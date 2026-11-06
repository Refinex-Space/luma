/**
 * A read-only JSON viewer (Discover's documents, the console's responses): syntax-coloured
 * like the editor, objects and arrays fold (a folded one reads `{…} 3 keys` / `[…] 5 items`),
 * children are built only once their parent is open and long arrays / objects show their
 * first entries with the rest a click away. Right click: copy the value or its path, fold or
 * unfold everything under it. Arrows move between lines, ←/→ fold and unfold.
 */
import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import clsx from "clsx";
import { tx } from "@/platform/i18n";
import { copyText, showContextMenu, type MenuItem } from "@/ui";
import css from "./JsonView.module.css";

export type JsonPath = ReadonlyArray<string | number>;

export interface JsonViewProps {
  value: unknown;
  /** Levels open at first (the root is level 0). */
  expandDepth?: number;
  /** Entries a container shows before “more”. */
  pageSize?: number;
  className?: string;
  "aria-label"?: string;
}

type Row =
  | {
      kind: "value";
      id: string;
      path: JsonPath;
      depth: number;
      name: string | number | null;
      value: unknown;
      comma: boolean;
    }
  | {
      kind: "open";
      id: string;
      path: JsonPath;
      depth: number;
      name: string | number | null;
      value: unknown;
      array: boolean;
    }
  | { kind: "close"; id: string; path: JsonPath; depth: number; array: boolean; comma: boolean }
  | { kind: "more"; id: string; path: JsonPath; depth: number; hidden: number };

const isContainer = (v: unknown): v is object => typeof v === "object" && v !== null;
const entriesOf = (v: object): Array<[string | number, unknown]> =>
  Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v as Record<string, unknown>);
const idOf = (path: JsonPath) => JSON.stringify(path);

/** `hits.hits[0]._source["user name"]`: the path as code reads it. */
export function jsonPathText(path: JsonPath): string {
  let out = "";
  for (const p of path) {
    if (typeof p === "number") out += `[${p}]`;
    else if (/^[A-Za-z_$@][\w$@]*$/.test(p)) out += out ? `.${p}` : p;
    else out += `[${JSON.stringify(p)}]`;
  }
  return out;
}

/** What Copy Value puts on the clipboard: text as is, anything else as (pretty) JSON. */
export function jsonCopyText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined) return "";
  return JSON.stringify(v, null, 2);
}

/** The visible lines: open containers list their children (the first `limit` of them). */
export function jsonRows(
  value: unknown,
  isOpen: (id: string, depth: number) => boolean,
  limitOf: (id: string) => number,
): Row[] {
  const rows: Row[] = [];
  const walk = (v: unknown, path: JsonPath, depth: number, name: string | number | null, comma: boolean) => {
    const id = idOf(path);
    if (!isContainer(v) || !isOpen(id, depth) || !entriesOf(v).length) {
      rows.push({ kind: "value", id, path, depth, name, value: v, comma });
      return;
    }
    const array = Array.isArray(v);
    rows.push({ kind: "open", id, path, depth, name, value: v, array });
    const entries = entriesOf(v);
    const shown = Math.min(entries.length, limitOf(id));
    for (let i = 0; i < shown; i++) {
      const [k, x] = entries[i]!;
      walk(x, [...path, k], depth + 1, array ? null : k, i < entries.length - 1);
    }
    if (shown < entries.length)
      rows.push({ kind: "more", id: `${id}#more`, path, depth: depth + 1, hidden: entries.length - shown });
    rows.push({ kind: "close", id: `${id}#close`, path, depth, array, comma });
  };
  walk(value, [], 0, null, false);
  return rows;
}

function Scalar({ value }: { value: unknown }) {
  if (typeof value === "string") return <span className={css.string}>{JSON.stringify(value)}</span>;
  if (typeof value === "number" || typeof value === "bigint")
    return <span className={css.number}>{String(value)}</span>;
  if (typeof value === "boolean" || value === null) return <span className={css.keyword}>{String(value)}</span>;
  if (value === undefined) return <span className={css.keyword}>undefined</span>;
  return <span>{String(value)}</span>;
}

function Summary({ value }: { value: object }) {
  const array = Array.isArray(value);
  const n = array ? value.length : Object.keys(value).length;
  if (!n) return <span className={css.punct}>{array ? "[]" : "{}"}</span>;
  return (
    <>
      <span className={css.punct}>{array ? "[" : "{"}</span>
      <span className={css.ellipsis}>…</span>
      <span className={css.punct}>{array ? "]" : "}"}</span>
      <span className={css.count}>
        {array ? (n === 1 ? tx("1 item") : tx`${n} items`) : n === 1 ? tx("1 key") : tx`${n} keys`}
      </span>
    </>
  );
}

