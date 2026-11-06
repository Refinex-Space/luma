/**
 * Kibana Dev Tools console text (`.es` files): requests are a `METHOD path` line at column 0
 * (`GET /logs/_search?size=5`, method case-insensitive, leading `/` optional), followed by
 * an optional JSON body up to the next request line. `#` and `//` line comments and
 * `/* *\/` blocks may stand between requests (and inside bodies). A body of several JSON
 * values (`_bulk`, `_msearch`) is NDJSON: one compact value per line. Kibana's `"""…"""`
 * strings are sent as JSON strings. Offsets are UTF-16 positions (CodeMirror's).
 */
import { pathSegments, type EsMethod } from "./catalog";

export interface EsConsoleRequest {
  /** Start of the request line, end of the body (or of the request line without one). */
  from: number;
  to: number;
  method: EsMethod;
  /** As written (leading `/` and query string kept). */
  path: string;
  methodFrom: number;
  pathFrom: number;
  pathTo: number;
  /** What goes to the server: JSON (comments dropped, `"""` strings converted) or NDJSON. */
  body: string | null;
  /** Where the body's first value starts. */
  bodyFrom?: number;
  ndjson: boolean;
  /** An invalid body (`Expected "," or "}" at line 4, column 7`) or a missing path. */
  error: string | null;
  /** Range of the error in the console text. */
  errorFrom?: number;
  errorTo?: number;
}

/** A request line: method, blanks, path (the rest of the line). */
export const REQUEST_LINE = /^(GET|POST|PUT|DELETE|HEAD|PATCH)(?=[ \t]|$)[ \t]*(.*?)[ \t\r]*$/i;

const NDJSON_PATH = /(^|\/)_(bulk|msearch)(\/template)?$/;

/** NDJSON endpoints (`_bulk`, `_msearch`, `_msearch/template`). */
export const isNdjsonPath = (path: string) => NDJSON_PATH.test(pathSegments(path).join("/"));

// ---- JSON tokens ---------------------------------------------------------------------

export interface JsonToken {
  kind: "punct" | "string" | "triple" | "scalar";
  from: number;
  to: number;
  /** As written. */
  raw: string;
  /** As JSON (`"""…"""` converted to a JSON string). */
  json: string;
  /** Blanks before the token (comments removed). */
  ws: string;
}

class JsonError extends Error {
  constructor(
    message: string,
    readonly from: number,
    readonly to: number,
  ) {
    super(message);
  }
}

const SCALAR = /-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?|true|false|null/y;
const WORD = /[^\s{}[\]:,"]+/y;
const ESCAPE = /\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/y;

/** End of the comment starting at `i` (`#`, `//`, `/*`), -1 when none starts there. */
function commentEnd(text: string, i: number, to: number): number {
  const c = text[i];
  if (c === "#" || (c === "/" && text[i + 1] === "/")) {
    const nl = text.indexOf("\n", i);
    return nl < 0 || nl > to ? to : nl;
  }
  if (c === "/" && text[i + 1] === "*") {
    const end = text.indexOf("*/", i + 2);
    if (end < 0 || end + 2 > to) throw new JsonError("Unterminated comment", i, i + 2);
    return end + 2;
  }
  return -1;
}

/** JSON tokens of `text[from, to)`, comments skipped. */
export function jsonTokens(text: string, from: number, to: number): JsonToken[] {
  const out: JsonToken[] = [];
  let ws = "";
  let i = from;
  const push = (kind: JsonToken["kind"], end: number, json?: string) => {
    const raw = text.slice(i, end);
    out.push({ kind, from: i, to: end, raw, json: json ?? raw, ws });
    ws = "";
    i = end;
  };
  while (i < to) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      ws += c;
      i++;
      continue;
    }
    const ce = commentEnd(text, i, to);
    if (ce >= 0) {
      i = ce;
      continue;
    }
    if ("{}[]:,".includes(c)) {
      push("punct", i + 1);
      continue;
    }
    if (c === '"') {
      if (text.startsWith('"""', i)) {
        const end = text.indexOf('"""', i + 3);
        if (end < 0 || end + 3 > to) throw new JsonError('Unterminated """ string', i, i + 3);
        push("triple", end + 3, JSON.stringify(text.slice(i + 3, end)));
        continue;
      }
      let j = i + 1;
      for (;;) {
        if (j >= to || text[j] === "\n" || text[j] === "\r") throw new JsonError("Unterminated string", i, j);
        const d = text[j]!;
        if (d === '"') break;
        if (d === "\\") {
          ESCAPE.lastIndex = j;
          if (!ESCAPE.test(text)) throw new JsonError("Invalid escape in string", j, j + 2);
          j = ESCAPE.lastIndex;
          continue;
        }
        if (d.charCodeAt(0) < 0x20) throw new JsonError("Control character in string", j, j + 1);
        j++;
      }
      push("string", j + 1);
      continue;
    }
    SCALAR.lastIndex = i;
    const m = SCALAR.exec(text);
    WORD.lastIndex = i;
    const w = WORD.exec(text)![0];
    if (m && m[0].length === w.length && i + w.length <= to) {
      push("scalar", i + w.length);
      continue;
    }
    const end = Math.min(i + w.length, to);
    throw new JsonError(`Unexpected "${text.slice(i, end)}"`, i, end);
  }
  return out;
}

