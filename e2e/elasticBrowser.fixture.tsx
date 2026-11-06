/**
 * An Elasticsearch cluster kept in the page for Discover's end-to-end tests (browser mode
 * has no backend): the `commands` Discover calls answer from ~300 in-memory log documents
 * the way `ide_db::elastic` and Elasticsearch 8 do. `_search` honours size / from / sort /
 * search_after / track_total_hits, a working subset of the query DSL (match_all, bool,
 * match, match_phrase, multi_match, term(s), range, exists, wildcard, nested, query_string
 * with terms, phrases, wildcards, `field:value`, `_exists_`, AND / OR / NOT), the
 * aggregations date_histogram (fixed / calendar), terms, min, max, value_count, filter and
 * highlighting; points in time (`_pit`, then `/_search` with `pit`) search a snapshot;
 * `PUT` / `DELETE` `_doc` edit the documents (with `if_seq_no` conflicts).
 */
import { commands } from "../src/bindings";
import { loadSources, useDatabase } from "../src/features/database/store";

type Doc = { _index: string; _id: string; _source: Record<string, unknown>; _seq_no: number; _primary_term: number };
type Q = Record<string, unknown>;

const ok = (data: unknown) => Promise.resolve({ status: "ok", data });

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Deterministic numbers (mulberry32): the same documents on every run. */
function random(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
};

/** ~300 log lines: most in the last 24 hours (busier in the last hours), the rest over the week before. */
export function seedDocs(now = Date.now()): Doc[] {
  const r = random(20261105);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const services = ["checkout", "payments", "inventory", "auth", "search", "gateway"];
  const users = ["ada", "grace", "linus", "alan", "barbara", "ken", "margaret"];
  const tags = ["prod", "eu-west-1", "canary", "beta", "retry"];
  const docs: Doc[] = [];
  for (let i = 0; i < 300; i++) {
    const recent = i < 220;
    const age = recent ? Math.pow(r(), 1.35) * DAY : DAY + r() * 6 * DAY;
    const ts = Math.round(now - age - 5_000);
    const roll = r();
    const level = roll < 0.6 ? "info" : roll < 0.8 ? "warn" : roll < 0.92 ? "error" : "debug";
    const service = pick(services);
    const user = pick(users);
    const order = 1000 + Math.floor(r() * 9000);
    const duration = Math.round((level === "error" ? 800 + r() * 2400 : 4 + r() * 380) * 100) / 100;
    const status =
      level === "error"
        ? pick([500, 502, 503, 504])
        : level === "warn"
          ? pick([400, 401, 404, 409, 429])
          : pick([200, 200, 200, 201, 204, 301]);
    const messages: Record<string, string[]> = {
      info: [
        `GET /api/orders/${order} completed in ${Math.round(duration)}ms`,
        `User ${user} signed in from web`,
        `Order A-${order} placed by ${user}`,
        `Cache hit for product:${order % 97}`,
        `Indexed ${Math.floor(r() * 40) + 1} products into search`,
      ],
      warn: [
        `Slow query on orders took ${Math.round(duration)}ms`,
        `Retrying request to inventory-service (attempt 2)`,
        `Payment declined for order A-${order}`,
        `Rate limit reached for ${user}`,
      ],
      error: [
        `Timeout calling inventory-service after 3000ms`,
        `Connection reset by peer while charging order A-${order}`,
        `NullPointerException in CheckoutController.submit`,
        `Payment gateway returned 502 for order A-${order}`,
      ],
      debug: [`Feature flag newCheckout evaluated to ${r() < 0.5}`, `Session ${order.toString(16)} refreshed`],
    };
    const source: Record<string, unknown> = {
      "@timestamp": new Date(ts).toISOString(),
      level,
      message: pick(messages[level]!),
      service,
      http: { status, method: pick(["GET", "GET", "POST", "PUT", "DELETE"]) },
      duration_ms: duration,
      user: { name: user },
      client: { ip: `10.0.${Math.floor(r() * 8)}.${Math.floor(r() * 250) + 2}` },
      tags: tags.filter(() => r() < 0.3),
    };
    if (!(source.tags as string[]).length) delete source.tags;
    docs.push({
      _index: `logs-app-${dayOf(ts)}`,
      _id: `${(ts * 37 + i).toString(36).slice(-6)}${i.toString(36).padStart(3, "0")}`,
      _source: source,
      _seq_no: i,
      _primary_term: 1,
    });
  }
  return docs;
}

