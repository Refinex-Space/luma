/**
 * Reformat Code for SQL, laid out like IDEA's default SQL code style: clauses
 * on their own lines, select / set / values items one per line aligned after
 * their keyword (or, `indented`, on lines of their own under it), joins under
 * the first table, AND / OR of WHERE right-aligned, column aliases aligned,
 * subqueries aligned after their parenthesis, CREATE TABLE bodies one
 * definition per line. Keywords, built-in types and functions take the style's
 * case; identifiers and comments are kept. Each statement is replaced on its
 * own, so text between statements is left alone.
 */
import type { DbDriver } from "@/platform/ipc";
import { isReserved } from "./dialect";
import { cased, isTypeWord, isVocabularyWord, vocabulary, type KeywordCase } from "./keywords";
import { lex, type Token } from "./lexer";

/** Editor › Code Style › SQL. */
export interface SqlStyle {
  keywordCase: KeywordCase;
  /** `aligned`: items after their keyword (`SELECT a,` / `       b`); `indented`: under it, one per line. */
  layout: "aligned" | "indented";
  /** Align the `AS` of select items in a column. */
  alignAliases: boolean;
  /** Indent of table bodies and, `indented`, of clause items. */
  indent: number;
}

/** What Luma formats SQL as when nothing is set: IDEA's layout, upper-case keywords. */
export const DEFAULT_SQL_STYLE: SqlStyle = { keywordCase: "upper", layout: "aligned", alignAliases: true, indent: 4 };

export interface SqlEdit {
  from: number;
  to: number;
  insert: string;
}

interface Item {
  kind: Token["kind"] | "comment";
  text: string;
  upper: string;
  from: number;
  to: number;
}

/** Edits formatting every statement (or those overlapping `range`). */
export function formatSql(
  text: string,
  driver: DbDriver,
  range: { from: number; to: number } | null = null,
  style: SqlStyle = DEFAULT_SQL_STYLE,
): SqlEdit[] {
  const lexed = lex(text, driver);
  const items: Item[] = [
    ...lexed.tokens,
    ...lexed.comments.map((c) => ({
      kind: "comment" as const,
      text: text.slice(c.from, c.to),
      upper: "",
      from: c.from,
      to: c.to,
    })),
  ].sort((a, b) => a.from - b.from);

  const edits: SqlEdit[] = [];
  let start = 0;
  let depth = 0;
  const flush = (end: number) => {
    // Comments before a statement stay where they are.
    let a = start;
    while (a < end && items[a]!.kind === "comment") a++;
    if (a >= end) return;
    const first = items[a]!;
    const last = items[end - 1]!;
    if (range && (last.to < range.from || first.from > range.to)) return;
    const line = text.lastIndexOf("\n", first.from - 1) + 1;
    const lead = text.slice(line, first.from);
    const indent = /^[ \t]*$/.test(lead) ? lead : "";
    edits.push({ from: first.from, to: last.to, insert: formatStatement(items.slice(a, end), indent, driver, style) });
  };
  items.forEach((it, i) => {
    if (it.kind === "punct" && it.text === "(") depth++;
    else if (it.kind === "punct" && it.text === ")") depth = Math.max(0, depth - 1);
    else if (it.kind === "punct" && it.text === ";" && depth === 0) {
      flush(i + 1);
      start = i + 1;
    }
  });
  flush(items.length);
  return edits;
}

