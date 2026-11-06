/**
 * Discover tabs' state, kept while a tab is hidden (keyed by the editor input's key): the
 * query and its language, the time range, the columns, the sort, the panes' sizes, the
 * hits loaded so far with the histogram, the open document and the scroll position. Also
 * the searches themselves (cancellable, the newest wins), Load More, top values and the
 * document edits.
 */
import { create } from "zustand";
import { call, commands, isCancelled, nextRequestId, type EsField, type RequestId } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { editorService, notifications } from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";
import { withConnection } from "../../store";
import { fieldsOf, loadedFields, openDiscover } from "../store";
import { esDiscoverInput } from "../model";
import { kqlToDsl, luceneToDsl } from "../kql";
import {
  DEFAULT_RANGE,
  MAX_HITS,
  PAGE_SIZE,
  PIT_KEEP_ALIVE,
  aggFieldOf,
  chooseInterval,
  effectiveSort,
  esErrorText,
  flattenSource,
  histogramBody,
  hitsBody,
  parseSearch,
  parseTopValues,
  resolveRange,
  sampleTopValues,
  timeFieldOf,
  topValuesBody,
  withTimeRange,
  type Bucket,
  type Dsl,
  type Hit,
  type Interval,
  type QueryLang,
  type SortSpec,
  type TimeRange,
  type TopValues,
} from "./search";

export interface QueryError {
  message: string;
  /** The query's failing range (KQL syntax errors). */
  range: { text: string; from: number; to: number } | null;
}

export interface DiscoverResult {
  total: number;
  relation: "eq" | "gte";
  hits: Hit[];
  /** `hits` as dotted fields. */
  rows: Array<Record<string, unknown>>;
  buckets: Bucket[] | null;
  interval: Interval | null;
  /** The histogram's span. */
  bounds: { from: number; to: number } | null;
  /** What the hits were searched with (Load More and top values reuse it). */
  basis: { query: Dsl; sort: SortSpec[]; timeField: string | null; pit: boolean };
  done: boolean;
  took: number | null;
}

export interface DiscoverTab {
  id: string;
  index: string;
  query: string;
  lang: QueryLang;
  time: TimeRange;
  columns: string[];
  sort: SortSpec[];
  widths: Record<string, number>;
  sidebarWidth: number;
  sidebarOpen: boolean;
  flyoutWidth: number;
  status: "idle" | "loading" | "ok" | "error";
  loadingMore: boolean;
  error: QueryError | null;
  result: DiscoverResult | null;
  /** The document shown in the flyout (`docKey`). */
  open: string | null;
  scrollTop: number;
}

interface Layout {
  sidebarWidth: number;
  sidebarOpen: boolean;
  flyoutWidth: number;
}

const LAYOUT_KEY = "luma.esDiscover.layout";
export const SIDEBAR_MIN = 180;
export const FLYOUT_MIN = 320;
const DEFAULT_LAYOUT: Layout = { sidebarWidth: 248, sidebarOpen: true, flyoutWidth: 460 };

