//! Field / method descriptors and generic signatures of class files (JVMS §4.3, §4.7.9.1), parsed
//! into the types the compiler wrote, as IDEA's `SignatureParsing` does for its class-file stubs.

use serde::{Deserialize, Serialize};

/// A primitive type of a descriptor or signature.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum BaseType {
    Byte,
    Char,
    Double,
    Float,
    Int,
    Long,
    Short,
    Boolean,
}

impl BaseType {
    fn from_char(c: u8) -> Option<Self> {
        Some(match c {
            b'B' => Self::Byte,
            b'C' => Self::Char,
            b'D' => Self::Double,
            b'F' => Self::Float,
            b'I' => Self::Int,
            b'J' => Self::Long,
            b'S' => Self::Short,
            b'Z' => Self::Boolean,
            _ => return None,
        })
    }

    pub fn keyword(self) -> &'static str {
        match self {
            Self::Byte => "byte",
            Self::Char => "char",
            Self::Double => "double",
            Self::Float => "float",
            Self::Int => "int",
            Self::Long => "long",
            Self::Short => "short",
            Self::Boolean => "boolean",
        }
    }
}

/// A type as a class file records it: erased (descriptor) or generic (signature).
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TypeSig {
    Base(BaseType),
    Void,
    Class(ClassTypeSig),
    TypeVar(String),
    Array(Box<TypeSig>),
}

/// `Ljava/util/Map$Entry<TK;TV;>;`: the binary name and the type arguments of each segment.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ClassTypeSig {
    /// Binary name with `/` separators: `java/util/Map$Entry`.
    pub name: String,
    /// Arguments per segment, outermost first; segments without arguments are empty. A
    /// signature `LOuter<TT;>.Inner<TU;>;` gives `[[T], [U]]`.
    pub args: Vec<Vec<TypeArgSig>>,
}

impl ClassTypeSig {
    /// Arguments of the innermost segment (the class itself).
    pub fn own_args(&self) -> &[TypeArgSig] {
        self.args.last().map(Vec::as_slice).unwrap_or(&[])
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TypeArgSig {
    /// `*`
    Any,
    /// `+T`: `? extends T`
    Extends(TypeSig),
    /// `-T`: `? super T`
    Super(TypeSig),
    Exact(TypeSig),
}

/// `T:Ljava/lang/Object;:Ljava/lang/Comparable<TT;>;`
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TypeParamSig {
    pub name: String,
    /// Class bound (if any) then interface bounds. Empty means `Object`.
    pub bounds: Vec<TypeSig>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ClassSignature {
    pub type_params: Vec<TypeParamSig>,
    pub super_class: TypeSig,
    pub interfaces: Vec<TypeSig>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct MethodSignature {
    pub type_params: Vec<TypeParamSig>,
    pub params: Vec<TypeSig>,
    pub ret: TypeSig,
    pub throws: Vec<TypeSig>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignatureError {
    pub at: usize,
    pub text: String,
}

impl std::fmt::Display for SignatureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "malformed signature at {}: {}", self.at, self.text)
    }
}

type Result<T> = std::result::Result<T, SignatureError>;

struct Parser<'a> {
    s: &'a [u8],
    text: &'a str,
    i: usize,
}

impl<'a> Parser<'a> {
    fn new(text: &'a str) -> Self {
        Self { s: text.as_bytes(), text, i: 0 }
    }

    fn err<T>(&self) -> Result<T> {
        Err(SignatureError { at: self.i, text: self.text.to_owned() })
    }

    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn eat(&mut self, c: u8) -> bool {
        if self.peek() == Some(c) {
            self.i += 1;
            true
        } else {
            false
        }
    }

    fn expect(&mut self, c: u8) -> Result<()> {
        if self.eat(c) { Ok(()) } else { self.err() }
    }

    fn done(&self) -> Result<()> {
        if self.i == self.s.len() { Ok(()) } else { self.err() }
    }

    /// An identifier up to one of `stops`.
    fn ident(&mut self, stops: &[u8]) -> Result<&'a str> {
        let start = self.i;
        while let Some(c) = self.peek() {
            if stops.contains(&c) {
                break;
            }
            self.i += 1;
        }
        if self.i == start {
            return self.err();
        }
        Ok(&self.text[start..self.i])
    }

    fn java_type(&mut self) -> Result<TypeSig> {
        match self.peek() {
            Some(c) if BaseType::from_char(c).is_some() => {
                self.i += 1;
                Ok(TypeSig::Base(BaseType::from_char(c).unwrap_or(BaseType::Int)))
            }
            _ => self.reference_type(),
        }
    }

    fn reference_type(&mut self) -> Result<TypeSig> {
        match self.peek() {
            Some(b'L') => self.class_type().map(TypeSig::Class),
            Some(b'T') => {
                self.i += 1;
                let name = self.ident(b";")?.to_owned();
                self.expect(b';')?;
                Ok(TypeSig::TypeVar(name))
            }
            Some(b'[') => {
                self.i += 1;
                Ok(TypeSig::Array(Box::new(self.java_type()?)))
            }
            _ => self.err(),
        }
    }

    fn class_type(&mut self) -> Result<ClassTypeSig> {
        self.expect(b'L')?;
        let mut name = self.ident(b"<.;")?.to_owned();
        let mut args = vec![self.type_args()?];
        while self.eat(b'.') {
            let segment = self.ident(b"<.;")?;
            name.push('$');
            name.push_str(segment);
            args.push(self.type_args()?);
        }
        self.expect(b';')?;
        if args.iter().all(Vec::is_empty) {
            args.clear();
        }
        Ok(ClassTypeSig { name, args })
    }

