import { describe, expect, it } from "vitest";
import { getterName, lombokProblems, setterName, type ProblemKind } from "./checks";
import { applyLombok, type LombokHandler } from "./refactor";
import { classAt, parseJava } from "./syntax";

const problems = (src: string, kind?: ProblemKind) => lombokProblems(src).filter((p) => !kind || p.kind === kind);
const fix = (src: string, label: string) => {
  const p = lombokProblems(src).find((x) => x.fix.label === label);
  if (!p) throw new Error(`no fix '${label}' in ${lombokProblems(src).map((x) => x.fix.label)}`);
  return p.fix.apply();
};
const refactor = (src: string, handler: LombokHandler, at = src.indexOf("class ")) =>
  applyLombok(src, classAt(parseJava(src), at)!, handler);

describe("Lombok's accessor names", () => {
  it("prefixes is for primitive booleans only, and keeps an is-prefixed boolean field's name", () => {
    expect(getterName("bar", "int")).toBe("getBar");
    expect(getterName("Bar", "Date")).toBe("getBar");
    expect(getterName("active", "boolean")).toBe("isActive");
    expect(getterName("isActive", "boolean")).toBe("isActive");
    expect(getterName("active", "Boolean")).toBe("getActive");
    expect(setterName("isActive", "boolean")).toBe("setActive");
    expect(setterName("name", "String")).toBe("setName");
  });
});

describe("Lombok @Getter may be used", () => {
  const ALL = `public class Foo {
  private int bar;
  private boolean baz;

  public int getBar() {
    return bar;
  }

  public boolean isBaz() {
    return baz;
  }
}`;

  it("reports the class when every field has a trivial getter, and the fix annotates it", () => {
    const p = problems(ALL, "getter");
    expect(p.map((x) => x.message)).toEqual(["Class 'Foo' may use Lombok @Getter"]);
    expect(ALL.slice(p[0]!.from, p[0]!.to)).toBe("Foo");
    expect(fix(ALL, "Use lombok @Getter for 'Foo'")).toBe(`import lombok.Getter;

@Getter
public class Foo {
  private int bar;
  private boolean baz;

}`);
  });

  it("reports single fields, moving the getter's doc comment onto the field", () => {
    const src = `import java.util.Date;

public class MoveJavaDoc {
  private Date creationDate;
  private int fieldWithoutGetter;

  /**
   * Returns The date.
   *
   * It's an instance field.
   *
   * @return The date
   */
  public Date getCreationDate() {
    return this.creationDate;
  }
}`;
    expect(problems(src, "getter").map((x) => x.message)).toEqual(["Field 'creationDate' may have Lombok @Getter"]);
    expect(fix(src, "Use lombok @Getter for 'creationDate'")).toBe(`import lombok.Getter;

import java.util.Date;

public class MoveJavaDoc {
  /**
   * -- GETTER --
   * Returns The date.
   * It's an instance field.
   *
   * @return The date
   */
  @Getter
  private Date creationDate;
  private int fieldWithoutGetter;

}`);
  });

  it("merges into the field's doc comment and splits a multi-variable declaration", () => {
    const merge = `class Foo {
  /**
   * The process date.
   */
  private String processDate;
  private int other;

  /** Returns the date. */
  public String getProcessDate() {
    return processDate;
  }
}`;
    expect(fix(merge, "Use lombok @Getter for 'processDate'")).toContain(`  /**
   * The process date.
   * -- GETTER --
   * Returns the date.
   */
  @Getter
  private String processDate;`);
    const multi = `class Foo {
  private int bar, foo;

  public int getBar() {
    return bar;
  }

}`;
    expect(fix(multi, "Use lombok @Getter for 'bar'")).toBe(`import lombok.Getter;

class Foo {
  @Getter
  private int bar;
  private int foo;

}`);
  });

  it("skips what Lombok would not generate the same way", () => {
    const none = `class Foo {
  private int a;
  private Boolean flag;
  private int b;
  private final int c = 1;
  public int getA() { return a + 1; }
  public Boolean isFlag() { return flag; }
  int getB() { return b; }
  @Override public int getC() { return c; }
  public final int getA2() { return a; }
  public long getB2() { return b; }
  public int getB3() throws Exception { return b; }
}
record R(int x) { public int getX() { return x; } }
interface I { int getY(); }`;
    expect(problems(none, "getter")).toEqual([]);
    // A `Boolean` wrapper is read through `get`.
    expect(
      problems(`class Foo { private Boolean flag; public Boolean getFlag() { return (flag); } }`, "getter"),
    ).toHaveLength(1);
  });

  it("reports static fields one by one and nested classes on their own", () => {
    const src = `class Outer {
  private static char bar;
  private int x;
  public static char getBar() { return bar; }

  static class Inner {
    private String name;
    public String getName() { return Inner.this.name; }
  }
}`;
    expect(problems(src, "getter").map((p) => p.message)).toEqual([
      "Field 'bar' may have Lombok @Getter",
      "Class 'Inner' may use Lombok @Getter",
    ]);
    expect(fix(src, "Use lombok @Getter for 'bar'")).toContain("  @Getter\n  private static char bar;");
  });

  it("only removes the getter when @Data / @Value already generate it, and keeps a lombok.* import", () => {
    const src = `import lombok.*;

@Data
class Foo {
  private int anotherField;
  private int fieldWithoutGetter;

  public int getAnotherField() {
    return anotherField;
  }
}`;
    expect(fix(src, "Use lombok @Getter for 'anotherField'")).toBe(`import lombok.*;

@Data
class Foo {
  private int anotherField;
  private int fieldWithoutGetter;

}`);
  });
});

