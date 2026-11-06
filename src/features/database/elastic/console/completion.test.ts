import { CompletionContext, type Completion, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import type { EsField } from "@/platform/ipc";
import {
  AGG_TYPE_NAMES,
  DSL_SCHEMAS,
  ES_APIS,
  QUERY_CLAUSE_NAMES,
  matchApi,
  nextSegments,
  schemaAt,
  schemaKeys,
} from "./catalog";
import { esConsoleCompletion, jsonContextAt, requestIndex, valueSnippet, type EsCompletion } from "./completion";

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
  F("message", ["text"]),
  F("status", ["keyword"]),
  F("items", ["nested"]),
  F("items.name", ["keyword"]),
  F("user", ["object"]),
  F("user.name", ["keyword"]),
];

const fields = vi.fn(async (_index: string) => FIELDS);
const source = esConsoleCompletion({ indices: () => ["logs", "metrics", ".kibana"], fields });

/** Completion at `|` of `text`. */
async function complete(text: string, explicit = false): Promise<CompletionResult | null> {
  const pos = text.indexOf("|");
  const doc = text.slice(0, pos) + text.slice(pos + 1);
  const state = EditorState.create({ doc, selection: { anchor: pos } });
  return source(new CompletionContext(state, pos, explicit));
}

const labels = (r: CompletionResult | null) => r?.options.map((o) => o.label) ?? [];

describe("catalogue", () => {
  it("covers the common endpoints, each method + path once", () => {
    expect(ES_APIS.length).toBeGreaterThan(100);
    const keys = ES_APIS.flatMap((a) => a.methods.map((m) => `${m} ${a.path}`));
    expect(new Set(keys).size).toBe(keys.length);
    for (const a of ES_APIS) {
      expect(a.summary).not.toBe("");
      if (a.schema) expect(DSL_SCHEMAS[a.schema]).toBeDefined();
      if (a.template && !a.ndjson) expect(() => JSON.parse(a.template!)).not.toThrow();
    }
  });

  it("matches request paths to templates, literals first", () => {
    expect(matchApi("GET", "/logs/_search?size=1")?.path).toBe("{index}/_search");
    expect(matchApi("post", "_search")?.path).toBe("_search");
    expect(matchApi("GET", "_cat/indices")?.path).toBe("_cat/indices");
    expect(matchApi("PUT", "logs")?.path).toBe("{index}");
    expect(matchApi("GET", "_all/_search")?.path).toBe("{index}/_search");
    expect(matchApi("GET", "_ingest/pipeline/_simulate")?.path).toBe("_ingest/pipeline/_simulate");
    expect(matchApi("GET", "_nodes/stats")?.path).toBe("_nodes/stats");
    expect(matchApi("GET", "_nodes/_local/stats")?.path).toBe("_nodes/{node_id}/stats");
    expect(matchApi("PUT", "_cat/indices")).toBeNull();
    expect(matchApi("GET", "_nope")).toBeNull();
    expect([...nextSegments("GET", ["_cat"]).keys()]).toEqual(expect.arrayContaining(["indices", "health", "shards"]));
  });

  it("describes the DSL", () => {
    expect(QUERY_CLAUSE_NAMES).toEqual(
      expect.arrayContaining(["match", "bool", "range", "nested", "knn", "terms_set"]),
    );
    expect(AGG_TYPE_NAMES).toEqual(expect.arrayContaining(["terms", "date_histogram", "composite", "bucket_sort"]));
    const search = DSL_SCHEMAS.search!;
    expect(schemaKeys(schemaAt(search, ["query", "bool"])!).keys.map(([k]) => k)).toEqual([
      "must",
      "should",
      "filter",
      "must_not",
      "minimum_should_match",
      "boost",
    ]);
    // `must` takes a clause or an array of clauses.
    expect(schemaKeys(schemaAt(search, ["query", "bool", "must", "[]"])!).keys.map(([k]) => k)).toContain("match");
    expect(schemaKeys(schemaAt(search, ["query", "bool", "must"])!).keys.map(([k]) => k)).toContain("term");
    expect(schemaKeys(schemaAt(search, ["query", "match"])!).fields).not.toBeNull();
    expect(schemaKeys(schemaAt(search, ["query", "match", "msg"])!).keys.map(([k]) => k)).toContain("operator");
    expect(schemaAt(search, ["nope"])).toBeNull();
    expect(valueSnippet(schemaAt(search, ["query"])!)).toBe("{\n\t${}\n}");
    expect(valueSnippet(schemaAt(search, ["query", "match_all"])!)).toBe("{${}}");
    expect(valueSnippet(schemaAt(search, ["size"])!)).toBe("${}");
    expect(valueSnippet(schemaAt(search, ["sort"])!)).toBe("[${}]");
    expect(valueSnippet(schemaAt(search, ["query", "bool", "must"])!)).toBe("[\n\t{\n\t\t${}\n\t}\n]");
    expect(valueSnippet(schemaAt(search, ["explain"])!)).toBe("${true}");
    expect(valueSnippet(schemaAt(search, ["query", "multi_match", "type"])!)).toBe('"${best_fields}"');
  });
});