    fn type_args(&mut self) -> Result<Vec<TypeArgSig>> {
        let mut out = Vec::new();
        if !self.eat(b'<') {
            return Ok(out);
        }
        while !self.eat(b'>') {
            let arg = match self.peek() {
                Some(b'*') => {
                    self.i += 1;
                    TypeArgSig::Any
                }
                Some(b'+') => {
                    self.i += 1;
                    TypeArgSig::Extends(self.reference_type()?)
                }
                Some(b'-') => {
                    self.i += 1;
                    TypeArgSig::Super(self.reference_type()?)
                }
                Some(_) => TypeArgSig::Exact(self.reference_type()?),
                None => return self.err(),
            };
            out.push(arg);
        }
        if out.is_empty() {
            return self.err();
        }
        Ok(out)
    }

    fn type_params(&mut self) -> Result<Vec<TypeParamSig>> {
        let mut out = Vec::new();
        if !self.eat(b'<') {
            return Ok(out);
        }
        while !self.eat(b'>') {
            let name = self.ident(b":")?.to_owned();
            let mut bounds = Vec::new();
            // Class bound: `:` then an optional reference type.
            self.expect(b':')?;
            if matches!(self.peek(), Some(b'L' | b'T' | b'[')) {
                bounds.push(self.reference_type()?);
            }
            // Interface bounds.
            while self.eat(b':') {
                bounds.push(self.reference_type()?);
            }
            out.push(TypeParamSig { name, bounds });
        }
        Ok(out)
    }

    fn return_type(&mut self) -> Result<TypeSig> {
        if self.eat(b'V') { Ok(TypeSig::Void) } else { self.java_type() }
    }
}

/// A field descriptor (`[Ljava/lang/String;`) or field signature (`Ljava/util/List<TT;>;`).
pub fn parse_field(text: &str) -> std::result::Result<TypeSig, SignatureError> {
    let mut p = Parser::new(text);
    let t = p.java_type()?;
    p.done()?;
    Ok(t)
}

/// A method descriptor or signature.
pub fn parse_method(text: &str) -> std::result::Result<MethodSignature, SignatureError> {
    let mut p = Parser::new(text);
    let type_params = p.type_params()?;
    p.expect(b'(')?;
    let mut params = Vec::new();
    while !p.eat(b')') {
        params.push(p.java_type()?);
    }
    let ret = p.return_type()?;
    let mut throws = Vec::new();
    while p.eat(b'^') {
        throws.push(p.reference_type()?);
    }
    p.done()?;
    Ok(MethodSignature { type_params, params, ret, throws })
}

/// A class signature.
pub fn parse_class(text: &str) -> std::result::Result<ClassSignature, SignatureError> {
    let mut p = Parser::new(text);
    let type_params = p.type_params()?;
    let super_class = p.reference_type()?;
    let mut interfaces = Vec::new();
    while p.peek().is_some() {
        interfaces.push(p.reference_type()?);
    }
    Ok(ClassSignature { type_params, super_class, interfaces })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn class(name: &str) -> TypeSig {
        TypeSig::Class(ClassTypeSig { name: name.into(), args: Vec::new() })
    }

    #[test]
    fn descriptors() {
        assert_eq!(parse_field("I").unwrap(), TypeSig::Base(BaseType::Int));
        assert_eq!(
            parse_field("[[Ljava/lang/String;").unwrap(),
            TypeSig::Array(Box::new(TypeSig::Array(Box::new(class("java/lang/String")))))
        );
        let m = parse_method("(ILjava/lang/Object;[J)V").unwrap();
        assert_eq!(m.params.len(), 3);
        assert_eq!(m.ret, TypeSig::Void);
        assert!(parse_field("Ljava/lang/String").is_err());
        assert!(parse_field("I;").is_err());
    }

    #[test]
    fn map_entry_and_stream_signatures() {
        // java.util.Map: <K:Ljava/lang/Object;V:Ljava/lang/Object;>Ljava/lang/Object;
        let c = parse_class("<K:Ljava/lang/Object;V:Ljava/lang/Object;>Ljava/lang/Object;").unwrap();
        assert_eq!(c.type_params.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["K", "V"]);
        assert!(c.interfaces.is_empty());
        // Stream.map
        let m = parse_method(
            "<R:Ljava/lang/Object;>(Ljava/util/function/Function<-TT;+TR;>;)Ljava/util/stream/Stream<TR;>;",
        )
        .unwrap();
        assert_eq!(m.type_params[0].name, "R");
        let TypeSig::Class(f) = &m.params[0] else { panic!() };
        assert_eq!(f.name, "java/util/function/Function");
        assert_eq!(
            f.own_args(),
            [TypeArgSig::Super(TypeSig::TypeVar("T".into())), TypeArgSig::Extends(TypeSig::TypeVar("R".into()))]
        );
        // Interface-only bound: `<T::Ljava/lang/Comparable<-TT;>;>`
        let m = parse_method("<T::Ljava/lang/Comparable<-TT;>;>(Ljava/util/List<TT;>;)V").unwrap();
        assert_eq!(m.type_params[0].bounds.len(), 1);
        // Inner class of a generic outer, wildcard, throws clause.
        let m = parse_method("(LOuter<TT;>.Inner<*>;)TT;^Ljava/io/IOException;^TX;").unwrap();
        let TypeSig::Class(inner) = &m.params[0] else { panic!() };
        assert_eq!(inner.name, "Outer$Inner");
        assert_eq!(inner.args, vec![vec![TypeArgSig::Exact(TypeSig::TypeVar("T".into()))], vec![TypeArgSig::Any]]);
        assert_eq!(m.throws.len(), 2);
    }
}
