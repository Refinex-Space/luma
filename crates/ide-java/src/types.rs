//! Java types for semantic analysis (IDEA's `PsiType` family and `PsiSubstitutor`): primitive,
//! class types with arguments (and the enclosing instance's type of an inner class), arrays,
//! type variables with their declaring owner, the null type, and `Unknown` for anything the
//! engine could not determine — which callers treat as "don't know", never as a match.

use crate::classfile::BaseType;
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

/// A class identity: its binary name with `/` package separators and `$` before member names
/// (`java/util/Map$Entry`). Local and anonymous source classes get keys no source name can spell.
pub type Key = Arc<str>;

pub const OBJECT: &str = "java/lang/Object";
pub const STRING: &str = "java/lang/String";

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Type {
    Prim(BaseType),
    Void,
    Class(ClassType),
    Array(Box<Type>),
    Var(TypeVar),
    Null,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ClassType {
    pub key: Key,
    /// Arguments of this class; empty for a non-generic class or a raw type.
    pub args: Vec<TypeArg>,
    /// `Outer<String>.Inner`: the enclosing instance's type of an inner class, when generic.
    pub outer: Option<Box<ClassType>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum TypeArg {
    Exact(Type),
    Extends(Type),
    Super(Type),
    Any,
}

/// A type variable and the declaration owning it: a class key, or `<class key>#<method index>`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct TypeVar {
    pub name: Arc<str>,
    pub owner: Arc<str>,
}

impl Type {
    pub fn class(key: impl Into<Key>) -> Self {
        Type::Class(ClassType { key: key.into(), args: Vec::new(), outer: None })
    }

    pub fn object() -> Self {
        Self::class(OBJECT)
    }

    pub fn string() -> Self {
        Self::class(STRING)
    }

    pub fn is_unknown(&self) -> bool {
        match self {
            Type::Unknown => true,
            Type::Array(e) => e.is_unknown(),
            _ => false,
        }
    }

    /// Whether `Unknown` occurs anywhere in it.
    pub fn has_unknown(&self) -> bool {
        match self {
            Type::Unknown => true,
            Type::Array(e) => e.has_unknown(),
            Type::Class(c) => c.has_unknown(),
            _ => false,
        }
    }

    pub fn as_class(&self) -> Option<&ClassType> {
        match self {
            Type::Class(c) => Some(c),
            _ => None,
        }
    }

    pub fn is_primitive(&self) -> bool {
        matches!(self, Type::Prim(_))
    }

    pub fn is_reference(&self) -> bool {
        matches!(self, Type::Class(_) | Type::Array(_) | Type::Var(_) | Type::Null)
    }

    pub fn array_of(self, dims: usize) -> Type {
        (0..dims).fold(self, |t, _| Type::Array(Box::new(t)))
    }
}

impl ClassType {
    pub fn is_raw_or_plain(&self) -> bool {
        self.args.is_empty()
    }

    fn has_unknown(&self) -> bool {
        self.args.iter().any(|a| match a {
            TypeArg::Exact(t) | TypeArg::Extends(t) | TypeArg::Super(t) => t.has_unknown(),
            TypeArg::Any => false,
        }) || self.outer.as_ref().is_some_and(|o| o.has_unknown())
    }
}

impl TypeArg {
    /// The type a value read through this argument has: `? extends T` → `T`; `?` and
    /// `? super T` → `None` (the variable's bound, which the caller knows).
    pub fn upper(&self) -> Option<&Type> {
        match self {
            TypeArg::Exact(t) | TypeArg::Extends(t) => Some(t),
            TypeArg::Super(_) | TypeArg::Any => None,
        }
    }
}

/// Type variables → arguments (IDEA's `PsiSubstitutor`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Subst {
    map: HashMap<TypeVar, TypeArg>,
    /// Variables of a raw type: erased wherever they occur.
    raw: Vec<TypeVar>,
}

impl Subst {
    pub fn is_empty(&self) -> bool {
        self.map.is_empty() && self.raw.is_empty()
    }

    pub fn put(&mut self, var: TypeVar, arg: TypeArg) {
        self.map.insert(var, arg);
    }

    pub fn put_raw(&mut self, var: TypeVar) {
        self.raw.push(var);
    }

    pub fn get(&self, var: &TypeVar) -> Option<&TypeArg> {
        self.map.get(var)
    }

    /// Keeps the bindings `keep` accepts.
    pub fn retain(&mut self, mut keep: impl FnMut(&TypeVar, &TypeArg) -> bool) {
        self.map.retain(|k, v| keep(k, v));
    }

    pub fn is_raw(&self, var: &TypeVar) -> bool {
        self.raw.contains(var)
    }

    pub fn extend(&mut self, other: &Subst) {
        for (k, v) in &other.map {
            self.map.entry(k.clone()).or_insert_with(|| v.clone());
        }
        for r in &other.raw {
            if !self.raw.contains(r) {
                self.raw.push(r.clone());
            }
        }
    }

    pub fn vars(&self) -> impl Iterator<Item = (&TypeVar, &TypeArg)> {
        self.map.iter()
    }

