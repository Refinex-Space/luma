/**
 * A Redis console reply in its `Result N` tab: scalars as an index / value grid, pairs
 * (`HGETALL`, `CONFIG GET`, maps, `… WITHSCORES`) as a two-column grid, nested replies as
 * an expandable tree like `redis-cli` prints them, strings as text or pretty JSON.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { highlightInto } from "@/editor/lsp/markdown";
import type { RedisCommandOutcome, RedisReply } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { IconButton, Tree, copyText, showContextMenu } from "@/ui";
import { copySelectionOnKeyDown } from "@/ui/selectableText";
import {
  DataView,
  ExtractorSelect,
  PanelToggle,
  exportMenu,
  shownData,
  useGridView,
  viewMenu,
  type DataPanel,
} from "../../DataView";
import type { ExportData } from "../../export";
import { bytesLabel, splitRedisTarget } from "../model";
import { sourceById } from "../../store";
import { byteLength, cellText, cliText, isAggregate, jsonContainer, replyLayout, type ReplyLayout } from "./reply";
import { splitLine } from "./parse";
import dbStyles from "../../Database.module.css";
import styles from "./RedisConsole.module.css";

const NIL: RedisReply = { kind: "nil" };

/** `name: db0`, the data source and database a reply came from. */
function sourceText(target: string): string {
  const { id, db } = splitRedisTarget(target);
  return `${sourceById(id)?.name ?? id}: db${db}`;
}

function Source({ outcome, target }: { outcome: RedisCommandOutcome; target: string }) {
  return (
    <span className={dbStyles.resultSource} title={outcome.text}>
      {sourceText(target)}
    </span>
  );
}

export function RedisReplyView({ outcome, target }: { outcome: RedisCommandOutcome; target: string }) {
  const reply = outcome.reply ?? NIL;
  const layout = useMemo(() => replyLayout(reply, outcome.text), [reply, outcome.text]);
  if (layout.kind === "text") return <TextReply reply={reply} outcome={outcome} target={target} />;
  if (layout.kind === "tree") return <TreeReply reply={reply} outcome={outcome} target={target} />;
  return <GridReply reply={reply} layout={layout} outcome={outcome} target={target} />;
}

// ---- text ------------------------------------------------------------------------------

function TextReply({ reply, outcome, target }: { reply: RedisReply; outcome: RedisCommandOutcome; target: string }) {
  const raw = reply.kind === "bulk" ? bytesLabel(reply.value) : reply.kind === "verbatim" ? reply.text : cliText(reply);
  const textual = (reply.kind === "bulk" && !reply.value.binary) || reply.kind === "verbatim";
  const json = useMemo(() => (textual ? jsonContainer(raw) : undefined), [textual, raw]);
  const [mode, setMode] = useState<"text" | "json">(json !== undefined ? "json" : "text");
  const [wrap, setWrap] = useState(true);
  const pretty = mode === "json" && json !== undefined;
  const shown = useMemo(() => (pretty ? JSON.stringify(json, null, 2) : raw), [pretty, json, raw]);
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = shown;
    if (!pretty) return;
    // Highlighted off-screen: switching back to Text meanwhile must win.
    let current = true;
    const colored = document.createElement("pre");
    void highlightInto(colored, shown, "JSON").then(() => {
      if (current && colored.childNodes.length) el.replaceChildren(...colored.childNodes);
    });
    return () => {
      current = false;
    };
  }, [shown, pretty]);
  const bytes = reply.kind === "bulk" ? byteLength(reply.value) : null;
  return (
    <div className={dbStyles.view}>
      <div className={dbStyles.toolbar}>
        <IconButton icon="file-text" title="Text" aria-pressed={!pretty} onClick={() => setMode("text")} />
        <IconButton
          icon="file-json"
          title="JSON"
          aria-pressed={pretty}
          disabled={json === undefined}
          onClick={() => setMode("json")}
        />
        <span className={dbStyles.toolbarSeparator} />
        <IconButton icon="soft-wrap" title="Soft-Wrap" aria-pressed={wrap} onClick={() => setWrap((w) => !w)} />
        <IconButton icon="copy" title="Copy" onClick={() => void copyText(shown)} />
        <span className={dbStyles.spacer} />
        {bytes !== null && <span className={styles.size}>{sizeText(bytes)}</span>}
        <Source outcome={outcome} target={target} />
      </div>
      <pre
        ref={ref}
        className={clsx(styles.text, wrap && styles.wrap)}
        tabIndex={0}
        onKeyDown={copySelectionOnKeyDown}
        aria-label={outcome.text}
      />
    </div>
  );
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

