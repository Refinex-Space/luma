/**
 * GFM tables as their source lines: each line split into raw cell segments between unescaped
 * pipes (pipes inside code spans don't count). Edits rewrite only what they change: a cell
 * edit replaces that cell's text, a row operation touches that row's line, a column operation
 * one segment per line, so untouched cells keep their spacing and the file its bytes.
 */

export type Align = "left" | "center" | "right" | null;

export interface TableLine {
  /** Offsets in the document. */
  from: number;
  to: number;
  indent: string;
  leading: boolean;
  trailing: boolean;
  /** Whatever follows the trailing pipe (spaces). */
  rest: string;
  /** Raw text between pipes. */
  segs: string[];
  /** Document offset of each segment's start. */
  starts: number[];
}

export interface TableModel {
  from: number;
  to: number;
  header: TableLine;
  delimiter: TableLine;
  rows: TableLine[];
  aligns: Align[];
  columns: number;
}

/** Pipe positions of `text` that separate cells. */
function pipes(text: string): number[] {
  const out: number[] = [];
  let tick = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "`") {
      let n = 1;
      while (text[i + n] === "`") n++;
      if (tick === 0) {
        // Only an opening run with a matching close counts as a code span.
        if (text.indexOf("`".repeat(n), i + n) >= 0) tick = n;
      } else if (n === tick) tick = 0;
      i += n - 1;
      continue;
    }
    if (c === "|" && tick === 0) out.push(i);
  }
  return out;
}

export function parseLine(text: string, from: number): TableLine {
  const indent = /^\s*/.exec(text)![0];
  const body = text.slice(indent.length);
  const trimmed = body.trimEnd();
  const rest = body.slice(trimmed.length);
  const ps = pipes(trimmed);
  const leading = ps[0] === 0;
  const trailing = ps.length > 0 && ps[ps.length - 1] === trimmed.length - 1 && !(leading && ps.length === 1);
  const cuts = [leading ? 0 : -1, ...ps.filter((p) => p !== 0 && !(trailing && p === trimmed.length - 1))];
  const end = trailing ? trimmed.length - 1 : trimmed.length;
  const segs: string[] = [];
  const starts: number[] = [];
  for (let i = 0; i < cuts.length; i++) {
    const a = cuts[i]! + 1;
    const b = i + 1 < cuts.length ? cuts[i + 1]! : end;
    segs.push(trimmed.slice(a, b));
    starts.push(from + indent.length + a);
  }
  return { from, to: from + text.length, indent, leading, trailing, rest, segs, starts };
}

const alignOf = (seg: string): Align => {
  const s = seg.trim();
  const l = s.startsWith(":");
  const r = s.endsWith(":") && s.length > 1;
  return l && r ? "center" : r ? "right" : l ? "left" : null;
};

export const isDelimiterRow = (line: TableLine) =>
  line.segs.length > 0 && line.segs.every((s) => /^\s*:?-+:?\s*$/.test(s));

/** The table whose source is `text` starting at document offset `from`, or null. */
export function parseTable(text: string, from: number): TableModel | null {
  const lines: TableLine[] = [];
  let at = from;
  for (const l of text.split("\n")) {
    lines.push(parseLine(l, at));
    at += l.length + 1;
  }
  if (lines.length < 2 || !isDelimiterRow(lines[1]!)) return null;
  const header = lines[0]!;
  const delimiter = lines[1]!;
  return {
    from,
    to: from + text.length,
    header,
    delimiter,
    rows: lines.slice(2).filter((l) => l.segs.length > 0 || l.to > l.from),
    aligns: header.segs.map((_, i) => alignOf(delimiter.segs[i] ?? "")),
    columns: header.segs.length,
  };
}

/** The table's lines top to bottom (header, delimiter, rows). */
export const tableLines = (t: TableModel) => [t.header, t.delimiter, ...t.rows];

/** A cell's text as shown: trimmed, `\|` unescaped. */
export const cellText = (seg: string | undefined) => (seg ?? "").trim().replace(/\\\|/g, "|");

/** Text typed into a cell as Markdown source: one line, pipes escaped. */
export const cellSource = (text: string) => text.replace(/\r?\n/g, "<br>").replace(/\|/g, "\\|");

export function serializeLine(l: Pick<TableLine, "indent" | "leading" | "trailing" | "rest" | "segs">): string {
  return `${l.indent}${l.leading ? "|" : ""}${l.segs.join("|")}${l.trailing ? "|" : ""}${l.rest}`;
}

export interface Change {
  from: number;
  to: number;
  insert: string;
}

/** Row index in table terms: 0 is the header, 1… the body rows. */
const lineOfRow = (t: TableModel, row: number) => (row === 0 ? t.header : t.rows[row - 1]);