const NEWLINE_CLAUSES = new Set([
  "SELECT",
  "FROM",
  "WHERE",
  "GROUP",
  "HAVING",
  "ORDER",
  "LIMIT",
  "OFFSET",
  "WINDOW",
  "RETURNING",
  "VALUES",
  "SET",
  "UNION",
  "INTERSECT",
  "EXCEPT",
]);
const JOIN_START = new Set(["JOIN", "LEFT", "RIGHT", "FULL", "INNER", "CROSS", "NATURAL", "STRAIGHT_JOIN"]);
const JOIN_MODIFIERS = new Set(["LEFT", "RIGHT", "FULL", "INNER", "CROSS", "NATURAL", "OUTER"]);
/** Where a list item continues: the width of `select `, `from `, `set `, `values `. */
const ITEM_COLUMN: Record<string, number> = { SELECT: 7, FROM: 5, SET: 4, VALUES: 7 };
/** Clauses whose items go on lines of their own under them in the `indented` layout. */
const LIST_CLAUSES = new Set(["SELECT", "FROM", "WHERE", "GROUP", "HAVING", "ORDER", "SET", "VALUES", "RETURNING"]);
/** Words that complete a clause keyword on its line: `GROUP BY`, `SELECT DISTINCT`. */
const CLAUSE_TAIL = new Set(["BY", "DISTINCT", "ALL"]);
/** Keywords written like functions: `cast(x as int)`. */
const CALL_KEYWORDS = new Set(["CAST"]);

interface Frame {
  kind: "query" | "create" | "plain";
  /** Column where the block's clauses start. */
  indent: number;
  clause: string;
  /** Tokens written in this frame so far. */
  count: number;
  /** A BETWEEN waits for its AND. */
  between: boolean;
  /** `indented`: the clause keyword was written, its items start on the next line. */
  breakPending?: boolean;
  /** `indented` subquery: its `)` goes on a line of its own at this column. */
  closeAt?: number;
}

/** A column definition of a table body, for aligning names, types and constraints. */
interface Definition {
  line: number;
  /** End of the column name, and of its type (when constraints follow on the line). */
  name: number;
  type?: number;
}

