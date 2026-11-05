/**
 * The Redis Browser: one editor tab per database, as RedisInsight's Browser and DataGrip's
 * Redis view. A toolbar (database, key filter by pattern and type, refresh, new key,
 * server information, Pub/Sub, command line), the key list beside the selected key's
 * value (`RedisKeyView`), and a collapsible command line underneath.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import clsx from "clsx";
import { tx } from "@/platform/i18n";
import { registerKeyClaim } from "@/platform/keymap";
import { Button, EmptyState, Icon, IconButton, Input, Select, T, type SelectOption } from "@/ui";
import { editorService, type EditorInput } from "@/workbench/contributions";
import { useDatabase } from "../../store";
import { RedisKeyView } from "../KeyEditor";
import { KIND_META, keyId, redisBrowserInput, redisTarget, splitRedisTarget, type RedisBrowserRef } from "../model";
import {
  keyRenamed,
  loadKeys,
  loadKeyspace,
  openBrowser,
  openKeyTab,
  openPubSub,
  openRedisDialog,
  openServerInfo,
  selectBrowserKey,
  useRedis,
} from "../store";
import { KeyList } from "./KeyList";
import { RedisCli, type RedisCliHandle } from "./RedisCli";
import { CLI_MIN, KEYS_MIN, setLayout, useBrowserUi } from "./state";
import css from "./RedisBrowser.module.css";

/** Typing settles this long before the keys are scanned again. */
const FILTER_DELAY = 250;
/** Room the key list and the value keep beside / above the panes being resized. */
const DETAIL_MIN = 360;
const MAIN_MIN = 160;