describe("jsonContextAt", () => {
  const at = (text: string) => {
    const pos = text.indexOf("|");
    return jsonContextAt(text.slice(0, pos) + text.slice(pos + 1), 0, pos);
  };

  it("finds the key path and whether a key or value is typed", () => {
    expect(at('{"query": {"|')).toEqual({ path: ["query"], at: "key", inString: true, from: 11, prefix: "", root: 0 });
    expect(at('{"query": {"ma|')).toMatchObject({ path: ["query"], at: "key", prefix: "ma" });
    expect(at('{"query": {ma|')).toMatchObject({ path: ["query"], at: "key", inString: false, from: 11, prefix: "ma" });
    expect(at('{"size": 1, "q|')).toMatchObject({ path: [], at: "key", prefix: "q" });
    expect(at('{"aggs": {"a": {"terms": {"field": "st|')).toMatchObject({
      path: ["aggs", "a", "terms", "field"],
      at: "value",
      inString: true,
      prefix: "st",
    });
    expect(at('{"sort": [{"a": "desc"}, {"|')).toMatchObject({ path: ["sort", "[]"], at: "key" });
    expect(at('{"fields": ["a", "|')).toMatchObject({ path: ["fields", "[]"], at: "value", inString: true });
    expect(at('{"explain": t|')).toMatchObject({ path: ["explain"], at: "value", inString: false, prefix: "t" });
    expect(at('{"a": {"b": 1}, "c": {"d": {}, "|')).toMatchObject({ path: ["c"], at: "key" });
  });

  it("is null after values, in comments and outside objects", () => {
    expect(at('{"size": 10 |')).toBeNull();
    expect(at('{"size": 1, # note |')).toBeNull();
    expect(at('{"q": """ab|')).toBeNull();
    expect(at("|")).toBeNull();
    expect(at("{} |")).toBeNull();
  });

  it("counts NDJSON lines", () => {
    expect(at('{"index": "a"}\n{"query": {"|')).toMatchObject({ root: 1, path: ["query"] });
  });
});

