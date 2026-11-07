//! One view of classes whether they come from source (the index's stubs) or from the class
//! path (class-file stubs), as IDEA's `PsiClass` is one interface over `PsiClassImpl` and
//! `ClsClassImpl`: kind, modifiers, type parameters, generic supertypes, members, member
//! classes. Type names written in source are resolved here (JLS §6.4–6.5, §7.5; IDEA's
//! `PsiResolveHelper.resolveReferencedClass`): type variables, member types of the enclosing
//! classes and their supertypes, the compilation unit, single-type imports, the package,
//! on-demand imports and `java.lang`. A name that resolves nowhere becomes [`Type::Unknown`].
//!
//! Source classes win over class-path classes of the same name: the project's own module
//! outputs and installed jars must not shadow the sources being edited.

use crate::classfile::{self, ClassStub, TypeArgSig, TypeParamSig, TypeSig};
use crate::classpath::ClassPath;
use crate::typeref::{self, ArgRef, TypeRef};
use crate::types::{ClassType, Key, OBJECT, Subst, Type, TypeArg, TypeVar};
use ide_index::java::{self as ix, JavaMemberKind, JavaTypeKind, JavaView, TypeId};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};

pub use classfile::{
    ACC_ABSTRACT, ACC_ENUM, ACC_FINAL, ACC_INTERFACE, ACC_PRIVATE, ACC_PROTECTED, ACC_PUBLIC, ACC_STATIC, ACC_VARARGS,
    DEPRECATED,
};

