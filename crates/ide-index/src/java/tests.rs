use super::*;
use crate::data::{FileEntry, FileRecord};
use ide_core::LanguageId;
use ide_language::Syntax;
use std::path::{Path, PathBuf};

fn stub(text: &str) -> JavaStub {
    Syntax::new().with_parsed(&LanguageId::new("java"), text, &|| false, |p| extract(p.tree, p.text)).unwrap()
}

/// An index of `files` (`rel`, text) under `/p`.
fn index(files: &[(&str, &str)]) -> IndexData {
    let mut d = IndexData::default();
    for (rel, text) in files {
        let record = FileRecord { java: Some(stub(text)), ..Default::default() };
        d.insert(FileEntry::new(PathBuf::from("/p").join(rel), (*rel).to_owned(), record));
    }
    d
}

fn view<'a>(d: &'a IndexData, path: &str, stub: &'a JavaStub) -> JavaView<'a> {
    JavaView::new(d, Some(Overlay { file: d.slot(Path::new(path)), stub }))
}

fn summary(m: &JavaMarkers) -> Vec<String> {
    m.markers
        .iter()
        .map(|m| {
            let mut owners: Vec<&str> = m.targets.iter().map(|t| t.owner.as_str()).collect();
            owners.sort();
            format!("{}:{} {:?} {}", m.line, m.name, m.kind, owners.join(","))
        })
        .collect()
}

#[test]
fn extracts_declarations_signatures_and_words() {
    let s = stub(
        r#"package a.b;
import java.util.List;
import static java.util.Map.entry;
import a.c.*;
/** Shape {@link Other} */
@Deprecated
public abstract class Shape<T extends Comparable<T>> extends Base<T> implements java.io.Serializable, Outer.Inner<String> {
    private static final String NAME = "shape"; // comment words ignored
    protected int x, y;
    public Shape(int x, String... names) { this.x = x; }
    abstract <R> R accept(Visitor<? super T, R> v, List<String>[] lists, int[][] grid);
    static class Nested {}
    interface Visitor<T, R> { R visit(T t); default void done() {} }
    enum Kind { CIRCLE { @Override public String toString() { return "c"; } }, SQUARE }
    record Point(int x, int y) implements Comparable<Point> { public int compareTo(Point o) { return 0; } }
    void run() {
        class Local implements Runnable { public void run() {} }
        Runnable r = new Runnable() { @Override public void run() {} };
    }
}
"#,
    );
    assert_eq!(s.package, "a.b");
    assert_eq!(
        s.imports.iter().map(|i| (i.path.as_str(), i.is_static, i.on_demand)).collect::<Vec<_>>(),
        vec![("java.util.List", false, false), ("java.util.Map.entry", true, false), ("a.c", false, true)]
    );
    assert_eq!(s.imports[0].at.col, 7, "import position: the imported name");
    let shape = &s.types[0];
    assert_eq!((shape.name.as_str(), shape.kind), ("Shape", JavaTypeKind::Class));
    assert!(shape.is(PUBLIC) && shape.is(ABSTRACT));
    assert_eq!(shape.supers, ["Base", "java.io.Serializable", "Outer.Inner"]);
    assert_eq!(shape.type_params, ["T"]);
    assert_eq!(shape.annotations, ["Deprecated"]);
    assert_eq!(shape.at, Pos::new(6, 22));
    let member = |name: &str| shape.members.iter().find(|m| m.name == name).unwrap();
    assert!(member("NAME").is(PRIVATE) && member("NAME").is(STATIC));
    assert_eq!((member("x").kind, member("y").ty.as_str()), (JavaMemberKind::Field, "int"));
    let ctor = shape.members.iter().find(|m| m.kind == JavaMemberKind::Constructor).unwrap();
    assert_eq!(ctor.params, ["int", "String[]"]);
    let accept = member("accept");
    assert_eq!(accept.params, ["Visitor", "List[]", "int[][]"]);
    assert_eq!(accept.type_params, ["R"]);
    assert!(accept.is(ABSTRACT));

    let names: Vec<String> = (0..s.types.len() as u32).map(|i| s.display_name(i)).collect();
    assert_eq!(
        names,
        [
            "Shape",
            "Shape.Nested",
            "Shape.Visitor",
            "Shape.Kind",
            "Shape.Kind (new Kind)",
            "Shape.Point",
            "Local",
            "Shape (new Runnable)"
        ]
    );
    let visitor = &s.types[2];
    assert!(visitor.is(STATIC) && visitor.is(ABSTRACT));
    assert!(visitor.members[0].is(ABSTRACT) && !visitor.members[1].is(ABSTRACT));
    let point = &s.types[5];
    let accessor = point.members.iter().find(|m| m.name == "x" && m.kind == JavaMemberKind::Method).unwrap();
    assert!(accessor.is(PUBLIC) && accessor.params.is_empty());
    assert!(s.types[6].is(LOCAL) && s.types[7].is(ANONYMOUS));
    assert_eq!(s.types[7].supers, ["Runnable"]);
    assert_eq!(s.qualified_name(1), "a.b.Shape.Nested");
    assert_eq!(s.qualified_name(6), "a.b.Shape.Local$");

    assert!(s.words.contains(&"Comparable".to_owned()) && s.words.contains(&"names".to_owned()));
    assert!(!s.words.contains(&"comment".to_owned()), "comments are not code");
    assert!(!s.words.contains(&"shape".to_owned()), "strings are not code");
    // A doc tag's reference is a usage (IDEA's id index records doc tag values as code).
    assert!(s.words.contains(&"Other".to_owned()), "{{@link Other}} names a class");
}

