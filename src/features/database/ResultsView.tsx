/**
 * Database Console service view (IDEA's): an Output tab logging every
 * executed statement with its outcome, and a `Result N` tab per result set —
 * a toolbar (re-run, export / copy as CSV, JSON, SQL…), the grid and a floating row count.
 */
import { copySelectionOnKeyDown } from "@/ui/selectableText";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { DbPlanNode } from "@/platform/ipc";
import { Button, EmptyState, Icon, IconButton, Spinner, Tabs, Tree, showContextMenu, T, type MenuItem } from "@/ui";
import { ChartView } from "./ChartView";
import {
  DataView,
  ExtractorSelect,
  PanelToggle,
  exportMenu,
  shownData,
  useGridView,
  viewMenu,
  type DataPanel,
} from "./DataView";
import type { ExportData } from "./export";
import { emptyEdits, hasEdits, type Cell, type PendingEdits } from "./model";
import { addRow, deleteRows, editedValue, isModified, revertCells, rowState, setCell } from "./rowEdits";
import { RedisReplyView } from "./redis/console/ReplyView";
import { EsResponseView } from "./elastic/EsResponseView";

const NO_EDITS = emptyEdits();
const NO_ROWS: ReadonlyArray<readonly Cell[]> = [];
import { analyze } from "./sql/analyze";
import {
  MAX_ALL_ROWS,
  OUTPUT_TAB,
  clearOutput,
  closeResult,
  countResult,
  fetchAllRows,
  outcomeSummary,
  pageResult,
  rerunResult,
  resolveResultEdit,
  setResultEdits,
  setResultPageSize,
  sortResult,
  submitResultEdits,
  sourceById,
  targetLabel,
  useDatabase,
  type OutputLine,
  type ResultTab,
} from "./store";
import styles from "./Database.module.css";
import { tx } from "@/platform/i18n";