export function JsonView({ value, expandDepth = 1, pageSize = 100, className, ...aria }: JsonViewProps) {
  // Folding the user chose, over the default (open below `expandDepth`).
  const [folds, setFolds] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [limits, setLimits] = useState<ReadonlyMap<string, number>>(new Map());
  const [active, setActive] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const rows = useMemo(
    () =>
      jsonRows(
        value,
        (id, depth) => folds.get(id) ?? depth < expandDepth,
        (id) => limits.get(id) ?? pageSize,
      ),
    [value, folds, limits, expandDepth, pageSize],
  );

  const setOpen = (ids: Iterable<string>, open: boolean) =>
    setFolds((m) => {
      const next = new Map(m);
      for (const id of ids) next.set(id, open);
      return next;
    });

  /** Every container under `v` (its own path first). */
  const containersUnder = (v: unknown, path: JsonPath, out: string[] = [], budget = { n: 5000 }) => {
    if (!isContainer(v) || budget.n-- <= 0) return out;
    out.push(idOf(path));
    for (const [k, x] of entriesOf(v)) containersUnder(x, [...path, k], out, budget);
    return out;
  };

  const menu = (row: Row): MenuItem[] => {
    if (row.kind === "more") return [];
    const v = row.kind === "close" ? valueAt(value, row.path) : row.value;
    const items: MenuItem[] = [
      { label: "Copy Value", icon: "copy", run: () => void copyText(jsonCopyText(v)) },
      {
        label: "Copy Path",
        disabled: !row.path.length,
        run: () => void copyText(jsonPathText(row.path)),
      },
    ];
    if (isContainer(v))
      items.push(
        { kind: "separator" },
        { label: "Expand All", icon: "expand-all", run: () => setOpen(containersUnder(v, row.path), true) },
        { label: "Collapse All", icon: "collapse-all", run: () => setOpen(containersUnder(v, row.path), false) },
      );
    return items;
  };

  const toggle = (row: Row) => {
    if (row.kind === "open") setOpen([row.id], false);
    else if (row.kind === "close") setOpen([idOf(row.path)], false);
    else if (row.kind === "value" && isContainer(row.value)) setOpen([row.id], true);
  };

  const containerId = (row: Row) => (row.kind === "close" ? idOf(row.path) : row.id);

  const onKeyDown = (e: KeyboardEvent) => {
    const at = rows.findIndex((r) => r.id === active);
    const row = rows[at];
    const move = (i: number) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (!r) return;
      setActive(r.id);
      root.current?.querySelector(`[data-row="${CSS.escape(r.id)}"]`)?.scrollIntoView({ block: "nearest" });
    };
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at < 0 ? 0 : at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(rows.length - 1);
    else if (e.key === "ArrowRight" && row?.kind === "value" && isContainer(row.value)) setOpen([row.id], true);
    else if (e.key === "ArrowLeft" && row && (row.kind === "open" || row.kind === "close")) {
      setOpen([containerId(row)], false);
      setActive(containerId(row));
    } else if (e.key === "ArrowLeft" && row && row.path.length) {
      const parent = idOf(row.path.slice(0, -1));
      if (rows.some((r) => r.id === parent)) setActive(parent);
    } else if ((e.key === "Enter" || e.key === " ") && row) {
      if (row.kind === "more")
        setLimits((m) => new Map(m).set(idOf(row.path), (m.get(idOf(row.path)) ?? pageSize) + pageSize * 10));
      else toggle(row);
    } else if (mod && e.key.toLowerCase() === "c" && row && !window.getSelection()?.toString()) {
      void copyText(
        jsonCopyText(row.kind === "close" ? valueAt(value, row.path) : row.kind === "more" ? undefined : row.value),
      );
    } else return;
    e.preventDefault();
  };

  return (
    <div
      ref={root}
      className={clsx(css.json, className)}
      role="tree"
      aria-label={tx(aria["aria-label"] ?? "JSON")}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={() => {
        if (!active && rows[0]) setActive(rows[0].id);
      }}
    >
      {rows.map((row) => {
        const open = row.kind === "open";
        const foldable = open || (row.kind === "value" && isContainer(row.value) && entriesOf(row.value).length > 0);
        const onContext = (e: MouseEvent) => {
          e.preventDefault();
          setActive(row.id);
          const items = menu(row);
          if (items.length) showContextMenu(e, items);
        };
        return (
          <div
            key={row.id}
            data-row={row.id}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-expanded={foldable ? open : undefined}
            aria-selected={row.id === active}
            className={clsx(css.row, row.id === active && css.active)}
            style={{ paddingLeft: 4 + row.depth * 16 }}
            onMouseDown={() => setActive(row.id)}
            onContextMenu={onContext}
          >
            <span className={css.gutter}>
              {foldable && (
                <button
                  type="button"
                  tabIndex={-1}
                  className={clsx(css.chevron, open && css.chevronOpen)}
                  aria-label={open ? tx("Collapse") : tx("Expand")}
                  onClick={() => toggle(row)}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                    <path
                      d="M3.5 2 L6.5 5 L3.5 8"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )}
            </span>
            {row.kind === "more" ? (
              <button
                type="button"
                className={css.more}
                onClick={() =>
                  setLimits((m) => new Map(m).set(idOf(row.path), (m.get(idOf(row.path)) ?? pageSize) + pageSize * 10))
                }
              >
                {moreLabel(row.hidden)}
              </button>
            ) : row.kind === "close" ? (
              <span className={css.punct}>
                {row.array ? "]" : "}"}
                {row.comma && ","}
              </span>
            ) : (
              <span className={css.line} onDoubleClick={foldable ? () => toggle(row) : undefined}>
                {row.name !== null && (
                  <>
                    <span className={css.key}>{JSON.stringify(row.name)}</span>
                    <span className={css.punct}>: </span>
                  </>
                )}
                {open ? (
                  <span className={css.punct}>{(row as { array: boolean }).array ? "[" : "{"}</span>
                ) : isContainer(row.value) ? (
                  <Summary value={row.value} />
                ) : (
                  <Scalar value={row.value} />
                )}
                {row.kind === "value" && row.comma && <span className={css.punct}>,</span>}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function moreLabel(hidden: number): string {
  const count = hidden.toLocaleString("en");
  return tx`${count} more…`;
}

function valueAt(root: unknown, path: JsonPath): unknown {
  let cur = root;
  for (const p of path) cur = isContainer(cur) ? (cur as Record<string | number, unknown>)[p] : undefined;
  return cur;
}
