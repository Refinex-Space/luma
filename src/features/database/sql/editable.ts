/**
 * Editable query results (DataGrip's): a plain query over one table whose result holds
 * the table's whole primary key. Result columns that are table columns can be edited;
 * expressions and aliases stay read-only.
 */
import type { DbColumnInfo, DbDriver } from "@/platform/ipc";
import { analyze } from "./analyze";
import { hasSetOperation, isPlainQuery } from "./reshape";

/** The one table `statement` reads (schema as written), or `null`. */
export function queryTableOf(statement: string, driver: DbDriver): { schema: string | null; name: string } | null {
  if (!isPlainQuery(statement) || hasSetOperation(statement)) return null;
  const top = analyze(statement, statement.length, driver).refs.filter((r) => r.depth === 0);
  if (top.length !== 1 || top[0]!.kind !== "table") return null;
  return { schema: top[0]!.schema, name: top[0]!.name };
}

export interface EditMapping {
  /** Result column → table column (`null`: not a table column, read-only). */
  columns: Array<string | null>;
  primaryKey: string[];
}

/** Maps result columns to `table` columns by name; `null` unless every key column is in the result once. */
export function mapResultColumns(result: readonly string[], table: readonly DbColumnInfo[]): EditMapping | null {
  const lower = result.map((n) => n.toLowerCase());
  if (new Set(lower).size !== lower.length) return null;
  const columns = lower.map((n) => table.find((c) => c.name.toLowerCase() === n)?.name ?? null);
  const primaryKey = table.filter((c) => c.primaryKey).map((c) => c.name);
  if (!primaryKey.length || !primaryKey.every((k) => columns.includes(k))) return null;
  return { columns, primaryKey };
}
