/**
 * Discover's query bar languages → Elasticsearch Query DSL.
 *
 * KQL follows Kibana's grammar (`kuery/grammar.peggy`): free text, `field:value`, quoted
 * phrases, `*` wildcards, `field:*` (exists), ranges `field >= value`, `and` / `or` / `not`
 * (case-insensitive; `not` binds tighter than `and`, `and` tighter than `or`), parentheses,
 * value lists `field:(a or b)`, nested `field:{ sub:value }` and `\` escapes. Unquoted values
 * may contain blanks (`message:hello world` matches "hello world"). With the index pattern's
 * fields known, keyword / numeric / boolean / ip fields get `term`, dates a day-exact `range`
 * and keyword wildcards a `wildcard` query; without them everything stays `match`-based.
 * Lucene text goes to `query_string` unchanged.
 */
import type { Completion } from "@codemirror/autocomplete";
import type { EsField } from "@/platform/ipc";

export type KqlResult =
  | { ok: true; query: Record<string, unknown> }
  | { ok: false; error: string; from: number; to: number };

type RangeOp = "gt" | "gte" | "lt" | "lte";

/** A literal: its text (escapes resolved), its `query_string` and `wildcard` forms. */
interface Lit {
  text: string;
  /** Lucene-escaped, unescaped `*` kept as wildcards (`query_string`). */
  query: string;
  /** `wildcard` query value (`*` wildcards, literal `*` `?` `\` escaped). */
  pattern: string;
  /** Contains an unescaped `*`. */
  wildcard: boolean;
  quoted: boolean;
  from: number;
  to: number;
}

type Node =
  | { k: "or" | "and"; items: Node[] }
  | { k: "not"; item: Node }
  | { k: "is"; field: Lit | null; value: Lit }
  | { k: "range"; field: Lit; op: RangeOp; value: Lit }
  | { k: "nested"; field: Lit; query: Node };

class KqlError extends Error {
  constructor(
    message: string,
    readonly from: number,
    readonly to: number,
  ) {
    super(message);
  }
}

