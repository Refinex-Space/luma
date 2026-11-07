//! Resolution against a hermetic miniature JDK written as sources (the model treats source and
//! class-path classes alike), so the tests need no installed JDK.

use super::*;
use crate::classpath::ClassPath;
use ide_index::testing::JavaSources;

const MINI_JDK: &[(&str, &str)] = &[
    (
        "java/lang/Object.java",
        "package java.lang; public class Object { public boolean equals(Object o) { return false; } public int hashCode() { return 0; } public String toString() { return null; } public final Class<?> getClass() { return null; } }",
    ),
    (
        "java/lang/String.java",
        "package java.lang; public final class String implements CharSequence, Comparable<String> { public int length() { return 0; } public String trim() { return this; } public boolean isEmpty() { return false; } public char charAt(int i) { return 0; } public static String valueOf(Object o) { return null; } public static String valueOf(int i) { return null; } public static String valueOf(char c) { return null; } public static String format(String f, Object... args) { return null; } }",
    ),
    ("java/lang/CharSequence.java", "package java.lang; public interface CharSequence { int length(); }"),
    ("java/lang/Comparable.java", "package java.lang; public interface Comparable<T> { int compareTo(T o); }"),
    (
        "java/lang/Number.java",
        "package java.lang; public abstract class Number { public abstract int intValue(); public long longValue() { return 0; } }",
    ),
    (
        "java/lang/Integer.java",
        "package java.lang; public final class Integer extends Number implements Comparable<Integer> { public static Integer valueOf(int i) { return null; } public int intValue() { return 0; } public static int parseInt(String s) { return 0; } }",
    ),
    (
        "java/lang/Long.java",
        "package java.lang; public final class Long extends Number { public int intValue() { return 0; } }",
    ),
    (
        "java/lang/Boolean.java",
        "package java.lang; public final class Boolean { public boolean booleanValue() { return false; } }",
    ),
    (
        "java/lang/Iterable.java",
        "package java.lang; public interface Iterable<T> { java.util.Iterator<T> iterator(); }",
    ),
    (
        "java/lang/Class.java",
        "package java.lang; public final class Class<T> { public String getName() { return null; } }",
    ),
    (
        "java/lang/Enum.java",
        "package java.lang; public abstract class Enum<E extends Enum<E>> implements Comparable<E> { public final String name() { return null; } public final int ordinal() { return 0; } }",
    ),
    ("java/lang/Record.java", "package java.lang; public abstract class Record {}"),
    ("java/lang/Runnable.java", "package java.lang; public interface Runnable { void run(); }"),
    (
        "java/lang/Throwable.java",
        "package java.lang; public class Throwable { public String getMessage() { return null; } }",
    ),
    ("java/lang/Exception.java", "package java.lang; public class Exception extends Throwable {}"),
    ("java/lang/RuntimeException.java", "package java.lang; public class RuntimeException extends Exception {}"),
    (
        "java/lang/System.java",
        "package java.lang; public final class System { public static final java.io.PrintStream out = null; }",
    ),
    (
        "java/io/PrintStream.java",
        "package java.io; public class PrintStream { public void println(String s) {} public void println(Object o) {} public void println(int i) {} }",
    ),
    ("java/util/Iterator.java", "package java.util; public interface Iterator<E> { boolean hasNext(); E next(); }"),
    (
        "java/util/Collection.java",
        "package java.util; public interface Collection<E> extends Iterable<E> { int size(); boolean add(E e); java.util.stream.Stream<E> stream(); }",
    ),
    (
        "java/util/List.java",
        "package java.util; public interface List<E> extends Collection<E> { E get(int index); boolean equals(Object o); static <E> List<E> of(E... es) { return null; } }",
    ),
    ("java/util/Set.java", "package java.util; public interface Set<E> extends Collection<E> {}"),
    (
        "java/util/ArrayList.java",
        "package java.util; public class ArrayList<E> implements List<E> { public ArrayList() {} public ArrayList(int capacity) {} public ArrayList(Collection<? extends E> c) {} }",
    ),
    (
        "java/util/Map.java",
        "package java.util; public interface Map<K, V> { V get(Object key); V put(K key, V value); Set<Map.Entry<K, V>> entrySet(); interface Entry<K, V> { K getKey(); V getValue(); } }",
    ),
    (
        "java/util/HashMap.java",
        "package java.util; public class HashMap<K, V> implements Map<K, V> { public HashMap() {} }",
    ),
    (
        "java/util/Optional.java",
        "package java.util; public final class Optional<T> { public static <T> Optional<T> of(T value) { return null; } public static <T> Optional<T> empty() { return null; } public T get() { return null; } public <U> Optional<U> map(java.util.function.Function<? super T, ? extends U> mapper) { return null; } public T orElse(T other) { return null; } }",
    ),
    (
        "java/util/Collections.java",
        "package java.util; public class Collections { public static <T> List<T> emptyList() { return null; } }",
    ),
    ("java/lang/annotation/Annotation.java", "package java.lang.annotation; public interface Annotation {}"),
    (
        "java/util/function/Function.java",
        "package java.util.function; public interface Function<T, R> { R apply(T t); default <V> Function<T, V> andThen(Function<? super R, ? extends V> after) { return null; } }",
    ),
    (
        "java/util/function/Consumer.java",
        "package java.util.function; public interface Consumer<T> { void accept(T t); }",
    ),
    ("java/util/function/Supplier.java", "package java.util.function; public interface Supplier<T> { T get(); }"),
    (
        "java/util/function/Predicate.java",
        "package java.util.function; public interface Predicate<T> { boolean test(T t); }",
    ),
    (
        "java/util/stream/Stream.java",
        "package java.util.stream; public interface Stream<T> { <R> Stream<R> map(java.util.function.Function<? super T, ? extends R> mapper); Stream<T> filter(java.util.function.Predicate<? super T> p); void forEach(java.util.function.Consumer<? super T> action); java.util.Optional<T> findFirst(); java.util.List<T> toList(); Stream<T> sorted(java.util.Comparator<? super T> c); <R, A> R collect(Collector<? super T, A, R> collector); }",
    ),
    ("java/util/stream/Collector.java", "package java.util.stream; public interface Collector<T, A, R> {}"),
    (
        "java/util/stream/Collectors.java",
        "package java.util.stream; public final class Collectors { public static <T, K, U> Collector<T, ?, java.util.Map<K, U>> toMap(java.util.function.Function<? super T, ? extends K> k, java.util.function.Function<? super T, ? extends U> v) { return null; } public static <T, K> Collector<T, ?, java.util.Map<K, java.util.List<T>>> groupingBy(java.util.function.Function<? super T, ? extends K> f) { return null; } }",
    ),
    (
        "java/util/function/ToIntFunction.java",
        "package java.util.function; public interface ToIntFunction<T> { int applyAsInt(T value); }",
    ),
    (
        "java/util/Comparator.java",
        "package java.util; public interface Comparator<T> { int compare(T a, T b); static <T> Comparator<T> comparingInt(java.util.function.ToIntFunction<? super T> f) { return null; } default Comparator<T> thenComparing(Comparator<? super T> other) { return null; } default <U extends Comparable<? super U>> Comparator<T> thenComparing(java.util.function.Function<? super T, ? extends U> key) { return null; } }",
    ),
];

