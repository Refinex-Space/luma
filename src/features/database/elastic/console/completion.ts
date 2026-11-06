/**
 * Completion in Elasticsearch consoles: the method at a line start; path segments (index
 * names, aliases and data streams, `_api` words fitting the position) and query parameters
 * on request lines; in a body, the keys valid at the caret's JSON path (Query DSL clauses
 * under `query`, aggregation types under `aggs.<name>`, field names of the request's
 * index under `match` / `range`…), and values (`field` names, enumerations, booleans).
 */
import {
  snippet,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { EsField } from "@/platform/ipc";
import {
  COMMON_PARAMS,
  DSL_SCHEMAS,
  ES_METHODS,
  FLAG_PARAMS,
  INDEX_PARAMS_NAMES,
  PARAM_VALUES,
  matchApi,
  nextSegments,
  pathSegments,
  resolveRef,
  schemaAt,
  schemaKeys,
  schemaValues,
  type DslSchema,
  type FieldFilter,
} from "./catalog";
import { REQUEST_LINE } from "./parse";

export interface EsConsoleContext {
  /** Index, alias and data stream names of the console's data source. */
  indices(): readonly string[];
  /** Fields of an index name / pattern (`*` when the request names none). */
  fields(index: string): Promise<readonly EsField[]> | readonly EsField[];
}

/** A completion with Luma's icon and right-aligned type column. */
export interface EsCompletion extends Completion {
  icon?: string | null;
  typeText?: string;
}

// ---- JSON context --------------------------------------------------------------------

export interface JsonContext {
  /** Keys from the body's root to the place completed (`[]` for array items). */
  path: string[];
  /** A key of the object at `path`, or the value at `path`. */
  at: "key" | "value";
  /** Inside a `"…"` string (`from` is its opening quote). */
  inString: boolean;
  /** Where the typed word / string starts, and what is typed of it. */
  from: number;
  prefix: string;
  /** Index of the top-level value (NDJSON line) the caret is in. */
  root: number;
}

interface Frame {
  type: "{" | "[";
  key: string | null;
  state: "key" | "colon" | "value" | "after";
}

const WORD = /[^\s{}[\]:,"]+/y;

/**
 * Where `pos` is in the JSON text starting at `from`: the path of keys and whether a key
 * or a value is typed there. Null in comments, `"""` strings, after a complete value and
 * outside any object or array.
 */
export function jsonContextAt(text: string, from: number, pos: number): JsonContext | null {
  return scanJson(text, from, pos).context;
}

/** The JSON context at `pos`, and how many objects / arrays are open there. */
function scanJson(text: string, from: number, pos: number): { context: JsonContext | null; depth: number } {
  const stack: Frame[] = [];
  let root = 0;
  const top = () => stack.at(-1);
  const valueDone = () => {
    const t = top();
    if (t) t.state = "after";
    else root++;
  };
  const result = (inString: boolean, start: number) => ({ context: context(inString, start), depth: stack.length });
  const context = (inString: boolean, start: number): JsonContext | null => {
    const t = top();
    if (!t || (t.state !== "key" && t.state !== "value")) return null;
    const path = stack.slice(0, -1).map((f) => (f.type === "{" ? (f.key ?? "") : "[]"));
    if (t.state === "value") {
      if (t.type === "{" && t.key === null) return null;
      path.push(t.type === "{" ? t.key! : "[]");
    }
    return { path, at: t.state, inString, from: start, prefix: text.slice(inString ? start + 1 : start, pos), root };
  };
  let i = from;
  while (i < pos) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "#" || (c === "/" && text[i + 1] === "/")) {
      const nl = text.indexOf("\n", i);
      if (nl < 0 || nl >= pos) return { context: null, depth: stack.length };
      i = nl;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0 || end + 2 > pos) return { context: null, depth: stack.length };
      i = end + 2;
      continue;
    }
    if (c === '"') {
      if (text.startsWith('"""', i)) {
        const end = text.indexOf('"""', i + 3);
        if (end < 0 || end + 3 > pos) return { context: null, depth: stack.length };
        i = end + 3;
        valueDone();
        continue;
      }
      let j = i + 1;
      let content = "";
      while (j < pos && text[j] !== '"' && text[j] !== "\n") {
        if (text[j] === "\\") {
          content += text[j + 1] ?? "";
          j += 2;
        } else content += text[j++];
      }
      if (j >= pos) return result(true, i);
      const t = top();
      if (t?.type === "{" && t.state === "key") {
        t.key = content;
        t.state = "colon";
      } else valueDone();
      i = text[j] === '"' ? j + 1 : j;
      continue;
    }
    if (c === "{" || c === "[") {
      const t = top();
      if (t) t.state = "after";
      stack.push({ type: c, key: null, state: c === "{" ? "key" : "value" });
      i++;
      continue;
    }
    if (c === "}" || c === "]") {
      stack.pop();
      valueDone();
      i++;
      continue;
    }
    if (c === ":") {
      const t = top();
      if (t?.type === "{") t.state = "value";
      i++;
      continue;
    }
    if (c === ",") {
      const t = top();
      if (t) {
        t.state = t.type === "{" ? "key" : "value";
        t.key = null;
      }
      i++;
      continue;
    }
    WORD.lastIndex = i;
    const end = WORD.exec(text) ? WORD.lastIndex : i + 1;
    if (end >= pos) return result(false, i);
    i = end;
    valueDone();
  }
  return result(false, pos);
}