#[test]
fn utf16_columns_and_structure_hash_ignore_bodies() {
    let a = stub("class 名字 { void 方法() { int a = 1; } }");
    assert_eq!(a.types[0].at, Pos::new(0, 6));
    assert_eq!(a.types[0].members[0].at, Pos::new(0, 16));
    let body = stub("class 名字 { void 方法() { int a = 2; foo(); } }");
    assert_eq!(a.structure_hash(), body.structure_hash());
    let signature = stub("class 名字 { void 方法(int x) { int a = 1; } }");
    assert_ne!(a.structure_hash(), signature.structure_hash());
    let moved = stub("\n\nclass 名字 {\n void 方法() { int a = 1; } }");
    assert_eq!(a.structure_hash(), moved.structure_hash(), "positions are not structure");
}

const API: &str = r#"package app.api;
public interface Shape {
    double area();
    default String describe() { return "shape"; }
    interface Visitor { void visit(Shape s); }
}
"#;
const BASE: &str = r#"package app.model;
import app.api.Shape;
public abstract class AbstractShape implements Shape, Comparable<AbstractShape> {
    public String describe() { return "abstract"; }
    public int compareTo(AbstractShape o) { return 0; }
    protected abstract void draw(java.util.List<String> lines);
    @Override public String toString() { return describe(); }
}
"#;
const CIRCLE: &str = r#"package app.model;
public class Circle extends AbstractShape {
    public double area() { return 3.14; }
    protected void draw(java.util.List<String> out) {}
    public String describe() { return "circle"; }
}
"#;
const SQUARE: &str = r#"package app.other;
import app.model.*;
import app.api.Shape;
public final class Square extends AbstractShape implements Shape.Visitor {
    public double area() { return 1; }
    protected void draw(java.util.List<String> lines) {}
    public void visit(Shape s) {}
    void use() { Shape anon = new Shape() { public double area() { return 0; } }; }
}
"#;
const UNRELATED: &str = r#"package app.elsewhere;
class AbstractShape { void draw(java.util.List<String> lines) {} }
class Fake extends AbstractShape { void draw(java.util.List<String> lines) {} }
"#;

fn project() -> IndexData {
    index(&[
        ("api/Shape.java", API),
        ("model/AbstractShape.java", BASE),
        ("model/Circle.java", CIRCLE),
        ("other/Square.java", SQUARE),
        ("elsewhere/AbstractShape.java", UNRELATED),
    ])
}

