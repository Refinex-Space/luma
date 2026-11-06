/**
 * Discover's pure parts: time ranges and the histogram's interval, the `_search` bodies
 * (hits page, histogram, top values), reading responses (hits, totals, buckets, errors,
 * highlights), flattening `_source` into dotted fields, the field list's sections and the
 * filters the field popover and the document table add to the query.
 */
import type { EsField } from "@/platform/ipc";
import { fieldGroup, type FieldGroup } from "../model";

export type QueryLang = "kql" | "lucene";

export type TimeRange =
  | { kind: "relative"; ms: number }
  | { kind: "absolute"; from: number; to: number }
  | { kind: "all" };

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The picker's quick ranges (`null`: all time). */
export const QUICK_RANGES: ReadonlyArray<{ ms: number | null; label: string; short: string }> = [
  { ms: 15 * MIN, label: "Last 15 minutes", short: "15m" },
  { ms: HOUR, label: "Last 1 hour", short: "1h" },
  { ms: DAY, label: "Last 24 hours", short: "24h" },
  { ms: 7 * DAY, label: "Last 7 days", short: "7d" },
  { ms: 30 * DAY, label: "Last 30 days", short: "30d" },
  { ms: 365 * DAY, label: "Last 1 year", short: "1y" },
  { ms: null, label: "All time", short: "All" },
];

export const DEFAULT_RANGE: TimeRange = { kind: "relative", ms: DAY };

/** The bounds of a range now (`null`: unbounded). */
export function resolveRange(range: TimeRange, now: number): { from: number; to: number } | null {
  switch (range.kind) {
    case "relative":
      return { from: now - range.ms, to: now };
    case "absolute":
      return { from: range.from, to: range.to };
    case "all":
      return null;
  }
}

export interface Interval {
  /** Nominal length (calendar intervals: their average). */
  ms: number;
  /** `fixed_interval` / `calendar_interval` value. */
  value: string;
  calendar: boolean;
}

const fixed = (value: string, ms: number): Interval => ({ ms, value, calendar: false });
const INTERVALS: readonly Interval[] = [
  fixed("10ms", 10),
  fixed("50ms", 50),
  fixed("100ms", 100),
  fixed("500ms", 500),
  fixed("1s", 1000),
  fixed("2s", 2000),
  fixed("5s", 5000),
  fixed("10s", 10_000),
  fixed("15s", 15_000),
  fixed("30s", 30_000),
  fixed("1m", MIN),
  fixed("2m", 2 * MIN),
  fixed("5m", 5 * MIN),
  fixed("10m", 10 * MIN),
  fixed("15m", 15 * MIN),
  fixed("30m", 30 * MIN),
  fixed("1h", HOUR),
  fixed("2h", 2 * HOUR),
  fixed("3h", 3 * HOUR),
  fixed("6h", 6 * HOUR),
  fixed("12h", 12 * HOUR),
  fixed("1d", DAY),
  { ms: 7 * DAY, value: "1w", calendar: true },
  { ms: 30.44 * DAY, value: "1M", calendar: true },
  { ms: 91.31 * DAY, value: "1q", calendar: true },
  { ms: 365.25 * DAY, value: "1y", calendar: true },
];

/** Most bars the histogram draws; the interval is the finest that stays under it (≈40–80 bars). */
export const MAX_BUCKETS = 80;

/** The histogram's interval for a span: the finest “round” one giving at most `MAX_BUCKETS` bars. */
export function chooseInterval(spanMs: number): Interval {
  const span = Math.max(1, spanMs);
  return INTERVALS.find((i) => span / i.ms <= MAX_BUCKETS) ?? INTERVALS[INTERVALS.length - 1]!;
}

/** The axis' tick spacing: the first round step at least `minMs` long. */
export function tickStep(minMs: number): number {
  return (INTERVALS.find((i) => i.ms >= minMs) ?? INTERVALS[INTERVALS.length - 1]!).ms;
}

export interface SortSpec {
  field: string;
  dir: "asc" | "desc";
}

/** The sort a search runs with: the chosen one, else newest first (time-based), else by score. */
export function effectiveSort(sort: readonly SortSpec[], timeField: string | null): SortSpec[] {
  if (sort.length) return [...sort];
  if (timeField) return [{ field: timeField, dir: "desc" }];
  return [{ field: "_score", dir: "desc" }];
}

