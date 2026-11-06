/**
 * The Discover tab of an index pattern (Kibana's Discover, in the IDE's voice): a toolbar
 * (index pattern, query bar, time range, refresh, hits), the field list, the hits over time
 * and the documents, the open one beside them. Everything a tab shows is kept while it is
 * hidden (`state.ts`).
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import clsx from "clsx";
import { tx } from "@/platform/i18n";
import { registerKeyClaim } from "@/platform/keymap";
import { Button, EmptyState, IconButton, Spinner, T } from "@/ui";
import type { EditorInput } from "@/workbench/contributions";
import { useDatabase } from "../../store";
import type { EsDiscoverRef } from "../model";
import { fieldsOf, useFields } from "../store";
import { DocumentFlyout } from "./DocumentFlyout";
import { FieldSidebar } from "./FieldSidebar";
import { Histogram } from "./Histogram";
import { HitsTable } from "./HitsTable";
import { IndexPicker, TimePicker } from "./Pickers";
import { QueryBar, type QueryBarHandle } from "./QueryBar";
import { appendFilter, hitsLabel, timeFieldOf, type SortSpec, type TimeRange } from "./search";
import {
  FLYOUT_MIN,
  SIDEBAR_MIN,
  deleteDocument,
  docKey,
  ensureTab,
  loadMore,
  patchTab,
  runSearch,
  saveDocument,
  switchPattern,
  useDiscover,
  type QueryError,
} from "./state";
import css from "./Discover.module.css";

/** Room the documents keep beside the field list and the open document. */
const MAIN_MIN = 320;

export function EsDiscover({ input }: { input: EditorInput }) {
  const { id, index } = input.data as EsDiscoverRef;
  const source = useDatabase((s) => s.sources.find((x) => x.id === id));
  const loaded = useDatabase((s) => s.loaded);
  if (!source)
    return loaded ? <EmptyState title="This data source no longer exists" /> : <EmptyState title="Loading…" />;
  return <Discover key={input.key} tabKey={input.key} id={id} index={index} readOnly={!!source.readOnly} />;
}

function dragFrom(e: PointerEvent, onMove: (dx: number) => void, onEnd: () => void) {
  e.preventDefault();
  const el = e.currentTarget as HTMLElement;
  const start = e.clientX;
  el.setPointerCapture(e.pointerId);
  const move = (ev: globalThis.PointerEvent) => onMove(ev.clientX - start);
  const up = () => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", up);
    onEnd();
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
}