/// An interface method with a body.
pub const DEFAULT_METHOD: u32 = 1 << 18;
/// A class declared in a block, or anonymous.
pub const LOCAL_CLASS: u32 = 1 << 19;
pub const ANONYMOUS_CLASS: u32 = 1 << 20;
/// A member the language declares implicitly (default constructor, `values()`, record parts).
pub const IMPLICIT: u32 = 1 << 21;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ClassKind {
    Class,
    Interface,
    Enum,
    Record,
    Annotation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Origin {
    Source(TypeId),
    Library,
    /// A builder class Lombok's `@Builder` generates in a source class: the class and which of
    /// its builders.
    LombokBuilder(TypeId, u32),
}

#[derive(Clone, Debug, PartialEq)]
pub struct TypeParam {
    pub var: TypeVar,
    /// Empty: `Object`.
    pub bounds: Vec<Type>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FieldData {
    pub name: String,
    pub flags: u32,
    pub ty: Type,
    pub enum_constant: bool,
    /// Index of the declaration in the source type's members.
    pub source: Option<u32>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MethodData {
    /// `<init>` for a constructor.
    pub name: String,
    pub flags: u32,
    pub type_params: Vec<TypeParam>,
    pub params: Vec<Type>,
    pub varargs: bool,
    /// `void` for constructors.
    pub ret: Type,
    pub source: Option<u32>,
}

impl MethodData {
    pub fn is_constructor(&self) -> bool {
        self.name == "<init>"
    }

    pub fn is_static(&self) -> bool {
        self.flags & ACC_STATIC as u32 != 0
    }

    pub fn is_abstract(&self) -> bool {
        self.flags & ACC_ABSTRACT as u32 != 0
    }
}

#[derive(Debug, Default)]
pub struct Members {
    pub fields: Vec<FieldData>,
    pub methods: Vec<MethodData>,
}

#[derive(Debug)]
pub struct ClassData {
    pub key: Key,
    /// Simple name; empty for an anonymous class.
    pub name: String,
    pub kind: ClassKind,
    pub flags: u32,
    pub type_params: Vec<TypeParam>,
    /// `None` for `Object` and interfaces.
    pub super_class: Option<Type>,
    pub interfaces: Vec<Type>,
    /// Member classes declared here: (simple name, key).
    pub member_classes: Vec<(String, Key)>,
    /// The class this one is declared in (member, local or anonymous).
    pub outer: Option<Key>,
    pub origin: Origin,
    members: OnceLock<Members>,
}

impl ClassData {
    pub fn is_interface(&self) -> bool {
        matches!(self.kind, ClassKind::Interface | ClassKind::Annotation)
    }

    pub fn is_static(&self) -> bool {
        self.flags & ACC_STATIC as u32 != 0
    }

    /// An inner class: non-static member, local or anonymous class (has an enclosing instance
    /// whose type arguments it sees).
    pub fn is_inner(&self) -> bool {
        self.outer.is_some() && !self.is_static() && !self.is_interface() && self.kind == ClassKind::Class
    }

    /// Package with `/` separators.
    pub fn package(&self) -> &str {
        package_of(&self.key)
    }

    /// The class as a type with its own type variables as arguments (`List<E>` inside `List`).
    pub fn self_type(&self) -> ClassType {
        ClassType {
            key: self.key.clone(),
            args: self.type_params.iter().map(|p| TypeArg::Exact(Type::Var(p.var.clone()))).collect(),
            outer: None,
        }
    }
}

pub fn package_of(key: &str) -> &str {
    key.rfind('/').map_or("", |i| &key[..i])
}

/// `a/b/Outer$Inner` → `a.b.Outer.Inner` (as written in Java).
pub fn java_name(key: &str) -> String {
    key.replace(['/', '$'], ".")
}

/// The binary name of a dotted package (`java.util` → `java/util`).
fn slash(package: &str) -> String {
    package.replace('.', "/")
}

/// Where a type name is resolved: the innermost enclosing class, type parameters of enclosing
/// methods (innermost first), classes declared in enclosing blocks, and the compilation unit.
#[derive(Clone, Debug, Default)]
pub struct Scope {
    pub class: Option<Key>,
    pub method_type_params: Vec<TypeParam>,
    /// Local classes in scope, innermost last: (simple name, key).
    pub local_classes: Vec<(String, Key)>,
    /// The source file whose imports and package apply.
    pub file: Option<u32>,
    /// `true` while resolving a class header (its supertypes): the class's own member types are
    /// not in scope there, its type parameters are.
    pub header_of: Option<Key>,
}

/// The engine's view of one project state: the index (source stubs, with the edited file's
/// unsaved declarations) and the class path of the file being analyzed.
/// Which source files the analyzed module can see (its own and those of the modules it depends
/// on), and in which order: `None` for an invisible file, else its rank (0 for the module's own,
/// then the class path position of the module declaring it) — IDEA's module-scoped resolution,
/// `javac`'s first-on-the-class-path rule. Decides between source classes of the same name.
pub type SourceVisibility = std::sync::Arc<dyn Fn(&std::path::Path) -> Option<usize> + Send + Sync>;

pub struct Model<'a> {
    pub view: &'a JavaView<'a>,
    pub cp: &'a ClassPath,
    visible: Option<SourceVisibility>,
    source_cache: RefCell<HashMap<Key, Option<Arc<ClassData>>>>,
    source_keys: RefCell<HashMap<TypeId, Key>>,
    building: RefCell<HashSet<Key>>,
}

/// Index flags → JVM-style access flags.
fn source_flags(f: u16) -> u32 {
    let mut out = 0u32;
    for (from, to) in [
        (ix::PUBLIC, ACC_PUBLIC as u32),
        (ix::PROTECTED, ACC_PROTECTED as u32),
        (ix::PRIVATE, ACC_PRIVATE as u32),
        (ix::STATIC, ACC_STATIC as u32),
        (ix::ABSTRACT, ACC_ABSTRACT as u32),
        (ix::FINAL, ACC_FINAL as u32),
        (ix::DEFAULT, DEFAULT_METHOD),
        (ix::LOCAL, LOCAL_CLASS),
        (ix::ANONYMOUS, ANONYMOUS_CLASS),
    ] {
        if f & from != 0 {
            out |= to;
        }
    }
    out
}

impl<'a> Model<'a> {
    pub fn new(view: &'a JavaView<'a>, cp: &'a ClassPath) -> Self {
        Self {
            view,
            cp,
            visible: None,
            source_cache: RefCell::default(),
            source_keys: RefCell::default(),
            building: RefCell::default(),
        }
    }

    /// Restricts same-named source classes to those `visible` says the module sees.
    pub fn with_visibility(mut self, visible: Option<SourceVisibility>) -> Self {
        self.visible = visible;
        self
    }

    // ------------------------------------------------------------------ keys and lookup

    /// The key of a source type: its binary name, or for a local / anonymous class
    /// `<enclosing key>$#<index><name>` (no source name can spell it).
    pub fn source_key(&self, id: TypeId) -> Option<Key> {
        if let Some(k) = self.source_keys.borrow().get(&id) {
            return Some(k.clone());
        }
        let stub = self.view.stub(id.file)?;
        let t = stub.types.get(id.ty as usize)?;
        let key: Key = match t.outer {
            None => {
                let pkg = slash(&stub.package);
                if pkg.is_empty() { t.name.as_str().into() } else { format!("{pkg}/{}", t.name).into() }
            }
            Some(o) => {
                let outer = self.source_key(TypeId { file: id.file, ty: o })?;
                if t.is(ix::LOCAL) || t.is(ix::ANONYMOUS) {
                    format!("{outer}$#{}{}", id.ty, t.name).into()
                } else {
                    format!("{outer}${}", t.name).into()
                }
            }
        };
        self.source_keys.borrow_mut().insert(id, key.clone());
        Some(key)
    }

    /// The source type with this key.
    pub fn source_type(&self, key: &str) -> Option<TypeId> {
        let pkg = package_of(key);
        let rest = if pkg.is_empty() { key } else { &key[pkg.len() + 1..] };
        let mut parts = rest.split('$');
        let top = parts.next()?;
        let dotted = pkg.replace('/', ".");
        let candidates: Vec<TypeId> = self
            .view
            .types_named(top)
            .into_iter()
            .filter(|&id| {
                self.view.stub(id.file).is_some_and(|s| s.package == dotted && s.types[id.ty as usize].outer.is_none())
            })
            .collect();
        // Several modules may declare the class: the one the analyzed module sees first.
        let rank = |id: &TypeId| match (&self.visible, self.view.path(id.file)) {
            (Some(v), Some(p)) => v(p),
            _ => Some(0),
        };
        let mut id = match candidates.len() {
            0 => return None,
            1 => candidates[0],
            _ => candidates
                .iter()
                .copied()
                .filter_map(|c| rank(&c).map(|r| (r, c)))
                .min_by_key(|(r, _)| *r)
                .map(|(_, c)| c)
                .unwrap_or(candidates[0]),
        };
        for part in parts {
            id = match part.strip_prefix('#') {
                Some(local) => {
                    let digits: String = local.chars().take_while(char::is_ascii_digit).collect();
                    TypeId { file: id.file, ty: digits.parse().ok()? }
                }
                None => self.view.member_type_of(id, part)?,
            };
        }
        Some(id)
    }

    /// The class with this key, from source or the class path.
    pub fn class(&self, key: &str) -> Option<Arc<ClassData>> {
        if let Some(c) = self.source_cache.borrow().get(key) {
            return c.clone();
        }
        let built = match self.source_type(key) {
            Some(id) => self.build_source(id, key.into()),
            None => self.lombok_builder(key).or_else(|| self.library(key)),
        };
        self.source_cache.borrow_mut().insert(key.into(), built.clone());
        built
    }

    pub fn source_class(&self, id: TypeId) -> Option<Arc<ClassData>> {
        let key = self.source_key(id)?;
        self.class(&key)
    }

    /// `Outer$OuterBuilder` of a source class with `@Builder`.
    fn lombok_builder(&self, key: &str) -> Option<Arc<ClassData>> {
        let (outer_key, simple) = key.rsplit_once('$')?;
        let outer_id = self.source_type(outer_key)?;
        let stub = self.view.stub(outer_id.file)?;
        let t = stub.types.get(outer_id.ty as usize)?;
        let index = crate::lombok::builder_names(stub, t).iter().position(|n| n == simple)?;
        Some(Arc::new(ClassData {
            key: key.into(),
            name: simple.to_owned(),
            kind: ClassKind::Class,
            flags: ACC_PUBLIC as u32 | ACC_STATIC as u32 | IMPLICIT,
            type_params: Vec::new(),
            super_class: Some(Type::object()),
            interfaces: Vec::new(),
            member_classes: Vec::new(),
            outer: Some(outer_key.into()),
            origin: Origin::LombokBuilder(outer_id, index as u32),
            members: OnceLock::new(),
        }))
    }

    fn library(&self, key: &str) -> Option<Arc<ClassData>> {
        self.cp.data(key, |stub| from_class_file(stub, self.cp))
    }

    /// Whether a class exists with this key (without building it).
    pub fn exists(&self, key: &str) -> bool {
        self.source_type(key).is_some() || self.cp.has_class_file(key)
    }

    pub fn has_package(&self, slashed: &str) -> bool {
        self.view.has_package(&slashed.replace('/', ".")) || self.cp.has_package(slashed)
    }

    /// The top-level class `name` of package `slashed`.
    pub fn top_level(&self, slashed: &str, name: &str) -> Option<Key> {
        let key = if slashed.is_empty() { name.to_owned() } else { format!("{slashed}/{name}") };
        self.exists(&key).then(|| key.into())
    }

    /// The class named by a dotted name (`java.util.Map.Entry`): the longest package prefix
    /// with a top-level class after it, then member classes.
    pub fn by_dotted(&self, dotted: &str) -> Option<Key> {
        let segs: Vec<&str> = dotted.split('.').collect();
        for split in (0..segs.len()).rev() {
            let pkg = segs[..split].join("/");
            let Some(mut key) = self.top_level(&pkg, segs[split]) else { continue };
            let mut ok = true;
            for seg in &segs[split + 1..] {
                match self.member_class(&key, seg) {
                    Some(k) => key = k,
                    None => {
                        ok = false;
                        break;
                    }
                }
            }
            if ok {
                return Some(key);
            }
        }
        None
    }

    /// Member class `name` of `owner`, declared or inherited (JLS §8.5).
    pub fn member_class(&self, owner: &str, name: &str) -> Option<Key> {
        let mut seen = HashSet::new();
        self.member_class_in(owner, name, &mut seen)
    }

    fn member_class_in(&self, owner: &str, name: &str, seen: &mut HashSet<Key>) -> Option<Key> {
        if !seen.insert(owner.into()) {
            return None;
        }
        let c = self.class(owner)?;
        if let Some((_, k)) = c.member_classes.iter().find(|(n, _)| n == name) {
            return Some(k.clone());
        }
        let supers = c.super_class.iter().chain(&c.interfaces).filter_map(|t| t.as_class().map(|c| c.key.clone()));
        for s in supers.collect::<Vec<_>>() {
            if let Some(k) = self.member_class_in(&s, name, seen) {
                return Some(k);
            }
        }
        None
    }

    // ------------------------------------------------------------------ name resolution

    /// Resolves a type name (simple) in `scope`: a type variable, or a class.
    pub fn resolve_simple_type(&self, name: &str, scope: &Scope) -> Option<Type> {
        if let Some((_, k)) = scope.local_classes.iter().rev().find(|(n, _)| n == name) {
            return Some(Type::class(k.clone()));
        }
        if let Some(p) = scope.method_type_params.iter().find(|p| &*p.var.name == name) {
            return Some(Type::Var(p.var.clone()));
        }
        // The class whose header is resolved: its type parameters, then its enclosing classes.
        let mut next = match &scope.header_of {
            Some(h) => {
                let c = self.class(h);
                if let Some(p) = c.as_ref().and_then(|c| c.type_params.iter().find(|p| &*p.var.name == name)) {
                    return Some(Type::Var(p.var.clone()));
                }
                c.and_then(|c| c.outer.clone())
            }
            None => scope.class.clone(),
        };
        while let Some(key) = next {
            let Some(c) = self.class(&key) else { break };
            if let Some(p) = c.type_params.iter().find(|p| &*p.var.name == name) {
                return Some(Type::Var(p.var.clone()));
            }
            if c.name == name && c.outer.is_none() {
                return Some(Type::class(c.key.clone()));
            }
            if let Some(k) = self.member_class(&key, name) {
                return Some(Type::class(k));
            }
            // A member class's own name, seen from inside it.
            if c.name == name {
                return Some(Type::class(c.key.clone()));
            }
            next = c.outer.clone();
        }
        self.resolve_in_file(name, scope.file).map(Type::class)
    }

    /// Compilation-unit scope: types of the file and single-type imports, the package,
    /// on-demand imports, `java.lang`.
    fn resolve_in_file(&self, name: &str, file: Option<u32>) -> Option<Key> {
        let stub = file.and_then(|f| self.view.stub(f));
        let pkg = stub.map(|s| slash(&s.package)).unwrap_or_default();
        if let Some(stub) = stub {
            if stub.types.iter().any(|t| t.outer.is_none() && t.name == name) {
                return self.top_level(&pkg, name);
            }
            for import in stub.imports.iter().filter(|i| !i.on_demand) {
                if ix::simple(&import.path) != name {
                    continue;
                }
                let found = if import.is_static {
                    // `import static a.B.C;` brings member class C of B (fields and methods too).
                    let (owner, member) = import.path.rsplit_once('.')?;
                    self.by_dotted(owner).and_then(|o| self.member_class(&o, member))
                } else {
                    self.by_dotted(&import.path)
                };
                if found.is_some() {
                    return found;
                }
            }
        }
        if let Some(k) = self.top_level(&pkg, name) {
            return Some(k);
        }
        if let Some(stub) = stub {
            let mut found = None;
            for import in stub.imports.iter().filter(|i| i.on_demand) {
                // `p.*` imports a package's types or a type's member types; `static T.*` the latter.
                let hit = if import.is_static {
                    self.by_dotted(&import.path).and_then(|o| self.member_class(&o, name))
                } else if let Some(k) = self.top_level(&slash(&import.path), name) {
                    Some(k)
                } else {
                    self.by_dotted(&import.path).and_then(|o| self.member_class(&o, name))
                };
                if let Some(k) = hit {
                    if found.as_ref().is_some_and(|f| *f != k) {
                        // Ambiguous on-demand imports: javac reports an error; don't guess.
                        return None;
                    }
                    found = Some(k);
                }
            }
            if found.is_some() {
                return found;
            }
        }
        self.top_level("java/lang", name)
    }

    /// Resolves a type as written in `scope`.
    pub fn resolve_type_ref(&self, t: &TypeRef, scope: &Scope) -> Type {
        match t {
            TypeRef::Prim(b) => Type::Prim(*b),
            TypeRef::Void => Type::Void,
            TypeRef::Array(e) => Type::Array(Box::new(self.resolve_type_ref(e, scope))),
            TypeRef::Named(segs) => self.resolve_named(segs, scope),
        }
    }

    /// Resolves canonical type text (as the index stores it).
    pub fn resolve_text(&self, text: &str, scope: &Scope) -> Type {
        match typeref::parse(text) {
            Some(t) => self.resolve_type_ref(&t, scope),
            None => Type::Unknown,
        }
    }

    fn resolve_named(&self, segs: &[typeref::Segment], scope: &Scope) -> Type {
        let first = &segs[0];
        let mut current: Option<ClassType> = None;
        let mut rest = &segs[1..];
        match self.resolve_simple_type(&first.name, scope) {
            Some(Type::Var(v)) if segs.len() == 1 => return Type::Var(v),
            Some(Type::Class(c)) => {
                current = Some(ClassType { key: c.key, args: self.resolve_args(&first.args, scope), outer: None })
            }
            _ => {
                // A package-qualified name: the longest package prefix naming a class.
                for split in (1..segs.len()).rev() {
                    let pkg: Vec<&str> = segs[..split].iter().map(|s| s.name.as_str()).collect();
                    if let Some(k) = self.top_level(&pkg.join("/"), &segs[split].name) {
                        current =
                            Some(ClassType { key: k, args: self.resolve_args(&segs[split].args, scope), outer: None });
                        rest = &segs[split + 1..];
                        break;
                    }
                }
            }
        }
        let Some(mut current) = current else { return Type::Unknown };
        for seg in rest {
            let Some(k) = self.member_class(&current.key, &seg.name) else { return Type::Unknown };
            let inner_is_inner = self.class(&k).is_some_and(|c| c.is_inner());
            let outer = (inner_is_inner && !current.args.is_empty()).then(|| Box::new(current.clone()));
            current = ClassType { key: k, args: self.resolve_args(&seg.args, scope), outer };
        }
        Type::Class(current)
    }

    fn resolve_args(&self, args: &[ArgRef], scope: &Scope) -> Vec<TypeArg> {
        args.iter()
            .map(|a| match a {
                ArgRef::Exact(t) => TypeArg::Exact(self.resolve_type_ref(t, scope)),
                ArgRef::Extends(t) => TypeArg::Extends(self.resolve_type_ref(t, scope)),
                ArgRef::Super(t) => TypeArg::Super(self.resolve_type_ref(t, scope)),
                ArgRef::Any => TypeArg::Any,
            })
            .collect()
    }

    // ------------------------------------------------------------------ source classes

    fn build_source(&self, id: TypeId, key: Key) -> Option<Arc<ClassData>> {
        if !self.building.borrow_mut().insert(key.clone()) {
            return None;
        }
        let built = self.build_source_header(id, key.clone());
        self.building.borrow_mut().remove(&key);
        built.map(Arc::new)
    }

    fn build_source_header(&self, id: TypeId, key: Key) -> Option<ClassData> {
        let stub = self.view.stub(id.file)?;
        let t = stub.types.get(id.ty as usize)?;
        let kind = match t.kind {
            JavaTypeKind::Class => ClassKind::Class,
            JavaTypeKind::Interface => ClassKind::Interface,
            JavaTypeKind::Enum => ClassKind::Enum,
            JavaTypeKind::Record => ClassKind::Record,
            JavaTypeKind::Annotation => ClassKind::Annotation,
        };
        let mut flags = source_flags(t.flags);
        if matches!(kind, ClassKind::Interface | ClassKind::Annotation) {
            flags |= ACC_INTERFACE as u32 | ACC_ABSTRACT as u32;
        }
        if kind == ClassKind::Enum {
            flags |= ACC_ENUM as u32;
        }
        if t.annotations.iter().any(|a| a == "Deprecated") {
            flags |= DEPRECATED;
        }
        let outer = match t.outer {
            Some(o) => Some(self.source_key(TypeId { file: id.file, ty: o })?),
            None => None,
        };
        let mut member_classes: Vec<(String, Key)> = stub
            .types
            .iter()
            .enumerate()
            .filter(|(_, m)| m.outer == Some(id.ty) && !m.is(ix::LOCAL) && !m.is(ix::ANONYMOUS))
            .filter_map(|(i, m)| Some((m.name.clone(), self.source_key(TypeId { file: id.file, ty: i as u32 })?)))
            .collect();
        for b in crate::lombok::builder_names(stub, t) {
            if !member_classes.iter().any(|(n, _)| *n == b) {
                member_classes.push((b.clone(), format!("{key}${b}").into()));
            }
        }
        let type_params: Vec<TypeParam> = t
            .sig
            .type_params
            .iter()
            .map(|p| TypeParam {
                var: TypeVar { name: p.name.as_str().into(), owner: key.clone() },
                bounds: Vec::new(),
            })
            .collect();
        // Insert a provisional class (no supertypes) so that names in the header that refer to
        // this class or its type parameters resolve.
        let provisional = Arc::new(ClassData {
            key: key.clone(),
            name: t.name.clone(),
            kind,
            flags,
            type_params: type_params.clone(),
            super_class: None,
            interfaces: Vec::new(),
            member_classes,
            outer,
            origin: Origin::Source(id),
            members: OnceLock::new(),
        });
        self.source_cache.borrow_mut().insert(key.clone(), Some(provisional.clone()));
        let header_scope = Scope { header_of: Some(key.clone()), file: Some(id.file), ..Default::default() };
        let mut type_params = type_params;
        for (p, text) in type_params.iter_mut().zip(&t.sig.type_params) {
            p.bounds = text.bounds.iter().map(|b| self.resolve_text(b, &header_scope)).collect();
        }
        let anonymous = t.is(ix::ANONYMOUS);
        let mut super_class = None;
        let mut interfaces = Vec::new();
        match kind {
            ClassKind::Class if anonymous => {
                // `new X() {…}`: X is the superclass, or the one interface beside `Object`.
                let base = t.sig.extends.as_deref().map(|e| self.resolve_text(e, &self.scope_of_outer(id)));
                match base {
                    Some(Type::Class(c)) if self.class(&c.key).is_some_and(|b| b.is_interface()) => {
                        super_class = Some(Type::object());
                        interfaces.push(Type::Class(c));
                    }
                    Some(b) => super_class = Some(b),
                    None => super_class = Some(Type::object()),
                }
            }
            ClassKind::Class => {
                super_class = Some(match &t.sig.extends {
                    Some(e) => self.resolve_text(e, &header_scope),
                    None if &*key == OBJECT => return Some(self.finish(provisional, None, Vec::new(), type_params)),
                    None => Type::object(),
                });
            }
            ClassKind::Enum => {
                super_class = Some(Type::Class(ClassType {
                    key: "java/lang/Enum".into(),
                    args: vec![TypeArg::Exact(Type::class(key.clone()))],
                    outer: None,
                }));
            }
            ClassKind::Record => super_class = Some(Type::class("java/lang/Record")),
            ClassKind::Annotation => interfaces.push(Type::class("java/lang/annotation/Annotation")),
            ClassKind::Interface => {}
        }
        interfaces.extend(t.sig.implements.iter().map(|i| self.resolve_text(i, &header_scope)));
        Some(self.finish(provisional, super_class, interfaces, type_params))
    }

    /// Scope of the class enclosing source type `id` (for an anonymous class's base type).
    fn scope_of_outer(&self, id: TypeId) -> Scope {
        let outer =
            self.view.ty(id).and_then(|t| t.outer).and_then(|o| self.source_key(TypeId { file: id.file, ty: o }));
        Scope { class: outer, file: Some(id.file), ..Default::default() }
    }

    fn finish(
        &self,
        p: Arc<ClassData>,
        super_class: Option<Type>,
        interfaces: Vec<Type>,
        type_params: Vec<TypeParam>,
    ) -> ClassData {
        ClassData {
            key: p.key.clone(),
            name: p.name.clone(),
            kind: p.kind,
            flags: p.flags,
            type_params,
            super_class,
            interfaces,
            member_classes: p.member_classes.clone(),
            outer: p.outer.clone(),
            origin: p.origin,
            members: OnceLock::new(),
        }
    }

    /// Fields and methods of `c`, built on first use.
    pub fn members<'c>(&self, c: &'c ClassData) -> &'c Members {
        c.members.get_or_init(|| match c.origin {
            Origin::Source(id) => {
                let mut m = self.source_members(c, id);
                crate::lombok::add_members(self, c, id, &mut m);
                m
            }
            Origin::LombokBuilder(id, i) => {
                let outer = c.outer.as_deref().and_then(|o| self.class(o));
                outer
                    .and_then(|o| crate::lombok::builders(self, &o, id).into_iter().nth(i as usize))
                    .map(|b| crate::lombok::builder_members(&b))
                    .unwrap_or_default()
            }
            // Library classes are built with their members.
            Origin::Library => Members::default(),
        })
    }

    fn source_members(&self, c: &ClassData, id: TypeId) -> Members {
        let Some(t) = self.view.ty(id) else { return Members::default() };
        let scope = Scope { class: Some(c.key.clone()), file: Some(id.file), ..Default::default() };
        let mut out = Members::default();
        for (i, m) in t.members.iter().enumerate() {
            let mut flags = source_flags(m.flags);
            if m.annotations.iter().any(|a| a == "Deprecated") {
                flags |= DEPRECATED;
            }
            match m.kind {
                JavaMemberKind::Field | JavaMemberKind::EnumConstant => {
                    let enum_constant = m.kind == JavaMemberKind::EnumConstant;
                    if enum_constant {
                        flags |= ACC_ENUM as u32;
                    }
                    let ty =
                        if enum_constant { Type::class(c.key.clone()) } else { self.resolve_text(&m.sig.ty, &scope) };
                    out.fields.push(FieldData {
                        name: m.name.clone(),
                        flags,
                        ty,
                        enum_constant,
                        source: Some(i as u32),
                    });
                }
                JavaMemberKind::Method | JavaMemberKind::Constructor => {
                    let ctor = m.kind == JavaMemberKind::Constructor;
                    let owner: Arc<str> = format!("{}#{i}", c.key).into();
                    let mut type_params: Vec<TypeParam> = m
                        .sig
                        .type_params
                        .iter()
                        .map(|p| TypeParam {
                            var: TypeVar { name: p.name.as_str().into(), owner: owner.clone() },
                            bounds: vec![],
                        })
                        .collect();
                    let mscope = Scope { method_type_params: type_params.clone(), ..scope.clone() };
                    for (p, text) in type_params.iter_mut().zip(&m.sig.type_params) {
                        p.bounds = text.bounds.iter().map(|b| self.resolve_text(b, &mscope)).collect();
                    }
                    let mscope = Scope { method_type_params: type_params.clone(), ..scope.clone() };
                    let params = m.sig.params.iter().map(|p| self.resolve_text(p, &mscope)).collect();
                    let ret = if ctor { Type::Void } else { self.resolve_text(&m.sig.ty, &mscope) };
                    // Record accessors are listed at the component; a declared accessor replaces it.
                    let is_record_accessor = c.kind == ClassKind::Record && !ctor && m.sig.params.is_empty();
                    if is_record_accessor
                        && let Some(prev) = out.methods.iter().position(|x| x.name == m.name && x.params.is_empty())
                    {
                        out.methods.remove(prev);
                    }
                    if c.is_interface() && !ctor && flags & (ACC_PRIVATE as u32 | ACC_STATIC as u32) == 0 {
                        flags |= ACC_PUBLIC as u32;
                    }
                    out.methods.push(MethodData {
                        name: if ctor { "<init>".into() } else { m.name.clone() },
                        flags,
                        type_params,
                        params,
                        varargs: m.sig.varargs,
                        ret,
                        source: Some(i as u32),
                    });
                }
            }
        }
        // Implicit members (JLS §8.8.9, §8.9.3, §8.10.4). A record always has a canonical
        // constructor: implicitly declared unless written (as such or compact).
        let record_components: Vec<Type> = if c.kind == ClassKind::Record {
            out.fields.iter().filter(|f| f.flags & ACC_STATIC as u32 == 0).map(|f| f.ty.clone()).collect()
        } else {
            Vec::new()
        };
        let has_ctor = if c.kind == ClassKind::Record {
            out.methods.iter().any(|m| m.is_constructor() && m.params == record_components)
        } else {
            out.methods.iter().any(MethodData::is_constructor)
        };
        let anonymous = c.flags & ANONYMOUS_CLASS != 0;
        if !c.is_interface() && !has_ctor && !anonymous {
            let params = record_components;
            let access = match c.kind {
                ClassKind::Enum => ACC_PRIVATE as u32,
                // A record's canonical constructor is as accessible as the record.
                _ => c.flags & (ACC_PUBLIC | ACC_PROTECTED | ACC_PRIVATE) as u32,
            };
            out.methods.push(MethodData {
                name: "<init>".into(),
                flags: access | IMPLICIT,
                type_params: Vec::new(),
                params,
                varargs: false,
                ret: Type::Void,
                source: None,
            });
        }
        // A record's `equals`, `hashCode` and `toString` are its own members (JLS §8.10.3).
        if c.kind == ClassKind::Record {
            let public = ACC_PUBLIC as u32 | IMPLICIT;
            let implicit = [
                ("equals", vec![Type::object()], Type::Prim(crate::classfile::BaseType::Boolean)),
                ("hashCode", Vec::new(), Type::Prim(crate::classfile::BaseType::Int)),
                ("toString", Vec::new(), Type::string()),
            ];
            for (name, params, ret) in implicit {
                if !out.methods.iter().any(|m| m.name == name && m.params.len() == params.len()) {
                    out.methods.push(MethodData {
                        name: name.into(),
                        flags: public,
                        type_params: Vec::new(),
                        params,
                        varargs: false,
                        ret,
                        source: None,
                    });
                }
            }
        }
        if c.kind == ClassKind::Enum {
            let me = Type::class(c.key.clone());
            let implicit = ACC_PUBLIC as u32 | ACC_STATIC as u32 | IMPLICIT;
            out.methods.push(MethodData {
                name: "values".into(),
                flags: implicit,
                type_params: Vec::new(),
                params: Vec::new(),
                varargs: false,
                ret: Type::Array(Box::new(me.clone())),
                source: None,
            });
            out.methods.push(MethodData {
                name: "valueOf".into(),
                flags: implicit,
                type_params: Vec::new(),
                params: vec![Type::string()],
                varargs: false,
                ret: me,
                source: None,
            });
        }
        out
    }

    // ------------------------------------------------------------------ type relations

    /// The bound a type variable is read as (its first bound, else `Object`).
    pub fn var_bound(&self, v: &TypeVar) -> Type {
        self.type_param(v).and_then(|p| p.bounds.first().cloned()).unwrap_or_else(Type::object)
    }

    /// The declaration of a type variable.
    pub fn type_param(&self, v: &TypeVar) -> Option<TypeParam> {
        match v.owner.split_once('#') {
            None => self.class(&v.owner)?.type_params.iter().find(|p| p.var == *v).cloned(),
            Some((class, _)) => {
                let c = self.class(class)?;
                self.members(&c).methods.iter().flat_map(|m| &m.type_params).find(|p| p.var == *v).cloned()
            }
        }
    }

    pub fn erasure(&self, t: &Type) -> Type {
        match t {
            Type::Class(c) => Type::class(c.key.clone()),
            Type::Array(e) => Type::Array(Box::new(self.erasure(e))),
            Type::Var(v) => {
                let b = self.var_bound(v);
                // `T extends U`, `U extends Foo`: follow, but not around a cycle.
                match b {
                    Type::Var(ref w) if w != v => self.erasure(&b),
                    Type::Var(_) => Type::object(),
                    other => self.erasure(&other),
                }
            }
            other => other.clone(),
        }
    }

    /// The substitution a class type applies to its class's members: its arguments for the
    /// class's type parameters (and the enclosing instance's for an inner class); a raw type
    /// erases them.
    pub fn subst_of(&self, ct: &ClassType) -> Subst {
        let mut s = Subst::default();
        let mut next = Some(ct);
        while let Some(t) = next {
            if let Some(c) = self.class(&t.key) {
                if t.args.is_empty() {
                    for p in &c.type_params {
                        s.put_raw(p.var.clone());
                    }
                } else {
                    for (p, a) in c.type_params.iter().zip(&t.args) {
                        s.put(p.var.clone(), a.clone());
                    }
                }
            }
            next = t.outer.as_deref();
        }
        s
    }

    /// Applies `s` with this model's variable bounds.
    pub fn apply(&self, s: &Subst, t: &Type) -> Type {
        if s.is_empty() {
            return t.clone();
        }
        s.apply(t, &|v| self.erasure(&Type::Var(v.clone())))
    }

    /// Direct supertypes of a class type, with its arguments substituted.
    pub fn direct_supertypes(&self, ct: &ClassType) -> Vec<ClassType> {
        let Some(c) = self.class(&ct.key) else { return Vec::new() };
        let s = self.subst_of(ct);
        let mut out: Vec<ClassType> = c
            .super_class
            .iter()
            .chain(&c.interfaces)
            .filter_map(|t| match self.apply(&s, t) {
                Type::Class(x) => Some(x),
                _ => None,
            })
            .collect();
        // A raw type's supertypes are erased (JLS §4.8).
        if ct.args.is_empty() && !c.type_params.is_empty() {
            for x in &mut out {
                x.args.clear();
            }
        }
        if c.is_interface() && c.super_class.is_none() && out.iter().all(|x| &*x.key != OBJECT) {
            out.push(ClassType { key: OBJECT.into(), args: Vec::new(), outer: None });
        }
        out
    }

    /// `ct` seen as its supertype `target` (`ArrayList<String>` as `Iterable` → `Iterable<String>`).
    pub fn as_super(&self, ct: &ClassType, target: &str) -> Option<ClassType> {
        let mut seen = HashSet::new();
        let mut queue = vec![ct.clone()];
        while let Some(t) = queue.pop() {
            if &*t.key == target {
                return Some(t);
            }
            if !seen.insert(t.key.clone()) {
                continue;
            }
            queue.extend(self.direct_supertypes(&t));
        }
        None
    }

    /// Whether class `a` is `b` or a subclass / subinterface of it.
    pub fn is_subclass(&self, a: &str, b: &str) -> bool {
        if a == b || b == OBJECT {
            return true;
        }
        let mut seen = HashSet::new();
        let mut queue: Vec<Key> = vec![a.into()];
        while let Some(k) = queue.pop() {
            if &*k == b {
                return true;
            }
            if !seen.insert(k.clone()) {
                continue;
            }
            if let Some(c) = self.class(&k) {
                queue.extend(
                    c.super_class.iter().chain(&c.interfaces).filter_map(|t| t.as_class().map(|c| c.key.clone())),
                );
            }
        }
        false
    }

    /// Every supertype class of `key` (itself first), breadth first, each once.
    pub fn all_supers(&self, key: &str) -> Vec<Key> {
        let mut out: Vec<Key> = Vec::new();
        let mut queue: std::collections::VecDeque<Key> = std::collections::VecDeque::from([Key::from(key)]);
        while let Some(k) = queue.pop_front() {
            if out.contains(&k) {
                continue;
            }
            if let Some(c) = self.class(&k) {
                queue.extend(
                    c.super_class.iter().chain(&c.interfaces).filter_map(|t| t.as_class().map(|c| c.key.clone())),
                );
                if c.is_interface() && c.super_class.is_none() {
                    queue.push_back(OBJECT.into());
                }
            }
            out.push(k);
        }
        out
    }
}