const SPACE = /\s/;
/** Characters ending an unquoted literal (Kibana's `SpecialCharacter` minus `*`). */
const SPECIAL = /[\\():<>"{}]/;
const KEYWORD = /(or|and|not)(?=[\s()"{}]|$)/iy;
const RANGE = /(>=|<=|>|<)/y;
const LUCENE_SPECIAL = /[+\-=&|><!(){}[\]^"~*?:\\/\s]/;
const RANGE_OPS: Record<string, RangeOp> = { ">": "gt", ">=": "gte", "<": "lt", "<=": "lte" };

const quote = (s: string) => `"${s}"`;

/** The recursive descent parser; `lenient` scans broken input without throwing (tokens). */
class Parser {
  i = 0;
  constructor(
    readonly s: string,
    readonly lenient = false,
  ) {}

  get n() {
    return this.s.length;
  }

  ws() {
    while (this.i < this.n && SPACE.test(this.s[this.i]!)) this.i++;
  }

  keywordAt(at: number): "or" | "and" | "not" | null {
    KEYWORD.lastIndex = at;
    const m = KEYWORD.exec(this.s);
    return m ? (m[1]!.toLowerCase() as "or" | "and" | "not") : null;
  }

  rangeAt(at: number): string | null {
    RANGE.lastIndex = at;
    return RANGE.exec(this.s)?.[1] ?? null;
  }

  fail(message: string, from: number, to = from + 1): never {
    throw new KqlError(message, from, Math.min(Math.max(to, from), this.n));
  }

  /** At the end of the input or of the enclosing group / list / nested query. */
  closed() {
    return this.i >= this.n || this.s[this.i] === ")" || this.s[this.i] === "}";
  }

  /** `or`-separated terms; `field` set inside a value list `field:(…)`. */
  or(field: Lit | null): Node {
    const items = [this.and(field)];
    for (;;) {
      const save = this.i;
      this.ws();
      if (this.i > save && this.keywordAt(this.i) === "or") {
        const op = this.i;
        this.i += 2;
        this.ws();
        if (this.closed()) this.fail(`Expected a ${field ? "value" : "query"} after "or"`, op, op + 2);
        items.push(this.and(field));
      } else {
        this.i = save;
        return items.length === 1 ? items[0]! : { k: "or", items };
      }
    }
  }

  and(field: Lit | null): Node {
    const items = [this.not(field)];
    for (;;) {
      const save = this.i;
      this.ws();
      if (this.i > save && this.keywordAt(this.i) === "and") {
        const op = this.i;
        this.i += 3;
        this.ws();
        if (this.closed()) this.fail(`Expected a ${field ? "value" : "query"} after "and"`, op, op + 3);
        items.push(this.not(field));
      } else {
        this.i = save;
        return items.length === 1 ? items[0]! : { k: "and", items };
      }
    }
  }

  not(field: Lit | null): Node {
    this.ws();
    if (this.keywordAt(this.i) === "not") {
      const op = this.i;
      const after = this.s[op + 3];
      // A whole query `not` is a word; a trailing one after `and` / `or` dangles.
      if (after !== undefined || (!field && op > 0)) {
        this.i += 3;
        this.ws();
        if (this.closed()) this.fail(`Expected a ${field ? "value" : "query"} after "not"`, op, op + 3);
        return { k: "not", item: this.not(field) };
      }
    }
    return this.sub(field);
  }

  sub(field: Lit | null): Node {
    this.ws();
    const c = this.s[this.i];
    if (c === undefined) this.fail(field ? "Expected a value" : "Expected a query", this.n, this.n);
    if (c === "(") {
      const open = this.i++;
      this.ws();
      if (this.s[this.i] === ")") this.fail("Expected a query inside the parentheses", open, this.i + 1);
      const q = this.or(field);
      this.ws();
      if (this.s[this.i] !== ")") {
        if (this.i >= this.n) this.fail('Missing closing ")"', open);
        this.unexpected();
      }
      this.i++;
      return q;
    }
    const lit = this.literal();
    if (!lit) this.unexpected();
    if (field) return { k: "is", field, value: lit };
    const save = this.i;
    this.ws();
    const op = this.rangeAt(this.i);
    if (this.s[this.i] === ":") return this.fieldValue(lit);
    if (op) {
      const at = this.i;
      this.i += op.length;
      this.ws();
      const value = this.closed() ? null : this.literal();
      if (!value) this.fail(`Expected a value after "${op}"`, at, at + op.length);
      return { k: "range", field: lit, op: RANGE_OPS[op]!, value };
    }
    this.i = save;
    return { k: "is", field: null, value: lit };
  }

  /** After `field` at a `:`: a value, a value list or a nested query. */
  fieldValue(field: Lit): Node {
    const colon = this.i++;
    this.ws();
    const c = this.s[this.i];
    if (c === "{") {
      const open = this.i++;
      this.ws();
      if (this.s[this.i] === "}") this.fail("Expected a query inside the braces", open, this.i + 1);
      if (this.i >= this.n) this.fail('Missing closing "}"', open);
      const query = this.or(null);
      this.ws();
      if (this.s[this.i] !== "}") {
        if (this.i >= this.n) this.fail('Missing closing "}"', open);
        this.unexpected();
      }
      this.i++;
      return { k: "nested", field, query };
    }
    if (c === "(") {
      const open = this.i++;
      this.ws();
      if (this.s[this.i] === ")") this.fail("Expected a value inside the parentheses", open, this.i + 1);
      if (this.i >= this.n) this.fail('Missing closing ")"', open);
      const q = this.or(field);
      this.ws();
      if (this.s[this.i] !== ")") {
        if (this.i >= this.n) this.fail('Missing closing ")"', open);
        this.unexpected();
      }
      this.i++;
      return q;
    }
    const value = this.closed() || c === ":" ? null : this.literal();
    if (!value) this.fail('Missing value after ":"', colon);
    return { k: "is", field, value };
  }

  unexpected(): never {
    const c = this.s[this.i];
    if (c === undefined) this.fail("Unexpected end of query", this.n, this.n);
    if (this.keywordAt(this.i) === "not") this.fail('Expected "and" or "or" before "not"', this.i, this.i + 3);
    this.fail(`Unexpected "${c}"`, this.i);
  }

  /** A quoted or unquoted literal at `i` (blanks before it skipped), null when none starts there. */
  literal(): Lit | null {
    const s = this.s;
    const start = this.i;
    if (s[start] === '"') {
      let text = "";
      let i = start + 1;
      while (i < this.n && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < this.n) {
          const e = s[i + 1]!;
          text += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e;
          i += 2;
        } else text += s[i++];
      }
      if (i >= this.n) {
        if (!this.lenient) this.fail("Missing closing quote", start, this.n);
        this.i = this.n;
      } else this.i = i + 1;
      const query = quote(text.replace(/["\\]/g, "\\$&"));
      return {
        text,
        query,
        pattern: text.replace(/[*?\\]/g, "\\$&"),
        wildcard: false,
        quoted: true,
        from: start,
        to: this.i,
      };
    }
    let text = "";
    let query = "";
    let pattern = "";
    let wildcard = false;
    let i = start;
    let end = start;
    // Text, query and pattern up to the last non-blank character.
    let tail = { text: 0, query: 0, pattern: 0 };
    const mark = () => {
      end = i;
      tail = { text: text.length, query: query.length, pattern: pattern.length };
    };
    while (i < this.n) {
      const c = s[i]!;
      if (c === "\\") {
        if (i + 1 >= this.n) {
          if (!this.lenient) this.fail('Nothing to escape after "\\"', i);
          i++;
          mark();
          break;
        }
        const e = s[i + 1]!;
        text += e;
        query += LUCENE_SPECIAL.test(e) ? `\\${e}` : e;
        pattern += /[*?\\]/.test(e) ? `\\${e}` : e;
        i += 2;
        mark();
        continue;
      }
      if (SPECIAL.test(c)) break;
      if (SPACE.test(c)) {
        let j = i;
        while (j < this.n && SPACE.test(s[j]!)) j++;
        if (j >= this.n || SPECIAL.test(s[j]!) || this.keywordAt(j)) break;
        const blank = s.slice(i, j);
        text += blank;
        query += blank.replace(/\s/g, "\\$&");
        pattern += blank;
        i = j;
        continue;
      }
      if (c === "*") wildcard = true;
      text += c;
      query += c === "*" ? c : LUCENE_SPECIAL.test(c) ? `\\${c}` : c;
      pattern += c === "?" ? "\\?" : c;
      i++;
      mark();
    }
    if (end === start) return null;
    this.i = end;
    return {
      text: text.slice(0, tail.text),
      query: query.slice(0, tail.query),
      pattern: pattern.slice(0, tail.pattern),
      wildcard,
      quoted: false,
      from: start,
      to: end,
    };
  }
}

function parse(text: string): Node | null {
  const p = new Parser(text);
  p.ws();
  if (p.i >= p.n) return null;
  const node = p.or(null);
  p.ws();
  if (p.i < p.n) p.unexpected();
  return node;
}

// ---- DSL -----------------------------------------------------------------------------

type Kind = "text" | "keyword" | "number" | "date" | "boolean" | "ip" | "nested" | "other";

const KINDS: Record<string, Kind> = {
  text: "text",
  match_only_text: "text",
  search_as_you_type: "text",
  annotated_text: "text",
  keyword: "keyword",
  constant_keyword: "keyword",
  wildcard: "keyword",
  version: "keyword",
  long: "number",
  integer: "number",
  short: "number",
  byte: "number",
  double: "number",
  float: "number",
  half_float: "number",
  scaled_float: "number",
  unsigned_long: "number",
  token_count: "number",
  date: "date",
  date_nanos: "date",
  boolean: "boolean",
  ip: "ip",
  nested: "nested",
};

function kindOf(field: EsField | undefined): Kind | null {
  if (!field || !field.types.length) return null;
  const kinds = new Set(field.types.map((t) => KINDS[t] ?? "other"));
  return kinds.size === 1 ? [...kinds][0]! : null;
}

const NUMBER = /^-?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;

/** A number for numeric fields when it is one (and exact), else the text. */
function typed(text: string, kind: Kind | null): string | number | boolean {
  if (kind === "number" && NUMBER.test(text.trim())) {
    const n = Number(text);
    if (Number.isFinite(n) && (!Number.isInteger(n) || Number.isSafeInteger(n))) return n;
  }
  if (kind === "boolean" && /^(true|false)$/i.test(text.trim())) return text.trim().toLowerCase() === "true";
  return text;
}

type Dsl = Record<string, unknown>;

const globRegex = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

class Builder {
  readonly fields: Map<string, EsField> | null;
  constructor(fields: readonly EsField[] | undefined) {
    this.fields = fields?.length ? new Map(fields.map((f) => [f.name, f])) : null;
  }

  build(node: Node, prefix: string): Dsl {
    switch (node.k) {
      case "or": {
        const should = flatten(node, "or").map((n) => this.build(n, prefix));
        return { bool: { should, minimum_should_match: 1 } };
      }
      case "and":
        return { bool: { filter: flatten(node, "and").map((n) => this.build(n, prefix)) } };
      case "not":
        return { bool: { must_not: [this.build(node.item, prefix)] } };
      case "nested": {
        const path = prefix + node.field.text;
        const query = this.build(node.query, `${path}.`);
        return kindOf(this.fields?.get(path)) === "nested" ? { nested: { path, query, score_mode: "none" } } : query;
      }
      case "range":
        return this.range(node, prefix);
      case "is":
        return this.is(node, prefix);
    }
  }

  /** Fields matching a wildcard field name, null without known fields. */
  expand(pattern: string): string[] | null {
    if (!this.fields) return null;
    const re = globRegex(pattern);
    return [...this.fields.values()]
      .filter((f) => !f.metadata && f.searchable && re.test(f.name) && kindOf(f) !== "nested")
      .map((f) => f.name);
  }

  range(node: Extract<Node, { k: "range" }>, prefix: string): Dsl {
    const name = prefix + node.field.text;
    const one = (field: string) => {
      const value = typed(node.value.text, kindOf(this.fields?.get(field)));
      return { range: { [field]: { [node.op]: value } } };
    };
    if (isWildcardField(node.field)) {
      const names = this.expand(name);
      if (!names) {
        const op = Object.entries(RANGE_OPS).find(([, v]) => v === node.op)![0];
        return { query_string: { query: `${name}:${op}${node.value.query}`, analyze_wildcard: true, lenient: true } };
      }
      return names.length === 1 ? one(names[0]!) : { bool: { should: names.map(one), minimum_should_match: 1 } };
    }
    return one(name);
  }

  is(node: Extract<Node, { k: "is" }>, prefix: string): Dsl {
    const { field, value } = node;
    const exists = !value.quoted && value.wildcard && value.text === "*";
    if (!field || (!field.quoted && field.text === "*")) {
      if (prefix) throw new KqlError("Expected a field name inside a nested query", value.from, value.to);
      if (exists) return { match_all: {} };
      if (value.wildcard) return { query_string: { query: value.query, analyze_wildcard: true, lenient: true } };
      return { multi_match: { type: value.quoted ? "phrase" : "best_fields", query: value.text, lenient: true } };
    }
    const name = prefix + field.text;
    if (isWildcardField(field)) {
      const names = this.expand(name);
      if (!names) {
        if (exists) return { query_string: { query: `_exists_:${name}` } };
        return { query_string: { fields: [name], query: value.query, analyze_wildcard: true, lenient: true } };
      }
      const queries = names.map((n) => this.one(n, value, exists));
      return queries.length === 1 ? queries[0]! : { bool: { should: queries, minimum_should_match: 1 } };
    }
    return this.one(name, value, exists);
  }

  one(name: string, value: Lit, exists: boolean): Dsl {
    if (exists) return { exists: { field: name } };
    const kind = kindOf(this.fields?.get(name));
    if (value.wildcard) {
      if (kind === "keyword") return { wildcard: { [name]: { value: value.pattern } } };
      return { query_string: { fields: [name], query: value.query, analyze_wildcard: true } };
    }
    switch (kind) {
      case "keyword":
      case "number":
      case "boolean":
      case "ip":
        return { term: { [name]: typed(value.text, kind) } };
      case "date":
        return { range: { [name]: { gte: value.text, lte: value.text } } };
      default:
        return value.quoted ? { match_phrase: { [name]: value.text } } : { match: { [name]: value.text } };
    }
  }
}

const isWildcardField = (field: Lit) => !field.quoted && field.wildcard;

function flatten(node: Extract<Node, { k: "or" | "and" }>, k: "or" | "and"): Node[] {
  return node.items.flatMap((n) => (n.k === k ? flatten(n, k) : [n]));
}

/** KQL `text` → Query DSL (`match_all` when empty), or the first error and its range. */
export function kqlToDsl(text: string, fields?: readonly EsField[]): KqlResult {
  try {
    const node = parse(text);
    if (!node) return { ok: true, query: { match_all: {} } };
    return { ok: true, query: new Builder(fields).build(node, "") };
  } catch (e) {
    if (e instanceof KqlError) return { ok: false, error: e.message, from: e.from, to: e.to };
    throw e;
  }
}

/** Lucene query syntax → `query_string` (`match_all` when empty). */
export function luceneToDsl(text: string): Record<string, unknown> {
  const query = text.trim();
  return query ? { query_string: { query, analyze_wildcard: true } } : { match_all: {} };
}

// ---- tokens --------------------------------------------------------------------------

export type KqlTokenKind = "field" | "operator" | "range" | "keyword" | "value" | "string" | "paren" | "error";

export interface KqlToken {
  kind: KqlTokenKind;
  from: number;
  to: number;
  /** The token's text (a literal's escapes resolved). */
  text: string;
}

/** Tokens of a KQL query for highlighting (never fails: broken input still tokenizes). */
export function kqlTokens(text: string): KqlToken[] {
  const p = new Parser(text, true);
  const out: KqlToken[] = [];
  const push = (kind: KqlTokenKind, from: number, to: number, t = text.slice(from, to)) =>
    out.push({ kind, from, to, text: t });
  for (;;) {
    p.ws();
    const i = p.i;
    if (i >= p.n) return out;
    const c = text[i]!;
    const prev = out.at(-1);
    if ("(){}".includes(c)) {
      p.i++;
      push("paren", i, i + 1);
      continue;
    }
    if (c === ":") {
      p.i++;
      push("operator", i, i + 1);
      continue;
    }
    const op = p.rangeAt(i);
    if (op) {
      p.i += op.length;
      push("range", i, i + op.length);
      continue;
    }
    const kw = p.keywordAt(i);
    const afterOperator = prev && (prev.kind === "operator" || prev.kind === "range");
    if (kw && !afterOperator && (kw !== "not" || text[i + 3] !== undefined)) {
      p.i += kw.length;
      push("keyword", i, i + kw.length);
      continue;
    }
    const lit = p.literal();
    if (!lit) {
      p.i++;
      push("error", i, i + 1);
      continue;
    }
    let j = p.i;
    while (j < p.n && SPACE.test(text[j]!)) j++;
    const isField = !afterOperator && (text[j] === ":" || p.rangeAt(j) !== null);
    push(isField ? "field" : lit.quoted ? "string" : "value", lit.from, lit.to, lit.text);
  }
}

// ---- completion ----------------------------------------------------------------------

/** A query bar suggestion (a CodeMirror `Completion` with Luma's icon / type column). */
export interface KqlOption extends Completion {
  icon?: string | null;
  typeText?: string;
}

export interface KqlCompletions {
  from: number;
  options: KqlOption[];
  /** Set when completing a value of this field: the UI may add its top values. */
  field?: string;
}

const escapeField = (name: string) => name.replace(/[\\():<>"{}*\s]/g, "\\$&");

const KEYWORD_OPTION = (k: string): KqlOption => ({ label: k, apply: `${k} `, type: "keyword", icon: null });
const OPERATOR_OPTIONS: KqlOption[] = [
  { label: ":", apply: ": ", type: "operator", icon: null, typeText: "equals" },
  { label: ":*", apply: ":* ", type: "operator", icon: null, typeText: "exists" },
  { label: "<", apply: "< ", type: "operator", icon: null },
  { label: "<=", apply: "<= ", type: "operator", icon: null },
  { label: ">", apply: "> ", type: "operator", icon: null },
  { label: ">=", apply: ">= ", type: "operator", icon: null },
];

function fieldOptions(fields: readonly EsField[] | undefined, scope: string): KqlOption[] {
  if (!fields) return [];
  return fields
    .filter((f) => f.searchable && f.name.startsWith(scope) && f.name.length > scope.length)
    .map((f) => {
      const label = f.name.slice(scope.length);
      return {
        label,
        apply: `${escapeField(label)} `,
        type: "property",
        icon: "db-column",
        typeText: f.types.join(", "),
        boost: f.metadata ? -1 : 0,
      };
    });
}

/**
 * Suggestions at `pos` of a KQL query: field names (where a term starts), `:` and range
 * operators after a field, `and` / `or` after a term, and value positions (`field` set,
 * `true` / `false` offered for boolean fields).
 */
export function kqlCompletions(text: string, pos: number, fields?: readonly EsField[]): KqlCompletions {
  const before = text.slice(0, pos);
  let from = pos - (/[^\s\\():<>"{}]*$/.exec(before)?.[0].length ?? 0);
  let tokens = kqlTokens(before.slice(0, from));
  let inString = false;
  // An open quote before the caret: complete the quoted value.
  const all = kqlTokens(before);
  const last = all.at(-1);
  if (last && last.kind === "string" && last.to === pos && !/(^|[^\\])(\\\\)*"$/.test(before.slice(last.from + 1))) {
    inString = true;
    from = last.from;
    tokens = all.slice(0, -1);
  }

  type Frame = { kind: "group" | "list" | "nested"; field: string | null; scope: string };
  const stack: Frame[] = [];
  const scope = () => stack.at(-1)?.scope ?? "";
  let expect: "term" | "value" | "colon" | "op" | "fieldOrOp" = "term";
  let field: string | null = null;
  for (const t of tokens) {
    switch (t.kind) {
      case "paren":
        if (t.text === "(") {
          if (expect === "value") stack.push({ kind: "list", field, scope: scope() });
          else {
            stack.push({ kind: "group", field: null, scope: scope() });
            expect = "term";
          }
        } else if (t.text === "{") {
          stack.push({ kind: "nested", field: null, scope: field ? `${field}.` : scope() });
          expect = "term";
        } else {
          stack.pop();
          expect = "op";
        }
        break;
      case "keyword": {
        const top = stack.at(-1);
        if (top?.kind === "list") {
          expect = "value";
          field = top.field;
        } else expect = "term";
        break;
      }
      case "field":
        field = scope() + t.text;
        expect = "colon";
        break;
      case "operator":
      case "range":
        expect = "value";
        break;
      default:
        if (expect === "term" && t.kind === "value") {
          field = scope() + t.text;
          expect = "fieldOrOp";
        } else expect = "op";
    }
  }
  if (inString && expect !== "value") return { from, options: [] };
  switch (expect) {
    case "term":
      return { from, options: [...fieldOptions(fields, scope()), KEYWORD_OPTION("not")] };
    case "value": {
      const info = field ? fields?.find((f) => f.name === field) : undefined;
      const options: KqlOption[] =
        info && kindOf(info) === "boolean"
          ? ["true", "false"].map((v) => ({ label: v, type: "constant", icon: null }))
          : [];
      return field ? { from, options, field } : { from, options };
    }
    case "colon":
      return { from, options: OPERATOR_OPTIONS };
    case "fieldOrOp": {
      const known = !fields || fields.some((f) => f.name === field);
      return { from, options: [...(known ? OPERATOR_OPTIONS : []), KEYWORD_OPTION("and"), KEYWORD_OPTION("or")] };
    }
    case "op":
      return { from, options: [KEYWORD_OPTION("and"), KEYWORD_OPTION("or")] };
  }
}

// ---- Lucene (`query_string`) ----------------------------------------------------------

/** Characters ending a Lucene term (unless escaped with `\`). */
const LUCENE_STOP = /[\s()[\]{}":^~]/;
const LUCENE_KEYWORDS = new Set(["AND", "OR", "NOT", "TO", "&&", "||", "!"]);

/**
 * Tokens of a Lucene `query_string` query for highlighting (never fails): `field:` names,
 * terms, phrases and `/regex/`, `AND` / `OR` / `NOT` / `TO` (and `&&` `||` `!`), `+` / `-`,
 * `:>=` comparisons, `^boost` / `~fuzziness`, and the brackets of groups and ranges.
 */
export function luceneTokens(text: string): KqlToken[] {
  const out: KqlToken[] = [];
  const push = (kind: KqlTokenKind, from: number, to: number) =>
    out.push({ kind, from, to, text: text.slice(from, to) });
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const from = i;
    if (c === '"' || c === "/") {
      i++;
      while (i < n && text[i] !== c) i += text[i] === "\\" ? 2 : 1;
      i = Math.min(n, i + 1);
      push("string", from, i);
    } else if ("()[]{}".includes(c)) {
      push("paren", from, ++i);
    } else if ((c === "&" || c === "|") && text[i + 1] === c) {
      push("keyword", from, (i += 2));
    } else if (c === "!") {
      push("keyword", from, ++i);
    } else if (c === "+" || c === "-") {
      push("operator", from, ++i);
    } else if (c === ":") {
      i++;
      if (text[i] === ">" || text[i] === "<") i += text[i + 1] === "=" ? 2 : 1;
      push("operator", from, i);
    } else if (c === "^" || c === "~") {
      i++;
      while (i < n && /[\d.]/.test(text[i]!)) i++;
      push("operator", from, i);
    } else {
      while (i < n) {
        if (text[i] === "\\") i += 2;
        else if (LUCENE_STOP.test(text[i]!)) break;
        else i++;
      }
      i = Math.min(n, Math.max(i, from + 1));
      const word = text.slice(from, i);
      push(text[i] === ":" ? "field" : LUCENE_KEYWORDS.has(word) ? "keyword" : "value", from, i);
    }
  }
  return out;
}

const escapeLucene = (name: string) => name.replace(/[+\-=&|><!(){}[\]^"~*?:\\/\s]/g, "\\$&");

const LUCENE_KEYWORD = (k: string): KqlOption => ({ label: k, apply: `${k} `, type: "keyword", icon: null });
const EXISTS_OPTION: KqlOption = {
  label: "_exists_",
  apply: "_exists_:",
  type: "keyword",
  icon: null,
  typeText: "has a value",
};

function luceneFieldOptions(fields: readonly EsField[] | undefined): KqlOption[] {
  // The document's own fields first, `_id` / `_index` after them.
  const searchable = (fields ?? []).filter((f) => f.searchable);
  return [...searchable.filter((f) => !f.metadata), ...searchable.filter((f) => f.metadata)].map((f) => ({
    label: f.name,
    apply: `${escapeLucene(f.name)}:`,
    type: "property",
    icon: "db-column",
    typeText: f.types.join(", "),
    boost: f.metadata ? -1 : 0,
  }));
}

/**
 * Suggestions at `pos` of a Lucene query: field names (and `_exists_:`, `NOT`) where a
 * term starts, values after `field:` (`field` set; `true` / `false` for booleans, field
 * names after `_exists_:`), `AND` / `OR` / `NOT` or another field after a term, nothing
 * inside a range.
 */
export function luceneCompletions(text: string, pos: number, fields?: readonly EsField[]): KqlCompletions {
  const before = text.slice(0, pos);
  const tokens = luceneTokens(before);
  const last = tokens.at(-1);
  let from = pos;
  let prior = tokens;
  let inString = false;
  if (last && last.to === pos && (last.kind === "value" || last.kind === "keyword") && /[^\s]$/.test(before)) {
    from = last.from;
    prior = tokens.slice(0, -1);
  } else if (last && last.kind === "string" && last.to === pos && !/(^|[^\\])(\\\\)*"$/.test(last.text.slice(1))) {
    // An open phrase: complete the quoted value.
    inString = true;
    from = last.from;
    prior = tokens.slice(0, -1);
  }

  type Frame = { field: string | null; range: boolean };
  const stack: Frame[] = [];
  let expect: "term" | "value" | "op" | "none" = "term";
  let pending: string | null = null;
  let field: string | null = null;
  for (const t of prior) {
    const top = stack.at(-1);
    switch (t.kind) {
      case "field":
        pending = t.text.replace(/\\(.)/g, "$1");
        break;
      case "operator":
        if (t.text.startsWith(":")) {
          field = pending;
          expect = "value";
        } else if (t.text === "+" || t.text === "-") expect = top?.field ? "value" : "term";
        else expect = "op";
        break;
      case "keyword":
        if (t.text === "TO") expect = "none";
        else if (top?.field) {
          field = top.field;
          expect = "value";
        } else expect = "term";
        break;
      case "paren":
        if (t.text === "(") {
          stack.push({ field: expect === "value" ? field : null, range: false });
          expect = expect === "value" ? "value" : "term";
        } else if (t.text === "[" || t.text === "{") {
          stack.push({ field, range: true });
          expect = "none";
        } else {
          stack.pop();
          expect = "op";
        }
        break;
      default:
        if (top?.range) expect = "none";
        else {
          expect = "op";
          if (top?.field) field = top.field;
        }
    }
    if (t.kind !== "field") pending = null;
  }
  if (stack.at(-1)?.range) expect = "none";
  if (inString) {
    return expect === "value" && field && field !== "_exists_" ? { from, options: [], field } : { from, options: [] };
  }
  switch (expect) {
    case "none":
      return { from, options: [] };
    case "term":
      return { from, options: [...luceneFieldOptions(fields), EXISTS_OPTION, LUCENE_KEYWORD("NOT")] };
    case "value": {
      if (field === "_exists_")
        return {
          from,
          options: luceneFieldOptions(fields).map((o) => ({ ...o, apply: `${escapeLucene(o.label)} ` })),
        };
      const info = field ? fields?.find((f) => f.name === field) : undefined;
      const options: KqlOption[] =
        info && kindOf(info) === "boolean"
          ? ["true", "false"].map((v) => ({ label: v, apply: `${v} `, type: "constant", icon: null }))
          : [];
      return field ? { from, options, field } : { from, options };
    }
    case "op":
      return {
        from,
        options: [
          LUCENE_KEYWORD("AND"),
          LUCENE_KEYWORD("OR"),
          LUCENE_KEYWORD("NOT"),
          ...luceneFieldOptions(fields),
          EXISTS_OPTION,
        ],
      };
  }
}