const APP: &[(&str, &str)] = &[
    (
        "app/Order.java",
        "package app;\npublic class Order {\n  private String id;\n  int amount;\n  public Order() {}\n  public Order(String id) { this(); this.id = id; }\n  public String getId() { return id; }\n  public int getAmount() { return amount; }\n  public void setAmount(int a) { this.amount = a; }\n  public Order withAmount(int a) { return this; }\n  public Customer customer() { return null; }\n  public enum Status { NEW, PAID }\n  public Status status() { return null; }\n}",
    ),
    (
        "app/Customer.java",
        "package app;\nimport java.util.List;\npublic class Customer { public String name() { return null; } public List<Order> orders() { return null; } }",
    ),
    (
        "app/Service.java",
        "package app;\npublic interface Service { void place(Order o); default void cancel(Order o) {} }",
    ),
    (
        "app/ServiceImpl.java",
        "package app;\npublic class ServiceImpl implements Service { public void place(Order o) {} public void place(Order o, int qty) {} }",
    ),
    (
        "app/Base.java",
        "package app;\npublic class Base { protected int count; public Base(int c) {} public void hook() {} }",
    ),
];

const USE: &str = r#"package app;
import java.util.*;
import java.util.function.*;
import static java.util.Collections.emptyList;

public class Use extends Base {
  private int amount;
  private Map<String, Order> byId = new HashMap<>();

  public Use() { /*24*/super(1); }

  void run(List<Order> orders, ServiceImpl impl, Service svc, Object obj, Unknown u) {
    Order o = new /*12*/Order();
    o./*1*/getId();
    var list = new ArrayList<Order>();
    list./*2*/get(0)./*3*/getAmount();
    for (Order x : orders) x./*4*/getId();
    orders.stream().map(x -> x./*5*/getId()).forEach(s -> s./*6*/trim());
    orders.stream().map(Order::/*7*/getId).forEach(s -> s./*8*/length());
    impl./*9*/place(o);
    impl./*10*/place(o, 2);
    svc./*11*/place(o);
    impl./*31*/cancel(o);
    String./*13*/valueOf(1);
    String./*14*/valueOf(o);
    System./*15*/out./*16*/println(o./*17*/getAmount());
    /*18*/amount = 3;
    this./*19*/amount = 4;
    /*20*/count++;
    List<Order> none = /*21*/emptyList();
    none.get(0)./*22*/getId();
    new Runnable() { public void run() { /*23*/amount++; /*25*/hook(); } };
    if (obj instanceof Order ord && ord./*26*/getAmount() > 0) { ord./*27*/getId(); }
    if (!(obj instanceof Order ord2)) return;
    ord2./*28*/getId();
    for (Map.Entry<String, Order> e : byId.entrySet()) e./*29*/getValue()./*30*/getId();
    u./*32*/foo();
    /*33*/Order typed = null;
    java.util./*34*/List<String> qualified = null;
    switch (o.status()) { case /*35*/PAID -> o.getId(); default -> {} }
    o.getClass()./*36*/getName();
    Optional.of(o).map(Order::getAmount).get()./*37*/intValue();
    o.withAmount(1)./*38*/withAmount(2)./*39*/customer()./*40*/name();
    Function<Order, String> f = x -> x./*41*/getId();
    f./*42*/apply(o)./*43*/trim();
    Supplier<Order> sup = Order::/*44*/new;
    String.format("%s", o)./*45*/trim();
    int amount = 1;
    /*46*/amount++;
    o.customer().orders().stream().filter(p -> p./*47*/getAmount() > 0).findFirst()./*48*/get()./*49*/getId();
    orders./*50*/equals(none);
    o./*51*/equals(o);
  }
}
"#;

