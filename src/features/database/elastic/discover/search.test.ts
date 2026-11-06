import { describe, expect, it } from "vitest";
import type { EsField } from "@/platform/ipc";
import { jsonCopyText, jsonPathText, jsonRows } from "../JsonView";
import { niceMax } from "./Histogram";
import {
  HL_POST,
  HL_PRE,
  MAX_BUCKETS,
  PIT_KEEP_ALIVE,
  aggFieldOf,
  appendFilter,
  chooseInterval,
  effectiveSort,
  esErrorText,
  fieldSections,
  fieldValue,
  flattenSource,
  highlightSegments,
  histogramBody,
  hitsBody,
  hitsLabel,
  parseSearch,
  parseTime,
  parseTopValues,
  resolveRange,
  sampleTopValues,
  sortClause,
  timeFieldOf,
  topValuesBody,
  withTimeRange,
} from "./search";

const f = (name: string, type: string, extra: Partial<EsField> = {}): EsField => ({
  name,
  types: [type],
  searchable: type !== "object",
  aggregatable: !["text", "object"].includes(type),
  metadata: false,
  ...extra,
});
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("the histogram's interval", () => {
  it("is the finest round one giving at most 80 bars, ~40 or more for the quick ranges", () => {
    const cases: Array<[number, string]> = [
      [15 * MIN, "15s"],
      [HOUR, "1m"],
      [DAY, "30m"],
      [7 * DAY, "3h"],
      [30 * DAY, "12h"],
      [365 * DAY, "1w"],
    ];
    for (const [span, value] of cases) {
      const i = chooseInterval(span);
      expect(i.value).toBe(value);
      expect(span / i.ms).toBeLessThanOrEqual(MAX_BUCKETS);
      expect(span / i.ms).toBeGreaterThanOrEqual(40);
    }
  });

  it("uses calendar intervals past a day, and years for decades", () => {
    expect(chooseInterval(365 * DAY)).toMatchObject({ calendar: true, value: "1w" });
    expect(chooseInterval(5 * 365 * DAY)).toMatchObject({ calendar: true, value: "1M" });
    expect(chooseInterval(50 * 365 * DAY)).toMatchObject({ calendar: true, value: "1y" });
    expect(chooseInterval(0).value).toBe("10ms");
  });

  it("rounds the y axis to 1-2-5 steps", () => {
    expect(niceMax(0)).toBe(2);
    expect(niceMax(13)).toBe(20);
    expect(niceMax(42)).toBe(50);
    expect(niceMax(240)).toBe(250);
  });
});

describe("time ranges", () => {
  it("resolves relative, absolute and all-time ranges", () => {
    expect(resolveRange({ kind: "relative", ms: HOUR }, 10 * HOUR)).toEqual({ from: 9 * HOUR, to: 10 * HOUR });
    expect(resolveRange({ kind: "absolute", from: 1, to: 2 }, 99)).toEqual({ from: 1, to: 2 });
    expect(resolveRange({ kind: "all" }, 99)).toBeNull();
  });

  it("parses local times and ISO-8601", () => {
    expect(parseTime("2026-11-05")).toBe(new Date(2026, 10, 5).getTime());
    expect(parseTime("2026-11-05 14:03")).toBe(new Date(2026, 10, 5, 14, 3).getTime());
    expect(parseTime("2026-11-05 14:03:22.12")).toBe(new Date(2026, 10, 5, 14, 3, 22, 120).getTime());
    expect(parseTime("2026-11-05T14:03:22Z")).toBe(Date.UTC(2026, 10, 5, 14, 3, 22));
    expect(parseTime("2026-02-30")).toBeNull();
    expect(parseTime("yesterday")).toBeNull();
  });
});

