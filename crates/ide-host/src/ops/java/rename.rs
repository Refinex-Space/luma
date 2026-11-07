//! Rename of Java locals, fields and methods (with their override family) by Luma's engine,
//! as IDEA's `RenameJavaVariableProcessor` / `RenameJavaMethodProcessor` do: every occurrence in
//! the files that may hold one must be decided, and the renamed code is resolved again — each
//! renamed occurrence must bind to the renamed declaration, and every reference that was
//! already named like the new name must bind as before (no shadowing, no hiding, no accidental
//! override). Anything else (classes, packages, a family with a library method, an undecided
//! occurrence, a conflict) is left to jdtls.

use super::find::pos_at;
use super::usages::{byte_of, unsaved_java};
use crate::Project;
use ide_core::{FileEdit, IpcPath, Pos, Range, TextEdit, WorkspaceEdit};
use ide_java::model::{ClassKind, Model, Origin};
use ide_java::resolve::{FileAnalysis, Resolution, Target};
use ide_java::search::UsageQuery;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

/// Reserved words and literals (JLS §3.9, §3.10.3, §3.10.7); `_` since Java 9.
const RESERVED: &[&str] = &[
    "abstract",
    "assert",
    "boolean",
    "break",
    "byte",
    "case",
    "catch",
    "char",
    "class",
    "const",
    "continue",
    "default",
    "do",
    "double",
    "else",
    "enum",
    "extends",
    "final",
    "finally",
    "float",
    "for",
    "goto",
    "if",
    "implements",
    "import",
    "instanceof",
    "int",
    "interface",
    "long",
    "native",
    "new",
    "package",
    "private",
    "protected",
    "public",
    "return",
    "short",
    "static",
    "strictfp",
    "super",
    "switch",
    "synchronized",
    "this",
    "throw",
    "throws",
    "transient",
    "try",
    "void",
    "volatile",
    "while",
    "true",
    "false",
    "null",
    "_",
];

/// Whether `name` is a Java identifier (JLS §3.8).
pub(crate) fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    let start = chars.next().is_some_and(|c| c.is_alphabetic() || c == '_' || c == '$');
    start && chars.all(|c| c.is_alphanumeric() || c == '_' || c == '$') && !RESERVED.contains(&name)
}

/// A file's current text: the editor's when it has unsaved edits, else the indexed one.
fn text_of(
    view: &ide_index::java::JavaView,
    f: &Path,
    primary: (&Path, &str),
    unsaved: &[(PathBuf, String)],
) -> Option<String> {
    if f == primary.0 {
        return Some(primary.1.to_owned());
    }
    if let Some((_, t)) = unsaved.iter().find(|(p, _)| p == f) {
        return Some(t.clone());
    }
    let t = std::fs::read_to_string(f).ok()?;
    // The index must describe it (a file saved a moment ago may not be re-indexed yet).
    (view.indexed_hash(f) == Some(*blake3::hash(t.as_bytes()).as_bytes())).then_some(t)
}

/// What a rename at a position changes.
struct Plan {
    target: Target,
    old_name: String,
    /// Byte ranges of the occurrences, by file, with the file's text.
    files: BTreeMap<PathBuf, (String, Vec<(usize, usize)>)>,
}

/// The query for `target` named `name`, when the engine can rename it.
fn renameable(model: &Model, target: &Target, name: &str) -> Option<UsageQuery> {
    let source_class = |k: &str| model.class(k).filter(|c| matches!(c.origin, Origin::Source(_)));
    match target {
        Target::Local(_) => Some(UsageQuery::local(target, name)),
        Target::Field { class, name } => {
            let c = source_class(class)?;
            // A record component is also its accessor and a constructor parameter; Lombok
            // generates accessors named after the field: both are jdtls's to rename.
            if c.kind == ClassKind::Record {
                return None;
            }
            let cap: String = name.chars().take(1).flat_map(char::to_uppercase).chain(name.chars().skip(1)).collect();
            let accessors = [format!("get{cap}"), format!("set{cap}"), format!("is{cap}")];
            if model.members(&c).methods.iter().any(|m| m.source.is_none() && accessors.contains(&m.name)) {
                return None;
            }
            Some(UsageQuery::new(model, target, false))
        }
        Target::Method { class, name, desc } if name != "<init>" => {
            let c = source_class(class)?;
            if c.kind == ClassKind::Annotation {
                return None;
            }
            // Declared in the source (not generated: Lombok, enum `values()`, record accessors).
            let declared =
                model.members(&c).methods.iter().any(|m| {
                    &m.name == name && ide_java::resolve::method_desc(model, m) == *desc && m.source.is_some()
                });
            if !declared {
                return None;
            }
            let q = UsageQuery::new(model, target, false);
            q.family_in_sources(model).then_some(q)
        }
        _ => None,
    }
}