// ---------------------------------------------------------------------- class files

fn class_kind(stub: &ClassStub) -> ClassKind {
    if stub.is_annotation() {
        ClassKind::Annotation
    } else if stub.is_interface() {
        ClassKind::Interface
    } else if stub.is_enum() {
        ClassKind::Enum
    } else if stub.is_record() {
        ClassKind::Record
    } else {
        ClassKind::Class
    }
}

/// Type variables in scope while converting a class file's signatures: innermost first.
struct VarScope<'s> {
    vars: Vec<&'s [TypeParam]>,
}

impl VarScope<'_> {
    fn lookup(&self, name: &str) -> Option<TypeVar> {
        self.vars.iter().flat_map(|v| v.iter()).find(|p| &*p.var.name == name).map(|p| p.var.clone())
    }
}

fn convert(t: &TypeSig, vars: &VarScope) -> Type {
    match t {
        TypeSig::Base(b) => Type::Prim(*b),
        TypeSig::Void => Type::Void,
        TypeSig::Array(e) => Type::Array(Box::new(convert(e, vars))),
        TypeSig::TypeVar(n) => vars.lookup(n).map(Type::Var).unwrap_or(Type::Unknown),
        TypeSig::Class(c) => Type::Class(convert_class(&c.name, &c.args, vars)),
    }
}

