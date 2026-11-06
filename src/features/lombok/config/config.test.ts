import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { CONFIG_KEYS } from "./keys";
import { closestKey, configKey, contextAt, keyAt, keyDoc, parseConfig, validateConfig } from "./model";
import { completeConfig, isLombokConfig } from "./index";

const SAMPLE = `# Project defaults
config.stopBubbling = true
clear lombok.anyConstructor.addConstructorProperties
lombok.accessors.chain = true
lombok.copyableAnnotations += org.springframework.beans.factory.annotation.Qualifier
import ../shared/lombok.config
`;

describe("lombok.config keys", () => {
  it("lists every key of the bundled Lombok with its kind and values", () => {
    expect(CONFIG_KEYS.length).toBeGreaterThanOrEqual(80);
    expect(configKey("lombok.accessors.chain")).toMatchObject({ kind: "boolean", values: ["false", "true"] });
    expect(configKey("LOMBOK.LOG.FIELDNAME")?.key).toBe("lombok.log.fieldName");
    expect(configKey("lombok.data.flagUsage")).toMatchObject({ kind: "enum", values: ["WARNING", "ERROR", "ALLOW"] });
    expect(configKey("lombok.copyableAnnotations")).toMatchObject({ kind: "list", example: "<fully.qualified.Type>" });
    expect(configKey("lombok.toString.callSuper")?.default).toBe("skip");
    expect(configKey("checkerframework")?.kind).toBe("other");
  });
});

describe("parsing", () => {
  it("reads directives with their offsets", () => {
    const lines = parseConfig(SAMPLE);
    expect(lines.map((l) => l.kind)).toEqual(["comment", "set", "clear", "set", "set", "import"]);
    const add = lines[4]!;
    expect(add.kind === "set" && [add.key, add.op, add.value]).toEqual([
      "lombok.copyableAnnotations",
      "+=",
      "org.springframework.beans.factory.annotation.Qualifier",
    ]);
    const set = lines[1]!;
    expect(set.kind === "set" && SAMPLE.slice(set.valueFrom, set.valueFrom + set.value.length)).toBe("true");
    expect(set.kind === "set" && SAMPLE.slice(set.opFrom, set.opFrom + 1)).toBe("=");
  });
});

describe("the lombok.config problems inspection", () => {
  it("accepts a valid file", () => {
    expect(validateConfig(SAMPLE)).toEqual([]);
    // Keys and enum / boolean values are case-insensitive, as Lombok reads them.
    expect(validateConfig("LOMBOK.ACCESSORS.CHAIN = TRUE\nlombok.data.flagUsage = warning\n")).toEqual([]);
  });

  it("reports unknown keys with the key meant, wrong values and list operators on single values", () => {
    const text = [
      "lombok.acessors.chain = true",
      "lombok.getter.noIsPrefix = yes",
      "lombok.log.fieldName += logger",
      "lombok.foo.bar.baz.qux = 1",
      "lombok.anyConstructor",
      "lombok.data.flagUsage =",
    ].join("\n");
    const problems = validateConfig(text);
    const at = (p: (typeof problems)[number]) => text.slice(p.from, p.to);
    expect(problems.map((p) => [at(p), p.message])).toEqual([
      ["lombok.acessors.chain", "Unknown key 'lombok.acessors.chain'; did you mean 'lombok.accessors.chain'?"],
      ["yes", "'yes' is not a value of 'lombok.getter.noIsPrefix' (false, true)"],
      ["+=", "'+=' adds to or removes from a list; 'lombok.log.fieldName' takes one value: use '='"],
      ["lombok.foo.bar.baz.qux", "Unknown key 'lombok.foo.bar.baz.qux'"],
      ["lombok.anyConstructor", "Expected 'key = value', 'key += value', 'key -= value', 'clear key' or 'import path'"],
      ["=", "Missing value of 'lombok.data.flagUsage'"],
    ]);
    expect(problems[0]!.replacement).toBe("lombok.accessors.chain");
    expect(closestKey("completely.different")).toBeUndefined();
  });

  it("checks the values of lists of an enum", () => {
    expect(validateConfig("lombok.jacksonized.jacksonVersion += 2\n")).toEqual([]);
    expect(validateConfig("lombok.jacksonized.jacksonVersion += 4\n")[0]?.message).toMatch(/not a value/);
  });
});

describe("completion", () => {
  const complete = (text: string, explicit = false) => {
    const pos = text.indexOf("|");
    const state = EditorState.create({ doc: text.replace("|", "") });
    return completeConfig({ state, pos, explicit });
  };

  it("offers keys, clear and import at the start of a line", () => {
    const r = complete("lombok.acc|");
    expect(r?.from).toBe(0);
    const labels = r!.options.map((o) => o.label);
    expect(labels).toContain("lombok.accessors.chain");
    expect(labels).toContain("clear");
    expect(r!.options.find((o) => o.label === "lombok.copyableAnnotations")?.apply).toBe(
      "lombok.copyableAnnotations += ",
    );
    expect(r!.options.find((o) => o.label === "lombok.accessors.chain")?.apply).toBe("lombok.accessors.chain = ");
    expect(complete("|")).toBeNull();
    expect(complete("|", true)?.options.length).toBeGreaterThan(80);
  });

  it("offers keys after clear, operators after a key and values after the operator", () => {
    expect(complete("clear lombok.lo|")?.from).toBe(6);
    expect(complete("lombok.copyableAnnotations |")!.options.map((o) => o.label)).toEqual(["+=", "-=", "="]);
    expect(complete("lombok.accessors.chain |")!.options.map((o) => o.label)).toEqual(["="]);
    expect(complete("lombok.accessors.chain = t|")!.options.map((o) => o.label)).toEqual(["false", "true"]);
    expect(complete("lombok.toString.callSuper = |")!.options.map((o) => o.label)).toEqual(["CALL", "SKIP", "WARN"]);
    expect(complete("lombok.addNullAnnotations = |")!.options.map((o) => o.label)).toContain("jspecify");
    expect(complete("# lombok.acc|")).toBeNull();
    expect(complete("lombok.log.fieldName = |")).toBeNull();
  });

  it("knows where the caret is", () => {
    expect(contextAt("  lombok.x", 10)).toMatchObject({ kind: "directive", from: 2, typed: "lombok.x" });
    expect(contextAt("lombok.log.fieldName = lo", 25)).toMatchObject({ kind: "value", typed: "lo", from: 23 });
  });
});

describe("Quick Documentation", () => {
  it("describes the key under the pointer", () => {
    const text = "lombok.toString.callSuper = CALL";
    const found = keyAt(text, 10)!;
    expect([found.from, found.to, found.key.key]).toEqual([0, 25, "lombok.toString.callSuper"]);
    expect(keyAt(text, 30)).toBeNull();
    const doc = keyDoc(found.key);
    expect(doc).toContain("**lombok.toString.callSuper**");
    expect(doc).toContain("Values: `CALL` | `SKIP` | `WARN`");
    expect(doc).toContain("Default: `skip`");
  });
});

it("recognizes lombok.config files", () => {
  expect(isLombokConfig({ path: "/p/src/lombok.config", uiMode: null })).toBe(true);
  expect(isLombokConfig({ path: "/p/app.config", uiMode: null })).toBe(false);
  expect(isLombokConfig({ path: "/p/x", uiMode: "Lombok Config" })).toBe(true);
});