function time(t: number): string {
  const d = new Date(t);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function Output() {
  const lines = useDatabase((s) => s.output);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <span className={styles.spacer} />
        <IconButton icon="trash" title="Clear All" disabled={!lines.length} onClick={clearOutput} />
      </div>
      <div
        ref={ref}
        className={styles.output}
        tabIndex={0}
        onKeyDown={copySelectionOnKeyDown}
        role="log"
        aria-label={tx("Database output")}
      >
        {lines.map((l: OutputLine) => (
          <div key={l.id} className={clsx(styles.outputLine, l.kind === "error" && styles.outputError)}>
            <span className={styles.outputTime}>[{time(l.time)}]</span>{" "}
            {l.prompt && <span className={styles.outputPrompt}>{l.prompt} </span>}
            <span className={l.kind === "statement" ? styles.outputStatement : undefined}>{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The table a query reads (target of SQL extractors), else IDEA's placeholder. */
function queryTable(text: string, data: Pick<ExportData, "driver">): string {
  const a = analyze(text, text.length, data.driver);
  return a.refs.find((r) => r.depth === 0 && r.kind === "table")?.name ?? "MY_TABLE";
}

const PAGE_SIZES = [10, 100, 500, 1000];

/** IDEA's pagination: ⏮ ◀ "1–500 ▾" (page size, Count Rows) "of N" ▶ ⏭. */
function Pager({ tab, shown }: { tab: ResultTab; shown: number }) {
  const shape = tab.shape!;
  const { offset, pageSize, total } = shape;
  const last = total !== null && offset + shown >= total;
  const more = !!tab.outcome.result?.hasMore;
  const label = shown ? `${offset + 1}–${offset + shown}` : "0";
  const totalText = total?.toLocaleString("en") ?? "";
  // IDEA: "of 500+" until the rows are counted.
  const atLeast = (offset + shown).toLocaleString("en");
  const busy = !!tab.busy;
  return (
    <div className={styles.pager}>
      <IconButton
        icon="page-first"
        title="First Page"
        disabled={busy || offset === 0}
        onClick={() => void pageResult(tab.id, "first")}
      />
      <IconButton
        icon="chevron-left"
        title="Previous Page"
        disabled={busy || offset === 0}
        onClick={() => void pageResult(tab.id, "previous")}
      />
      <button
        type="button"
        className={styles.pageRange}
        aria-haspopup="menu"
        title={tx("Page size")}
        onClick={(e) =>
          showContextMenu(e, [
            {
              label: "Count Rows",
              disabled: busy || total !== null || !!shape.counting,
              run: () => void countResult(tab.id),
            },
            { kind: "header", label: "Page Size" },
            ...PAGE_SIZES.map((n): MenuItem => ({
              label: n.toLocaleString("en"),
              checked: n === pageSize,
              run: () => void setResultPageSize(tab.id, n),
            })),
            { label: "All", checked: pageSize >= MAX_ALL_ROWS, run: () => void setResultPageSize(tab.id, 0) },
          ])
        }
      >
        {label}
        <Icon name="chevron-down" size={12} className={styles.pageRangeChevron} />
      </button>
      <button
        type="button"
        className={styles.pageTotal}
        disabled={busy || total !== null || !!shape.counting || !more}
        title={total === null ? tx("Count rows (SELECT COUNT(*))") : undefined}
        onClick={() => void countResult(tab.id)}
      >
        {shape.counting ? <Spinner size={10} /> : total !== null ? tx`of ${totalText}` : tx`of ${atLeast}+`}
      </button>
      <IconButton
        icon="chevron-right"
        title="Next Page"
        disabled={busy || !more || last}
        onClick={() => void pageResult(tab.id, "next")}
      />
      <IconButton
        icon="page-last"
        title="Last Page"
        disabled={busy || (!more && total !== null && last) || (!more && total === null)}
        onClick={() => void pageResult(tab.id, "last")}
      />
    </div>
  );
}

function Result({ tab }: { tab: ResultTab }) {
  const [mode, setMode] = useState<"table" | "chart">("table");
  const [panel, setPanel] = useState<DataPanel | null>(null);
  const r = tab.outcome.result;
  const edit = tab.edit ?? null;
  const edits = tab.edits ?? NO_EDITS;
  const names = useMemo(() => edit?.columns ?? [], [edit]);
  const columns = useMemo(
    () =>
      r
        ? r.columns.map((c, i) => ({
            name: c.name,
            type: c.typeName,
            primaryKey: !!names[i] && !!edit?.primaryKey.includes(names[i]!),
          }))
        : [],
    [r, names, edit],
  );
  const view = useGridView(columns);
  const rows = r?.rows ?? NO_ROWS;
  const value = useCallback(
    (row: number, col: number) => editedValue(edits, rows, names, row, col),
    [edits, rows, names],
  );
  useEffect(() => {
    if (tab.edit === undefined && r) void resolveResultEdit(tab.id);
  }, [tab.edit, tab.id, r]);
  if (!r) return null;
  const driver = sourceById(tab.sourceId)?.driver ?? "sqlite";
  const target = edit
    ? { table: edit.table, schema: edit.schema, driver }
    : { table: queryTable(tab.outcome.statement.text, { driver }), driver };
  const loaded = r.rows.length;
  const update = (f: (e: PendingEdits) => PendingEdits) => setResultEdits(tab.id, f(tab.edits ?? emptyEdits()));
  const dirty = hasEdits(edits);
  const shape = tab.shape;
  const paged = !!shape && !shape.fixed;
  const data = (): ExportData => shownData({ ...target, columns, rows: r.rows }, view);
  const loadAll =
    paged && (r.hasMore || shape.offset > 0)
      ? async () => {
          const all = await fetchAllRows(tab.id);
          return all && shownData({ ...target, columns, rows: all.rows }, view);
        }
      : undefined;
  const firstRow = (shape?.offset ?? 0) + 1;
  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <IconButton icon="db-table" title="Table" aria-pressed={mode === "table"} onClick={() => setMode("table")} />
        <IconButton icon="db-chart" title="Chart" aria-pressed={mode === "chart"} onClick={() => setMode("chart")} />
        <span className={styles.toolbarSeparator} />
        {paged && (
          <>
            <Pager tab={tab} shown={r.rows.length} />
            <span className={styles.toolbarSeparator} />
          </>
        )}
        <IconButton icon="refresh" title="Rerun Query" disabled={tab.busy} onClick={() => void rerunResult(tab.id)} />
        {edit && mode === "table" && (
          <>
            <IconButton
              icon="plus"
              title="Add Row"
              disabled={tab.busy}
              onClick={() => update((e) => addRow(e, names))}
            />
            <Button
              size="small"
              variant="primary"
              disabled={!dirty || tab.busy}
              title={tx`Submit changes to ${edit.table}`}
              onClick={() => void submitResultEdits(tab.id)}
            >
              <T>Submit</T>
            </Button>
            <Button size="small" disabled={!dirty} onClick={() => setResultEdits(tab.id, emptyEdits())}>
              <T>Revert</T>
            </Button>
          </>
        )}
        {mode === "table" && (
          <IconButton
            icon="settings"
            title="View Options"
            aria-haspopup="menu"
            onClick={(e) => showContextMenu(e, viewMenu(view, columns))}
          />
        )}
        {tab.busy && <Spinner size={12} />}
        <span className={styles.spacer} />
        <span className={styles.resultSource} title={tab.outcome.statement.text}>
          {targetLabel(tab.sourceId)}
        </span>
        <ExtractorSelect />
        <IconButton
          icon="export"
          title="Export Data"
          aria-haspopup="menu"
          onClick={(e) => showContextMenu(e, exportMenu(data(), target.table, loadAll))}
        />
        {mode === "table" && <PanelToggle panel={panel} onChange={setPanel} />}
      </div>
      {mode === "chart" ? (
        <div className={styles.fill}>
          <ChartView columns={columns} rows={r.rows} />
        </div>
      ) : (
        <div className={clsx(styles.fill, styles.gridHost, tab.busy && styles.gridBusy)}>
          <DataView
            columns={columns}
            rowCount={loaded + edits.inserts.length}
            fixedRows={loaded}
            value={value}
            firstRowNumber={firstRow}
            editable={!!edit && !tab.busy}
            cellEditable={(_, c) => !!names[c]}
            onEdit={(row, col, v) => update((e) => setCell(e, rows, names, row, col, v))}
            rowState={edit ? (row) => rowState(edits, loaded, row) : undefined}
            isModified={edit ? (row, col) => isModified(edits, names, row, col) : undefined}
            onRevert={edit ? (rs, cs) => update((e) => revertCells(e, names, loaded, rs, cs)) : undefined}
            onDeleteRows={edit ? (rs) => update((e) => deleteRows(e, loaded, rs)) : undefined}
            rowMenu={
              edit
                ? (rs) => [
                    { label: "Add Row", icon: "plus", run: () => update((e) => addRow(e, names)) },
                    {
                      label: "Clone Row",
                      disabled: rs.length !== 1,
                      run: () => update((e) => addRow(e, names, (c) => value(rs[0]!, c))),
                    },
                    {
                      label: "Delete Rows",
                      icon: "trash",
                      shortcut: "⌘⌫",
                      run: () => update((e) => deleteRows(e, loaded, rs)),
                    },
                  ]
                : undefined
            }
            sort={paged ? shape.sort : undefined}
            onSortChange={paged ? (next) => void sortResult(tab.id, next) : undefined}
            target={target}
            view={view}
            panel={panel}
            onPanelChange={setPanel}
            aria-label={tab.title}
          />
          <div className={styles.rowPill} role="status" title={outcomeSummary(tab.outcome)}>
            {rowsLabel(r.rows.length, shape, r.hasMore)}
          </div>
        </div>
      )}
    </div>
  );
}

/** "4 rows", "500 of 1,204 rows", "500+ rows" (more not counted yet). */
function rowsLabel(shown: number, shape: ResultTab["shape"], more: boolean): string {
  const total = shape?.total ?? null;
  const count = shown.toLocaleString("en");
  if (total !== null && total !== shown) {
    const [visible, rowCount] = [count, total.toLocaleString("en")];
    return tx`${visible} of ${rowCount} rows`;
  }
  if (more) return tx`${count}+ rows`;
  return shown === 1 ? tx`${shown} row` : tx`${count} rows`;
}

interface PlanRow {
  node: DbPlanNode;
  index: number;
  key: string;
}

/** IDEA's operation icons: a table for scans of one, a key for index lookups, an arrow for the statement. */
function planIcon(r: PlanRow): string | null {
  if (r.index < 0) return "arrow-left";
  if (/index/i.test(r.node.operation)) return "db-key";
  if (/scan/i.test(r.node.operation)) return "db-table";
  return null;
}

/** IDEA's Query Plan tab: the operation tree with its parameters, the selected operation's properties beside it. */
function PlanResult({ tab }: { tab: ResultTab }) {
  const plan = useMemo(() => tab.plan ?? [], [tab.plan]);
  const rows = useMemo(() => plan.map((node, index): PlanRow => ({ node, index, key: String(index) })), [plan]);
  // IDEA roots the operations in the statement itself ("Select").
  const statement = useMemo((): PlanRow => {
    const kind = /^\s*(\w+)/.exec(tab.outcome.statement.text)?.[1]?.toLowerCase() ?? "statement";
    const operation = kind[0]!.toUpperCase() + kind.slice(1);
    return {
      node: { parent: null, operation, params: "", properties: [{ name: "Operation", value: kind }] },
      index: -1,
      key: "statement",
    };
  }, [tab.outcome.statement.text]);
  const [selected, setSelected] = useState(-1);
  // Everything starts expanded, a re-explained plan too.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const keys = useMemo(() => [statement.key, ...rows.map((r) => r.key)], [statement, rows]);
  const expanded = useMemo(() => new Set(keys.filter((k) => !collapsed.has(k))), [keys, collapsed]);
  const setExpanded = (next: ReadonlySet<string>) => setCollapsed(new Set(keys.filter((k) => !next.has(k))));
  const children = (r: PlanRow) =>
    r === statement ? rows.filter((c) => c.node.parent === null) : rows.filter((c) => c.node.parent === r.index);
  const props = (selected < 0 ? statement : rows[selected])?.node.properties ?? [];
  const selectedKey = selected < 0 ? statement.key : String(selected);
  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <IconButton icon="refresh" title="Explain Again" disabled={tab.busy} onClick={() => void rerunResult(tab.id)} />
        {tab.busy && <Spinner size={12} />}
        <span className={styles.spacer} />
        <span className={styles.resultSource} title={tab.outcome.statement.text}>
          {targetLabel(tab.sourceId)}
        </span>
      </div>
      <div className={clsx(styles.fill, styles.planView)}>
        <div className={styles.planTree}>
          <div className={styles.planHeader}>
            <span>
              <T>Operation</T>
            </span>
            <span>
              <T>Params</T>
            </span>
          </div>
          {plan.length ? (
            <Tree<PlanRow>
              aria-label="Query plan"
              roots={[statement]}
              selected={new Set([selectedKey])}
              expanded={expanded}
              onExpandedChange={setExpanded}
              getKey={(r) => r.key}
              getLabel={(r) => r.node.operation}
              getChildren={(r) => children(r)}
              isExpandable={(r) => children(r).length > 0}
              onSelectionChange={(_, lead) => lead && setSelected(lead.index)}
              renderNode={(r) => (
                <span className={styles.planRow}>
                  <span className={styles.planOperation}>
                    {planIcon(r) && <Icon name={planIcon(r)!} size={16} />}
                    {r.node.operation}
                  </span>
                  <span className={styles.planParams}>{r.node.params}</span>
                </span>
              )}
            />
          ) : (
            <EmptyState title="Empty plan" />
          )}
        </div>
        <table className={styles.planProperties} aria-label={tx("Plan node properties")}>
          <thead>
            <tr>
              <th>
                <T>Property</T>
              </th>
              <th>
                <T>Value</T>
              </th>
            </tr>
          </thead>
          <tbody>
            {props.map((p) => (
              <tr key={p.name}>
                <td>{p.name}</td>
                <td>{p.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Output and the `Result N` tabs, in the Database Console tool window's header (like Run's sessions). */
export function ResultTabs() {
  const results = useDatabase((s) => s.results);
  const active = useDatabase((s) => s.activeResult);
  const hasOutput = useDatabase((s) => s.output.length > 0);
  if (!results.length && !hasOutput) return null;
  const tab = results.find((r) => r.id === active);
  return (
    <Tabs
      variant="compact"
      className={styles.resultTabs}
      aria-label="Results"
      activeId={tab ? String(tab.id) : String(OUTPUT_TAB)}
      onSelect={(id) => useDatabase.setState({ activeResult: Number(id) })}
      onClose={(id) => closeResult(Number(id))}
      items={[
        { id: String(OUTPUT_TAB), label: "Output", icon: "db-console", closable: false },
        ...results.map((r) => ({
          id: String(r.id),
          label: r.title,
          icon: r.plan ? "db-plan" : r.redis ? "db-redis" : r.elastic ? "db-elasticsearch" : "db-table",
          closable: true,
          tooltip: r.outcome.statement.text,
        })),
      ]}
    />
  );
}

export function ResultsView() {
  const results = useDatabase((s) => s.results);
  const active = useDatabase((s) => s.activeResult);
  const hasOutput = useDatabase((s) => s.output.length > 0);
  if (!results.length && !hasOutput)
    return (
      <EmptyState title="No results">
        <T>Execute a statement in a query console with ⌘↩.</T>
      </EmptyState>
    );
  const tab = results.find((r) => r.id === active);
  if (tab?.redis) return <RedisReplyView key={tab.id} outcome={tab.redis.outcome} target={tab.sourceId} />;
  if (tab?.elastic) return <EsResponseView key={tab.id} tab={tab} />;
  return !tab ? <Output /> : tab.plan ? <PlanResult key={tab.id} tab={tab} /> : <Result key={tab.id} tab={tab} />;
}
