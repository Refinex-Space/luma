/**
 * Data extractors (IDEA's, of the grid's Copy and Export Data): SQL INSERT / multi-row
 * INSERT / UPDATE statements, One-row literals, JSON, Markdown, HTML, XML, a pretty text
 * table and the CSV formats (comma, tab, pipe, semicolon). Values arrive as text; the
 * column types say which are written as numbers, booleans or binary literals. Redis data
 * has no SQL: its grids offer Redis commands (`HSET`, `RPUSH`, `SADD`, `ZADD`, `XADD`)
 * in place of the SQL extractors.
 */
import type { DbDriver } from "@/platform/ipc";
import { isNumericColumn } from "./Grid";
import type { Cell } from "./model";
import { quoteIdent } from "./sql/complete";

export type ExportFormat =
  | "redis"
  | "sql"
  | "sqlMultirow"
  | "sqlUpdate"
  | "oneRow"
  | "json"
  | "markdown"
  | "html"
  | "xml"
  | "text"
  | "csv"
  | "tsv"
  | "pipe"
  | "semicolon";

export interface Extractor {
  id: ExportFormat;
  label: string;
  extension: string;
  /** IDEA's chooser sections: the built-in extractors, then the CSV formats. */
  group: "builtin" | "csv";
  /** Column header, row header and transpose apply. */
  tabular: boolean;
}

export const EXPORT_FORMATS: readonly Extractor[] = [
  { id: "redis", label: "Redis Commands", extension: "redis", group: "builtin", tabular: false },
  { id: "sql", label: "SQL Inserts", extension: "sql", group: "builtin", tabular: false },
  { id: "sqlMultirow", label: "SQL Insert Multirow", extension: "sql", group: "builtin", tabular: false },
  { id: "sqlUpdate", label: "SQL Updates", extension: "sql", group: "builtin", tabular: false },
  { id: "oneRow", label: "One Row", extension: "sql", group: "builtin", tabular: false },
  { id: "json", label: "JSON", extension: "json", group: "builtin", tabular: false },
  { id: "markdown", label: "Markdown", extension: "md", group: "builtin", tabular: true },
  { id: "html", label: "HTML Table", extension: "html", group: "builtin", tabular: true },
  { id: "xml", label: "XML", extension: "xml", group: "builtin", tabular: false },
  { id: "text", label: "Pretty Text", extension: "txt", group: "builtin", tabular: true },
  { id: "csv", label: "CSV", extension: "csv", group: "csv", tabular: true },
  { id: "tsv", label: "TSV", extension: "tsv", group: "csv", tabular: true },
  { id: "pipe", label: "Pipe-separated", extension: "txt", group: "csv", tabular: true },
  { id: "semicolon", label: "Semicolon-separated", extension: "csv", group: "csv", tabular: true },
];

export function extractorOf(id: string | null | undefined): Extractor {
  return EXPORT_FORMATS.find((f) => f.id === id) ?? EXPORT_FORMATS.find((f) => f.id === "csv")!;
}

const SQL_ONLY: ReadonlySet<ExportFormat> = new Set(["sql", "sqlMultirow", "sqlUpdate", "oneRow"]);

/** The extractors of a data source's data: Redis commands for Redis, neither for Elasticsearch, SQL for the others. */
export function formatsFor(driver: DbDriver | null | undefined): readonly Extractor[] {
  if (driver === "redis") return EXPORT_FORMATS.filter((f) => !SQL_ONLY.has(f.id));
  if (driver === "elasticsearch") return EXPORT_FORMATS.filter((f) => f.id !== "redis" && !SQL_ONLY.has(f.id));
  return EXPORT_FORMATS.filter((f) => f.id !== "redis");
}

/** The chosen extractor (one preference for every grid), or its counterpart where it doesn't apply. */
export function effectiveExtractor(id: ExportFormat, driver: DbDriver | null | undefined): ExportFormat {
  if (formatsFor(driver).some((f) => f.id === id)) return id;
  return driver === "redis" ? "redis" : driver === "elasticsearch" ? "json" : "sql";
}

/** The chooser's options, IDEA's sections first ("Built-in", "CSV"). */
export function extractorOptions(
  driver?: DbDriver | null,
): Array<{ value: string; label: string; section?: boolean; disabled?: boolean }> {
  const out: Array<{ value: string; label: string; section?: boolean; disabled?: boolean }> = [];
  const formats = formatsFor(driver);
  for (const [group, title] of [
    ["builtin", "Built-in"],
    ["csv", "CSV"],
  ] as const) {
    out.push({ value: `#${group}`, label: title, section: true, disabled: true });
    for (const f of formats.filter((x) => x.group === group)) out.push({ value: f.id, label: f.label });
  }
  return out;
}

