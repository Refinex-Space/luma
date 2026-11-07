//! Usages of a declaration in a parsed file (IDEA's `ReferencesSearch` / `MethodReferencesSearch`
//! with `MethodTextOccurrenceProcessor`, after the identifier index chose the candidate files):
//! every occurrence of the declaration's name is resolved and classified as a usage, not a usage,
//! or undecided ([`FileUsages::undecided`]), which callers hand to the compiler-grade server.
//!
//! What counts follows IDEA's usages inlay (`JavaTelescope`, `UsagesCountManager`): a method's
//! usages are those of its deepest super methods (`DeepestSuperMethodsSearch`), and a reference
//! that resolves to an override of one of them counts too
//! (`MethodTextOccurrenceProcessor.processInexactReference`). A field's usages include its
//! accessors' when `accessors` is set (JDT LS's `includeAccessors`, Luma's default).

use crate::model::{ACC_PRIVATE, MethodData, Model};
use crate::resolve::{FileAnalysis, Resolution, Target, method_desc};
use crate::types::{Key, Type};
use std::collections::HashSet;
use tree_sitter::Node;

/// What usages of one declaration are.
#[derive(Clone, Debug)]
pub struct UsageQuery {
    pub target: Target,
    /// Names whose occurrences may be usages (the declaration's, its accessors').
    pub names: Vec<String>,
    /// Targets a reference may resolve to and count.
    exact: HashSet<Target>,
    /// Methods whose overrides count: (class, name, erased parameters).
    roots: Vec<(Key, MethodData)>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FileUsages {
    /// Byte ranges of the usages.
    pub usages: Vec<(usize, usize)>,
    /// Occurrences the engine could not decide: their byte offsets.
    pub undecided: Vec<usize>,
}

impl FileUsages {
    pub fn decided(&self) -> bool {
        self.undecided.is_empty()
    }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().chain(c).collect(),
        None => String::new(),
    }
}

/// The deepest methods `m` (declared in `class`) overrides (JLS §8.4.8.1): methods of supertypes
/// with the same name and erased parameters after substitution, that override nothing above.
pub fn deepest_supers(model: &Model, class: &Key, m: &MethodData) -> Vec<(Key, MethodData)> {
    if m.is_constructor() || m.is_static() || m.flags & ACC_PRIVATE as u32 != 0 {
        return Vec::new();
    }
    let Some(c) = model.class(class) else { return Vec::new() };
    let mine: Vec<String> = m.params.iter().map(|p| model.erasure(p).to_string()).collect();
    let mut overridden: Vec<(Key, MethodData)> = Vec::new();
    for sup in model.all_supers(class).into_iter().skip(1) {
        let Some(view) = model.as_super(&c.self_type(), &sup) else { continue };
        let Some(sc) = model.class(&sup) else { continue };
        let subst = model.subst_of(&view);
        for sm in model.members(&sc).methods.iter().filter(|x| x.name == m.name && x.params.len() == m.params.len()) {
            if sm.is_static() || sm.flags & ACC_PRIVATE as u32 != 0 {
                continue;
            }
            let theirs: Vec<String> =
                sm.params.iter().map(|p| model.erasure(&model.apply(&subst, p)).to_string()).collect();
            if theirs == mine {
                overridden.push((sup.clone(), sm.clone()));
            }
        }
    }
    // Keep those whose class has no other overridden method's class above it.
    let deepest: Vec<(Key, MethodData)> = overridden
        .iter()
        .filter(|(k, _)| !overridden.iter().any(|(o, _)| o != k && model.is_subclass(k, o)))
        .cloned()
        .collect();
    deepest
}

/// Whether method `r` of class `rc` overrides `root` of class `root_class` (or is it).
pub fn overrides(model: &Model, rc: &Key, r: &MethodData, root_class: &Key, root: &MethodData) -> bool {
    if r.name != root.name || r.params.len() != root.params.len() {
        return false;
    }
    if rc == root_class {
        return method_desc(model, r) == method_desc(model, root);
    }
    if r.is_static() || root.is_static() || !model.is_subclass(rc, root_class) {
        return false;
    }
    let Some(c) = model.class(rc) else { return false };
    let Some(view) = model.as_super(&c.self_type(), root_class) else { return false };
    let subst = model.subst_of(&view);
    let mine: Vec<String> = r.params.iter().map(|p| model.erasure(p).to_string()).collect();
    let theirs: Vec<String> = root.params.iter().map(|p| model.erasure(&model.apply(&subst, p)).to_string()).collect();
    mine == theirs
}