function storedLayout(): Layout {
  try {
    const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") as Partial<Layout>;
    return {
      sidebarWidth: typeof v.sidebarWidth === "number" ? Math.max(SIDEBAR_MIN, v.sidebarWidth) : 248,
      sidebarOpen: typeof v.sidebarOpen === "boolean" ? v.sidebarOpen : true,
      flyoutWidth: typeof v.flyoutWidth === "number" ? Math.max(FLYOUT_MIN, v.flyoutWidth) : 460,
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function storeLayout(t: DiscoverTab) {
  try {
    const layout: Layout = { sidebarWidth: t.sidebarWidth, sidebarOpen: t.sidebarOpen, flyoutWidth: t.flyoutWidth };
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // Blocked storage: the layout lasts the session.
  }
}

export const useDiscover = create<{ tabs: Record<string, DiscoverTab> }>(() => ({ tabs: {} }));

export const docKey = (h: Pick<Hit, "_index" | "_id">) => `${h._index}\u0000${h._id}`;

function newTab(id: string, index: string, seed?: Partial<DiscoverTab>): DiscoverTab {
  return {
    id,
    index,
    query: "",
    lang: "kql",
    time: DEFAULT_RANGE,
    columns: [],
    sort: [],
    widths: {},
    ...storedLayout(),
    status: "idle",
    loadingMore: false,
    error: null,
    result: null,
    open: null,
    scrollTop: 0,
    ...seed,
  };
}

export function ensureTab(key: string, id: string, index: string): DiscoverTab {
  const known = useDiscover.getState().tabs[key];
  if (known) return known;
  const t = newTab(id, index);
  useDiscover.setState((s) => ({ tabs: { ...s.tabs, [key]: t } }));
  return t;
}

export const tabOf = (key: string): DiscoverTab | undefined => useDiscover.getState().tabs[key];

export function patchTab(key: string, p: Partial<DiscoverTab> | ((t: DiscoverTab) => Partial<DiscoverTab>)) {
  useDiscover.setState((s) => {
    const t = s.tabs[key];
    if (!t) return s;
    const next = { ...t, ...(typeof p === "function" ? p(t) : p) };
    if (
      next.sidebarWidth !== t.sidebarWidth ||
      next.sidebarOpen !== t.sidebarOpen ||
      next.flyoutWidth !== t.flyoutWidth
    )
      storeLayout(next);
    return { tabs: { ...s.tabs, [key]: next } };
  });
}

/** Forgets a closed tab. */
export function dropTab(key: string) {
  cancelSearch(key);
  closePit(key);
  useDiscover.setState((s) => {
    const { [key]: _gone, ...tabs } = s.tabs;
    return { tabs };
  });
}

// ---- the query ------------------------------------------------------------------------------

/** The query DSL of the text (empty: everything), or where it does not parse. */
export function parseQuery(
  text: string,
  lang: QueryLang,
  fields: readonly EsField[],
): { ok: true; query: Dsl } | { ok: false; error: QueryError } {
  if (!text.trim()) return { ok: true, query: { match_all: {} } };
  if (lang === "lucene") return { ok: true, query: luceneToDsl(text) as Dsl };
  const r = kqlToDsl(text, fields);
  if (r.ok) return { ok: true, query: r.query as Dsl };
  return { ok: false, error: { message: r.error, range: { text, from: r.from, to: r.to } } };
}

// ---- searching ------------------------------------------------------------------------------

const running = new Map<string, RequestId[]>();
const seqs = new Map<string, number>();

function cancelSearch(key: string) {
  for (const r of running.get(key) ?? []) void commands.cancelRequest(r);
  running.delete(key);
}

const indexPath = (index: string) => `/${encodeURIComponent(index).replace(/%2C/gi, ",")}`;
const searchPath = (index: string) => `${indexPath(index)}/_search?ignore_unavailable=true`;

class EsError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(esErrorText(body, status));
  }
}

/** A request of tab `key` (cancelled with its searches). */
async function send(key: string, id: string, method: string, path: string, body: Dsl | null) {
  const req = nextRequestId();
  running.set(key, [...(running.get(key) ?? []), req]);
  try {
    return await withConnection(id, () =>
      call(commands.esRequest(req, id, method, path, body ? JSON.stringify(body) : null)),
    );
  } finally {
    running.set(
      key,
      (running.get(key) ?? []).filter((x) => x !== req),
    );
  }
}

/** A search of `index`, or of point in time `pit` (whose searches name no index). */
async function post(key: string, id: string, index: string, body: Dsl, pit: string | null = null): Promise<unknown> {
  const r = await send(key, id, "POST", pit ? "/_search" : searchPath(index), body);
  if (r.status < 200 || r.status >= 300) throw new EsError(r.status, r.body);
  return JSON.parse(r.body);
}

// ---- points in time -------------------------------------------------------------------------

/**
 * Each tab's point in time: its pages read one snapshot of the indices, `_shard_doc`
 * breaking ties, so Load More neither repeats nor skips a hit while documents change.
 */
const pits = new Map<string, { id: string; pit: string }>();

/** A point in time on `index`, or null where there is none (OpenSearch's API differs, Elasticsearch before 7.10, no privilege). */
async function openPit(key: string, id: string, index: string): Promise<string | null> {
  try {
    const r = await send(
      key,
      id,
      "POST",
      `${indexPath(index)}/_pit?keep_alive=${PIT_KEEP_ALIVE}&ignore_unavailable=true`,
      null,
    );
    if (r.status < 200 || r.status >= 300) return null;
    const pit = (JSON.parse(r.body) as { id?: unknown }).id;
    return typeof pit === "string" ? pit : null;
  } catch (e) {
    if (isCancelled(e)) throw e;
    return null;
  }
}

function releasePit(id: string, pit: string) {
  void call(commands.esRequest(nextRequestId(), id, "DELETE", "/_pit", JSON.stringify({ id: pit }))).catch(() => {});
}

function closePit(key: string) {
  const p = pits.get(key);
  if (!p) return;
  pits.delete(key);
  releasePit(p.id, p.pit);
}

const isExpired = (e: unknown) =>
  e instanceof EsError && e.status === 404 && /search_context_missing|No search context/i.test(e.body);

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runs the tab's query from the first page; the hits shown stay until the answer arrives. */
export async function runSearch(key: string): Promise<void> {
  const t = tabOf(key);
  if (!t) return;
  cancelSearch(key);
  const seq = (seqs.get(key) ?? 0) + 1;
  seqs.set(key, seq);
  const stale = () => seqs.get(key) !== seq;
  patchTab(key, { status: "loading", loadingMore: false });

  // The fields (the time field, the sort) and a fresh snapshot, side by side.
  let pit: string | null = null;
  let kept = false;
  let fields: EsField[] = [];
  try {
    [fields, pit] = await Promise.all([
      // No fields (a pattern matching nothing yet): searched without a time field.
      fieldsOf(t.id, t.index).catch((): EsField[] => []),
      openPit(key, t.id, t.index),
    ]);
  } catch {
    return; // Cancelled by a newer search.
  }
  const release = () => {
    if (pit) releasePit(t.id, pit);
    pit = null;
  };
  if (stale()) return release();
  const parsed = parseQuery(t.query, t.lang, fields);
  if (!parsed.ok) {
    release();
    patchTab(key, { status: "error", error: parsed.error });
    return;
  }
  const timeField = timeFieldOf(fields);
  const bounds = timeField ? resolveRange(t.time, Date.now()) : null;
  const query = withTimeRange(parsed.query, timeField, bounds);
  const sort = effectiveSort(
    t.sort.filter((s) => s.field === "_score" || fields.some((f) => f.name === s.field)),
    timeField,
  );
  const interval = bounds ? chooseInterval(bounds.to - bounds.from) : null;
  const first = (p: string | null) =>
    post(
      key,
      t.id,
      t.index,
      hitsBody({
        query,
        sort,
        histogram:
          timeField && bounds && interval ? { field: timeField, interval, ...bounds, timeZone: timeZone() } : null,
        extentOf: timeField && !bounds ? timeField : null,
        pit: p,
      }),
      p,
    );
  try {
    let json: unknown;
    try {
      json = await first(pit);
    } catch (e) {
      if (!pit || stale() || isCancelled(e) || !(e instanceof EsError)) throw e;
      // A point in time it cannot page (Elasticsearch before 7.12 has no `_shard_doc`): pages without one.
      release();
      json = await first(null);
    }
    if (stale()) return release();
    const page = parseSearch(json);
    closePit(key);
    if (pit) {
      pits.set(key, { id: t.id, pit: page.pit ?? pit });
      kept = true;
    }
    let result: DiscoverResult = {
      total: page.total,
      relation: page.relation,
      hits: page.hits,
      rows: page.hits.map((h) => flattenSource(h._source)),
      buckets: page.buckets,
      interval,
      bounds,
      basis: { query, sort, timeField, pit: !!pit },
      done: page.hits.length < PAGE_SIZE || page.hits.length >= Math.min(page.total, MAX_HITS),
      took: page.took,
    };
    if (result.done) closePit(key);
    const open = tabOf(key)?.open;
    const keepOpen = open && page.hits.some((h) => docKey(h) === open) ? open : null;
    patchTab(key, { status: "ok", error: null, result, open: keepOpen });

    // All time: the histogram spans the hits' own extent, asked for once it is known.
    if (timeField && !bounds && page.extent) {
      const span = { from: page.extent.min, to: Math.max(page.extent.max, page.extent.min + 1) };
      const all = chooseInterval(span.to - span.from);
      const h = parseSearch(
        await post(
          key,
          t.id,
          t.index,
          histogramBody(query, { field: timeField, interval: all, ...span, timeZone: timeZone() }),
        ),
      );
      if (stale()) return;
      result = { ...result, buckets: h.buckets, interval: all, bounds: span };
      patchTab(key, { result });
    }
  } catch (e) {
    if (!kept) release();
    if (stale() || isCancelled(e)) return;
    patchTab(key, { status: "error", error: { message: message(e), range: null } });
  }
}

/** The next page after the last hit (`search_after`, in the search's point in time), up to `MAX_HITS`. */
export async function loadMore(key: string): Promise<void> {
  const t = tabOf(key);
  const r = t?.result;
  if (!t || !r || r.done || t.loadingMore || t.status === "loading") return;
  const last = r.hits[r.hits.length - 1];
  if (!last?.sort) return;
  const seq = seqs.get(key) ?? 0;
  patchTab(key, { loadingMore: true });
  const size = Math.min(PAGE_SIZE, MAX_HITS - r.hits.length);
  const next = (pit: string | null) =>
    post(
      key,
      t.id,
      t.index,
      hitsBody({ query: r.basis.query, sort: r.basis.sort, size, searchAfter: last.sort, pit }),
      pit,
    );
  // Expired (idle past its keep-alive): a new snapshot from here on, the sort values still apply.
  const reopen = async () => {
    const pit = await openPit(key, t.id, t.index);
    if (!pit) throw new Error(tx("The search expired. Refresh to search again."));
    if (seqs.get(key) === seq) pits.set(key, { id: t.id, pit });
    else releasePit(t.id, pit);
    return pit;
  };
  try {
    let json: unknown;
    if (r.basis.pit) {
      const pit = pits.get(key)?.pit ?? (await reopen());
      try {
        json = await next(pit);
      } catch (e) {
        if (!isExpired(e)) throw e;
        json = await next(await reopen());
      }
    } else json = await next(null);
    if (seqs.get(key) !== seq) return;
    const page = parseSearch(json);
    const held = pits.get(key);
    if (held && page.pit) pits.set(key, { ...held, pit: page.pit });
    let done = false;
    patchTab(key, (cur) => {
      if (!cur.result) return { loadingMore: false };
      const hits = [...cur.result.hits, ...page.hits];
      done = page.hits.length < size || hits.length >= Math.min(cur.result.total, MAX_HITS);
      return {
        loadingMore: false,
        result: {
          ...cur.result,
          hits,
          rows: [...cur.result.rows, ...page.hits.map((h) => flattenSource(h._source))],
          done,
        },
      };
    });
    if (done) closePit(key);
  } catch (e) {
    patchTab(key, { loadingMore: false });
    if (!isCancelled(e))
      notifications().notify({ level: "error", title: tx("Cannot load more documents"), body: message(e) });
  }
}

/** After an edit or a delete: the total and the histogram again (the hits loaded stay). */
async function refreshCounts(key: string) {
  const t = tabOf(key);
  const r = t?.result;
  if (!t || !r) return;
  const seq = seqs.get(key);
  const { timeField } = r.basis;
  const h =
    timeField && r.interval && r.bounds
      ? { field: timeField, interval: r.interval, ...r.bounds, timeZone: timeZone() }
      : null;
  try {
    const page = parseSearch(await post(`${key}\u0000counts`, t.id, t.index, histogramBody(r.basis.query, h, true)));
    if (seqs.get(key) !== seq) return;
    patchTab(key, (cur) =>
      cur.result
        ? {
            result: {
              ...cur.result,
              total: page.total,
              relation: page.relation,
              ...(h ? { buckets: page.buckets } : {}),
            },
          }
        : {},
    );
  } catch {
    // The counts stay as they were until the next search.
  }
}

/** A field's top values among the matching documents (or among the loaded ones, when it cannot aggregate). */
export async function topValues(key: string, field: string): Promise<TopValues & { sampled: boolean }> {
  const t = tabOf(key);
  if (!t) throw new Error("closed");
  const fields = loadedFields(t.id, t.index);
  const agg = aggFieldOf(fields?.status === "ok" ? fields.value : [], field);
  if (!agg) return { ...sampleTopValues(t.result?.rows ?? [], field), sampled: true };
  const query = t.result?.basis.query ?? { match_all: {} };
  const json = await post(`${key}\u0000top`, t.id, t.index, topValuesBody(query, agg));
  return { ...parseTopValues(json), sampled: false };
}

const valueCache = new Map<string, Promise<string[]>>();

/** A keyword field's 20 most common values in the pattern (query bar completion), asked for once per field. */
export function suggestValues(key: string, field: string): Promise<string[]> {
  const t = tabOf(key);
  if (!t) return Promise.resolve([]);
  const fields = loadedFields(t.id, t.index);
  const agg = aggFieldOf(fields?.status === "ok" ? fields.value : [], field);
  const f = fields?.status === "ok" ? fields.value.find((x) => x.name === agg) : undefined;
  if (!agg || !f || !f.types.some((x) => x === "keyword" || x === "constant_keyword" || x === "ip"))
    return Promise.resolve([]);
  const cacheKey = `${t.id}\u0000${t.index}\u0000${agg}`;
  let p = valueCache.get(cacheKey);
  if (!p) {
    p = post(`${key}\u0000values`, t.id, t.index, topValuesBody({ match_all: {} }, agg, 20)).then((json) =>
      parseTopValues(json).values.map((v) => v.value),
    );
    p.catch(() => valueCache.delete(cacheKey));
    valueCache.set(cacheKey, p);
  }
  return p;
}

// ---- documents ------------------------------------------------------------------------------

const docPath = (h: Hit) => `/${encodeURIComponent(h._index)}/_doc/${encodeURIComponent(h._id)}`;

function replaceHit(key: string, old: Hit, next: Hit | null) {
  patchTab(key, (t) => {
    const r = t.result;
    if (!r) return {};
    const at = r.hits.findIndex((h) => docKey(h) === docKey(old));
    if (at < 0) return {};
    const hits = [...r.hits];
    const rows = [...r.rows];
    if (next) {
      hits[at] = next;
      rows[at] = flattenSource(next._source);
      return { result: { ...r, hits, rows } };
    }
    hits.splice(at, 1);
    rows.splice(at, 1);
    const neighbour = hits[at] ?? hits[at - 1];
    return {
      result: { ...r, hits, rows, total: Math.max(0, r.total - 1) },
      open: t.open === docKey(old) ? (neighbour ? docKey(neighbour) : null) : t.open,
    };
  });
}

/** Writes a document's new `_source` (optimistic concurrency on its sequence number); the error text if refused. */
export async function saveDocument(key: string, hit: Hit, source: Record<string, unknown>): Promise<string | null> {
  const t = tabOf(key);
  if (!t) return "closed";
  const cc =
    hit._seq_no !== undefined && hit._primary_term !== undefined
      ? `&if_seq_no=${hit._seq_no}&if_primary_term=${hit._primary_term}`
      : "";
  try {
    const r = await withConnection(t.id, () =>
      call(
        commands.esRequest(
          nextRequestId(),
          t.id,
          "PUT",
          `${docPath(hit)}?refresh=wait_for${cc}`,
          JSON.stringify(source),
        ),
      ),
    );
    if (r.status < 200 || r.status >= 300) return esErrorText(r.body, r.status);
    const ack = JSON.parse(r.body) as { _seq_no?: number; _primary_term?: number };
    replaceHit(key, hit, {
      ...hit,
      _source: source,
      highlight: undefined,
      _seq_no: ack._seq_no ?? hit._seq_no,
      _primary_term: ack._primary_term ?? hit._primary_term,
    });
    void refreshCounts(key);
    return null;
  } catch (e) {
    return message(e);
  }
}

export async function deleteDocument(key: string, hit: Hit): Promise<boolean> {
  const t = tabOf(key);
  if (!t) return false;
  const { _id: id, _index: index } = hit;
  const ok = await confirm({
    title: "Delete Document",
    message: tx`Delete document '${id}' from index '${index}'? This cannot be undone.`,
    ok: "Delete",
  });
  if (!ok) return false;
  try {
    const r = await withConnection(t.id, () =>
      call(commands.esRequest(nextRequestId(), t.id, "DELETE", `${docPath(hit)}?refresh=wait_for`, null)),
    );
    if (r.status < 200 || r.status >= 300) throw new Error(esErrorText(r.body, r.status));
    replaceHit(key, hit, null);
    void refreshCounts(key);
    return true;
  } catch (e) {
    notifications().notify({ level: "error", title: tx("Cannot delete the document"), body: message(e) });
    return false;
  }
}

// ---- the index pattern ----------------------------------------------------------------------

/** Moves the tab to another index pattern (keeping its query and time range), unless that one has a tab already. */
export function switchPattern(key: string, index: string) {
  const t = tabOf(key);
  if (!t || index === t.index || !index.trim()) return;
  const next = esDiscoverInput(t.id, index);
  const open = editorService()
    .openTabs?.()
    .some((x) => x.input.key === next.key);
  if (!tabOf(next.key)) {
    const seeded = newTab(t.id, index, {
      query: t.query,
      lang: t.lang,
      time: t.time,
      sidebarWidth: t.sidebarWidth,
      sidebarOpen: t.sidebarOpen,
      flyoutWidth: t.flyoutWidth,
    });
    useDiscover.setState((s) => ({ tabs: { ...s.tabs, [next.key]: seeded } }));
  }
  void openDiscover(t.id, index, true);
  if (!open) {
    void editorService()
      .closeInput?.(key)
      .then((closed) => closed && dropTab(key));
  }
}