// ---- options -------------------------------------------------------------------------

function kindLabel(schema: DslSchema): string {
  const [first] = schemaValues(schema);
  if (!first) return "";
  switch (first.kind) {
    case "object":
    case "fields":
    case "named":
      return "object";
    case "array":
      return "array";
    case "value":
      return first.field ? "field" : first.type;
    default:
      return "";
  }
}

/** What follows `"key": ` for a value of `schema` (a snippet template). */
export function valueSnippet(schema: DslSchema): string {
  const [first] = schemaValues(schema);
  if (!first) return "${}";
  switch (first.kind) {
    case "object":
      return Object.keys(first.keys).length <= 1 && !first.fieldKeys ? "{${}}" : "{\n\t${}\n}";
    case "fields":
    case "named":
      return "{\n\t${}\n}";
    case "array": {
      const [item] = schemaValues(resolveRef(first.items));
      return item && item.kind !== "value" ? "[\n\t{\n\t\t${}\n\t}\n]" : "[${}]";
    }
    case "value":
      if (first.type === "boolean") return "${true}";
      if (first.type === "string") return first.values?.length ? `"\${${first.values[0]}}"` : '"${}"';
      return "${}";
    default:
      return "${}";
  }
}

const escapeSnippet = (s: string) => s.replace(/[{}\\]/g, "\\$&");

/** Inserts `"key": <value snippet>`, over a closing quote typed already; just `"key"` before a `:`. */
function applyKey(name: string, schema: DslSchema) {
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    let end = to;
    if (view.state.sliceDoc(end, end + 1) === '"') end++;
    const key = `"${escapeSnippet(name.replace(/["\\]/g, "\\$&"))}"`;
    const colon = /^\s*:/.test(view.state.sliceDoc(end, end + 40));
    snippet(colon ? key : `${key}: ${valueSnippet(schema)}`)(view, completion, from, end);
  };
}

function keyOption(name: string, schema: DslSchema): EsCompletion {
  return { label: name, type: "property", typeText: kindLabel(schema), apply: applyKey(name, schema) };
}

/** `fields` that fit `filter`, as options built by `make` (aggregatable ones first for `agg`). */
function fieldOptions(
  fields: readonly EsField[],
  filter: FieldFilter,
  make: (f: EsField) => EsCompletion,
): EsCompletion[] {
  return fields
    .filter((f) =>
      filter === "nested" ? f.types.includes("nested") : !f.types.every((t) => t === "object" || t === "nested"),
    )
    .map((f) => {
      const o = make(f);
      o.icon = "db-column";
      o.typeText = f.types.join(", ");
      o.boost = (f.metadata ? -2 : 0) + (filter === "agg" ? (f.aggregatable ? 1 : -1) : 0);
      return o;
    });
}

const methodOptions = (): EsCompletion[] =>
  ES_METHODS.map((m) => ({ label: m, apply: `${m} `, type: "keyword", icon: null }));

// ---- source --------------------------------------------------------------------------

/** The request line at or above line `number` (1-based), with its line. */
function headerAbove(doc: Text, number: number): { line: number; method: string; path: string; end: number } | null {
  for (let n = number; n >= 1; n--) {
    const line = doc.line(n);
    const m = REQUEST_LINE.exec(line.text);
    if (m) return { line: n, method: m[1]!.toUpperCase(), path: m[2]!, end: line.to };
  }
  return null;
}

/** Index (pattern) a request path names, `*` when it starts with an `_api` word. */
export function requestIndex(path: string): string {
  const [first] = pathSegments(path);
  return first && !first.startsWith("_") ? first : "*";
}

