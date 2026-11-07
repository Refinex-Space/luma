//! Class files → stubs: the declarations a compiled class contributes to name resolution and
//! nothing of its code, as IDEA's `ClsStubBuilder` / `StubBuildingVisitor` build them
//! (`java/java-psi-impl/src/com/intellij/psi/impl/compiled`, Apache 2.0). Like IDEA, synthetic
//! members and the class initializer are left out, an anonymous class has no constructors, and
//! a constructor without a generic signature loses the parameters the compiler adds (an enum's
//! name and ordinal, an inner class's enclosing instance).

mod reader;
pub mod signature;

pub use reader::{ClassFileError, decode_mutf8};
pub use signature::{
    BaseType, ClassSignature, ClassTypeSig, MethodSignature, TypeArgSig, TypeParamSig, TypeSig, parse_class,
    parse_field, parse_method,
};

use reader::{Constant, ConstantPool, Cursor, Result, err};
use serde::{Deserialize, Serialize};

pub const ACC_PUBLIC: u16 = 0x0001;
pub const ACC_PRIVATE: u16 = 0x0002;
pub const ACC_PROTECTED: u16 = 0x0004;
pub const ACC_STATIC: u16 = 0x0008;
pub const ACC_FINAL: u16 = 0x0010;
pub const ACC_SYNCHRONIZED: u16 = 0x0020;
pub const ACC_BRIDGE: u16 = 0x0040;
pub const ACC_VARARGS: u16 = 0x0080;
pub const ACC_NATIVE: u16 = 0x0100;
pub const ACC_INTERFACE: u16 = 0x0200;
pub const ACC_ABSTRACT: u16 = 0x0400;
pub const ACC_STRICT: u16 = 0x0800;
pub const ACC_SYNTHETIC: u16 = 0x1000;
pub const ACC_ANNOTATION: u16 = 0x2000;
pub const ACC_ENUM: u16 = 0x4000;
/// Class flag of `module-info.class`; field / method flag `ACC_MANDATED` for parameters.
pub const ACC_MODULE: u16 = 0x8000;
/// Not a JVM flag: set by the stub builder on `@Deprecated` or `Deprecated`-attributed members.
pub const DEPRECATED: u32 = 1 << 16;
/// Not a JVM flag: a method of an annotation type with a default value.
pub const HAS_DEFAULT: u32 = 1 << 17;

