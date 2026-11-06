//! Answers for an open Java file from the structure index: its inheritance gutter markers
//! (IDEA's `JavaLineMarkerProvider`: "is implemented / overridden", "implements / overrides") and
//! the files a usage search of one of its declarations has to look at (IDEA's use scope over the
//! identifier index).

use super::*;
use ide_core::{IpcPath, Location, Range};
use specta::Type;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum JavaMarkerKind {
    /// ↓ on an interface / abstract method: has implementations.
    Implemented,
    /// ↓ on a class / method: has subclasses / overriders.
    Overridden,
    /// ↑ on a method implementing an abstract one.
    Implementing,
    /// ↑ on a method overriding a concrete one.
    Overriding,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JavaMarkerTarget {
    pub location: Location,
    /// The type it is in (`Outer.Inner`), for tooltips and choosers.
    pub owner: String,
    #[serde(rename = "abstract")]
    pub abstract_: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JavaMarker {
    /// The declaration's name, 0-based line / UTF-16 column.
    pub line: u32,
    pub col: u32,
    pub name: String,
    pub method: bool,
    pub kind: JavaMarkerKind,
    pub targets: Vec<JavaMarkerTarget>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JavaMarkers {
    pub markers: Vec<JavaMarker>,
    /// Methods whose super method may be declared outside the sources (a library type is among
    /// the supertypes): only a language server knows.
    pub unresolved: Vec<Pos>,
}

/// Bound on the subtypes walked per type (a marker lists them all up to it).
const MAX_SUBTYPES: usize = 1000;
const OBJECT_METHODS: &[&str] = &["equals", "hashCode", "toString", "clone", "finalize"];

fn location(view: &JavaView, path_of_overlay: &Path, file: u32, at: Pos, name: &str) -> Option<Location> {
    let path = if Some(file) == view.overlay_file() { path_of_overlay.to_owned() } else { view.path(file)?.to_owned() };
    let end = Pos::new(at.line, at.col + name.encode_utf16().count() as u32);
    Some(Location { path: IpcPath::from(path), range: Range::new(at, end), uri: None })
}

fn type_target(view: &JavaView, path: &Path, id: TypeId) -> Option<JavaMarkerTarget> {
    let stub = view.stub(id.file)?;
    let t = stub.types.get(id.ty as usize)?;
    let name = if t.is(ANONYMOUS) { t.supers.first().map(|s| simple(s)).unwrap_or_default() } else { &t.name };
    Some(JavaMarkerTarget {
        location: location(view, path, id.file, t.at, name)?,
        owner: stub.display_name(id.ty),
        abstract_: t.is(ABSTRACT),
    })
}

fn member_target(view: &JavaView, path: &Path, id: TypeId, m: &JavaMember) -> Option<JavaMarkerTarget> {
    let stub = view.stub(id.file)?;
    Some(JavaMarkerTarget {
        location: location(view, path, id.file, m.at, &m.name)?,
        owner: stub.display_name(id.ty),
        abstract_: m.is(ABSTRACT),
    })
}

/// The gutter markers of the edited file (`view`'s overlay, at `path`).
pub fn markers(view: &JavaView, path: &Path) -> JavaMarkers {
    let mut out = JavaMarkers::default();
    let Some(file) = view.overlay_file() else { return out };
    let Some(stub) = view.stub(file) else { return out };
    for (ti, t) in stub.types.iter().enumerate() {
        let id = TypeId { file, ty: ti as u32 };
        let extendable = !t.is(FINAL) && !t.is(ANONYMOUS) && !t.is(LOCAL) && !t.name.is_empty();
        let subtypes = if extendable { view.all_subtypes(id, MAX_SUBTYPES) } else { Vec::new() };
        if !subtypes.is_empty() {
            out.markers.push(JavaMarker {
                line: t.at.line,
                col: t.at.col,
                name: t.name.clone(),
                method: false,
                kind: if t.is(ABSTRACT) { JavaMarkerKind::Implemented } else { JavaMarkerKind::Overridden },
                targets: subtypes.iter().filter_map(|&s| type_target(view, path, s)).collect(),
            });
        }
        let (supertypes, external) = view.all_supertypes(id);
        for m in t.members.iter().filter(|m| m.kind == JavaMemberKind::Method) {
            // ↓ overriders in subtypes.
            if !m.is(STATIC) && !m.is(PRIVATE) && !m.is(FINAL) && !subtypes.is_empty() {
                let mut targets = Vec::new();
                for &s in &subtypes {
                    let Some(st) = view.ty(s) else { continue };
                    for sm in st.members.iter().filter(|sm| view.overrides(s, sm, id, m)) {
                        targets.extend(member_target(view, path, s, sm));
                    }
                }
                if !targets.is_empty() {
                    out.markers.push(JavaMarker {
                        line: m.at.line,
                        col: m.at.col,
                        name: m.name.clone(),
                        method: true,
                        kind: if m.is(ABSTRACT) { JavaMarkerKind::Implemented } else { JavaMarkerKind::Overridden },
                        targets,
                    });
                }
            }
            // ↑ super methods in supertypes.
            if m.is(STATIC) || m.is(PRIVATE) {
                continue;
            }
            let mut targets = Vec::new();
            for &s in &supertypes {
                let Some(st) = view.ty(s) else { continue };
                for sm in st.members.iter().filter(|sm| view.overrides(id, m, s, sm)) {
                    targets.extend(member_target(view, path, s, sm));
                }
            }
            if targets.is_empty() {
                // `Object` is every type's supertype, and a library type may declare it.
                if external
                    || OBJECT_METHODS.contains(&m.name.as_str())
                    || m.annotations.iter().any(|a| a == "Override")
                {
                    out.unresolved.push(m.at);
                }
                continue;
            }
            let implementing = targets.iter().any(|t| t.abstract_);
            out.markers.push(JavaMarker {
                line: m.at.line,
                col: m.at.col,
                name: m.name.clone(),
                method: true,
                kind: if implementing { JavaMarkerKind::Implementing } else { JavaMarkerKind::Overriding },
                targets,
            });
        }
    }
    out.markers
        .sort_by_key(|m| (m.line, m.col, !matches!(m.kind, JavaMarkerKind::Implemented | JavaMarkerKind::Overridden)));
    out
}

/// Where usages of a declaration can be: the files that mention one of its names, narrowed by
/// its accessibility (IDEA's use scope).
#[derive(Clone, Debug, PartialEq)]
pub struct UsageScope {
    /// A stable identity of the declaration within its file: `Outer.Inner#name(String,int)`.
    pub key: String,
    /// Names a usage is written with: the declaration's, and a field's accessors.
    pub words: Vec<String>,
    /// Usages can only be in the declaring file (private, local).
    pub local: bool,
    /// Indexed files that may hold usages (the declaring file excluded), with their content hash.
    pub files: Vec<(PathBuf, [u8; 32])>,
}

/// `name` with its first letter upper-cased (`name` → `Name`).
fn capitalized(name: &str) -> String {
    let mut c = name.chars();
    c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
}

/// Names a field is used with outside its file: its getters and setters, and its own name when
/// Lombok makes it a builder or fluent accessor method (`@Builder`, `@Accessors`); a private
/// field's own name is only written in its file.
fn field_words(stub: &JavaStub, ty: u32, m: &JavaMember) -> Vec<String> {
    let lombok = |names: &[&str]| {
        let mut next = Some(ty);
        let mut found = m.annotations.iter().any(|a| names.contains(&a.as_str()));
        while let Some(i) = next {
            let t = &stub.types[i as usize];
            found |= t.annotations.iter().any(|a| names.contains(&a.as_str()));
            next = t.outer;
        }
        found
    };
    let accessors = lombok(&["Accessors"]);
    let builder = lombok(&["Builder", "SuperBuilder"]);
    let mut names = vec![m.name.clone()];
    if accessors && m.name.len() > 1 {
        // `@Accessors(prefix = "m")`: `mTitle` → `title`.
        let stripped = m.name.trim_start_matches(|c: char| c.is_lowercase());
        if !stripped.is_empty() && stripped.len() < m.name.len() {
            names.push(format!("{}{}", stripped[..1].to_lowercase(), &stripped[1..]));
        }
    }
    let mut words = Vec::new();
    for name in &names {
        let base = name.strip_prefix("is").filter(|r| r.starts_with(char::is_uppercase)).unwrap_or(name);
        for prefix in ["get", "set", "is"] {
            words.push(format!("{prefix}{}", capitalized(base)));
        }
        if !m.is(PRIVATE) || accessors || builder {
            words.push(name.clone());
        }
    }
    words
}

/// The usage scope of the declaration whose name is at `pos` in the edited file.
pub fn usage_scope(view: &JavaView, pos: Pos) -> Option<UsageScope> {
    let file = view.overlay_file()?;
    let stub = view.stub(file)?;
    let (ti, mi) = stub.declaration_at(pos)?;
    let t = &stub.types[ti as usize];
    let member = mi.map(|i| &t.members[i as usize]);
    let mut key = stub.display_name(ti);
    let mut words = Vec::new();
    match member {
        None => words.push(t.name.clone()),
        Some(m) => {
            key.push('#');
            key.push_str(if m.kind == JavaMemberKind::Constructor { "<init>" } else { &m.name });
            if matches!(m.kind, JavaMemberKind::Method | JavaMemberKind::Constructor) {
                key.push('(');
                key.push_str(&m.params.join(","));
                key.push(')');
            }
            if m.kind != JavaMemberKind::Field {
                words.push(if m.kind == JavaMemberKind::Constructor { t.name.clone() } else { m.name.clone() });
            } else if t.kind == JavaTypeKind::Record && !m.is(STATIC) {
                // A record component: its accessor has its name.
                words.push(m.name.clone());
            } else {
                words.extend(field_words(stub, ti, m));
            }
        }
    }
    words.sort();
    words.dedup();
    // Accessibility: private anywhere in the chain, or a local / anonymous type, keeps usages in
    // the file; package-private ones in the package. A private field is used through its
    // accessors too (Lombok's, a record's), as accessible as its type.
    let field = member.is_some_and(|m| m.kind == JavaMemberKind::Field);
    let flags = member.map_or(PUBLIC, |m| if field && m.is(PRIVATE) { PUBLIC } else { m.flags });
    let mut local = flags & PRIVATE != 0;
    let mut package_only = flags & (PUBLIC | PROTECTED | PRIVATE) == 0;
    let mut next = Some(ti);
    while let Some(i) = next {
        let ty = &stub.types[i as usize];
        local |= ty.is(PRIVATE) || ty.is(LOCAL) || ty.is(ANONYMOUS);
        package_only |= ty.flags & (PUBLIC | PROTECTED | PRIVATE) == 0;
        next = ty.outer;
    }
    let mut files = Vec::new();
    if !local {
        let mut seen = HashSet::new();
        for w in &words {
            for &f in view.data.java.files_with_word(w) {
                if f == file || !seen.insert(f) {
                    continue;
                }
                let Some(entry) = view.data.files.get(f as usize).and_then(Option::as_ref) else { continue };
                if package_only && entry.java.as_ref().is_none_or(|j| j.package != stub.package) {
                    continue;
                }
                files.push((entry.path.clone(), entry.hash));
            }
        }
        files.sort();
    }
    Some(UsageScope { key, words, local, files })
}