export interface ExportColumn {
  name: string;
  type: string;
  primaryKey?: boolean;
}

export interface ExportData {
  columns: readonly ExportColumn[];
  rows: ReadonlyArray<readonly Cell[]>;
  /** Target of SQL statements (the query's table, else IDEA's `MY_TABLE`). */
  table: string;
  /** Schema qualifying `table`, when known (the table editor's). */
  schema?: string;
  driver: DbDriver;
  /** Redis: the value's type (`hash`, `list`, …); `table` is then the key. */
  redisKind?: string;
}

/** The Export Data dialog's options (the tabular formats). */
export interface ExportOptions {
  columnHeader: boolean;
  rowHeader: boolean;
  transpose: boolean;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = { columnHeader: true, rowHeader: false, transpose: false };

/** Header and rows of a tabular export after the row header / transpose options. */
function laidOut(d: ExportData, o: ExportOptions): { head: string[] | null; rows: Cell[][] } {
  let head = d.columns.map((c) => c.name);
  let rows = d.rows.map((r) => [...r]);
  if (o.rowHeader) {
    head = ["#", ...head];
    rows = rows.map((r, i) => [String(i + 1), ...r]);
  }
  if (!o.transpose) return { head: o.columnHeader ? head : null, rows };
  return { head: null, rows: head.map((h, c) => [...(o.columnHeader ? [h] : []), ...rows.map((r) => r[c] ?? null)]) };
}

// ---- SQL literals -------------------------------------------------------------

const BOOLEAN_TYPE = /^bool/i;
const BINARY_TYPE = /bytea|blob|binary|image/i;
const HEX = /^0x([0-9a-f]*)$/i;

type ColumnKind = "number" | "boolean" | "binary" | "text";

function columnKinds(d: ExportData): ColumnKind[] {
  return d.columns.map((c, i) => {
    const sample = d.rows.slice(0, 50).map((r) => r[i] ?? null);
    if (BOOLEAN_TYPE.test(c.type)) return "boolean";
    if (BINARY_TYPE.test(c.type)) return "binary";
    return isNumericColumn(c.type, sample) ? "number" : "text";
  });
}

/** A string literal of `driver`: `''` doubled; MySQL also escapes backslashes, SQL Server marks Unicode. */
export function stringLiteral(v: string, driver: DbDriver): string {
  let s = v.replace(/'/g, "''");
  if (driver === "mysql") s = s.replace(/\\/g, "\\\\");
  // eslint-disable-next-line no-control-regex
  const unicode = driver === "sqlServer" && /[^\x00-\x7f]/.test(v);
  return `${unicode ? "N" : ""}'${s}'`;
}

export function sqlLiteral(v: Cell, kind: ColumnKind, driver: DbDriver): string {
  if (v === null) return "NULL";
  switch (kind) {
    case "number":
      return Number.isFinite(Number(v)) && v.trim() !== "" ? v : stringLiteral(v, driver);
    case "boolean": {
      const b = /^(t|true|1|y|yes)$/i.test(v) ? true : /^(f|false|0|n|no)$/i.test(v) ? false : null;
      if (b === null) return stringLiteral(v, driver);
      return driver === "sqlServer" || driver === "sqlite" ? (b ? "1" : "0") : b ? "TRUE" : "FALSE";
    }
    case "binary": {
      const hex = HEX.exec(v)?.[1];
      if (hex === undefined) return stringLiteral(v, driver);
      if (driver === "postgres") return `'\\x${hex.toLowerCase()}'::bytea`;
      if (driver === "sqlite") return `X'${hex}'`;
      return `0x${hex}`;
    }
    case "text":
      return stringLiteral(v, driver);
  }
}

function qualifiedTable(d: ExportData): string {
  const table = quoteIdent(d.table, d.driver);
  return d.schema ? `${quoteIdent(d.schema, d.driver)}.${table}` : table;
}

/** `name = value`, or `name IS NULL` (SQL Updates' WHERE). */
function equals(name: string, literal: string): string {
  return literal === "NULL" ? `${name} IS NULL` : `${name} = ${literal}`;
}

// ---- text helpers ---------------------------------------------------------------

function delimited(sep: string, quoteAlways: boolean) {
  return (head: string[] | null, rows: Cell[][]): string => {
    const field = (v: Cell) => {
      const s = v ?? "";
      return quoteAlways || s.includes(sep) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = rows.map((r) => r.map(field).join(sep));
    if (head) lines.unshift(head.map(field).join(sep));
    return lines.join("\n");
  };
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A valid XML element name for a column (`order id` → `order_id`, `1st` → `_1st`). */
function xmlName(name: string): string {
  const s = name.replace(/[^\p{L}\p{N}_.-]/gu, "_");
  return /^[\p{L}_]/u.test(s) && !/^xml/i.test(s) ? s : `_${s}`;
}

/** Display width of a cell in a monospace table (wide CJK characters count twice). */
function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}

function prettyTable(head: string[] | null, rows: Cell[][], numeric: boolean[], rowHeader: boolean): string {
  const cells = (r: Cell[]) => r.map((v) => (v === null ? "<null>" : v.replace(/\r?\n/g, "⏎")));
  const all = [...(head ? [head] : []), ...rows.map(cells)];
  const width = all[0]?.length ?? 0;
  const widths = Array.from({ length: width }, (_, c) => Math.max(1, ...all.map((r) => textWidth(r[c] ?? ""))));
  const right = (c: number) => (rowHeader ? (c === 0 ? true : !!numeric[c - 1]) : !!numeric[c]);
  const line = `+${widths.map((w) => "-".repeat(w + 2)).join("+")}+`;
  const fmt = (r: string[], header: boolean) =>
    `|${r
      .map((v, c) => {
        const pad = " ".repeat(widths[c]! - textWidth(v));
        return ` ${!header && right(c) ? pad + v : v + pad} `;
      })
      .join("|")}|`;
  const out = [line];
  if (head) out.push(fmt(head, true), line);
  for (const r of rows) out.push(fmt(cells(r), false));
  if (rows.length) out.push(line);
  return out.join("\n");
}

// ---- extraction --------------------------------------------------------------------

export function exportData(
  format: ExportFormat,
  d: ExportData,
  options: ExportOptions = DEFAULT_EXPORT_OPTIONS,
): string {
  const names = d.columns.map((c) => c.name);
  const kinds = columnKinds(d);
  const literal = (v: Cell, i: number) => sqlLiteral(v, kinds[i]!, d.driver);
  const idents = names.map((n) => quoteIdent(n, d.driver));
  switch (format) {
    case "redis":
      return redisCommands(d);
    case "sql": {
      const head = `INSERT INTO ${qualifiedTable(d)} (${idents.join(", ")}) VALUES`;
      return d.rows.map((r) => `${head} (${r.map(literal).join(", ")});`).join("\n");
    }
    case "sqlMultirow": {
      if (!d.rows.length) return "";
      const values = d.rows.map((r) => `       (${r.map(literal).join(", ")})`).join(",\n");
      return `INSERT INTO ${qualifiedTable(d)} (${idents.join(", ")})\nVALUES ${values.trimStart()};`;
    }
    case "sqlUpdate": {
      // Rows are found by the primary key when the columns hold it, else by every value.
      const keys = d.columns.map((c, i) => (c.primaryKey ? i : -1)).filter((i) => i >= 0);
      const where = keys.length ? keys : names.map((_, i) => i);
      const set = names.map((_, i) => i).filter((i) => !keys.includes(i));
      return d.rows
        .map((r) => {
          const assignments = (set.length ? set : where).map((i) => `${idents[i]} = ${literal(r[i] ?? null, i)}`);
          const condition = where.map((i) => equals(idents[i]!, literal(r[i] ?? null, i))).join(" AND ");
          return `UPDATE ${qualifiedTable(d)} SET ${assignments.join(", ")} WHERE ${condition};`;
        })
        .join("\n");
    }
    case "oneRow":
      return d.rows.flatMap((r) => r.map(literal)).join(", ");
    case "json": {
      const value = (v: Cell, i: number) => {
        if (v === null) return null;
        if (kinds[i] === "number" && Number.isFinite(Number(v))) return Number(v);
        if (kinds[i] === "boolean" && /^(t|true|f|false)$/i.test(v)) return /^t/i.test(v);
        return v;
      };
      return JSON.stringify(
        d.rows.map((r) => Object.fromEntries(names.map((n, i) => [n, value(r[i] ?? null, i)]))),
        null,
        2,
      );
    }
    case "markdown": {
      const cell = (v: Cell) => (v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
      const t = laidOut(d, options);
      const width = t.head?.length ?? t.rows[0]?.length ?? 0;
      // A Markdown table always has a header row: blank when left out.
      const head = t.head ?? Array.from({ length: width }, () => "");
      const align =
        options.transpose || t.head === null
          ? head.map(() => "---")
          : [...(options.rowHeader ? ["--:"] : []), ...kinds.map((k) => (k === "number" ? "--:" : "---"))];
      return [head.map(cell), align, ...t.rows.map((r) => r.map(cell))].map((r) => `| ${r.join(" | ")} |`).join("\n");
    }
    case "html": {
      const t = laidOut(d, options);
      const td = (v: Cell, tag: "td" | "th") =>
        v === null ? `<${tag}><i>NULL</i></${tag}>` : `<${tag}>${escapeHtml(v).replace(/\r?\n/g, "<br>")}</${tag}>`;
      const lines = ['<table border="1" style="border-collapse:collapse">'];
      if (t.head) lines.push(`  <tr>${t.head.map((h) => td(h, "th")).join("")}</tr>`);
      for (const r of t.rows)
        lines.push(`  <tr>${r.map((v, c) => td(v, options.transpose && c === 0 ? "th" : "td")).join("")}</tr>`);
      lines.push("</table>");
      return lines.join("\n");
    }
    case "xml": {
      const tags = names.map(xmlName);
      const rows = d.rows.map((r) =>
        [
          "  <row>",
          ...r.map((v, i) => (v === null ? `    <${tags[i]}/>` : `    <${tags[i]}>${escapeHtml(v)}</${tags[i]}>`)),
          "  </row>",
        ].join("\n"),
      );
      return ['<?xml version="1.0" encoding="UTF-8"?>', "<data>", ...rows, "</data>"].join("\n");
    }
    case "text": {
      const t = laidOut(d, options);
      return prettyTable(
        t.head,
        t.rows,
        kinds.map((k) => k === "number"),
        options.rowHeader && !options.transpose,
      );
    }
    case "csv":
    case "tsv":
    case "pipe":
    case "semicolon": {
      const t = laidOut(d, options);
      const sep = { csv: ",", tsv: "\t", pipe: "|", semicolon: ";" }[format];
      return delimited(sep, false)(t.head, t.rows);
    }
  }
}

/** A word as `redis-cli` reads it: bare when plain, else double-quoted with escapes. */
export function redisArg(v: string): string {
  if (v && !/[\s"'\\]/.test(v)) return v;
  const escaped = v.replace(
    /[\\"\n\r\t]/g,
    (c) => ({ "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t" })[c]!,
  );
  return `"${escaped}"`;
}

/**
 * Commands writing rows back into the key `table` (by its `redisKind`): a hash's fields
 * with `HSET`, a list's values with `RPUSH`, members with `SADD` / `ZADD`, stream entries
 * with `XADD`; anything else as one command line per row.
 */
function redisCommands(d: ExportData): string {
  const at = (name: string) => d.columns.findIndex((c) => c.name === name);
  const key = redisArg(d.table);
  const word = (v: Cell) => redisArg(v ?? "");
  const line = (words: string[]) => words.join(" ");
  const [field, value, member, score, id] = ["field", "value", "member", "score", "id"].map(at) as number[];
  const has = (...cols: number[]) => cols.every((c) => c >= 0);
  const rows = d.rows;
  switch (d.redisKind) {
    case "hash":
      if (has(field!, value!))
        return rows.map((r) => line(["HSET", key, word(r[field!]!), word(r[value!]!)])).join("\n");
      break;
    case "list":
      if (has(value!)) return rows.map((r) => line(["RPUSH", key, word(r[value!]!)])).join("\n");
      break;
    case "set":
      if (has(member!)) return rows.map((r) => line(["SADD", key, word(r[member!]!)])).join("\n");
      break;
    case "zset":
      if (has(member!, score!))
        return rows.map((r) => line(["ZADD", key, word(r[score!]!), word(r[member!]!)])).join("\n");
      break;
    case "stream":
      if (has(id!))
        return rows
          .map((r) =>
            line([
              "XADD",
              key,
              word(r[id!]!),
              ...d.columns.flatMap((c, i) => (i === id || r[i] === null ? [] : [redisArg(c.name), word(r[i]!)])),
            ]),
          )
          .join("\n");
      break;
  }
  return rows.map((r) => r.map(word).join(" ")).join("\n");
}

/** The rows × columns of a selection as extractor input (IDEA extracts only the selected columns). */
export function selectionData(
  d: Omit<ExportData, "rows" | "columns">,
  columns: readonly ExportColumn[],
  rows: readonly number[],
  cols: readonly number[],
  value: (row: number, col: number) => Cell,
): ExportData {
  return {
    ...d,
    columns: cols.map((c) => columns[c]!),
    rows: rows.map((r) => cols.map((c) => value(r, c))),
  };
}