/// `Outer<A>.Inner<B>`: segments outermost first; the binary names of the outer segments are
/// the prefixes of the name ending before each `$`.
fn convert_class(name: &str, args: &[Vec<TypeArgSig>], vars: &VarScope) -> ClassType {
    let conv_args = |a: &[TypeArgSig]| -> Vec<TypeArg> {
        a.iter()
            .map(|x| match x {
                TypeArgSig::Any => TypeArg::Any,
                TypeArgSig::Extends(t) => TypeArg::Extends(convert(t, vars)),
                TypeArgSig::Super(t) => TypeArg::Super(convert(t, vars)),
                TypeArgSig::Exact(t) => TypeArg::Exact(convert(t, vars)),
            })
            .collect()
    };
    if args.len() <= 1 {
        return ClassType {
            key: name.into(),
            args: args.first().map(|a| conv_args(a)).unwrap_or_default(),
            outer: None,
        };
    }
    // Split the binary name at the last `args.len() - 1` dollars.
    let mut cut = name.len();
    let mut ends = vec![name.len()];
    for _ in 1..args.len() {
        match name[..cut].rfind('$') {
            Some(i) => {
                cut = i;
                ends.push(i);
            }
            None => break,
        }
    }
    ends.reverse();
    let mut current: Option<ClassType> = None;
    for (end, a) in ends.iter().zip(args) {
        let ct = ClassType {
            key: name[..*end].into(),
            args: conv_args(a),
            outer: current.take().filter(|o| !o.args.is_empty()).map(Box::new),
        };
        current = Some(ct);
    }
    current.unwrap_or_else(|| ClassType { key: name.into(), args: Vec::new(), outer: None })
}

