import { describe, expect, it } from "vitest";
import type { EsField } from "@/platform/ipc";
import { kqlCompletions, kqlToDsl, kqlTokens, luceneCompletions, luceneToDsl, luceneTokens } from "./kql";

const F = (name: string, types: string[], extra: Partial<EsField> = {}): EsField => ({
  name,
  types,
  searchable: true,
  aggregatable: !types.includes("text"),
  metadata: false,
  ...extra,
});

const FIELDS: EsField[] = [
  F("@timestamp", ["date"]),
  F("_id", ["_id"], { metadata: true }),
  F("active", ["boolean"]),
  F("bytes", ["long"]),
  F("client.ip", ["ip"]),
  F("items", ["nested"]),
  F("items.name", ["keyword"]),
  F("items.qty", ["integer"]),
  F("message", ["text"]),
  F("message.keyword", ["keyword"]),
  F("status", ["keyword"]),
  F("user.email", ["keyword"]),
  F("user.name", ["keyword"]),
];

/** The DSL of `text` (fails the test on a parse error). */
function dsl(text: string, fields?: readonly EsField[]) {
  const r = kqlToDsl(text, fields);
  if (!r.ok) throw new Error(`${r.error} (${r.from}-${r.to})`);
  return r.query;
}

/** The error of `text`. */
function err(text: string) {
  const r = kqlToDsl(text);
  if (r.ok) throw new Error(`no error for ${text}`);
  return { error: r.error, from: r.from, to: r.to };
}

const free = (query: string) => ({ multi_match: { type: "best_fields", query, lenient: true } });