describe("search bodies", () => {
  const bounds = { from: Date.UTC(2026, 10, 4), to: Date.UTC(2026, 10, 5) };

  it("restricts the query to the time range (match_all drops out)", () => {
    expect(withTimeRange({ match_all: {} }, "@timestamp", bounds)).toEqual({
      bool: {
        filter: [
          {
            range: {
              "@timestamp": {
                gte: "2026-11-04T00:00:00.000Z",
                lte: "2026-11-05T00:00:00.000Z",
                format: "strict_date_optional_time",
              },
            },
          },
        ],
      },
    });
    const q = { term: { level: "error" } };
    expect(withTimeRange(q, "@timestamp", bounds)).toMatchObject({ bool: { must: [q] } });
    expect(withTimeRange(q, null, bounds)).toBe(q);
    expect(withTimeRange(q, "@timestamp", null)).toBe(q);
  });

  it("sorts newest first when time-based, else by score; ties break on _doc", () => {
    expect(effectiveSort([], "@timestamp")).toEqual([{ field: "@timestamp", dir: "desc" }]);
    expect(effectiveSort([], null)).toEqual([{ field: "_score", dir: "desc" }]);
    expect(effectiveSort([{ field: "http.status", dir: "asc" }], "@timestamp")).toEqual([
      { field: "http.status", dir: "asc" },
    ]);
    expect(sortClause([{ field: "@timestamp", dir: "desc" }])).toEqual([
      { "@timestamp": { order: "desc", unmapped_type: "boolean" } },
      { _doc: { order: "asc" } },
    ]);
  });

  it("asks for a page, highlights, the histogram and the next page after the last hit", () => {
    const body = hitsBody({
      query: { match_all: {} },
      sort: [{ field: "@timestamp", dir: "desc" }],
      histogram: { field: "@timestamp", interval: chooseInterval(DAY), ...bounds, timeZone: "UTC" },
    });
    expect(body).toMatchObject({
      size: 100,
      seq_no_primary_term: true,
      highlight: { pre_tags: [HL_PRE], post_tags: [HL_POST], fields: { "*": {} } },
      aggs: {
        histogram: {
          date_histogram: {
            field: "@timestamp",
            fixed_interval: "30m",
            min_doc_count: 0,
            extended_bounds: { min: bounds.from, max: bounds.to },
          },
        },
      },
    });
    expect(body).not.toHaveProperty("search_after");
    const next = hitsBody({ query: { match_all: {} }, sort: [], searchAfter: [1, 7], size: 50 });
    expect(next).toMatchObject({ size: 50, search_after: [1, 7] });
    expect(next).not.toHaveProperty("aggs");
    const all = hitsBody({ query: { match_all: {} }, sort: [], extentOf: "@timestamp" });
    expect(all.aggs).toEqual({
      min_time: { min: { field: "@timestamp" } },
      max_time: { max: { field: "@timestamp" } },
    });
    const cal = hitsBody({
      query: { match_all: {} },
      sort: [],
      histogram: { field: "t", interval: chooseInterval(365 * DAY), ...bounds, timeZone: "UTC" },
    });
    expect((cal.aggs as { histogram: { date_histogram: object } }).histogram.date_histogram).toMatchObject({
      calendar_interval: "1w",
    });
  });

  it("pages a point in time, `_shard_doc` breaking ties", () => {
    const sort = [{ field: "@timestamp", dir: "desc" as const }];
    const body = hitsBody({ query: { match_all: {} }, sort, searchAfter: [1, 7], pit: "p1" });
    expect(body.pit).toEqual({ id: "p1", keep_alive: PIT_KEEP_ALIVE });
    expect((body.sort as unknown[]).at(-1)).toEqual({ _shard_doc: { order: "asc" } });
    expect(hitsBody({ query: { match_all: {} }, sort })).not.toHaveProperty("pit");
    expect(parseSearch({ pit_id: "p2", hits: { hits: [] } }).pit).toBe("p2");
    expect(parseSearch({ hits: { hits: [] } }).pit).toBeNull();
  });

  it("counts again: the histogram with the total, or the total alone", () => {
    const h = { field: "t", interval: chooseInterval(DAY), ...bounds, timeZone: "UTC" };
    const counts = histogramBody({ match_all: {} }, h, true);
    expect(counts).toMatchObject({ size: 0, aggs: { histogram: {} } });
    expect(counts).not.toHaveProperty("track_total_hits");
    expect(histogramBody({ match_all: {} }, null, true)).toEqual({ size: 0, query: { match_all: {} } });
    expect(histogramBody({ match_all: {} }, h)).toMatchObject({ track_total_hits: false });
  });
});