const MAGIC: u32 = 0xCAFE_BABE;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ClassStub {
    /// Binary name with `/` separators: `java/util/Map$Entry`.
    pub name: String,
    /// The simple name as written: `Entry` (empty for an anonymous class).
    pub simple_name: String,
    /// Access flags; for a nested class the `InnerClasses` flags (with `static`, `private`…),
    /// with [`DEPRECATED`] when deprecated.
    pub flags: u32,
    pub super_name: Option<String>,
    pub interfaces: Vec<String>,
    pub signature: Option<ClassSignature>,
    pub fields: Vec<FieldStub>,
    pub methods: Vec<MethodStub>,
    /// Member classes declared here (binary names), in the order the class file lists them.
    pub members: Vec<String>,
    /// The class this one is a member of.
    pub outer: Option<String>,
    /// Local or anonymous: not reachable by name.
    pub local: bool,
    pub annotations: Vec<AnnotationStub>,
    pub record_components: Vec<RecordComponentStub>,
    pub permitted: Vec<String>,
    pub source_file: Option<String>,
    pub major_version: u16,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FieldStub {
    pub name: String,
    pub flags: u32,
    /// The generic type when a signature is present, else the descriptor's.
    pub ty: TypeSig,
    pub constant: Option<ConstValue>,
    pub annotations: Vec<AnnotationStub>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MethodStub {
    /// `<init>` for a constructor.
    pub name: String,
    pub flags: u32,
    pub type_params: Vec<TypeParamSig>,
    /// Source parameters (synthetic ones of constructors dropped).
    pub params: Vec<TypeSig>,
    pub ret: TypeSig,
    pub throws: Vec<TypeSig>,
    /// From `MethodParameters` when compiled with `-parameters`, else empty.
    pub param_names: Vec<String>,
    pub annotations: Vec<AnnotationStub>,
    /// Erased descriptor, for identity (overloads of the same name).
    pub descriptor: String,
}

impl MethodStub {
    pub fn is_constructor(&self) -> bool {
        self.name == "<init>"
    }

    pub fn is_varargs(&self) -> bool {
        self.flags & ACC_VARARGS as u32 != 0
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecordComponentStub {
    pub name: String,
    pub ty: TypeSig,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AnnotationStub {
    /// Binary name of the annotation type.
    pub ty: String,
    /// `RuntimeVisibleAnnotations` (else `RuntimeInvisibleAnnotations`: retention CLASS).
    pub visible: bool,
    pub elements: Vec<(String, ElementValue)>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum ConstValue {
    Int(i32),
    Long(i64),
    Float(f32),
    Double(f64),
    Str(String),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum ElementValue {
    Const(ConstValue),
    /// Tag `Z`, `C`, `B`, `S`: an int constant of that type.
    Typed(BaseType, i32),
    Enum {
        ty: String,
        name: String,
    },
    Class(TypeSig),
    Annotation(Box<AnnotationStub>),
    Array(Vec<ElementValue>),
}

impl ClassStub {
    /// Package with `/` separators (`java/util`), empty for the default package.
    pub fn package(&self) -> &str {
        self.name.rfind('/').map_or("", |i| &self.name[..i])
    }

    pub fn is_interface(&self) -> bool {
        self.flags & ACC_INTERFACE as u32 != 0
    }

    pub fn is_annotation(&self) -> bool {
        self.flags & ACC_ANNOTATION as u32 != 0
    }

    pub fn is_enum(&self) -> bool {
        self.flags & ACC_ENUM as u32 != 0
    }

    pub fn is_record(&self) -> bool {
        self.super_name.as_deref() == Some("java/lang/Record")
    }

    pub fn is_deprecated(&self) -> bool {
        self.flags & DEPRECATED != 0
    }
}

/// Builds the stub of a class file. `module-info` and `package-info` files are errors: they
/// declare no class.
pub fn parse(bytes: &[u8]) -> std::result::Result<ClassStub, ClassFileError> {
    let mut c = Cursor::new(bytes);
    if c.u32()? != MAGIC {
        return err("not a class file");
    }
    let _minor = c.u16()?;
    let major_version = c.u16()?;
    let pool = ConstantPool::read(&mut c)?;
    let access = c.u16()?;
    if access & ACC_MODULE != 0 {
        return err("module-info declares no class");
    }
    let name = pool.class_name(c.u16()?)?.to_owned();
    let super_name = pool.opt_class_name(c.u16()?)?.map(str::to_owned);
    let n = c.u16()? as usize;
    let mut interfaces = Vec::with_capacity(n);
    for _ in 0..n {
        interfaces.push(pool.class_name(c.u16()?)?.to_owned());
    }

    let raw_fields = read_members(&mut c, &pool)?;
    let raw_methods = read_members(&mut c, &pool)?;
    // Bytes after the attributes are ignored, as the JVM and ASM do (some tools append them).
    let class_attrs = read_attributes(&mut c, &pool)?;

    let mut stub = ClassStub {
        simple_name: name.rsplit('/').next().unwrap_or(&name).to_owned(),
        name,
        flags: (access & !ACC_SYNCHRONIZED) as u32,
        super_name,
        interfaces,
        signature: None,
        fields: Vec::new(),
        methods: Vec::new(),
        members: Vec::new(),
        outer: None,
        local: false,
        annotations: Vec::new(),
        record_components: Vec::new(),
        permitted: Vec::new(),
        source_file: None,
        major_version,
    };

    let mut anonymous = false;
    for attr in &class_attrs {
        let mut a = Cursor::new(attr.data);
        match attr.name {
            "Signature" => {
                // A malformed signature (obfuscators) falls back to the erased supertypes, as in IDEA.
                stub.signature = parse_class(pool.utf8(a.u16()?)?).ok();
            }
            "InnerClasses" => {
                for _ in 0..a.u16()? {
                    let inner = pool.class_name(a.u16()?)?;
                    let outer = pool.opt_class_name(a.u16()?)?;
                    let inner_name = a.u16()?;
                    let flags = a.u16()?;
                    if inner == stub.name {
                        if inner_name == 0 {
                            anonymous = true;
                            stub.simple_name.clear();
                        } else {
                            stub.simple_name = pool.utf8(inner_name)?.to_owned();
                        }
                        match outer {
                            Some(o) => stub.outer = Some(o.to_owned()),
                            None => stub.local = true,
                        }
                        stub.flags = (flags & !ACC_SYNCHRONIZED) as u32 | (stub.flags & DEPRECATED);
                    } else if outer == Some(stub.name.as_str()) && inner_name != 0 && flags & ACC_SYNTHETIC == 0 {
                        stub.members.push(inner.to_owned());
                    }
                }
            }
            "EnclosingMethod" => stub.local = true,
            "RuntimeVisibleAnnotations" => stub.annotations.extend(read_annotations(&mut a, &pool, true)?),
            "RuntimeInvisibleAnnotations" => stub.annotations.extend(read_annotations(&mut a, &pool, false)?),
            "Deprecated" => stub.flags |= DEPRECATED,
            "SourceFile" => stub.source_file = Some(pool.utf8(a.u16()?)?.to_owned()),
            "PermittedSubclasses" => {
                for _ in 0..a.u16()? {
                    stub.permitted.push(pool.class_name(a.u16()?)?.to_owned());
                }
            }
            "Record" => {
                for _ in 0..a.u16()? {
                    let name = pool.utf8(a.u16()?)?.to_owned();
                    let descriptor = pool.utf8(a.u16()?)?;
                    let mut ty = parse_field(descriptor).map_err(|e| reader::ClassFileError(e.to_string()))?;
                    for attr in read_attributes(&mut a, &pool)? {
                        if attr.name == "Signature"
                            && let Ok(t) = parse_field(pool.utf8(Cursor::new(attr.data).u16()?)?)
                        {
                            ty = t;
                        }
                    }
                    stub.record_components.push(RecordComponentStub { name, ty });
                }
            }
            _ => {}
        }
    }
    if stub.annotations.iter().any(|a| a.ty == "java/lang/Deprecated") {
        stub.flags |= DEPRECATED;
    }

    for f in raw_fields {
        if f.access & ACC_SYNTHETIC != 0 {
            continue;
        }
        let mut field = FieldStub {
            name: f.name.to_owned(),
            flags: f.access as u32,
            ty: parse_field(f.descriptor).map_err(|e| reader::ClassFileError(e.to_string()))?,
            constant: None,
            annotations: Vec::new(),
        };
        for attr in &f.attrs {
            let mut a = Cursor::new(attr.data);
            match attr.name {
                "Signature" => {
                    if let Ok(t) = parse_field(pool.utf8(a.u16()?)?) {
                        field.ty = t;
                    }
                }
                "ConstantValue" => field.constant = constant(&pool, a.u16()?)?,
                "RuntimeVisibleAnnotations" => field.annotations.extend(read_annotations(&mut a, &pool, true)?),
                "RuntimeInvisibleAnnotations" => field.annotations.extend(read_annotations(&mut a, &pool, false)?),
                "Deprecated" => field.flags |= DEPRECATED,
                _ => {}
            }
        }
        if field.annotations.iter().any(|a| a.ty == "java/lang/Deprecated") {
            field.flags |= DEPRECATED;
        }
        stub.fields.push(field);
    }

    let is_enum = stub.is_enum();
    let is_inner = stub.outer.is_some() && stub.flags & ACC_STATIC as u32 == 0 && !stub.is_interface();
    for m in raw_methods {
        if m.access & (ACC_SYNTHETIC | ACC_BRIDGE) != 0 || m.name == "<clinit>" {
            continue;
        }
        let is_constructor = m.name == "<init>";
        if is_constructor && anonymous {
            continue;
        }
        let erased = parse_method(m.descriptor).map_err(|e| reader::ClassFileError(e.to_string()))?;
        let mut method = MethodStub {
            name: m.name.to_owned(),
            flags: m.access as u32,
            type_params: Vec::new(),
            params: erased.params,
            ret: erased.ret,
            throws: erased.throws,
            param_names: Vec::new(),
            annotations: Vec::new(),
            descriptor: m.descriptor.to_owned(),
        };
        let mut generic = false;
        for attr in &m.attrs {
            let mut a = Cursor::new(attr.data);
            match attr.name {
                "Signature" => {
                    if let Ok(sig) = parse_method(pool.utf8(a.u16()?)?) {
                        method.type_params = sig.type_params;
                        method.params = sig.params;
                        method.ret = sig.ret;
                        if !sig.throws.is_empty() {
                            method.throws = sig.throws;
                        }
                        generic = true;
                    }
                }
                "Exceptions" if method.throws.is_empty() => {
                    for _ in 0..a.u16()? {
                        let name = pool.class_name(a.u16()?)?;
                        method.throws.push(TypeSig::Class(ClassTypeSig { name: name.to_owned(), args: Vec::new() }));
                    }
                }
                "MethodParameters" => {
                    for _ in 0..a.u8()? {
                        let name = a.u16()?;
                        let flags = a.u16()?;
                        if flags & (ACC_SYNTHETIC | ACC_MODULE) == 0 {
                            method.param_names.push(if name == 0 {
                                String::new()
                            } else {
                                pool.utf8(name)?.to_owned()
                            });
                        }
                    }
                }
                "RuntimeVisibleAnnotations" => method.annotations.extend(read_annotations(&mut a, &pool, true)?),
                "RuntimeInvisibleAnnotations" => method.annotations.extend(read_annotations(&mut a, &pool, false)?),
                "AnnotationDefault" => method.flags |= HAS_DEFAULT,
                "Deprecated" => method.flags |= DEPRECATED,
                _ => {}
            }
        }
        if is_constructor && !generic {
            let string = |t: &TypeSig| matches!(t, TypeSig::Class(c) if c.name == "java/lang/String");
            if is_enum
                && method.params.len() >= 2
                && string(&method.params[0])
                && method.params[1] == TypeSig::Base(BaseType::Int)
            {
                method.params.drain(..2);
            } else if is_inner && !method.params.is_empty() {
                method.params.remove(0);
            }
        }
        if method.param_names.len() != method.params.len() {
            method.param_names.clear();
        }
        if method.annotations.iter().any(|a| a.ty == "java/lang/Deprecated") {
            method.flags |= DEPRECATED;
        }
        stub.methods.push(method);
    }
    Ok(stub)
}

struct RawAttr<'a> {
    name: &'a str,
    data: &'a [u8],
}

struct RawMember<'a> {
    access: u16,
    name: &'a str,
    descriptor: &'a str,
    attrs: Vec<RawAttr<'a>>,
}

fn read_attributes<'a>(c: &mut Cursor<'a>, pool: &'a ConstantPool) -> Result<Vec<RawAttr<'a>>> {
    let n = c.u16()? as usize;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let name = pool.utf8(c.u16()?)?;
        let len = c.u32()? as usize;
        let data = c.bytes(len)?;
        out.push(RawAttr { name, data });
    }
    Ok(out)
}

fn read_members<'a>(c: &mut Cursor<'a>, pool: &'a ConstantPool) -> Result<Vec<RawMember<'a>>> {
    let n = c.u16()? as usize;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let access = c.u16()?;
        let name = pool.utf8(c.u16()?)?;
        let descriptor = pool.utf8(c.u16()?)?;
        let attrs = read_attributes(c, pool)?;
        out.push(RawMember { access, name, descriptor, attrs });
    }
    Ok(out)
}

fn constant(pool: &ConstantPool, index: u16) -> Result<Option<ConstValue>> {
    Ok(match pool.get(index)? {
        Constant::Int(v) => Some(ConstValue::Int(*v)),
        Constant::Long(v) => Some(ConstValue::Long(*v)),
        Constant::Float(v) => Some(ConstValue::Float(*v)),
        Constant::Double(v) => Some(ConstValue::Double(*v)),
        Constant::Str(s) => Some(ConstValue::Str(pool.utf8(*s)?.to_owned())),
        Constant::Utf8(s) => Some(ConstValue::Str(s.to_string())),
        _ => None,
    })
}

/// A type descriptor `Lpkg/Name;` → `pkg/Name`; anything else as is.
fn descriptor_class(descriptor: &str) -> String {
    descriptor.strip_prefix('L').and_then(|d| d.strip_suffix(';')).unwrap_or(descriptor).to_owned()
}

fn read_annotations(c: &mut Cursor, pool: &ConstantPool, visible: bool) -> Result<Vec<AnnotationStub>> {
    let n = c.u16()? as usize;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        out.push(read_annotation(c, pool, visible)?);
    }
    Ok(out)
}

fn read_annotation(c: &mut Cursor, pool: &ConstantPool, visible: bool) -> Result<AnnotationStub> {
    let ty = descriptor_class(pool.utf8(c.u16()?)?);
    let n = c.u16()? as usize;
    let mut elements = Vec::with_capacity(n);
    for _ in 0..n {
        let name = pool.utf8(c.u16()?)?.to_owned();
        elements.push((name, read_element(c, pool, visible)?));
    }
    Ok(AnnotationStub { ty, visible, elements })
}

fn read_element(c: &mut Cursor, pool: &ConstantPool, visible: bool) -> Result<ElementValue> {
    let tag = c.u8()?;
    Ok(match tag {
        b'B' | b'C' | b'S' | b'Z' => {
            let base = match tag {
                b'B' => BaseType::Byte,
                b'C' => BaseType::Char,
                b'S' => BaseType::Short,
                _ => BaseType::Boolean,
            };
            match pool.get(c.u16()?)? {
                Constant::Int(v) => ElementValue::Typed(base, *v),
                other => return err(format!("bad {} element constant {other:?}", tag as char)),
            }
        }
        b'D' | b'F' | b'I' | b'J' | b's' => match constant(pool, c.u16()?)? {
            Some(v) => ElementValue::Const(v),
            None => return err("bad element constant"),
        },
        b'e' => {
            let ty = descriptor_class(pool.utf8(c.u16()?)?);
            let name = pool.utf8(c.u16()?)?.to_owned();
            ElementValue::Enum { ty, name }
        }
        b'c' => {
            let d = pool.utf8(c.u16()?)?;
            ElementValue::Class(if d == "V" {
                TypeSig::Void
            } else {
                parse_field(d).map_err(|e| reader::ClassFileError(e.to_string()))?
            })
        }
        b'@' => ElementValue::Annotation(Box::new(read_annotation(c, pool, visible)?)),
        b'[' => {
            let n = c.u16()? as usize;
            let mut items = Vec::with_capacity(n);
            for _ in 0..n {
                items.push(read_element(c, pool, visible)?);
            }
            ElementValue::Array(items)
        }
        other => return err(format!("unknown element value tag {}", other as char)),
    })
}

#[cfg(test)]
mod tests;