#[test]
fn resolves_through_imports_package_and_on_demand_imports() {
    let d = project();
    let square = stub(SQUARE);
    let v = view(&d, "/p/other/Square.java", &square);
    let file = v.overlay_file().unwrap();
    let supers = v.supertypes(TypeId { file, ty: 0 });
    let names: Vec<String> = supers
        .iter()
        .map(|r| match r {
            Resolved::Source(id) => v.qualified_name(*id).unwrap(),
            Resolved::External(q) => format!("external {q}"),
        })
        .collect();
    // `app.model.*` brings the model's AbstractShape, not the one of `app.elsewhere`.
    assert_eq!(names, ["app.model.AbstractShape", "app.api.Shape.Visitor"]);
    let base = stub(BASE);
    let v = view(&d, "/p/model/AbstractShape.java", &base);
    let supers = v.supertypes(TypeId { file: v.overlay_file().unwrap(), ty: 0 });
    assert_eq!(supers[1], Resolved::External("java.lang.Comparable".into()));
}

#[test]
fn markers_for_inheritors_and_super_methods_across_files() {
    let d = project();
    let api = stub(API);
    let m = markers(&view(&d, "/p/api/Shape.java", &api), Path::new("/p/api/Shape.java"));
    assert_eq!(
        summary(&m),
        [
            "1:Shape Implemented AbstractShape,Circle,Square,Square (new Shape)",
            "2:area Implemented Circle,Square,Square (new Shape)",
            "3:describe Overridden AbstractShape,Circle",
            "4:Visitor Implemented Square",
            "4:visit Implemented Square",
        ]
    );
    let base = stub(BASE);
    let path = Path::new("/p/model/AbstractShape.java");
    let m = markers(&view(&d, "/p/model/AbstractShape.java", &base), path);
    assert_eq!(
        summary(&m),
        [
            "2:AbstractShape Implemented Circle,Square",
            "3:describe Overridden Circle",
            "3:describe Overriding Shape",
            "5:draw Implemented Circle,Square",
        ]
    );
    // compareTo implements a library interface, toString overrides Object, and draw might be
    // declared by the library supertype Comparable: a server knows.
    let unresolved: Vec<u32> = m.unresolved.iter().map(|p| p.line).collect();
    assert_eq!(unresolved, [4, 5, 6]);
    let target = &m.markers[0].targets[0];
    assert_eq!(target.location.path.0, PathBuf::from("/p/model/Circle.java"));
    assert_eq!(target.location.range.start, Pos::new(1, 13));

    let circle = stub(CIRCLE);
    let m = markers(&view(&d, "/p/model/Circle.java", &circle), Path::new("/p/model/Circle.java"));
    assert_eq!(
        summary(&m),
        ["2:area Implementing Shape", "3:draw Implementing AbstractShape", "4:describe Overriding AbstractShape,Shape"]
    );
    // The unrelated AbstractShape of another package has its own subclass only.
    let other = stub(UNRELATED);
    let m = markers(&view(&d, "/p/elsewhere/AbstractShape.java", &other), Path::new("/p/elsewhere/AbstractShape.java"));
    assert_eq!(
        summary(&m),
        ["1:AbstractShape Overridden Fake", "1:draw Overridden Fake", "2:draw Overriding AbstractShape"]
    );
}

#[test]
fn unsaved_text_replaces_the_indexed_file() {
    let d = project();
    // A new implementation typed but not saved: `Shape` sees it from the edited file only when
    // that file is the overlay; the overlay's own declarations come from its text.
    let edited = SQUARE.replace("public final class Square", "public class Square");
    let s = stub(&edited);
    let m = markers(&view(&d, "/p/other/Square.java", &s), Path::new("/p/other/Square.java"));
    assert_eq!(summary(&m)[0], "4:area Implementing Shape");
    let fresh = stub("package app.other;\npublic class Hexagon extends app.model.Circle {}\n");
    let v = view(&d, "/p/other/Hexagon.java", &fresh);
    assert_eq!(v.overlay_file(), Some(u32::MAX));
    let (supers, external) = v.all_supertypes(TypeId { file: u32::MAX, ty: 0 });
    let names: Vec<String> = supers.iter().map(|&id| v.qualified_name(id).unwrap()).collect();
    assert_eq!(names, ["app.model.Circle", "app.model.AbstractShape", "app.api.Shape"]);
    assert!(external, "Comparable is a library type");
}

