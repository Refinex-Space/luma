/**
 * The `.env` lexer and parser, after the JetBrains plugin's (`DotEnvLexer.flex`,
 * `DovEnvGrammar.bnf`): one state machine drives both the line-based highlighter
 * (`language.ts`) and the whole-file parser the checks, navigation and the project
 * model read.
 *
 *   # comment
 *   export KEY=unquoted value   # inline comment
 *   KEY: value                  (`:` separates too)
 *   KEY="double ${NESTED} \" multi-line"   KEY='single, no nesting'
 */

/** Lexer state, kept across lines (quoted values span lines). */
export type LexState =
  | "initial"
  /** After `export `. */
  | "key"
  /** After `=` / `:`. */
  | "value"
  | "doubleQuoted"
  | "singleQuoted"
  /** After a closing quote: the rest of the line is comment. */
  | "comment"
  /** After `${`. */
  | "nested"
  /** After the nested variable's name, before `}`. */
  | "nestedEnd";

export type TokenType =
  | "comment"
  | "export"
  | "key"
  | "separator"
  | "value"
  | "quote"
  | "nestedStart"
  | "nestedKey"
  | "nestedEnd"
  | "space"
  | "bad";

export interface LexToken {
  type: TokenType;
  /** End offset in the line. */
  end: number;
  state: LexState;
}

