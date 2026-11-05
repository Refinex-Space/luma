/**
 * Pending edits of a data grid (IDEA's `GridMutator`): changed cells, deleted rows and
 * added rows over the loaded rows, kept until Submit. Shared by the table editor and
 * editable query results; columns are named by the table's columns (`names[col]`,
 * `null` for a result column that is no table column).
 */
import { emptyEdits, type Cell, type PendingEdits } from "./model";

export type ColumnNames = ReadonlyArray<string | null>;

/** The shown value: the pending edit, an added row's value, else the loaded one. */
export function editedValue(
  edits: PendingEdits,
  rows: ReadonlyArray<readonly Cell[]>,
  names: ColumnNames,
  row: number,
  col: number,
): Cell {
  const name = names[col];
  if (row >= rows.length) {
    const ins = edits.inserts[row - rows.length];
    return name && ins?.has(name) ? ins.get(name)! : null;
  }
  const upd = name ? edits.updates.get(row) : undefined;
  if (name && upd?.has(name)) return upd.get(name)!;
  return rows[row]?.[col] ?? null;
}

/** `edits` with cell (`row`, `col`) set to `v`; setting a loaded cell back to its value drops the edit. */
export function setCell(
  edits: PendingEdits,
  rows: ReadonlyArray<readonly Cell[]>,
  names: ColumnNames,
  row: number,
  col: number,
  v: Cell,
): PendingEdits {
  const name = names[col];
  if (!name) return edits;
  const next: PendingEdits = {
    updates: new Map(edits.updates),
    deletes: new Set(edits.deletes),
    inserts: [...edits.inserts],
  };
  if (row >= rows.length) {
    const ins = new Map(next.inserts[row - rows.length]);
    ins.set(name, v);
    next.inserts[row - rows.length] = ins;
    return next;
  }
  const upd = new Map(next.updates.get(row));
  if ((rows[row]?.[col] ?? null) === v) upd.delete(name);
  else upd.set(name, v);
  if (upd.size) next.updates.set(row, upd);
  else next.updates.delete(row);
  return next;
}

/** Marks loaded rows deleted; added rows among `targets` are dropped. */
export function deleteRows(edits: PendingEdits, loaded: number, targets: readonly number[]): PendingEdits {
  const deletes = new Set(edits.deletes);
  const gone = new Set(targets.filter((r) => r >= loaded).map((r) => r - loaded));
  for (const r of targets) if (r < loaded) deletes.add(r);
  return { ...edits, deletes, inserts: edits.inserts.filter((_, i) => !gone.has(i)) };
}

/** IDEA's Revert Selected: the cells' edits undone, deleted rows restored, added rows dropped. */
export function revertCells(
  edits: PendingEdits,
  names: ColumnNames,
  loaded: number,
  targets: readonly number[],
  cols: readonly number[],
): PendingEdits {
  const updates = new Map(edits.updates);
  for (const r of targets) {
    const upd = updates.get(r);
    if (!upd) continue;
    const next = new Map(upd);
    for (const c of cols) if (names[c]) next.delete(names[c]!);
    if (next.size) updates.set(r, next);
    else updates.delete(r);
  }
  const deletes = new Set([...edits.deletes].filter((d) => !targets.includes(d)));
  const dropped = new Set(targets.filter((r) => r >= loaded).map((r) => r - loaded));
  return { updates, deletes, inserts: edits.inserts.filter((_, i) => !dropped.has(i)) };
}

/** A new row (IDEA's Add Row), or one with the values of `from` (Clone Row; table columns only). */
export function addRow(edits: PendingEdits, names: ColumnNames, from?: (col: number) => Cell): PendingEdits {
  const values = new Map<string, Cell>();
  if (from) names.forEach((n, c) => n && values.set(n, from(c)));
  return { ...edits, inserts: [...edits.inserts, values] };
}

export function rowState(edits: PendingEdits, loaded: number, row: number): "inserted" | "deleted" | null {
  return row >= loaded ? "inserted" : edits.deletes.has(row) ? "deleted" : null;
}

export function isModified(edits: PendingEdits, names: ColumnNames, row: number, col: number): boolean {
  const name = names[col];
  return !!name && !!edits.updates.get(row)?.has(name);
}

/** Statements the edits make (Submit's count and the discard question). */
export function editCount(edits: PendingEdits): number {
  return (
    [...edits.updates.keys()].filter((r) => !edits.deletes.has(r)).length + edits.deletes.size + edits.inserts.length
  );
}

export { emptyEdits };