describe("kqlToDsl", () => {
  it("matches everything when empty", () => {
    expect(dsl("")).toEqual({ match_all: {} });
    expect(dsl("   \n ")).toEqual({ match_all: {} });
    expect(dsl("*")).toEqual({ match_all: {} });
  });

  it("searches free text in all fields", () => {
    expect(dsl("error")).toEqual(free("error"));
    // Unquoted values keep their blanks (one literal), like Kibana.
    expect(dsl("error timeout")).toEqual(free("error timeout"));
    expect(dsl('"connection reset"')).toEqual({
      multi_match: { type: "phrase", query: "connection reset", lenient: true },
    });
    expect(dsl("err*")).toEqual({ query_string: { query: "err*", analyze_wildcard: true, lenient: true } });
    // Words starting like keywords are words.
    expect(dsl("orange")).toEqual(free("orange"));
    expect(dsl("android and notebook")).toEqual({ bool: { filter: [free("android"), free("notebook")] } });
  });

  it("matches field values (match without known fields)", () => {
    expect(dsl("message:hello")).toEqual({ match: { message: "hello" } });
    expect(dsl("message: hello world")).toEqual({ match: { message: "hello world" } });
    expect(dsl('message:"hello world"')).toEqual({ match_phrase: { message: "hello world" } });
    expect(dsl("status : not")).toEqual({ match: { status: "not" } });
    expect(dsl('"my field":x')).toEqual({ match: { "my field": "x" } });
  });

  it("uses term / range by field type when fields are known", () => {
    expect(dsl("message:hello", FIELDS)).toEqual({ match: { message: "hello" } });
    expect(dsl("status:active", FIELDS)).toEqual({ term: { status: "active" } });
    expect(dsl('status:"in progress"', FIELDS)).toEqual({ term: { status: "in progress" } });
    expect(dsl("bytes:200", FIELDS)).toEqual({ term: { bytes: 200 } });
    expect(dsl("active:TRUE", FIELDS)).toEqual({ term: { active: true } });
    expect(dsl("client.ip:10.0.0.0/8", FIELDS)).toEqual({ term: { "client.ip": "10.0.0.0/8" } });
    expect(dsl("@timestamp:2024-01-01", FIELDS)).toEqual({
      range: { "@timestamp": { gte: "2024-01-01", lte: "2024-01-01" } },
    });
    // A field the pattern doesn't know stays a match.
    expect(dsl("other:x", FIELDS)).toEqual({ match: { other: "x" } });
  });

  it("checks existence and wildcards", () => {
    expect(dsl("status:*")).toEqual({ exists: { field: "status" } });
    expect(dsl("message:err*")).toEqual({
      query_string: { fields: ["message"], query: "err*", analyze_wildcard: true },
    });
    expect(dsl("status:err*", FIELDS)).toEqual({ wildcard: { status: { value: "err*" } } });
    expect(dsl("message:a?b*c", FIELDS)).toEqual({
      query_string: { fields: ["message"], query: "a\\?b*c", analyze_wildcard: true },
    });
    expect(dsl("status:a?*", FIELDS)).toEqual({ wildcard: { status: { value: "a\\?*" } } });
  });

  it("reads ranges", () => {
    expect(dsl("bytes > 1000")).toEqual({ range: { bytes: { gt: "1000" } } });
    expect(dsl("bytes>=1000", FIELDS)).toEqual({ range: { bytes: { gte: 1000 } } });
    expect(dsl("bytes < 10", FIELDS)).toEqual({ range: { bytes: { lt: 10 } } });
    expect(dsl("bytes <= 10.5", FIELDS)).toEqual({ range: { bytes: { lte: 10.5 } } });
    expect(dsl('@timestamp < "2024-01-01T00:00:00"', FIELDS)).toEqual({
      range: { "@timestamp": { lt: "2024-01-01T00:00:00" } },
    });
    expect(dsl("@timestamp >= now-1d", FIELDS)).toEqual({ range: { "@timestamp": { gte: "now-1d" } } });
  });

  it("combines with and / or / not by KQL precedence", () => {
    const a = { match: { a: "1" } };
    const b = { match: { b: "2" } };
    const c = { match: { c: "3" } };
    expect(dsl("a:1 and b:2")).toEqual({ bool: { filter: [a, b] } });
    expect(dsl("a:1 or b:2")).toEqual({ bool: { should: [a, b], minimum_should_match: 1 } });
    expect(dsl("not a:1")).toEqual({ bool: { must_not: [a] } });
    expect(dsl("a:1 or b:2 and c:3")).toEqual({
      bool: { should: [a, { bool: { filter: [b, c] } }], minimum_should_match: 1 },
    });
    expect(dsl("(a:1 or b:2) and c:3")).toEqual({
      bool: { filter: [{ bool: { should: [a, b], minimum_should_match: 1 } }, c] },
    });
    expect(dsl("not a:1 and b:2")).toEqual({ bool: { filter: [{ bool: { must_not: [a] } }, b] } });
    expect(dsl("NOT a:1 AnD b:2 OR c:3")).toEqual({
      bool: { should: [{ bool: { filter: [{ bool: { must_not: [a] } }, b] } }, c], minimum_should_match: 1 },
    });
    // Chains flatten into one bool.
    expect(dsl("a:1 and b:2 and c:3")).toEqual({ bool: { filter: [a, b, c] } });
    expect(dsl("a:1 or (b:2 or c:3)")).toEqual({ bool: { should: [a, b, c], minimum_should_match: 1 } });
    expect(dsl("not (a:1 or b:2)")).toEqual({
      bool: { must_not: [{ bool: { should: [a, b], minimum_should_match: 1 } }] },
    });
  });

  it("distributes value lists over their field", () => {
    expect(dsl("status:(active or pending)", FIELDS)).toEqual({
      bool: { should: [{ term: { status: "active" } }, { term: { status: "pending" } }], minimum_should_match: 1 },
    });
    expect(dsl("tags:(a or b and c)")).toEqual({
      bool: {
        should: [{ match: { tags: "a" } }, { bool: { filter: [{ match: { tags: "b" } }, { match: { tags: "c" } }] } }],
        minimum_should_match: 1,
      },
    });
    expect(dsl("tags:(not a)")).toEqual({ bool: { must_not: [{ match: { tags: "a" } }] } });
    expect(dsl('message:("a b" or c*)')).toEqual({
      bool: {
        should: [
          { match_phrase: { message: "a b" } },
          { query_string: { fields: ["message"], query: "c*", analyze_wildcard: true } },
        ],
        minimum_should_match: 1,
      },
    });
  });

  it("builds nested queries for nested fields only", () => {
    expect(dsl("items:{ name:apple and qty > 2 }", FIELDS)).toEqual({
      nested: {
        path: "items",
        query: { bool: { filter: [{ term: { "items.name": "apple" } }, { range: { "items.qty": { gt: 2 } } }] } },
        score_mode: "none",
      },
    });
    // Not nested (or unknown): a dotted path.
    expect(dsl("user:{ name:bob }", FIELDS)).toEqual({ term: { "user.name": "bob" } });
    expect(dsl("user:{ name:bob }")).toEqual({ match: { "user.name": "bob" } });
    expect(err("items:{ apple }").error).toMatch(/field name/);
  });

  it("resolves escapes", () => {
    expect(dsl("message:a\\:b")).toEqual({ match: { message: "a:b" } });
    expect(dsl("message:\\(x\\)")).toEqual({ match: { message: "(x)" } });
    // An escaped `*` is literal, not a wildcard.
    expect(dsl("message:a\\*")).toEqual({ match: { message: "a*" } });
    expect(dsl("message:\\and")).toEqual({ match: { message: "and" } });
    expect(dsl('message:"say \\"hi\\""')).toEqual({ match_phrase: { message: 'say "hi"' } });
    expect(dsl("message:a\\*b*", FIELDS)).toEqual({
      query_string: { fields: ["message"], query: "a\\*b*", analyze_wildcard: true },
    });
  });

  it("expands wildcard field names", () => {
    expect(dsl("user.*:bob")).toEqual({
      query_string: { fields: ["user.*"], query: "bob", analyze_wildcard: true, lenient: true },
    });
    expect(dsl("user.*:bob", FIELDS)).toEqual({
      bool: { should: [{ term: { "user.email": "bob" } }, { term: { "user.name": "bob" } }], minimum_should_match: 1 },
    });
    expect(dsl("user.*:*")).toEqual({ query_string: { query: "_exists_:user.*" } });
    expect(dsl("*:error")).toEqual(free("error"));
  });

  it("reports errors with their range", () => {
    expect(err('message:"abc')).toEqual({ error: "Missing closing quote", from: 8, to: 12 });
    expect(err("(a or b")).toEqual({ error: 'Missing closing ")"', from: 0, to: 1 });
    expect(err("status:")).toEqual({ error: 'Missing value after ":"', from: 6, to: 7 });
    expect(err("(status: )")).toEqual({ error: 'Missing value after ":"', from: 7, to: 8 });
    expect(err("a and")).toEqual({ error: 'Expected a query after "and"', from: 2, to: 5 });
    expect(err("a or ")).toMatchObject({ error: 'Expected a query after "or"', from: 2, to: 4 });
    expect(err("a:1 and not")).toMatchObject({ error: 'Expected a query after "not"', from: 8, to: 11 });
    expect(err("(a or b) and )")).toMatchObject({ error: 'Expected a query after "and"' });
    expect(err("a:1)")).toEqual({ error: 'Unexpected ")"', from: 3, to: 4 });
    expect(err("a:1 not b:2")).toMatchObject({ error: 'Expected "and" or "or" before "not"', from: 4, to: 7 });
    expect(err("()")).toMatchObject({ from: 0, to: 2 });
    expect(err("status:()")).toMatchObject({ error: "Expected a value inside the parentheses" });
    expect(err("status:(a or b")).toMatchObject({ error: 'Missing closing ")"', from: 7, to: 8 });
    expect(err("items:{ name:x")).toMatchObject({ error: 'Missing closing "}"', from: 6, to: 7 });
    expect(err("bytes >")).toMatchObject({ error: 'Expected a value after ">"', from: 6, to: 7 });
    expect(err("bytes >= )")).toMatchObject({ error: 'Expected a value after ">="' });
    expect(err("message:a\\")).toMatchObject({ error: 'Nothing to escape after "\\"', from: 9, to: 10 });
  });
});