function pathCompletion(ctx: EsConsoleContext, method: string, text: string, base: number): CompletionResult | null {
  const q = text.indexOf("?");
  if (q >= 0) {
    const api = matchApi(method, text.slice(0, q));
    const query = text.slice(q + 1);
    const amp = query.lastIndexOf("&");
    const cur = query.slice(amp + 1);
    const curFrom = base + q + 1 + amp + 1;
    const eq = cur.indexOf("=");
    if (eq >= 0) {
      const values = PARAM_VALUES[cur.slice(0, eq)];
      if (!values) return null;
      return {
        from: curFrom + eq + 1,
        options: values.map((v): EsCompletion => ({ label: v, type: "constant", icon: null })),
        validFor: /^[\w-]*$/,
      };
    }
    const names = [...new Set([...(api?.params ?? []), ...COMMON_PARAMS])];
    return {
      from: curFrom,
      options: names.map((n, i): EsCompletion => ({
        label: n,
        apply: FLAG_PARAMS.has(n) ? n : `${n}=`,
        type: "property",
        icon: null,
        boost: i < (api?.params?.length ?? 0) ? 1 : 0,
      })),
      validFor: /^[\w-]*$/,
    };
  }
  const lead = text.startsWith("/") ? 1 : 0;
  const parts = text.slice(lead).split("/");
  const cur = parts.pop()!;
  const curFrom = base + text.length - cur.length;
  const options: EsCompletion[] = [];
  let indices = false;
  for (const [seg, apis] of nextSegments(method, parts)) {
    if (seg.startsWith("{")) {
      if (INDEX_PARAMS_NAMES.has(seg)) indices = true;
      continue;
    }
    const ending = apis.filter((a) => pathSegments(a.path).length === parts.length + 1);
    options.push({
      label: seg,
      apply: ending.length ? seg : `${seg}/`,
      type: "function",
      info: ending.length ? ending.map((a) => `${a.methods.join(" ")}  ${a.summary}`).join("\n") : undefined,
    });
  }
  const comma = cur.lastIndexOf(",");
  if (indices) {
    const names = ctx.indices().map((name): EsCompletion => ({
      label: name,
      type: "variable",
      icon: "db-index",
      boost: name.startsWith(".") ? -1 : 0,
    }));
    if (comma >= 0) return names.length ? { from: curFrom + comma + 1, options: names, validFor: /^[\w.*-]*$/ } : null;
    options.push(...names);
  }
  return options.length ? { from: curFrom, options, validFor: /^[\w.*-]*$/ } : null;
}

async function bodyCompletion(
  ctx: EsConsoleContext,
  cx: CompletionContext,
  header: { method: string; path: string },
  json: JsonContext,
  offset: number,
): Promise<CompletionResult | null> {
  const api = matchApi(header.method, header.path);
  let name = api?.schema;
  if (api?.header && json.root % 2 === 0) name = api.header;
  if (!name && pathSegments(header.path).at(-1) === "_search") name = "search";
  const root = name ? DSL_SCHEMAS[name] : undefined;
  const place = root ? schemaAt(root, json.path) : null;
  if (!place) return null;
  const from = offset + json.from;
  const loadFields = async () => {
    const list = await ctx.fields(requestIndex(header.path));
    return cx.aborted ? null : list;
  };
  if (json.at === "key") {
    const { keys, fields } = schemaKeys(place);
    const options = keys.map(([k, s]) => keyOption(k, s));
    if (fields) {
      const list = await loadFields();
      if (!list) return null;
      options.push(...fieldOptions(list, fields.filter, (f) => keyOption(f.name, fields.value)));
    }
    return options.length ? { from, options, validFor: /^"?[\w.@-]*$/ } : null;
  }
  const values = schemaValues(place).filter((v) => v.kind === "value");
  const enums = [...new Set(values.flatMap((v) => (v.kind === "value" ? (v.values ?? []) : [])))];
  const filter = values.find((v) => v.kind === "value" && v.field)?.field as FieldFilter | undefined;
  const q = (s: string) => (json.inString ? s : `"${s}"`);
  const options: EsCompletion[] = enums.map((v) => ({ label: v, apply: q(v), type: "constant", icon: null }));
  if (!json.inString && values.some((v) => v.kind === "value" && v.type === "boolean"))
    options.push(...["true", "false"].map((v): EsCompletion => ({ label: v, type: "keyword", icon: null })));
  if (filter) {
    const list = await loadFields();
    if (!list) return null;
    options.push(...fieldOptions(list, filter, (f) => ({ label: f.name, apply: q(f.name), type: "property" })));
  }
  if (!options.length) return null;
  return json.inString
    ? { from: from + 1, options, validFor: /^[\w.@-]*$/ }
    : { from, options, validFor: /^"?[\w.@-]*$/ };
}

/** The completion source of an Elasticsearch console. */
export function esConsoleCompletion(ctx: EsConsoleContext): CompletionSource {
  return async (cx: CompletionContext): Promise<CompletionResult | null> => {
    const { state, pos } = cx;
    const line = state.doc.lineAt(pos);
    const before = line.text.slice(0, pos - line.from);
    const request = REQUEST_LINE.exec(line.text);
    if (request && before.length > request[1]!.length) {
      const m = /^([A-Za-z]+)([ \t]+)(\S*)$/.exec(before);
      return m ? pathCompletion(ctx, m[1]!.toUpperCase(), m[3]!, line.from + m[1]!.length + m[2]!.length) : null;
    }
    const header = request ? null : headerAbove(state.doc, line.number - 1);
    const bodyFrom = header ? header.end + 1 : -1;
    if (/^[A-Za-z]*$/.test(before)) {
      // A word at column 0 starts a request unless it is inside a body's object / array.
      const inBody = header && scanJson(state.doc.sliceString(bodyFrom, line.from), 0, line.from - bodyFrom).depth > 0;
      if (!inBody) {
        if (!cx.explicit && !before) return null;
        return { from: line.from, options: methodOptions(), validFor: /^[A-Za-z]*$/ };
      }
    }
    if (!header) return null;
    const text = state.doc.sliceString(bodyFrom, pos);
    const json = jsonContextAt(text, 0, text.length);
    if (!json) return null;
    if (!cx.explicit && !json.prefix && !json.inString) return null;
    return bodyCompletion(ctx, cx, header, json, bodyFrom);
  };
}
