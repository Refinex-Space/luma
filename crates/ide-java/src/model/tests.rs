use super::*;
use crate::classpath::{ClassPath, ClassRoot};
use crate::types::{ClassType, Type, TypeArg};
use ide_index::testing::JavaSources;
use std::path::Path;
use std::sync::Arc;

/// The fixture class files (package `fx`) as a class directory.
fn fixtures() -> (tempfile::TempDir, ClassPath) {
    let dir = tempfile::tempdir().unwrap();
    let fx = dir.path().join("fx");
    std::fs::create_dir_all(&fx).unwrap();
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    for e in std::fs::read_dir(&src).unwrap().flatten() {
        if e.path().extension().is_some_and(|x| x == "class") {
            std::fs::copy(e.path(), fx.join(e.file_name())).unwrap();
        }
    }
    let cp = ClassPath::new(vec![Arc::new(ClassRoot::open(dir.path()).unwrap())]);
    (dir, cp)
}

fn var(name: &str, owner: &str) -> Type {
    Type::Var(TypeVar { name: name.into(), owner: owner.into() })
}

fn class_with(key: &str, args: Vec<Type>) -> Type {
    Type::Class(ClassType { key: key.into(), args: args.into_iter().map(TypeArg::Exact).collect(), outer: None })
}

#[test]
fn source_headers_resolve_type_parameters_and_supertypes() {
    let src = JavaSources::new(&[
        ("p/Base.java", "package p; public class Base<B> { public static class Node {} }"),
        (
            "p/Repo.java",
            "package p;\nimport fx.Box;\npublic class Repo<T extends Comparable<T>> extends Base<T> implements Iterable<T> {\n  Box<T> box;\n  Node node;\n}",
        ),
    ]);
    let (_d, cp) = fixtures();
    src.with_view(|view| {
        let m = Model::new(view, &cp);
        let repo = m.class("p/Repo").unwrap();
        assert_eq!(repo.kind, ClassKind::Class);
        assert!(repo.flags & ACC_PUBLIC as u32 != 0);
        assert_eq!(repo.type_params[0].var, TypeVar { name: "T".into(), owner: "p/Repo".into() });
        // `Comparable` is not on this class path: unknown, not guessed.
        assert_eq!(repo.type_params[0].bounds, [Type::Unknown]);
        assert_eq!(repo.super_class, Some(class_with("p/Base", vec![var("T", "p/Repo")])));
        assert_eq!(repo.interfaces, [Type::Unknown]);
        let members = m.members(&repo);
        let field = |n: &str| members.fields.iter().find(|f| f.name == n).unwrap().ty.clone();
        assert_eq!(field("box"), class_with("fx/Box", vec![var("T", "p/Repo")]));
        // An inherited member class.
        assert_eq!(field("node"), Type::class("p/Base$Node"));
        assert!(members.methods.iter().any(|x| x.is_constructor() && x.flags & IMPLICIT != 0));
    });
}

#[test]
fn library_classes_have_generic_members() {
    let src = JavaSources::new(&[]);
    let (_d, cp) = fixtures();
    src.with_view(|view| {
        let m = Model::new(view, &cp);
        let b = m.class("fx/Box").unwrap();
        assert_eq!(b.origin, Origin::Library);
        let t = var("T", "fx/Box");
        assert_eq!(b.interfaces, [class_with("java/lang/Iterable", vec![t.clone()])]);
        let members = m.members(&b);
        let map = members.methods.iter().find(|x| x.name == "map").unwrap();
        assert_eq!(map.ret, Type::Var(map.type_params[0].var.clone()));
        let cursor = m.class("fx/Box$Cursor").unwrap();
        assert!(cursor.is_inner());
        let current = m.members(&cursor).methods.iter().find(|x| x.name == "current").unwrap();
        // The outer class's type variable.
        assert_eq!(current.ret, t);
        assert_eq!(m.by_dotted("fx.Box.Cursor").as_deref(), Some("fx/Box$Cursor"));
        assert_eq!(m.by_dotted("fx.Box.Entry").as_deref(), Some("fx/Box$Entry"));
        assert!(m.by_dotted("fx.Box.Nope").is_none());

        // Box<String> seen as Iterable: Iterable<String>.
        let boxed = ClassType { key: "fx/Box".into(), args: vec![TypeArg::Exact(Type::string())], outer: None };
        let it = m.as_super(&boxed, "java/lang/Iterable").unwrap();
        assert_eq!(it.args, [TypeArg::Exact(Type::string())]);
        // A raw Box is a raw Iterable.
        let raw = ClassType { key: "fx/Box".into(), args: vec![], outer: None };
        assert!(m.as_super(&raw, "java/lang/Iterable").unwrap().args.is_empty());

        let color = m.class("fx/Color").unwrap();
        assert_eq!(color.kind, ClassKind::Enum);
        assert!(m.members(&color).fields.iter().any(|f| f.name == "RED" && f.enum_constant));
    });
}