impl UsageQuery {
    /// The query for `target` (`accessors`: a field's getter / setter count as its usages).
    pub fn new(model: &Model, target: &Target, accessors: bool) -> Self {
        let mut q = UsageQuery { target: target.clone(), names: Vec::new(), exact: HashSet::new(), roots: Vec::new() };
        q.exact.insert(target.clone());
        match target {
            Target::Method { class, name, desc } => {
                q.names.push(if name == "<init>" { simple_name(class) } else { name.clone() });
                let found = model.class(class).and_then(|c| {
                    model
                        .members(&c)
                        .methods
                        .iter()
                        .find(|m| &m.name == name && method_desc(model, m) == *desc)
                        .cloned()
                });
                if let Some(m) = found {
                    let deepest = deepest_supers(model, class, &m);
                    if deepest.is_empty() {
                        q.roots.push((class.clone(), m));
                    } else {
                        for (k, d) in &deepest {
                            q.exact.insert(Target::Method {
                                class: k.clone(),
                                name: d.name.clone(),
                                desc: method_desc(model, d),
                            });
                        }
                        q.roots = deepest;
                    }
                }
            }
            Target::Field { class, name } => {
                q.names.push(name.clone());
                if accessors && let Some(c) = model.class(class) {
                    let members = model.members(&c);
                    let is_bool = members
                        .fields
                        .iter()
                        .any(|f| &f.name == name && f.ty == Type::Prim(crate::classfile::BaseType::Boolean));
                    let cap = capitalize(name);
                    let mut accessor_names = vec![format!("get{cap}"), format!("set{cap}")];
                    if is_bool {
                        accessor_names.push(format!("is{cap}"));
                    }
                    for m in members.methods.iter().filter(|m| accessor_names.contains(&m.name)) {
                        let getter = m.params.is_empty() && !m.name.starts_with("set");
                        let setter = m.params.len() == 1 && m.name.starts_with("set");
                        if getter || setter {
                            q.exact.insert(Target::Method {
                                class: class.clone(),
                                name: m.name.clone(),
                                desc: method_desc(model, m),
                            });
                            if !q.names.contains(&m.name) {
                                q.names.push(m.name.clone());
                            }
                        }
                    }
                }
            }
            Target::Class(k) => q.names.push(simple_name(k)),
            Target::Local(_) | Target::TypeVar(_) | Target::Package(_) => {}
        }
        q
    }

    /// The query for the local variable (or parameter) declared at `target` as `name` (its
    /// name is in the file's text, not in the target).
    pub fn local(target: &Target, name: &str) -> Self {
        UsageQuery {
            target: target.clone(),
            names: vec![name.to_owned()],
            exact: HashSet::from([target.clone()]),
            roots: Vec::new(),
        }
    }

    /// Whether the methods this query counts all belong to source classes (a rename can change
    /// every declaration of the family); `false` when one is a library's.
    pub fn family_in_sources(&self, model: &Model) -> bool {
        let source = |k: &Key| model.class(k).is_some_and(|c| matches!(c.origin, crate::model::Origin::Source(_)));
        self.roots.iter().all(|(k, _)| source(k))
            && self.exact.iter().all(|t| match t {
                Target::Method { class, .. } | Target::Field { class, .. } | Target::Class(class) => source(class),
                _ => true,
            })
    }

    /// Whether resolving an occurrence to `r` makes it a usage; `None` when that cannot be told
    /// (a signature with a type the engine does not know: the method may or may not override).
    fn decide(&self, model: &Model, r: &Target) -> Option<bool> {
        if self.exact.contains(r) {
            return Some(true);
        }
        let Target::Method { class, name, desc } = r else { return Some(false) };
        let same_name = self.roots.iter().any(|(_, m)| &m.name == name)
            || self.exact.iter().any(|t| matches!(t, Target::Method { name: n, .. } if n == name));
        if !same_name {
            return Some(false);
        }
        let unknown = |d: &str| d.contains("?unknown");
        let ours_unknown =
            self.exact.iter().any(|t| matches!(t, Target::Method { name: n, desc: d, .. } if n == name && unknown(d)));
        if unknown(desc) || ours_unknown {
            return None;
        }
        if self.roots.is_empty() {
            return Some(false);
        }
        let c = model.class(class)?;
        let m =
            model.members(&c).methods.iter().find(|m| &m.name == name && method_desc(model, m) == *desc).cloned()?;
        Some(self.roots.iter().any(|(rk, rm)| overrides(model, class, &m, rk, rm)))
    }
}

