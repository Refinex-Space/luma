//! Configuration metadata worked out from Java sources, as the annotation processor would write
//! it (IDEA 2023.2: "Spring configuration beans no longer require the annotation processor"):
//! `@ConfigurationProperties` classes and `@Bean` methods, their JavaBean or constructor-bound
//! properties with types, Javadoc descriptions, defaults and deprecation, nested groups. Also
//! the Java answers configuration files need ([`JavaTypes`], a [`crate::TypeOracle`]).

use crate::metadata::{RawDeprecation, RawItem, RawMetadata};
use crate::name;
use crate::{BeanProperty, ClassKind, EnumConstant, TypeOracle};
use ide_index::java::{AnnotationValue, JavaAnnotation, JavaMember, JavaMemberKind, JavaView, TypeId};
use ide_java::model::{ClassData, ClassKind as JavaKind, Model, Scope};
use ide_java::types::{Type, TypeArg};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

// ---------------------------------------------------------------------------
// Javadoc

/// The Javadoc comment ending right before the line starting at byte `line_start` (annotations
/// and blank lines between are skipped), as plain text: its main description, inline tags
/// reduced to their text, HTML removed, whitespace collapsed.
pub fn javadoc_before(text: &str, line_start: usize) -> Option<String> {
    Some(clean(raw_javadoc_before(text, line_start)?)).filter(|s| !s.is_empty())
}

/// The body of the Javadoc comment before the line at `line_start` (see [`javadoc_before`]).
pub fn raw_javadoc_before(text: &str, line_start: usize) -> Option<&str> {
    let mut end = line_start.min(text.len());
    // Walk back over blank lines and annotation lines.
    loop {
        let before = text[..end].trim_end();
        if before.ends_with("*/") {
            let close = before.len();
            let open = before.rfind("/**")?;
            return Some(&before[open + 3..close - 2]);
        }
        let line_begin = before.rfind('\n').map_or(0, |i| i + 1);
        let line = before[line_begin..].trim();
        if line.starts_with('@') || line.ends_with(')') && line.contains('@') || line.ends_with(',') {
            end = line_begin;
            continue;
        }
        return None;
    }
}

/// A comment's main description as plain text.
pub fn clean(comment: &str) -> String {
    let mut lines = Vec::new();
    for line in comment.lines() {
        let l = line.trim().trim_start_matches('*').trim();
        if l.starts_with('@') {
            break;
        }
        lines.push(l);
    }
    let joined = lines.join(" ");
    let mut out = String::with_capacity(joined.len());
    let mut rest = joined.as_str();
    while let Some(i) = rest.find(['{', '<']) {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        if let Some(inner) = tail.strip_prefix("{@") {
            let close = inner.find('}').unwrap_or(inner.len());
            let body = &inner[..close];
            let mut parts = body.splitn(2, char::is_whitespace);
            let tag = parts.next().unwrap_or("");
            let arg = parts.next().unwrap_or("").trim();
            let shown = match tag {
                "link" | "linkplain" => {
                    let mut p = arg.splitn(2, char::is_whitespace);
                    let target = p.next().unwrap_or("");
                    let label = p.next().unwrap_or("").trim();
                    if label.is_empty() {
                        let t = target.trim_start_matches('#');
                        let t = t.split('(').next().unwrap_or(t);
                        t.rsplit(['.', '#']).next().unwrap_or(t).to_owned()
                    } else {
                        label.to_owned()
                    }
                }
                _ => arg.to_owned(),
            };
            out.push_str(&shown);
            rest = inner.get(close + 1..).unwrap_or("");
        } else if tail.starts_with('<') {
            let close = tail.find('>').map_or(tail.len(), |c| c + 1);
            if tail.starts_with("<p") || tail.starts_with("<br") {
                out.push(' ');
            }
            rest = &tail[close..];
        } else {
            out.push('{');
            rest = &tail[1..];
        }
    }
    out.push_str(rest);
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&").replace("&quot;", "\"")
}

/// Byte offset of the start of 0-based `line`.
pub fn line_start(text: &str, line: u32) -> usize {
    if line == 0 {
        return 0;
    }
    text.match_indices('\n').nth(line as usize - 1).map_or(text.len(), |(i, _)| i + 1)
}

// ---------------------------------------------------------------------------
// Types as metadata writes them

/// `java.util.Map<java.lang.String,java.lang.Integer>`; primitives boxed; nested classes with `$`.
pub fn meta_type(t: &Type) -> Option<String> {
    use ide_java::classfile::BaseType as B;
    Some(match t {
        Type::Prim(b) => match b {
            B::Boolean => "java.lang.Boolean",
            B::Int => "java.lang.Integer",
            B::Long => "java.lang.Long",
            B::Double => "java.lang.Double",
            B::Float => "java.lang.Float",
            B::Short => "java.lang.Short",
            B::Byte => "java.lang.Byte",
            B::Char => "java.lang.Character",
        }
        .to_owned(),
        Type::Class(c) => {
            let mut s = c.key.replace('/', ".");
            let args: Vec<String> = c
                .args
                .iter()
                .filter_map(|a| match a {
                    TypeArg::Exact(t) | TypeArg::Extends(t) => meta_type(t),
                    TypeArg::Super(_) | TypeArg::Any => Some("?".to_owned()),
                })
                .collect();
            if !args.is_empty() {
                s.push('<');
                s.push_str(&args.join(","));
                s.push('>');
            }
            s
        }
        Type::Array(e) => format!("{}[]", meta_type(e)?),
        Type::Var(_) => "java.lang.Object".to_owned(),
        _ => return None,
    })
}

