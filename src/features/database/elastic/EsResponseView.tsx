/**
 * An Elasticsearch console response in the Database Console window: the status, time and
 * hits on one line, then the body — as a folding JSON tree, or for a search response its
 * hits as a table (`_index`, `_id`, `_score` and the `_source` fields flattened).
 * Bodies that are not JSON (`_cat/*`, `?format=txt`) show as text.
 */
import { useMemo, useState } from "react";
import clsx from "clsx";
import { tx } from "@/platform/i18n";
import { EmptyState, IconButton, T, copyText } from "@/ui";
import { DataView, ExtractorSelect, PanelToggle, useGridView, type DataPanel } from "../DataView";
import type { ResultTab } from "../store";
import { sizeLabel } from "../redis/model";
import { JsonView } from "./JsonView";
import dbStyles from "../Database.module.css";
import css from "./EsResponseView.module.css";

type Cell = string | null;

/** Most `_source` columns the Hits table shows (the first fields met). */
const MAX_COLUMNS = 200;

/** `{ a: { b: 1 } }` → `a.b = 1`; arrays and leaves stop the walk (arrays as JSON). */
export function flatten(source: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (source && typeof source === "object" && !Array.isArray(source)) {
    for (const [k, v] of Object.entries(source as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length) flatten(v, key, out);
      else out[key] = v;
    }
  } else if (prefix) out[prefix] = source;
  return out;
}

const cellOf = (v: unknown): Cell =>
  v === null || v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v);

interface Hit {
  _index?: string;
  _id?: string;
  _score?: number | null;
  _source?: unknown;
  fields?: Record<string, unknown>;
}

/** The hits of a search response as columns and rows, or null when it has none. */
export function hitsTable(body: unknown): { columns: string[]; rows: Cell[][] } | null {
  const hits = (body as { hits?: { hits?: Hit[] } } | null)?.hits?.hits;
  if (!Array.isArray(hits)) return null;
  const flat = hits.map((h) => flatten(h._source ?? h.fields ?? {}));
  const names: string[] = [];
  const seen = new Set<string>();
  for (const f of flat)
    for (const k of Object.keys(f))
      if (!seen.has(k) && names.length < MAX_COLUMNS) {
        seen.add(k);
        names.push(k);
      }
  const columns = ["_index", "_id", "_score", ...names];
  const rows = hits.map((h, i) => [
    cellOf(h._index),
    cellOf(h._id),
    cellOf(h._score),
    ...names.map((n) => cellOf(flat[i]![n])),
  ]);
  return { columns, rows };
}

function statusTone(status: number): "ok" | "warn" | "bad" {
  return status < 300 ? "ok" : status < 500 ? "warn" : "bad";
}

export function EsResponseView({ tab }: { tab: ResultTab }) {
  const { method, path, response } = tab.elastic!;
  const parsed = useMemo((): { ok: true; value: unknown } | { ok: false } => {
    if (!response.body.trim()) return { ok: false };
    try {
      return { ok: true, value: JSON.parse(response.body) as unknown };
    } catch {
      return { ok: false };
    }
  }, [response.body]);
  const table = useMemo(() => (parsed.ok ? hitsTable(parsed.value) : null), [parsed]);
  const [view, setView] = useState<"json" | "hits">(() => (table && table.rows.length ? "hits" : "json"));
  const took = parsed.ok ? (parsed.value as { took?: number } | null)?.took : undefined;
  const total = parsed.ok
    ? (parsed.value as { hits?: { total?: number | { value: number; relation: string } } } | null)?.hits?.total
    : undefined;
  const hits = typeof total === "number" ? total : total?.value;
  const elapsed = response.elapsedMs ?? 0;
  const time = elapsed < 10 ? elapsed.toFixed(1) : String(Math.round(elapsed));
  const bytes = new TextEncoder().encode(response.body).length;
  const hitsText = hits?.toLocaleString("en") ?? "";
  const more = typeof total === "object" && total?.relation === "gte" ? "+" : "";

  return (
    <div className={dbStyles.view}>
      <div className={clsx(dbStyles.toolbar, css.bar)}>
        <span className={clsx(css.status, css[statusTone(response.status)])}>{response.status}</span>
        <span className={css.request} title={`${method} ${path}`}>
          <b>{method}</b> {path}
        </span>
        <span className={css.facts}>
          <span>{tx`${time} ms`}</span>
          {took !== undefined && <span title={tx("Time Elasticsearch took")}>{tx`took ${took} ms`}</span>}
          {hits !== undefined && <span className={css.hits}>{tx`${hitsText}${more} hits`}</span>}
          <span>{sizeLabel(bytes)}</span>
          {response.truncated && (
            <span className={css.truncated}>
              <T>truncated</T>
            </span>
          )}
        </span>
        <span className={dbStyles.spacer} />
        {table && (
          <div className={css.segmented} role="radiogroup" aria-label={tx("View as")}>
            <button type="button" role="radio" aria-checked={view === "hits"} onClick={() => setView("hits")}>
              <T>Hits</T>
            </button>
            <button type="button" role="radio" aria-checked={view === "json"} onClick={() => setView("json")}>
              JSON
            </button>
          </div>
        )}
        <IconButton icon="copy" title="Copy Response" onClick={() => void copyText(response.body)} />
      </div>
      {view === "hits" && table ? (
        <HitsGrid columns={table.columns} rows={table.rows} index={path.split("/").filter(Boolean)[0] ?? ""} />
      ) : parsed.ok ? (
        <div className={clsx(dbStyles.fill, css.json)}>
          <JsonView value={parsed.value} expandDepth={2} aria-label={tx("Response")} />
        </div>
      ) : response.body.trim() ? (
        <pre className={clsx(dbStyles.fill, css.text)}>{response.body}</pre>
      ) : (
        <EmptyState title="Empty response" />
      )}
    </div>
  );
}

function HitsGrid({ columns, rows, index }: { columns: string[]; rows: Cell[][]; index: string }) {
  const gridColumns = useMemo(
    () => columns.map((name, i) => ({ name, type: i === 2 ? "double" : "", primaryKey: i === 1 })),
    [columns],
  );
  const view = useGridView(gridColumns);
  const [panel, setPanel] = useState<DataPanel | null>(null);
  if (!rows.length) return <EmptyState title="No hits" />;
  return (
    <>
      <div className={clsx(dbStyles.toolbar, css.gridBar)}>
        <span className={dbStyles.spacer} />
        <ExtractorSelect driver="elasticsearch" />
        <PanelToggle panel={panel} onChange={setPanel} />
      </div>
      <div className={clsx(dbStyles.fill, dbStyles.gridHost)}>
        <DataView
          aria-label={tx("Hits")}
          columns={gridColumns}
          rowCount={rows.length}
          value={(r, c) => rows[r]?.[c] ?? null}
          target={{ table: index || "hits", driver: "elasticsearch" }}
          view={view}
          panel={panel}
          onPanelChange={setPanel}
        />
      </div>
    </>
  );
}