describe("Lombok @Setter may be used", () => {
  it("reports trivial setters of non-final fields", () => {
    const src = `class Foo {
  private int bar;
  private boolean isBaz;
  private final int fixed = 1;

  public void setBar(int bar) {
    this.bar = bar;
  }

  public void setBaz(final boolean isBaz) {
    this.isBaz = isBaz;
  }

  public void setFixed(int fixed) {
    this.fixed = fixed;
  }
}`;
    expect(problems(src, "setter").map((p) => p.message)).toEqual([
      "Field 'bar' may have Lombok @Setter",
      "Field 'isBaz' may have Lombok @Setter",
    ]);
    expect(fix(src, "Use lombok @Setter for 'bar'")).toContain("  @Setter\n  private int bar;");
    // An overload without @Tolerate: Lombok would generate nothing.
    expect(
      problems(
        `class Foo { private int a; public void setA(int a) { this.a = a; } public void setA(String s) { } }`,
        "setter",
      ),
    ).toEqual([]);
    // `a = a` assigns the parameter to itself.
    expect(problems(`class Foo { private int a; public void setA(int a) { a = a; } }`, "setter")).toEqual([]);
  });
});

describe("@Slf4j", () => {
  const SRC = `import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

class Service {
  private static final Logger LOG1 = LoggerFactory.getLogger(Service.class);

  void foo() {
    LOG1.info("foo() called");
    other.LOG1.info("not ours");
  }
}`;

  it("reports a logger of its own class and replaces it, renaming its uses to log", () => {
    expect(problems(SRC, "logger").map((p) => p.message)).toEqual([
      "Slf4j Logger is defined explicitly. Use Lombok @Slf4j annotation instead.",
    ]);
    expect(fix(SRC, "Replace logger field with @Slf4j annotation")).toBe(`import lombok.extern.slf4j.Slf4j;

@Slf4j
class Service {
  void foo() {
    log.info("foo() called");
    other.LOG1.info("not ours");
  }
}`);
  });

  it("knows qualified and statically imported factories, and ignores other loggers", () => {
    expect(
      problems(`class A { org.slf4j.Logger l = org.slf4j.LoggerFactory.getLogger(A.class); }`, "logger"),
    ).toHaveLength(1);
    expect(
      problems(
        `import org.slf4j.Logger;\nimport static org.slf4j.LoggerFactory.getLogger;\nclass A { Logger l = getLogger(A.class); }`,
        "logger",
      ),
    ).toHaveLength(1);
    expect(problems(`import org.slf4j.*;\nclass A { Logger l = LoggerFactory.getLogger(B.class); }`, "logger")).toEqual(
      [],
    );
    expect(
      problems(`import java.util.logging.Logger;\nclass A { Logger l = Logger.getLogger("a"); }`, "logger"),
    ).toEqual([]);
  });
});