/** The top-level values of `tokens` (token index ranges); throws on invalid JSON. */
function jsonValues(tokens: readonly JsonToken[], end: number): Array<[number, number]> {
  let k = 0;
  const fail = (message: string, t: JsonToken | undefined): never => {
    throw new JsonError(message, t ? t.from : end, t ? t.to : end);
  };
  const isPunct = (t: JsonToken | undefined, raw: string) => t?.kind === "punct" && t.raw === raw;
  const value = () => {
    const t = tokens[k];
    if (!t) return fail("Expected a value", t);
    if (t.kind !== "punct") {
      k++;
      return;
    }
    if (t.raw !== "{" && t.raw !== "[") fail(`Unexpected "${t.raw}"`, t);
    const object = t.raw === "{";
    const close = object ? "}" : "]";
    k++;
    if (isPunct(tokens[k], close)) {
      k++;
      return;
    }
    for (;;) {
      if (k >= tokens.length) fail(`Missing closing "${close}"`, t);
      if (object) {
        const key = tokens[k];
        if (key?.kind !== "string" && key?.kind !== "triple") fail("Expected a property name", key);
        k++;
        if (!isPunct(tokens[k], ":")) fail(tokens[k] ? 'Expected ":"' : `Missing closing "${close}"`, tokens[k] ?? t);
        k++;
      }
      value();
      const sep = tokens[k];
      if (isPunct(sep, ",")) {
        k++;
        if (isPunct(tokens[k], close)) fail(`Unexpected "${close}" after ","`, tokens[k]);
        continue;
      }
      if (isPunct(sep, close)) {
        k++;
        return;
      }
      fail(sep ? `Expected "," or "${close}"` : `Missing closing "${close}"`, sep ?? t);
    }
  };
  const out: Array<[number, number]> = [];
  while (k < tokens.length) {
    const start = k;
    value();
    out.push([start, k]);
  }
  return out;
}

// ---- requests ------------------------------------------------------------------------

function position(text: string, offset: number) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      col = 1;
    } else col++;
  }
  return `line ${line}, column ${col}`;
}

/** End of the last line of `text[from, to)` that is neither blank nor a comment line. */
function lastContent(text: string, from: number, to: number): number {
  let end = to;
  while (end > from) {
    const start = Math.max(from, text.lastIndexOf("\n", end - 1) + 1);
    const line = text.slice(start, end);
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("//")) return start + line.trimEnd().length;
    end = start - 1;
  }
  return -1;
}

/** Line starts of request lines. */
function requestLines(text: string): Array<{ from: number; to: number; m: RegExpExecArray }> {
  const out: Array<{ from: number; to: number; m: RegExpExecArray }> = [];
  let from = 0;
  while (from <= text.length) {
    const nl = text.indexOf("\n", from);
    const to = nl < 0 ? text.length : nl;
    const m = REQUEST_LINE.exec(text.slice(from, to));
    if (m) out.push({ from, to, m });
    if (nl < 0) break;
    from = nl + 1;
  }
  return out;
}