fn describe(r: &Resolution, text: &str) -> String {
    match r {
        Resolution::Found(Target::Class(k)) => format!("class {k}"),
        Resolution::Found(Target::Field { class, name }) => format!("field {class}.{name}"),
        Resolution::Found(Target::Method { class, name, desc }) => format!("method {class}.{name}{desc}"),
        Resolution::Found(Target::Local(at)) => {
            let rest = &text[*at..];
            let end = rest.find(|c: char| !(c.is_alphanumeric() || c == '_')).unwrap_or(rest.len());
            format!("local {}", &rest[..end])
        }
        Resolution::Found(Target::Package(p)) => format!("package {p}"),
        Resolution::Found(Target::TypeVar(v)) => format!("typevar {}", v.name),
        Resolution::Missing => "missing".into(),
        Resolution::Builtin => "builtin".into(),
        Resolution::Unknown => "unknown".into(),
    }
}

/// Resolves the identifier after each `/*N*/` marker of `text` (file `rel` among `files`).
fn resolve_all(files: &[(&str, &str)], rel: &str, text: &str) -> Vec<(u32, String)> {
    let mut all: Vec<(&str, &str)> = MINI_JDK.to_vec();
    all.extend_from_slice(files);
    all.push((rel, text));
    let src = JavaSources::new(&all);
    let cp = ClassPath::empty();
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&tree_sitter_java::LANGUAGE.into()).unwrap();
    let tree = parser.parse(text, None).unwrap();
    src.with_view(|view| {
        let model = crate::model::Model::new(view, &cp);
        let fa = FileAnalysis::new(&model, &tree, text, src.file(rel).unwrap());
        let mut out = Vec::new();
        let mut i = 0;
        while let Some(at) = text[i..].find("/*") {
            let start = i + at;
            let end = start + text[start..].find("*/").unwrap() + 2;
            i = end;
            let Ok(n) = text[start + 2..end - 2].parse::<u32>() else { continue };
            let ident = text[end..].find(|c: char| c.is_alphanumeric() || c == '_').unwrap() + end;
            let node = tree.root_node().descendant_for_byte_range(ident, ident).unwrap();
            let r = if node.kind() == "super" || node.kind() == "this" {
                fa.call(node.parent().unwrap()).res
            } else if node.parent().is_some_and(|p| {
                p.kind() == "object_creation_expression"
                    || p.parent().is_some_and(|g| g.kind() == "object_creation_expression")
            }) && n == 12
            {
                let mut creation = node;
                while creation.kind() != "object_creation_expression" {
                    creation = creation.parent().unwrap();
                }
                fa.call(creation).res
            } else if node.kind() == "new" {
                fa.method_ref(node.parent().unwrap()).0
            } else {
                fa.resolve(node)
            };
            out.push((n, describe(&r, text)));
        }
        out
    })
}

#[test]
fn resolves_names_members_invocations_and_lambdas() {
    let got = resolve_all(APP, "app/Use.java", USE);
    let expected: &[(u32, &str)] = &[
        (24, "method app/Base.<init>(int)"),
        (12, "method app/Order.<init>()"),
        (1, "method app/Order.getId()"),
        (2, "method java/util/List.get(int)"),
        (3, "method app/Order.getAmount()"),
        (4, "method app/Order.getId()"),
        (5, "method app/Order.getId()"),
        (6, "method java/lang/String.trim()"),
        (7, "method app/Order.getId()"),
        (8, "method java/lang/String.length()"),
        (9, "method app/ServiceImpl.place(app.Order)"),
        (10, "method app/ServiceImpl.place(app.Order,int)"),
        (11, "method app/Service.place(app.Order)"),
        (31, "method app/Service.cancel(app.Order)"),
        (13, "method java/lang/String.valueOf(int)"),
        (14, "method java/lang/String.valueOf(java.lang.Object)"),
        (15, "field java/lang/System.out"),
        (16, "method java/io/PrintStream.println(int)"),
        (17, "method app/Order.getAmount()"),
        (18, "field app/Use.amount"),
        (19, "field app/Use.amount"),
        (20, "field app/Base.count"),
        (21, "method java/util/Collections.emptyList()"),
        (22, "method app/Order.getId()"),
        (23, "field app/Use.amount"),
        (25, "method app/Base.hook()"),
        (26, "method app/Order.getAmount()"),
        (27, "method app/Order.getId()"),
        (28, "method app/Order.getId()"),
        (29, "method java/util/Map$Entry.getValue()"),
        (30, "method app/Order.getId()"),
        (32, "unknown"),
        (33, "class app/Order"),
        (34, "class java/util/List"),
        (35, "field app/Order$Status.PAID"),
        (36, "method java/lang/Class.getName()"),
        (37, "method java/lang/Integer.intValue()"),
        (38, "method app/Order.withAmount(int)"),
        (39, "method app/Order.customer()"),
        (40, "method app/Customer.name()"),
        (41, "method app/Order.getId()"),
        (42, "method java/util/function/Function.apply(java.lang.Object)"),
        (43, "method java/lang/String.trim()"),
        (44, "method app/Order.<init>()"),
        (45, "method java/lang/String.trim()"),
        (46, "local amount"),
        (47, "method app/Order.getAmount()"),
        (48, "method java/util/Optional.get()"),
        (49, "method app/Order.getId()"),
        // An interface's own redeclaration of an Object method, not Object's.
        (50, "method java/util/List.equals(java.lang.Object)"),
        (51, "method java/lang/Object.equals(java.lang.Object)"),
    ];
    let mut failures = Vec::new();
    for (n, want) in expected {
        let have = got.iter().find(|(m, _)| m == n).map(|(_, d)| d.as_str()).unwrap_or("<no marker>");
        if have != *want {
            failures.push(format!("/*{n}*/: expected `{want}`, got `{have}`"));
        }
    }
    assert!(failures.is_empty(), "{} of {} wrong:\n{}", failures.len(), expected.len(), failures.join("\n"));
}