#[test]
fn usage_scope_follows_accessibility_and_accessor_names() {
    let d = index(&[
        (
            "a/Bean.java",
            "package a;\npublic class Bean { private String name; int size; public boolean active; public void go() {} private void hidden() {} }\n",
        ),
        ("a/Same.java", "package a;\nclass Same { void f(Bean b) { b.size = b.getName().length(); b.go(); } }\n"),
        ("b/Other.java", "package b;\nclass Other { void f(a.Bean b) { b.go(); b.isActive(); int size = 0; } }\n"),
        ("b/Quiet.java", "package b;\nclass Quiet { }\n"),
    ]);
    let bean = stub(
        "package a;\npublic class Bean { private String name; int size; public boolean active; public void go() {} private void hidden() {} }\n",
    );
    let v = view(&d, "/p/a/Bean.java", &bean);
    let at = |name: &str| bean.types[0].members.iter().find(|m| m.name == name).unwrap().at;
    let files = |s: &UsageScope| s.files.iter().map(|(p, _)| p.to_string_lossy().into_owned()).collect::<Vec<_>>();

    // A private field is used through its accessors elsewhere (`b.getName()`), not by its name.
    let name = usage_scope(&v, at("name")).unwrap();
    assert!(!name.local);
    assert_eq!(name.key, "Bean#name");
    assert_eq!(name.words, ["getName", "isName", "setName"]);
    assert_eq!(files(&name), ["/p/a/Same.java"]);
    let hidden = usage_scope(&v, at("hidden")).unwrap();
    assert!(hidden.local && hidden.files.is_empty(), "a private method: the file only");

    let size = usage_scope(&v, at("size")).unwrap();
    assert_eq!(files(&size), ["/p/a/Same.java"], "package-private: the package only");

    let active = usage_scope(&v, at("active")).unwrap();
    assert!(active.words.contains(&"isActive".to_owned()));
    assert_eq!(files(&active), ["/p/b/Other.java"]);

    let go = usage_scope(&v, at("go")).unwrap();
    assert_eq!(go.key, "Bean#go()");
    assert_eq!(files(&go), ["/p/a/Same.java", "/p/b/Other.java"]);

    let class = usage_scope(&v, bean.types[0].at).unwrap();
    assert_eq!(
        (class.key.as_str(), files(&class)),
        ("Bean", vec!["/p/a/Same.java".to_owned(), "/p/b/Other.java".to_owned()])
    );
    assert!(usage_scope(&v, Pos::new(0, 0)).is_none());
}

#[test]
fn graph_follows_replaced_and_removed_files() {
    let mut d = project();
    let before = d.java.structure;
    let circle_words = d.java.files_with_word("Circle").len();
    assert_eq!(circle_words, 1);
    // Replacing a file with a body-only change keeps the structure hash.
    let record = FileRecord { java: Some(stub(&CIRCLE.replace("3.14", "3.1416"))), ..Default::default() };
    d.insert(FileEntry::new(PathBuf::from("/p/model/Circle.java"), "model/Circle.java".into(), record));
    assert_eq!(d.java.structure, before);
    assert_eq!(d.java.files_with_word("Circle").len(), 1);
    // Dependencies of `area` references: a new `area` overload changes them, a new `perimeter` not.
    let words = vec!["area".to_owned()];
    let area = d.java.dependency_hash(&words);
    let add = |d: &mut IndexData, member: &str| {
        let text = CIRCLE.replace("    public double area()", &format!("    {member}\n    public double area()"));
        let record = FileRecord { java: Some(stub(&text)), ..Default::default() };
        d.insert(FileEntry::new(PathBuf::from("/p/model/Circle.java"), "model/Circle.java".into(), record));
    };
    add(&mut d, "public double perimeter() { return 0; }");
    assert_eq!(d.java.dependency_hash(&words), area);
    add(&mut d, "public double area(int scale) { return 0; }");
    assert_ne!(d.java.dependency_hash(&words), area);
    add(&mut d, "");
    assert_eq!(d.java.dependency_hash(&words), area, "back to the same declarations");
    let rec = d.record(Path::new("/p/model/Circle.java")).unwrap();
    assert!(rec.java.unwrap().words.contains(&"AbstractShape".to_owned()), "words survive persistence");
    d.remove(Path::new("/p/model/Circle.java"));
    assert_ne!(d.java.structure, before);
    assert!(d.java.files_with_word("Circle").is_empty());
    let api = stub(API);
    let m = markers(&view(&d, "/p/api/Shape.java", &api), Path::new("/p/api/Shape.java"));
    assert_eq!(summary(&m)[0], "1:Shape Implemented AbstractShape,Square,Square (new Shape)");
}

