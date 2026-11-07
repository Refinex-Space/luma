//! Find Usages of Java declarations with Luma's engine: the same usages the "N usages" inlay
//! counts (IDEA's `JavaTelescope` semantics, see `ide_java::search`), with the read / write
//! classification of field usages JDT LS's extension gives (assignment writes, compound
//! assignment and increment read-write, getters read, setters write). When any candidate file
//! holds an occurrence the engine cannot decide, it answers nothing and JDT searches instead.

use crate::Project;
use ide_core::{IpcPath, Location, Pos, Range};
use ide_java::model::{Model, Origin};
use ide_java::resolve::{FileAnalysis, Resolution, Target};
use ide_java::search::UsageQuery;
use ide_java::tree_sitter::Node;
use ide_lsp::types::{ClassifiedReference, ReferenceAccess, ReferenceKind, References};
use std::path::{Path, PathBuf};

pub(crate) fn pos_at(text: &str, byte: usize) -> Pos {
    let before = &text[..byte.min(text.len())];
    let line = before.matches('\n').count() as u32;
    let col = before.rsplit('\n').next().unwrap_or("").encode_utf16().count() as u32;
    Pos::new(line, col)
}

/// How a field usage at `n` (an identifier) uses the field.
fn field_access(n: Node, text: &str) -> ReferenceAccess {
    // `x` or `this.x` / `obj.x` as the operand.
    let mut operand = n;
    if let Some(p) = n
        .parent()
        .filter(|p| p.kind() == "field_access" && p.child_by_field_name("field").is_some_and(|f| f.id() == n.id()))
    {
        operand = p;
    }
    let Some(parent) = operand.parent() else { return ReferenceAccess::Read };
    match parent.kind() {
        "assignment_expression" if parent.child_by_field_name("left").is_some_and(|l| l.id() == operand.id()) => {
            let op = parent.child_by_field_name("operator").and_then(|o| text.get(o.byte_range())).unwrap_or("=");
            if op == "=" { ReferenceAccess::Write } else { ReferenceAccess::ReadWrite }
        }
        "update_expression" => ReferenceAccess::ReadWrite,
        _ => ReferenceAccess::Read,
    }
}

