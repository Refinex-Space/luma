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
    JavaView { data: d, overlay: Some(Overlay { file: d.slot(Path::new(path)), stub }) }
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
        s.imports,
        vec![
            JavaImport { path: "java.util.List".into(), is_static: false, on_demand: false },
            JavaImport { path: "java.util.Map.entry".into(), is_static: true, on_demand: false },
            JavaImport { path: "a.c".into(), is_static: false, on_demand: true },
        ]
    );
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
    assert!(!s.words.contains(&"Other".to_owned()), "doc comments are not code");
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

mod spring {
    use super::*;

    const FILES: &[(&str, &str)] = &[
        ("shop/Order.java", "package shop;\npublic class Order {}\n"),
        (
            "shop/OrderRepository.java",
            "package shop;\nimport org.springframework.data.jpa.repository.JpaRepository;\npublic interface OrderRepository extends JpaRepository<Order, Long> {}\n",
        ),
        ("shop/pay/PaymentGateway.java", "package shop.pay;\npublic interface PaymentGateway { void pay(); }\n"),
        (
            "shop/pay/AlipayGateway.java",
            "package shop.pay;\nimport org.springframework.stereotype.Service;\n@Service\npublic class AlipayGateway implements PaymentGateway { public void pay() {} }\n",
        ),
        (
            "shop/pay/WechatGateway.java",
            "package shop.pay;\n@org.springframework.stereotype.Service @org.springframework.context.annotation.Primary\npublic class WechatGateway implements PaymentGateway { public void pay() {} }\n",
        ),
        (
            "shop/OrderService.java",
            "package shop;\nimport java.util.List;\nimport lombok.RequiredArgsConstructor;\nimport org.springframework.stereotype.Service;\nimport shop.pay.PaymentGateway;\n@Service\n@RequiredArgsConstructor\npublic class OrderService {\n    private final OrderRepository repo;\n    private final PaymentGateway gateway;\n    private final List<PaymentGateway> gateways;\n    private final String name = \"x\";\n}\n",
        ),
        (
            "shop/NotifyService.java",
            "package shop;\nimport shop.pay.*;\n@org.springframework.stereotype.Component\nclass NotifyService {\n    @Autowired @Qualifier(\"alipayGateway\") private PaymentGateway gateway;\n    @Autowired private PricingService pricing;\n}\n",
        ),
        (
            "shop/AppConfig.java",
            "package shop;\nimport org.springframework.web.client.RestTemplate;\n@Configuration\nclass AppConfig {\n    @Bean RestTemplate restTemplate() { return new RestTemplate(); }\n    @Bean(\"clock\") java.time.Clock systemClock(OrderService orders) { return null; }\n}\n",
        ),
        (
            "shop/ReportController.java",
            "package shop;\nimport org.springframework.web.client.RestTemplate;\n@RestController\nclass ReportController {\n    ReportController(RestTemplate rest, java.time.Clock clock) {}\n}\n",
        ),
        (
            "shop/DomainService.java",
            "package shop;\n@org.springframework.stereotype.Service\npublic @interface DomainService {}\n",
        ),
        ("shop/PricingService.java", "package shop;\n@DomainService\nclass PricingService {}\n"),
    ];

    fn spring_of(rel: &str) -> Vec<String> {
        let d = index(FILES);
        let text = FILES.iter().find(|(r, _)| *r == rel).unwrap().1;
        let s = stub(text);
        let path = format!("/p/{rel}");
        let m = markers(&view(&d, &path, &s), Path::new(&path));
        m.markers
            .iter()
            .filter(|m| matches!(m.kind, JavaMarkerKind::Bean | JavaMarkerKind::Injection))
            .map(|m| {
                let mut owners: Vec<&str> = m.targets.iter().map(|t| t.owner.as_str()).collect();
                owners.sort();
                format!("{}:{} {:?} {}", m.line, m.name, m.kind, owners.join(","))
            })
            .collect()
    }

    #[test]
    fn injection_points_find_their_beans() {
        assert_eq!(
            spring_of("shop/OrderService.java"),
            [
                // Injected into AppConfig.systemClock's parameter.
                "7:OrderService Bean AppConfig.systemClock(orders)",
                "8:repo Injection OrderRepository",
                // Two implementations: the @Primary one.
                "9:gateway Injection WechatGateway",
                // A list receives every implementation.
                "10:gateways Injection AlipayGateway,WechatGateway",
            ]
        );
        assert_eq!(
            spring_of("shop/NotifyService.java"),
            ["4:gateway Injection AlipayGateway", "5:pricing Injection PricingService"],
            "@Qualifier picks by name; a meta-annotated stereotype makes a bean"
        );
        assert_eq!(
            spring_of("shop/ReportController.java"),
            ["4:rest Injection AppConfig.restTemplate(),AppConfig.systemClock()"],
            "constructor parameters on one line share one marker; @Bean methods of library types"
        );
    }

    #[test]
    fn beans_of_the_own_module_come_first() {
        let config = |pkg: &str| {
            format!(
                "package {pkg};\n@Configuration\nclass StoreConfig {{ @Bean io.minio.MinioClient minio() {{ return null; }} }}\n"
            )
        };
        let user = "package a;\n@Service\nclass Upload { @Autowired io.minio.MinioClient minio; }\n";
        let (a_config, b_config) = (config("a"), config("b"));
        let mut d = index(&[
            ("a/src/a/StoreConfig.java", &a_config),
            ("b/src/b/StoreConfig.java", &b_config),
            ("a/src/a/Upload.java", user),
        ]);
        let s = stub(user);
        let owners = |d: &IndexData| {
            let m = markers(&view(d, "/p/a/src/a/Upload.java", &s), Path::new("/p/a/src/a/Upload.java"));
            m.markers
                .iter()
                .flat_map(|m| m.targets.iter().map(|t| t.location.path.0.display().to_string()))
                .collect::<Vec<_>>()
        };
        assert_eq!(owners(&d).len(), 2, "no build files: every module");
        for pom in ["a/pom.xml", "b/pom.xml"] {
            d.insert(FileEntry::new(PathBuf::from("/p").join(pom), pom.into(), FileRecord::default()));
        }
        assert_eq!(owners(&d), ["/p/a/src/a/StoreConfig.java"]);
    }

    #[test]
    fn beans_find_where_they_are_injected() {
        assert_eq!(
            spring_of("shop/pay/WechatGateway.java"),
            ["2:WechatGateway Bean OrderService.gateway,OrderService.gateways"]
        );
        assert_eq!(
            spring_of("shop/pay/AlipayGateway.java"),
            ["3:AlipayGateway Bean NotifyService.gateway,OrderService.gateways"]
        );
        assert_eq!(
            spring_of("shop/AppConfig.java"),
            [
                "4:restTemplate Bean ReportController(rest)",
                "5:systemClock Bean ReportController(clock)",
                "5:orders Injection OrderService",
            ]
        );
        assert_eq!(spring_of("shop/OrderRepository.java"), ["2:OrderRepository Bean OrderService.repo"]);
        // Not Spring code: nothing.
        assert!(spring_of("shop/Order.java").is_empty());
    }
}