fn simple_name(key: &str) -> String {
    key.rsplit(['/', '$']).next().unwrap_or(key).to_owned()
}

impl<'t> FileAnalysis<'_, '_, 't> {
    /// Usages of `q` in this file. The declaration itself is not a usage.
    pub fn usages(&self, q: &UsageQuery) -> FileUsages {
        let mut out = FileUsages::default();
        if q.names.is_empty() {
            return out;
        }
        let ctor = matches!(&q.target, Target::Method { name, .. } if name == "<init>");
        let mut stack = vec![self.tree.root_node()];
        while let Some(n) = stack.pop() {
            let mut c = n.walk();
            for child in n.children(&mut c) {
                stack.push(child);
            }
            if n.kind() == "block_comment" {
                self.doc_usages(n, q, &mut out);
                continue;
            }
            if ctor {
                self.constructor_usage(n, q, &mut out);
                continue;
            }
            if !matches!(n.kind(), "identifier" | "type_identifier") {
                continue;
            }
            let text = self.node_text(n);
            if !q.names.iter().any(|x| x == text) {
                continue;
            }
            if self.declared_target(n).is_some() {
                continue;
            }
            match self.resolve(n) {
                Resolution::Found(t) => match q.decide(self.model, &t) {
                    Some(true) => out.usages.push((n.start_byte(), n.end_byte())),
                    Some(false) => {}
                    None => out.undecided.push(n.start_byte()),
                },
                Resolution::Missing => {
                    // Nothing found: a code error, or a member generated by an annotation processor.
                    if self.may_be_generated(n) {
                        out.undecided.push(n.start_byte());
                    }
                }
                Resolution::Unknown => out.undecided.push(n.start_byte()),
                Resolution::Builtin => {}
            }
        }
        out.usages.sort_unstable();
        out.undecided.sort_unstable();
        out
    }

    /// The declarations of `q`'s target in this file: its own name and, for a method, the name
    /// of every method of its override family declared here (what a rename changes besides the
    /// usages).
    pub fn declarations(&self, q: &UsageQuery) -> FileUsages {
        let mut out = FileUsages::default();
        let mut stack = vec![self.tree.root_node()];
        while let Some(n) = stack.pop() {
            let mut c = n.walk();
            stack.extend(n.children(&mut c));
            if !matches!(n.kind(), "identifier" | "type_identifier") || !q.names.iter().any(|x| x == self.node_text(n))
            {
                continue;
            }
            let Some(t) = self.declared_target(n) else { continue };
            match q.decide(self.model, &t) {
                Some(true) => out.usages.push((n.start_byte(), n.end_byte())),
                Some(false) => {}
                None => out.undecided.push(n.start_byte()),
            }
        }
        out.usages.sort_unstable();
        out.undecided.sort_unstable();
        out
    }

    /// `new C(…)`, `this(…)` / `super(…)`, enum constants and `C::new` calling a constructor.
    fn constructor_usage(&self, n: Node<'t>, q: &UsageQuery, out: &mut FileUsages) {
        let name = &q.names[0];
        let (anchor, res) = match n.kind() {
            "object_creation_expression" => {
                let Some(ty) = n.child_by_field_name("type") else { return };
                let text = ide_index::java::type_text(ty, self.text);
                let base = text.split('<').next().unwrap_or(&text);
                if base.rsplit('.').next() != Some(name.as_str()) {
                    return;
                }
                (ty, self.call(n).res)
            }
            "explicit_constructor_invocation" => {
                let Some(kw) = n.child_by_field_name("constructor") else { return };
                (kw, self.call(n).res)
            }
            "enum_constant" => {
                let Some(id) = n.child_by_field_name("name") else { return };
                (id, self.call(n).res)
            }
            "method_reference" => {
                let is_new = n.child(n.child_count().saturating_sub(1)).is_some_and(|t| t.kind() == "new");
                if !is_new {
                    return;
                }
                (n, self.method_ref(n).0)
            }
            // A constructor without `this(…)` / `super(…)` calls its superclass's no-argument one;
            // so does the default constructor of a class declaring none (JLS §8.8.7, §8.8.9).
            "constructor_declaration" => {
                let Some(body) = n.child_by_field_name("body") else { return };
                let mut c = body.walk();
                let first = body.named_children(&mut c).find(|x| !x.is_extra());
                if first.is_some_and(|f| f.kind() == "explicit_constructor_invocation") {
                    return;
                }
                let Some(name) = n.child_by_field_name("name") else { return };
                (name, self.implicit_super(n))
            }
            "class_declaration" => {
                let Some(body) = n.child_by_field_name("body") else { return };
                let mut c = body.walk();
                if body.named_children(&mut c).any(|x| x.kind() == "constructor_declaration") {
                    return;
                }
                let Some(name) = n.child_by_field_name("name") else { return };
                let Some(key) = self.declared_key(n) else { return };
                (name, self.implicit_super_of(&key))
            }
            _ => return,
        };
        match res {
            Resolution::Found(t) => match q.decide(self.model, &t) {
                Some(true) => out.usages.push((anchor.start_byte(), anchor.end_byte())),
                Some(false) => {}
                None => out.undecided.push(anchor.start_byte()),
            },
            Resolution::Missing | Resolution::Builtin => {}
            Resolution::Unknown => out.undecided.push(anchor.start_byte()),
        }
    }