#[test]
fn record_components_and_lombok_builders_are_used_by_name() {
    let text = "package a;\n@lombok.Builder public class Order { private String id; public record Line(int qty) {} }\n";
    let d = index(&[
        ("a/Order.java", text),
        ("b/Use.java", "package b;\nclass Use { void f(a.Order.Line l) { a.Order.builder().id(\"1\"); l.qty(); } }\n"),
    ]);
    let order = stub(text);
    let v = view(&d, "/p/a/Order.java", &order);
    let id = usage_scope(&v, order.types[0].members[0].at).unwrap();
    assert!(id.words.contains(&"id".to_owned()), "builder setter id(…)");
    assert_eq!(id.files.len(), 1);
    let qty = usage_scope(&v, order.types[1].members[0].at).unwrap();
    assert_eq!((qty.words.as_slice(), qty.local, qty.files.len()), (&["qty".to_owned()][..], false, 1));
}

#[test]
fn only_processor_annotated_types_may_have_generated_implementations() {
    let d = index(&[]);
    let generated = |text: &str| {
        let s = stub(text);
        let v = view(&d, "/p/M.java", &s);
        implementations_may_be_generated(&v, TypeId { file: v.overlay_file().unwrap(), ty: 0 })
    };
    // MapStruct writes `CarMapperImpl` into generated sources, which are not indexed.
    assert!(generated("import org.mapstruct.Mapper;\n@Mapper public interface CarMapper {}\n"));
    assert!(generated("import org.immutables.value.Value;\n@Value.Immutable abstract class Car {}\n"));
    // MyBatis' `@Mapper` is a proxy, a plain interface, a concrete class: the index is the answer.
    assert!(!generated("import org.apache.ibatis.annotations.Mapper;\n@Mapper public interface CarMapper {}\n"));
    assert!(!generated("import org.mapstruct.Mapper;\npublic interface CarMapper {}\n"));
    assert!(!generated("import org.mapstruct.Mapper;\n@Mapper public class CarMapper {}\n"));
}

#[test]
fn implementations_and_hierarchy_levels() {
    let d = project();
    let names = |targets: Vec<JavaMarkerTarget>| targets.into_iter().map(|t| t.owner).collect::<Vec<_>>();
    let api = stub(API);
    let v = view(&d, "/p/api/Shape.java", &api);
    let path = Path::new("/p/api/Shape.java");
    // On the name, anywhere in it.
    let (shape, none) = declaration_named_at(&v, Pos::new(1, 20)).unwrap();
    assert!(none.is_none());
    assert_eq!(
        names(implementations(&v, path, shape, None)),
        ["AbstractShape", "Circle", "Square", "Square (new Shape)"]
    );
    let (_, area) = declaration_named_at(&v, Pos::new(2, 12)).unwrap();
    assert_eq!(names(implementations(&v, path, shape, area)), ["Circle", "Square", "Square (new Shape)"]);
    // A concrete method lists itself before its overriders.
    let (_, describe) = declaration_named_at(&v, Pos::new(3, 20)).unwrap();
    assert_eq!(names(implementations(&v, path, shape, describe)), ["Shape", "AbstractShape", "Circle"]);
    assert!(declaration_named_at(&v, Pos::new(2, 0)).is_none());

    let subtypes: Vec<String> = subtype_items(&v, path, shape).into_iter().map(|i| i.name).collect();
    assert_eq!(subtypes, ["AbstractShape", "Square (new Shape)"]);
    let (supers, external) = supertype_items(&v, path, shape);
    assert!(supers.is_empty() && !external, "an interface without supertypes");

    let circle = stub(CIRCLE);
    let v = view(&d, "/p/model/Circle.java", &circle);
    let (id, _) = declaration_named_at(&v, Pos::new(1, 14)).unwrap();
    let (supers, external) = supertype_items(&v, Path::new("/p/model/Circle.java"), id);
    assert_eq!((supers[0].name.as_str(), supers[0].package.as_str(), external), ("AbstractShape", "app.model", false));
    let base = stub(BASE);
    let v = view(&d, "/p/model/AbstractShape.java", &base);
    let (id, _) = declaration_named_at(&v, Pos::new(2, 25)).unwrap();
    assert!(supertype_items(&v, Path::new("/p/model/AbstractShape.java"), id).1, "Comparable is a library type");
}