/// Usages of the declaration at (or referenced at) `pos` of `path`, when the engine decides
/// every occurrence in the files that may hold one.
pub(crate) fn engine_find_usages(
    project: &Project,
    path: &Path,
    text: &str,
    pos: Pos,
    libraries_too: bool,
) -> Option<References> {
    let cp = crate::java_engine::classpath_for(project, path);
    let visibility = project.java_engine.visibility(path);
    let byte = super::usages::byte_of(text, pos)?;
    // Other open files with unsaved edits: searched in their editor text.
    let unsaved = super::usages::unsaved_java(project, path);
    project
        .index
        .with_java_edits(path, text, &unsaved, |view| -> Option<References> {
            let me = view.overlay_file()?;
            let tree = ide_java::parse(text)?;
            let model = Model::new(view, &cp).with_visibility(visibility.clone());
            let fa = FileAnalysis::new(&model, &tree, text, me);
            let ident = fa.identifier_at(byte)?;
            let target = match fa.declared_target(ident) {
                Some(t) => t,
                None => match fa.resolve(ident) {
                    Resolution::Found(t) => t,
                    _ => return None,
                },
            };
            if matches!(target, Target::Package(_) | Target::TypeVar(_)) {
                return None;
            }
            // Usages in libraries (All Places) are JDT's to find; library code cannot use the
            // project's declarations, so those need no library search.
            let class = match &target {
                Target::Class(k) | Target::Field { class: k, .. } | Target::Method { class: k, .. } => Some(k.clone()),
                _ => None,
            };
            if libraries_too && class.is_some_and(|k| model.class(&k).is_none_or(|c| c.origin == Origin::Library)) {
                return None;
            }
            let q = match &target {
                Target::Local(_) => UsageQuery::local(&target, fa.node_text_pub(ident)),
                _ => UsageQuery::new(&model, &target, true),
            };
            // The files that may hold usages: the declaration's scope in the index, or for a
            // local (or a library declaration) the files mentioning its names.
            let files: Vec<PathBuf> = match &target {
                Target::Local(_) => vec![path.to_owned()],
                _ => declaration_scope(project, &model, &target, path, text, &unsaved).unwrap_or_else(|| {
                    let mut files: Vec<PathBuf> = q
                        .names
                        .iter()
                        .flat_map(|n| view.files_mentioning(n))
                        .filter_map(|slot| view.path(slot).map(Path::to_owned))
                        .collect();
                    files.sort();
                    files.dedup();
                    files
                }),
            };
            let mut out = References::default();
            for f in files {
                let (file_text, slot) = if f == path {
                    (text.to_owned(), me)
                } else if let Some((_, t)) = unsaved.iter().find(|(p, _)| *p == f) {
                    (t.clone(), view.file_slot(&f)?)
                } else {
                    let Some(doc) = project.documents.by_path(&f) else {
                        let t = std::fs::read_to_string(&f).ok()?;
                        if view.indexed_hash(&f) != Some(*blake3::hash(t.as_bytes()).as_bytes()) {
                            return None;
                        }
                        let slot = view.file_slot(&f)?;
                        let file_cp = crate::java_engine::classpath_for(project, &f);
                        let file_model = Model::new(view, &file_cp).with_visibility(project.java_engine.visibility(&f));
                        let usages = usages_in(&file_model, &q, &f, &t, slot)?;
                        out.locations.extend(usages.0);
                        out.classified.extend(usages.1);
                        continue;
                    };
                    // Saved since `unsaved` was taken: the index may not have caught up.
                    let snapshot = project.documents.snapshot(doc).ok()?;
                    if snapshot.dirty
                        || view.indexed_hash(&f) != Some(*blake3::hash(snapshot.text.as_bytes()).as_bytes())
                    {
                        return None;
                    }
                    (snapshot.text, view.file_slot(&f)?)
                };
                // Each file with its own module's class path and visibility.
                let file_cp = if f == path { cp.clone() } else { crate::java_engine::classpath_for(project, &f) };
                let file_model = Model::new(view, &file_cp).with_visibility(project.java_engine.visibility(&f));
                let usages = usages_in(&file_model, &q, &f, &file_text, slot)?;
                out.locations.extend(usages.0);
                out.classified.extend(usages.1);
            }
            Some(out)
        })
        .flatten()
}

/// The files the index says may use the declaration `target` (its own file included).
fn declaration_scope(
    project: &Project,
    model: &Model,
    target: &Target,
    path: &Path,
    text: &str,
    unsaved: &[(PathBuf, String)],
) -> Option<Vec<PathBuf>> {
    let (class, member) = match target {
        Target::Class(k) => (k.clone(), None),
        Target::Field { class, name } => (class.clone(), Some(name.clone())),
        Target::Method { class, name, desc } => (class.clone(), Some(format!("{name}{desc}"))),
        _ => return None,
    };
    let c = model.class(&class)?;
    let Origin::Source(id) = c.origin else { return None };
    let view = model.view;
    let decl_path = view.path(id.file).map(Path::to_owned).unwrap_or_else(|| path.to_owned());
    let t = view.ty(id)?;
    let at = match member {
        None => t.at,
        Some(m) if m.contains('(') => {
            let members = model.members(&c);
            let found = members
                .methods
                .iter()
                .find(|x| format!("{}{}", x.name, ide_java::resolve::method_desc(model, x)) == m)?;
            t.members.get(found.source? as usize)?.at
        }
        Some(m) => t.members.iter().find(|x| x.name == m)?.at,
    };
    let decl_text = if decl_path == path {
        text.to_owned()
    } else if let Some((_, t)) = unsaved.iter().find(|(p, _)| *p == decl_path) {
        t.clone()
    } else {
        std::fs::read_to_string(&decl_path).ok()?
    };
    // The scope with every edited file from its editor text (the searched file's included).
    let mut edits: Vec<(PathBuf, String)> = unsaved.to_vec();
    if decl_path != path {
        edits.push((path.to_owned(), text.to_owned()));
    }
    let scope = project.index.java_usage_scopes(&decl_path, &decl_text, &edits, &[at]).into_iter().next()??;
    let mut files: Vec<PathBuf> = scope.files.into_iter().map(|(f, _)| f).collect();
    files.push(decl_path);
    if !files.iter().any(|f| f == path) {
        files.push(path.to_owned());
    }
    Some(files)
}