#[test]
fn imports_package_and_ambiguity() {
    let src = JavaSources::new(&[
        ("q/Color.java", "package q; public class Color {}"),
        ("q/Point.java", "package q; public class Point {}"),
        ("a/Use.java", "package a;\nimport fx.*;\nclass Use { Color c; Tag t; }"),
        ("a/Both.java", "package a;\nimport fx.*;\nimport q.*;\nclass Both { Color c; Tag t; }"),
        ("a/Single.java", "package a;\nimport q.Color;\nimport fx.*;\nclass Single { Color c; }"),
        ("a/Same.java", "package a;\nimport fx.*;\nclass Same { Use u; }"),
        (
            "a/Nested.java",
            "package a;\nimport fx.Box.Entry;\nimport static fx.Box.Cursor;\nclass Nested { Entry<String, Integer> e; Cursor c; fx.Box.Entry<?, ?> q; }",
        ),
    ]);
    let (_d, cp) = fixtures();
    src.with_view(|view| {
        let m = Model::new(view, &cp);
        let field = |class: &str, name: &str| {
            let c = m.class(class).unwrap();
            m.members(&c).fields.iter().find(|f| f.name == name).unwrap().ty.clone()
        };
        assert_eq!(field("a/Use", "c"), Type::class("fx/Color"));
        assert_eq!(field("a/Use", "t"), Type::class("fx/Tag"));
        // Two on-demand imports define Color: javac rejects it, the engine does not guess.
        assert_eq!(field("a/Both", "c"), Type::Unknown);
        assert_eq!(field("a/Both", "t"), Type::class("fx/Tag"));
        // A single-type import shadows on-demand ones.
        assert_eq!(field("a/Single", "c"), Type::class("q/Color"));
        // The package beats on-demand imports.
        assert_eq!(field("a/Same", "u"), Type::class("a/Use"));
        let entry = field("a/Nested", "e");
        assert_eq!(entry.as_class().unwrap().key.as_ref(), "fx/Box$Entry");
        assert_eq!(entry.as_class().unwrap().args.len(), 2);
        assert_eq!(field("a/Nested", "c"), Type::class("fx/Box$Cursor"));
        assert_eq!(field("a/Nested", "q").as_class().unwrap().key.as_ref(), "fx/Box$Entry");
    });
}

#[test]
fn implicit_members_of_enums_records_and_classes() {
    let src = JavaSources::new(&[(
        "p/Kinds.java",
        "package p;\npublic class Kinds {\n  enum Mode { ON, OFF }\n  record Pair<A>(A left, int right) { public A left() { return left; } public Pair(A only) { this(only, 0); } }\n  interface Api { void run(); default void stop() {} static Api of() { return null; } }\n  private static class Hidden {}\n}",
    )]);
    let cp = ClassPath::empty();
    src.with_view(|view| {
        let m = Model::new(view, &cp);
        let mode = m.class("p/Kinds$Mode").unwrap();
        assert_eq!(mode.kind, ClassKind::Enum);
        assert!(mode.is_static());
        assert_eq!(mode.super_class.as_ref().unwrap().as_class().unwrap().key.as_ref(), "java/lang/Enum");
        let mm = m.members(&mode);
        let values = mm.methods.iter().find(|x| x.name == "values").unwrap();
        assert_eq!(values.ret, Type::Array(Box::new(Type::class("p/Kinds$Mode"))));
        assert!(mm.methods.iter().any(|x| x.name == "valueOf" && x.is_static()));
        let ctor = mm.methods.iter().find(|x| x.is_constructor()).unwrap();
        assert!(ctor.flags & ACC_PRIVATE as u32 != 0);

        let pair = m.class("p/Kinds$Pair").unwrap();
        assert_eq!(pair.kind, ClassKind::Record);
        let pm = m.members(&pair);
        let a = var("A", "p/Kinds$Pair");
        // The canonical constructor exists beside a declared non-canonical one (JLS §8.10.4).
        let canonical = pm.methods.iter().find(|x| x.is_constructor() && x.params.len() == 2).unwrap();
        assert_eq!(canonical.params, [a.clone(), Type::Prim(crate::classfile::BaseType::Int)]);
        assert!(pm.methods.iter().any(|x| x.is_constructor() && x.params == [a.clone()]));
        // The declared accessor replaces the implicit one: one `left()`.
        assert_eq!(pm.methods.iter().filter(|x| x.name == "left").count(), 1);
        assert!(pm.methods.iter().any(|x| x.name == "right" && x.params.is_empty()));

        let api = m.class("p/Kinds$Api").unwrap();
        assert!(api.is_interface() && api.is_static());
        let am = m.members(&api);
        assert!(am.methods.iter().find(|x| x.name == "run").unwrap().is_abstract());
        assert!(am.methods.iter().find(|x| x.name == "stop").unwrap().flags & DEFAULT_METHOD != 0);
        assert!(am.methods.iter().all(|x| !x.is_constructor()));
        // Interfaces see Object's members.
        assert!(m.all_supers("p/Kinds$Api").iter().any(|k| &**k == OBJECT));

        let hidden = m.class("p/Kinds$Hidden").unwrap();
        let ctor = m.members(&hidden).methods.iter().find(|x| x.is_constructor()).unwrap().flags;
        assert!(ctor & ACC_PRIVATE as u32 != 0, "a default constructor has the class's access");
    });
}