fn type_params(owner: &Arc<str>, sigs: &[TypeParamSig]) -> Vec<TypeParam> {
    sigs.iter()
        .map(|p| TypeParam { var: TypeVar { name: p.name.as_str().into(), owner: owner.clone() }, bounds: Vec::new() })
        .collect()
}

/// Type parameters of the classes enclosing `stub` (outermost last), for signatures that refer
/// to an outer class's variables.
fn outer_params(stub: &ClassStub, cp: &ClassPath) -> Vec<Vec<TypeParam>> {
    let mut out = Vec::new();
    let mut next = stub.outer.clone();
    let mut guard = 0;
    while let Some(o) = next {
        guard += 1;
        if guard > 16 {
            break;
        }
        let Some(s) = cp.find(&o) else { break };
        let key: Arc<str> = s.name.as_str().into();
        if let Some(sig) = &s.signature {
            out.push(type_params(&key, &sig.type_params));
        }
        next = s.outer.clone();
    }
    out
}

/// A class file's stub as a [`ClassData`], members included.
pub(crate) fn from_class_file(stub: &ClassStub, cp: &ClassPath) -> ClassData {
    let key: Key = stub.name.as_str().into();
    let kind = class_kind(stub);
    let mut tparams = stub.signature.as_ref().map(|s| type_params(&key, &s.type_params)).unwrap_or_default();
    let outers = outer_params(stub, cp);
    let bounds: Vec<Vec<Type>> = {
        let mut vars = VarScope { vars: vec![&tparams] };
        vars.vars.extend(outers.iter().map(Vec::as_slice));
        stub.signature
            .as_ref()
            .map(|s| s.type_params.iter().map(|p| p.bounds.iter().map(|b| convert(b, &vars)).collect()).collect())
            .unwrap_or_default()
    };
    for (p, b) in tparams.iter_mut().zip(bounds) {
        p.bounds = b;
    }
    let mut class_vars = VarScope { vars: vec![&tparams] };
    class_vars.vars.extend(outers.iter().map(Vec::as_slice));
    let (super_class, interfaces) = match &stub.signature {
        Some(sig) => {
            let sup = convert(&sig.super_class, &class_vars);
            (Some(sup), sig.interfaces.iter().map(|i| convert(i, &class_vars)).collect())
        }
        None => (
            stub.super_name.as_deref().map(Type::class),
            stub.interfaces.iter().map(|i| Type::class(i.as_str())).collect(),
        ),
    };
    let super_class = if stub.is_interface() || stub.super_name.is_none() { None } else { super_class };
    let fields = stub
        .fields
        .iter()
        .map(|f| FieldData {
            name: f.name.clone(),
            flags: f.flags,
            ty: convert(&f.ty, &class_vars),
            enum_constant: f.flags & ACC_ENUM as u32 != 0,
            source: None,
        })
        .collect();
    let methods = stub
        .methods
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let owner: Arc<str> = format!("{key}#{i}").into();
            let mut mparams = type_params(&owner, &m.type_params);
            let bounds: Vec<Vec<Type>> = {
                let mut vars = VarScope { vars: vec![&mparams, &tparams] };
                vars.vars.extend(outers.iter().map(Vec::as_slice));
                m.type_params.iter().map(|p| p.bounds.iter().map(|b| convert(b, &vars)).collect()).collect()
            };
            for (p, b) in mparams.iter_mut().zip(bounds) {
                p.bounds = b;
            }
            let mut vars = VarScope { vars: vec![&mparams, &tparams] };
            vars.vars.extend(outers.iter().map(Vec::as_slice));
            MethodData {
                name: m.name.clone(),
                flags: m.flags,
                params: m.params.iter().map(|p| convert(p, &vars)).collect(),
                varargs: m.is_varargs(),
                ret: convert(&m.ret, &vars),
                type_params: mparams,
                source: None,
            }
        })
        .collect();
    let member_classes = stub
        .members
        .iter()
        .map(|m| {
            let simple = m.strip_prefix(&format!("{}$", stub.name)).unwrap_or(m).to_owned();
            (simple, Key::from(m.as_str()))
        })
        .collect();
    let mut flags = stub.flags;
    if stub.local && stub.simple_name.is_empty() {
        flags |= ANONYMOUS_CLASS;
    }
    if stub.local {
        flags |= LOCAL_CLASS;
    }
    let data = ClassData {
        key,
        name: stub.simple_name.clone(),
        kind,
        flags,
        type_params: tparams.clone(),
        super_class,
        interfaces,
        member_classes,
        outer: stub.outer.as_deref().map(Key::from),
        origin: Origin::Library,
        members: OnceLock::new(),
    };
    let _ = data.members.set(Members { fields, methods });
    data
}

#[cfg(test)]
mod tests;
