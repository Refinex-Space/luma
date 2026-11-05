/**
 * Table data editor (editor tab): pages of rows with sorting (header click),
 * a WHERE filter, and pending cell edits / added / deleted rows submitted
 * together in one transaction. Tables without a primary key are read-only.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  call,
  commands,
  isCancelled,
  nextRequestId,
  type DbSortKey,
  type DbTablePage,
  type RequestId,
} from "@/platform/ipc";
import { Button, EmptyState, Icon, IconButton, Select, Spinner, T, showContextMenu } from "@/ui";
import { notifications, type EditorInput } from "@/workbench/contributions";
import { SqlFilterInput } from "./SqlFilterInput";
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
import {
  buildRowEdits,
  emptyEdits,
  formatOrderBy,
  hasEdits,
  parseOrderBy,
  type Cell,
  type PendingEdits,
} from "./model";
import { countTableRows, openDialog, sourceById, withConnection } from "./store";
import type { TableRef } from "./tableInput";
import { addRow, deleteRows as removeRows, editedValue, isModified, revertCells, rowState, setCell } from "./rowEdits";
import styles from "./Database.module.css";
import { tx } from "@/platform/i18n";

const PAGE_SIZES = ["100", "500", "1000", "5000"];

export { tableTitle } from "./tableInput";

const NO_ROWS: ReadonlyArray<readonly Cell[]> = [];

export function TableEditor({ input }: { input: EditorInput }) {
  const ref = input.data as TableRef;
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(500);
  const [sort, setSort] = useState<DbSortKey[]>([]);
  const [filterText, setFilterText] = useState("");
  const [filter, setFilter] = useState("");
  const [nonce, setNonce] = useState(0);
  const [edits, setEdits] = useState<PendingEdits>(emptyEdits);
  const [panel, setPanel] = useState<DataPanel | null>(null);
  // The ORDER BY field while it's being edited; it shows the sort otherwise.
  const [orderDraft, setOrderDraft] = useState<string | null>(null);
  // The page for the current parameters (`key`); stale while loading.
  const [loadedPage, setLoadedPage] = useState<{ key: string; page: DbTablePage | null; error: string | null } | null>(
    null,
  );
  const key = JSON.stringify([ref.id, ref.schema, ref.table, filter, sort, offset, limit, nonce]);
  const loading = loadedPage?.key !== key;
  const page = loadedPage?.page ?? null;
  const error = loadedPage?.error ?? null;
  const reload = () => setNonce((n) => n + 1);

  useEffect(() => {
    const id: RequestId = nextRequestId();
    let done = false;
    void (async () => {
      try {
        const p = await withConnection(ref.id, () =>
          call(commands.dbTablePage(id, ref.id, ref.schema, ref.table, filter || null, sort, offset, limit)),
        );
        setLoadedPage({ key, page: p, error: null });
        setEdits(emptyEdits());
      } catch (e) {
        if (!isCancelled(e))
          setLoadedPage((prev) => ({
            key,
            page: prev?.page ?? null,
            error: e instanceof Error ? e.message : String(e),
          }));
      } finally {
        done = true;
      }
    })();
    return () => {
      if (!done) void commands.cancelRequest(id);
    };
  }, [key, ref.id, ref.schema, ref.table, filter, sort, offset, limit]);

  const columns = page?.result.columns ?? [];
  const names = columns.map((c) => c.name);
  const pk = page?.details.columns.filter((c) => c.primaryKey).map((c) => c.name) ?? [];
  const fkColumns = new Set(page?.details.foreignKeys.flatMap((k) => k.columns) ?? []);
  const editable = pk.length > 0 && !sourceById(ref.id)?.readOnly;
  const loaded = page?.result.rows.length ?? 0;
  const rowCount = loaded + edits.inserts.length;
  const gridColumns = useMemo(
    () =>
      columns.map((c) => ({
        name: c.name,
        type: c.typeName,
        primaryKey: pk.includes(c.name),
        foreignKey: fkColumns.has(c.name),
      })),
    // `pk` / `fkColumns` derive from `page`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page],
  );

  const rows = page?.result.rows ?? NO_ROWS;
  const value = useCallback(
    (row: number, col: number): Cell => editedValue(edits, rows, names, row, col),
    // `names` derives from `page`, like `rows`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, edits],
  );
  const onEdit = (row: number, col: number, v: Cell) => setEdits((e) => setCell(e, rows, names, row, col, v));
  const view = useGridView(gridColumns);
  const revert = (targets: number[], cols: number[]) => setEdits((e) => revertCells(e, names, loaded, targets, cols));
  const cloneRow = (row: number) => setEdits((e) => addRow(e, names, (c) => value(row, c)));
  const deleteRows = (targets: number[]) => setEdits((e) => removeRows(e, loaded, targets));

  const submit = async () => {
    if (!page) return;
    try {
      const n = await call(
        commands.dbApplyEdits(ref.id, ref.schema, ref.table, buildRowEdits(names, page.result.rows, pk, edits)),
      );
      notifications().notify({ level: "info", title: `${ref.table}: ${n} row(s) changed`, key: "db-submit" });
      reload();
    } catch (e) {
      notifications().notify({
        level: "error",
        title: "Changes were not submitted",
        body: e instanceof Error ? e.message : String(e),
        key: "db-submit",
      });
    }
  };

  // Count Rows: of the table with the current filter (exact once counted, or when one page holds all).
  const countKey = JSON.stringify([ref.id, ref.schema, ref.table, filter, nonce]);
  const [counted, setCounted] = useState<{ key: string; n: number | null; busy: boolean } | null>(null);
  const counting = counted?.key === countKey && counted.busy;
  const total =
    counted?.key === countKey && counted.n !== null
      ? counted.n
      : page && !page.result.hasMore && !loading
        ? offset + loaded
        : null;
  const totalText = total?.toLocaleString("en") ?? "";
  const atLeast = (offset + loaded).toLocaleString("en");
  const count = async (): Promise<number | null> => {
    setCounted({ key: countKey, n: null, busy: true });
    const n = await countTableRows(ref.id, ref.schema, ref.table, filter);
    setCounted({ key: countKey, n, busy: false });
    return n;
  };
  const lastPage = async () => {
    const n = total ?? (await count());
    if (n !== null) setOffset(Math.max(0, Math.floor((n - 1) / limit) * limit));
  };

  const onSortChange = (next: DbSortKey[]) => {
    setOffset(0);
    setSort(next);
  };

  const dirty = hasEdits(edits);
  const target = { table: ref.table, schema: ref.schema, driver: sourceById(ref.id)?.driver ?? "sqlite" };
  const orderInvalid = orderDraft !== null && !parseOrderBy(orderDraft, names);
  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <div className={styles.pager}>
          <IconButton
            icon="page-first"
            title="First Page"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(0)}
          />
          <IconButton
            icon="chevron-left"
            title="Previous Page"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - limit))}
          />
          <span className={styles.pageRange}>{loaded ? `${offset + 1}–${offset + loaded}` : "0"}</span>
          <button
            type="button"
            className={styles.pageTotal}
            disabled={total !== null || counting || !page?.result.hasMore}
            title={total === null ? tx("Count rows (SELECT COUNT(*))") : undefined}
            onClick={() => void count()}
          >
            {counting ? <Spinner size={10} /> : total !== null ? tx`of ${totalText}` : tx`of ${atLeast}+`}
          </button>
          <IconButton
            icon="chevron-right"
            title="Next Page"
            disabled={!page?.result.hasMore || loading}
            onClick={() => setOffset(offset + limit)}
          />
          <IconButton
            icon="page-last"
            title="Last Page"
            disabled={!page?.result.hasMore || loading}
            onClick={() => void lastPage()}
          />
          <Select
            aria-label="Page size"
            value={String(limit)}
            options={PAGE_SIZES.map((v) => ({ value: v, label: v }))}
            onChange={(v) => {
              setOffset(0);
              setLimit(Number(v));
            }}
          />
        </div>
        <span className={styles.toolbarSeparator} />
        <IconButton icon="refresh" title="Reload Page" onClick={reload} disabled={loading} />
        {editable && (
          <>
            <IconButton icon="plus" title="Add Row" onClick={() => setEdits((e) => addRow(e, names))} />
            <Button size="small" variant="primary" disabled={!dirty} onClick={() => void submit()}>
              <T>Submit</T>
            </Button>
            <Button size="small" disabled={!dirty} onClick={() => setEdits(emptyEdits())}>
              <T>Revert</T>
            </Button>
          </>
        )}
        {loading && <Spinner size={12} />}
        <span className={styles.spacer} />
        <ExtractorSelect />
        <IconButton
          icon="export"
          title="Export Data"
          aria-haspopup="menu"
          disabled={!page}
          onClick={(e) =>
            page &&
            showContextMenu(
              e,
              exportMenu(
                shownData({ ...target, columns: gridColumns, rows: page.result.rows }, view),
                `${ref.schema}.${ref.table}`,
              ),
            )
          }
        />
        <IconButton
          icon="import"
          title="Import Data from File…"
          disabled={!editable}
          onClick={() => openDialog({ kind: "import", id: ref.id, schema: ref.schema, table: ref.table })}
        />
        <IconButton
          icon="settings"
          title="View Options"
          aria-haspopup="menu"
          onClick={(e) => showContextMenu(e, viewMenu(view, gridColumns))}
        />
        <PanelToggle panel={panel} onChange={setPanel} />
      </div>
      <div className={styles.filterBar}>
        <label className={styles.filterField}>
          <Icon name="filter" size={14} />
          <SqlFilterInput
            kind="where"
            schema={ref.schema}
            table={ref.table}
            columns={gridColumns}
            driver={sourceById(ref.id)?.driver ?? "sqlite"}
            value={filterText}
            onChange={setFilterText}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setOffset(0);
                setFilter(filterText.trim());
              }
            }}
          />
        </label>
        <label className={styles.filterField}>
          <Icon name="db-sort" size={14} />
          <SqlFilterInput
            kind="order"
            schema={ref.schema}
            table={ref.table}
            columns={gridColumns}
            driver={sourceById(ref.id)?.driver ?? "sqlite"}
            invalid={orderInvalid}
            value={orderDraft ?? formatOrderBy(sort)}
            onChange={setOrderDraft}
            onBlur={() => !orderInvalid && setOrderDraft(null)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOrderDraft(null);
              if (e.key !== "Enter" || orderDraft === null) return;
              const next = parseOrderBy(orderDraft, names);
              if (!next) return;
              setOffset(0);
              setSort(next);
              setOrderDraft(null);
            }}
          />
        </label>
      </div>
      {page && !editable && (
        <div className={styles.notice}>
          {pk.length ? tx("Read-only data source.") : tx("Read-only: the table has no primary key to identify rows.")}
        </div>
      )}
      {error ? (
        <pre className={styles.error}>{error}</pre>
      ) : !page ? (
        <EmptyState title="Loading…" />
      ) : (
        <div className={styles.fill}>
          <DataView
            aria-label={tx`${ref.table} data`}
            columns={gridColumns}
            rowCount={rowCount}
            fixedRows={loaded}
            value={value}
            panel={panel}
            onPanelChange={setPanel}
            firstRowNumber={offset + 1}
            rowState={(r) => rowState(edits, loaded, r)}
            isModified={(r, c) => isModified(edits, names, r, c)}
            editable={editable}
            onEdit={onEdit}
            sort={sort}
            onSortChange={onSortChange}
            target={target}
            view={view}
            onRevert={editable ? revert : undefined}
            onDeleteRows={editable ? deleteRows : undefined}
            rowMenu={(rows) =>
              editable
                ? [
                    {
                      label: "Add Row",
                      icon: "plus",
                      run: () => setEdits((e) => addRow(e, names)),
                    },
                    { label: "Clone Row", disabled: rows.length !== 1, run: () => cloneRow(rows[0]!) },
                    { label: "Delete Rows", icon: "trash", shortcut: "⌘⌫", run: () => deleteRows(rows) },
                  ]
                : []
            }
          />
        </div>
      )}
    </div>
  );
}