// ---- grids -----------------------------------------------------------------------------

/** What SQL extractors name the "table": the command's key, else the command. */
function exportTable(text: string): string {
  const words = splitLine(text).words.map((w) => w.value.text);
  return (words[1] ?? words[0] ?? "redis").replace(/[^\w.-]+/g, "_") || "redis";
}

function GridReply({
  reply,
  layout,
  outcome,
  target,
}: {
  reply: RedisReply;
  layout: Extract<ReplyLayout, { kind: "list" | "pairs" }>;
  outcome: RedisCommandOutcome;
  target: string;
}) {
  const [panel, setPanel] = useState<DataPanel | null>(null);
  const rows = useMemo((): Array<readonly (string | null)[]> => {
    if (layout.kind === "pairs") return layout.rows;
    const items = reply.kind === "array" || reply.kind === "set" ? reply.items : [];
    return items.map((r, i) => [String(i), cellText(r)]);
  }, [layout, reply]);
  const columns = useMemo(
    () =>
      layout.kind === "list"
        ? [
            { name: layout.columns[0], type: "integer" },
            { name: layout.columns[1], type: "" },
          ]
        : layout.columns.map((name) => ({ name, type: "" })),
    [layout],
  );
  const view = useGridView(columns);
  const value = useCallback((row: number, col: number) => rows[row]?.[col] ?? null, [rows]);
  const exportTarget = { table: exportTable(outcome.text), driver: "redis" as const };
  const data = (): ExportData => shownData({ ...exportTarget, columns, rows }, view);
  const shown = rows.length;
  const count = shown.toLocaleString("en");
  return (
    <div className={dbStyles.view}>
      <div className={dbStyles.toolbar}>
        <IconButton icon="copy" title="Copy as redis-cli Output" onClick={() => void copyText(cliText(reply))} />
        <IconButton
          icon="settings"
          title="View Options"
          aria-haspopup="menu"
          onClick={(e) => showContextMenu(e, viewMenu(view, columns))}
        />
        <span className={dbStyles.spacer} />
        <Source outcome={outcome} target={target} />
        <ExtractorSelect driver="redis" />
        <IconButton
          icon="export"
          title="Export Data"
          aria-haspopup="menu"
          onClick={(e) => showContextMenu(e, exportMenu(data(), exportTarget.table))}
        />
        <PanelToggle panel={panel} onChange={setPanel} />
      </div>
      <div className={clsx(dbStyles.fill, dbStyles.gridHost)}>
        <DataView
          columns={columns}
          rowCount={rows.length}
          value={value}
          target={exportTarget}
          view={view}
          panel={panel}
          onPanelChange={setPanel}
          aria-label={outcome.text}
        />
        <div className={dbStyles.rowPill} role="status">
          {shown === 1 ? tx`${shown} row` : tx`${count} rows`}
        </div>
      </div>
    </div>
  );
}

// ---- tree ------------------------------------------------------------------------------

interface ReplyNode {
  key: string;
  /** `1)`, `1~` (set), `1#` (map). */
  mark: string;
  /** A map entry's key. */
  name: RedisReply | null;
  reply: RedisReply;
  children?: ReplyNode[];
}

