// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyDelombok, delombokInput, hasDelombokWork } from "./delombok";

/** Sources and what Lombok 1.18.48's delombok made of them (the backend's format options). */
const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

describe("Delombok input", () => {
  it("keeps only the chosen annotations, and their settings", () => {
    const src = fixture("Person.java");
    const getterOnly = delombokInput(src, "logger");
    expect(getterOnly).toContain("@Slf4j");
    expect(getterOnly).not.toMatch(/@Data|@Builder|@Singular/);
    // @Singular configures @Builder: it stays with it.
    const builder = delombokInput(src, "builder");
    expect(builder).toMatch(/@Builder[\s\S]*@Singular/);
    expect(builder).not.toMatch(/@Data|@Slf4j/);
    expect(delombokInput(src, "all")).toBe(src);
  });

  it("finds work only where the chosen annotations are", () => {
    expect(hasDelombokWork(fixture("Person.java"), "data")).toBe(true);
    expect(hasDelombokWork(fixture("Person.java"), "value")).toBe(false);
    expect(hasDelombokWork("import lombok.*;\n@Getter class A { int x; }", "getter")).toBe(true);
    // Not Lombok's: another library's @Data.
    expect(hasDelombokWork("import org.acme.Data;\n@Data class A {}", "data")).toBe(false);
    expect(hasDelombokWork("@lombok.Data class A {}", "data")).toBe(true);
  });
});

describe("Delombok result", () => {
  it("writes the generated members into the original, keeping its formatting and comments", () => {
    const src = fixture("Person.java");
    const { text, removed, generated } = applyDelombok(src, fixture("Person.delombok.java"), "all");
    // @Slf4j, @Data, @Builder (@Singular went with @Builder).
    expect(removed).toBe(3);
    expect(generated).toBeGreaterThan(5);
    // The rest of the file as written.
    expect(text).toContain("/** A person. */\npublic class Person {");
    expect(text).toContain("    private int age;   // years\n");
    expect(text).toContain('        log.info("hi {}", name); // inline comment\n');
    // Lombok's marks and imports are gone; what it generated is there.
    expect(text).not.toMatch(/@lombok\.Generated|import lombok|@Data|@Builder|@Singular|@Slf4j/);
    expect(text).toContain(
      "public class Person {\n    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(Person.class);\n    // the name",
    );
    expect(text).toContain("\n    public static class PersonBuilder {\n        private String name;");
    expect(text).toContain("\n    public String getName() {\n        return this.name;\n    }\n");
    expect(text).toContain("import java.util.List;");
    expect(text.trimEnd().endsWith("}\n}")).toBe(true);
  });

  it("applies @Value's and @UtilityClass's modifiers to the existing declarations", () => {
    const point = applyDelombok(fixture("Point.java"), fixture("Point.delombok.java"), "all").text;
    expect(point.startsWith("package demo;\n\npublic final class Point {")).toBe(true);
    expect(point).toContain("public final class Point {\n    private final int x;\n    private final int y;");
    expect(point).toContain("    private final String label;");
    expect(point).toMatch(/public Point\(final int x, final int y, final String label\)/);
    expect(point).toContain("    @Override\n    public boolean equals(final Object o) {");
    expect(point).not.toMatch(/import lombok|@Value|@Getter/);

    const util = applyDelombok(fixture("Util.java"), fixture("Util.delombok.java"), "utilityClass").text;
    expect(util).toContain("public final class Util {\n    static int counter;");
    expect(util).toContain("    public static int twice(int a) {");
    expect(util).toContain("    private Util() {\n        throw new UnsupportedOperationException");
    expect(util).not.toContain("UtilityClass");
  });

  it("delomboks one annotation, leaving the others", () => {
    const src = "import lombok.Getter;\nimport lombok.ToString;\n\n@Getter\n@ToString\nclass A {\n\tint x;\n}\n";
    const output =
      "class A {\n    int x;\n\n    @lombok.Generated\n    public int getX() {\n        return this.x;\n    }\n}\n";
    const { text } = applyDelombok(src, output, "getter", "\t");
    expect(text).toBe(
      "import lombok.ToString;\n\n@ToString\nclass A {\n\tint x;\n\n\tpublic int getX() {\n\t\treturn this.x;\n\t}\n}\n",
    );
  });

  it("handles a class on one line and an empty class", () => {
    const output = "class A {\n\n    @lombok.Generated\n    public A() {\n    }\n}\n";
    expect(applyDelombok("@lombok.NoArgsConstructor class A {}", output, "constructors").text).toBe(
      "class A {\n    public A() {\n    }\n}",
    );
  });
});