/// The occurrences a rename of the declaration at (or referenced at) `pos` changes; `None` when
/// the engine leaves it to jdtls.
fn plan(project: &Project, path: &Path, text: &str, pos: Pos, unsaved: &[(PathBuf, String)]) -> Option<Plan> {
    let cp = crate::java_engine::classpath_for(project, path);
    let visibility = project.java_engine.visibility(path);
    let byte = byte_of(text, pos)?;
    project
        .index
        .with_java_edits(path, text, unsaved, |view| -> Option<Plan> {
            let me = view.overlay_file()?;
            let tree = ide_java::parse(text)?;
            let model = Model::new(view, &cp).with_visibility(visibility.clone());
            let fa = FileAnalysis::new(&model, &tree, text, me);
            let ident = fa.identifier_at(byte)?;
            let old_name = fa.node_text_pub(ident).to_owned();
            let target = match fa.declared_target(ident) {
                Some(t) => t,
                None => match fa.resolve(ident) {
                    Resolution::Found(t) => t,
                    _ => return None,
                },
            };
            let q = renameable(&model, &target, &old_name)?;
            let mut candidates: Vec<PathBuf> = match target {
                Target::Local(_) => Vec::new(),
                _ => view
                    .files_mentioning(&old_name)
                    .into_iter()
                    .filter(|&s| s != me)
                    .filter_map(|s| view.path(s).map(Path::to_owned))
                    .collect(),
            };
            candidates.push(path.to_owned());
            candidates.sort();
            candidates.dedup();
            let mut files = BTreeMap::new();
            for f in candidates {
                let file_text = text_of(view, &f, (path, text), unsaved)?;
                let slot = if f == path { me } else { view.file_slot(&f)? };
                let file_tree = ide_java::parse(&file_text)?;
                let file_cp = if f == path { cp.clone() } else { crate::java_engine::classpath_for(project, &f) };
                let file_model = Model::new(view, &file_cp).with_visibility(project.java_engine.visibility(&f));
                let fa = FileAnalysis::new(&file_model, &file_tree, &file_text, slot);
                let (usages, declarations) = (fa.usages(&q), fa.declarations(&q));
                if !usages.decided() || !declarations.decided() {
                    return None;
                }
                let mut ranges: Vec<(usize, usize)> = usages.usages.into_iter().chain(declarations.usages).collect();
                ranges.sort_unstable();
                ranges.dedup();
                // Only the name itself is replaced (never a constructor call's type or a qualifier).
                if ranges.iter().any(|&(s, e)| file_text.get(s..e) != Some(old_name.as_str())) {
                    return None;
                }
                if !ranges.is_empty() {
                    files.insert(f, (file_text, ranges));
                }
            }
            if files.is_empty() {
                return None;
            }
            Some(Plan { target, old_name, files })
        })
        .flatten()
}

/// Where byte `at` of a file moves when its `ranges` (sorted) are replaced by `delta` bytes more.
fn shifted(at: usize, ranges: &[(usize, usize)], delta: isize) -> usize {
    let before = ranges.iter().take_while(|(s, _)| *s < at).count() as isize;
    (at as isize + before * delta) as usize
}

/// A file, its text and how its references named like the new name resolve.
type FileBindings = (PathBuf, String, Vec<(usize, Resolution)>);