/**
 * The `sort` clause with a tie-breaker so `search_after` pages never skip or repeat a hit:
 * in a point in time `_shard_doc` (unique across shards, and the PIT's snapshot keeps it
 * stable); without one `_doc`, unique only within a shard.
 */
export function sortClause(sort: readonly SortSpec[], pit = false): unknown[] {
  return [
    ...sort.map((s) =>
      s.field === "_score" ? { _score: { order: s.dir } } : { [s.field]: { order: s.dir, unmapped_type: "boolean" } },
    ),
    pit ? { _shard_doc: { order: "asc" } } : { _doc: { order: "asc" } },
  ];
}

/** How long a point in time lives between two pages (each page extends it). */
export const PIT_KEEP_ALIVE = "5m";

export const HL_PRE = "@luma-hl@";
export const HL_POST = "@/luma-hl@";
export const PAGE_SIZE = 100;
/** Most hits Discover pages through (Kibana's sample size cap; `index.max_result_window` too). */
export const MAX_HITS = 10_000;

export type Dsl = Record<string, unknown>;

/** The user's query restricted to the time range. */
export function withTimeRange(query: Dsl, timeField: string | null, bounds: { from: number; to: number } | null): Dsl {
  if (!timeField || !bounds) return query;
  const range = {
    range: {
      [timeField]: {
        gte: new Date(bounds.from).toISOString(),
        lte: new Date(bounds.to).toISOString(),
        format: "strict_date_optional_time",
      },
    },
  };
  const isAll = "match_all" in query && Object.keys(query).length === 1;
  return { bool: { ...(isAll ? {} : { must: [query] }), filter: [range] } };
}

export interface HistogramRequest {
  field: string;
  interval: Interval;
  from: number;
  to: number;
  timeZone: string;
}

export function histogramAgg(h: HistogramRequest): Dsl {
  return {
    date_histogram: {
      field: h.field,
      [h.interval.calendar ? "calendar_interval" : "fixed_interval"]: h.interval.value,
      time_zone: h.timeZone,
      min_doc_count: 0,
      extended_bounds: { min: h.from, max: h.to },
    },
  };
}

export interface HitsRequest {
  query: Dsl;
  sort: readonly SortSpec[];
  size?: number;
  searchAfter?: readonly unknown[] | null;
  histogram?: HistogramRequest | null;
  /** Ask for the time field's min / max (all time: the histogram's bounds). */
  extentOf?: string | null;
  /** The point in time searched (`POST /_search`, no index in the path). */
  pit?: string | null;
}

/** A page of hits (plus, on the first, the histogram or the time extent). */
export function hitsBody(r: HitsRequest): Dsl {
  const aggs: Dsl = {};
  if (r.histogram) aggs.histogram = histogramAgg(r.histogram);
  if (r.extentOf) {
    aggs.min_time = { min: { field: r.extentOf } };
    aggs.max_time = { max: { field: r.extentOf } };
  }
  return {
    size: r.size ?? PAGE_SIZE,
    query: r.query,
    sort: sortClause(r.sort, !!r.pit),
    ...(r.searchAfter ? { search_after: r.searchAfter } : {}),
    ...(r.pit ? { pit: { id: r.pit, keep_alive: PIT_KEEP_ALIVE } } : {}),
    seq_no_primary_term: true,
    highlight: {
      pre_tags: [HL_PRE],
      post_tags: [HL_POST],
      fields: { "*": {} },
      fragment_size: 2147483647,
    },
    ...(Object.keys(aggs).length ? { aggs } : {}),
  };
}

/** The histogram alone (all time, once the extent is known; with the total: counts after an edit). */
export function histogramBody(query: Dsl, h: HistogramRequest | null, withTotal = false): Dsl {
  return {
    size: 0,
    query,
    ...(withTotal ? {} : { track_total_hits: false }),
    ...(h ? { aggs: { histogram: histogramAgg(h) } } : {}),
  };
}

/** A field's five most common values among the matching documents. */
export function topValuesBody(query: Dsl, field: string, size = 5): Dsl {
  return {
    size: 0,
    query,
    track_total_hits: true,
    aggs: { top: { terms: { field, size } }, present: { filter: { exists: { field } } } },
  };
}

// ---- responses ------------------------------------------------------------------------------