/** Whether the table writes cells as `| a |` (spaced) rather than `|a|`. */
const spaced = (t: TableModel) => t.header.segs.some((s) => s.startsWith(" "));
const newCell = (t: TableModel, text = "") => (spaced(t) ? ` ${text} ` : text || " ");
const newDelimiter = (t: TableModel, align: Align = null) => {
  const dashes = `${align === "left" || align === "center" ? ":" : ""}---${align === "right" || align === "center" ? ":" : ""}`;
  return t.delimiter.segs.some((s) => s.startsWith(" ")) ? ` ${dashes} ` : dashes;
};

/** A line with exactly `n` segments (missing ones added empty). */
function padded(t: TableModel, l: TableLine, n: number): string[] {
  const segs = [...l.segs];
  while (segs.length < n) segs.push(newCell(t));
  return segs;
}

/** Replaces the text of cell (`row`, `col`). */
export function setCell(t: TableModel, row: number, col: number, text: string): Change | null {
  const line = lineOfRow(t, row);
  if (!line || col >= t.columns) return null;
  const src = cellSource(text);
  const seg = line.segs[col];
  if (seg === undefined) {
    const segs = padded(t, line, col + 1);
    segs[col] = newCell(t, src);
    return { from: line.from, to: line.to, insert: serializeLine({ ...line, segs }) };
  }
  const start = line.starts[col]!;
  const lead = seg.length - seg.trimStart().length;
  const content = seg.trim();
  if (!content) {
    // An empty cell: write it with the table's spacing.
    return { from: start, to: start + seg.length, insert: newCell(t, src) };
  }
  return { from: start + lead, to: start + lead + content.length, insert: src };
}

/** Inserts an empty body row at body index `at` (0 = first body row). */
export function insertRow(t: TableModel, at: number): Change {
  const like = t.rows[0] ?? t.header;
  const text = serializeLine({
    indent: t.header.indent,
    leading: like.leading,
    trailing: like.trailing,
    rest: "",
    segs: Array.from({ length: t.columns }, () => newCell(t)),
  });
  const after = at === 0 ? t.delimiter : t.rows[Math.min(at, t.rows.length) - 1]!;
  return { from: after.to, to: after.to, insert: `\n${text}` };
}

export function deleteRow(t: TableModel, row: number): Change | null {
  const line = t.rows[row - 1];
  if (!line) return null;
  return { from: line.from - 1, to: line.to, insert: "" };
}

/** Swaps body rows `row` and `row + dir` (header excluded). */
export function moveRow(t: TableModel, row: number, dir: -1 | 1): Change | null {
  const a = t.rows[row - 1];
  const b = t.rows[row - 1 + dir];
  if (!a || !b) return null;
  const [top, bottom] = dir < 0 ? [b, a] : [a, b];
  const text = (l: TableLine) => serializeLine(l);
  return { from: top.from, to: bottom.to, insert: `${text(bottom)}\n${text(top)}` };
}

function eachLine(t: TableModel, f: (l: TableLine, segs: string[], isDelimiter: boolean) => string[]): Change[] {
  return tableLines(t).map((l, i) => {
    const segs = f(l, padded(t, l, t.columns), i === 1);
    return { from: l.from, to: l.to, insert: serializeLine({ ...l, segs }) };
  });
}

export function insertColumn(t: TableModel, at: number): Change[] {
  return eachLine(t, (_l, segs, delim) => {
    segs.splice(at, 0, delim ? newDelimiter(t) : newCell(t));
    return segs;
  });
}

export function deleteColumn(t: TableModel, col: number): Change[] | null {
  if (t.columns <= 1) return null;
  return eachLine(t, (_l, segs) => {
    segs.splice(col, 1);
    return segs;
  });
}

export function moveColumn(t: TableModel, col: number, dir: -1 | 1): Change[] | null {
  const other = col + dir;
  if (other < 0 || other >= t.columns) return null;
  return eachLine(t, (_l, segs) => {
    [segs[col], segs[other]] = [segs[other]!, segs[col]!];
    return segs;
  });
}

export function alignColumn(t: TableModel, col: number, align: Align): Change | null {
  const seg = t.delimiter.segs[col];
  if (seg === undefined) return null;
  const start = t.delimiter.starts[col]!;
  const dashes = Math.max(3, seg.replace(/[^-]/g, "").length);
  const body = `${align === "left" || align === "center" ? ":" : ""}${"-".repeat(dashes)}${align === "right" || align === "center" ? ":" : ""}`;
  const lead = seg.length - seg.trimStart().length;
  const trail = seg.length - seg.trimEnd().length;
  return {
    from: start,
    to: start + seg.length,
    insert: `${seg.slice(0, lead)}${body}${seg.slice(seg.length - trail)}`,
  };
}

/** A new table's source: `cols` × `rows` (body rows), header cells named. */
export function newTable(cols: number, rows: number, name: (i: number) => string): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [
    line(Array.from({ length: cols }, (_, i) => name(i))),
    line(Array.from({ length: cols }, () => "---")),
    ...Array.from({ length: rows }, () => line(Array.from({ length: cols }, () => " "))),
  ].join("\n");
}