describe("responses", () => {
  it("reads totals (counted or not), hits, buckets and the time extent", () => {
    const page = parseSearch({
      took: 3,
      hits: { total: { value: 10000, relation: "gte" }, hits: [{ _index: "a", _id: "1", _source: { x: 1 } }] },
      aggregations: {
        histogram: { buckets: [{ key: 1000, doc_count: 4 }] },
        min_time: { value: 5 },
        max_time: { value: 9 },
      },
    });
    expect(page).toMatchObject({ total: 10000, relation: "gte", took: 3, buckets: [{ key: 1000, count: 4 }] });
    expect(page.extent).toEqual({ min: 5, max: 9 });
    expect(hitsLabel(page.total, page.relation)).toBe("10,000+");
    expect(hitsLabel(1234, "eq")).toBe("1,234");
    expect(parseSearch({ hits: { total: 7, hits: [] } })).toMatchObject({ total: 7, relation: "eq", buckets: null });
  });

  it("reads top values as shares of the documents with the field", () => {
    const top = parseTopValues({
      hits: { total: { value: 200, relation: "eq" }, hits: [] },
      aggregations: {
        top: {
          sum_other_doc_count: 20,
          buckets: [
            { key: "error", doc_count: 50 },
            { key: 1, key_as_string: "true", doc_count: 30 },
          ],
        },
        present: { doc_count: 100 },
      },
    });
    expect(top).toEqual({
      values: [
        { value: "error", count: 50, share: 0.5 },
        { value: "true", count: 30, share: 0.3 },
      ],
      present: 100,
      total: 200,
    });
    expect(topValuesBody({ match_all: {} }, "service")).toMatchObject({
      size: 0,
      aggs: { top: { terms: { field: "service", size: 5 } }, present: { filter: { exists: { field: "service" } } } },
    });
  });

  it("counts top values in loaded documents when the field cannot aggregate", () => {
    const rows = [{ tags: ["a", "b"] }, { tags: ["a"] }, { other: 1 }, { tags: "c" }];
    expect(sampleTopValues(rows, "tags")).toEqual({
      values: [
        { value: "a", count: 2, share: 2 / 3 },
        { value: "b", count: 1, share: 1 / 3 },
        { value: "c", count: 1, share: 1 / 3 },
      ],
      present: 3,
      total: 4,
    });
  });

  it("explains errors with ES's own reasons", () => {
    const body = JSON.stringify({
      error: {
        root_cause: [{ type: "query_shard_exception", reason: 'failed to create query: For input string: "abc"' }],
        type: "search_phase_execution_exception",
        reason: "all shards failed",
        caused_by: { type: "number_format_exception", reason: 'For input string: "abc"' },
      },
      status: 400,
    });
    expect(esErrorText(body, 400)).toBe(
      'failed to create query: For input string: "abc"\nall shards failed\nFor input string: "abc"',
    );
    expect(esErrorText("<html>Bad Gateway</html>", 502)).toBe("<html>Bad Gateway</html>");
    expect(esErrorText("", 502)).toBe("HTTP 502");
    expect(esErrorText('{"error":"no handler found"}', 400)).toBe("no handler found");
  });

  it("splits highlighted text into segments", () => {
    expect(highlightSegments(`a ${HL_PRE}b${HL_POST} c ${HL_PRE}d${HL_POST}`)).toEqual([
      { text: "a ", hit: false },
      { text: "b", hit: true },
      { text: " c ", hit: false },
      { text: "d", hit: true },
    ]);
    expect(highlightSegments("plain")).toEqual([{ text: "plain", hit: false }]);
  });
});