describe("esConsoleCompletion", () => {
  it("completes methods at a line start", async () => {
    const r = await complete("G|");
    expect(r?.from).toBe(0);
    expect(labels(r)).toEqual(["GET", "POST", "PUT", "DELETE", "HEAD", "PATCH"]);
    expect(r!.options[0]!.apply).toBe("GET ");
    expect(await complete("|")).toBeNull();
    expect(labels(await complete("GET x\n{}\n\n|", true))).toContain("POST");
    // Between requests after a body, too.
    expect(labels(await complete('GET x\n{"size": 1}\npu|'))).toContain("PUT");
  });

  it("completes path segments: _api words and index names", async () => {
    const root = await complete("GET |");
    expect(root?.from).toBe(4);
    expect(labels(root)).toEqual(expect.arrayContaining(["_search", "_cat", "_cluster", "logs", "metrics", ".kibana"]));
    expect(root!.options.find((o) => o.label === "_cluster")!.apply).toBe("_cluster/");
    expect((root!.options.find((o) => o.label === "logs") as EsCompletion).icon).toBe("db-index");
    expect((root!.options.find((o) => o.label === ".kibana") as EsCompletion).boost).toBe(-1);

    const cat = await complete("GET /_cat/in|");
    expect(cat?.from).toBe(10);
    expect(labels(cat)).toEqual(expect.arrayContaining(["indices", "health", "nodes"]));
    expect(labels(cat)).not.toContain("logs");

    const idx = await complete("POST logs/_|");
    expect(labels(idx)).toEqual(expect.arrayContaining(["_search", "_doc", "_bulk", "_update_by_query"]));
    expect(labels(idx)).not.toContain("_cat");
    expect(idx!.options.find((o) => o.label === "_search")!.info).toContain("Search documents");

    const list = await complete("GET logs,me|");
    expect(list?.from).toBe(9);
    expect(labels(list)).toEqual(["logs", "metrics", ".kibana"]);
    // Index names only where the method has an index endpoint.
    expect(labels(await complete("GET _cat/indices/|"))).toEqual(["logs", "metrics", ".kibana"]);
  });

  it("completes query parameters and their values", async () => {
    const params = await complete("GET _cat/indices?|");
    expect(params?.from).toBe(17);
    expect(labels(params)).toEqual(expect.arrayContaining(["v", "h", "s", "format", "pretty", "filter_path"]));
    expect(params!.options.find((o) => o.label === "v")!.apply).toBe("v");
    expect(params!.options.find((o) => o.label === "h")!.apply).toBe("h=");
    expect(labels(await complete("GET logs/_search?size=1&tr|"))).toContain("track_total_hits");
    const values = await complete("POST _sql?format=|");
    expect(values?.from).toBe(17);
    expect(labels(values)).toContain("txt");
  });

  it("completes top-level search keys and query clauses", async () => {
    const top = await complete('GET logs/_search\n{\n  "|"\n}');
    expect(labels(top)).toEqual(
      expect.arrayContaining(["query", "size", "aggs", "sort", "_source", "track_total_hits"]),
    );
    expect(top!.from).toBe(21);

    const clauses = await complete('GET logs/_search\n{\n  "query": {\n    "|\n  }\n}');
    expect(labels(clauses)).toEqual(expect.arrayContaining(["match", "bool", "range", "term", "nested", "exists"]));

    const must = await complete('POST logs/_count\n{"query": {"bool": {"must": [{"te|');
    expect(labels(must)).toContain("term");
    // Without a quote, after a word typed.
    expect(labels(await complete('GET logs/_search\n{\n  "query": {\n    ma|'))).toContain("match");
  });

  it("completes field names of the request's index as keys", async () => {
    fields.mockClear();
    const r = await complete('GET logs/_search\n{"query": {"match": {"|');
    expect(fields).toHaveBeenCalledWith("logs");
    expect(labels(r)).toEqual(["@timestamp", "_id", "message", "status", "items.name", "user.name"]);
    const status = r!.options.find((o) => o.label === "status") as EsCompletion;
    expect(status).toMatchObject({ icon: "db-column", typeText: "keyword" });
    expect((r!.options.find((o) => o.label === "_id") as EsCompletion).boost).toBe(-2);
    // `_search` without an index asks for all fields.
    await complete('GET _search\n{"query": {"range": {"|');
    expect(fields).toHaveBeenLastCalledWith("*");
    expect(requestIndex("/logs-*,metrics/_search?x")).toBe("logs-*,metrics");
  });

  it("completes aggregation types, their parameters and field values", async () => {
    const types = await complete('GET logs/_search\n{"aggs": {"by_status": {"|');
    expect(labels(types)).toEqual(expect.arrayContaining(["terms", "date_histogram", "avg", "aggs", "meta"]));

    const params = await complete('GET logs/_search\n{"aggs": {"by_status": {"terms": {"|');
    expect(labels(params)).toEqual(expect.arrayContaining(["field", "size", "order", "min_doc_count", "missing"]));

    const values = await complete('GET logs/_search\n{"aggs": {"a": {"terms": {"field": "|"');
    const opts = values!.options as EsCompletion[];
    expect(values!.from).toBe(53);
    const boost = (l: string) => opts.find((o) => o.label === l)!.boost;
    // Aggregatable fields first.
    expect(boost("status")).toBeGreaterThan(boost("message")!);
    expect(opts.find((o) => o.label === "status")!.apply).toBe("status");

    const interval = await complete(
      'GET logs/_search\n{"aggs": {"t": {"date_histogram": {"field": "@timestamp", "calendar_interval": "|"',
    );
    expect(labels(interval)).toEqual(["minute", "hour", "day", "week", "month", "quarter", "year"]);

    const nested = await complete('GET logs/_search\n{"query": {"nested": {"path": "|"');
    expect(labels(nested)).toEqual(["items"]);
  });

  it("completes booleans and quoted enumerations outside strings", async () => {
    expect(labels(await complete('GET logs/_search\n{"explain": t|'))).toEqual(["true", "false"]);
    const sort = await complete('GET logs/_search\n{"query": {"multi_match": {"type": b|');
    expect(sort!.options.find((o) => o.label === "best_fields")!.apply).toBe('"best_fields"');
  });

  it("uses the header schema on even _msearch lines", async () => {
    expect(labels(await complete('GET logs/_msearch\n{"|'))).toContain("preference");
    expect(labels(await complete('GET logs/_msearch\n{}\n{"|'))).toContain("query");
  });

  it("stays quiet without a prefix, in unknown bodies and comments", async () => {
    expect(await complete("GET logs/_search\n{\n  |")).toBeNull();
    expect(await complete('POST logs/_doc\n{\n  "|')).toBeNull();
    expect(await complete('GET logs/_search\n{\n  # "q|')).toBeNull();
    expect(await complete("# GET |")).toBeNull();
  });

  it("inserts a key with a value snippet", async () => {
    const apply = async (text: string, label: string) => {
      const pos = text.indexOf("|");
      const doc = text.slice(0, pos) + text.slice(pos + 1);
      const view = new EditorView({ state: EditorState.create({ doc, selection: { anchor: pos } }) });
      const r = await source(new CompletionContext(view.state, pos, true));
      const option = r!.options.find((o) => o.label === label)! as Completion;
      (option.apply as (v: EditorView, c: Completion, from: number, to: number) => void)(view, option, r!.from, pos);
      const out = view.state.doc.toString();
      view.destroy();
      return out;
    };
    expect(await apply('GET x/_search\n{\n  "qu|"\n}', "query")).toBe('GET x/_search\n{\n  "query": {\n    \n  }\n}');
    expect(await apply("GET x/_search\n{\n  si|\n}", "size")).toBe('GET x/_search\n{\n  "size": \n}');
    expect(await apply('GET x/_search\n{\n  "si|": 10\n}', "size")).toBe('GET x/_search\n{\n  "size": 10\n}');
    expect(await apply('GET x/_search\n{"query": {"match": {"st|', "status")).toBe(
      'GET x/_search\n{"query": {"match": {"status": ""',
    );
  });
});