function Discover({ tabKey, id, index, readOnly }: { tabKey: string; id: string; index: string; readOnly: boolean }) {
  useState(() => ensureTab(tabKey, id, index));
  const tab = useDiscover((s) => s.tabs[tabKey])!;
  const loadedFields = useFields(id, index);
  const fields = useMemo(() => (loadedFields?.status === "ok" ? loadedFields.value : []), [loadedFields]);
  const byName = useMemo(() => new Map(fields.map((f) => [f.name, f])), [fields]);
  const timeField = useMemo(() => timeFieldOf(fields), [fields]);
  const root = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const queryBar = useRef<QueryBarHandle>(null);

  useEffect(() => {
    void fieldsOf(id, index).catch(() => {});
    if (useDiscover.getState().tabs[tabKey]?.status === "idle") void runSearch(tabKey);
  }, [tabKey, id, index]);

  const run = (p: Parameters<typeof patchTab>[1] = {}) => {
    patchTab(tabKey, p);
    void runSearch(tabKey);
  };
  const refresh = () => {
    void fieldsOf(id, index, true).catch(() => {});
    void runSearch(tabKey);
  };
  const toggleColumn = (field: string) =>
    patchTab(tabKey, (t) => ({
      columns: t.columns.includes(field) ? t.columns.filter((c) => c !== field) : [...t.columns, field],
    }));
  const moveColumn = (field: string, by: -1 | 1) =>
    patchTab(tabKey, (t) => {
      const at = t.columns.indexOf(field);
      const to = at + by;
      if (at < 0 || to < 0 || to >= t.columns.length) return {};
      const columns = [...t.columns];
      [columns[at], columns[to]] = [columns[to]!, columns[at]!];
      return { columns };
    });
  const filter = (field: string, value: unknown, negate: boolean) =>
    run((t) => ({ query: appendFilter(t.query, t.lang, field, value, negate) }));
  const setTime = (time: TimeRange) => run({ time });
  const setSort = (sort: SortSpec[]) => run({ sort });

  // ⌘R refreshes, ⌘F goes to the query: here, not app-wide.
  useEffect(
    () =>
      registerKeyClaim((e) => {
        if (!root.current?.contains(e.target as Node)) return false;
        const mod = e.metaKey || e.ctrlKey;
        return mod && !e.altKey && !e.shiftKey && ["f", "r"].includes(e.key.toLowerCase());
      }),
    [],
  );
  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || e.altKey || e.shiftKey) return;
    const k = e.key.toLowerCase();
    if (k === "r") {
      e.preventDefault();
      refresh();
    } else if (k === "f") {
      e.preventDefault();
      queryBar.current?.focus();
    }
  };

  // ---- resizing -------------------------------------------------------------------------
  const [live, setLive] = useState<{ side?: number; fly?: number } | null>(null);
  const sideW = live?.side ?? tab.sidebarWidth;
  const flyW = live?.fly ?? tab.flyoutWidth;
  const resize = (e: PointerEvent, which: "side" | "fly") => {
    const total = main.current?.clientWidth ?? 1200;
    const start = which === "side" ? tab.sidebarWidth : tab.flyoutWidth;
    const other = which === "side" ? (tab.open ? tab.flyoutWidth : 0) : tab.sidebarOpen ? tab.sidebarWidth : 0;
    const min = which === "side" ? SIDEBAR_MIN : FLYOUT_MIN;
    const max = Math.max(min, total - other - MAIN_MIN);
    let last = start;
    dragFrom(
      e,
      (dx) => {
        last = Math.round(Math.max(min, Math.min(max, start + (which === "side" ? dx : -dx))));
        setLive(which === "side" ? { side: last } : { fly: last });
      },
      () => {
        patchTab(tabKey, which === "side" ? { sidebarWidth: last } : { flyoutWidth: last });
        setLive(null);
      },
    );
  };

  const result = tab.result;
  const present = useMemo(() => {
    const out = new Set<string>();
    for (const r of result?.rows ?? []) for (const k of Object.keys(r)) out.add(k);
    return out;
  }, [result?.rows]);
  const openIndex = tab.open && result ? result.hits.findIndex((h) => docKey(h) === tab.open) : -1;
  const openHit = openIndex >= 0 ? result!.hits[openIndex]! : null;
  const loading = tab.status === "loading";
  const timeBased = !!timeField;

  const columns = [tab.sidebarOpen ? `${sideW}px 1px` : "", "minmax(0, 1fr)", openHit ? `1px ${flyW}px` : ""]
    .filter(Boolean)
    .join(" ");

  let body;
  if (tab.status === "error" && tab.error) body = <ErrorView error={tab.error} />;
  else if (!result) body = <div className={css.center}>{loading && <Spinner size={16} />}</div>;
  else if (!result.hits.length)
    body = (
      <EmptyState
        title="No results"
        actions={
          timeBased && tab.time.kind !== "all" ? (
            <Button variant="ghost" onClick={() => setTime({ kind: "all" })}>
              <T>Search All Time</T>
            </Button>
          ) : undefined
        }
      />
    );
  else
    body = (
      <HitsTable
        tabKey={tabKey}
        result={result}
        fields={byName}
        timeField={result.basis.timeField}
        columns={tab.columns}
        sort={tab.sort}
        widths={tab.widths}
        open={tab.open}
        loadingMore={tab.loadingMore}
        onOpen={(k) => patchTab(tabKey, { open: k })}
        onSort={setSort}
        onWidth={(field, w) => patchTab(tabKey, (t) => ({ widths: { ...t.widths, [field]: w } }))}
        onToggleColumn={toggleColumn}
        onMoveColumn={moveColumn}
        onFilter={filter}
        onLoadMore={() => void loadMore(tabKey)}
      />
    );

  return (
    <div ref={root} className={clsx(css.discover, live && css.dragging)} onKeyDown={onKeyDown}>
      <div className={css.bar} role="toolbar" aria-label={tx("Discover")}>
        <IconButton
          icon="panel-left"
          title="Fields"
          pressed={tab.sidebarOpen}
          onClick={() => patchTab(tabKey, (t) => ({ sidebarOpen: !t.sidebarOpen }))}
        />
        <IndexPicker id={id} value={index} onChange={(next) => switchPattern(tabKey, next)} />
        <QueryBar
          ref={queryBar}
          tabKey={tabKey}
          value={tab.query}
          lang={tab.lang}
          fields={fields}
          onChange={(query) => patchTab(tabKey, { query })}
          onLangChange={(lang) => run({ lang })}
          onSubmit={(query) => run({ query })}
          onClear={() => root.current?.querySelector<HTMLElement>("[role=grid]")?.focus()}
        />
        {timeBased && <TimePicker value={tab.time} onChange={setTime} />}
        <IconButton icon="refresh" title="Refresh" shortcut="⌘R" onClick={refresh} />
        <span className={css.hits} role="status" aria-live="polite">
          {loading ? <Spinner size={12} /> : null}
          {result && tab.status !== "error" && (
            <span className={css.hitsText}>
              <b>{hitsLabel(result.total, result.relation)}</b>{" "}
              {result.total === 1 && result.relation === "eq" ? tx("hit") : tx("hits")}
            </span>
          )}
        </span>
      </div>

      <div ref={main} className={css.main} style={{ gridTemplateColumns: columns } as CSSProperties}>
        {tab.sidebarOpen && (
          <>
            <FieldSidebar
              tabKey={tabKey}
              fields={fields}
              loading={!loadedFields || loadedFields.status === "loading"}
              error={loadedFields?.status === "error" ? loadedFields.message : null}
              present={present}
              columns={tab.columns}
              onToggleColumn={toggleColumn}
              onFilter={filter}
            />
            <div
              className={css.vResize}
              role="separator"
              aria-orientation="vertical"
              aria-label={tx("Resize")}
              onPointerDown={(e) => resize(e, "side")}
            />
          </>
        )}
        <section className={clsx(css.content, loading && result && css.reloading)} aria-label={tx("Documents")}>
          {loading && result && <span className={css.loadingBar} aria-hidden />}
          {timeBased && result?.buckets && result.interval && result.bounds && tab.status !== "error" && (
            <Histogram
              buckets={result.buckets}
              interval={result.interval}
              bounds={result.bounds}
              loading={loading}
              onZoom={(from, to) => setTime({ kind: "absolute", from, to })}
            />
          )}
          <div className={css.body}>{body}</div>
        </section>
        {openHit && result && (
          <>
            <div
              className={css.vResize}
              role="separator"
              aria-orientation="vertical"
              aria-label={tx("Resize")}
              onPointerDown={(e) => resize(e, "fly")}
            />
            <DocumentFlyout
              hit={openHit}
              row={result.rows[openIndex]!}
              position={openIndex}
              count={result.hits.length}
              fields={byName}
              columns={tab.columns}
              readOnly={readOnly}
              onStep={(by) => {
                const next = result.hits[openIndex + by];
                if (next) patchTab(tabKey, { open: docKey(next) });
              }}
              onClose={() => patchTab(tabKey, { open: null })}
              onToggleColumn={toggleColumn}
              onFilter={filter}
              onSave={(source) => saveDocument(tabKey, openHit, source)}
              onDelete={() => void deleteDocument(tabKey, openHit)}
            />
          </>
        )}
      </div>
    </div>
  );
}

function ErrorView({ error }: { error: QueryError }) {
  const r = error.range;
  return (
    <div className={css.error} role="alert">
      <div className={css.errorTitle}>{r ? tx("Invalid query") : tx("Search failed")}</div>
      {r && (
        <pre className={css.errorQuery}>
          {r.text.slice(0, r.from)}
          <span className={css.tkInvalid}>{r.text.slice(r.from, Math.max(r.to, r.from + 1)) || " "}</span>
          {r.text.slice(Math.max(r.to, r.from + 1))}
        </pre>
      )}
      <pre className={css.errorText}>{error.message}</pre>
    </div>
  );
}