    /// Usages of `q` in the references of a doc comment.
    fn doc_usages(&self, comment: Node<'t>, q: &UsageQuery, out: &mut FileUsages) {
        let text = self.node_text(comment);
        if !text.starts_with("/**") || !q.names.iter().any(|n| text.contains(n.as_str())) {
            return;
        }
        for r in crate::javadoc::references(text, comment.start_byte()) {
            // The type and its qualifiers (`a.Outer.Inner`): each segment named as the searched
            // class is a usage of it when the prefix up to it resolves to it.
            if let Some((ty, at)) = &r.ty
                && matches!(q.target, Target::Class(_))
            {
                let last_start = at - ty.rfind('.').map_or(0, |i| i + 1);
                let mut offset = 0;
                for segment in ty.split('.') {
                    let seg_start = offset;
                    offset += segment.len() + 1;
                    if !q.names.iter().any(|n| n == segment) {
                        continue;
                    }
                    let prefix = &ty[..seg_start + segment.len()];
                    let pos = last_start + seg_start;
                    match self.doc_class(comment, Some(prefix)) {
                        Resolution::Found(t) if q.decide(self.model, &t) == Some(true) => {
                            out.usages.push((pos, pos + segment.len()))
                        }
                        Resolution::Unknown => out.undecided.push(pos),
                        _ => {}
                    }
                }
            }
            // The member, when its name is one searched.
            let Some((name, at)) = &r.member else { continue };
            let ctor = matches!(&q.target, Target::Method { name, .. } if name == "<init>");
            if !q.names.contains(name) || matches!(q.target, Target::Class(_)) {
                continue;
            }
            match self.doc_members(comment, &r, ctor) {
                Ok(targets) => {
                    let decisions: Vec<Option<bool>> = targets.iter().map(|t| q.decide(self.model, t)).collect();
                    if decisions.contains(&Some(true)) {
                        out.usages.push((*at, at + name.len()));
                    } else if decisions.contains(&None) {
                        out.undecided.push(*at);
                    }
                }
                Err(Resolution::Unknown) => out.undecided.push(*at),
                Err(_) => {}
            }
        }
    }

    /// The class a doc comment's reference names (`ty`), or the documented class (`None`).
    fn doc_class(&self, comment: Node<'t>, ty: Option<&str>) -> Resolution {
        // A comment before a class declaration documents that class.
        let mut next = comment.next_named_sibling();
        while let Some(n) = next.filter(|n| n.is_extra()) {
            next = n.next_named_sibling();
        }
        let documented = next.filter(|n| crate::resolve::is_class_decl(n.kind())).and_then(|d| self.declared_key(d));
        let class = documented.clone().or_else(|| self.enclosing_class(comment).map(|(_, k)| k));
        let Some(ty) = ty else {
            return match class {
                Some(k) => Resolution::Found(Target::Class(k)),
                None => Resolution::Unknown,
            };
        };
        let mut scope = self.scope_at(comment);
        if documented.is_some() {
            scope.class = documented;
            scope.header_of = None;
        }
        match self.model.resolve_text(ty, &scope) {
            Type::Class(c) => Resolution::Found(Target::Class(c.key)),
            Type::Var(v) => Resolution::Found(Target::TypeVar(v)),
            _ if self.model.has_package(&ty.replace('.', "/")) => Resolution::Found(Target::Package(ty.to_owned())),
            _ => Resolution::Unknown,
        }
    }