/** A `SCAN … MATCH` pattern: a glob as typed, other text as a substring (`*text*`). */
export function keyFilterPattern(text: string): string {
  const t = text.trim();
  if (!t) return "*";
  if (/[*?[]/.test(t)) return t;
  return `*${t.replace(/[\\\]]/g, "\\$&")}*`;
}

/** What the filter field shows for a pattern (a substring's stars dropped). */
function filterText(pattern: string): string {
  if (pattern === "*") return "";
  const m = /^\*([^*?[]*)\*$/.exec(pattern);
  return m ? m[1]!.replace(/\\(.)/g, "$1") : pattern;
}

/** Drags `onMove(delta)` from a pointer down; `onEnd` once released. */
function dragFrom(e: PointerEvent, axis: "x" | "y", onMove: (delta: number) => void, onEnd: () => void) {
  e.preventDefault();
  const el = e.currentTarget as HTMLElement;
  const start = axis === "x" ? e.clientX : e.clientY;
  el.setPointerCapture(e.pointerId);
  const move = (ev: globalThis.PointerEvent) => onMove((axis === "x" ? ev.clientX : ev.clientY) - start);
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

export function RedisBrowser({ input }: { input: EditorInput }) {
  const { target } = input.data as RedisBrowserRef;
  const { id, db } = splitRedisTarget(target);
  const source = useDatabase((s) => s.sources.find((x) => x.id === id));
  const loaded = useDatabase((s) => s.loaded);
  if (!source)
    return loaded ? <EmptyState title="This data source no longer exists" /> : <EmptyState title="Loading…" />;
  return <Browser key={target} target={target} id={id} db={db} readOnly={!!source.readOnly} inputKey={input.key} />;
}

function Browser(props: { target: string; id: string; db: number; readOnly: boolean; inputKey: string }) {
  const { target, id, db, readOnly, inputKey } = props;
  const list = useRedis((s) => s.browserKeys[target]);
  const keyspace = useRedis((s) => s.keyspace[id]);
  const shown = useRedis((s) => s.browserKey[target] ?? null);
  const reload = useBrowserUi((s) => s.reload[target] ?? 0);
  const { flat, cliOpen, cliHeight, keysWidth } = useBrowserUi();
  const root = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  const cli = useRef<RedisCliHandle>(null);

  useEffect(() => {
    const s = useRedis.getState();
    if (!s.browserKeys[target]) void loadKeys(target, { list: "browser" });
    if (!s.keyspace[id]) void loadKeyspace(id);
  }, [target, id]);

  // ---- filter ---------------------------------------------------------------------------
  const [filter, setFilter] = useState(() => filterText(list?.pattern ?? "*"));
  const type = list?.type ?? null;
  const applied = useRef(list?.pattern ?? "*");
  const applyFilter = (text: string, now = false) => {
    setFilter(text);
    const pattern = keyFilterPattern(text);
    window.clearTimeout(filterTimer.current);
    const go = () => {
      if (pattern === applied.current) return;
      applied.current = pattern;
      void loadKeys(target, { list: "browser", pattern });
    };
    if (now) go();
    else filterTimer.current = window.setTimeout(go, FILTER_DELAY);
  };
  const filterTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(filterTimer.current), []);

  // ---- databases and types --------------------------------------------------------------
  const databases = useMemo((): SelectOption[] => {
    const dbs = keyspace?.status === "ok" ? keyspace.value.databases : [];
    const options = dbs.map((d) => {
      const keys = (d.keys ?? 0).toLocaleString("en");
      return { value: String(d.index), label: `db${d.index}`, detail: d.keys ? tx`${keys} keys` : undefined };
    });
    if (!options.some((o) => o.value === String(db)))
      options.unshift({ value: String(db), label: `db${db}`, detail: undefined });
    return options;
  }, [keyspace, db]);
  const total = keyspace?.status === "ok" ? (keyspace.value.databases.find((d) => d.index === db)?.keys ?? 0) : null;
  const types = useMemo(
    (): SelectOption[] => [
      { value: "", label: "All Types" },
      ...Object.entries(KIND_META).map(([value, m]) => ({ value, label: m.label })),
    ],
    [],
  );

  const switchDatabase = (n: number) => {
    if (n === db) return;
    const next = redisTarget(id, n);
    const open = editorService()
      .openTabs?.()
      .some((t) => t.input.key === redisBrowserInput(next).key);
    openBrowser(next);
    // The picker moves this tab to the other database (unless that one has a tab already).
    if (!open) void editorService().closeInput?.(inputKey);
  };

  const refresh = () => {
    void loadKeyspace(id);
    void loadKeys(target, { list: "browser" });
  };

  // ---- command line ---------------------------------------------------------------------
  const toggleCli = (focus = true) => {
    const open = !useBrowserUi.getState().cliOpen;
    setLayout({ cliOpen: open });
    if (open && focus) requestAnimationFrame(() => cli.current?.focus());
  };
  const insert = (text: string) => {
    if (!useBrowserUi.getState().cliOpen) setLayout({ cliOpen: true });
    requestAnimationFrame(() => cli.current?.insert(text));
  };

  // ⌘F filters keys, ⌃` opens / closes the command line, ⌘R refreshes: here, not app-wide.
  useEffect(
    () =>
      registerKeyClaim((e) => {
        if (!root.current?.contains(e.target as Node)) return false;
        const mod = e.metaKey || e.ctrlKey;
        if (e.ctrlKey && !e.metaKey && e.code === "Backquote") return true;
        return mod && !e.altKey && !e.shiftKey && ["f", "r"].includes(e.key.toLowerCase());
      }),
    [],
  );
  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.ctrlKey && !e.metaKey && e.code === "Backquote") {
      e.preventDefault();
      toggleCli();
    } else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      filterInput.current?.focus();
      filterInput.current?.select();
    } else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "r") {
      e.preventDefault();
      refresh();
    }
  };

  // ---- resizing -------------------------------------------------------------------------
  const [dragging, setDragging] = useState(false);
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const [liveHeight, setLiveHeight] = useState<number | null>(null);
  const width = liveWidth ?? keysWidth;
  const height = liveHeight ?? cliHeight;
  const resizeKeys = (e: PointerEvent) => {
    const max = (main.current?.clientWidth ?? 1000) - DETAIL_MIN;
    const start = keysWidth;
    let last = start;
    setDragging(true);
    dragFrom(
      e,
      "x",
      (d) => setLiveWidth((last = Math.max(KEYS_MIN, Math.min(max, start + d)))),
      () => {
        setLayout({ keysWidth: last });
        setLiveWidth(null);
        setDragging(false);
      },
    );
  };
  const resizeCli = (e: PointerEvent) => {
    const max = (root.current?.clientHeight ?? 600) - MAIN_MIN;
    const start = cliHeight;
    let last = start;
    setDragging(true);
    dragFrom(
      e,
      "y",
      (d) => setLiveHeight((last = Math.max(CLI_MIN, Math.min(max, start - d)))),
      () => {
        setLayout({ cliHeight: last });
        setLiveHeight(null);
        setDragging(false);
      },
    );
  };

  const empty = list?.done && !list.keys.length && list.pattern === "*" && list.type === null;
  return (
    <div
      ref={root}
      className={clsx(css.browser, dragging && css.dragging)}
      style={{ "--keys-w": `${width}px`, "--cli-h": `${height}px` } as CSSProperties}
      onKeyDown={onKeyDown}
    >
      <div className={css.bar} role="toolbar" aria-label={tx("Redis Browser")}>
        <Select
          aria-label="Database"
          value={String(db)}
          options={databases}
          searchable={databases.length > 16}
          onChange={(v) => switchDatabase(Number(v))}
          className={css.dbPicker}
        />
        <label className={css.filter}>
          <Icon name="search" size={14} />
          <Input
            ref={filterInput}
            variant="bare"
            mono
            aria-label="Filter keys"
            placeholder={tx("Filter keys: user:* or any text")}
            value={filter}
            spellCheck={false}
            onChange={(e) => applyFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyFilter(filter, true);
              if (e.key === "Escape" && filter) {
                e.preventDefault();
                e.stopPropagation();
                applyFilter("", true);
              }
            }}
          />
          {filter && (
            <IconButton
              icon="close"
              title="Clear"
              size="small"
              iconSize={12}
              tabIndex={-1}
              onClick={() => applyFilter("", true)}
            />
          )}
          <span className={css.filterSep} />
          <Select
            aria-label="Key type"
            variant="ghost"
            value={type ?? ""}
            options={types}
            onChange={(v) => void loadKeys(target, { list: "browser", type: v || null })}
            className={css.typePicker}
          />
        </label>
        <IconButton icon="refresh" title="Refresh" shortcut="⌘R" onClick={refresh} />
        <IconButton
          icon="list"
          title="Flat List"
          pressed={flat}
          onClick={() => setLayout({ flat: !useBrowserUi.getState().flat })}
        />
        {!readOnly && (
          <>
            <span className={css.barSep} />
            <Button
              size="small"
              variant="primary"
              onClick={() => openRedisDialog({ kind: "newKey", target, prefix: "" })}
            >
              <Icon name="plus" size={14} />
              <T>New Key</T>
            </Button>
          </>
        )}
        <span className={css.spacer} />
        <IconButton icon="db-chart" title="Server Information" onClick={() => openServerInfo(id)} />
        <IconButton icon="toolwindow-notifications" title="Pub/Sub" onClick={() => openPubSub(id)} />
        <IconButton icon="terminal" title="Command Line" shortcut="⌃`" pressed={cliOpen} onClick={() => toggleCli()} />
      </div>

      <div ref={main} className={css.main}>
        <KeyList
          target={target}
          list={list}
          total={total}
          readOnly={readOnly}
          onFilter={(pattern) => applyFilter(filterText(pattern), true)}
          onInsert={insert}
        />
        <div
          className={css.vResize}
          role="separator"
          aria-orientation="vertical"
          aria-label={tx("Resize")}
          onPointerDown={resizeKeys}
          onDoubleClick={() => setLayout({ keysWidth: 340 })}
        />
        <section className={css.detail} aria-label={tx("Value")}>
          {shown ? (
            <RedisKeyView
              key={`${target}|${keyId(shown)}`}
              target={target}
              keyBytes={shown}
              reload={reload}
              onRenamed={async (next) => {
                keyRenamed(target, shown, next);
                return true;
              }}
              onDeleted={async () => {
                selectBrowserKey(target, null);
                return true;
              }}
              actions={
                <IconButton icon="external-link" title="Open in New Tab" onClick={() => openKeyTab(target, shown)} />
              }
            />
          ) : empty && !readOnly ? (
            <EmptyState
              title="No keys"
              actions={
                <Button variant="ghost" onClick={() => openRedisDialog({ kind: "newKey", target, prefix: "" })}>
                  <T>New Key…</T>
                </Button>
              }
            />
          ) : (
            <EmptyState title="Select a key" />
          )}
        </section>
      </div>

      <section className={clsx(css.cli, !cliOpen && css.cliClosed)} aria-label={tx("Command Line")}>
        {cliOpen && (
          <div
            className={css.hResize}
            role="separator"
            aria-orientation="horizontal"
            aria-label={tx("Resize")}
            onPointerDown={resizeCli}
          />
        )}
        <RedisCli browser={target} open={cliOpen} onToggle={() => toggleCli()} handleRef={cli} />
      </section>
    </div>
  );
}