function childrenOf(r: RedisReply, parent: string): ReplyNode[] {
  if (r.kind === "map") return r.entries.map((e, i) => replyNode(`${parent}/${i}`, `${i + 1}#`, e.key, e.value));
  if (r.kind === "array" || r.kind === "set") {
    const mark = r.kind === "set" ? "~" : ")";
    return r.items.map((item, i) => replyNode(`${parent}/${i}`, `${i + 1}${mark}`, null, item));
  }
  return [];
}

function replyNode(key: string, mark: string, name: RedisReply | null, reply: RedisReply): ReplyNode {
  return { key, mark, name, reply, children: isAggregate(reply) ? childrenOf(reply, key) : undefined };
}

const MAX_SHOWN = 400;

function Scalar({ r }: { r: RedisReply }) {
  const text = cliText(r);
  const shown = text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}…` : text;
  const cls =
    r.kind === "bulk" || r.kind === "verbatim"
      ? styles.string
      : r.kind === "int" || r.kind === "double"
        ? styles.number
        : r.kind === "bool"
          ? styles.keyword
          : r.kind === "nil"
            ? styles.nil
            : r.kind === "error"
              ? styles.error
              : undefined;
  return <span className={cls}>{shown.replace(/\n/g, "↵")}</span>;
}

function kindText(r: RedisReply): string {
  if (r.kind === "map") return `map [${r.entries.length}]`;
  if (r.kind === "array" || r.kind === "set") return `${r.kind} [${r.items.length}]`;
  return "";
}

function collectKeys(nodes: readonly ReplyNode[], out: string[] = [], limit = 5000): string[] {
  for (const n of nodes) {
    if (out.length >= limit) break;
    if (n.children?.length) {
      out.push(n.key);
      collectKeys(n.children, out, limit);
    }
  }
  return out;
}

function TreeReply({ reply, outcome, target }: { reply: RedisReply; outcome: RedisCommandOutcome; target: string }) {
  const roots = useMemo(() => childrenOf(reply, "r"), [reply]);
  const all = useMemo(() => collectKeys(roots), [roots]);
  // The first level opens; a small reply opens entirely.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(all.length <= 50 ? all : roots.filter((n) => n.children?.length).map((n) => n.key)),
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const copyNode = (n: ReplyNode) => void copyText(n.children ? cliText(n.reply) : (cellText(n.reply) ?? ""));
  return (
    <div className={dbStyles.view}>
      <div className={dbStyles.toolbar}>
        <IconButton icon="expand-all" title="Expand All" onClick={() => setExpanded(new Set(all))} />
        <IconButton icon="collapse-all" title="Collapse All" onClick={() => setExpanded(new Set())} />
        <span className={dbStyles.toolbarSeparator} />
        <IconButton icon="copy" title="Copy as redis-cli Output" onClick={() => void copyText(cliText(reply))} />
        <span className={dbStyles.spacer} />
        <Source outcome={outcome} target={target} />
      </div>
      <Tree<ReplyNode>
        className={styles.tree}
        aria-label={outcome.text}
        roots={roots}
        getKey={(n) => n.key}
        getLabel={(n) => (n.children ? (n.name ? (cellText(n.name) ?? "") : "") : (cellText(n.reply) ?? ""))}
        getChildren={(n) => n.children}
        isExpandable={(n) => !!n.children?.length}
        expanded={expanded}
        onExpandedChange={setExpanded}
        selected={selected}
        onSelectionChange={setSelected}
        horizontalScroll
        onContextMenu={(n, _sel, e) =>
          n &&
          showContextMenu(e, [
            { label: "Copy Value", icon: "copy", run: () => copyNode(n) },
            ...(n.name ? [{ label: "Copy Key", run: () => void copyText(cellText(n.name!) ?? "") }] : []),
          ])
        }
        renderNode={(n) => (
          <span className={styles.node}>
            <span className={styles.mark}>{n.mark}</span>
            {n.name && (
              <>
                <Scalar r={n.name} />
                <span className={styles.arrow}>=&gt;</span>
              </>
            )}
            {n.children ? <span className={styles.kind}>{kindText(n.reply)}</span> : <Scalar r={n.reply} />}
          </span>
        )}
      />
    </div>
  );
}
