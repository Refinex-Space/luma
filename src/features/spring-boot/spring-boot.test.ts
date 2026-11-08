import { describe, expect, it } from "vitest";
import { canonical, propertiesKeyText, yamlKeyEdit } from "./config/insert";
import { hoverMarkdown, propertyDocMarkdown } from "./config/docs";
import type { YamlInsert } from "@/platform/ipc";

/** Applies non-overlapping changes to `doc`. */
function apply(doc: string, changes: Array<{ from: number; to: number; insert: string }>): string {
  let out = doc;
  for (const c of [...changes].sort((a, b) => b.from - a.from)) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}

describe("canonical keys", () => {
  it("relaxes ordinary elements and keeps indexes", () => {
    expect(canonical("spring.datasource[0].Max_Pool-size")).toBe("spring.datasource[0].maxpoolsize");
    expect(canonical("logging.level[org.Foo]")).toBe("logging.level[org.Foo]");
    expect(canonical("server.servlet.contextPath")).toBe(canonical("server.servlet.context-path"));
  });
});

describe("YAML key insertion", () => {
  it("writes nested mappings in place", () => {
    const doc = "server:\n  port: 1\nspring.da";
    const from = doc.lastIndexOf("spring");
    const ctx: YamlInsert = {
      parent: "",
      column: 0,
      indentUnit: 2,
      lineFrom: from,
      lineTo: doc.length,
      paths: [{ key: "server", at: "server:\n  port: 1".length, indent: 2 }],
    };
    const edit = yamlKeyEdit(doc, ctx, from, doc.length, ["spring", "datasource", "url"], "value");
    const out = apply(doc, edit.changes);
    expect(out).toBe("server:\n  port: 1\nspring:\n  datasource:\n    url: ");
    expect(edit.cursor).toBe(out.length);
    expect(edit.retrigger).toBe(true);
  });

  it("merges into a mapping already holding a prefix, removing the typed line", () => {
    const doc = "spring:\n  jpa:\n    show-sql: true\nserver:\n  port: 1\nspring.datasource.u\n";
    const lineFrom = doc.indexOf("spring.datasource");
    const lineTo = doc.length - 1;
    const ctx: YamlInsert = {
      parent: "",
      column: 0,
      indentUnit: 2,
      lineFrom,
      lineTo,
      paths: [
        { key: "spring", at: "spring:\n  jpa:\n    show-sql: true".length, indent: 2 },
        { key: "spring.jpa", at: "spring:\n  jpa:\n    show-sql: true".length, indent: 4 },
        { key: "server", at: "spring:\n  jpa:\n    show-sql: true\nserver:\n  port: 1".length, indent: 2 },
      ],
    };
    const edit = yamlKeyEdit(doc, ctx, lineFrom, lineTo, ["spring", "datasource", "url"], "value");
    const out = apply(doc, edit.changes);
    expect(out).toBe("spring:\n  jpa:\n    show-sql: true\n  datasource:\n    url: \nserver:\n  port: 1\n");
    expect(out.slice(0, edit.cursor).endsWith("    url: ")).toBe(true);
  });

  it("opens sequences and nested keys", () => {
    const doc = "app:\n  t";
    const ctx: YamlInsert = { parent: "app", column: 2, indentUnit: 2, lineFrom: 5, lineTo: doc.length, paths: [] };
    expect(apply(doc, yamlKeyEdit(doc, ctx, 7, doc.length, ["tags"], "list").changes)).toBe("app:\n  tags:\n    - ");
    expect(apply(doc, yamlKeyEdit(doc, ctx, 7, doc.length, ["servers"], "index").changes)).toBe(
      "app:\n  servers:\n    - ",
    );
    expect(apply(doc, yamlKeyEdit(doc, ctx, 7, doc.length, ["map"], "nested").changes)).toBe("app:\n  map:\n    ");
  });

  it("writes properties keys with their separator", () => {
    expect(propertiesKeyText("server.port", "value")).toEqual({ text: "server.port=", retrigger: true });
    expect(propertiesKeyText("logging.level", "nested")).toEqual({ text: "logging.level.", retrigger: true });
    expect(propertiesKeyText("app.servers", "index").text).toBe("app.servers[");
  });
});

describe("documentation", () => {
  it("shows type, default, deprecation and origin", () => {
    const md = propertyDocMarkdown({
      name: "spring.datasource.hikari.maximum-pool-size",
      kind: "property",
      ty: "Integer",
      qualifiedType: "java.lang.Integer",
      default: "10",
      description: "Maximum number of connections.",
      deprecation: { level: "warning", reason: null, replacement: "spring.x.y", since: "3.4.0" },
      sourceType: "com.zaxxer.hikari.HikariConfig",
      sourceMethod: "setMaximumPoolSize()",
      origins: [{ kind: "jar", path: "/r/spring-boot-jdbc-4.1.2.jar" }],
      values: [],
    });
    expect(md).toContain("`Integer`");
    expect(md).toContain("`10`");
    expect(md).toContain("Maximum number of connections.");
    expect(md).toContain("`spring.x.y`");
    expect(md).toContain("HikariConfig#setMaximumPoolSize");
    expect(md).toContain("spring-boot-jdbc-4.1.2.jar");
  });

  it("lists placeholder definitions", () => {
    const md = hoverMarkdown({
      kind: "placeholder",
      key: "app.name",
      definitions: [{ path: "/p/application-dev.yml", line: 2, offset: 0, value: "Demo", profile: "dev" }],
    });
    expect(md).toContain("application-dev.yml:3");
    expect(md).toContain("`Demo`");
  });
});