    /// `t` with the variables replaced. A variable standing for a wildcard becomes the type a
    /// value of it is read as (the bound of `? extends`, `bound(var)` otherwise); a variable of
    /// a raw type becomes `erase(var)`. Arguments of class types keep their wildcards.
    pub fn apply(&self, t: &Type, bound: &dyn Fn(&TypeVar) -> Type) -> Type {
        match t {
            Type::Var(v) => {
                if self.is_raw(v) {
                    return bound(v);
                }
                match self.map.get(v) {
                    Some(TypeArg::Exact(x)) | Some(TypeArg::Extends(x)) => x.clone(),
                    Some(TypeArg::Super(_)) | Some(TypeArg::Any) => bound(v),
                    None => t.clone(),
                }
            }
            Type::Array(e) => Type::Array(Box::new(self.apply(e, bound))),
            Type::Class(c) => Type::Class(self.apply_class(c, bound)),
            _ => t.clone(),
        }
    }

    pub fn apply_class(&self, c: &ClassType, bound: &dyn Fn(&TypeVar) -> Type) -> ClassType {
        ClassType {
            key: c.key.clone(),
            args: c.args.iter().map(|a| self.apply_arg(a, bound)).collect(),
            outer: c.outer.as_ref().map(|o| Box::new(self.apply_class(o, bound))),
        }
    }

    fn apply_arg(&self, a: &TypeArg, bound: &dyn Fn(&TypeVar) -> Type) -> TypeArg {
        let inner = |t: &Type| -> TypeArg {
            if let Type::Var(v) = t {
                if self.is_raw(v) {
                    return TypeArg::Exact(bound(v));
                }
                if let Some(mapped) = self.map.get(v) {
                    return mapped.clone();
                }
            }
            TypeArg::Exact(self.apply(t, bound))
        };
        match a {
            TypeArg::Exact(t) => inner(t),
            // `? extends T` with T := X is `? extends X`; with T := `? extends X` as well.
            TypeArg::Extends(t) => match inner(t) {
                TypeArg::Exact(x) | TypeArg::Extends(x) => TypeArg::Extends(x),
                TypeArg::Super(_) | TypeArg::Any => TypeArg::Any,
            },
            TypeArg::Super(t) => match inner(t) {
                TypeArg::Exact(x) | TypeArg::Super(x) => TypeArg::Super(x),
                TypeArg::Extends(_) | TypeArg::Any => TypeArg::Any,
            },
            TypeArg::Any => TypeArg::Any,
        }
    }
}

/// Java spelling for messages and tests: `java.util.Map.Entry<K, ? extends V>[]`.
impl fmt::Display for Type {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Type::Prim(b) => f.write_str(b.keyword()),
            Type::Void => f.write_str("void"),
            Type::Class(c) => c.fmt(f),
            Type::Array(e) => write!(f, "{e}[]"),
            Type::Var(v) => f.write_str(&v.name),
            Type::Null => f.write_str("null"),
            Type::Unknown => f.write_str("?unknown"),
        }
    }
}

impl fmt::Display for ClassType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.outer {
            Some(o) => {
                o.fmt(f)?;
                let simple = self.key.rsplit(['$', '/']).next().unwrap_or(&self.key);
                write!(f, ".{simple}")?;
            }
            None => f.write_str(&self.key.replace(['/', '$'], "."))?,
        }
        if !self.args.is_empty() {
            f.write_str("<")?;
            for (i, a) in self.args.iter().enumerate() {
                if i > 0 {
                    f.write_str(", ")?;
                }
                match a {
                    TypeArg::Exact(t) => write!(f, "{t}")?,
                    TypeArg::Extends(t) => write!(f, "? extends {t}")?,
                    TypeArg::Super(t) => write!(f, "? super {t}")?,
                    TypeArg::Any => f.write_str("?")?,
                }
            }
            f.write_str(">")?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn var(name: &str) -> TypeVar {
        TypeVar { name: name.into(), owner: "java/util/List".into() }
    }

    fn list(arg: TypeArg) -> Type {
        Type::Class(ClassType { key: "java/util/List".into(), args: vec![arg], outer: None })
    }

    #[test]
    fn substitution_keeps_wildcards_inside_and_reads_through_them_outside() {
        let e = var("E");
        let mut s = Subst::default();
        s.put(e.clone(), TypeArg::Extends(Type::class("java/lang/Number")));
        let object = |_: &TypeVar| Type::object();
        // `E get(int)` on `List<? extends Number>` reads a Number.
        assert_eq!(s.apply(&Type::Var(e.clone()), &object), Type::class("java/lang/Number"));
        // `List<E> subList()` keeps the wildcard.
        assert_eq!(
            s.apply(&list(TypeArg::Exact(Type::Var(e.clone()))), &object),
            list(TypeArg::Extends(Type::class("java/lang/Number")))
        );
        // `Collection<? extends E>` with E := `? extends Number`.
        assert_eq!(
            s.apply(&list(TypeArg::Extends(Type::Var(e.clone()))), &object),
            list(TypeArg::Extends(Type::class("java/lang/Number")))
        );
        let mut raw = Subst::default();
        raw.put_raw(e.clone());
        assert_eq!(raw.apply(&Type::Var(e), &object), Type::object());
    }

    #[test]
    fn displays_like_java() {
        let t = Type::Array(Box::new(list(TypeArg::Super(Type::string()))));
        assert_eq!(t.to_string(), "java.util.List<? super java.lang.String>[]");
        let inner = Type::Class(ClassType {
            key: "p/Outer$Inner".into(),
            args: vec![],
            outer: Some(Box::new(ClassType { key: "p/Outer".into(), args: vec![TypeArg::Any], outer: None })),
        });
        assert_eq!(inner.to_string(), "p.Outer<?>.Inner");
    }
}