#[test]
fn annotation_arguments_are_kept() {
    let s = stub(
        r##"@ApplicationModule(allowedDependencies = {"orders", "shared::api"})
package shop.billing;

import org.springframework.context.annotation.*;

@Profile({"dev", "!prod"})
@ConditionalOnProperty(prefix = "app.billing", name = "enabled", havingValue = "true", matchIfMissing = true)
@ComponentScan(basePackageClasses = {Billing.class, shop.Shared.class}, lazyInit = true)
@Scope(proxyMode = ScopedProxyMode.TARGET_CLASS)
@RequestMapping(Paths.BASE + "/bills")
class Billing<T> extends Base<T> implements Repository<Bill, Long> {
    @Value("${billing.limit:10}") int limit;
    @Bean(name = {"clock", "systemClock"}, autowireCandidate = false)
    java.util.Optional<java.time.Clock> clock(@Qualifier("utc") Zone z) { return null; }
    @Cacheable(cacheNames = "bills", key = "#id + '-' " + "+ #p1")
    void cached() {}
    @Order(-1) @Nested(@Inner(x = 1)) void nested() {}
}
"##,
    );
    let pkg = &s.package_annotations[0];
    assert_eq!(pkg.name, "ApplicationModule");
    assert_eq!(pkg.arg("allowedDependencies").unwrap().strings(), ["orders", "shared::api"]);
    let AnnotationValue::Str { at, end, .. } = &pkg.arg("allowedDependencies").unwrap().items()[1] else { panic!() };
    assert_eq!((at, end), (&Pos::new(0, 53), &Pos::new(0, 64)), "string contents, without the quotes");

    let t = &s.types[0];
    assert_eq!(t.super_args, vec![vec!["T".to_owned()], vec!["Bill".to_owned(), "Long".to_owned()]]);
    let a = |name: &str| t.annotation_args.iter().find(|a| a.name == name).unwrap();
    assert_eq!(a("Profile").arg("value").unwrap().strings(), ["dev", "!prod"]);
    let cond = a("ConditionalOnProperty");
    assert_eq!(cond.arg("prefix").unwrap().as_str(), Some("app.billing"));
    assert_eq!(cond.arg("matchIfMissing").unwrap().as_bool(), Some(true));
    assert_eq!(a("ComponentScan").arg("basePackageClasses").unwrap().classes(), ["Billing", "shop.Shared"]);
    assert_eq!(a("Scope").arg("proxyMode").unwrap().name_segment(), Some("TARGET_CLASS"));
    assert_eq!(
        a("RequestMapping").arg("value"),
        Some(&AnnotationValue::Concat(vec![
            AnnotationValue::Name("Paths.BASE".into()),
            AnnotationValue::Str { text: "/bills".into(), at: Pos::new(9, 30), end: Pos::new(9, 36) },
        ]))
    );
    assert_eq!(a("Profile").at, Pos::new(5, 0));

    let m = |name: &str| t.members.iter().find(|m| m.name == name).unwrap();
    assert_eq!(m("limit").annotation_args[0].arg("value").unwrap().as_str(), Some("${billing.limit:10}"));
    let bean = &m("clock").annotation_args[0];
    assert_eq!(bean.arg("name").unwrap().strings(), ["clock", "systemClock"]);
    assert_eq!(bean.arg("autowireCandidate").unwrap().as_bool(), Some(false));
    assert_eq!(m("clock").ty_args, ["java.time.Clock"], "type arguments of a return type");
    assert_eq!(m("clock").param_details[0].annotation_args[0].arg("value").unwrap().as_str(), Some("utc"));
    assert_eq!(
        m("cached").annotation_args[0].arg("key").unwrap().as_str(),
        Some("#id + '-' + #p1"),
        "concatenated literals join"
    );
    let nested = &m("nested").annotation_args;
    assert_eq!(nested[0].arg("value"), Some(&AnnotationValue::Num("-1".into())));
    let AnnotationValue::Annotation(inner) = nested[1].arg("value").unwrap() else { panic!() };
    assert_eq!((inner.name.as_str(), inner.arg("x")), ("Inner", Some(&AnnotationValue::Num("1".into()))));
}

