/**
 * Result / table data grid after IDEA's (`grid` module): virtualised rows, resizable
 * columns, rectangular cell selection (click, ⇧-click, drag, arrows, Home/End, Page Up/Down,
 * ⌘A, a header click selects the column), Copy through the current data extractor (a
 * single cell copies its value), `<null>` rendering, multi-column sorting from the header's
 * sort icon (⌥/⇧-click adds a key, the priority shows once several sort), IDEA's cell and
 * column header menus, and in-place editing (table editor).
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import { registerKeyClaim } from "@/platform/keymap";
import { Icon, showContextMenu, type MenuItem } from "@/ui";
import { copyText } from "@/ui/selectableText";
import { EXPORT_FORMATS, extractorOf } from "./export";
import { setCopyHeader, setExtractor, useGridPrefs } from "./gridPrefs";
import { parseDelimited, toTsv, type Cell } from "./model";
import { nextSort, type SortKey } from "./resultView";
import styles from "./Database.module.css";
import { tx } from "@/platform/i18n";

export interface GridColumn {
  name: string;
  type: string;
  primaryKey?: boolean;
  foreignKey?: boolean;
}

const NUMERIC_TYPE = /int|num|dec|real|float|double|money|serial|^bit$/i;
const NUMBER = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

/** Numbers are right-aligned (IDEA): by type, else when every sampled value is one. */
export function isNumericColumn(type: string, sample: readonly Cell[]): boolean {
  if (type && !/^(null|unknown)?$/i.test(type)) return NUMERIC_TYPE.test(type) && !/point|interval/i.test(type);
  const values = sample.filter((v): v is string => v !== null);
  return values.length > 0 && values.every((v) => NUMBER.test(v));
}

export type GridPanel = "record" | "value" | "aggregates";

export interface GridProps {
  columns: readonly GridColumn[];
  rowCount: number;
  /** Displayed value (pending edits applied). */
  value: (row: number, col: number) => Cell;
  rowState?: (row: number) => "deleted" | "inserted" | null;
  isModified?: (row: number, col: number) => boolean;
  editable?: boolean;
  /** With `editable`: whether a cell can change (a query result's expression columns cannot). */
  cellEditable?: (row: number, col: number) => boolean;
  onEdit?: (row: number, col: number, value: Cell) => void;
  /** The sort keys, the primary first; with `onSortChange` the header sorts. */
  sort?: readonly SortKey[];
  onSortChange?: (next: SortKey[]) => void;
  /** Row commands for the selected rows (Add / Clone / Delete Rows…), after Copy / Paste. */
  rowMenu?: (rows: number[]) => MenuItem[];
  /** Row header text (a row number; a column name when transposed). */
  rowLabel?: (row: number) => string;
  /** The selected range changed (the Record / Value / Aggregates panel follows it). */
  onSelectionChange?: (range: GridRange | null) => void;
  /** The header's filter button (IDEA's local filter); `filtered` marks the columns with one. */
  onFilter?: (col: number, anchor: HTMLElement) => void;
  filtered?: (col: number) => boolean;
  /** Text Copy puts on the clipboard for a block of cells (the current extractor). */
  extract?: (rows: number[], cols: number[]) => string;
  /** Local Filter by the selected values of a column. */
  onFilterBySelection?: (col: number, values: Cell[]) => void;
  onHideColumns?: (cols: number[]) => void;
  /** The first `pinned` columns stay in view while scrolling sideways (IDEA's pinned columns). */
  pinned?: number;
  /** Pin Columns (`true`) / Unpin Columns; `null` columns: Unpin All. */
  onPin?: (cols: number[] | null, pin: boolean) => void;
  /** Show All Columns, when some are hidden. */
  onShowAllColumns?: () => void;
  onOpenPanel?: (panel: GridPanel) => void;
  onRevert?: (rows: number[], cols: number[]) => void;
  onDeleteRows?: (rows: number[]) => void;
  onFind?: () => void;
  onGoToRow?: () => void;
  /** A cell's background tint (the heatmap), a CSS colour. */
  tint?: (row: number, col: number) => string | undefined;
  /** Find matches: highlighted, the current one stronger. */
  match?: (row: number, col: number) => "match" | "current" | null;
  /** Selects and scrolls to a cell (Find, Go to Row) when `seq` changes. */
  reveal?: { row: number; col: number; seq: number } | null;
  "aria-label"?: string;
}

