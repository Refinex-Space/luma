/**
 * A data grid with IDEA's result-view extras, shared by console results and the table
 * editor: Copy through the data extractor (selected rows × selected columns), the header's
 * local filter (values of the loaded rows), client-side multi-column sorting when the
 * caller does not sort with ORDER BY, hidden columns, Transpose, Find on Current Page
 * (⌘F, with Filter Rows), Go to Row (⌘L) and the Record / Value / Aggregates side panel
 * following the selection. The view state (`useGridView`) lives with the caller, whose
 * toolbar offers the View options and exports what is shown.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import {
  Button,
  Checkbox,
  Icon,
  IconButton,
  Input,
  Popup,
  Select,
  Tabs,
  T,
  showContextMenu,
  type MenuItem,
} from "@/ui";
import { copyText } from "@/ui/selectableText";
import { ConsoleFindBar } from "@/features/run/FindBar";
import { DEFAULT_FIND_OPTIONS, type FindOptions } from "@/features/run/find";
import { registerKeyClaim } from "@/platform/keymap";
import { exportData, extractorOf, extractorOptions, selectionData, type ExportData, type ExportFormat } from "./export";
import { Grid, isNumericColumn, type GridColumn, type GridPanel, type GridProps, type GridRange } from "./Grid";
import { setAggregate, setColoring, setExtractor, useGridPrefs, type GridAggregate } from "./gridPrefs";
import type { Cell } from "./model";
import {
  aggregates,
  cellMatcher,
  distinctValues,
  formatNumber,
  heat,
  imageUrl,
  numberRange,
  parseGoTo,
  toggleFilterValue,
  visibleRows,
  type LocalFilter,
  type LocalSort,
  type SortKey,
} from "./resultView";
import { openDialog } from "./store";
import styles from "./Database.module.css";
import { tx } from "@/platform/i18n";

export type DataPanel = GridPanel;

// ---- view state ---------------------------------------------------------------------

/** What the grid shows of its rows and columns; a new column set starts over. */
export interface GridView {
  key: string;
  hidden: ReadonlySet<number>;
  transposed: boolean;
  filter: LocalFilter;
  /** Client-side sort keys (without ORDER BY), the primary first. */
  localSort: readonly LocalSort[];
  /** Pinned columns, shown first and kept in view. */
  pinned: ReadonlySet<number>;
}

export interface GridViewModel extends GridView {
  update: (patch: Partial<Omit<GridView, "key">>) => void;
  /** IDEA's Reset View: every column shown, no local filter or sort, not transposed. */
  reset: () => void;
}

const freshView = (key: string): GridView => ({
  key,
  hidden: new Set(),
  transposed: false,
  filter: new Map(),
  localSort: [],
  pinned: new Set(),
});

export function useGridView(columns: readonly { name: string }[]): GridViewModel {
  const key = columns.map((c) => c.name).join("\u0000");
  const [state, setState] = useState<GridView>(() => freshView(key));
  const current = state.key === key ? state : freshView(key);
  const update = useCallback(
    (patch: Partial<Omit<GridView, "key">>) => setState((s) => ({ ...(s.key === key ? s : freshView(key)), ...patch })),
    [key],
  );
  const reset = useCallback(() => setState(freshView(key)), [key]);
  return { ...current, update, reset };
}

/** The columns and rows an export takes: the shown columns (IDEA exports visible ones). */
export function shownData(data: ExportData, view: GridView): ExportData {
  if (!view.hidden.size) return data;
  const cols = data.columns.map((_, i) => i).filter((i) => !view.hidden.has(i));
  return {
    ...data,
    columns: cols.map((i) => data.columns[i]!),
    rows: data.rows.map((r) => cols.map((i) => r[i] ?? null)),
  };
}

// ---- toolbar pieces ---------------------------------------------------------------------

/** The Export button's menu: the Export Data dialog (with the current extractor), then quick Copy As. */
export function exportMenu(data: ExportData, source: string, loadAll?: () => Promise<ExportData | null>): MenuItem[] {
  const format = useGridPrefs.getState().extractor;
  const copyAs = (id: ExportFormat): MenuItem => ({
    label: extractorOf(id).label,
    run: () => void navigator.clipboard?.writeText(exportData(id, data)),
  });
  return [
    { label: "Export Data…", icon: "export", run: () => openDialog({ kind: "export", data, source, format, loadAll }) },
    { kind: "separator" },
    {
      label: "Copy All As",
      icon: "copy",
      submenu: extractorOptions()
        .filter((o) => !o.section)
        .map((o) => copyAs(o.value as ExportFormat)),
    },
  ];
}