fn key_of(fqn: &str) -> String {
    fqn.replace('.', "/")
}

// ---------------------------------------------------------------------------
// Bean properties

/// One bindable property of a class.
#[derive(Clone, Debug)]
pub struct Prop {
    /// The Java name (`maxPoolSize`), or `@Name`'s.
    pub name: String,
    pub ty: Type,
    /// Declared in source: its file and line (description, defaults, annotations).
    pub field: Option<(TypeId, usize)>,
    pub getter: Option<(TypeId, usize)>,
    pub param: Option<(TypeId, usize, usize)>,
    /// Bound through a constructor.
    pub constructor: bool,
}

fn is_java_value(key: &str) -> bool {
    key.starts_with("java/") || key.starts_with("javax/") || key.starts_with("jakarta/") || key.starts_with("kotlin/")
}

fn capitalize_rest(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => {
            // `URL` stays `URL`; `Name` → `name` (java.beans.Introspector.decapitalize).
            let rest: String = c.collect();
            if rest.chars().next().is_some_and(char::is_uppercase) && f.is_uppercase() {
                format!("{f}{rest}")
            } else {
                format!("{}{rest}", f.to_lowercase())
            }
        }
        None => String::new(),
    }
}

/// The source type and member index of a class's source declaration for a member name.
fn source_member(view: &JavaView, c: &ClassData, pred: impl Fn(&JavaMember) -> bool) -> Option<(TypeId, usize)> {
    let ide_java::model::Origin::Source(id) = c.origin else { return None };
    let t = view.ty(id)?;
    t.members.iter().position(pred).map(|i| (id, i))
}

/// Whether a class binds through a constructor, and its constructor's source declaration.
fn binding_constructor(view: &JavaView, c: &ClassData) -> Option<(TypeId, usize)> {
    let ide_java::model::Origin::Source(id) = c.origin else { return None };
    let t = view.ty(id)?;
    let ctors: Vec<usize> =
        t.members.iter().enumerate().filter(|(_, m)| m.kind == JavaMemberKind::Constructor).map(|(i, _)| i).collect();
    if let Some(&i) = ctors.iter().find(|&&i| t.members[i].annotations.iter().any(|a| a == "ConstructorBinding")) {
        return Some((id, i));
    }
    let with_params: Vec<usize> = ctors.iter().copied().filter(|&i| !t.members[i].params.is_empty()).collect();
    if with_params.len() == 1
        && ctors.len() == 1
        && !t.members[with_params[0]].annotations.iter().any(|a| a == "Autowired")
    {
        return Some((id, with_params[0]));
    }
    None
}