    /// The members a doc comment's `#member` reference names: the field, or the methods so
    /// named (only those with the written signature, when there is one), or constructors.
    fn doc_members(
        &self,
        comment: Node<'t>,
        r: &crate::javadoc::DocRef,
        ctor: bool,
    ) -> Result<Vec<Target>, Resolution> {
        let class = match self.doc_class(comment, r.ty.as_ref().map(|(t, _)| t.as_str())) {
            Resolution::Found(Target::Class(k)) => k,
            Resolution::Found(_) | Resolution::Missing | Resolution::Builtin => return Err(Resolution::Missing),
            Resolution::Unknown => return Err(Resolution::Unknown),
        };
        let Some(c) = self.model.class(&class) else { return Err(Resolution::Unknown) };
        if self.has_unknown_supertype(&class) {
            return Err(Resolution::Unknown);
        }
        let Some((name, _)) = &r.member else { return Err(Resolution::Missing) };
        let mut out = Vec::new();
        if r.params.is_none()
            && let Some(declaring) = self.field_declaring_class(&class, name)
        {
            out.push(Target::Field { class: declaring, name: name.clone() });
        }
        let candidates = if ctor || *name == c.name {
            self.constructors(&c.self_type(), Some(&class))
        } else {
            self.member_methods(&c.self_type(), name, Some(&class))
        };
        let scope = self.scope_at(comment);
        let mut doubtful = false;
        for cand in candidates {
            if let Some(params) = &r.params {
                if params.len() != cand.method.params.len() {
                    continue;
                }
                // Each written parameter type against the method's: equal, different, or not
                // comparable (a type the engine cannot resolve on either side).
                let mut fits = Some(true);
                for (written, p) in params.iter().zip(&cand.method.params) {
                    let theirs = self.model.erasure(&self.model.apply(&cand.subst, p));
                    let ours = self.model.resolve_text(written.trim_end_matches("..."), &scope);
                    let ours = if written.ends_with("...") { ours.array_of(1) } else { ours };
                    let this = if theirs.has_unknown() || ours.has_unknown() {
                        None
                    } else {
                        Some(self.model.erasure(&ours) == theirs)
                    };
                    fits = match (fits, this) {
                        (Some(false), _) | (_, Some(false)) => Some(false),
                        (None, _) | (_, None) => None,
                        _ => Some(true),
                    };
                }
                match fits {
                    Some(false) => continue,
                    None => {
                        doubtful = true;
                        continue;
                    }
                    Some(true) => {}
                }
            }
            out.push(self.method_target(&cand.class, &cand.method));
        }
        match (out.is_empty(), doubtful) {
            (false, _) => Ok(out),
            (true, true) => Err(Resolution::Unknown),
            (true, false) => Err(Resolution::Missing),
        }
    }

    /// The superclass constructor a constructor declaration calls implicitly.
    fn implicit_super(&self, ctor: Node<'t>) -> Resolution {
        match self.enclosing_class(ctor) {
            Some((_, key)) => self.implicit_super_of(&key),
            None => Resolution::Unknown,
        }
    }

    fn implicit_super_of(&self, key: &Key) -> Resolution {
        let Some(c) = self.model.class(key) else { return Resolution::Unknown };
        // Enums and records call `Enum` / `Record` constructors nobody declares in the project.
        if c.kind != crate::model::ClassKind::Class {
            return Resolution::Missing;
        }
        let Some(Type::Class(sup)) = &c.super_class else { return Resolution::Unknown };
        let ctors: Vec<_> = self
            .model
            .class(&sup.key)
            .map(|s| {
                self.model
                    .members(&s)
                    .methods
                    .iter()
                    .filter(|m| m.is_constructor() && m.params.is_empty())
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        match ctors.as_slice() {
            [m] => Resolution::Found(self.method_target(&sup.key, m)),
            [] if self.model.class(&sup.key).is_some() => Resolution::Missing,
            _ => Resolution::Unknown,
        }
    }

    /// A member reference that found nothing may name a member an annotation processor
    /// generates (Lombok), which the engine does not see.
    fn may_be_generated(&self, n: Node<'t>) -> bool {
        let _ = n;
        // Without the declaration of the member there is no way to tell a typo from generated
        // code: never count it as decided.
        true
    }
}