export interface Hit {
  _index: string;
  _id: string;
  _score?: number | null;
  _source?: Record<string, unknown>;
  sort?: unknown[];
  highlight?: Record<string, string[]>;
  _seq_no?: number;
  _primary_term?: number;
}

export interface Bucket {
  key: number;
  count: number;
}

export interface SearchPage {
  total: number;
  /** `gte`: at least `total` (ES stopped counting). */
  relation: "eq" | "gte";
  hits: Hit[];
  buckets: Bucket[] | null;
  extent: { min: number; max: number } | null;
  took: number | null;
  /** The point in time's id to send next (Elasticsearch may change it from page to page). */
  pit: string | null;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);

export function parseSearch(json: unknown): SearchPage {
  const root = obj(json) ?? {};
  const hits = obj(root.hits) ?? {};
  const total = hits.total;
  let count = 0;
  let relation: "eq" | "gte" = "eq";
  if (typeof total === "number") count = total;
  else if (obj(total)) {
    count = Number(obj(total)!.value ?? 0);
    relation = obj(total)!.relation === "gte" ? "gte" : "eq";
  }
  const aggs = obj(root.aggregations);
  const hist = obj(aggs?.histogram);
  const buckets = Array.isArray(hist?.buckets)
    ? (hist!.buckets as Json[]).map((b) => ({ key: Number(b.key), count: Number(b.doc_count ?? 0) }))
    : null;
  const min = obj(aggs?.min_time)?.value;
  const max = obj(aggs?.max_time)?.value;
  return {
    total: count,
    relation,
    hits: Array.isArray(hits.hits) ? (hits.hits as Hit[]) : [],
    buckets,
    extent: typeof min === "number" && typeof max === "number" ? { min, max } : null,
    took: typeof root.took === "number" ? root.took : null,
    pit: typeof root.pit_id === "string" ? root.pit_id : null,
  };
}

export interface TopValue {
  value: string;
  count: number;
  /** Share of the documents that have the field, 0–1. */
  share: number;
}

export interface TopValues {
  values: TopValue[];
  /** Documents with the field. */
  present: number;
  /** Documents matching. */
  total: number;
}

export function parseTopValues(json: unknown): TopValues {
  const root = obj(json) ?? {};
  const page = parseSearch(json);
  const aggs = obj(root.aggregations) ?? {};
  const top = obj(aggs.top) ?? {};
  const buckets = Array.isArray(top.buckets) ? (top.buckets as Json[]) : [];
  const counted = buckets.reduce((n, b) => n + Number(b.doc_count ?? 0), 0);
  const presentRaw = obj(aggs.present)?.doc_count;
  const present = typeof presentRaw === "number" ? presentRaw : counted + Number(top.sum_other_doc_count ?? 0);
  const base = Math.max(1, present);
  return {
    values: buckets.map((b) => {
      const count = Number(b.doc_count ?? 0);
      return { value: String(b.key_as_string ?? b.key), count, share: count / base };
    }),
    present,
    total: page.total,
  };
}

/** Top values counted in the loaded hits (fields that cannot be aggregated). */
export function sampleTopValues(rows: ReadonlyArray<Record<string, unknown>>, field: string, size = 5): TopValues {
  const counts = new Map<string, number>();
  let present = 0;
  for (const r of rows) {
    const v = r[field];
    if (v === undefined || v === null) continue;
    present++;
    for (const x of Array.isArray(v) ? v : [v]) {
      const key = typeof x === "object" ? JSON.stringify(x) : String(x);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const values = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, size)
    .map(([value, count]) => ({ value, count, share: count / Math.max(1, present) }));
  return { values, present, total: rows.length };
}

/** The readable part of an Elasticsearch error (`error.root_cause[0].reason`, its cause). */
export function esErrorText(body: string, status: number): string {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return body.trim() || `HTTP ${status}`;
  }
  const error = obj(json)?.error;
  if (typeof error === "string") return error;
  const e = obj(error);
  if (!e) return body.trim() || `HTTP ${status}`;
  const root = Array.isArray(e.root_cause) ? obj(e.root_cause[0]) : null;
  const reasons: string[] = [];
  const add = (x: unknown) => {
    if (typeof x === "string" && x && !reasons.includes(x)) reasons.push(x);
  };
  add(root?.reason);
  add(e.reason);
  for (let c = obj(e.caused_by); c; c = obj(c.caused_by)) add(c.reason);
  // A failed shard's reason is where `search_phase_execution_exception` keeps the real one.
  const failed = Array.isArray(e.failed_shards) ? obj(e.failed_shards[0]) : null;
  add(obj(failed?.reason)?.reason);
  return reasons.length ? reasons.join("\n") : String(e.type ?? `HTTP ${status}`);
}