/// How each reference named `name` in `text` resolves (by byte offset), declarations aside.
fn bindings(fa: &FileAnalysis, tree: &ide_java::tree_sitter::Tree, name: &str) -> Vec<(usize, Resolution)> {
    let mut out = Vec::new();
    let mut stack = vec![tree.root_node()];
    while let Some(n) = stack.pop() {
        let mut c = n.walk();
        stack.extend(n.children(&mut c));
        if matches!(n.kind(), "identifier" | "type_identifier")
            && fa.node_text_pub(n) == name
            && fa.declared_target(n).is_none()
        {
            out.push((n.start_byte(), fa.resolve(n)));
        }
    }
    out.sort_by_key(|(at, _)| *at);
    out
}

/// A local renamed to `name` must not share a scope with another local of that name (JLS §6.4:
/// neither may be redeclared in a block or lambda inside the other's scope).
fn no_redeclared_local(fa: &FileAnalysis, renamed: &Target, name: &str) -> bool {
    let Target::Local(at) = *renamed else { return true };
    let declared: Vec<ide_java::tree_sitter::Node> = {
        let mut out = Vec::new();
        let mut stack = vec![fa.tree.root_node()];
        while let Some(n) = stack.pop() {
            let mut c = n.walk();
            stack.extend(n.children(&mut c));
            if n.kind() == "identifier"
                && fa.node_text_pub(n) == name
                && matches!(fa.declared_target(n), Some(Target::Local(_)))
            {
                out.push(n);
            }
        }
        out
    };
    let Some(mine) = declared.iter().find(|n| n.start_byte() == at) else { return false };
    declared.iter().filter(|n| n.start_byte() != at).all(|other| {
        fa.visible_local(name, *mine).is_none_or(|l| l == at) && fa.visible_local(name, *other) != Some(at)
    })
}

