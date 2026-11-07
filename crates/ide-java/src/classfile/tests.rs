use super::*;
use std::path::Path;

fn fixture(name: &str) -> ClassStub {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(format!("{name}.class"));
    parse(&std::fs::read(&path).unwrap()).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn class(name: &str) -> TypeSig {
    TypeSig::Class(ClassTypeSig { name: name.into(), args: Vec::new() })
}

fn method<'a>(c: &'a ClassStub, name: &str) -> &'a MethodStub {
    c.methods.iter().find(|m| m.name == name).unwrap_or_else(|| panic!("no method {name}"))
}

#[test]
fn generic_class_with_bounds_and_members() {
    let c = fixture("Box");
    assert_eq!((c.name.as_str(), c.simple_name.as_str(), c.package()), ("fx/Box", "Box", "fx"));
    assert_eq!(c.super_name.as_deref(), Some("java/lang/Object"));
    assert_eq!(c.interfaces, ["java/lang/Iterable"]);
    let sig = c.signature.as_ref().unwrap();
    assert_eq!(sig.type_params[0].name, "T");
    // `T extends Comparable<? super T>`: an interface bound only.
    let TypeSig::Class(bound) = &sig.type_params[0].bounds[0] else { panic!() };
    assert_eq!(bound.name, "java/lang/Comparable");
    assert_eq!(bound.own_args(), [TypeArgSig::Super(TypeSig::TypeVar("T".into()))]);
    let TypeSig::Class(iterable) = &sig.interfaces[0] else { panic!() };
    assert_eq!(iterable.own_args(), [TypeArgSig::Exact(TypeSig::TypeVar("T".into()))]);
    // Member classes, not the anonymous one.
    let mut members = c.members.clone();
    members.sort();
    assert_eq!(members, ["fx/Box$Cursor", "fx/Box$Entry"]);
    assert!(c.outer.is_none() && !c.local);

    let name = c.fields.iter().find(|f| f.name == "NAME").unwrap();
    assert_eq!(name.constant, Some(ConstValue::Str("box".into())));
    assert_eq!(c.fields.iter().find(|f| f.name == "SIZE").unwrap().constant, Some(ConstValue::Int(42)));
    let items = c.fields.iter().find(|f| f.name == "items").unwrap();
    let TypeSig::Class(list) = &items.ty else { panic!() };
    assert_eq!(list.name, "java/util/List");
    assert_eq!(list.own_args(), [TypeArgSig::Extends(TypeSig::TypeVar("T".into()))]);

    let ctor = method(&c, "<init>");
    assert!(ctor.is_constructor());
    assert_eq!(ctor.param_names, ["items"]);
    let map = method(&c, "map");
    assert_eq!(map.type_params[0].name, "R");
    assert_eq!(map.ret, TypeSig::TypeVar("R".into()));
    assert_eq!(map.throws, [class("java/io/IOException")]);
    assert_eq!(map.param_names, ["f"]);
    let max = method(&c, "max");
    assert!(max.is_varargs() && max.flags & ACC_STATIC as u32 != 0);
    assert_eq!(max.type_params[0].bounds.len(), 2);
    assert_eq!(max.params, [TypeSig::Array(Box::new(TypeSig::TypeVar("E".into())))]);
    assert!(method(&c, "old").flags & DEPRECATED != 0);
    assert!(method(&c, "iterator").flags & DEPRECATED == 0);
}

#[test]
fn inner_classes_and_their_constructors() {
    let cursor = fixture("Box$Cursor");
    assert_eq!(cursor.simple_name, "Cursor");
    assert_eq!(cursor.outer.as_deref(), Some("fx/Box"));
    assert!(cursor.flags & ACC_STATIC as u32 == 0 && cursor.flags & ACC_PUBLIC as u32 != 0);
    // The enclosing instance parameter is the compiler's, not the source's.
    let ctor = method(&cursor, "<init>");
    assert_eq!(ctor.params, [TypeSig::Base(BaseType::Int)]);
    assert_eq!(ctor.param_names, ["start"]);
    assert_eq!(method(&cursor, "current").ret, TypeSig::TypeVar("T".into()));

    let entry = fixture("Box$Entry");
    assert!(entry.flags & ACC_STATIC as u32 != 0);
    assert_eq!(entry.signature.as_ref().unwrap().type_params.len(), 2);

    let anon = fixture("Box$1");
    assert!(anon.local && anon.simple_name.is_empty());
    assert!(anon.methods.iter().all(|m| !m.is_constructor()), "anonymous classes have no constructors");
}

#[test]
fn enums_records_annotations_and_sealed_types() {
    let color = fixture("Color");
    assert!(color.is_enum());
    let ctor = method(&color, "<init>");
    assert_eq!(ctor.params, [class("java/lang/String")], "enum name and ordinal are synthetic");
    assert!(color.methods.iter().any(|m| m.name == "values"), "values() resolves like any method");
    assert!(color.fields.iter().any(|f| f.name == "RED" && f.flags & ACC_ENUM as u32 != 0));
    assert!(color.fields.iter().all(|f| f.name != "$VALUES"), "synthetic fields are left out");

    let point = fixture("Point");
    assert!(point.is_record());
    let names: Vec<_> = point.record_components.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(names, ["x", "y"]);
    assert_eq!(point.record_components[0].ty, TypeSig::TypeVar("N".into()));
    assert!(point.methods.iter().any(|m| m.name == "x" && m.params.is_empty()));

    let tag = fixture("Tag");
    assert!(tag.is_annotation() && tag.is_interface());
    assert!(method(&tag, "value").flags & HAS_DEFAULT != 0);
    assert!(method(&tag, "color").flags & HAS_DEFAULT == 0);
    let retention = tag.annotations.iter().find(|a| a.ty == "java/lang/annotation/Retention").unwrap();
    assert_eq!(
        retention.elements,
        [(
            "value".into(),
            ElementValue::Enum { ty: "java/lang/annotation/RetentionPolicy".into(), name: "RUNTIME".into() }
        )]
    );

    let shape = fixture("Shape");
    assert!(shape.is_interface());
    assert_eq!(shape.permitted, ["fx/Shape$Circle", "fx/Shape$Square"]);
    let a = shape.annotations.iter().find(|a| a.ty == "fx/Tag").unwrap();
    assert!(a.visible);
    let types = &a.elements.iter().find(|(n, _)| n == "types").unwrap().1;
    assert_eq!(
        *types,
        ElementValue::Array(vec![
            ElementValue::Class(class("java/lang/String")),
            ElementValue::Class(TypeSig::Base(BaseType::Int))
        ])
    );
    assert!(method(&shape, "describe").flags & ACC_ABSTRACT as u32 == 0);
    let circle = fixture("Shape$Circle");
    assert!(circle.is_record() && circle.flags & ACC_STATIC as u32 != 0, "member types of interfaces are static");
    assert_eq!(method(&circle, "<init>").params, [TypeSig::Base(BaseType::Double)]);
}

#[test]
fn rejects_what_is_not_a_class() {
    assert!(parse(b"\xCA\xFE\xBA\xBE").is_err());
    assert!(parse(b"PK\x03\x04").is_err());
    let mut bytes = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/Box.class")).unwrap();
    bytes.truncate(bytes.len() / 2);
    assert!(parse(&bytes).is_err());
}