/// The bindable properties of class `key` (JavaBean setters / getters of mutable values, record
/// components, a binding constructor's parameters). `None` when the class is no bean.
pub fn properties(model: &Model, key: &str) -> Option<Vec<Prop>> {
    let c = model.class(key)?;
    if is_java_value(key) || matches!(c.kind, JavaKind::Enum | JavaKind::Annotation | JavaKind::Interface) {
        return None;
    }
    let view = model.view;
    let members = model.members(&c);
    let mut out: Vec<Prop> = Vec::new();
    // Records and constructor binding.
    if c.kind == JavaKind::Record {
        for f in members.fields.iter().filter(|f| f.flags & 0x0008 == 0) {
            out.push(Prop {
                name: f.name.clone(),
                ty: f.ty.clone(),
                field: source_member(view, &c, |m| m.kind == JavaMemberKind::Field && m.name == f.name),
                getter: None,
                param: None,
                constructor: true,
            });
        }
        return Some(out);
    }
    if let Some((id, ci)) = binding_constructor(view, &c) {
        let ctor = &view.ty(id)?.members[ci];
        let method =
            members.methods.iter().find(|m| m.is_constructor() && m.params.len() == ctor.param_details.len())?;
        for (pi, (p, ty)) in ctor.param_details.iter().zip(&method.params).enumerate() {
            let name = p
                .annotation_args
                .iter()
                .find(|a| a.simple_name() == "Name")
                .and_then(|a| a.arg("value")?.as_str().map(str::to_owned))
                .unwrap_or_else(|| p.name.clone());
            out.push(Prop {
                name,
                ty: ty.clone(),
                field: source_member(view, &c, |m| m.kind == JavaMemberKind::Field && m.name == p.name),
                getter: None,
                param: Some((id, ci, pi)),
                constructor: true,
            });
        }
        return Some(out);
    }
    // JavaBean: setters, and getters of values that are mutated in place.
    let mut seen = HashSet::new();
    let mut add = |name: String, ty: Type, getter: Option<(TypeId, usize)>, out: &mut Vec<Prop>| {
        if name.is_empty() || !seen.insert(name.clone()) {
            return;
        }
        let field = source_member(view, &c, |m| m.kind == JavaMemberKind::Field && m.name == name);
        out.push(Prop { name, ty, field, getter, param: None, constructor: false });
    };
    let mut current = Some(c.clone());
    let mut depth = 0;
    while let Some(cls) = current {
        let ms = model.members(&cls);
        for m in &ms.methods {
            if m.is_static() || m.flags & 0x0001 == 0 {
                continue;
            }
            if let Some(n) = m.name.strip_prefix("set")
                && m.params.len() == 1
                && !n.is_empty()
            {
                let prop = capitalize_rest(n);
                let getter = source_member(view, &cls, |x| {
                    x.kind == JavaMemberKind::Method
                        && x.params.is_empty()
                        && (x.name == format!("get{n}") || x.name == format!("is{n}"))
                });
                add(prop, m.params[0].clone(), getter, &mut out);
            }
        }
        for m in &ms.methods {
            if m.is_static() || m.flags & 0x0001 == 0 || !m.params.is_empty() {
                continue;
            }
            let Some(n) = m.name.strip_prefix("get").filter(|n| !n.is_empty()) else { continue };
            let mutable = match &m.ret {
                Type::Class(ct) => {
                    let k = &*ct.key;
                    k.starts_with("java/util/")
                        && (k.contains("Map") || k.contains("List") || k.contains("Set") || k.contains("Collection"))
                        || cls.member_classes.iter().any(|(_, mk)| *mk == ct.key)
                        || source_member(view, &cls, |x| {
                            x.kind == JavaMemberKind::Field
                                && x.name == capitalize_rest(n)
                                && x.annotations.iter().any(|a| a == "NestedConfigurationProperty")
                        })
                        .is_some()
                }
                _ => false,
            };
            if mutable {
                let getter = source_member(view, &cls, |x| {
                    x.kind == JavaMemberKind::Method && x.name == m.name && x.params.is_empty()
                });
                add(capitalize_rest(n), m.ret.clone(), getter, &mut out);
            }
        }
        depth += 1;
        current = match (&cls.super_class, depth < 8) {
            (Some(Type::Class(sc)), true) if &*sc.key != ide_java::types::OBJECT => model.class(&sc.key),
            _ => None,
        };
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// Answers for configuration files

/// The Java engine's answers to [`TypeOracle`] for one module.
pub struct JavaTypes<'m, 'a> {
    pub model: &'m Model<'a>,
    /// Source text of a Java file (open editor first).
    pub read: &'m dyn Fn(&Path) -> Option<Arc<str>>,
    /// Beans of the Spring model: (name, qualified type).
    pub beans: Vec<(String, String)>,
    texts: RefCell<HashMap<PathBuf, Option<Arc<str>>>>,
    kinds: RefCell<HashMap<String, ClassKind>>,
}

impl<'m, 'a> JavaTypes<'m, 'a> {
    pub fn new(model: &'m Model<'a>, read: &'m dyn Fn(&Path) -> Option<Arc<str>>) -> Self {
        Self { model, read, beans: Vec::new(), texts: RefCell::default(), kinds: RefCell::default() }
    }

    fn text(&self, file: u32) -> Option<Arc<str>> {
        let path = self.model.view.path(file)?.to_owned();
        if let Some(t) = self.texts.borrow().get(&path) {
            return t.clone();
        }
        let t = (self.read)(&path);
        self.texts.borrow_mut().insert(path, t.clone());
        t
    }

    /// The Javadoc of a member / type of a source file, by its 0-based line.
    pub fn doc_at(&self, file: u32, line: u32) -> Option<String> {
        let text = self.text(file)?;
        javadoc_before(&text, line_start(&text, line))
    }

    fn key(&self, fqn: &str) -> Option<String> {
        let base = fqn.split('<').next().unwrap_or(fqn).trim();
        if base.contains('/') {
            return Some(base.to_owned());
        }
        if let Some(k) = self.model.by_dotted(&base.replace('$', ".")) {
            return Some(k.to_string());
        }
        let k = key_of(base);
        self.model.class(&k).map(|_| k)
    }

    fn describe(&self, p: &Prop) -> Option<String> {
        let at = p.field.or(p.getter)?;
        let m = &self.model.view.ty(at.0)?.members[at.1];
        self.doc_at(at.0.file, m.at.line)
    }
}

impl TypeOracle for JavaTypes<'_, '_> {
    fn class_kind(&self, fqn: &str) -> ClassKind {
        if let Some(k) = self.kinds.borrow().get(fqn) {
            return k.clone();
        }
        let kind = (|| {
            let key = self.key(fqn)?;
            let c = self.model.class(&key)?;
            Some(match c.kind {
                JavaKind::Enum => {
                    let members = self.model.members(&c);
                    let constants = members
                        .fields
                        .iter()
                        .filter(|f| f.enum_constant)
                        .map(|f| EnumConstant {
                            name: f.name.clone(),
                            description: source_member(self.model.view, &c, |m| {
                                m.name == f.name
                                    && matches!(m.kind, JavaMemberKind::Field | JavaMemberKind::EnumConstant)
                            })
                            .and_then(|(id, i)| self.doc_at(id.file, self.model.view.ty(id)?.members[i].at.line)),
                        })
                        .collect();
                    ClassKind::Enum(constants)
                }
                _ if is_java_value(&key) => ClassKind::Value,
                JavaKind::Interface | JavaKind::Annotation => ClassKind::Unknown,
                _ => match properties(self.model, &key) {
                    Some(props) if !props.is_empty() => ClassKind::Bean(
                        props
                            .iter()
                            .map(|p| BeanProperty {
                                name: name::kebab(&p.name),
                                ty: meta_type(&p.ty),
                                description: self.describe(p),
                            })
                            .collect(),
                    ),
                    _ => ClassKind::Unknown,
                },
            })
        })()
        .unwrap_or(ClassKind::Unknown);
        self.kinds.borrow_mut().insert(fqn.to_owned(), kind.clone());
        kind
    }

    fn class_exists(&self, fqn: &str) -> Option<bool> {
        if self.model.cp.roots().is_empty() {
            return None;
        }
        Some(self.key(fqn).is_some())
    }

    fn subclasses(&self, target: Option<&str>, concrete: bool, limit: usize) -> Vec<String> {
        let Some(target) = target.and_then(|t| self.key(t)) else { return Vec::new() };
        let simple = target.rsplit(['/', '$']).next().unwrap_or(&target).to_owned();
        let mut candidates: Vec<String> = Vec::new();
        // Library classes: service registrations, and classes named like the target.
        let service = format!("META-INF/services/{}", target.replace('/', "."));
        for root in self.model.cp.roots() {
            if let Some(Ok(bytes)) = root.read_resource(&service) {
                for line in String::from_utf8_lossy(&bytes).lines() {
                    let l = line.split('#').next().unwrap_or("").trim();
                    if !l.is_empty() {
                        candidates.push(key_of(l));
                    }
                }
            }
            for pkg in root.packages() {
                for class in root.class_files(pkg) {
                    if class.ends_with(&simple) && !class.contains('$') {
                        candidates.push(if pkg.is_empty() { class.to_owned() } else { format!("{pkg}/{class}") });
                    }
                }
            }
        }
        // Source classes naming the target among their supertypes.
        for id in self.model.view.types_with_super(&simple) {
            if let Some(k) = self.model.source_key(id) {
                candidates.push(k.to_string());
            }
        }
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for k in candidates {
            if out.len() >= limit || !seen.insert(k.clone()) || k == target {
                continue;
            }
            let Some(c) = self.model.class(&k) else { continue };
            if concrete && (c.is_interface() || c.flags & 0x0400 != 0) {
                continue;
            }
            if self.model.is_subclass(&k, &target) {
                out.push(k.replace(['/', '$'], "."));
            }
        }
        out.sort();
        out
    }

    fn class_doc(&self, fqn: &str) -> Option<String> {
        let key = self.key(fqn)?;
        let id = self.model.source_type(&key)?;
        let t = self.model.view.ty(id)?;
        self.doc_at(id.file, t.at.line)
    }

    fn logger_names(&self, prefix: &str, limit: usize) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut seen = HashSet::new();
        let slashed = prefix.replace('.', "/");
        // Packages, then the classes of a package named exactly.
        let parent = slashed.rsplit_once('/').map_or("", |(p, _)| p);
        for root in self.model.cp.roots() {
            for pkg in root.packages() {
                if pkg.starts_with(&slashed) && seen.insert(pkg.to_owned()) {
                    out.push(pkg.replace('/', "."));
                }
                if pkg == parent || pkg == slashed {
                    for class in root.class_files(pkg) {
                        if !class.contains('$') {
                            let full = format!("{pkg}/{class}");
                            if full.starts_with(&slashed) && seen.insert(full.clone()) {
                                out.push(full.replace('/', "."));
                            }
                        }
                    }
                }
                if out.len() > limit * 4 {
                    break;
                }
            }
        }
        for (pkg, classes) in self.model.view.source_packages() {
            let dotted = pkg.clone();
            if dotted.starts_with(prefix) && seen.insert(dotted.replace('.', "/")) {
                out.push(dotted.clone());
            }
            for c in classes {
                let full = if dotted.is_empty() { c } else { format!("{dotted}.{c}") };
                if full.starts_with(prefix) && seen.insert(full.replace('.', "/")) {
                    out.push(full);
                }
            }
        }
        out.sort();
        out.truncate(limit);
        out
    }

    fn beans(&self, target: Option<&str>) -> Vec<(String, String)> {
        let target = target.and_then(|t| self.key(t));
        self.beans
            .iter()
            .filter(|(_, ty)| match &target {
                Some(t) => self.key(ty).is_some_and(|k| self.model.is_subclass(&k, t)),
                None => true,
            })
            .cloned()
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Metadata from @ConfigurationProperties sources

/// A `@ConfigurationProperties` declaration: a class, or a `@Bean` method (its return type).
struct Declaration {
    prefix: String,
    /// The bound class.
    key: String,
    source_type: String,
    source_method: Option<String>,
    deprecated: bool,
}

fn prefix_of(a: &JavaAnnotation) -> Option<String> {
    let v = a.arg("prefix").or_else(|| a.arg("value"))?;
    v.as_str().map(str::to_owned)
}

/// Works out the metadata of the `@ConfigurationProperties` types of `files` (index slots of
/// the module's source files). One entry per file declaring something.
pub fn derive(types: &JavaTypes, files: &[u32]) -> Vec<(PathBuf, RawMetadata)> {
    let model = types.model;
    let view = model.view;
    let mut out = Vec::new();
    for &file in files {
        let Some(stub) = view.stub(file) else { continue };
        let Some(path) = view.path(file).map(Path::to_owned) else { continue };
        let mut decls = Vec::new();
        for (ti, t) in stub.types.iter().enumerate() {
            let id = TypeId { file, ty: ti as u32 };
            let Some(key) = model.source_key(id) else { continue };
            let deprecated = t.annotations.iter().any(|a| a == "Deprecated");
            if let Some(a) = t.annotation_args.iter().find(|a| a.simple_name() == "ConfigurationProperties")
                && let Some(prefix) = prefix_of(a)
            {
                decls.push(Declaration {
                    prefix,
                    key: key.to_string(),
                    source_type: key.replace('/', "."),
                    source_method: None,
                    deprecated,
                });
            }
            for m in &t.members {
                if m.kind != JavaMemberKind::Method {
                    continue;
                }
                let Some(a) = m.annotation_args.iter().find(|a| a.simple_name() == "ConfigurationProperties") else {
                    continue;
                };
                let Some(prefix) = prefix_of(a) else { continue };
                let scope = Scope { class: Some(key.clone()), file: Some(file), ..Default::default() };
                let ret = model.resolve_text(&m.sig.ty, &scope);
                let Some(ct) = ret.as_class() else { continue };
                decls.push(Declaration {
                    prefix,
                    key: ct.key.to_string(),
                    source_type: key.replace('/', "."),
                    source_method: Some(format!("{}()", m.name)),
                    deprecated: m.annotations.iter().any(|a| a == "Deprecated"),
                });
            }
        }
        if decls.is_empty() {
            continue;
        }
        let mut raw = RawMetadata::default();
        for d in decls {
            if !name::is_valid_prefix(&d.prefix) {
                continue;
            }
            let ty = d.key.replace('/', ".");
            raw.groups.push(RawItem {
                name: Some(d.prefix.clone()),
                ty: Some(ty.clone()),
                source_type: Some(d.source_type.clone()),
                source_method: d.source_method.clone(),
                ..Default::default()
            });
            let mut visiting = HashSet::new();
            group(types, &d.key, &d.prefix, &ty, d.deprecated, &mut raw, &mut visiting, 0);
        }
        out.push((path, raw));
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn group(
    types: &JavaTypes,
    key: &str,
    prefix: &str,
    source_type: &str,
    deprecated: bool,
    raw: &mut RawMetadata,
    visiting: &mut HashSet<String>,
    depth: usize,
) {
    if depth > 8 || !visiting.insert(key.to_owned()) {
        return;
    }
    let model = types.model;
    let Some(props) = properties(model, key) else { return };
    let Some(class) = model.class(key) else { return };
    for p in props {
        let kebab = name::kebab(&p.name);
        let full = format!("{prefix}.{kebab}");
        let annotations = annotations_of(types, &p);
        let nested_marked = annotations.iter().any(|a| a.simple_name() == "NestedConfigurationProperty");
        let nested_key = match &p.ty {
            Type::Class(ct) if ct.args.is_empty() => {
                let inner = class.member_classes.iter().any(|(_, k)| *k == ct.key);
                let bean = !is_java_value(&ct.key)
                    && model.class(&ct.key).is_some_and(|c| matches!(c.kind, JavaKind::Class | JavaKind::Record));
                (bean && (inner || nested_marked)).then(|| ct.key.to_string())
            }
            _ => None,
        };
        let prop_deprecated = deprecated || annotations.iter().any(|a| a.simple_name() == "Deprecated");
        let deprecation =
            annotations.iter().find(|a| a.simple_name() == "DeprecatedConfigurationProperty").map(|a| RawDeprecation {
                level: Some("warning".into()),
                reason: a.arg("reason").and_then(AnnotationValue::as_str).map(str::to_owned).filter(|s| !s.is_empty()),
                replacement: a
                    .arg("replacement")
                    .and_then(AnnotationValue::as_str)
                    .map(str::to_owned)
                    .filter(|s| !s.is_empty()),
                since: a.arg("since").and_then(AnnotationValue::as_str).map(str::to_owned).filter(|s| !s.is_empty()),
            });
        if let Some(nk) = nested_key {
            let ty = nk.replace('/', ".");
            raw.groups.push(RawItem {
                name: Some(full.clone()),
                ty: Some(ty.clone()),
                source_type: Some(source_type.to_owned()),
                source_method: Some(format!("get{}()", upper_first(&p.name))),
                ..Default::default()
            });
            group(types, &nk, &full, &ty, prop_deprecated, raw, visiting, depth + 1);
            continue;
        }
        raw.properties.push(RawItem {
            name: Some(full),
            ty: meta_type(&p.ty),
            description: if p.constructor {
                param_doc(types, &p).or_else(|| types.describe(&p))
            } else {
                types.describe(&p).or_else(|| param_doc(types, &p))
            },
            source_type: Some(source_type.to_owned()),
            default_value: default_of(types, &p, &annotations),
            deprecated: (prop_deprecated || deprecation.is_some()).then_some(true),
            deprecation,
            ..Default::default()
        });
    }
    visiting.remove(key);
}

fn upper_first(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
}

/// The annotations on a property's field, getter and constructor parameter.
fn annotations_of(types: &JavaTypes, p: &Prop) -> Vec<JavaAnnotation> {
    let view = types.model.view;
    let mut out = Vec::new();
    for (id, i) in [p.field, p.getter].into_iter().flatten() {
        if let Some(m) = view.ty(id).and_then(|t| t.members.get(i)) {
            out.extend(m.annotation_args.iter().cloned());
        }
    }
    if let Some((id, ci, pi)) = p.param
        && let Some(param) = view.ty(id).and_then(|t| t.members.get(ci)).and_then(|m| m.param_details.get(pi))
    {
        out.extend(param.annotation_args.iter().cloned());
    }
    out
}

/// A record component's or constructor parameter's `@param` documentation.
fn param_doc(types: &JavaTypes, p: &Prop) -> Option<String> {
    let view = types.model.view;
    let (id, line) = match p.param {
        Some((id, ci, _)) => (id, view.ty(id)?.members.get(ci)?.at.line),
        None if p.constructor => (p.field?.0, view.ty(p.field?.0)?.at.line),
        None => return None,
    };
    let text = types.text(id.file)?;
    let comment = raw_javadoc_before(&text, line_start(&text, line))?;
    let tag = format!("@param {}", p.name);
    let at = comment.find(&tag)?;
    let rest = &comment[at + tag.len()..];
    let end = rest.find("\n * @").or_else(|| rest.find("@param")).unwrap_or(rest.len());
    Some(clean(&rest[..end])).filter(|s| !s.is_empty())
}

/// The default value of a property: `@DefaultValue`, or the literal its field is initialized with.
fn default_of(types: &JavaTypes, p: &Prop, annotations: &[JavaAnnotation]) -> Option<serde_json::Value> {
    if let Some(a) = annotations.iter().find(|a| a.simple_name() == "DefaultValue") {
        let values = a.arg("value").map(AnnotationValue::strings).unwrap_or_default();
        return match values.as_slice() {
            [] => None,
            [one] => Some(literal_default(one, &p.ty)),
            many => Some(serde_json::Value::Array(
                many.iter().map(|v| serde_json::Value::String((*v).to_owned())).collect(),
            )),
        };
    }
    let (id, i) = p.field?;
    let m = types.model.view.ty(id)?.members.get(i)?;
    let text = types.text(id.file)?;
    let init = initializer(&text, m.at.line, &m.name)?;
    evaluate(&init, &p.ty)
}

fn literal_default(v: &str, ty: &Type) -> serde_json::Value {
    use ide_java::classfile::BaseType as B;
    let boxed = |k: &str| matches!(ty, Type::Class(c) if &*c.key == k);
    match ty {
        Type::Prim(B::Boolean) => v.parse::<bool>().map(serde_json::Value::Bool).unwrap_or_else(|_| v.into()),
        Type::Prim(B::Int | B::Long | B::Short | B::Byte) => {
            v.parse::<i64>().map(Into::into).unwrap_or_else(|_| v.into())
        }
        _ if boxed("java/lang/Boolean") => v.parse::<bool>().map(serde_json::Value::Bool).unwrap_or_else(|_| v.into()),
        _ if boxed("java/lang/Integer") || boxed("java/lang/Long") => {
            v.parse::<i64>().map(Into::into).unwrap_or_else(|_| v.into())
        }
        _ => v.into(),
    }
}

/// The initializer expression text of field `name` declared on `line`.
fn initializer(text: &str, line: u32, name: &str) -> Option<String> {
    let start = line_start(text, line);
    let rest = &text[start..];
    let decl = &rest[..rest.find(';')?];
    let at = decl.find(name)?;
    let after = decl[at + name.len()..].trim_start();
    let expr = after.strip_prefix('=')?.trim();
    (!expr.is_empty() && expr.len() < 200).then(|| expr.to_owned())
}

/// The value of a simple initializer, as the annotation processor writes it.
fn evaluate(expr: &str, ty: &Type) -> Option<serde_json::Value> {
    let e = expr.trim();
    if let Some(s) = e.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
        if s.contains('"') {
            return None;
        }
        return Some(serde_json::from_str::<String>(&format!("\"{s}\"")).ok()?.into());
    }
    if e == "true" || e == "false" {
        return Some(serde_json::Value::Bool(e == "true"));
    }
    let num = e.trim_end_matches(['L', 'l', 'd', 'D', 'f', 'F']).replace('_', "");
    if let Ok(n) = num.parse::<i64>() {
        return Some(n.into());
    }
    if num.contains('.')
        && let Ok(n) = num.parse::<f64>()
    {
        return serde_json::Number::from_f64(n).map(serde_json::Value::Number);
    }
    // Duration.ofSeconds(30) → 30s, DataSize.ofMegabytes(10) → 10MB.
    let call = |prefix: &str| -> Option<i64> {
        let inner = e.strip_prefix(prefix)?.strip_suffix(')')?;
        inner.trim().trim_end_matches(['L', 'l']).replace('_', "").parse().ok()
    };
    for (p, unit) in [
        ("Duration.ofNanos(", "ns"),
        ("Duration.ofMillis(", "ms"),
        ("Duration.ofSeconds(", "s"),
        ("Duration.ofMinutes(", "m"),
        ("Duration.ofHours(", "h"),
        ("Duration.ofDays(", "d"),
        ("DataSize.ofBytes(", "B"),
        ("DataSize.ofKilobytes(", "KB"),
        ("DataSize.ofMegabytes(", "MB"),
        ("DataSize.ofGigabytes(", "GB"),
        ("DataSize.ofTerabytes(", "TB"),
        ("Period.ofDays(", "d"),
        ("Period.ofMonths(", "m"),
        ("Period.ofYears(", "y"),
    ] {
        if let Some(n) = call(p) {
            return Some(format!("{n}{unit}").into());
        }
    }
    if let Some(cs) = e.strip_prefix("StandardCharsets.") {
        return Some(cs.replace('_', "-").into());
    }
    // An enum constant of the property's own type: written lowercase with dashes.
    if let Type::Class(ct) = ty {
        let simple = ct.key.rsplit(['/', '$']).next().unwrap_or(&ct.key);
        if let Some(constant) = e.strip_prefix(simple).and_then(|r| r.strip_prefix('.'))
            && constant.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        {
            return Some(constant.to_lowercase().replace('_', "-").into());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn javadoc_text() {
        let text = "class A {\n    /**\n     * Maximum {@code size} of the {@link java.util.List pool}.\n     * <p>\n     * See {@link Other#method()}.\n     * @since 1.0\n     */\n    @Deprecated\n    private int size = 10;\n}\n";
        let line = text.lines().position(|l| l.contains("private int size")).unwrap() as u32;
        assert_eq!(javadoc_before(text, line_start(text, line)).unwrap(), "Maximum size of the pool. See method.");
        assert_eq!(javadoc_before("class A {\n  int x;\n}", line_start("class A {\n  int x;\n}", 1)), None);
    }

    #[test]
    fn evaluates_defaults() {
        let s = Type::string();
        assert_eq!(evaluate("\"x\\ty\"", &s), Some("x\ty".into()));
        assert_eq!(evaluate("10_000L", &s), Some(10000.into()));
        assert_eq!(evaluate("Duration.ofSeconds(30)", &s), Some("30s".into()));
        assert_eq!(evaluate("DataSize.ofMegabytes(10)", &s), Some("10MB".into()));
        assert_eq!(evaluate("StandardCharsets.UTF_8", &s), Some("UTF-8".into()));
        assert_eq!(evaluate("Mode.SLOW_START", &Type::class("demo/Mode")), Some("slow-start".into()));
        assert_eq!(evaluate("compute()", &s), None);
        assert_eq!(initializer("  private int size = 10;\n", 0, "size").as_deref(), Some("10"));
        assert_eq!(initializer("  private String name;\n", 0, "name"), None);
    }

    const MAIL: &str = r#"package demo;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "app.mail")
public class MailProperties {
    /** SMTP host. */
    private String host = "localhost";
    /** Port of the {@code SMTP} server. */
    private int port = 25;
    private Duration timeout = Duration.ofSeconds(30);
    private final List<String> recipients = new ArrayList<>();
    private final Pool pool = new Pool();
    private Mode mode = Mode.SLOW_START;
    private String legacy;
    public String getHost() { return host; }
    public void setHost(String host) { this.host = host; }
    public int getPort() { return port; }
    public void setPort(int port) { this.port = port; }
    public Duration getTimeout() { return timeout; }
    public void setTimeout(Duration timeout) { this.timeout = timeout; }
    public List<String> getRecipients() { return recipients; }
    public Pool getPool() { return pool; }
    public Mode getMode() { return mode; }
    public void setMode(Mode mode) { this.mode = mode; }
    @Deprecated
    public String getLegacy() { return legacy; }
    public void setLegacy(String legacy) { this.legacy = legacy; }

    public static class Pool {
        /** Maximum size. */
        private int maxSize = 8;
        public int getMaxSize() { return maxSize; }
        public void setMaxSize(int maxSize) { this.maxSize = maxSize; }
    }
}
"#;

    const MODE: &str =
        "package demo;\n/** Modes. */\npublic enum Mode {\n    /** Fast. */\n    FAST,\n    SLOW_START\n}\n";

    const SERVER: &str = r#"package demo;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * Server.
 * @param name the server name
 * @param port the port
 */
@ConfigurationProperties("app.server")
public record ServerProps(String name, @DefaultValue("8080") int port) {}
"#;

    #[test]
    fn derives_metadata_from_sources() {
        let Some(home) = std::env::var_os("JAVA_HOME").map(PathBuf::from).filter(|h| h.join("lib/modules").is_file())
        else {
            return;
        };
        let src = ide_index::testing::JavaSources::new(&[
            ("demo/MailProperties.java", MAIL),
            ("demo/Mode.java", MODE),
            ("demo/ServerProps.java", SERVER),
        ]);
        let cp = ide_java::classpath::ClassPath::open(&ide_java::classpath::jdk_roots(&home));
        let texts: HashMap<PathBuf, &str> =
            [("/p/demo/MailProperties.java", MAIL), ("/p/demo/Mode.java", MODE), ("/p/demo/ServerProps.java", SERVER)]
                .into_iter()
                .map(|(p, t)| (PathBuf::from(p), t))
                .collect();
        let read = |p: &Path| texts.get(p).map(|t| Arc::from(*t));
        src.with_view(|view| {
            let model = Model::new(view, &cp);
            let types = JavaTypes::new(&model, &read);
            let files: Vec<u32> = ["demo/MailProperties.java", "demo/Mode.java", "demo/ServerProps.java"]
                .iter()
                .filter_map(|f| src.file(f))
                .collect();
            let derived = derive(&types, &files);
            assert_eq!(derived.len(), 2);
            let all: Vec<&RawItem> = derived.iter().flat_map(|(_, r)| r.properties.iter()).collect();
            let get =
                |n: &str| *all.iter().find(|p| p.name.as_deref() == Some(n)).unwrap_or_else(|| panic!("{n}: {all:#?}"));
            let host = get("app.mail.host");
            assert_eq!(host.ty.as_deref(), Some("java.lang.String"));
            assert_eq!(host.description.as_deref(), Some("SMTP host."));
            assert_eq!(host.default_value, Some("localhost".into()));
            let port = get("app.mail.port");
            assert_eq!(port.ty.as_deref(), Some("java.lang.Integer"));
            assert_eq!(port.description.as_deref(), Some("Port of the SMTP server."));
            assert_eq!(port.default_value, Some(25.into()));
            assert_eq!(get("app.mail.timeout").default_value, Some("30s".into()));
            assert_eq!(get("app.mail.recipients").ty.as_deref(), Some("java.util.List<java.lang.String>"));
            assert_eq!(get("app.mail.mode").default_value, Some("slow-start".into()));
            assert_eq!(get("app.mail.mode").ty.as_deref(), Some("demo.Mode"));
            let max = get("app.mail.pool.max-size");
            assert_eq!(max.description.as_deref(), Some("Maximum size."));
            assert_eq!(max.default_value, Some(8.into()));
            assert_eq!(get("app.mail.legacy").deprecated, Some(true));
            assert_eq!(get("app.server.name").description.as_deref(), Some("the server name"));
            assert_eq!(get("app.server.port").default_value, Some(8080.into()));
            let groups: Vec<&str> =
                derived.iter().flat_map(|(_, r)| r.groups.iter().filter_map(|g| g.name.as_deref())).collect();
            assert!(
                groups.contains(&"app.mail") && groups.contains(&"app.mail.pool") && groups.contains(&"app.server")
            );
            // The oracle: enum constants with their Javadoc, nested bean properties.
            let ClassKind::Enum(constants) = types.class_kind("demo.Mode") else { panic!() };
            assert_eq!(constants[0].description.as_deref(), Some("Fast."));
            let ClassKind::Bean(props) = types.class_kind("demo.MailProperties$Pool") else { panic!() };
            assert_eq!(props[0].name, "max-size");
            assert_eq!(types.class_kind("java.time.Duration"), ClassKind::Value);
            assert_eq!(types.class_exists("demo.Mode"), Some(true));
            assert_eq!(types.class_exists("demo.Nope"), Some(false));
            assert!(types.logger_names("demo", 10).contains(&"demo.MailProperties".to_owned()));
        });
    }
}
