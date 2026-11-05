/**
 * Re-querying a console result (IDEA's "Sort via ORDER BY", paging and Count Rows): the
 * statement is wrapped as a derived table and ordered by result column position, so
 * sorting covers every row of the query, not only the fetched page.
 */
import type { DbDriver } from "@/platform/ipc";

export interface OrderKey {
  /** 0-based result column. */
  column: number;
  descending: boolean;
}

/** The query without its trailing `;` and blanks. */
function body(statement: string): string {
  return statement
    .trim()
    .replace(/;+\s*$/, "")
    .trimEnd();
}

/** Comments and string / identifier literals blanked, for keyword checks. */
function code(text: string): string {
  return text
    .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]/g, "''");
}

/**
 * One query (SELECT, WITH, VALUES, TABLE) that writes and locks nothing: no second
 * statement, SELECT … INTO, row locks or data-modifying CTE.
 */
export function isPlainQuery(statement: string): boolean {
  const c = code(body(statement));
  if (!/^\s*\(?\s*(select|with|values|table)\b/i.test(c)) return false;
  if (/;/.test(c) || /\binto\b|\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i.test(c)) return false;
  return !(/^\s*with\b/i.test(c) && /\b(insert|update|delete|merge)\b/i.test(c));
}

/** Set operations at any level (`UNION`, `INTERSECT`, `EXCEPT`, `MINUS`). */
export function hasSetOperation(statement: string): boolean {
  return /\b(union|intersect|except|minus)\b/i.test(code(body(statement)));
}

/**
 * Whether `statement` can be re-queried as a derived table: one query (SELECT, WITH,
 * VALUES, TABLE) that writes nothing, with result column names a derived table accepts
 * (distinct; named on SQL Server).
 */
export function canReshape(statement: string, columns: readonly string[], driver: DbDriver): boolean {
  if (!isPlainQuery(statement)) return false;
  const names = columns.map((n) => n.toLowerCase());
  if (new Set(names).size !== names.length) return false;
  if (driver === "sqlServer" && names.some((n) => !n)) return false;
  return true;
}

/** `statement` ordered by `order`, `offset` rows skipped, at most `limit` rows (when given). */
export function reshapeQuery(
  driver: DbDriver,
  statement: string,
  order: readonly OrderKey[],
  offset: number,
  limit: number | null,
): string {
  const by = order.map((k) => `${k.column + 1}${k.descending ? " DESC" : ""}`).join(", ");
  let sql = `SELECT * FROM (\n${body(statement)}\n) luma_q`;
  if (driver === "sqlServer") {
    // OFFSET … FETCH needs an ORDER BY.
    if (by || offset || limit !== null) sql += ` ORDER BY ${by || "(SELECT NULL)"}`;
    if (offset || limit !== null) sql += ` OFFSET ${offset} ROWS`;
    if (limit !== null) sql += ` FETCH NEXT ${limit} ROWS ONLY`;
    return sql;
  }
  if (by) sql += ` ORDER BY ${by}`;
  if (limit !== null) sql += ` LIMIT ${limit}`;
  else if (offset && driver === "mysql") sql += " LIMIT 18446744073709551615";
  else if (offset && driver === "sqlite") sql += " LIMIT -1";
  if (offset) sql += ` OFFSET ${offset}`;
  return sql;
}

/** IDEA's Count Rows: the number of rows `statement` returns. */
export function countQuery(statement: string): string {
  return `SELECT COUNT(*) FROM (\n${body(statement)}\n) luma_q`;
}