const KEY_CHARS = /(?:[^:=\s\\${}]|\\ )+/y;
const EXPORT = /[eE][xX][pP][oO][rR][tT] +/y;
const SPACE = /[ \t\f]+/y;
const UNQUOTED_VALUE = /(?:[^ \t\f"'\\#]|\\.)[^#]*/y;
const DOUBLE_QUOTED_CHARS = /(?:[^\\"$]|\\.?|\$(?=[^{"]|$))+/y;
const SINGLE_QUOTED_CHARS = /(?:[^\\']|\\.?)+/y;
const NESTED_END = /[ \t\f]*\}/y;

function at(re: RegExp, text: string, pos: number): number {
  re.lastIndex = pos;
  return re.test(text) ? re.lastIndex : -1;
}

/** The token at `pos` of `line` in `state` (never empty). */
export function lexToken(state: LexState, line: string, pos: number): LexToken {
  const ch = line[pos]!;
  let end: number;
  switch (state) {
    case "initial":
    case "key":
      if ((end = at(SPACE, line, pos)) > 0) return { type: "space", end, state };
      if (state === "initial" && ch === "#") return { type: "comment", end: line.length, state };
      if (state === "initial" && (end = at(EXPORT, line, pos)) > 0) {
        // `export` alone is a key (`export=1`); the prefix needs a key after it.
        if (end < line.length && at(KEY_CHARS, line, end) > 0) return { type: "export", end, state: "key" };
      }
      if ((end = at(KEY_CHARS, line, pos)) > 0) return { type: "key", end, state: "initial" };
      if (state === "initial" && (ch === "=" || ch === ":")) return { type: "separator", end: pos + 1, state: "value" };
      return { type: "bad", end: pos + 1, state: "initial" };
    case "value":
      if ((end = at(SPACE, line, pos)) > 0) return { type: "space", end, state };
      if (ch === '"') return { type: "quote", end: pos + 1, state: "doubleQuoted" };
      if (ch === "'") return { type: "quote", end: pos + 1, state: "singleQuoted" };
      if (ch === "#") return { type: "comment", end: line.length, state: "comment" };
      if ((end = at(UNQUOTED_VALUE, line, pos)) > 0) return { type: "value", end, state: "initial" };
      return { type: "bad", end: pos + 1, state: "initial" };
    case "doubleQuoted":
      if (ch === '"') return { type: "quote", end: pos + 1, state: "comment" };
      if (line.startsWith("${", pos)) return { type: "nestedStart", end: pos + 2, state: "nested" };
      if ((end = at(DOUBLE_QUOTED_CHARS, line, pos)) > 0) return { type: "value", end, state };
      // A lone `$` before the closing quote.
      return { type: "value", end: pos + 1, state };
    case "singleQuoted":
      if (ch === "'") return { type: "quote", end: pos + 1, state: "comment" };
      return { type: "value", end: Math.max(at(SINGLE_QUOTED_CHARS, line, pos), pos + 1), state };
    case "comment":
      if ((end = at(SPACE, line, pos)) > 0 && end === line.length) return { type: "space", end, state };
      return { type: "comment", end: line.length, state };
    case "nested":
    case "nestedEnd":
      if ((end = at(NESTED_END, line, pos)) > 0) return { type: "nestedEnd", end, state: "doubleQuoted" };
      if (state === "nested" && (end = at(KEY_CHARS, line, pos)) > 0)
        return { type: "nestedKey", end, state: "nestedEnd" };
      if ((end = at(SPACE, line, pos)) > 0) return { type: "space", end, state };
      // Not a nested variable after all: back to the quoted value.
      return { type: "value", end: pos + 1, state: "doubleQuoted" };
  }
}

/** The state a line break leaves: quoted values continue on the next line. */
export function lineBreak(state: LexState): LexState {
  return state === "doubleQuoted" || state === "singleQuoted" ? state : "initial";
}

// ---------------------------------------------------------------------------
// Parser

export interface Span {
  from: number;
  to: number;
}

export interface DotEnvValue extends Span {
  /** The value as written, quotes included. */
  raw: string;
  /** Without its quotes. */
  text: string;
  quote: '"' | "'" | null;
}

export interface DotEnvProperty {
  key: string;
  /** The key. */
  keySpan: Span;
  /** The whole `export KEY=value` (without a trailing comment). */
  span: Span;
  exportSpan: Span | null;
  /** `=` or `:`; `null` for a key alone on its line. */
  separator: Span | null;
  value: DotEnvValue | null;
}

/** `${NAME}` inside a double-quoted value. */
export interface NestedVariable {
  /** Empty for `${}`. */
  key: string;
  /** The name (empty at the `}` for `${}`). */
  keySpan: Span;
  /** `${` … `}`. */
  span: Span;
}

export interface DotEnvFile {
  properties: DotEnvProperty[];
  nested: NestedVariable[];
  /** Lines (0-based) inside a multi-line quoted value after its first. */
  continuationLines: Set<number>;
  /** Lines (0-based) whose line break is inside a quoted value (their trailing spaces are part of it). */
  quotedLineEnds: Set<number>;
}

interface Tok extends Span {
  type: TokenType;
  line: number;
}

/** Every token of `text` with its absolute offsets. */
export function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let state: LexState = "initial";
  let lineStart = 0;
  let line = 0;
  for (;;) {
    const nl = text.indexOf("\n", lineStart);
    const lineEnd = nl < 0 ? text.length : nl;
    const content = text.slice(lineStart, lineEnd).replace(/\r$/, "");
    for (let pos = 0; pos < content.length;) {
      const t = lexToken(state, content, pos);
      out.push({ type: t.type, from: lineStart + pos, to: lineStart + t.end, line });
      state = t.state;
      pos = t.end;
    }
    if (nl < 0) break;
    state = lineBreak(state);
    lineStart = nl + 1;
    line++;
  }
  return out;
}

export function parseDotEnv(text: string): DotEnvFile {
  const tokens = tokenize(text);
  const properties: DotEnvProperty[] = [];
  const nested: NestedVariable[] = [];
  const continuationLines = new Set<number>();
  const quotedLineEnds = new Set<number>();
  let i = 0;
  const next = () => {
    while (i < tokens.length && tokens[i]!.type === "space") i++;
    return tokens[i];
  };
  while (i < tokens.length) {
    const first = next();
    if (!first) break;
    if (first.type !== "export" && first.type !== "key") {
      i++;
      continue;
    }
    let exportSpan: Span | null = null;
    let keyTok = first;
    if (first.type === "export") {
      exportSpan = { from: first.from, to: first.to };
      i++;
      const k = next();
      if (!k || k.type !== "key" || k.line !== first.line) continue;
      keyTok = k;
    }
    i++;
    const key = text.slice(keyTok.from, keyTok.to);
    const prop: DotEnvProperty = {
      key,
      keySpan: { from: keyTok.from, to: keyTok.to },
      span: { from: exportSpan?.from ?? keyTok.from, to: keyTok.to },
      exportSpan,
      separator: null,
      value: null,
    };
    properties.push(prop);
    const sep = next();
    if (!sep || sep.type !== "separator" || sep.line !== keyTok.line) continue;
    i++;
    prop.separator = { from: sep.from, to: sep.to };
    prop.span.to = sep.to;
    const v = next();
    if (!v || v.line !== sep.line) continue;
    if (v.type === "value") {
      i++;
      // Spaces before an inline comment are not part of the value.
      const raw = text.slice(v.from, v.to).replace(/[ \t\f]+$/, "");
      const to = v.from + raw.length;
      prop.value = { from: v.from, to, raw, text: raw, quote: null };
      prop.span.to = to;
    } else if (v.type === "quote") {
      const quote = text[v.from] as '"' | "'";
      i++;
      let end = v.to;
      let closed = false;
      const QUOTED = new Set<TokenType>(["value", "space", "quote", "nestedStart", "nestedKey", "nestedEnd"]);
      while (i < tokens.length && QUOTED.has(tokens[i]!.type)) {
        const t = tokens[i]!;
        for (let l = v.line + 1; l <= t.line; l++) {
          continuationLines.add(l);
          quotedLineEnds.add(l - 1);
        }
        end = t.to;
        i++;
        if (t.type === "quote") {
          closed = true;
          break;
        }
        if (t.type === "nestedStart") {
          const k = tokens[i]?.type === "nestedKey" ? tokens[i]! : null;
          const close = tokens[i + (k ? 1 : 0)];
          if (close?.type === "nestedEnd")
            nested.push({
              key: k ? text.slice(k.from, k.to) : "",
              keySpan: k ? { from: k.from, to: k.to } : { from: close.from, to: close.from },
              span: { from: t.from, to: close.to },
            });
        }
      }
      const raw = text.slice(v.from, end);
      prop.value = {
        from: v.from,
        to: end,
        raw,
        text: raw.slice(1, closed ? -1 : undefined),
        quote,
      };
      prop.span.to = end;
    }
  }
  return { properties, nested, continuationLines, quotedLineEnds };
}

/** The property whose key, or the nested variable whose name, is at `pos`. */
export function symbolAt(
  file: DotEnvFile,
  pos: number,
): { kind: "declaration" | "reference"; key: string; span: Span } | null {
  for (const p of file.properties)
    if (p.keySpan.from <= pos && pos <= p.keySpan.to) return { kind: "declaration", key: p.key, span: p.keySpan };
  for (const n of file.nested)
    if (n.key && n.keySpan.from <= pos && pos <= n.keySpan.to)
      return { kind: "reference", key: n.key, span: n.keySpan };
  return null;
}