/** A selected block of cells, inclusive; `lead` is the cell last moved to. */
export interface GridRange {
  top: number;
  bottom: number;
  left: number;
  right: number;
  lead: { row: number; col: number };
}

interface Sel {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

const ROW_H = 24;
const MIN_ROW_HEADER = 48;

/** Keystrokes a focused grid handles itself, ahead of the IDE keymap. */
const GRID_KEYS =
  /^((Meta|Ctrl)\+(C|V|A|F|L|Backspace|Delete|Home|End|ArrowUp|ArrowDown)|(Meta|Ctrl)\+Shift\+Enter|Shift\+Enter|Enter|F2|Home|End|PageUp|PageDown)$/;
let claimed = false;
function claimGridKeys() {
  if (claimed) return;
  claimed = true;
  registerKeyClaim(
    (e, stroke) =>
      GRID_KEYS.test(stroke) &&
      e.target instanceof Element &&
      e.target.matches("[data-db-grid]") &&
      // A cell editor's keys are its own.
      !e.target.closest("input, textarea"),
  );
}

/** Wide enough for the whole header (icon, name, filter, sort) and the longest sampled value. */
function initialWidth(c: GridColumn, sample: Cell[], decorations: number): number {
  // Icon, gaps and padding (≈40px) besides the name and the filter / sort buttons.
  const header = c.name.length * 8 + 40 + decorations;
  const longest = Math.max(...sample.map((v) => Math.min((v ?? "<null>").length, 60)), 0) * 7.5 + 20;
  return Math.max(64, Math.min(360, Math.max(header, longest)));
}

/** SQLite renders whole REALs as `3108.0`; IDEA shows `3108`. */
const displayed = (v: string, numeric: boolean) => (numeric && /^-?\d+\.0$/.test(v) ? v.slice(0, -2) : v);

function norm(s: Sel) {
  return {
    top: Math.min(s.r0, s.r1),
    bottom: Math.max(s.r0, s.r1),
    left: Math.min(s.c0, s.c1),
    right: Math.max(s.c0, s.c1),
  };
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

export function Grid(props: GridProps) {
  const { columns, rowCount, value, editable, onEdit, sort = [], onSortChange, rowMenu } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const extractor = useGridPrefs((s) => s.extractor);
  const copyHeader = useGridPrefs((s) => s.copyHeader);
  const dragging = useRef<"cells" | "rows" | "columns" | null>(null);
  useEffect(() => {
    claimGridKeys();
    const stop = () => {
      dragging.current = null;
    };
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  }, []);
  const [editing, setEditing] = useState<{ row: number; col: number; text: string } | null>(null);
  const columnKey = columns.map((c) => c.name).join("\u0000");
  // Widths and alignment by column name: pinning or hiding (another order) keeps them.
  const [measured, setMeasured] = useState<Record<string, { width: number; numeric: boolean }>>({});
  const measure = (ci: number, rows = Math.min(rowCount, 50)) => {
    const sample = Array.from({ length: rows }, (_, r) => value(r, ci));
    const decorations = (props.onFilter ? 20 : 0) + (onSortChange ? 26 : 0);
    return {
      width: initialWidth(columns[ci]!, sample, decorations),
      numeric: isNumericColumn(columns[ci]!.type, sample),
    };
  };
  const widths = useMemo(() => columns.map((c) => measured[c.name]?.width ?? 100), [columns, measured]);
  const numeric = useMemo(() => columns.map((c) => measured[c.name]?.numeric ?? false), [columns, measured]);
  const setWidths = (f: (w: number[]) => number[]) =>
    setMeasured((m) => {
      const next = f(columns.map((c) => m[c.name]?.width ?? 100));
      const out = { ...m };
      columns.forEach((c, i) => (out[c.name] = { numeric: m[c.name]?.numeric ?? false, width: next[i]! }));
      return out;
    });
  const columnSet = [...columns.map((c) => c.name)].sort().join("\u0000");
  useEffect(() => {
    setMeasured((m) => {
      const out = { ...m };
      columns.forEach((c, ci) => {
        if (!out[c.name]) out[c.name] = measure(ci);
      });
      return out;
    });
    // Measure the columns not measured yet (a new column set).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnKey]);
  useEffect(() => {
    // Another column set (a new result) starts without a selection; a new order keeps it out too.
    setSel(null);
    setEditing(null);
  }, [columnSet, columnKey]);

  const { onSelectionChange } = props;
  useEffect(() => {
    onSelectionChange?.(
      sel && rowCount ? { ...norm(sel), lead: { row: Math.min(sel.r1, rowCount - 1), col: sel.c1 } } : null,
    );
  }, [sel, rowCount, onSelectionChange]);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  // Row numbers (or transposed column names) set the row header's width.
  const rowHeaderWidth = useMemo(() => {
    if (!props.rowLabel) return Math.max(MIN_ROW_HEADER, String(rowCount).length * 8 + 16);
    let longest = 0;
    for (let r = 0; r < Math.min(rowCount, 500); r++) longest = Math.max(longest, props.rowLabel(r).length);
    return Math.max(MIN_ROW_HEADER, Math.min(240, longest * 7.5 + 20));
  }, [props, rowCount]);
  const totalWidth = useMemo(() => rowHeaderWidth + widths.reduce((a, b) => a + b, 0), [widths, rowHeaderWidth]);
  const pinned = Math.min(props.pinned ?? 0, columns.length);
  // Left offsets of the pinned columns (after the row header, itself pinned).
  const pinLeft = useMemo(() => {
    const out: number[] = [];
    let x = rowHeaderWidth;
    for (let c = 0; c < pinned; c++) {
      out.push(x);
      x += widths[c] ?? 0;
    }
    return out;
  }, [pinned, widths, rowHeaderWidth]);
  const pinStyle = (c: number) => (c < pinned ? { left: pinLeft[c] } : undefined);
  const tinted = (r: number, c: number) => !!props.tint?.(r, c);
  const cellStyle = (r: number, c: number): CSSProperties | undefined => {
    const tint = props.tint?.(r, c);
    const pin = pinStyle(c);
    return tint ? ({ ...pin, "--cell-tint": tint } as CSSProperties) : pin;
  };
  const pinClass = (c: number) => c < pinned && clsx(styles.pinnedCell, c === pinned - 1 && styles.pinnedLast);
  const template = `${rowHeaderWidth}px ${widths.map((w) => `${w}px`).join(" ")}`;

  const reveal = props.reveal;
  useEffect(() => {
    if (!reveal || reveal.row >= rowCount) return;
    setSel({ r0: reveal.row, c0: reveal.col, r1: reveal.row, c1: reveal.col });
    virtualizer.scrollToIndex(reveal.row, { align: "center" });
    const el = scrollRef.current;
    if (el) {
      const left = rowHeaderWidth + widths.slice(0, reveal.col).reduce((a, b) => a + b, 0);
      const right = left + (widths[reveal.col] ?? 0);
      if (left < el.scrollLeft + rowHeaderWidth) el.scrollLeft = left - rowHeaderWidth;
      else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
      el.focus({ preventScroll: true });
    }
    // Only a new request moves the selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.seq]);

  const selected = (r: number, c: number) => {
    if (!sel) return false;
    const n = norm(sel);
    return r >= n.top && r <= n.bottom && c >= n.left && c <= n.right;
  };
  const selectedRows = (): number[] => (sel ? range(norm(sel).top, norm(sel).bottom) : []);
  const selectedCols = (): number[] => (sel ? range(norm(sel).left, norm(sel).right) : []);
  const single = () => !!sel && sel.r0 === sel.r1 && sel.c0 === sel.c1;

  /** IDEA: one cell copies its value as is; more go through the data extractor. */
  const copy = () => {
    if (!sel) return;
    if (single()) {
      const v = value(sel.r1, sel.c1);
      void copyText(v ?? "");
      return;
    }
    const rows = selectedRows();
    const cols = selectedCols();
    // Without an extractor (a bare grid): tab-separated.
    const text =
      props.extract?.(rows, cols) ??
      toTsv(
        null,
        rows.map((r) => cols.map((c) => value(r, c))),
      );
    void copyText(text);
  };

  const paste = (text: string) => {
    if (!editable || !onEdit || !sel || !text) return;
    const rows = parseDelimited(text.replace(/\r?\n$/, ""), text.includes("\t") ? "\t" : ",");
    const { top, left } = norm(sel);
    let bottom = top;
    let right = left;
    rows.forEach((cells, dr) =>
      cells.forEach((cell, dc) => {
        const row = top + dr,
          col = left + dc;
        if (row >= rowCount || col >= columns.length || !canEdit(row, col)) return;
        onEdit(row, col, cell);
        bottom = Math.max(bottom, row);
        right = Math.max(right, col);
      }),
    );
    setSel({ r0: top, c0: left, r1: bottom, c1: right });
  };

  const commit = () => {
    if (!editing) return;
    const prev = value(editing.row, editing.col);
    if (editing.text !== (prev ?? "") || prev === null) {
      if (!(prev === null && editing.text === "")) onEdit?.(editing.row, editing.col, editing.text);
    }
    setEditing(null);
    scrollRef.current?.focus();
  };

  const canEdit = (row: number, col: number) =>
    !!editable && props.rowState?.(row) !== "deleted" && (props.cellEditable?.(row, col) ?? true);
  const startEdit = (row: number, col: number) => {
    if (!canEdit(row, col)) return;
    setEditing({ row, col, text: value(row, col) ?? "" });
  };

  const moveTo = (r: number, c: number, extend: boolean) => {
    r = Math.max(0, Math.min(rowCount - 1, r));
    c = Math.max(0, Math.min(columns.length - 1, c));
    setSel(extend && sel ? { ...sel, r1: r, c1: c } : { r0: r, c0: c, r1: r, c1: c });
    virtualizer.scrollToIndex(r, { align: "auto" });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing || e.target !== e.currentTarget) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (mod && key === "c") return (handled(), copy());
    if (mod && key === "a") {
      handled();
      if (rowCount && columns.length) setSel({ r0: 0, c0: 0, r1: rowCount - 1, c1: columns.length - 1 });
      return;
    }
    if (mod && key === "f" && props.onFind) return (handled(), props.onFind());
    if (mod && key === "l" && props.onGoToRow) return (handled(), props.onGoToRow());
    if (!sel || !rowCount) return;
    if (mod && (key === "Backspace" || key === "Delete") && props.onDeleteRows)
      return (handled(), props.onDeleteRows(selectedRows()));
    if (key === "Enter" && mod && e.shiftKey && props.onOpenPanel) return (handled(), props.onOpenPanel("record"));
    if (key === "Enter" && e.shiftKey && props.onOpenPanel) return (handled(), props.onOpenPanel("value"));
    if (key === "Enter" || key === "F2") {
      handled();
      if (editable) startEdit(sel.r1, sel.c1);
      else props.onOpenPanel?.("value");
      return;
    }
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? ROW_H * 10) / ROW_H) - 1);
    const to: Record<string, [number, number] | undefined> = {
      ArrowUp: mod ? [0, sel.c1] : [sel.r1 - 1, sel.c1],
      ArrowDown: mod ? [rowCount - 1, sel.c1] : [sel.r1 + 1, sel.c1],
      ArrowLeft: [sel.r1, sel.c1 - 1],
      ArrowRight: [sel.r1, sel.c1 + 1],
      Home: mod ? [0, 0] : [sel.r1, 0],
      End: mod ? [rowCount - 1, columns.length - 1] : [sel.r1, columns.length - 1],
      PageUp: [sel.r1 - page, sel.c1],
      PageDown: [sel.r1 + page, sel.c1],
    };
    const target = to[key];
    if (!target) return;
    handled();
    moveTo(target[0], target[1], e.shiftKey);
  };

  const onCellMouseDown = (e: MouseEvent, r: number, c: number) => {
    if (e.button !== 0) {
      if (!selected(r, c)) setSel({ r0: r, c0: c, r1: r, c1: c });
      return;
    }
    if (editing) commit();
    e.preventDefault();
    scrollRef.current?.focus();
    dragging.current = "cells";
    setSel(e.shiftKey && sel ? { ...sel, r1: r, c1: c } : { r0: r, c0: c, r1: r, c1: c });
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (editing || !editable || !onEdit || !sel) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    paste(text);
  };

  const onRowNumberMouseDown = (e: MouseEvent, r: number) => {
    if (!columns.length) return;
    if (e.button !== 0) {
      if (!sel || !selected(r, 0)) setSel({ r0: r, c0: 0, r1: r, c1: columns.length - 1 });
      return;
    }
    e.preventDefault();
    scrollRef.current?.focus();
    dragging.current = "rows";
    const last = columns.length - 1;
    setSel(e.shiftKey && sel ? { ...sel, r1: r, c1: last } : { r0: r, c0: 0, r1: r, c1: last });
  };

  const onHeaderMouseDown = (e: MouseEvent, c: number) => {
    if (!rowCount) return;
    if (e.button !== 0) {
      if (!sel || !selected(0, c)) setSel({ r0: 0, c0: c, r1: rowCount - 1, c1: c });
      return;
    }
    e.preventDefault();
    scrollRef.current?.focus();
    dragging.current = "columns";
    setSel(e.shiftKey && sel ? { ...sel, r0: 0, r1: rowCount - 1, c1: c } : { r0: 0, c0: c, r1: rowCount - 1, c1: c });
  };

  const sortBy = (column: string, add: boolean, direction?: "asc" | "desc" | null) =>
    onSortChange?.(nextSort(sort, column, add, direction));

  const extractorMenu = (): MenuItem[] => [
    { kind: "header", label: "Built-in" },
    ...EXPORT_FORMATS.filter((f) => f.group === "builtin").map((f): MenuItem => ({
      label: f.label,
      checked: f.id === extractor,
      run: () => setExtractor(f.id),
    })),
    { kind: "header", label: "CSV" },
    ...EXPORT_FORMATS.filter((f) => f.group === "csv").map((f): MenuItem => ({
      label: f.label,
      checked: f.id === extractor,
      run: () => setExtractor(f.id),
    })),
    { kind: "separator" },
    { label: "Copy Column Names with CSV Formats", checked: copyHeader, run: () => setCopyHeader(!copyHeader) },
  ];

  const cellMenu = (): MenuItem[] => {
    if (!sel) return [];
    const n = norm(sel);
    const rows = selectedRows();
    const cols = selectedCols();
    const items: MenuItem[] = [];
    if (props.onOpenPanel) {
      items.push(
        editable
          ? {
              label: "Edit Value",
              shortcut: "↵",
              disabled: !single() || !canEdit(n.top, n.left),
              run: () => startEdit(n.top, n.left),
            }
          : { label: "View Value", shortcut: "↵", run: () => props.onOpenPanel!("value") },
        { label: "Open in Value Editor", shortcut: "⇧↵", run: () => props.onOpenPanel!("value") },
        { label: "Show Record View", shortcut: "⌘⇧↵", run: () => props.onOpenPanel!("record") },
        { label: "Show Aggregate View", run: () => props.onOpenPanel!("aggregates") },
        { kind: "separator" },
      );
    }
    if (props.onRevert) {
      const changed = rows.some((r) => props.rowState?.(r) || cols.some((c) => props.isModified?.(r, c)));
      items.push({
        label: "Revert Selected",
        icon: "revert",
        disabled: !changed,
        run: () => props.onRevert!(rows, cols),
      });
    }
    if (editable && onEdit)
      items.push({
        label: "Set NULL",
        run: () => {
          for (const r of rows) for (const c of cols) if (canEdit(r, c)) onEdit(r, c, null);
        },
      });
    if (items.length && items.at(-1)?.kind !== "separator") items.push({ kind: "separator" });
    items.push(
      {
        label: single() ? "Copy" : tx`Copy (${tx(extractorOf(extractor).label)})`,
        icon: "copy",
        shortcut: "⌘C",
        run: copy,
      },
      { label: tx`Data Extractor: ${tx(extractorOf(extractor).label)}`, submenu: extractorMenu() },
    );
    if (editable && onEdit)
      items.push({
        label: "Paste",
        icon: "paste",
        shortcut: "⌘V",
        run: () => void navigator.clipboard?.readText().then(paste),
      });
    const extra = rowMenu?.(rows) ?? [];
    if (extra.length) items.push({ kind: "separator" }, ...extra);
    if (props.onFilterBySelection && n.left === n.right) {
      const values = [...new Set(rows.map((r) => value(r, n.left)))];
      items.push(
        { kind: "separator" },
        {
          label: "Local Filter by Selected Values",
          icon: "filter",
          run: () => props.onFilterBySelection!(n.left, values),
        },
      );
    }
    const goTo: MenuItem[] = [];
    if (props.onGoToRow) goTo.push({ label: "Row…", shortcut: "⌘L", run: props.onGoToRow });
    if (props.onFind) goTo.push({ label: "Find on Current Page", shortcut: "⌘F", run: props.onFind });
    if (goTo.length) items.push({ kind: "separator" }, ...goTo);
    return items;
  };

  const headerMenu = (c: number): MenuItem[] => {
    const col = columns[c]!;
    const cols =
      sel && selected(0, c) && norm(sel).top === 0 && norm(sel).bottom === rowCount - 1 ? selectedCols() : [c];
    const s = sort.find((k) => k.column === col.name);
    const items: MenuItem[] = [
      {
        label: "Copy Column Name",
        icon: "copy",
        run: () => void copyText(cols.map((i) => columns[i]!.name).join(", ")),
      },
      {
        label: "Select Column",
        disabled: !rowCount,
        run: () => setSel({ r0: 0, c0: c, r1: rowCount - 1, c1: c }),
      },
    ];
    if (props.onHideColumns || props.onShowAllColumns) {
      items.push({ kind: "separator" });
      if (props.onHideColumns)
        items.push(
          {
            label: cols.length > 1 ? "Hide Columns" : "Hide Column",
            disabled: cols.length >= columns.length,
            run: () => props.onHideColumns!(cols),
          },
          {
            label: "Hide Other Columns",
            disabled: columns.length <= cols.length,
            run: () => props.onHideColumns!(columns.map((_, i) => i).filter((i) => !cols.includes(i))),
          },
        );
      if (props.onShowAllColumns) items.push({ label: "Show All Columns", run: props.onShowAllColumns });
    }
    if (props.onPin) {
      const allPinned = cols.every((i) => i < pinned);
      items.push(
        { kind: "separator" },
        allPinned
          ? { label: cols.length > 1 ? "Unpin Columns" : "Unpin Column", run: () => props.onPin!(cols, false) }
          : { label: cols.length > 1 ? "Pin Columns" : "Pin Column", run: () => props.onPin!(cols, true) },
        { label: "Unpin All Columns", disabled: !pinned, run: () => props.onPin!(null, false) },
      );
    }
    items.push(
      { kind: "separator" },
      {
        label: "Fit Column Width",
        run: () =>
          setWidths((w) => w.map((x, i) => (cols.includes(i) ? measure(i, Math.min(rowCount, 500)).width : x))),
      },
      {
        label: "Reset Columns Width",
        run: () => setWidths(() => columns.map((_, i) => measure(i).width)),
      },
    );
    if (onSortChange) {
      items.push(
        { kind: "header", label: "ORDER BY" },
        {
          label: "Ascending",
          checked: !!s && !s.descending && sort.length === 1,
          run: () => sortBy(col.name, false, "asc"),
        },
        {
          label: "Descending",
          checked: !!s?.descending && sort.length === 1,
          run: () => sortBy(col.name, false, "desc"),
        },
        { kind: "header", label: "Add to ORDER BY" },
        { label: "Ascending", disabled: !!s && !s.descending, run: () => sortBy(col.name, true, "asc") },
        { label: "Descending", disabled: !!s?.descending, run: () => sortBy(col.name, true, "desc") },
        { kind: "separator" },
        { label: "Clear Sorting", disabled: !sort.length, run: () => onSortChange([]) },
      );
    }
    if (props.onFilter) {
      const anchor = scrollRef.current?.querySelector<HTMLElement>(`[data-col="${c}"]`);
      items.push(
        { kind: "separator" },
        { label: "Set Local Filter…", icon: "filter", run: () => anchor && props.onFilter!(c, anchor) },
      );
    }
    return items;
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    const header = (e.target as Element).closest<HTMLElement>("[data-col]");
    const items = header ? headerMenu(Number(header.dataset.col)) : cellMenu();
    if (items.length) showContextMenu(e, items);
  };

  const startResize = (e: MouseEvent, col: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const start = widths[col] ?? 100;
    const move = (ev: globalThis.MouseEvent) =>
      setWidths((w) => w.map((x, i) => (i === col ? Math.max(40, start + ev.clientX - startX) : x)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const multiSort = sort.length > 1;

  return (
    <div
      ref={scrollRef}
      className={styles.grid}
      tabIndex={0}
      role="grid"
      data-db-grid=""
      aria-label={props["aria-label"] ?? "Results"}
      aria-rowcount={rowCount}
      aria-multiselectable
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onContextMenu={onContextMenu}
    >
      <div className={styles.gridInner} style={{ width: totalWidth, height: virtualizer.getTotalSize() + ROW_H }}>
        <div className={clsx(styles.gridRow, styles.gridHeader)} style={{ gridTemplateColumns: template }} role="row">
          <div
            className={clsx(styles.rowNumber, styles.cornerCell)}
            title={tx("Select All")}
            onMouseDown={(e) => {
              e.preventDefault();
              scrollRef.current?.focus();
              if (rowCount && columns.length) setSel({ r0: 0, c0: 0, r1: rowCount - 1, c1: columns.length - 1 });
            }}
          />
          {columns.map((c, ci) => {
            const at = sort.findIndex((k) => k.column === c.name);
            const s = at >= 0 ? sort[at] : undefined;
            const columnSelected = !!sel && rowCount > 0 && selected(0, ci) && selected(rowCount - 1, ci);
            return (
              <div
                key={ci}
                role="columnheader"
                data-col={ci}
                aria-sort={s && sort.length === 1 ? (s.descending ? "descending" : "ascending") : undefined}
                className={clsx(styles.headerCell, columnSelected && styles.headerSelected, pinClass(ci))}
                style={pinStyle(ci)}
                title={c.type ? `${c.name}: ${c.type}` : c.name}
                onMouseDown={(e) => onHeaderMouseDown(e, ci)}
                onMouseEnter={() => {
                  if (dragging.current === "columns" && sel) setSel({ ...sel, r1: rowCount - 1, c1: ci });
                }}
              >
                <Icon
                  name={c.primaryKey ? "db-column-key" : c.foreignKey ? "db-column-fk" : "db-column"}
                  size={16}
                  className={styles.headerIcon}
                />
                <span className={styles.headerName}>{c.name}</span>
                {props.onFilter && (
                  <button
                    type="button"
                    className={clsx(styles.headerFilter, props.filtered?.(ci) && styles.headerFilterOn)}
                    aria-label={tx`Local filter of ${c.name}`}
                    title={tx("Local filter")}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onFilter?.(ci, e.currentTarget);
                    }}
                  >
                    <Icon name="filter" size={12} />
                  </button>
                )}
                {onSortChange && (
                  <button
                    type="button"
                    className={clsx(styles.headerSortButton, s && styles.headerSortOn)}
                    aria-label={
                      s ? (s.descending ? tx`${c.name}: descending` : tx`${c.name}: ascending`) : tx`Sort by ${c.name}`
                    }
                    title={tx("Click to sort; ⌥-click or ⇧-click to add to the sort")}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      sortBy(c.name, e.altKey || e.shiftKey);
                    }}
                  >
                    <Icon name={s ? (s.descending ? "arrow-down" : "arrow-up") : "db-sort"} size={s ? 12 : 16} />
                    {s && multiSort && <span className={styles.headerSortRank}>{at + 1}</span>}
                  </button>
                )}
                <span
                  className={styles.resizer}
                  onMouseDown={(e) => startResize(e, ci)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setWidths((w) => w.map((x, i) => (i === ci ? measure(ci, Math.min(rowCount, 500)).width : x)));
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            );
          })}
        </div>
        {virtualizer.getVirtualItems().map((v) => {
          const r = v.index;
          const state = props.rowState?.(r) ?? null;
          const rowSelected = !!sel && columns.length > 0 && selected(r, 0) && selected(r, columns.length - 1);
          return (
            <div
              key={v.key}
              role="row"
              className={clsx(
                styles.gridRow,
                state === "deleted" && styles.rowDeleted,
                state === "inserted" && styles.rowInserted,
              )}
              style={{ gridTemplateColumns: template, transform: `translateY(${v.start + ROW_H}px)` }}
            >
              <div
                className={clsx(styles.rowNumber, rowSelected && styles.rowNumberSelected)}
                onMouseDown={(e) => onRowNumberMouseDown(e, r)}
                onMouseEnter={() => {
                  if (dragging.current === "rows" && sel) setSel({ ...sel, r1: r, c1: columns.length - 1 });
                }}
                title={props.rowLabel ? props.rowLabel(r) : undefined}
              >
                {state === "inserted" ? "+" : (props.rowLabel?.(r) ?? r + 1)}
              </div>
              {columns.map((_, c) => {
                if (editing && editing.row === r && editing.col === c) {
                  return (
                    <input
                      key={c}
                      className={styles.cellEditor}
                      autoFocus
                      aria-label={tx`Edit ${columns[c]!.name}`}
                      value={editing.text}
                      onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                      onBlur={commit}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") commit();
                        if (e.key === "Escape") {
                          setEditing(null);
                          scrollRef.current?.focus();
                        }
                      }}
                    />
                  );
                }
                const val = value(r, c);
                const found = props.match?.(r, c) ?? null;
                return (
                  <div
                    key={c}
                    role="gridcell"
                    aria-selected={selected(r, c) || undefined}
                    className={clsx(
                      styles.cell,
                      numeric[c] && styles.cellNumber,
                      found === "match" && styles.cellMatch,
                      found === "current" && styles.cellMatchCurrent,
                      selected(r, c) && styles.cellSelected,
                      props.isModified?.(r, c) && styles.cellModified,
                      pinClass(c),
                      tinted(r, c) && styles.cellTinted,
                    )}
                    style={cellStyle(r, c)}
                    onMouseDown={(e) => onCellMouseDown(e, r, c)}
                    onMouseEnter={() => {
                      if (dragging.current === "cells") setSel((s) => (s ? { ...s, r1: r, c1: c } : s));
                    }}
                    onDoubleClick={() => (editable ? startEdit(r, c) : props.onOpenPanel?.("value"))}
                    title={val != null && val.length > 40 ? val.slice(0, 2000) : undefined}
                  >
                    {val === null ? <span className={styles.null}>&lt;null&gt;</span> : displayed(val, !!numeric[c])}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