/** IDEA's data extractor drop-down at the right of a data toolbar ("CSV ▾"): what Copy writes. */
export function ExtractorSelect() {
  const value = useGridPrefs((s) => s.extractor);
  return (
    <Select
      aria-label="Data extractor"
      value={value}
      options={extractorOptions()}
      onChange={(v) => setExtractor(v as ExportFormat)}
    />
  );
}

/** The Record / Value / Aggregates panel's toggle (IDEA's "Show Value Editor"). */
export function PanelToggle({ panel, onChange }: { panel: DataPanel | null; onChange: (p: DataPanel | null) => void }) {
  return (
    <IconButton
      icon="split"
      title={panel ? "Hide Record / Value / Aggregates" : "Show Record / Value / Aggregates"}
      aria-pressed={!!panel}
      onClick={() => onChange(panel ? null : "record")}
    />
  );
}

/** IDEA's "View as" / column visibility / Reset View options. */
export function viewMenu(view: GridViewModel, columns: readonly { name: string }[]): MenuItem[] {
  return [
    { label: "Transpose", checked: view.transposed, run: () => view.update({ transposed: !view.transposed }) },
    { kind: "separator" },
    {
      label: "Columns",
      submenu: columns.map((c, i) => ({
        label: c.name,
        verbatim: true,
        checked: !view.hidden.has(i),
        // The last shown column stays.
        disabled: !view.hidden.has(i) && view.hidden.size >= columns.length - 1,
        run: () => {
          const hidden = new Set(view.hidden);
          if (hidden.has(i)) hidden.delete(i);
          else hidden.add(i);
          view.update({ hidden });
        },
      })),
    },
    { label: "Show All Columns", disabled: !view.hidden.size, run: () => view.update({ hidden: new Set() }) },
    {
      label: "Coloring",
      submenu: (
        [
          ["off", "Off"],
          ["sequential", "Sequential"],
          ["diverging", "Diverging"],
        ] as const
      ).map(([mode, label]) => ({
        label,
        checked: useGridPrefs.getState().coloring === mode,
        run: () => setColoring(mode),
      })),
    },
    { kind: "separator" },
    { label: "Reset View", run: view.reset },
  ];
}

// ---- the view -------------------------------------------------------------------------

export interface DataViewProps extends Pick<
  GridProps,
  "rowState" | "isModified" | "editable" | "cellEditable" | "onEdit" | "rowMenu"
> {
  columns: readonly GridColumn[];
  rowCount: number;
  value: (row: number, col: number) => Cell;
  /** Rows from here on (the table editor's added rows) are never filtered or sorted. */
  fixedRows?: number;
  firstRowNumber?: number;
  /** Sorting with ORDER BY (the caller re-queries); without it the loaded rows sort locally. */
  sort?: readonly SortKey[];
  onSortChange?: (next: SortKey[]) => void;
  onRevert?: (rows: number[], cols: number[]) => void;
  onDeleteRows?: (rows: number[]) => void;
  /** Table, schema and dialect the SQL extractors write for. */
  target: Omit<ExportData, "rows" | "columns">;
  view: GridViewModel;
  /** The side panel shown (`null`: hidden). */
  panel: DataPanel | null;
  onPanelChange: (panel: DataPanel | null) => void;
  "aria-label"?: string;
}

interface Found {
  /** Display row, shown column (indexes into `order` / `shownCols`). */
  row: number;
  col: number;
}

const MAX_FOUND = 10_000;

