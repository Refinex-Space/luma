//! Types as written in source, parsed from the index's canonical type text
//! (`Map<String,List<? extends T>>[]`, see `ide_index::java::TypeSignature`), before their names
//! are resolved (IDEA's `PsiJavaCodeReferenceElement` inside a `PsiTypeElement`).

use crate::classfile::BaseType;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum TypeRef {
    Prim(BaseType),
    Void,
    /// `a.b.Outer<T>.Inner`: dot-separated segments, each with its own arguments.
    Named(Vec<Segment>),
    Array(Box<TypeRef>),
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Segment {
    pub name: String,
    pub args: Vec<ArgRef>,
    /// `<>` written (diamond).
    pub diamond: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum ArgRef {
    Exact(TypeRef),
    Extends(TypeRef),
    Super(TypeRef),
    Any,
}

impl TypeRef {
    /// The dotted name without arguments (`Map.Entry`), for named types.
    pub fn dotted(&self) -> Option<String> {
        match self {
            TypeRef::Named(segs) => Some(segs.iter().map(|s| s.name.as_str()).collect::<Vec<_>>().join(".")),
            _ => None,
        }
    }

    /// `var` in a local variable declaration (not a type: inferred from the initializer).
    pub fn is_var(&self) -> bool {
        matches!(self, TypeRef::Named(s) if s.len() == 1 && s[0].name == "var" && s[0].args.is_empty())
    }

    pub fn element(&self) -> (&TypeRef, usize) {
        let mut t = self;
        let mut dims = 0;
        while let TypeRef::Array(e) = t {
            t = e;
            dims += 1;
        }
        (t, dims)
    }
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.s.get(self.i).is_some_and(|c| c.is_ascii_whitespace()) {
            self.i += 1;
        }
    }

    fn eat(&mut self, c: u8) -> bool {
        self.ws();
        if self.s.get(self.i) == Some(&c) {
            self.i += 1;
            true
        } else {
            false
        }
    }

    fn keyword(&mut self, k: &str) -> bool {
        self.ws();
        let end = self.i + k.len();
        if self.s.get(self.i..end) == Some(k.as_bytes())
            && self.s.get(end).is_none_or(|c| !(c.is_ascii_alphanumeric() || *c == b'_' || *c == b'$'))
        {
            self.i = end;
            true
        } else {
            false
        }
    }

    fn ident(&mut self) -> Option<String> {
        self.ws();
        let start = self.i;
        while let Some(&c) = self.s.get(self.i) {
            if c.is_ascii_alphanumeric() || c == b'_' || c == b'$' || c >= 0x80 {
                self.i += 1;
            } else {
                break;
            }
        }
        (self.i > start).then(|| String::from_utf8_lossy(&self.s[start..self.i]).into_owned())
    }

    fn ty(&mut self) -> Option<TypeRef> {
        let base = self.base()?;
        let mut t = base;
        loop {
            let save = self.i;
            if self.eat(b'[') && self.eat(b']') {
                t = TypeRef::Array(Box::new(t));
            } else {
                self.i = save;
                break;
            }
        }
        // Variable arity written as `T...` counts as an array.
        let save = self.i;
        if self.eat(b'.') && self.eat(b'.') && self.eat(b'.') {
            t = TypeRef::Array(Box::new(t));
        } else {
            self.i = save;
        }
        Some(t)
    }

    fn base(&mut self) -> Option<TypeRef> {
        const PRIMS: [(&str, BaseType); 8] = [
            ("byte", BaseType::Byte),
            ("short", BaseType::Short),
            ("char", BaseType::Char),
            ("int", BaseType::Int),
            ("long", BaseType::Long),
            ("float", BaseType::Float),
            ("double", BaseType::Double),
            ("boolean", BaseType::Boolean),
        ];
        for (k, b) in PRIMS {
            if self.keyword(k) {
                return Some(TypeRef::Prim(b));
            }
        }
        if self.keyword("void") {
            return Some(TypeRef::Void);
        }
        let mut segments = Vec::new();
        loop {
            let name = self.ident()?;
            let mut seg = Segment { name, args: Vec::new(), diamond: false };
            if self.eat(b'<') {
                if self.eat(b'>') {
                    seg.diamond = true;
                } else {
                    loop {
                        seg.args.push(self.arg()?);
                        if self.eat(b'>') {
                            break;
                        }
                        if !self.eat(b',') {
                            return None;
                        }
                    }
                }
            }
            segments.push(seg);
            let save = self.i;
            if self.eat(b'.') {
                // `T...` is variable arity, not a segment.
                if self.s.get(self.i) == Some(&b'.') {
                    self.i = save;
                    break;
                }
                continue;
            }
            break;
        }
        Some(TypeRef::Named(segments))
    }

    fn arg(&mut self) -> Option<ArgRef> {
        if self.eat(b'?') {
            if self.keyword("extends") {
                return Some(ArgRef::Extends(self.ty()?));
            }
            if self.keyword("super") {
                return Some(ArgRef::Super(self.ty()?));
            }
            return Some(ArgRef::Any);
        }
        Some(ArgRef::Exact(self.ty()?))
    }
}

/// Parses a type as written; `None` when it is not one (a parse error in the source).
pub fn parse(text: &str) -> Option<TypeRef> {
    let mut p = Parser { s: text.as_bytes(), i: 0 };
    let t = p.ty()?;
    p.ws();
    (p.i == p.s.len()).then_some(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(name: &str) -> TypeRef {
        TypeRef::Named(vec![Segment { name: name.into(), args: vec![], diamond: false }])
    }

    #[test]
    fn parses_canonical_and_spaced_types() {
        assert_eq!(parse("int").unwrap(), TypeRef::Prim(BaseType::Int));
        assert_eq!(parse("String[][]").unwrap(), TypeRef::Array(Box::new(TypeRef::Array(Box::new(named("String"))))));
        let t = parse("Map<String,List<? extends T>>").unwrap();
        let TypeRef::Named(segs) = &t else { panic!() };
        assert_eq!(segs[0].name, "Map");
        assert_eq!(segs[0].args[0], ArgRef::Exact(named("String")));
        let ArgRef::Exact(TypeRef::Named(list)) = &segs[0].args[1] else { panic!() };
        assert_eq!(list[0].args[0], ArgRef::Extends(named("T")));
        let t = parse("java.util.Map.Entry<K, ? super V>").unwrap();
        assert_eq!(t.dotted().unwrap(), "java.util.Map.Entry");
        let t = parse("Outer<T>.Inner").unwrap();
        let TypeRef::Named(segs) = &t else { panic!() };
        assert_eq!((segs.len(), segs[0].args.len(), segs[1].args.len()), (2, 1, 0));
        assert_eq!(
            parse("List<?>").unwrap(),
            TypeRef::Named(vec![Segment { name: "List".into(), args: vec![ArgRef::Any], diamond: false }])
        );
        assert!(parse("ArrayList<>").is_some_and(|t| matches!(&t, TypeRef::Named(s) if s[0].diamond)));
        assert_eq!(parse("String...").unwrap(), TypeRef::Array(Box::new(named("String"))));
        assert!(parse("var").unwrap().is_var());
        assert!(parse("integer").is_some_and(|t| t == named("integer")), "a keyword prefix is not a keyword");
        assert!(parse("Map<String").is_none());
        assert!(parse("").is_none());
    }
}