/// Whether renaming `plan` to `new_name` keeps the code meaning the same (see the module docs).
fn no_conflicts(
    project: &Project,
    path: &Path,
    text: &str,
    unsaved: &[(PathBuf, String)],
    plan: &Plan,
    new_name: &str,
) -> bool {
    let delta = new_name.len() as isize - plan.old_name.len() as isize;
    let renamed_text = |f: &Path, t: &str| -> String {
        let Some((_, ranges)) = plan.files.get(f) else { return t.to_owned() };
        let mut out = String::with_capacity(t.len());
        let mut at = 0;
        for &(s, e) in ranges {
            out.push_str(&t[at..s]);
            out.push_str(new_name);
            at = e;
        }
        out.push_str(&t[at..]);
        out
    };
    let ranges_of = |f: &Path| plan.files.get(f).map(|(_, r)| r.as_slice()).unwrap_or(&[]);
    let move_local = |f: &Path, r: Resolution| match r {
        Resolution::Found(Target::Local(at)) => Resolution::Found(Target::Local(shifted(at, ranges_of(f), delta))),
        other => other,
    };

    // Before: how the references already named `new_name` resolve.
    let cp = crate::java_engine::classpath_for(project, path);
    let before: Option<Vec<FileBindings>> = project
        .index
        .with_java_edits(path, text, unsaved, |view| {
            let me = view.overlay_file()?;
            let mut files: Vec<PathBuf> = view
                .files_mentioning(new_name)
                .into_iter()
                .filter_map(|s| if s == me { Some(path.to_owned()) } else { view.path(s).map(Path::to_owned) })
                .collect();
            files.extend(plan.files.keys().cloned());
            files.sort();
            files.dedup();
            let mut out = Vec::new();
            for f in files {
                let t = text_of(view, &f, (path, text), unsaved)?;
                let slot = if f == path { me } else { view.file_slot(&f)? };
                let tree = ide_java::parse(&t)?;
                let file_cp = if f == path { cp.clone() } else { crate::java_engine::classpath_for(project, &f) };
                let model = Model::new(view, &file_cp).with_visibility(project.java_engine.visibility(&f));
                let fa = FileAnalysis::new(&model, &tree, &t, slot);
                let b: Vec<(usize, Resolution)> = bindings(&fa, &tree, new_name)
                    .into_iter()
                    .map(|(at, r)| (shifted(at, ranges_of(&f), delta), move_local(&f, r)))
                    .collect();
                out.push((f, t, b));
            }
            Some(out)
        })
        .flatten();
    let Some(before) = before else { return false };

    // After: the renamed texts, every edited file from its new text.
    let new_primary = renamed_text(path, text);
    let mut edits: Vec<(PathBuf, String)> = unsaved.iter().map(|(p, t)| (p.clone(), renamed_text(p, t))).collect();
    for (f, (t, _)) in &plan.files {
        if f != path && !edits.iter().any(|(p, _)| p == f) {
            edits.push((f.clone(), renamed_text(f, t)));
        }
    }
    let renamed = match &plan.target {
        Target::Local(at) => Target::Local(shifted(*at, ranges_of(path), delta)),
        Target::Field { class, .. } => Target::Field { class: class.clone(), name: new_name.to_owned() },
        Target::Method { class, desc, .. } => {
            Target::Method { class: class.clone(), name: new_name.to_owned(), desc: desc.clone() }
        }
        _ => return false,
    };
    project
        .index
        .with_java_edits(path, &new_primary, &edits, |view| {
            let Some(me) = view.overlay_file() else { return false };
            let analyze =
                |f: &Path, t: &str, check: &mut dyn FnMut(&FileAnalysis, &ide_java::tree_sitter::Tree) -> bool| {
                    let Some(slot) = (if f == path { Some(me) } else { view.file_slot(f) }) else { return false };
                    let Some(tree) = ide_java::parse(t) else { return false };
                    let file_cp = if f == path { cp.clone() } else { crate::java_engine::classpath_for(project, f) };
                    let model = Model::new(view, &file_cp).with_visibility(project.java_engine.visibility(f));
                    let fa = FileAnalysis::new(&model, &tree, t, slot);
                    check(&fa, &tree)
                };
            // Each renamed occurrence binds to the renamed declaration, and nothing else does.
            for (f, (t, ranges)) in &plan.files {
                let new_text = renamed_text(f, t);
                let expected: Vec<(usize, usize)> = ranges
                    .iter()
                    .map(|&(s, _)| {
                        let s = shifted(s, ranges, delta);
                        (s, s + new_name.len())
                    })
                    .collect();
                let ok = analyze(f, &new_text, &mut |fa, _| {
                    let q = match &renamed {
                        Target::Local(_) => UsageQuery::local(&renamed, new_name),
                        _ => UsageQuery::new(fa.model, &renamed, false),
                    };
                    let (u, d) = (fa.usages(&q), fa.declarations(&q));
                    let mut found: Vec<(usize, usize)> = u.usages.into_iter().chain(d.usages).collect();
                    found.sort_unstable();
                    found.dedup();
                    u.undecided.is_empty()
                        && d.undecided.is_empty()
                        && found == expected
                        && no_redeclared_local(fa, &renamed, new_name)
                });
                if !ok {
                    return false;
                }
            }
            // The references already named `new_name` bind as before.
            for (f, t, b) in &before {
                let new_text = renamed_text(f, t);
                let ok = analyze(f, &new_text, &mut |fa, tree| {
                    let now: HashMap<usize, Resolution> = bindings(fa, tree, new_name).into_iter().collect();
                    b.iter().all(|(at, r)| now.get(at) == Some(r))
                });
                if !ok {
                    return false;
                }
            }
            true
        })
        .unwrap_or(false)
}

/// The range of the name a rename at `pos` would change, when the engine renames it.
pub(crate) fn engine_prepare_rename(project: &Project, path: &Path, text: &str, pos: Pos) -> Option<Range> {
    let unsaved = unsaved_java(project, path);
    let plan = plan(project, path, text, pos, &unsaved)?;
    let byte = byte_of(text, pos)?;
    let (_, ranges) = plan.files.get(path)?;
    let &(s, e) = ranges.iter().find(|(s, e)| *s <= byte && byte <= *e)?;
    Some(Range::new(pos_at(text, s), pos_at(text, e)))
}