describe("luceneToDsl", () => {
  it("wraps the text in query_string", () => {
    expect(luceneToDsl("status:200 AND NOT method:GET")).toEqual({
      query_string: { query: "status:200 AND NOT method:GET", analyze_wildcard: true },
    });
    expect(luceneToDsl("  ")).toEqual({ match_all: {} });
  });
});

describe("kqlTokens", () => {
  const kinds = (text: string) => kqlTokens(text).map((t) => [t.text, t.kind]);

  it("classifies fields, operators, keywords and values", () => {
    expect(kinds("status:active and bytes >= 10")).toEqual([
      ["status", "field"],
      [":", "operator"],
      ["active", "value"],
      ["and", "keyword"],
      ["bytes", "field"],
      [">=", "range"],
      ["10", "value"],
    ]);
    expect(kinds('not ("a b" or message : "x y")')).toEqual([
      ["not", "keyword"],
      ["(", "paren"],
      ["a b", "string"],
      ["or", "keyword"],
      ["message", "field"],
      [":", "operator"],
      ["x y", "string"],
      [")", "paren"],
    ]);
    expect(kqlTokens("a:b").map((t) => [t.from, t.to])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it("never fails on broken input", () => {
    expect(kinds('message:"unclosed')).toEqual([
      ["message", "field"],
      [":", "operator"],
      ["unclosed", "string"],
    ]);
    expect(kinds("a:or")).toEqual([
      ["a", "field"],
      [":", "operator"],
      ["or", "value"],
    ]);
    expect(kinds("items:{ x }").map((t) => t[1])).toEqual(["field", "operator", "paren", "value", "paren"]);
  });
});

describe("kqlCompletions", () => {
  const labels = (r: { options: { label: string }[] }) => r.options.map((o) => o.label);

  it("completes fields where a term starts", () => {
    const r = kqlCompletions("", 0, FIELDS);
    expect(r.from).toBe(0);
    expect(labels(r)).toEqual(expect.arrayContaining(["status", "message", "@timestamp", "not"]));
    expect(r.options.find((o) => o.label === "bytes")).toMatchObject({ icon: "db-column", typeText: "long" });
    expect(kqlCompletions("a:1 and sta", 11, FIELDS)).toMatchObject({ from: 8 });
    expect(kqlCompletions("(sta", 4, FIELDS).from).toBe(1);
  });

  it("offers operators after a field and keywords after a value", () => {
    expect(labels(kqlCompletions("status ", 7, FIELDS))).toEqual([":", ":*", "<", "<=", ">", ">=", "and", "or"]);
    expect(labels(kqlCompletions("unknownword ", 12, FIELDS))).toEqual(["and", "or"]);
    expect(labels(kqlCompletions("status:a ", 9, FIELDS))).toEqual(["and", "or"]);
    expect(labels(kqlCompletions("(a:1) ", 6, FIELDS))).toEqual(["and", "or"]);
  });

  it("asks for values after a field's operator", () => {
    expect(kqlCompletions("status:", 7, FIELDS)).toEqual({ from: 7, options: [], field: "status" });
    expect(kqlCompletions("status: ac", 10, FIELDS)).toMatchObject({ from: 8, field: "status" });
    expect(kqlCompletions("bytes > ", 8, FIELDS)).toMatchObject({ field: "bytes" });
    expect(kqlCompletions("status:(a or ", 13, FIELDS)).toMatchObject({ from: 13, field: "status" });
    expect(kqlCompletions('status:"in pro', 14, FIELDS)).toMatchObject({ from: 7, field: "status" });
    expect(labels(kqlCompletions("active:", 7, FIELDS))).toEqual(["true", "false"]);
  });

  it("completes sub-fields inside a nested query", () => {
    const r = kqlCompletions("items:{ ", 8, FIELDS);
    expect(labels(r)).toEqual(["name", "qty", "not"]);
    expect(kqlCompletions("items:{ name:", 13, FIELDS)).toMatchObject({ field: "items.name" });
  });
});

describe("Lucene", () => {
  const labels = (r: { options: { label: string }[] }) => r.options.map((o) => o.label);
  const kinds = (text: string) => luceneTokens(text).map((t) => `${t.kind}:${t.text}`);

  it("tokenizes query_string syntax", () => {
    expect(kinds('status:200 AND NOT message:"time out"')).toEqual([
      "field:status",
      "operator::",
      "value:200",
      "keyword:AND",
      "keyword:NOT",
      "field:message",
      "operator::",
      'string:"time out"',
    ]);
    expect(kinds("bytes:[10 TO *] -user\\:x:y^2 || _exists_:ip")).toEqual([
      "field:bytes",
      "operator::",
      "paren:[",
      "value:10",
      "keyword:TO",
      "value:*",
      "paren:]",
      "operator:-",
      "field:user\\:x",
      "operator::",
      "value:y",
      "operator:^2",
      "keyword:||",
      "field:_exists_",
      "operator::",
      "value:ip",
    ]);
    expect(kinds("bytes:>=10 name:/jo.*/~1")).toEqual([
      "field:bytes",
      "operator::>=",
      "value:10",
      "field:name",
      "operator::",
      "string:/jo.*/",
      "operator:~1",
    ]);
    // Broken input still tokenizes.
    expect(kinds('a:"open')).toEqual(["field:a", "operator::", 'string:"open']);
  });

  it("completes fields, then their values", () => {
    const r = luceneCompletions("", 0, FIELDS);
    expect(labels(r)).toEqual(expect.arrayContaining(["status", "message", "_exists_", "NOT"]));
    expect(r.options.find((o) => o.label === "status")?.apply).toBe("status:");
    expect(luceneCompletions("a:1 AND sta", 11, FIELDS).from).toBe(8);
    expect(luceneCompletions("(sta", 4, FIELDS).from).toBe(1);
    expect(luceneCompletions("status:", 7, FIELDS)).toEqual({ from: 7, options: [], field: "status" });
    expect(luceneCompletions("status:ok", 9, FIELDS)).toEqual({ from: 7, options: [], field: "status" });
    expect(luceneCompletions('status:"o', 9, FIELDS)).toEqual({ from: 7, options: [], field: "status" });
    expect(luceneCompletions("status:(a OR ", 13, FIELDS)).toMatchObject({ field: "status" });
    expect(labels(luceneCompletions("active:", 7, FIELDS))).toEqual(["true", "false"]);
  });

  it("offers fields after _exists_, keywords after a term, nothing in a range", () => {
    const exists = luceneCompletions("_exists_:", 9, FIELDS);
    expect(exists.field).toBeUndefined();
    expect(exists.options.find((o) => o.label === "user.name")?.apply).toBe("user.name ");
    const op = labels(luceneCompletions("status:ok ", 10, FIELDS));
    expect(op.slice(0, 3)).toEqual(["AND", "OR", "NOT"]);
    expect(op).toContain("message");
    expect(labels(luceneCompletions("(a:1) ", 6, FIELDS)).slice(0, 3)).toEqual(["AND", "OR", "NOT"]);
    expect(luceneCompletions("bytes:[10 TO ", 13, FIELDS).options).toEqual([]);
    expect(luceneCompletions("bytes:{1", 8, FIELDS).options).toEqual([]);
    expect(labels(luceneCompletions("NOT ", 4, FIELDS))).toContain("status");
  });

  it("escapes field names that need it", () => {
    const r = luceneCompletions("", 0, [F("user-agent", ["keyword"])]);
    expect(r.options[0]!.apply).toBe("user\\-agent:");
  });
});