#[test]
fn local_and_anonymous_classes_have_unspellable_keys() {
    let src = JavaSources::new(&[(
        "p/Outer.java",
        "package p;\nclass Outer {\n  Object f = new Runnable() { public void run() {} };\n  void m() { class Local {} }\n}",
    )]);
    let cp = ClassPath::empty();
    src.with_view(|view| {
        let m = Model::new(view, &cp);
        let file = src.file("p/Outer.java").unwrap();
        let stub = view.stub(file).unwrap();
        for (i, t) in stub.types.iter().enumerate() {
            let id = TypeId { file, ty: i as u32 };
            let key = m.source_key(id).unwrap();
            assert_eq!(m.source_type(&key), Some(id), "{key} round-trips");
            if t.is(ix::ANONYMOUS) || t.is(ix::LOCAL) {
                assert!(key.contains("$#"), "{key}");
            }
        }
        let anon = stub.types.iter().position(|t| t.is(ix::ANONYMOUS)).unwrap();
        let c = m.source_class(TypeId { file, ty: anon as u32 }).unwrap();
        // `new Runnable() {}` with Runnable unknown here: still a class with Object above it.
        assert!(c.flags & ANONYMOUS_CLASS != 0);
        assert!(m.members(&c).methods.iter().all(|x| !x.is_constructor()));
    });
}

#[test]
fn the_edited_file_replaces_its_indexed_declarations() {
    let src = JavaSources::new(&[("p/A.java", "package p; class A { int x; }")]);
    let cp = ClassPath::empty();
    src.with_edit("p/A.java", "package p; class A { String y; }", |view| {
        let m = Model::new(view, &cp);
        let a = m.class("p/A").unwrap();
        let names: Vec<_> = m.members(&a).fields.iter().map(|f| f.name.clone()).collect();
        assert_eq!(names, ["y"]);
    });
}

#[test]
fn same_named_source_classes_follow_module_visibility() {
    let src = JavaSources::new(&[
        ("a/src/main/java/x/Dup.java", "package x; public class Dup { public int fromA; }"),
        ("b/src/main/java/x/Dup.java", "package x; public class Dup { public int fromB; }"),
    ]);
    let cp = ClassPath::empty();
    src.with_view(|view| {
        let only_b: crate::model::SourceVisibility = Arc::new(|p: &Path| (!p.starts_with("/p/a")).then_some(1));
        let m = Model::new(view, &cp).with_visibility(Some(only_b));
        let c = m.class("x/Dup").unwrap();
        let fields: Vec<_> = m.members(&c).fields.iter().map(|f| f.name.clone()).collect();
        assert_eq!(fields, ["fromB"]);
        let only_a: crate::model::SourceVisibility = Arc::new(|p: &Path| (!p.starts_with("/p/b")).then_some(1));
        let m = Model::new(view, &cp).with_visibility(Some(only_a));
        let c = m.class("x/Dup").unwrap();
        assert_eq!(m.members(&c).fields[0].name, "fromA");
        // Both visible: the earlier on the class path.
        let b_first: crate::model::SourceVisibility =
            Arc::new(|p: &Path| Some(if p.starts_with("/p/b") { 1 } else { 2 }));
        let m = Model::new(view, &cp).with_visibility(Some(b_first));
        let c = m.class("x/Dup").unwrap();
        assert_eq!(m.members(&c).fields[0].name, "fromB");
    });
}