/// The edit renaming the declaration at (or referenced at) `pos` to `new_name`; `None` when
/// jdtls should (see the module docs).
pub(crate) fn engine_rename(
    project: &Project,
    path: &Path,
    text: &str,
    pos: Pos,
    new_name: &str,
) -> Option<WorkspaceEdit> {
    if !is_identifier(new_name) {
        return None;
    }
    let unsaved = unsaved_java(project, path);
    let plan = plan(project, path, text, pos, &unsaved)?;
    if plan.old_name == new_name || !no_conflicts(project, path, text, &unsaved, &plan, new_name) {
        return None;
    }
    let files = plan
        .files
        .iter()
        .map(|(f, (t, ranges))| FileEdit::Edit {
            path: IpcPath(f.clone()),
            edits: ranges
                .iter()
                .map(|&(s, e)| TextEdit {
                    range: Range::new(pos_at(t, s), pos_at(t, e)),
                    new_text: new_name.to_owned(),
                })
                .collect(),
            version: None,
        })
        .collect();
    Some(WorkspaceEdit { files, preconditions: Vec::new() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Host, HostConfig};
    use std::sync::Arc;
    use std::time::Duration;

    /// The position of the `nth` occurrence of `needle` in `text`.
    fn at(text: &str, needle: &str, nth: usize) -> Pos {
        let (byte, _) = text.match_indices(needle).nth(nth).unwrap();
        pos_at(text, byte)
    }

    /// The renamed files' texts, by file name.
    fn applied(edit: &WorkspaceEdit) -> BTreeMap<String, String> {
        edit.files
            .iter()
            .map(|f| {
                let FileEdit::Edit { path, edits, .. } = f else { panic!("{f:?}") };
                let mut text = std::fs::read_to_string(&path.0).unwrap();
                let mut edits = edits.clone();
                edits.sort_by_key(|e| std::cmp::Reverse(e.range.start));
                for e in edits {
                    let (s, t) = (byte_of(&text, e.range.start).unwrap(), byte_of(&text, e.range.end).unwrap());
                    text.replace_range(s..t, &e.new_text);
                }
                (path.0.file_name().unwrap().to_string_lossy().into_owned(), text)
            })
            .collect()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn renames_what_it_decides_and_refuses_conflicts() {
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let root = base.join("project");
        let src = root.join("src/main/java/s");
        std::fs::create_dir_all(&src).unwrap();
        let files = [
            ("Order.java", "package s; public class Order {}"),
            ("Service.java", "package s; public interface Service { void place(Order o); }"),
            (
                "Impl.java",
                "package s;\npublic class Impl implements Service {\n  public void place(Order o) {}\n  public void other(Order o) {}\n}\n",
            ),
            (
                "Use.java",
                "package s;\n/** Calls {@link Service#place(Order)}. */\nclass Use {\n  void m(Service s, Impl i, Order x) {\n    s.place(x);\n    i.place(x);\n    int a = 1;\n    int b = a + 1;\n  }\n}\n",
            ),
            (
                "Bean.java",
                "package s;\npublic class Bean {\n  private int size;\n  public int getSize() { return size; }\n  public void setSize(int s) { size = s; }\n  int twice() { int count = 2; return size * count; }\n}\n",
            ),
            ("BeanUse.java", "package s; class BeanUse { int m(Bean b) { return b.getSize(); } }"),
        ];
        for (name, text) in files {
            std::fs::write(src.join(name), text).unwrap();
        }
        let host = Host::new(HostConfig {
            config_dir: base.join("config"),
            data_dir: base.join("data"),
            local_data_dir: base.join("data"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(ide_core::NullSink)),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        });
        let project = host.open_project("main", &root).unwrap();
        assert!(project.index.wait_idle(Duration::from_secs(30)));
        let read = |n: &str| (src.join(n), std::fs::read_to_string(src.join(n)).unwrap());

        // A method: its whole override family, calls through any of its types, Javadoc links.
        let (impl_path, impl_text) = read("Impl.java");
        let place = at(&impl_text, "place", 0);
        let range = engine_prepare_rename(&project, &impl_path, &impl_text, place).unwrap();
        assert_eq!((range.start, range.end), (Pos::new(2, 14), Pos::new(2, 19)));
        let edit = engine_rename(&project, &impl_path, &impl_text, place, "submit").unwrap();
        let renamed = applied(&edit);
        assert_eq!(renamed.keys().collect::<Vec<_>>(), ["Impl.java", "Service.java", "Use.java"]);
        assert!(renamed["Service.java"].contains("void submit(Order o)"));
        assert!(renamed["Impl.java"].contains("public void submit(Order o)"));
        let use_text = &renamed["Use.java"];
        assert!(
            use_text.contains("{@link Service#submit(Order)}") && use_text.contains("s.submit(x);\n    i.submit(x);")
        );
        // Into an existing method of the same signature: a conflict, left to jdtls.
        assert!(engine_rename(&project, &impl_path, &impl_text, place, "other").is_none());
        assert!(engine_rename(&project, &impl_path, &impl_text, place, "class").is_none(), "not an identifier");

        // A field: its own references, not its accessors' calls.
        let (bean, bean_text) = read("Bean.java");
        let size = at(&bean_text, "size", 0);
        let renamed = applied(&engine_rename(&project, &bean, &bean_text, size, "total").unwrap());
        assert_eq!(renamed.keys().collect::<Vec<_>>(), ["Bean.java"]);
        assert_eq!(renamed["Bean.java"].matches("total").count(), 4);
        assert!(renamed["Bean.java"].contains("getSize()"));
        // `count` would be shadowed by the local in `twice()`.
        assert!(engine_rename(&project, &bean, &bean_text, at(&bean_text, "size", 3), "count").is_none());

        // A local: in its method only; never onto another local in scope.
        let (use_path, use_text) = read("Use.java");
        let a = at(&use_text, "a + 1", 0);
        let renamed = applied(&engine_rename(&project, &use_path, &use_text, a, "c").unwrap());
        assert!(renamed["Use.java"].contains("int c = 1;\n    int b = c + 1;"));
        assert!(engine_rename(&project, &use_path, &use_text, a, "b").is_none());
        assert!(engine_rename(&project, &use_path, &use_text, a, "x").is_none(), "the parameter x");
        // Find Usages of a local (its name is in the text, not in the target).
        let refs = super::super::find::engine_find_usages(&project, &use_path, &use_text, a, false).unwrap();
        assert_eq!(refs.locations.len(), 1);

        // Member completion without a language server (the engine's fallback).
        let (bean_use, bean_use_text) = read("BeanUse.java");
        let list = super::super::complete::engine_completion(
            &project,
            &bean_use,
            &bean_use_text,
            at(&bean_use_text, "getSize", 0),
        )
        .unwrap();
        let labels: Vec<String> =
            list.items.iter().map(|i| format!("{}{}", i.label, i.label_detail.clone().unwrap_or_default())).collect();
        assert!(labels.contains(&"getSize()".to_owned()) && labels.contains(&"setSize(int)".to_owned()), "{labels:?}");
        assert!(labels.contains(&"twice()".to_owned()) && !labels.iter().any(|l| l.starts_with("size")), "{labels:?}");
        let set = list.items.iter().find(|i| i.label == "setSize").unwrap();
        assert!(set.is_snippet && set.insert_text == "setSize($1)$0");

        // Classes are jdtls's (the file is renamed with them).
        assert!(engine_prepare_rename(&project, &impl_path, &impl_text, at(&impl_text, "Impl", 0)).is_none());
    }

    #[test]
    fn identifiers() {
        assert!(is_identifier("total") && is_identifier("$x") && is_identifier("_a") && is_identifier("été"));
        assert!(!is_identifier("1a") && !is_identifier("class") && !is_identifier("_") && !is_identifier("a-b"));
        assert!(!is_identifier("") && !is_identifier("null"));
        assert_eq!(shifted(10, &[(2, 4), (20, 22)], 3), 13);
    }
}