#[test]
fn declarations_name_their_targets() {
    let text = "package app;\npublic class Decl<T> {\n  private int /*1*/count;\n  public /*2*/Decl(int c) {}\n  public <R> R /*3*/map(java.util.function.Function<T, R> f, String... /*4*/names) { int /*5*/x = 0; return null; }\n  record /*6*/Pair(int /*7*/left) {}\n  enum E { /*8*/A }\n}\n";
    let got = resolve_all(&[], "app/Decl.java", text);
    let want = [
        (1, "field app/Decl.count"),
        (2, "method app/Decl.<init>(int)"),
        (3, "method app/Decl.map(java.util.function.Function,java.lang.String[])"),
        (4, "local names"),
        (5, "local x"),
        (6, "class app/Decl$Pair"),
        (7, "field app/Decl$Pair.left"),
        (8, "field app/Decl$E.A"),
    ];
    for (n, w) in want {
        assert_eq!(got.iter().find(|(m, _)| *m == n).unwrap().1, w, "/*{n}*/");
    }
}

#[test]
fn shadowing_and_scopes() {
    let text = r#"package app;
public class Scopes {
  int v;
  static int s;
  void m(int v) {
    /*1*/v++;
    { int w = 1; /*2*/w++; }
    for (int i = 0; /*3*/i < 3; i++) {}
    try (var r = new java.io.PrintStream()) { /*4*/r.println(1); } catch (RuntimeException e) { /*5*/e.getMessage(); }
    Runnable run = () -> { int v2 = /*6*/v; };
    java.util.function.Function<String, Integer> len = (String str) -> /*7*/str.length();
    new Object() { int v; void k() { /*8*/v++; } };
    /*9*/s = 1;
    Scopes./*10*/s = 2;
    this./*11*/v = 3;
  }
}
"#;
    let files = [
        (
            "java/io/PrintStream.java",
            "package java.io; public class PrintStream implements AutoCloseable { public void println(int i) {} public void close() {} }",
        ),
        ("java/lang/AutoCloseable.java", "package java.lang; public interface AutoCloseable { void close(); }"),
    ];
    let got = resolve_all(&files, "app/Scopes.java", text);
    let want = [
        (1, "local v"),
        (2, "local w"),
        (3, "local i"),
        (4, "local r"),
        (5, "local e"),
        (6, "local v"),
        (7, "local str"),
        (8, "field app/Scopes$#2.v"),
        (9, "field app/Scopes.s"),
        (10, "field app/Scopes.s"),
        (11, "field app/Scopes.v"),
    ];
    let mut failures = Vec::new();
    for (n, w) in want {
        let have = &got.iter().find(|(m, _)| *m == n).unwrap().1;
        if !(have == w || (n == 8 && have.starts_with("field app/Scopes$#") && have.ends_with(".v"))) {
            failures.push(format!("/*{n}*/: expected `{w}`, got `{have}`"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// Usages of the declaration named at `/*decl*/` in `rel`, over every file (rel, count, undecided).
fn usages_of(files: &[(&str, &str)], decl_file: &str, accessors: bool) -> Vec<(String, usize, usize)> {
    let mut all: Vec<(&str, &str)> = MINI_JDK.to_vec();
    all.extend_from_slice(files);
    let src = JavaSources::new(&all);
    let cp = ClassPath::empty();
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&tree_sitter_java::LANGUAGE.into()).unwrap();
    src.with_view(|view| {
        let model = crate::model::Model::new(view, &cp);
        let decl_text = files.iter().find(|(r, _)| *r == decl_file).unwrap().1;
        let tree = parser.parse(decl_text, None).unwrap();
        let fa = FileAnalysis::new(&model, &tree, decl_text, src.file(decl_file).unwrap());
        let at = decl_text.find("/*decl*/").unwrap() + "/*decl*/".len();
        let node = tree.root_node().descendant_for_byte_range(at, at).unwrap();
        let target = fa.declared_target(node).expect("a declaration");
        let q = crate::search::UsageQuery::new(&model, &target, accessors);
        let mut out = Vec::new();
        for (rel, text) in files {
            let tree = parser.parse(text, None).unwrap();
            let fa = FileAnalysis::new(&model, &tree, text, src.file(rel).unwrap());
            let u = fa.usages(&q);
            if !u.usages.is_empty() || !u.undecided.is_empty() {
                out.push(((*rel).to_owned(), u.usages.len(), u.undecided.len()));
            }
        }
        out
    })
}

#[test]
fn method_usages_count_the_override_family_like_idea() {
    let files = [
        ("s/Service.java", "package s; public interface Service { void place(String o); }"),
        (
            "s/Impl.java",
            "package s; public class Impl implements Service { public void /*decl*/place(String o) {} public void place(String o, int n) {} }",
        ),
        ("s/Other.java", "package s; public class Other implements Service { public void place(String o) {} }"),
        (
            "s/Use.java",
            "package s; class Use { void m(Service s, Impl i, Other o) { s.place(\"a\"); i.place(\"b\"); o.place(\"c\"); i.place(\"d\", 1); } }",
        ),
    ];
    let got = usages_of(&files, "s/Impl.java", false);
    // Every call of the family rooted at Service.place: through the interface and both implementations.
    assert_eq!(got, vec![("s/Use.java".to_owned(), 3, 0)]);
}

#[test]
fn field_usages_with_accessors_constructors_and_classes() {
    let files = [
        (
            "f/Bean.java",
            "package f; public class Bean { private int /*decl*/size; public Bean() { this(1); } public Bean(int s) { size = s; } public int getSize() { return size; } public void setSize(int s) { this.size = s; } }",
        ),
        (
            "f/Use.java",
            "package f; class Use { void m(Bean b) { b.setSize(b.getSize() + 1); java.util.function.Supplier<Bean> s = Bean::new; new Bean(); } }",
        ),
    ];
    let got = usages_of(&files, "f/Bean.java", true);
    assert_eq!(got, vec![("f/Bean.java".to_owned(), 3, 0), ("f/Use.java".to_owned(), 2, 0)]);
    let ctor = [
        ("f/Bean.java", "package f; public class Bean { public /*decl*/Bean() { this(1); } public Bean(int s) {} }"),
        ("f/Sub.java", "package f; class Sub extends Bean { Sub() { super(); } Sub(int x) { } }"),
        (
            "f/Use.java",
            "package f; class Use { void m() { java.util.function.Supplier<Bean> s = Bean::new; new Bean(); new Bean(2); } }",
        ),
    ];
    let got = usages_of(&ctor, "f/Bean.java", false);
    // `super()` explicit, the implicit one of `Sub(int x)` (JDT reports it as an implicit
    // reference), `Bean::new` for a Supplier and `new Bean()`.
    assert_eq!(got, vec![("f/Sub.java".to_owned(), 2, 0), ("f/Use.java".to_owned(), 2, 0)]);
    let class = [
        ("c/Thing.java", "package c; public class /*decl*/Thing { Thing next; }"),
        (
            "c/Use.java",
            "package c; import java.util.List; class Use { List<Thing> all; Thing one = new Thing(); c.Thing q; }",
        ),
    ];
    let got = usages_of(&class, "c/Thing.java", false);
    assert_eq!(got, vec![("c/Thing.java".to_owned(), 1, 0), ("c/Use.java".to_owned(), 4, 0)]);
}

#[test]
fn lombok_members_resolve() {
    let text = r#"package app;
import lombok.*;
import lombok.extern.slf4j.Slf4j;

@Data
@Builder
@Slf4j
class Person {
  private String name;
  private final int age;
  private boolean active;
  private boolean isAdmin;
}

@Value
@With
class Point { int x; int y; }

@RequiredArgsConstructor(staticName = "of")
class Pair { private final String left; private final String right; private String note = ""; }

class Use {
  void m(Person p) {
    p./*1*/getName();
    p./*2*/setName("x");
    p./*3*/getAge();
    p./*4*/isActive();
    p./*5*/isAdmin();
    p./*6*/setAdmin(true);
    p./*7*/setAge(1);
    Person./*8*/builder()./*9*/name("a")./*10*/age(3)./*11*/build()./*12*/getName();
    new Point(1, 2)./*13*/withX(5)./*14*/getY();
    Pair./*15*/of("a", "b");
    Person.log./*16*/toString();
  }
}
"#;
    let got = resolve_all(&[], "app/Use.java", text);
    let want = [
        (1, "method app/Person.getName()"),
        (2, "method app/Person.setName(java.lang.String)"),
        (3, "method app/Person.getAge()"),
        (4, "method app/Person.isActive()"),
        (5, "method app/Person.isAdmin()"),
        (6, "method app/Person.setAdmin(boolean)"),
        // `age` is final: no setter.
        (7, "missing"),
        (8, "method app/Person.builder()"),
        (9, "method app/Person$PersonBuilder.name(java.lang.String)"),
        (10, "method app/Person$PersonBuilder.age(int)"),
        (11, "method app/Person$PersonBuilder.build()"),
        (12, "method app/Person.getName()"),
        (13, "method app/Point.withX(int)"),
        (14, "method app/Point.getY()"),
        (15, "method app/Pair.of(java.lang.String,java.lang.String)"),
        // `log` is an org.slf4j.Logger, not on this class path: its methods are unknown.
        (16, "unknown"),
    ];
    let mut failures = Vec::new();
    for (n, w) in want {
        let have = &got.iter().find(|(m, _)| *m == n).unwrap().1;
        if have != w {
            failures.push(format!("/*{n}*/: expected `{w}`, got `{have}`"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn overloads_told_apart_by_class_literals() {
    let files = [
        ("org/slf4j/Logger.java", "package org.slf4j; public interface Logger { void info(String m); }"),
        (
            "org/slf4j/LoggerFactory.java",
            "package org.slf4j; public final class LoggerFactory { public static Logger getLogger(String name) { return null; } public static Logger getLogger(Class<?> clazz) { return null; } }",
        ),
    ];
    let text = "package app;\nimport org.slf4j.Logger;\nimport org.slf4j.LoggerFactory;\npublic class Svc {\n  private static final Logger log = LoggerFactory./*1*/getLogger(Svc.class);\n  void m() { log./*2*/info(\"x\"); LoggerFactory./*3*/getLogger(\"n\"); }\n}\n";
    let got = resolve_all(&files, "app/Svc.java", text);
    assert_eq!(
        got.iter().find(|(n, _)| *n == 1).unwrap().1,
        "method org/slf4j/LoggerFactory.getLogger(java.lang.Class)"
    );
    assert_eq!(got.iter().find(|(n, _)| *n == 2).unwrap().1, "method org/slf4j/Logger.info(java.lang.String)");
    assert_eq!(
        got.iter().find(|(n, _)| *n == 3).unwrap().1,
        "method org/slf4j/LoggerFactory.getLogger(java.lang.String)"
    );
}

#[test]
fn packages_headers_annotations_patterns_and_method_ref_overloads() {
    let files = [
        ("w/Fn.java", "package w; public interface Fn<T, R> extends java.util.function.Function<T, R> {}"),
        (
            "w/Wrapper.java",
            "package w; public class Wrapper<T> { public Wrapper<T> in(Fn<T, ?> col, java.util.Collection<?> values) { return this; } public Wrapper<T> in(Fn<T, ?> col, Object... values) { return this; } public Wrapper<T> eq(Fn<T, ?> col, Object v) { return this; } public Wrapper<T> eq(boolean c, Fn<T, ?> col, Object v) { return this; } }",
        ),
        ("w/Ann.java", "package w; public @interface Ann { Item[] value(); @interface Item { String name(); } }"),
    ];
    let text = r#"package app;
import w.*;
@Ann({@Ann./*1*/Item(name = "x")})
public class Box</*2*/T> implements Comparable</*3*/T> {
  public int compareTo(T o) { return 0; }
  void m(Object msg, java.util.List<Order> list) {
    java./*4*/util.List./*5*/of(1);
    if (msg instanceof Order /*6*/ord) { ord./*7*/getId(); }
    new Wrapper<Order>()./*8*/eq(Order::getId, 1)./*9*/in(Order::getId, list)./*10*/in(Order::getId, 1, 2);
  }
}
"#;
    let mut all: Vec<(&str, &str)> = APP.to_vec();
    all.extend_from_slice(&files);
    let got2 = resolve_all(&all, "app/Box.java", text);
    let want = [
        (1, "class w/Ann$Item"),
        (2, "typevar T"),
        (3, "typevar T"),
        (4, "package java.util"),
        (5, "method java/util/List.of(java.lang.Object[])"),
        (6, "local ord"),
        (7, "method app/Order.getId()"),
        (8, "method w/Wrapper.eq(w.Fn,java.lang.Object)"),
        (9, "method w/Wrapper.in(w.Fn,java.util.Collection)"),
        (10, "method w/Wrapper.in(w.Fn,java.lang.Object[])"),
    ];
    let mut failures = Vec::new();
    for (n, w) in want {
        let have = &got2.iter().find(|(m, _)| *m == n).unwrap().1;
        if have != w {
            failures.push(format!("/*{n}*/: expected `{w}`, got `{have}`"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn reabstraction_record_members_and_anonymous_protected_constructors() {
    let files = [
        ("n/Node.java", "package n; public abstract class Node { public abstract String toString(); }"),
        ("n/Base.java", "package n; public abstract class Base { protected Base(int x) {} }"),
    ];
    let text = r#"package app;
import n.*;
public class Uses {
  record Rec(int a) {}
  void m(Node node, Rec r) {
    node./*1*/toString();
    r./*2*/equals(r);
    r./*3*/hashCode();
    Object o = new /*4*/Base(1) {};
  }
}
"#;
    let got = resolve_all(&files, "app/Uses.java", text);
    let mut all: Vec<(&str, &str)> = MINI_JDK.to_vec();
    all.extend_from_slice(&files);
    all.push(("app/Uses.java", text));
    let src = JavaSources::new(&all);
    let cp = ClassPath::empty();
    let tree = crate::parse(text).unwrap();
    let ctor = src.with_view(|view| {
        let model = crate::model::Model::new(view, &cp);
        let fa = FileAnalysis::new(&model, &tree, text, src.file("app/Uses.java").unwrap());
        let at = text.find("Base(1)").unwrap();
        let mut n = tree.root_node().descendant_for_byte_range(at, at).unwrap();
        while n.kind() != "object_creation_expression" {
            n = n.parent().unwrap();
        }
        describe(&fa.call(n).res, text)
    });
    assert_eq!(got.iter().find(|(n, _)| *n == 1).unwrap().1, "method n/Node.toString()");
    assert_eq!(got.iter().find(|(n, _)| *n == 2).unwrap().1, "method app/Uses$Rec.equals(java.lang.Object)");
    assert_eq!(got.iter().find(|(n, _)| *n == 3).unwrap().1, "method app/Uses$Rec.hashCode()");
    assert_eq!(ctor, "method n/Base.<init>(int)");
}

#[test]
fn javadoc_references_count_as_usages() {
    let files = [
        (
            "d/Impl.java",
            "package d;\n/** See {@link #place} and {@code place()}. */\npublic class Impl {\n  public void /*decl*/place(String o) {}\n  public void place(String o, int n) {}\n}",
        ),
        (
            "d/Doc.java",
            "package d;\n/**\n * {@link Impl#place(String)} once, {@link d.Impl#place(String, int)} the other,\n * {@linkplain Impl#place(java.lang.String) again}.\n * @see Impl\n */\nclass Doc {}",
        ),
    ];
    let got = usages_of(&files, "d/Impl.java", false);
    // `{@link #place}` (any overload) and the two links with this signature; not `{@code …}`.
    assert_eq!(got, vec![("d/Impl.java".to_owned(), 1, 0), ("d/Doc.java".to_owned(), 2, 0)]);
    let class = [
        ("d/Thing.java", "package d; public class /*decl*/Thing {}"),
        (
            "d/Ref.java",
            "package d;\n/** Makes a {@link Thing}; @throws IllegalStateException never\n * @see d.Thing */\nclass Ref {}",
        ),
    ];
    let got = usages_of(&class, "d/Thing.java", false);
    assert_eq!(got, vec![("d/Ref.java".to_owned(), 2, 0)]);
}

#[test]
fn javadoc_link_to_another_package_with_generic_parameter() {
    let files = [
        (
            "c/agent/Agent.java",
            "package c.agent;\nimport c.model.Pause;\nimport java.util.Map;\npublic class Agent {\n  public String /*decl*/resume(Pause state, Map<String, String> results) { return null; }\n  public String resume(String id) { return null; }\n}",
        ),
        (
            "c/model/Pause.java",
            "package c.model;\n\nimport java.util.List;\n\n/**\n * 快照。\n *\n * <p>通过 {@link c.agent.Agent#resume(Pause, java.util.Map)}\n * 或别的方式恢复。\n */\npublic record Pause(String id, List<String> calls) {}",
        ),
    ];
    let got = usages_of(&files, "c/agent/Agent.java", false);
    assert_eq!(got, vec![("c/model/Pause.java".to_owned(), 1, 0)]);
}

#[test]
fn unknown_types_in_signatures_leave_occurrences_undecided() {
    // `Missing` is on no class path: the signatures that mention it cannot be compared.
    let files = [
        ("u/Agent.java", "package u;\npublic class Agent {\n  public void /*decl*/run(Missing m) {}\n}"),
        ("u/Sub.java", "package u;\npublic class Sub extends Agent {\n  public void run(Missing m) {}\n}"),
        (
            "u/Use.java",
            "package u;\n/** {@link Agent#run(Missing)} */\nclass Use { void m(Sub s, Missing x) { s.run(x); } }",
        ),
    ];
    let got = usages_of(&files, "u/Agent.java", false);
    let use_file = got.iter().find(|(f, _, _)| f == "u/Use.java").unwrap();
    assert!(use_file.2 > 0, "undecided, not counted as none: {got:?}");
}

#[test]
fn javadoc_qualifiers_are_class_usages() {
    let files = [
        (
            "q/Agent.java",
            "package q; public class /*decl*/Agent { public static class Builder { public void name(String n) {} } }",
        ),
        ("q/Doc.java", "package q;\n/** {@link q.Agent.Builder#name(String)} and {@link Agent} */\nclass Doc {}"),
    ];
    let got = usages_of(&files, "q/Agent.java", false);
    assert_eq!(got, vec![("q/Doc.java".to_owned(), 2, 0)]);
}

/// Member completions at `|` of `text` (a dummy identifier is put there, as IDEA does).
fn complete_at(files: &[(&str, &str)], rel: &str, text: &str) -> Option<Vec<String>> {
    let at = text.find('|').unwrap();
    let text = text.replacen('|', "", 1);
    crate::resolve::completion_texts(&text, at).iter().find_map(|t| complete_in(files, rel, t, at))
}

fn complete_in(files: &[(&str, &str)], rel: &str, text: &str, at: usize) -> Option<Vec<String>> {
    let text = text.to_owned();
    let mut all: Vec<(&str, &str)> = MINI_JDK.to_vec();
    all.extend_from_slice(files);
    all.push((rel, &text));
    let src = JavaSources::new(&all);
    let cp = ClassPath::empty();
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&tree_sitter_java::LANGUAGE.into()).unwrap();
    let tree = parser.parse(&text, None).unwrap();
    src.with_view(|view| {
        let model = crate::model::Model::new(view, &cp);
        let fa = FileAnalysis::new(&model, &tree, &text, src.file(rel).unwrap());
        let ident = fa.identifier_at(at)?;
        let items = fa.member_completions(ident)?;
        Some(
            items
                .iter()
                .map(|c| match c.kind {
                    CompletionKind::Method => format!("{}({}):{}@{}", c.name, c.params.join(","), c.ty, c.depth),
                    CompletionKind::Field => format!("{}:{}@{}", c.name, c.ty, c.depth),
                    CompletionKind::Class => format!("class {}", c.name),
                    CompletionKind::Keyword => c.name.clone(),
                })
                .collect(),
        )
    })
}

#[test]
fn member_completion_after_a_qualifier() {
    let files = [
        (
            "a/Order.java",
            "package a; public class Order extends Base { private int secret; public java.util.List<String> lines; public String id() { return null; } public static Order of(String s) { return null; } public String toString() { return null; } public static class Line {} }",
        ),
        (
            "a/Base.java",
            "package a; public class Base { protected long created; void pkg() {} private void hidden() {} }",
        ),
    ];
    // An instance of another package: public and inherited members, no statics, no private or
    // package-private ones; the override of toString() once.
    let got = complete_at(&files, "b/Use.java", "package b; class Use { void m(a.Order o) { o.| } }").unwrap();
    assert!(got.contains(&"id():String@0".to_owned()), "{got:?}");
    assert!(got.contains(&"lines:List<String>@0".to_owned()), "{got:?}");
    assert!(
        got.contains(&"toString():String@0".to_owned())
            && got.iter().filter(|g| g.starts_with("toString")).count() == 1
    );
    assert!(got.contains(&"hashCode():int@2".to_owned()), "{got:?}");
    assert!(
        !got.iter().any(|g| g.starts_with("secret")
            || g.starts_with("of(")
            || g.starts_with("pkg")
            || g.starts_with("hidden")
            || g.starts_with("created")),
        "{got:?}"
    );
    // Generic receivers substitute their type arguments; a partially typed name still completes.
    let got = complete_at(&files, "b/Use.java", "package b; class Use { void m(java.util.List<String> l) { l.ge|; } }")
        .unwrap();
    assert!(
        got.contains(&"get(int):String@0".to_owned()) && got.contains(&"add(String):boolean@1".to_owned()),
        "{got:?}"
    );
    // A type name: statics, member types and `class`.
    let got = complete_at(&files, "b/Use.java", "package b; class Use { void m() { a.Order.| } }").unwrap();
    assert!(
        got.contains(&"of(String):Order@0".to_owned())
            && got.contains(&"class Line".to_owned())
            && got.contains(&"class".to_owned()),
        "{got:?}"
    );
    assert!(!got.iter().any(|g| g.starts_with("id(")), "{got:?}");
    // In the same package, package-private and protected members too.
    let got = complete_at(&files, "a/Use.java", "package a; class Use { void m(Order o) { o.| } }").unwrap();
    assert!(got.contains(&"pkg():void@1".to_owned()) && got.contains(&"created:long@1".to_owned()), "{got:?}");
    // Not a qualified name: nothing from here.
    assert!(complete_at(&files, "b/Use.java", "package b; class Use { void m() { int x = | ; } }").is_none());
}

#[test]
fn lambdas_in_generic_calls_nested_as_arguments() {
    let item = (
        "a/Item.java",
        "package a; public class Item { public String name() { return null; } public int rank() { return 0; } }",
    );
    let boxes = (
        "a/Box.java",
        "package a; public class Box<T> { public static <T> Box<T> wrap(java.util.function.Supplier<T> s) { return null; } public static <D> void using(Box<D> b, java.util.function.Consumer<D> c) {} }",
    );
    let text = "package a;\nimport java.util.*;\nimport java.util.stream.*;\nclass Use {\n  void m(Map<String, String> headers, List<Item> items) {\n    headers.entrySet().stream().sorted(Comparator.comparingInt(e -> e./*1*/getKey().length()));\n    items.stream().collect(Collectors.toMap(i -> i./*2*/name(), i -> i));\n    Comparator.comparingInt((Item c) -> c.rank()).thenComparing(c -> c./*3*/name());\n    Map<String, List<Item>> byName = items.stream().collect(Collectors.groupingBy(Item::name));\n    byName.entrySet().stream().collect(Collectors.toMap(Map.Entry::getKey, x -> x./*4*/getValue().size()));\n    Box.using(Box.wrap(() -> new Item()), d -> d./*5*/name());\n  }\n}\n";
    let got = resolve_all(&[item, boxes], "a/Use.java", text);
    assert_eq!(
        got,
        [
            (1, "method java/util/Map$Entry.getKey()".to_owned()),
            (2, "method a/Item.name()".to_owned()),
            (3, "method a/Item.name()".to_owned()),
            (4, "method java/util/Map$Entry.getValue()".to_owned()),
            (5, "method a/Item.name()".to_owned()),
        ]
    );
}

#[test]
fn record_headers_see_the_records_member_types() {
    let text = "package a;\nimport java.util.*;\npublic record Schema(Map<String, /*1*/Table> tables, /*2*/Kind kind) implements Comparable<Schema> {\n  public record Table(String name) {}\n  public enum Kind { A }\n  public int compareTo(Schema o) { return 0; }\n}\n";
    assert_eq!(
        resolve_all(&[], "a/Schema.java", text),
        [(1, "class a/Schema$Table".to_owned()), (2, "class a/Schema$Kind".to_owned())]
    );
}