#[test]
fn generic_signatures_are_kept_canonically() {
    let s = stub(
        r#"package p;
import java.util.*;
public class Repo<T extends @Valid Comparable<? super T>, ID> extends Base<T> implements Iterable<T>, java.io.Serializable {
    private Map<String, List<? extends T>> index;
    int legacy[], plain;
    public <R extends Number & Comparable<R>> Optional<R> find(@NonNull Map.Entry<ID, ? super R> key, String... names) { return null; }
    public Outer<T>.Inner inner(int[] a, String b[]) { return null; }
    Repo(List<T> items) {}
    record Pair<A>(A left, List<A> rest) {}
    Object x = new Comparator<String>() { public int compare(String a, String b) { return 0; } };
}
interface Store<E> extends Collection<E>, Comparable<Store<E>> {}
enum Color { RED }
"#,
    );
    let repo = &s.types[0];
    assert_eq!(repo.sig.extends.as_deref(), Some("Base<T>"));
    assert_eq!(repo.sig.implements, ["Iterable<T>", "java.io.Serializable"]);
    assert_eq!(
        repo.sig.type_params[0],
        TypeParamText { name: "T".into(), bounds: (vec!["Comparable<? super T>".into()]).into() }
    );
    assert_eq!(repo.sig.type_params[1], TypeParamText { name: "ID".into(), bounds: (vec![]).into() });
    let m = |name: &str| repo.members.iter().find(|m| m.name == name).unwrap();
    assert_eq!(m("index").sig.ty, "Map<String,List<? extends T>>");
    assert_eq!(m("legacy").sig.ty, "int[]");
    assert_eq!(m("plain").sig.ty, "int");
    let find = &m("find").sig;
    assert_eq!(find.ty, "Optional<R>");
    assert_eq!(find.params, ["Map.Entry<ID,? super R>", "String[]"]);
    assert!(find.varargs);
    assert_eq!(find.type_params[0].bounds, ["Number", "Comparable<R>"]);
    let inner = &m("inner").sig;
    assert_eq!(inner.ty, "Outer<T>.Inner");
    assert_eq!(inner.params, ["int[]", "String[]"]);
    assert!(!inner.varargs);
    let ctor = repo.members.iter().find(|m| m.kind == JavaMemberKind::Constructor).unwrap();
    assert_eq!((ctor.sig.ty.as_str(), ctor.sig.params.as_slice()), ("", &["List<T>".to_owned()][..]));
    let pair = s.types.iter().find(|t| t.name == "Pair").unwrap();
    assert_eq!(pair.sig.type_params[0].name, "A");
    let rest: Vec<_> = pair.members.iter().filter(|m| m.name == "rest").map(|m| m.sig.ty.as_str()).collect();
    assert_eq!(rest, ["List<A>", "List<A>"], "the component's field and accessor");
    let anon = s.types.iter().find(|t| t.is(ANONYMOUS)).unwrap();
    assert_eq!(anon.sig.extends.as_deref(), Some("Comparator<String>"));
    let store = s.types.iter().find(|t| t.name == "Store").unwrap();
    assert_eq!(store.sig.extends, None);
    assert_eq!(store.sig.implements, ["Collection<E>", "Comparable<Store<E>>"]);
    let color = s.types.iter().find(|t| t.name == "Color").unwrap();
    assert_eq!(color.members[0].sig.ty, "Color");
}

#[test]
fn doc_comment_references_are_words() {
    let s = stub(
        "package p;\n/** Resumes with {@link a.Agent#resume(Pause, java.util.Map)}; plain prose here.\n * @see Other#stop\n * {@code notAWord()} */\nclass A {}",
    );
    for w in ["Agent", "resume", "Pause", "Map", "Other", "stop"] {
        assert!(s.words.iter().any(|x| x == w), "{w}");
    }
    for w in ["prose", "notAWord", "Resumes"] {
        assert!(!s.words.iter().any(|x| x == w), "{w}");
    }
}