// ---- documents ------------------------------------------------------------------------------

/**
 * `_source` as dotted fields (`user.name`); objects in arrays merge into arrays of their
 * fields' values, arrays of plain values stay arrays.
 */
export function flattenSource(source: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (key: string, v: unknown, inArray: boolean) => {
    if (!inArray || !(key in out)) {
      out[key] = inArray ? [v] : v;
      return;
    }
    const cur = out[key];
    out[key] = Array.isArray(cur) ? [...cur, v] : [cur, v];
  };
  const walk = (v: unknown, prefix: string, inArray: boolean) => {
    const o = obj(v);
    if (o) {
      const keys = Object.keys(o);
      if (!keys.length && prefix) put(prefix, v, inArray);
      for (const k of keys) walk(o[k], prefix ? `${prefix}.${k}` : k, inArray);
      return;
    }
    if (Array.isArray(v) && v.some((x) => obj(x))) {
      for (const x of v) walk(x, prefix, true);
      return;
    }
    if (prefix) put(prefix, v, inArray);
  };
  walk(source, "", false);
  for (const [k, v] of Object.entries(out))
    if (Array.isArray(v) && v.length === 1 && !Array.isArray(lookupRaw(source, k))) out[k] = v[0];
  return out;
}

function lookupRaw(source: unknown, path: string): unknown {
  let cur: unknown = source;
  for (const part of path.split(".")) {
    const o = obj(cur);
    if (!o) return undefined;
    cur = o[part];
  }
  return cur;
}

/** A field's value in a flattened document; a multi-field (`message.keyword`) reads its parent. */
export function fieldValue(flat: Record<string, unknown>, field: string): unknown {
  if (field in flat) return flat[field];
  const dot = field.lastIndexOf(".");
  if (dot > 0) {
    const parent = field.slice(0, dot);
    const v = flat[parent];
    if (v !== undefined && (typeof v !== "object" || Array.isArray(v))) return v;
  }
  return undefined;
}

/** A value as one line of text. */
export function valueText(v: unknown): string {
  if (v === undefined) return "";
  if (v === null) return "null";
  if (typeof v === "string") return v;
  if (Array.isArray(v))
    return v.map((x) => (typeof x === "object" && x !== null ? JSON.stringify(x) : String(x))).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export interface Segment {
  text: string;
  hit: boolean;
}

/** Highlighted text (`HL_PRE`…`HL_POST`) as segments. */
export function highlightSegments(text: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf(HL_PRE, i);
    if (start < 0) break;
    const end = text.indexOf(HL_POST, start + HL_PRE.length);
    if (end < 0) break;
    if (start > i) out.push({ text: text.slice(i, start), hit: false });
    out.push({ text: text.slice(start + HL_PRE.length, end), hit: true });
    i = end + HL_POST.length;
  }
  if (i < text.length) out.push({ text: text.slice(i), hit: false });
  return out;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** `2026-11-05 14:03:22.120`, local time. */
export function formatTime(v: unknown): string {
  const ms = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms)) return valueText(v);
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** `2026-11-05`, `2026-11-05 14:03`, `2026-11-05 14:03:22(.120)` (local) or ISO-8601; `null` if neither. */
export function parseTime(text: string): number | null {
  const t = text.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(t);
  if (m) {
    const [, y, mo, d, h = "0", mi = "0", s = "0", ms = "0"] = m;
    const date = new Date(+y!, +mo! - 1, +d!, +h, +mi, +s, +ms.padEnd(3, "0"));
    return date.getMonth() === +mo! - 1 && date.getDate() === +d! ? date.getTime() : null;
  }
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(t)) {
    const v = Date.parse(t);
    return Number.isFinite(v) ? v : null;
  }
  return null;
}

/** A bucket's time as precise as its interval needs. */
export function bucketLabel(ms: number, interval: Interval): string {
  const d = new Date(ms);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (interval.value === "1y") return String(d.getFullYear());
  if (interval.value === "1M" || interval.value === "1q") return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  if (interval.ms >= DAY) return date;
  if (interval.ms < MIN)
    return `${date} ${time}:${pad(d.getSeconds())}${interval.ms < 1000 ? `.${pad(d.getMilliseconds(), 3)}` : ""}`;
  return `${date} ${time}`;
}