export function DataView(props: DataViewProps) {
  const { columns, rowCount, value, fixedRows = rowCount, panel, onPanelChange, view } = props;
  const firstRow = props.firstRowNumber ?? 1;
  const { filter, hidden, transposed } = view;
  const extractor = useGridPrefs((s) => s.extractor);
  const copyHeader = useGridPrefs((s) => s.copyHeader);
  const hostRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<GridRange | null>(null);
  const [filterAt, setFilterAt] = useState<{ col: number; anchor: HTMLElement } | null>(null);
  const [reveal, setReveal] = useState<{ row: number; col: number; seq: number } | null>(null);

  const local = !props.onSortChange;
  // Pinned columns first, as IDEA moves them.
  const shownCols = useMemo(() => {
    const shown = columns.map((_, i) => i).filter((i) => !hidden.has(i));
    return [...shown.filter((i) => view.pinned.has(i)), ...shown.filter((i) => !view.pinned.has(i))];
  }, [columns, hidden, view.pinned]);
  const pinnedCount = transposed ? 0 : shownCols.filter((i) => view.pinned.has(i)).length;

  // Loaded rows shown, in order (local filter and sort).
  const shaped = useMemo(
    () =>
      filter.size || (local && view.localSort.length)
        ? visibleRows(rowCount, value, filter, local ? view.localSort : null, fixedRows)
        : null,
    [rowCount, value, filter, local, view.localSort, fixedRows],
  );

  // ---- heatmap: each numeric column's range over the loaded rows
  const coloring = useGridPrefs((s) => s.coloring);
  const ranges = useMemo(() => {
    if (coloring === "off") return null;
    const loaded = Math.min(rowCount, fixedRows);
    return columns.map((c, ci) => {
      const values = Array.from({ length: loaded }, (_, r) => value(r, ci));
      // Keys identify rows: their size means nothing.
      return !c.primaryKey && isNumericColumn(c.type, values.slice(0, 50)) ? numberRange(values) : null;
    });
  }, [coloring, columns, rowCount, fixedRows, value]);
  const tintOf = (row: number, col: number): string | undefined => {
    const t = ranges ? heat(value(row, col), ranges[col] ?? null) : null;
    if (t === null) return undefined;
    if (coloring === "sequential")
      return `color-mix(in srgb, var(--heat-high) ${Math.round(8 + t * 47)}%, transparent)`;
    // Diverging: low green, middle clear, high red.
    const d = Math.abs(t - 0.5) * 2;
    return `color-mix(in srgb, var(${t < 0.5 ? "--heat-low" : "--heat-high-diverging"}) ${Math.round(d * 55)}%, transparent)`;
  };

  // ---- find on current page
  const [find, setFind] = useState<{ query: string; options: FindOptions; filterRows: boolean } | null>(null);
  const [active, setActive] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);
  const matcher = useMemo(() => (find ? cellMatcher(find.query, find.options) : null), [find]);
  const baseRows = useMemo(() => shaped ?? Array.from({ length: rowCount }, (_, i) => i), [shaped, rowCount]);
  const { found, overflow } = useMemo(() => {
    const out: Found[] = [];
    if (typeof matcher !== "function") return { found: out, overflow: false };
    for (let r = 0; r < baseRows.length; r++)
      for (let c = 0; c < shownCols.length; c++)
        if (matcher(value(baseRows[r]!, shownCols[c]!))) {
          if (out.length >= MAX_FOUND) return { found: out, overflow: true };
          out.push({ row: r, col: c });
        }
    return { found: out, overflow: false };
  }, [matcher, baseRows, shownCols, value]);
  // Filter Rows keeps the rows with a match.
  const rows = useMemo(() => {
    if (!find?.filterRows || typeof matcher !== "function") return baseRows;
    const keep = new Set(found.map((f) => f.row));
    return baseRows.filter((_, i) => keep.has(i));
  }, [find?.filterRows, matcher, found, baseRows]);
  const foundAt = useMemo(() => {
    if (find?.filterRows) {
      // Display rows changed: re-key by the remaining rows.
      const index = new Map(rows.map((r, i) => [r, i]));
      return found.map((f) => ({ row: index.get(baseRows[f.row]!)!, col: f.col }));
    }
    return found;
  }, [find?.filterRows, rows, found, baseRows]);
  const foundKeys = useMemo(() => new Set(foundAt.map((f) => `${f.row}:${f.col}`)), [foundAt]);
  const current = foundAt[Math.min(active, foundAt.length - 1)];

  // Grid space ↔ (loaded row, column).
  const toModel = useCallback(
    (r: number, c: number) =>
      transposed ? { row: rows[c]!, col: shownCols[r]! } : { row: rows[r]!, col: shownCols[c]! },
    [transposed, rows, shownCols],
  );
  const toGrid = (displayRow: number, shownCol: number) =>
    transposed ? { row: shownCol, col: displayRow } : { row: displayRow, col: shownCol };

  const goToMatch = (step: number) => {
    if (!foundAt.length) return;
    const next = (Math.min(active, foundAt.length - 1) + step + foundAt.length) % foundAt.length;
    setActive(next);
    const f = foundAt[next]!;
    setReveal((r) => ({ ...toGrid(f.row, f.col), seq: (r?.seq ?? 0) + 1 }));
  };
  useEffect(() => {
    setActive(0);
    const f = foundAt[0];
    if (f) setReveal((r) => ({ ...toGrid(f.row, f.col), seq: (r?.seq ?? 0) + 1 }));
    // A new query (or option) starts from the first match.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find?.query, find?.options, find?.filterRows]);
  const focusGrid = () => hostRef.current?.querySelector<HTMLElement>("[data-db-grid]")?.focus();
  const openFind = () => {
    setFind((f) => f ?? { query: "", options: DEFAULT_FIND_OPTIONS, filterRows: false });
    requestAnimationFrame(() => {
      findInput.current?.focus();
      findInput.current?.select();
    });
  };
  const closeFind = () => {
    setFind(null);
    requestAnimationFrame(focusGrid);
  };
  useEffect(() => {
    if (!find) return;
    return registerKeyClaim((e) => !!(e.target as Element | null)?.closest?.("[data-run-find]"));
  }, [find]);

  // ---- go to row
  const [goTo, setGoTo] = useState<{ text: string; invalid: boolean } | null>(null);
  const shownNames = shownCols.map((i) => columns[i]!.name);
  const submitGoTo = () => {
    if (!goTo) return;
    const at = parseGoTo(goTo.text, shownNames);
    // Row numbers are the loaded rows' (paging): find the shown row with that number.
    const display = at ? rows.indexOf(at.row - (firstRow - 1)) : -1;
    if (!at || display < 0) {
      setGoTo({ ...goTo, invalid: true });
      return;
    }
    setGoTo(null);
    const col = at.column ?? (range ? (transposed ? range.lead.row : range.lead.col) : 0);
    setReveal((r) => ({ ...toGrid(display, Math.min(col, shownCols.length - 1)), seq: (r?.seq ?? 0) + 1 }));
  };

  // ---- grid props
  const gridColumns: GridColumn[] = useMemo(
    () =>
      transposed ? rows.map((r) => ({ name: String(firstRow + r), type: "" })) : shownCols.map((i) => columns[i]!),
    [transposed, rows, shownCols, columns, firstRow],
  );
  const gridValue = useCallback(
    (r: number, c: number) => {
      const m = toModel(r, c);
      return value(m.row, m.col);
    },
    [toModel, value],
  );

  const extract = (gridRows: number[], gridCols: number[]) => {
    const modelRows = transposed ? gridCols.map((c) => rows[c]!) : gridRows.map((r) => rows[r]!);
    const modelCols = transposed ? gridRows.map((r) => shownCols[r]!) : gridCols.map((c) => shownCols[c]!);
    const f = extractorOf(extractor);
    return exportData(f.id, selectionData(props.target, columns, modelRows, modelCols, value), {
      columnHeader: f.group === "csv" ? copyHeader : true,
      rowHeader: false,
      transpose: false,
    });
  };

  const sortKeys: readonly SortKey[] = local
    ? view.localSort.map((k) => ({ column: columns[k.column]?.name ?? "", descending: k.descending }))
    : (props.sort ?? []);
  const onSortChange = (next: SortKey[]) => {
    if (!local) return props.onSortChange?.(next);
    view.update({
      localSort: next
        .map((k) => ({ column: columns.findIndex((c) => c.name === k.column), descending: k.descending }))
        .filter((k) => k.column >= 0),
    });
  };

  const setFilter = (f: LocalFilter) => view.update({ filter: f });
  const modelRowsOf = (gridRows: number[], gridCols: number[]) =>
    transposed ? gridCols.map((c) => rows[c]!) : gridRows.map((r) => rows[r]!);
  const modelColsOf = (gridRows: number[], gridCols: number[]) =>
    transposed ? gridRows.map((r) => shownCols[r]!) : gridCols.map((c) => shownCols[c]!);

  const lead = range ? toModel(range.lead.row, range.lead.col) : null;
  const selectedCells = (): Cell[] => {
    if (!range) return [];
    const out: Cell[] = [];
    for (let r = range.top; r <= range.bottom; r++)
      for (let c = range.left; c <= range.right; c++) out.push(gridValue(r, c));
    return out;
  };

  return (
    <div className={styles.dataView} ref={hostRef}>
      <div className={clsx(styles.fill, styles.dataMain)}>
        {find && (
          <ConsoleFindBar
            label="Find on current page"
            query={find.query}
            onChange={(query) => setFind({ ...find, query })}
            options={find.options}
            onOptionsChange={(options) => setFind({ ...find, options })}
            count={foundAt.length}
            active={foundAt.length ? Math.min(active, foundAt.length - 1) : -1}
            overflow={overflow}
            invalid={matcher === "invalid"}
            inputRef={findInput}
            onNext={() => goToMatch(1)}
            onPrevious={() => goToMatch(-1)}
            onClose={closeFind}
          >
            <Checkbox
              className={styles.findFilterRows}
              checked={find.filterRows}
              onChange={(filterRows) => setFind({ ...find, filterRows })}
              label={tx("Filter rows")}
            />
          </ConsoleFindBar>
        )}
        <div className={clsx(styles.fill, styles.gridHost)}>
          <Grid
            aria-label={props["aria-label"]}
            columns={gridColumns}
            rowCount={transposed ? shownCols.length : rows.length}
            value={gridValue}
            rowState={props.rowState && !transposed ? (r) => props.rowState!(rows[r]!) : undefined}
            isModified={
              props.isModified &&
              ((r, c) => {
                const m = toModel(r, c);
                return props.isModified!(m.row, m.col);
              })
            }
            editable={props.editable}
            onEdit={
              props.onEdit &&
              ((r, c, v) => {
                const m = toModel(r, c);
                props.onEdit!(m.row, m.col, v);
              })
            }
            sort={transposed ? undefined : sortKeys}
            onSortChange={transposed ? undefined : onSortChange}
            rowMenu={props.rowMenu && ((r) => props.rowMenu!(transposed ? [] : r.map((x) => rows[x]!)))}
            rowLabel={(r) => (transposed ? columns[shownCols[r]!]!.name : String(firstRow + rows[r]!))}
            onSelectionChange={setRange}
            onFilter={transposed ? undefined : (col, anchor) => setFilterAt({ col: shownCols[col]!, anchor })}
            filtered={(col) => !transposed && filter.has(shownCols[col]!)}
            extract={extract}
            onFilterBySelection={
              transposed
                ? undefined
                : (col, values) => {
                    const next = new Map(filter);
                    next.set(shownCols[col]!, new Set(values));
                    setFilter(next);
                  }
            }
            onHideColumns={
              transposed
                ? undefined
                : (cols) => view.update({ hidden: new Set([...hidden, ...cols.map((c) => shownCols[c]!)]) })
            }
            onShowAllColumns={hidden.size ? () => view.update({ hidden: new Set() }) : undefined}
            pinned={pinnedCount}
            onPin={
              transposed
                ? undefined
                : (cols, pin) => {
                    if (!cols) return view.update({ pinned: new Set() });
                    const next = new Set(view.pinned);
                    for (const c of cols) {
                      if (pin) next.add(shownCols[c]!);
                      else next.delete(shownCols[c]!);
                    }
                    view.update({ pinned: next });
                  }
            }
            onOpenPanel={(p) => onPanelChange(p)}
            onRevert={props.onRevert && ((gr, gc) => props.onRevert!(modelRowsOf(gr, gc), modelColsOf(gr, gc)))}
            onDeleteRows={
              props.onDeleteRows && !transposed ? (gr) => props.onDeleteRows!(gr.map((r) => rows[r]!)) : undefined
            }
            onFind={openFind}
            onGoToRow={() => setGoTo({ text: "", invalid: false })}
            match={
              typeof matcher === "function"
                ? (r, c) => {
                    const d = transposed ? { row: c, col: r } : { row: r, col: c };
                    if (current && current.row === d.row && current.col === d.col) return "current";
                    return foundKeys.has(`${d.row}:${d.col}`) ? "match" : null;
                  }
                : undefined
            }
            reveal={reveal}
            tint={
              ranges
                ? (r, c) => {
                    const m = toModel(r, c);
                    return tintOf(m.row, m.col);
                  }
                : undefined
            }
          />
          {goTo && (
            <form
              className={styles.goToRow}
              onSubmit={(e) => {
                e.preventDefault();
                submitGoTo();
              }}
            >
              <label className={styles.goToLabel}>
                <T>Go to row</T>
                <Input
                  autoFocus
                  mono
                  aria-label="Row and column"
                  placeholder={tx("row[:column]")}
                  invalid={goTo.invalid}
                  value={goTo.text}
                  onChange={(e) => setGoTo({ text: e.target.value, invalid: false })}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      setGoTo(null);
                      focusGrid();
                    }
                  }}
                  onBlur={() => setGoTo(null)}
                />
              </label>
            </form>
          )}
          <div className={styles.gridPills}>
            {range && (range.bottom > range.top || range.right > range.left) && (
              <AggregatePill cells={selectedCells} onShowAll={() => onPanelChange("aggregates")} />
            )}
            {(filter.size > 0 || (find?.filterRows && typeof matcher === "function")) && (
              <div className={styles.filterPill} role="status">
                {tx`${rows.length} of ${rowCount} rows`}
                {filter.size > 0 && (
                  <button type="button" className={styles.filterPillClear} onClick={() => setFilter(new Map())}>
                    <T>Clear local filter</T>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {filterAt && (
        <FilterPopup
          anchor={filterAt.anchor}
          column={columns[filterAt.col]?.name ?? ""}
          values={distinctValues(Math.min(rowCount, fixedRows), value, filterAt.col)}
          checked={filter.get(filterAt.col) ?? null}
          onToggle={(all, v, on) => setFilter(toggleFilterValue(filter, filterAt.col, all, v, on))}
          onClear={() => {
            const next = new Map(filter);
            next.delete(filterAt.col);
            setFilter(next);
          }}
          onClearAll={() => setFilter(new Map())}
          onClose={() => setFilterAt(null)}
        />
      )}
      {panel && (
        <SidePanel
          panel={panel}
          onPanelChange={onPanelChange}
          columns={columns}
          shownCols={shownCols}
          lead={lead}
          cells={selectedCells}
          value={value}
          editable={!!props.editable && !!props.onEdit && !!lead && props.rowState?.(lead.row) !== "deleted"}
          cellEditable={(r, c) => props.cellEditable?.(r, c) ?? true}
          onEdit={(r, c, v) => props.onEdit?.(r, c, v)}
        />
      )}
    </div>
  );
}

function FilterPopup(props: {
  anchor: HTMLElement;
  column: string;
  values: Array<{ value: Cell; count: number }>;
  checked: ReadonlySet<Cell> | null;
  onToggle: (all: Cell[], v: Cell, on: boolean) => void;
  onClear: () => void;
  onClearAll: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const all = props.values.map((v) => v.value);
  const q = query.trim().toLowerCase();
  // Checked values first, as in IDEA's popup.
  const list = (q ? props.values.filter((v) => (v.value ?? "<null>").toLowerCase().includes(q)) : props.values)
    .slice()
    .sort(
      (a, b) =>
        Number(props.checked ? !props.checked.has(a.value) : 0) -
        Number(props.checked ? !props.checked.has(b.value) : 0),
    );
  return (
    <Popup
      open
      anchor={props.anchor}
      placement="bottom-start"
      onClose={props.onClose}
      aria-label={tx`Local filter of ${props.column}`}
      className={styles.filterPopup}
      trapFocus
    >
      <Input
        autoFocus
        aria-label="Search values"
        placeholder={tx`Values of ${props.column}`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className={styles.filterValues} role="group" aria-label={tx("Values")}>
        {list.map(({ value: v, count }) => (
          <div key={v ?? "\u0000null"} className={styles.filterValue}>
            <Checkbox
              checked={props.checked ? props.checked.has(v) : true}
              onChange={(on) => props.onToggle(all, v, on)}
              label={v === null ? <span className={styles.null}>&lt;null&gt;</span> : v}
            />
            <span className={styles.filterCount}>{count}</span>
          </div>
        ))}
        {!list.length && (
          <div className={styles.filterEmpty}>
            <T>No matching values</T>
          </div>
        )}
      </div>
      <div className={styles.filterButtons}>
        <Button size="small" disabled={!props.checked} onClick={props.onClear}>
          <T>Clear Filter</T>
        </Button>
        <Button size="small" onClick={props.onClearAll}>
          <T>Clear Local Filter For All Columns</T>
        </Button>
      </div>
    </Popup>
  );
}

/**
 * IDEA's aggregator widget for a selection of several cells: "Sum: 4,213.5"; its menu
 * copies the result, picks the aggregate and opens the Aggregates view.
 */
function AggregatePill({ cells, onShowAll }: { cells: () => Cell[]; onShowAll: () => void }) {
  const chosen = useGridPrefs((s) => s.aggregate);
  const all = aggregates(cells());
  // Sums and averages need numbers: other selections count.
  const numeric = all.sum !== null;
  const shown: GridAggregate = !numeric && ["sum", "avg", "median"].includes(chosen) ? "count" : chosen;
  const label = AGGREGATE_ROWS.find(([, key]) => key === shown)![0];
  const result = (key: GridAggregate) => {
    const v = all[key];
    return v === null ? "—" : typeof v === "number" ? formatNumber(v) : v;
  };
  const text = `${tx(label)}: ${result(shown)}`;
  return (
    <button
      type="button"
      className={styles.aggregatePill}
      aria-haspopup="menu"
      title={tx("Aggregate of the selected cells")}
      onClick={(e) =>
        showContextMenu(e, [
          { label: "Copy Aggregation Result", icon: "copy", run: () => void copyText(text) },
          { kind: "separator" },
          ...AGGREGATE_ROWS.map(([l, key]): MenuItem => ({
            label: l,
            checked: key === shown,
            disabled: !numeric && ["sum", "avg", "median"].includes(key),
            run: () => setAggregate(key),
          })),
          { kind: "separator" },
          { label: "Show Aggregate View", run: onShowAll },
        ])
      }
    >
      {text}
    </button>
  );
}

const AGGREGATE_ROWS: ReadonlyArray<[label: string, key: GridAggregate]> = [
  ["Count", "count"],
  ["Distinct", "distinct"],
  ["Nulls", "nulls"],
  ["Sum", "sum"],
  ["Avg", "avg"],
  ["Median", "median"],
  ["Min", "min"],
  ["Max", "max"],
];

function SidePanel(props: {
  panel: DataPanel;
  onPanelChange: (p: DataPanel | null) => void;
  columns: readonly GridColumn[];
  shownCols: readonly number[];
  /** The lead cell's loaded row and column. */
  lead: { row: number; col: number } | null;
  cells: () => Cell[];
  value: (row: number, col: number) => Cell;
  editable: boolean;
  cellEditable: (row: number, col: number) => boolean;
  onEdit: (row: number, col: number, v: Cell) => void;
}) {
  const { lead, value, columns } = props;
  return (
    <aside className={styles.sidePanel} aria-label={tx("Value panel")}>
      <div className={styles.sidePanelHead}>
        <Tabs
          variant="compact"
          aria-label="Value panel"
          activeId={props.panel}
          onSelect={(id) => props.onPanelChange(id as DataPanel)}
          items={[
            { id: "record", label: "Record" },
            { id: "value", label: "Value" },
            { id: "aggregates", label: "Aggregates" },
          ]}
        />
        <span className={styles.spacer} />
        <IconButton icon="close" title="Hide" size="small" onClick={() => props.onPanelChange(null)} />
      </div>
      <div className={styles.sidePanelBody}>
        {!lead ? (
          <div className={styles.filterEmpty}>
            <T>Select a cell</T>
          </div>
        ) : props.panel === "record" ? (
          <div className={styles.recordFields}>
            {props.shownCols.map((i) => (
              <RecordField
                // A new value (another row, an edit elsewhere) starts the field over.
                key={`${lead.row}\u0000${columns[i]!.name}\u0000${value(lead.row, i) ?? "\u0001"}`}
                column={columns[i]!}
                cell={value(lead.row, i)}
                editable={props.editable && props.cellEditable(lead.row, i)}
                onCommit={(v) => props.onEdit(lead.row, i, v)}
              />
            ))}
          </div>
        ) : props.panel === "value" ? (
          <ValueView
            key={`${lead.row}:${lead.col}`}
            column={columns[lead.col]?.name ?? ""}
            cell={value(lead.row, lead.col)}
            editable={props.editable && props.cellEditable(lead.row, lead.col)}
            onCommit={(v) => props.onEdit(lead.row, lead.col, v)}
          />
        ) : (
          <AggregatesView cells={props.cells()} />
        )}
      </div>
    </aside>
  );
}

function RecordField(props: { column: GridColumn; cell: Cell; editable: boolean; onCommit: (v: Cell) => void }) {
  const [text, setText] = useState(props.cell ?? "");
  const commit = () => {
    if (text !== (props.cell ?? "") || (props.cell === null && text !== "")) props.onCommit(text);
  };
  const c = props.column;
  return (
    <label className={styles.recordField}>
      <span className={styles.recordLabel}>
        <Icon name={c.primaryKey ? "db-column-key" : c.foreignKey ? "db-column-fk" : "db-column"} size={16} />
        {c.name}
        {c.type && c.type !== "NULL" && <span className={styles.treeType}>{c.type}</span>}
      </span>
      <Input
        mono
        value={text}
        readOnly={!props.editable}
        placeholder={props.cell === null ? "<null>" : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
    </label>
  );
}

/** Pretty-prints JSON values (IDEA's Value editor formats them). */
function formatted(v: string): string | null {
  const t = v.trim();
  if (!/^[[{]/.test(t)) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}

function ValueView(props: { column: string; cell: Cell; editable: boolean; onCommit: (v: Cell) => void }) {
  const [text, setText] = useState(props.cell ?? "");
  const [wrap, setWrap] = useState(true);
  const pretty = props.cell !== null ? formatted(props.cell) : null;
  const image = useMemo(() => imageUrl(props.cell), [props.cell]);
  const dirty = text !== (props.cell ?? "") || (props.cell === null && text !== "");
  return (
    <div className={styles.valueView}>
      <div className={styles.valueTools}>
        <span className={styles.treeType}>{props.column}</span>
        <span className={styles.spacer} />
        {pretty !== null && !props.editable && (
          <IconButton
            icon="md-code-block"
            title="Format JSON"
            size="small"
            aria-pressed={text === pretty}
            onClick={() => setText(text === pretty ? (props.cell ?? "") : pretty)}
          />
        )}
        <IconButton
          icon="soft-wrap"
          title="Soft-Wrap"
          size="small"
          aria-pressed={wrap}
          onClick={() => setWrap(!wrap)}
        />
      </div>
      {image && (
        <div className={styles.valueImage}>
          <img src={image} alt={tx`Image in ${props.column}`} />
        </div>
      )}
      <textarea
        className={clsx(styles.valueText, !wrap && styles.valueNoWrap, image && styles.valueTextSmall)}
        aria-label={tx`Value of ${props.column}`}
        value={text}
        readOnly={!props.editable}
        placeholder={props.cell === null ? "<null>" : undefined}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && dirty) props.onCommit(text);
        }}
      />
      {props.editable && (
        <div className={styles.filterButtons}>
          <Button size="small" disabled={!dirty} onClick={() => props.onCommit(text)}>
            <T>Apply</T>
          </Button>
          <Button size="small" onClick={() => props.onCommit(null)}>
            <T>Set NULL</T>
          </Button>
        </div>
      )}
    </div>
  );
}

function AggregatesView({ cells }: { cells: Cell[] }) {
  const a = aggregates(cells);
  const show = (v: number | string | null) => (v === null ? "—" : typeof v === "number" ? formatNumber(v) : v);
  return (
    <table className={styles.aggregates}>
      <tbody>
        {AGGREGATE_ROWS.map(([label, key]) => (
          <tr key={key}>
            <th scope="row">
              <T>{label}</T>
            </th>
            <td>{show(a[key])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