describe("Deprecated Lombok annotations", () => {
  it("offers the current annotation and fixes the import", () => {
    const src = `import lombok.experimental.Builder;
import lombok.experimental.Wither;

@Builder
class A {
  @Wither private final int x;
}`;
    const p = problems(src, "deprecated");
    expect(p.map((x) => [x.severity, x.message])).toEqual([
      [
        "error",
        "Lombok's annotation 'lombok.experimental.Builder' is deprecated and not supported by Lombok plugin anymore. Use 'lombok.Builder' instead.",
      ],
      [
        "error",
        "Lombok's annotation 'lombok.experimental.Wither' is deprecated and not supported by Lombok plugin anymore. Use 'lombok.With' instead.",
      ],
    ]);
    expect(fix(src, "Replace with '@lombok.With'")).toBe(`import lombok.With;
import lombok.experimental.Builder;

@Builder
class A {
  @With private final int x;
}`);
    expect(fix(`@lombok.experimental.Value class A {}`, "Replace with '@lombok.Value'")).toBe(
      "@lombok.Value class A {}",
    );
  });
});

describe("Refactor › Lombok", () => {
  const BEAN = `package demo;

import java.util.Objects;

public class Person {
  private String name;
  private int age;

  public String getName() {
    return name;
  }

  public void setName(String name) {
    this.name = name;
  }

  public int getAge() {
    return age;
  }

  public void setAge(int age) {
    this.age = age;
  }

  @Override
  public boolean equals(Object o) {
    return o instanceof Person p && Objects.equals(name, p.name) && age == p.age;
  }

  @Override
  public int hashCode() {
    return Objects.hash(name, age);
  }

  @Override
  public String toString() {
    return "Person(" + name + ", " + age + ")";
  }
}`;

  it("@Data replaces accessors, equals / hashCode and toString", () => {
    expect(refactor(BEAN, "data")).toBe(`package demo;

import lombok.Data;

import java.util.Objects;

@Data
public class Person {
  private String name;
  private int age;

}`);
  });

  it("@Getter / @ToString / @EqualsAndHashCode each replace only their methods", () => {
    const g = refactor(BEAN, "getter");
    expect(g).toContain("@Getter\npublic class Person");
    expect(g).not.toContain("getName()");
    expect(g).toContain("setName(String name)");
    expect(refactor(BEAN, "toString")).toContain("@ToString\npublic class Person");
    const eq = refactor(BEAN, "equalsAndHashCode");
    expect(eq).not.toContain("hashCode()");
    expect(eq).toContain("import lombok.EqualsAndHashCode;");
  });

  it("annotates fields one by one with their access level when getters differ", () => {
    const src = `class Foo {
  private int a;
  private int b;
  public int getA() { return a; }
  protected int getB() { return b; }
}`;
    expect(refactor(src, "getter")).toBe(`import lombok.AccessLevel;
import lombok.Getter;

class Foo {
  @Getter
  private int a;
  @Getter(AccessLevel.PROTECTED)
  private int b;
}`);
  });

  it("@Log (and friends) picks the annotation of the logger type and renames its uses", () => {
    const src = `import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

class Job {
  private static final Logger LOGGER = LogManager.getLogger(Job.class);

  void run() {
    LOGGER.info("run");
  }
}`;
    expect(refactor(src, "logger")).toBe(`import lombok.extern.log4j.Log4j2;

@Log4j2
class Job {
  void run() {
    log.info("run");
  }
}`);
  });

  it("works on the nested class at the caret", () => {
    const src = `class Outer {
  private int x;
  public int getX() { return x; }
  class Inner {
    private int y;
    public int getY() { return y; }
  }
}`;
    const out = refactor(src, "getter", src.indexOf("class Inner"));
    expect(out).toContain("  @Getter\n  class Inner {");
    expect(out).toContain("public int getX()");
  });
});