/** The requests of a console text, in order. */
export function parseRequests(text: string): EsConsoleRequest[] {
  const lines = requestLines(text);
  return lines.map((line, k) => {
    const { m } = line;
    const method = m[1]!.toUpperCase() as EsMethod;
    const path = m[2]!;
    const pathFrom = line.from + m[0].indexOf(path, m[1]!.length);
    const pathTo = pathFrom + path.length;
    const regionFrom = Math.min(line.to + 1, text.length);
    const regionTo = lines[k + 1]?.from ?? text.length;
    const req: EsConsoleRequest = {
      from: line.from,
      to: path ? pathTo : line.from + m[1]!.length,
      method,
      path,
      methodFrom: line.from,
      pathFrom: path ? pathFrom : line.from + m[1]!.length,
      pathTo: path ? pathTo : line.from + m[1]!.length,
      body: null,
      ndjson: isNdjsonPath(path),
      error: path ? null : "Missing request path",
    };
    if (!path) {
      req.errorFrom = line.from;
      req.errorTo = req.to;
    }
    try {
      const tokens = jsonTokens(text, regionFrom, regionTo);
      if (!tokens.length) return req;
      req.bodyFrom = tokens[0]!.from;
      const values = jsonValues(tokens, lastContent(text, regionFrom, regionTo));
      req.to = tokens.at(-1)!.to;
      req.ndjson ||= values.length > 1;
      req.body = req.ndjson
        ? values
            .map(([a, b]) =>
              tokens
                .slice(a, b)
                .map((t) => t.json)
                .join(""),
            )
            .join("\n") + "\n"
        : tokens.map((t, i) => (i ? t.ws : "") + t.json).join("");
    } catch (e) {
      if (!(e instanceof JsonError)) throw e;
      const end = lastContent(text, regionFrom, regionTo);
      if (end > req.to) {
        const start = regionFrom + (/^\s*/.exec(text.slice(regionFrom, end))?.[0].length ?? 0);
        req.bodyFrom ??= start;
        req.body = text.slice(req.bodyFrom, end);
        req.to = end;
      }
      req.error = `${e.message} at ${position(text, e.from)}`;
      req.errorFrom = e.from;
      req.errorTo = Math.max(e.to, e.from);
    }
    return req;
  });
}

const lineEnd = (text: string, pos: number) => {
  const nl = text.indexOf("\n", pos);
  return nl < 0 ? text.length : nl;
};

/**
 * The request at `pos`: on its lines, or on blank lines right after it. Null before the
 * first request and on comment lines between requests.
 */
export function requestAt(text: string, pos: number): EsConsoleRequest | null {
  const reqs = parseRequests(text);
  for (let k = 0; k < reqs.length; k++) {
    const r = reqs[k]!;
    if (pos < r.from) return null;
    const end = lineEnd(text, r.to);
    if (pos <= end) return r;
    const next = reqs[k + 1]?.from ?? text.length + 1;
    if (pos < next) return /^\s*$/.test(text.slice(end, pos)) ? r : null;
  }
  return null;
}

/** The requests a selection touches (the one at the caret when it is empty). */
export function requestsIn(text: string, from: number, to: number): EsConsoleRequest[] {
  if (from === to) {
    const r = requestAt(text, from);
    return r ? [r] : [];
  }
  return parseRequests(text).filter((r) => r.from < to && lineEnd(text, r.to) >= from);
}

// ---- formatting ----------------------------------------------------------------------

/**
 * `body` pretty-printed (2 spaces), NDJSON as one compact value per line; unchanged when it
 * is not valid JSON. Comments inside the body are dropped; `"""` strings stay.
 */
export function formatBody(body: string): string {
  let tokens: JsonToken[];
  let values: Array<[number, number]>;
  try {
    tokens = jsonTokens(body, 0, body.length);
    values = jsonValues(tokens, body.length);
  } catch {
    return body;
  }
  if (values.length !== 1)
    return values
      .map(([a, b]) =>
        tokens
          .slice(a, b)
          .map((t) => t.json)
          .join(""),
      )
      .join("\n");
  let out = "";
  let depth = 0;
  const pad = () => "\n" + "  ".repeat(depth);
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind !== "punct") {
      out += t.raw;
      continue;
    }
    switch (t.raw) {
      case "{":
      case "[": {
        const next = tokens[k + 1];
        if (next?.kind === "punct" && next.raw === (t.raw === "{" ? "}" : "]")) {
          out += t.raw + next.raw;
          k++;
        } else {
          depth++;
          out += t.raw + pad();
        }
        break;
      }
      case "}":
      case "]":
        depth--;
        out += pad() + t.raw;
        break;
      case ",":
        out += "," + pad();
        break;
      default:
        out += ": ";
    }
  }
  return out;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The request as a `curl` command against `baseUrl` (`http://localhost:9200`). */
export function toCurl(req: EsConsoleRequest, baseUrl: string): string {
  const url = `${baseUrl.replace(/\/+$/, "")}/${req.path.replace(/^\/+/, "")}`;
  const parts = [req.method === "HEAD" ? `curl -I ${shellQuote(url)}` : `curl -X ${req.method} ${shellQuote(url)}`];
  if (req.body !== null) {
    parts.push(`-H ${shellQuote(`Content-Type: application/${req.ndjson ? "x-ndjson" : "json"}`)}`);
    parts.push(`${req.ndjson ? "--data-binary" : "-d"} ${shellQuote(req.body)}`);
  }
  return parts.join(" \\\n  ");
}