#[test]
fn other_unsaved_files_answer_from_their_text() {
    let d = index(&[
        ("a/Api.java", "package a;\npublic interface Api { void run(); }\n"),
        ("a/Impl.java", "package a;\nclass Impl { }\n"),
        ("b/Use.java", "package b;\nclass Use { }\n"),
        ("old/Gone.java", "package old;\nclass Gone { }\n"),
    ]);
    let api = stub("package a;\npublic interface Api { void run(); }\n");
    // Unsaved: Impl now implements Api; Use calls run(); Gone moved to another package.
    let impl_ = stub("package a;\nclass Impl implements Api { public void run() {} }\n");
    let use_ = stub("package b;\nclass Use { void f(a.Api x) { x.run(); } }\n");
    let gone = stub("package fresh;\nclass Gone { }\n");
    let mut v = view(&d, "/p/a/Api.java", &api);
    let slot = |rel: &str| d.slot(&Path::new("/p").join(rel));
    let before = (v.files_mentioning("run"), v.direct_subtypes(TypeId { file: slot("a/Api.java").unwrap(), ty: 0 }));
    assert_eq!(before.0, [slot("a/Api.java").unwrap()]);
    assert!(before.1.is_empty());
    assert!(v.has_package("old") && !v.has_package("fresh"));
    v.others = vec![
        Overlay { file: slot("a/Impl.java"), stub: &impl_ },
        Overlay { file: slot("b/Use.java"), stub: &use_ },
        Overlay { file: slot("old/Gone.java"), stub: &gone },
    ];
    let mut mentioning = v.files_mentioning("run");
    mentioning.sort();
    let mut expected = vec![slot("a/Api.java").unwrap(), slot("a/Impl.java").unwrap(), slot("b/Use.java").unwrap()];
    expected.sort();
    assert_eq!(mentioning, expected);
    let api_id = TypeId { file: slot("a/Api.java").unwrap(), ty: 0 };
    assert_eq!(v.direct_subtypes(api_id), [TypeId { file: slot("a/Impl.java").unwrap(), ty: 0 }]);
    assert!(v.stub(slot("a/Impl.java").unwrap()).unwrap().types[0].members.iter().any(|m| m.name == "run"));
    assert!(!v.has_package("old") && v.has_package("fresh"));
    assert_eq!(v.types_named("Gone").len(), 1);
    // Usages of run() may now be in the unsaved Impl and Use.
    let at = api.types[0].members[0].at;
    let scope = usage_scope(&v, at).unwrap();
    let files: Vec<String> = scope.files.iter().map(|(p, _)| p.to_string_lossy().into_owned()).collect();
    assert_eq!(files, ["/p/a/Impl.java", "/p/b/Use.java"]);
}

#[test]
fn anonymous_classes_in_bodies_only_change_their_members_dependencies() {
    let base = "package a;\npublic class Use { void m() { int x = 1; } }\n";
    let with_anon =
        "package a;\npublic class Use { void m() { Runnable r = new Runnable() { public void run() {} }; } }\n";
    let other_super =
        "package a;\npublic class Use { void m() { Runnable r = new Thread() { public void run() {} }; } }\n";
    let hash = |text: &str, words: &[&str]| {
        let d = index(&[("a/Use.java", text), ("a/Api.java", "package a;\npublic interface Api { void place(); }\n")]);
        let words: Vec<String> = words.iter().map(|w| (*w).to_owned()).collect();
        d.java.dependency_hash(&words)
    };
    // Counts of `place` do not depend on an anonymous Runnable in a method body…
    assert_eq!(hash(base, &["place"]), hash(with_anon, &["place"]));
    // …counts of `run` do, and on what it extends.
    assert_ne!(hash(base, &["run"]), hash(with_anon, &["run"]));
    assert_ne!(hash(with_anon, &["run"]), hash(other_super, &["run"]));
    // A top-level class still changes every dependency (its name may rebind any reference).
    let extra = "package a;\npublic class Use { void m() { int x = 1; } }\nclass Extra {}\n";
    assert_ne!(hash(base, &["place"]), hash(extra, &["place"]));
}