describe("documents and fields", () => {
  it("flattens _source into dotted fields; arrays of objects merge per field", () => {
    expect(
      flattenSource({
        a: { b: 1, c: { d: "x" } },
        tags: ["p", "q"],
        hits: [{ n: 1 }, { n: 2 }],
        one: [{ n: 3 }],
        e: {},
      }),
    ).toEqual({ "a.b": 1, "a.c.d": "x", tags: ["p", "q"], "hits.n": [1, 2], "one.n": 3, e: {} });
  });

  it("reads a multi-field from its parent", () => {
    const flat = { message: "hello", "user.name": "ada" };
    expect(fieldValue(flat, "message.keyword")).toBe("hello");
    expect(fieldValue(flat, "user.name")).toBe("ada");
    expect(fieldValue(flat, "user.id")).toBeUndefined();
  });

  it("finds the time field and the field top values count on", () => {
    const fields = [
      f("created", "date"),
      f("@timestamp", "date"),
      f("message", "text"),
      f("message.keyword", "keyword"),
    ];
    expect(timeFieldOf(fields)).toBe("@timestamp");
    expect(timeFieldOf(fields.slice(0, 1))).toBe("created");
    expect(timeFieldOf([f("message", "text")])).toBeNull();
    expect(aggFieldOf(fields, "message")).toBe("message.keyword");
    expect(aggFieldOf(fields, "created")).toBe("created");
    expect(aggFieldOf([f("body", "text")], "body")).toBeNull();
  });

  it("lists selected, available and empty fields; multi-fields, objects and metadata stay out", () => {
    const fields = [
      f("_id", "_id", { metadata: true }),
      f("http", "object"),
      f("http.status", "long"),
      f("level", "keyword"),
      f("message", "text"),
      f("message.keyword", "keyword"),
      f("trace.id", "keyword"),
    ];
    const s = fieldSections(fields, new Set(["level", "message", "http.status"]), ["http.status"], "");
    expect(s.selected.map((x) => x.name)).toEqual(["http.status"]);
    expect(s.available.map((x) => x.name)).toEqual(["level", "message"]);
    expect(s.empty.map((x) => x.name)).toEqual(["trace.id"]);
    expect(fieldSections(fields, new Set(), [], "LEV").empty.map((x) => x.name)).toEqual(["level"]);
  });

  it("adds a field:value clause to the query", () => {
    expect(appendFilter("", "kql", "level", "error", false)).toBe('level:"error"');
    expect(appendFilter("timeout", "kql", "http.status", 500, true)).toBe("timeout and not http.status:500");
    expect(appendFilter("a or b", "kql", "x", 'say "hi"', false)).toBe('(a or b) and x:"say \\"hi\\""');
    expect(appendFilter("a:1", "lucene", "user.name", "ada", true)).toBe('a:1 AND NOT user.name:"ada"');
    expect(appendFilter("", "lucene", "@timestamp", "x", false)).toBe('@timestamp:"x"');
  });
});

describe("the JSON view", () => {
  const value = { a: 1, b: { c: [true, null, "x"] }, d: [] };

  it("lists the open containers' children, folded ones as one line", () => {
    const shallow = jsonRows(
      value,
      (_id, depth) => depth < 1,
      () => 100,
    );
    expect(shallow.map((r) => [r.kind, r.depth])).toEqual([
      ["open", 0],
      ["value", 1],
      ["value", 1],
      ["value", 1],
      ["close", 0],
    ]);
    const deep = jsonRows(
      value,
      () => true,
      () => 100,
    );
    expect(deep.filter((r) => r.kind === "value").length).toBe(5);
    expect(deep.at(-1)).toMatchObject({ kind: "close", comma: false });
  });

  it("shows the first entries of long containers, the rest a click away", () => {
    const rows = jsonRows(
      Array.from({ length: 250 }, (_, i) => i),
      () => true,
      () => 100,
    );
    expect(rows.filter((r) => r.kind === "value").length).toBe(100);
    expect(rows.find((r) => r.kind === "more")).toMatchObject({ hidden: 150 });
  });

  it("copies paths and values", () => {
    expect(jsonPathText(["hits", "hits", 0, "_source", "user name"])).toBe('hits.hits[0]._source["user name"]');
    expect(jsonPathText(["@timestamp"])).toBe("@timestamp");
    expect(jsonCopyText("text")).toBe("text");
    expect(jsonCopyText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});