/** An axis tick: just the part that changes at this scale. */
export function tickLabel(ms: number, spanMs: number): string {
  const d = new Date(ms);
  if (spanMs > 400 * DAY) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  if (spanMs > 3 * DAY) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (spanMs > 2 * HOUR) {
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.getHours() === 0 && d.getMinutes() === 0 ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : hm;
  }
  if (spanMs > 2 * MIN) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** `1,234` / `10,000+`. */
export function hitsLabel(total: number, relation: "eq" | "gte"): string {
  return `${total.toLocaleString("en")}${relation === "gte" ? "+" : ""}`;
}

// ---- fields ---------------------------------------------------------------------------------

/** The group a field's icon shows (conflicting types: `other`). */
export function groupOf(f: EsField): FieldGroup {
  const groups = new Set(f.types.map(fieldGroup));
  return groups.size === 1 ? [...groups][0]! : "other";
}

/** The time field of a pattern: `@timestamp` when it is a date, else the first date field. */
export function timeFieldOf(fields: readonly EsField[]): string | null {
  const dates = fields.filter((f) => !f.metadata && groupOf(f) === "date");
  return dates.find((f) => f.name === "@timestamp")?.name ?? dates[0]?.name ?? null;
}

/** Fields the table sorts by: aggregatable ones (keywords, numbers, dates…). */
export function isSortable(f: EsField | undefined): boolean {
  if (!f) return false;
  const g = groupOf(f);
  return f.aggregatable || g === "date" || g === "number";
}

/** The field top values are counted on: the field, else its `.keyword` multi-field; `null`: neither aggregates. */
export function aggFieldOf(fields: readonly EsField[], name: string): string | null {
  const f = fields.find((x) => x.name === name);
  if (f?.aggregatable) return name;
  const kw = fields.find((x) => x.name === `${name}.keyword`);
  return kw?.aggregatable ? kw.name : null;
}

/** Multi-fields (`message.keyword`) and object containers: not listed on their own. */
export function isListed(f: EsField, byName: ReadonlyMap<string, EsField>): boolean {
  if (f.metadata) return false;
  if (f.types.every((t) => t === "object" || t === "nested")) return false;
  const dot = f.name.lastIndexOf(".");
  if (dot > 0) {
    const parent = byName.get(f.name.slice(0, dot));
    if (parent && !parent.types.every((t) => t === "object" || t === "nested")) return false;
  }
  return true;
}

export interface FieldSections {
  selected: EsField[];
  available: EsField[];
  empty: EsField[];
}

/** The sidebar's sections: chosen columns (in their order), fields with values in the loaded hits, the rest. */
export function fieldSections(
  fields: readonly EsField[],
  present: ReadonlySet<string>,
  columns: readonly string[],
  search: string,
): FieldSections {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const needle = search.trim().toLowerCase();
  const matches = (f: EsField) => !needle || f.name.toLowerCase().includes(needle);
  const listed = fields.filter((f) => isListed(f, byName) && matches(f));
  const selected = columns
    .map(
      (c) => byName.get(c) ?? { name: c, types: ["unknown"], searchable: false, aggregatable: false, metadata: false },
    )
    .filter(matches);
  const chosen = new Set(columns);
  const rest = listed.filter((f) => !chosen.has(f.name));
  return {
    selected,
    available: rest.filter((f) => present.has(f.name)),
    empty: rest.filter((f) => !present.has(f.name)),
  };
}

/** A `field:value` clause added to the query (`negate`: excluded). */
export function appendFilter(query: string, lang: QueryLang, field: string, value: unknown, negate: boolean): string {
  const literal =
    typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const name = lang === "lucene" ? field.replace(/([+\-=&|><!(){}[\]^"~*?:\\/ ])/g, "\\$1") : field;
  const clause = `${negate ? (lang === "kql" ? "not " : "NOT ") : ""}${name}:${literal}`;
  const q = query.trim();
  if (!q) return clause;
  const and = lang === "kql" ? "and" : "AND";
  // An `or` at the top level binds looser: the existing query is wrapped.
  const wrapped = /\bor\b/i.test(q) && !/^\(.*\)$/.test(q) ? `(${q})` : q;
  return `${wrapped} ${and} ${clause}`;
}