function formatStatement(items: Item[], base: string, driver: DbDriver, style: SqlStyle): string {
  const indented = style.layout === "indented";
  const unit = style.indent;
  const words = items.filter((t) => t.kind !== "comment");
  const vocab = vocabulary(words, driver);
  const recase = new Set(words.filter((_, i) => vocab.has(i)));
  const textOf = (t: Item) => (recase.has(t) ? cased(t.text, style.keywordCase) : t.text);
  /** Column of a clause's continued items, from the clause's start. */
  const itemColumn = (clause: string) => (indented ? unit : ITEM_COLUMN[clause]!);
  const hasItems = (clause: string) => clause in ITEM_COLUMN || (indented && LIST_CLAUSES.has(clause));
  // `AS` of select items, per select list: line and column, aligned at the end.
  const aliases = new Map<Frame, Array<{ line: number; col: number }>>();
  const definitions: Definition[] = [];
  let definition: Definition | null = null;
  let defTokens = 0;
  let inType = false;
  const lines: string[] = [];
  let line = "";
  const newline = (column: number) => {
    lines.push(line.trimEnd());
    line = " ".repeat(column);
  };
  const atLineStart = () => line.trim() === "";
  const create = isCreateTable(items);
  const frames: Frame[] = [{ kind: "query", indent: 0, clause: "", count: 0, between: false }];
  let prev: Item | null = null;
  let unary = false;

  items.forEach((it, i) => {
    const frame = frames.at(-1)!;
    const word = it.kind === "word" ? it.upper : "";
    const isQuery = frame.kind === "query";

    // Line breaks before the token.
    const afterLineComment = prev?.kind === "comment" && /^(--|#)/.test(prev.text);
    if (frame.breakPending && it.kind !== "comment") {
      // `indented`: the clause's items start under it, once its keyword is complete.
      if (!(word && CLAUSE_TAIL.has(word) && !afterLineComment)) {
        frame.breakPending = false;
        if (!(isQuery && word && NEWLINE_CLAUSES.has(word))) newline(frame.indent + unit);
      }
    }
    if (afterLineComment) {
      newline(isQuery && hasItems(frame.clause) ? frame.indent + itemColumn(frame.clause) : frame.indent);
    } else if (it.kind === "punct" && it.text === ")" && frame.kind === "create") {
      newline(frames.at(-2)!.indent);
    } else if (it.kind === "punct" && it.text === ")" && frame.closeAt !== undefined) {
      newline(frame.closeAt);
    } else if (isQuery && word && frame.count > 0) {
      if (NEWLINE_CLAUSES.has(word)) {
        if (!atLineStart()) newline(frame.indent);
      } else if (word === "ON" && frame.clause === "VALUES") {
        newline(frame.indent);
      } else if (JOIN_START.has(word) && !JOIN_MODIFIERS.has(prev?.upper ?? "") && frame.clause === "FROM") {
        // Under the first table: `FROM orders o` / `     JOIN …`.
        if (!atLineStart()) newline(frame.indent + itemColumn("FROM"));
      } else if ((word === "AND" || word === "OR") && (frame.clause === "WHERE" || frame.clause === "HAVING")) {
        if (word === "AND" && frame.between) frame.between = false;
        else if (!atLineStart()) newline(frame.indent + (indented ? unit : word === "AND" ? 2 : 3));
      } else if ((word === "INSERT" || word === "UPDATE" || word === "DELETE") && isP(prev, ")")) {
        // The statement after `with x as (…)`.
        newline(frame.indent);
      }
    }

    // The token itself; a comma after a line comment moves before it (`a, -- why`).
    if (afterLineComment && isP(it, ",")) {
      const last = lines.at(-1)!;
      const at = last.lastIndexOf(prev!.text);
      lines[lines.length - 1] = `${last.slice(0, at).trimEnd()}, ${last.slice(at)}`;
    } else {
      if (
        style.alignAliases &&
        isQuery &&
        word === "AS" &&
        frame.clause === "SELECT" &&
        !atLineStart() &&
        !frame.breakPending
      ) {
        const list = aliases.get(frame) ?? [];
        list.push({ line: lines.length, col: line.trimEnd().length });
        aliases.set(frame, list);
      }
      if (
        isQuery &&
        frame.clause === "SELECT" &&
        frame.count > 0 &&
        !frame.breakPending &&
        isImplicitAlias(it, prev, items[i + 1], recase)
      ) {
        // `sum(x) total` → `sum(x) AS total`, aligned with the others.
        if (style.alignAliases) {
          const list = aliases.get(frame) ?? [];
          list.push({ line: lines.length, col: line.trimEnd().length });
          aliases.set(frame, list);
        }
        line += ` ${cased("AS", style.keywordCase)}`;
      }
      // Table bodies: where each definition's name and type end (aligned below).
      if (frame.kind === "create" && it.kind !== "comment") {
        // `TIMESTAMP WITH TIME ZONE`: WITH / WITHOUT before TIME are part of the type.
        const typeWord =
          recase.has(it) &&
          (isTypeWord(it.upper) || ((it.upper === "WITH" || it.upper === "WITHOUT") && items[i + 1]?.upper === "TIME"));
        if (definition && inType && !typeWord && !(isP(it, "(") && defTokens > 1)) {
          inType = false;
          if (!isP(it, ",")) definition.type = line.trimEnd().length;
        }
        if (defTokens === 1 && definition) inType = recase.has(it) && isTypeWord(it.upper);
      }
      if (!atLineStart() && spaceBefore(prev, it, items[i - 2], unary, recase)) line += " ";
      line += textOf(it);
      if (frame.kind === "create" && it.kind !== "comment") {
        if (defTokens === 0 && !recase.has(it) && (it.kind === "word" || it.kind === "quoted"))
          definition = { line: lines.length, name: line.length };
        if (!isP(it, ",")) defTokens++;
      }
    }
    unary = it.kind === "punct" && (it.text === "-" || it.text === "+") && (!prev || isOperatorLike(prev));

    // Bookkeeping and breaks after the token.
    frame.count++;
    if (isQuery && word) {
      if (NEWLINE_CLAUSES.has(word)) {
        frame.clause = word;
        if (indented && LIST_CLAUSES.has(word)) frame.breakPending = true;
      } else if (word === "ON" && frame.clause === "VALUES") frame.clause = "CONFLICT";
      if (word === "BETWEEN") frame.between = true;
    }
    if (it.kind === "punct" && it.text === "(") {
      const next = items[i + 1];
      if (create && frames.length === 1 && isCreateBodyParen(items, i)) {
        // `create table t\n(\n    a int,\n    …\n)`.
        line = line.slice(0, -1).trimEnd();
        newline(frame.indent);
        line += "(";
        frames.push({ kind: "create", indent: frame.indent + unit, clause: "", count: 0, between: false });
        newline(frame.indent + unit);
      } else if (next?.kind === "word" && (next.upper === "SELECT" || next.upper === "WITH")) {
        if (indented) {
          // `(` / `    SELECT …` / `)`, one indent deeper than the line it opens on.
          const at = line.length - line.trimStart().length;
          frames.push({ kind: "query", indent: at + unit, clause: "", count: 0, between: false, closeAt: at });
          newline(at + unit);
        } else frames.push({ kind: "query", indent: line.length, clause: "", count: 0, between: false });
      } else {
        frames.push({ kind: "plain", indent: frame.indent, clause: "", count: 0, between: false });
      }
    } else if (it.kind === "punct" && it.text === ")" && frames.length > 1) {
      if (frames.at(-1)!.kind === "create" && definition) {
        definitions.push(definition);
        definition = null;
      }
      frames.pop();
    } else if (it.kind === "punct" && it.text === ",") {
      if (frame.kind === "create") {
        if (definition) definitions.push(definition);
        definition = null;
        defTokens = 0;
        inType = false;
      }
      if (atLineStart()) {
        // Already broken after a line comment.
      } else if (frame.kind === "create") newline(frame.indent);
      else if (isQuery && hasItems(frame.clause)) newline(frame.indent + itemColumn(frame.clause));
    }
    prev = it;
  });
  lines.push(line.trimEnd());
  // Table bodies: names, then types, in columns (IDEA's aligned definitions).
  const defs = definitions.filter((d) => lines[d.line] !== undefined);
  if (defs.length > 1 && new Set(defs.map((d) => d.line)).size === defs.length) {
    const nameTo = Math.max(...defs.map((d) => d.name));
    for (const d of defs) {
      const l = lines[d.line]!;
      const pad = nameTo - d.name;
      lines[d.line] = l.slice(0, d.name) + " ".repeat(pad) + l.slice(d.name);
      if (d.type !== undefined) d.type += pad;
    }
    const typed = defs.filter((d) => d.type !== undefined && d.type < lines[d.line]!.length);
    if (typed.length > 1) {
      const typeTo = Math.max(...typed.map((d) => d.type!));
      for (const d of typed) {
        const l = lines[d.line]!;
        lines[d.line] = l.slice(0, d.type!) + " ".repeat(typeTo - d.type!) + l.slice(d.type!);
      }
    }
  }
  // Aligned aliases: every `AS` of a select list in one column (when they are not too far apart).
  for (const list of aliases.values()) {
    const rows = new Set(list.map((a) => a.line));
    if (list.length < 2 || rows.size !== list.length) continue;
    const to = Math.max(...list.map((a) => a.col));
    if (to - Math.min(...list.map((a) => a.col)) > 48) continue;
    for (const a of list) {
      const l = lines[a.line]!;
      lines[a.line] = l.slice(0, a.col) + " ".repeat(to - a.col) + l.slice(a.col);
    }
  }
  return lines.map((l, i) => (i === 0 ? l.trimStart() : l ? base + l : l)).join("\n");
}

const isP = (t: Item | null | undefined, p: string) => !!t && t.kind === "punct" && t.text === p;

/**
 * A select item's alias written without AS (`sum(x) total`): an identifier right after
 * the end of an expression, ending the item.
 */
function isImplicitAlias(it: Item, prev: Item | null, next: Item | undefined, vocab: ReadonlySet<Item>): boolean {
  if (!prev || (it.kind !== "word" && it.kind !== "quoted") || vocab.has(it)) return false;
  if (it.kind === "word" && isReserved(it.text)) return false;
  const endsExpression =
    isP(prev, ")") ||
    prev.kind === "string" ||
    prev.kind === "number" ||
    prev.kind === "quoted" ||
    (prev.kind === "word" && (!vocab.has(prev) || prev.upper === "END" || prev.upper === "NULL"));
  const endsItem = !next || isP(next, ",") || isP(next, ";") || (next.kind === "word" && next.upper === "FROM");
  return endsExpression && endsItem && prev.kind !== "comment";
}

function isOperatorLike(t: Item): boolean {
  if (t.kind === "punct") return t.text !== ")";
  return t.kind === "word" && isReserved(t.text);
}

/** Keywords written with a space before their `(` though no reserved word: `PRIMARY KEY (id)`, `OVER (…)`. */
const SPACED_PAREN = new Set(["KEY", "OVER", "FILTER", "WITHIN"]);

function spaceBefore(
  prev: Item | null,
  it: Item,
  beforePrev: Item | undefined,
  unary: boolean,
  vocab: ReadonlySet<Item>,
): boolean {
  if (!prev) return false;
  if (unary) return false;
  if (it.kind === "comment" || prev.kind === "comment") return true;
  if (it.kind === "punct" && [",", ";", ")", ".", "::"].includes(it.text)) return false;
  if (prev.kind === "punct" && ["(", ".", "::"].includes(prev.text)) return false;
  if (it.kind === "punct" && it.text === "(") {
    if (prev.kind === "word" && CALL_KEYWORDS.has(prev.upper)) return false;
    if (prev.kind === "word" && vocab.has(prev) && SPACED_PAREN.has(prev.upper)) return true;
    if (prev.kind === "word" && !isReserved(prev.text)) return isInsertTarget(beforePrev);
    if (prev.kind === "quoted") return isInsertTarget(beforePrev);
    return true;
  }
  if (it.kind === "punct" && it.text === "*" && prev.kind === "punct" && prev.text === ".") return false;
  return true;
}

/** `into users (` — a column list, written with a space. */
function isInsertTarget(beforePrev: Item | undefined): boolean {
  return (
    beforePrev?.kind === "word" &&
    (beforePrev.upper === "INTO" ||
      beforePrev.upper === "TABLE" ||
      beforePrev.upper === "EXISTS" ||
      beforePrev.upper === "REFERENCES")
  );
}

function isCreateTable(items: Item[]): boolean {
  const words = items
    .filter((t) => t.kind === "word")
    .slice(0, 3)
    .map((t) => t.upper);
  return words[0] === "CREATE" && words.includes("TABLE");
}

/** The first top-level `(` of `CREATE TABLE name (`, not `AS (select…)`. */
function isCreateBodyParen(items: Item[], i: number): boolean {
  for (let j = 0; j < i; j++) if (isP(items[j], "(")) return false;
  const prev = items[i - 1];
  return !!prev && (prev.kind === "word" || prev.kind === "quoted") && prev.upper !== "AS";
}

/** `text` with every statement formatted. */
export function formatted(text: string, driver: DbDriver, style: SqlStyle = DEFAULT_SQL_STYLE): string {
  let out = text;
  for (const e of formatSql(text, driver, null, style).reverse())
    out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return out;
}

/**
 * `text` with its vocabulary in `keywordCase`, nothing else touched (live templates).
 * `loose` cases every vocabulary word, for fragments without context (`not null`, `int`).
 */
export function recased(text: string, driver: DbDriver, keywordCase: KeywordCase, loose = false): string {
  if (keywordCase === "preserve") return text;
  const { tokens } = lex(text, driver);
  const vocab = loose
    ? new Set(tokens.flatMap((t, i) => (t.kind === "word" && isVocabularyWord(t.upper) ? [i] : [])))
    : vocabulary(tokens, driver);
  let out = "";
  let at = 0;
  tokens.forEach((t, i) => {
    if (!vocab.has(i)) return;
    out += text.slice(at, t.from) + cased(t.text, keywordCase);
    at = t.to;
  });
  return out + text.slice(at);
}