/// Usages in one file: locations and field classifications; `None` when undecided.
fn usages_in(
    model: &Model,
    q: &UsageQuery,
    f: &Path,
    text: &str,
    slot: u32,
) -> Option<(Vec<Location>, Vec<ClassifiedReference>)> {
    let tree = ide_java::parse(text)?;
    let fa = FileAnalysis::new(model, &tree, text, slot);
    let u = fa.usages(q);
    if !u.decided() {
        return None;
    }
    let mut locations = Vec::new();
    let mut classified = Vec::new();
    let field = matches!(q.target, Target::Field { .. });
    for (start, end) in u.usages {
        let location = Location {
            path: IpcPath(f.to_owned()),
            range: Range::new(pos_at(text, start), pos_at(text, end)),
            uri: None,
        };
        if field && let Some(n) = tree.root_node().descendant_for_byte_range(start, start) {
            let name = text.get(n.byte_range()).unwrap_or_default();
            let target_name = match &q.target {
                Target::Field { name, .. } => name.as_str(),
                _ => "",
            };
            let (kind, access) = if name == target_name {
                (ReferenceKind::Field, field_access(n, text))
            } else if name.starts_with("set") {
                (ReferenceKind::Setter, ReferenceAccess::Write)
            } else {
                (ReferenceKind::Getter, ReferenceAccess::Read)
            };
            classified.push(ClassifiedReference { access: Some(access), location: location.clone(), kind });
        }
        locations.push(location);
    }
    Some((locations, classified))
}

/// Where the name at `pos` is declared, when the engine resolves it to a source declaration.
pub(crate) fn engine_definition(project: &Project, path: &Path, text: &str, pos: Pos) -> Option<Location> {
    let cp = crate::java_engine::classpath_for(project, path);
    let visibility = project.java_engine.visibility(path);
    let byte = super::usages::byte_of(text, pos)?;
    project
        .index
        .with_java(path, text, |view| -> Option<Location> {
            let me = view.overlay_file()?;
            let tree = ide_java::parse(text)?;
            let model = Model::new(view, &cp).with_visibility(visibility.clone());
            let fa = FileAnalysis::new(&model, &tree, text, me);
            let ident = fa.identifier_at(byte)?;
            let Resolution::Found(target) = fa.resolve(ident) else { return None };
            let at_name = |file: &Path, at: Pos, name: &str| Location {
                path: IpcPath(file.to_owned()),
                range: Range::new(at, Pos::new(at.line, at.col + name.encode_utf16().count() as u32)),
                uri: None,
            };
            match target {
                Target::Local(b) => {
                    let n = tree.root_node().descendant_for_byte_range(b, b)?;
                    let name = text.get(n.byte_range())?;
                    Some(at_name(path, pos_at(text, b), name))
                }
                Target::Class(k) => {
                    let id = model.source_type(&k)?;
                    let t = view.ty(id)?;
                    let file = if id.file == me { path.to_owned() } else { view.path(id.file)?.to_owned() };
                    (!t.name.is_empty()).then(|| at_name(&file, t.at, &t.name))
                }
                Target::Field { class, name } => {
                    let c = model.class(&class)?;
                    let Origin::Source(id) = c.origin else { return None };
                    let m = view.ty(id)?.members.iter().find(|m| m.name == name)?;
                    let file = if id.file == me { path.to_owned() } else { view.path(id.file)?.to_owned() };
                    Some(at_name(&file, m.at, &m.name))
                }
                Target::Method { class, name, desc } => {
                    let c = model.class(&class)?;
                    let Origin::Source(id) = c.origin else { return None };
                    let found = model
                        .members(&c)
                        .methods
                        .iter()
                        .find(|m| m.name == name && ide_java::resolve::method_desc(&model, m) == desc)?
                        .source?;
                    let m = view.ty(id)?.members.get(found as usize)?;
                    let file = if id.file == me { path.to_owned() } else { view.path(id.file)?.to_owned() };
                    Some(at_name(&file, m.at, &m.name))
                }
                Target::Package(_) | Target::TypeVar(_) => None,
            }
        })
        .flatten()
}