// ---- mapping --------------------------------------------------------------------------------

const MAPPING: Record<string, string> = {
  "@timestamp": "date",
  level: "keyword",
  message: "text",
  "message.keyword": "keyword",
  service: "keyword",
  http: "object",
  "http.status": "long",
  "http.method": "keyword",
  duration_ms: "double",
  user: "object",
  "user.name": "keyword",
  client: "object",
  "client.ip": "ip",
  tags: "keyword",
};

function fieldCaps() {
  const fields = Object.entries(MAPPING).map(([name, type]) => ({
    name,
    types: [type],
    searchable: type !== "object",
    aggregatable: type !== "text" && type !== "object",
    metadata: false,
  }));
  for (const name of ["_id", "_index", "_source", "_score"])
    fields.push({
      name,
      types: [name],
      searchable: name !== "_source",
      aggregatable: name === "_index",
      metadata: true,
    });
  return fields.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- values ---------------------------------------------------------------------------------

function raw(source: unknown, path: string): unknown {
  let cur: unknown = source;
  for (const part of path.split(".")) {
    if (cur && typeof cur === "object" && !Array.isArray(cur)) cur = (cur as Q)[part];
    else return undefined;
  }
  return cur;
}

/** A field's values in a document (`x.keyword` reads `x`). */
function valuesOf(doc: Doc, field: string): unknown[] {
  if (field === "_id") return [doc._id];
  if (field === "_index") return [doc._index];
  let v = raw(doc._source, field);
  if (v === undefined && field.endsWith(".keyword")) v = raw(doc._source, field.slice(0, -8));
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

const typeOf = (field: string) => MAPPING[field] ?? (field.endsWith(".keyword") ? "keyword" : "unknown");
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
const timeOf = (v: unknown) => (typeof v === "number" ? v : Date.parse(String(v)));
const glob = (p: string) =>
  new RegExp(
    `^${p
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
    "i",
  );

class Bad extends Error {
  constructor(
    message: string,
    readonly type = "parsing_exception",
  ) {
    super(message);
  }
}

/** One value against a query value, the way the field's type compares. */
function equals(field: string, v: unknown, q: unknown): boolean {
  const type = typeOf(field);
  if (type === "text") return words(String(q)).some((w) => words(String(v)).includes(w));
  if (type === "long" || type === "double") return Number(v) === Number(q);
  if (type === "date") return timeOf(v) === timeOf(q);
  return String(v) === String(q);
}

function compareValue(field: string, a: unknown, b: unknown): number {
  const type = typeOf(field);
  if (type === "date") return timeOf(a) - timeOf(b);
  if (type === "long" || type === "double") return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

// ---- queries --------------------------------------------------------------------------------

const TEXT_FIELDS = Object.entries(MAPPING)
  .filter(([, t]) => t === "text" || t === "keyword")
  .map(([f]) => f);

/** Words the query looks for in `message` (highlighting). */
function highlightTerms(q: unknown, out: Set<string>) {
  if (!q || typeof q !== "object") return;
  const [kind, arg] = Object.entries(q as Q)[0] ?? [];
  const a = arg as Q;
  switch (kind) {
    case "bool":
      for (const k of ["must", "filter", "should"])
        for (const x of ([] as unknown[]).concat(a[k] ?? [])) highlightTerms(x, out);
      return;
    case "match":
    case "match_phrase": {
      const [f, v] = Object.entries(a)[0]!;
      if (f === "message" || f === "*")
        for (const w of words(String(typeof v === "object" ? (v as Q).query : v))) out.add(w);
      return;
    }
    case "multi_match":
      for (const w of words(String(a.query))) out.add(w);
      return;
    case "query_string":
      if (!a.fields || (a.fields as string[]).includes("message"))
        for (const w of words(
          String(a.query)
            .replace(/\b[\w.@]+:("[^"]*"|\S+)/g, " ")
            .replace(/\b(AND|OR|NOT)\b/g, " "),
        ))
          out.add(w);
  }
}

function matches(doc: Doc, q: unknown): boolean {
  if (!q || typeof q !== "object") throw new Bad("query malformed, empty clause found");
  const entries = Object.entries(q as Q);
  if (entries.length !== 1) throw new Bad("query malformed, expected one clause");
  const [kind, arg] = entries[0]!;
  const a = (arg ?? {}) as Q;
  const one = <T,>(o: Q): [string, T] => {
    const [f, v] = Object.entries(o)[0] ?? [];
    if (!f) throw new Bad(`[${kind}] query malformed, no field specified`);
    return [f, v as T];
  };
  switch (kind) {
    case "match_all":
      return true;
    case "match_none":
      return false;
    case "bool": {
      const list = (k: string) => ([] as unknown[]).concat(a[k] ?? []);
      const must = [...list("must"), ...list("filter")];
      if (!must.every((x) => matches(doc, x))) return false;
      if (list("must_not").some((x) => matches(doc, x))) return false;
      const should = list("should");
      const min = a.minimum_should_match !== undefined ? Number(a.minimum_should_match) : must.length ? 0 : 1;
      return !should.length || should.filter((x) => matches(doc, x)).length >= Math.min(min, should.length);
    }
    case "match": {
      const [f, v] = one<unknown>(a);
      const text = String(typeof v === "object" && v !== null ? (v as Q).query : v);
      return valuesOf(doc, f).some((x) => equals(f, x, text));
    }
    case "match_phrase": {
      const [f, v] = one<unknown>(a);
      const phrase = words(String(typeof v === "object" && v !== null ? (v as Q).query : v)).join(" ");
      return valuesOf(doc, f).some((x) =>
        typeOf(f) === "text" ? ` ${words(String(x)).join(" ")} `.includes(` ${phrase} `) : equals(f, x, phrase),
      );
    }
    case "multi_match": {
      const fields = (a.fields as string[] | undefined) ?? TEXT_FIELDS;
      const kindOf = a.type === "phrase" ? "match_phrase" : "match";
      return fields.some((f) => matches(doc, { [kindOf]: { [f]: a.query } }));
    }
    case "term": {
      const [f, v] = one<unknown>(a);
      const value = typeof v === "object" && v !== null ? (v as Q).value : v;
      return valuesOf(doc, f).some((x) =>
        typeOf(f) === "text" ? words(String(x)).includes(String(value)) : equals(f, x, value),
      );
    }
    case "terms": {
      const [f, vs] = one<unknown[]>(a);
      return valuesOf(doc, f).some((x) => vs.some((v) => equals(f, x, v)));
    }
    case "range": {
      const [f, b] = one<Q>(a);
      return valuesOf(doc, f).some((x) => {
        const c = (v: unknown) => compareValue(f, x, v);
        if (b.gt !== undefined && !(c(b.gt) > 0)) return false;
        if (b.gte !== undefined && !(c(b.gte) >= 0)) return false;
        if (b.lt !== undefined && !(c(b.lt) < 0)) return false;
        if (b.lte !== undefined && !(c(b.lte) <= 0)) return false;
        return true;
      });
    }
    case "exists":
      return valuesOf(doc, String(a.field)).length > 0;
    case "wildcard": {
      const [f, v] = one<unknown>(a);
      const re = glob(String(typeof v === "object" && v !== null ? (v as Q).value : v));
      return valuesOf(doc, f).some((x) => re.test(String(x)));
    }
    case "nested":
      return matches(doc, a.query);
    case "query_string":
      return queryString(doc, String(a.query ?? ""), (a.fields as string[] | undefined) ?? null);
    default:
      throw new Bad(`unknown query [${kind}]`);
  }
}

/** Lucene syntax, enough of it: terms, "phrases", wildcards, field:value, _exists_:field, AND / OR / NOT / -, ( ). */
function queryString(doc: Doc, text: string, fields: string[] | null): boolean {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|\(|\)|[^\s()]+(?:"(?:[^"\\]|\\.)*")?/g) ?? [];
  let i = 0;
  const term = (t: string): boolean => {
    const m = /^((?:[^:\\]|\\.)+):(.*)$/.exec(t);
    const unescape = (s: string) => s.replace(/\\(.)/g, "$1");
    let field = m ? unescape(m[1]!) : null;
    let value = m ? m[2]! : t;
    if (field === "_exists_") return valuesOf(doc, unescape(value)).length > 0;
    const phrase = /^".*"$/.test(value);
    if (phrase) value = value.slice(1, -1);
    value = unescape(value);
    if (/^[<>]=?/.test(value)) {
      const op = /^[<>]=?/.exec(value)![0];
      const rest = value.slice(op.length);
      const k = { ">": "gt", ">=": "gte", "<": "lt", "<=": "lte" }[op]!;
      return !!field && matches(doc, { range: { [field]: { [k]: rest } } });
    }
    const targets = field
      ? field.includes("*")
        ? Object.keys(MAPPING).filter((f) => glob(field!).test(f))
        : [field]
      : (fields ?? TEXT_FIELDS);
    field = null;
    if (!phrase && /[*?]/.test(value)) {
      const re = glob(value);
      return targets.some((f) =>
        valuesOf(doc, f).some((x) =>
          typeOf(f) === "text" ? words(String(x)).some((w) => re.test(w)) : re.test(String(x)),
        ),
      );
    }
    return targets.some((f) => matches(doc, phrase ? { match_phrase: { [f]: value } } : { match: { [f]: value } }));
  };
  const primary = (): boolean => {
    const t = tokens[i++];
    if (t === undefined) throw new Bad("Cannot parse query: unexpected end", "query_shard_exception");
    if (t === "(") {
      const v = or();
      if (tokens[i++] !== ")") throw new Bad(`Cannot parse '${text}': Encountered "<EOF>"`, "query_shard_exception");
      return v;
    }
    if (t === "NOT") return !primary();
    if (t.startsWith("-") && t.length > 1) return !term(t.slice(1));
    if (t.startsWith("+") && t.length > 1) return term(t.slice(1));
    return term(t);
  };
  const and = (): boolean => {
    let v = primary();
    while (tokens[i] === "AND") {
      i++;
      const w = primary();
      v = v && w;
    }
    return v;
  };
  const or = (): boolean => {
    let v = and();
    while (i < tokens.length && tokens[i] !== ")") {
      if (tokens[i] === "OR") i++;
      const w = and();
      v = v || w;
    }
    return v;
  };
  if (!tokens.length) return true;
  return or();
}

function score(doc: Doc, terms: Set<string>): number {
  if (!terms.size) return 1;
  const ws = words(String(doc._source.message ?? ""));
  return 1 + ws.filter((w) => terms.has(w)).length * 0.7;
}

// ---- sorting --------------------------------------------------------------------------------

type SortKey = { field: string; desc: boolean };

function sortKeys(sort: unknown): SortKey[] {
  return ([] as unknown[]).concat(sort ?? []).map((s) => {
    if (typeof s === "string") return { field: s, desc: s === "_score" };
    const [field, v] = Object.entries(s as Q)[0]!;
    const order = typeof v === "string" ? v : (v as Q).order;
    return { field, desc: order === "desc" };
  });
}

function sortValue(doc: Doc & { _score: number; _doc: number }, field: string): unknown {
  if (field === "_score") return doc._score;
  if (field === "_doc" || field === "_shard_doc") return doc._doc;
  const vs = valuesOf(doc, field);
  if (!vs.length) return null;
  const type = typeOf(field);
  if (type === "date") return Math.min(...vs.map(timeOf));
  if (type === "long" || type === "double") return Math.min(...vs.map(Number));
  return vs.map(String).sort()[0]!;
}

function cmpTuple(a: unknown[], b: unknown[], keys: SortKey[]): number {
  for (let k = 0; k < keys.length; k++) {
    const x = a[k];
    const y = b[k];
    if (x === y) continue;
    // Missing values sort last either way (`_last`).
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    if (c) return keys[k]!.desc ? -c : c;
  }
  return 0;
}

// ---- aggregations ---------------------------------------------------------------------------

const FIXED: Record<string, number> = { ms: 1, s: 1000, m: MIN, h: HOUR, d: DAY };

function bucketStart(t: number, fixed: string | undefined, calendar: string | undefined): number {
  if (fixed) {
    const m = /^(\d+)(ms|s|m|h|d)$/.exec(fixed);
    if (!m)
      throw new Bad(
        `failed to parse setting [date_histogram.fixedInterval] with value [${fixed}]`,
        "illegal_argument_exception",
      );
    // Fixed intervals line up in UTC here (a constant grid, whatever daylight saving does).
    const ms = Number(m[1]) * FIXED[m[2]!]!;
    return Math.floor(t / ms) * ms;
  }
  const d = new Date(t);
  switch (calendar) {
    case "1m":
    case "minute":
      return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()).getTime();
    case "1h":
    case "hour":
      return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
    case "1d":
    case "day":
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    case "1w":
    case "week": {
      const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
      return day.getTime();
    }
    case "1M":
    case "month":
      return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    case "1q":
    case "quarter":
      return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1).getTime();
    case "1y":
    case "year":
      return new Date(d.getFullYear(), 0, 1).getTime();
    default:
      throw new Bad(
        `The supplied interval [${calendar}] could not be parsed as a calendar interval.`,
        "illegal_argument_exception",
      );
  }
}

function nextBucket(t: number, fixed: string | undefined, calendar: string | undefined): number {
  if (fixed) {
    const m = /^(\d+)(ms|s|m|h|d)$/.exec(fixed)!;
    return t + Number(m[1]) * FIXED[m[2]!]!;
  }
  const d = new Date(t);
  switch (calendar) {
    case "1w":
    case "week":
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7).getTime();
    case "1M":
    case "month":
      return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    case "1q":
    case "quarter":
      return new Date(d.getFullYear(), d.getMonth() + 3, 1).getTime();
    case "1y":
    case "year":
      return new Date(d.getFullYear() + 1, 0, 1).getTime();
    case "1d":
    case "day":
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    case "1h":
    case "hour":
      return t + HOUR;
    default:
      return t + MIN;
  }
}

function aggregate(docs: Doc[], aggs: Q): Q {
  const out: Q = {};
  for (const [name, spec] of Object.entries(aggs)) {
    const [kind, arg] = Object.entries(spec as Q).find(([k]) => k !== "aggs" && k !== "aggregations")!;
    const a = arg as Q;
    switch (kind) {
      case "date_histogram": {
        const field = String(a.field);
        const fixed = a.fixed_interval as string | undefined;
        const calendar = a.calendar_interval as string | undefined;
        if (!fixed && !calendar)
          throw new Bad("Required one of fields [fixed_interval, calendar_interval]", "x_content_parse_exception");
        const counts = new Map<number, number>();
        for (const d of docs)
          for (const v of valuesOf(d, field)) {
            const k = bucketStart(timeOf(v), fixed, calendar);
            counts.set(k, (counts.get(k) ?? 0) + 1);
          }
        const bounds = a.extended_bounds as { min?: number; max?: number } | undefined;
        const keys = [...counts.keys()];
        const lo = Math.min(
          ...keys,
          ...(bounds?.min !== undefined ? [bucketStart(Number(bounds.min), fixed, calendar)] : []),
        );
        const hi = Math.max(
          ...keys,
          ...(bounds?.max !== undefined ? [bucketStart(Number(bounds.max), fixed, calendar)] : []),
        );
        const buckets = [];
        if (Number.isFinite(lo))
          for (let k = lo; k <= hi && buckets.length < 10_000; k = nextBucket(k, fixed, calendar))
            buckets.push({ key_as_string: new Date(k).toISOString(), key: k, doc_count: counts.get(k) ?? 0 });
        out[name] = { buckets: Number(a.min_doc_count ?? 1) > 0 ? buckets.filter((b) => b.doc_count > 0) : buckets };
        break;
      }
      case "terms": {
        const field = String(a.field);
        if (typeOf(field) === "text")
          throw new Bad(
            `Text fields are not optimised for operations that require per-document field data like aggregations and sorting, so these operations are disabled by default. Please use a keyword field instead. Alternatively, set fielddata=true on [${field}] in order to load field data by uninverting the inverted index.`,
            "illegal_argument_exception",
          );
        const counts = new Map<string, { key: unknown; n: number }>();
        for (const d of docs)
          for (const v of new Set(valuesOf(d, field).map((x) => JSON.stringify(x)))) {
            const c = counts.get(v) ?? { key: JSON.parse(v), n: 0 };
            c.n++;
            counts.set(v, c);
          }
        const sorted = [...counts.values()].sort((x, y) => y.n - x.n || String(x.key).localeCompare(String(y.key)));
        const size = Number(a.size ?? 10);
        out[name] = {
          doc_count_error_upper_bound: 0,
          sum_other_doc_count: sorted.slice(size).reduce((n, b) => n + b.n, 0),
          buckets: sorted.slice(0, size).map((b) => ({ key: b.key, doc_count: b.n })),
        };
        break;
      }
      case "min":
      case "max": {
        const vs = docs
          .flatMap((d) => valuesOf(d, String(a.field)))
          .map((v) => (typeOf(String(a.field)) === "date" ? timeOf(v) : Number(v)));
        const value = vs.length ? (kind === "min" ? Math.min(...vs) : Math.max(...vs)) : null;
        out[name] =
          typeOf(String(a.field)) === "date" && value !== null
            ? { value, value_as_string: new Date(value).toISOString() }
            : { value };
        break;
      }
      case "value_count":
        out[name] = { value: docs.reduce((n, d) => n + valuesOf(d, String(a.field)).length, 0) };
        break;
      case "filter":
        out[name] = { doc_count: docs.filter((d) => matches(d, a)).length };
        break;
      default:
        throw new Bad(`Unknown aggregation type [${kind}] did you mean [terms]?`);
    }
  }
  return out;
}

// ---- the cluster ----------------------------------------------------------------------------

export interface FakeElastic {
  docs: Doc[];
  /** Open points in time: the pattern and the documents when opened. */
  pits: Map<string, { pattern: string; docs: Doc[] }>;
  /** Requests answered, newest last (`method path`). */
  log: string[];
}

export async function installFakeElastic(opts: { readOnly?: boolean } = {}): Promise<FakeElastic> {
  const state: FakeElastic = { docs: seedDocs(), pits: new Map(), log: [] };
  let pitSeq = 0;
  const patternRe = (pattern: string) => pattern.split(",").map((p) => glob(decodeURIComponent(p.trim())));
  const indices = () => [...new Set(state.docs.map((d) => d._index))].sort();

  const json = (status: number, body: unknown) => ({
    status,
    elapsedMs: 3.2,
    contentType: "application/json",
    body: JSON.stringify(body),
    truncated: false,
  });
  const error = (status: number, type: string, reason: string) =>
    json(status, { error: { root_cause: [{ type, reason }], type, reason }, status });

  const search = (pattern: string, body: Q, all: Doc[] = state.docs) => {
    const res = patternRe(pattern);
    let docs = all.filter((d) => res.some((re) => re.test(d._index)));
    const query = (body.query ?? { match_all: {} }) as Q;
    docs = docs.filter((d) => matches(d, query));
    const terms = new Set<string>();
    highlightTerms(query, terms);
    const keys = sortKeys(body.sort ?? ["_score"]);
    const withScore = docs.map((d, i) => ({ ...d, _score: score(d, terms), _doc: all.indexOf(d) + i * 0 }));
    const tuples = new Map(withScore.map((d) => [d, keys.map((k) => sortValue(d, k.field))]));
    let ordered = [...withScore].sort((a, b) => cmpTuple(tuples.get(a)!, tuples.get(b)!, keys));
    if (body.search_after) {
      const after = body.search_after as unknown[];
      if (after.length !== keys.length)
        throw new Bad(
          `search_after has ${after.length} value(s) but sort has ${keys.length}.`,
          "illegal_argument_exception",
        );
      ordered = ordered.filter((d) => cmpTuple(tuples.get(d)!, after, keys) > 0);
    }
    const from = Number(body.from ?? 0);
    const size = Number(body.size ?? 10);
    const page = ordered.slice(from, from + size);
    const track = body.track_total_hits ?? 10_000;
    const hl = body.highlight as { pre_tags?: string[]; post_tags?: string[] } | undefined;
    const pre = hl?.pre_tags?.[0] ?? "<em>";
    const post = hl?.post_tags?.[0] ?? "</em>";
    const highlight = (d: Doc) => {
      const msg = String(d._source.message ?? "");
      if (!terms.size) return undefined;
      let hit = false;
      const out = msg.replace(/[\p{L}\p{N}_]+/gu, (w) => {
        if (!terms.has(w.toLowerCase())) return w;
        hit = true;
        return `${pre}${w}${post}`;
      });
      return hit ? { message: [out] } : undefined;
    };
    const total =
      track === false
        ? undefined
        : track === true || docs.length < Number(track)
          ? { value: docs.length, relation: "eq" }
          : { value: Number(track), relation: "gte" };
    return {
      took: 2 + Math.floor(docs.length / 50),
      timed_out: false,
      _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
      hits: {
        ...(total ? { total } : {}),
        max_score: keys.some((k) => k.field === "_score") ? Math.max(0, ...page.map((d) => d._score)) : null,
        hits: page.map((d) => ({
          _index: d._index,
          _id: d._id,
          _score: keys.some((k) => k.field === "_score") ? d._score : null,
          ...(body.seq_no_primary_term ? { _seq_no: d._seq_no, _primary_term: d._primary_term } : {}),
          _source: structuredClone(d._source),
          ...(hl && highlight(d) ? { highlight: highlight(d) } : {}),
          ...(body.sort ? { sort: tuples.get(d)! } : {}),
        })),
      },
      ...(body.aggs || body.aggregations
        ? { aggregations: aggregate(docs, (body.aggs ?? body.aggregations) as Q) }
        : {}),
    };
  };

  const c = commands as unknown as Record<string, unknown>;
  c.dbSources = () =>
    ok([
      {
        id: "logs",
        name: "luma-es",
        driver: "elasticsearch",
        host: "127.0.0.1",
        port: 9200,
        ssl: "disable",
        readOnly: !!opts.readOnly,
        options: {},
      },
    ]);
  c.dbConnected = () => ok(["logs"]);
  c.dbConnect = () => ok(null);
  c.cancelRequest = () => Promise.resolve(null);
  c.esCluster = () =>
    ok({
      name: "luma-cluster",
      uuid: "f3c1PnUjQ5K9uXH4cK2d1A",
      distribution: "elasticsearch",
      version: "8.19.10",
      status: "yellow",
      nodes: 1,
      dataNodes: 1,
      activeShards: indices().length,
      activePrimaryShards: indices().length,
      relocatingShards: 0,
      initializingShards: 0,
      unassignedShards: indices().length,
      indices: indices().length + 2,
      docs: state.docs.length,
      storeBytes: state.docs.length * 612,
    });
  c.esIndices = () => {
    const list = indices().map((name, i) => ({
      name,
      health: "yellow",
      status: "open",
      uuid: `u${i}`,
      primaries: 1,
      replicas: 1,
      docs: state.docs.filter((d) => d._index === name).length,
      storeBytes: state.docs.filter((d) => d._index === name).length * 612,
      hidden: false,
      dataStream: null,
      aliases: ["logs"],
    }));
    list.push(
      {
        name: ".kibana_8.19.10_001",
        health: "green",
        status: "open",
        uuid: "k1",
        primaries: 1,
        replicas: 0,
        docs: 42,
        storeBytes: 81920,
        hidden: true,
        dataStream: null,
        aliases: [],
      },
      {
        name: ".ds-metrics-system-2026.11.05-000001",
        health: "green",
        status: "open",
        uuid: "m1",
        primaries: 1,
        replicas: 0,
        docs: 0,
        storeBytes: 225,
        hidden: true,
        dataStream: "metrics-system",
        aliases: [],
      },
      {
        name: "orders",
        health: "green",
        status: "open",
        uuid: "o1",
        primaries: 1,
        replicas: 0,
        docs: 0,
        storeBytes: 225,
        hidden: false,
        dataStream: null,
        aliases: [],
      },
    );
    return ok({
      indices: list,
      dataStreams: [
        {
          name: "metrics-system",
          timestampField: "@timestamp",
          indices: [".ds-metrics-system-2026.11.05-000001"],
          status: "GREEN",
          hidden: false,
        },
      ],
      aliases: [{ name: "logs", indices: indices() }],
    });
  };
  c.esFields = (_id: string, index: string) => {
    const res = patternRe(index);
    return ok(indices().some((i) => res.some((re) => re.test(i))) ? fieldCaps() : []);
  };
  c.esRequest = async (_req: number, _id: string, method: string, path: string, body: string | null) => {
    state.log.push(`${method} ${path}`);
    // A moment, as a real round trip takes: loading states show, ordering bugs surface.
    await new Promise((r) => setTimeout(r, 40));
    const [pathname, qs = ""] = path.split("?");
    const params = new URLSearchParams(qs);
    const parts = pathname!.split("/").filter(Boolean);
    try {
      // Points in time: a snapshot of the documents, searched by id at `/_search`.
      if (parts[1] === "_pit" && method === "POST") {
        const id = `pit-${++pitSeq}`;
        state.pits.set(id, { pattern: decodeURIComponent(parts[0]!), docs: [...state.docs] });
        return ok(json(200, { id, _shards: { total: 1, successful: 1, skipped: 0, failed: 0 } }));
      }
      if (parts[0] === "_pit" && method === "DELETE") {
        const id = String((JSON.parse(body ?? "{}") as Q).id);
        const freed = state.pits.delete(id);
        return ok(json(200, { succeeded: true, num_freed: freed ? 1 : 0 }));
      }
      if (parts[0] === "_search" && parts.length === 1 && method === "POST") {
        const q = JSON.parse(body ?? "{}") as Q;
        const id = String((q.pit as Q | undefined)?.id ?? "");
        const pit = state.pits.get(id);
        if (!pit) return ok(error(404, "search_context_missing_exception", `No search context found for id [${id}]`));
        return ok(json(200, { pit_id: id, ...search(pit.pattern, q, pit.docs) }));
      }
      if (parts[1] === "_search" && (method === "POST" || method === "GET")) {
        return ok(json(200, search(parts[0]!, body ? (JSON.parse(body) as Q) : {})));
      }
      if (parts[1] === "_doc" && parts[2]) {
        const index = decodeURIComponent(parts[0]!);
        const id = decodeURIComponent(parts[2]);
        const at = state.docs.findIndex((d) => d._index === index && d._id === id);
        if (opts.readOnly && method !== "GET")
          return Promise.resolve({
            status: "error",
            error: { kind: "permissionDenied", message: "The data source is read-only" },
          });
        if (method === "DELETE") {
          if (at < 0) return ok(json(404, { _index: index, _id: id, result: "not_found" }));
          state.docs.splice(at, 1);
          return ok(
            json(200, { _index: index, _id: id, _version: 2, result: "deleted", _seq_no: 900, _primary_term: 1 }),
          );
        }
        if (method === "PUT" || method === "POST") {
          const doc = state.docs[at];
          const seq = params.get("if_seq_no");
          if (doc && seq !== null && Number(seq) !== doc._seq_no)
            return ok(
              error(
                409,
                "version_conflict_engine_exception",
                `[${id}]: version conflict, required seqNo [${seq}], primary term [1]. current document has seqNo [${doc._seq_no}] and primary term [1]`,
              ),
            );
          const source = JSON.parse(body ?? "{}") as Record<string, unknown>;
          const next = Math.max(...state.docs.map((d) => d._seq_no)) + 1;
          if (doc) Object.assign(doc, { _source: source, _seq_no: next });
          else state.docs.push({ _index: index, _id: id, _source: source, _seq_no: next, _primary_term: 1 });
          return ok(
            json(doc ? 200 : 201, {
              _index: index,
              _id: id,
              result: doc ? "updated" : "created",
              _seq_no: next,
              _primary_term: 1,
            }),
          );
        }
      }
      return ok(
        error(
          400,
          "illegal_argument_exception",
          `request [${path}] contains unrecognized parameters or an unknown endpoint`,
        ),
      );
    } catch (e) {
      if (e instanceof Bad) return ok(error(400, e.type, e.message));
      throw e;
    }
  };

  useDatabase.setState({ loaded: false });
  await loadSources();
  return state;
}
