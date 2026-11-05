/**
 * Server replies of the Redis console as `redis-cli` prints them, and how the Database
 * Console tool window shows them: simple replies stay in Output, collections and long
 * strings get a `Result N` tab laid out as a list, key / value pairs, a tree or text.
 */
import type { RedisBytes, RedisReply } from "@/platform/ipc";
import { bytesLabel } from "../model";
import { splitLine } from "./parse";

const encoder = new TextEncoder();

/** Bytes of a binary-safe string. */
export const byteLength = (b: RedisBytes) => (b.binary ? b.text.length / 2 : encoder.encode(b.text).length);

/** `redis-cli`'s quoting of a bulk string (`sdscatrepr`, keeping printable Unicode). */
export function quoted(b: RedisBytes): string {
  if (b.binary) return `"${bytesLabel(b)}"`;
  let out = '"';
  for (const ch of b.text) {
    const c = ch.codePointAt(0)!;
    if (ch === "\\" || ch === '"') out += `\\${ch}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c === 7) out += "\\a";
    else if (c === 8) out += "\\b";
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

export const isAggregate = (r: RedisReply): r is Extract<RedisReply, { kind: "array" | "set" | "map" }> =>
  r.kind === "array" || r.kind === "set" || r.kind === "map";

const EMPTY: Record<"array" | "set" | "map", string> = {
  array: "(empty array)",
  set: "(empty set)",
  map: "(empty hash)",
};

/** A reply as `redis-cli` prints it on a terminal (`1) "a"`, `(integer) 3`, `(nil)`…). */
export function cliText(r: RedisReply): string {
  switch (r.kind) {
    case "nil":
      return "(nil)";
    case "status":
      return r.text;
    case "error":
      return `(error) ${r.text}`;
    case "int":
      return `(integer) ${r.text}`;
    case "double":
      return `(double) ${r.text}`;
    case "bool":
      return r.value ? "(true)" : "(false)";
    case "bulk":
      return quoted(r.value);
    case "verbatim":
      return r.text;
    case "array":
    case "set":
    case "map": {
      const n = r.kind === "map" ? r.entries.length : r.items.length;
      if (!n) return EMPTY[r.kind];
      const width = String(n).length;
      const mark = r.kind === "array" ? ")" : r.kind === "set" ? "~" : "#";
      const lines: string[] = [];
      for (let i = 0; i < n; i++) {
        const prefix = `${String(i + 1).padStart(width)}${mark} `;
        const body =
          r.kind === "map" ? `${cliText(r.entries[i]!.key)} => ${cliText(r.entries[i]!.value)}` : cliText(r.items[i]!);
        const indent = " ".repeat(prefix.length);
        body.split("\n").forEach((line, j) => lines.push((j ? indent : prefix) + line));
      }
      return lines.join("\n");
    }
  }
}

/** Text of a scalar reply as a grid cell (`null` for nil); collections as `redis-cli` prints them. */
export function cellText(r: RedisReply): string | null {
  switch (r.kind) {
    case "nil":
      return null;
    case "bulk":
      return bytesLabel(r.value);
    case "status":
    case "int":
    case "double":
    case "verbatim":
      return r.text;
    case "bool":
      return r.value ? "true" : "false";
    case "error":
      return `(error) ${r.text}`;
    default:
      return cliText(r);
  }
}

/** A JSON object or array (worth pretty-printing), parsed; else `undefined`. */
export function jsonContainer(text: string): unknown {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return undefined;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
}

const LONG_TEXT = 120;
const LONG_BINARY = 64;

/** Fits on an Output line, as `redis-cli` would print it: no `Result N` tab. */
export function isTrivialReply(r: RedisReply): boolean {
  if (isAggregate(r)) return (r.kind === "map" ? r.entries.length : r.items.length) === 0;
  if (r.kind === "bulk") {
    if (r.value.binary) return byteLength(r.value) <= LONG_BINARY;
    return isShortText(r.value.text);
  }
  if (r.kind === "verbatim") return isShortText(r.text);
  return true;
}

const isShortText = (t: string) => t.length <= LONG_TEXT && !t.includes("\n") && jsonContainer(t) === undefined;

function elapsed(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

/** The Output line of a reply: `redis-cli`'s text for simple ones, a count for the rest. */
export function replySummary(r: RedisReply, ms: number | null): string {
  if (isTrivialReply(r)) return cliText(r);
  const t = elapsed(ms ?? 0);
  if (r.kind === "map") return `${r.entries.length} ${r.entries.length === 1 ? "entry" : "entries"} retrieved in ${t}`;
  if (r.kind === "array" || r.kind === "set")
    return `${r.items.length} ${r.items.length === 1 ? "item" : "items"} retrieved in ${t}`;
  const bytes = r.kind === "bulk" ? byteLength(r.value) : r.kind === "verbatim" ? encoder.encode(r.text).length : 0;
  return `${size(bytes)} retrieved in ${t}`;
}

// ---- layouts of a Result tab -------------------------------------------------------------

export type ReplyLayout =
  /** A string or a scalar. */
  | { kind: "text" }
  /** Scalars: index, value. */
  | { kind: "list"; columns: [string, string] }
  /** Key / value pairs (a map, `HGETALL`, `CONFIG GET`, `… WITHSCORES`). */
  | { kind: "pairs"; columns: [string, string]; rows: Array<[string | null, string | null]> }
  /** Nested collections. */
  | { kind: "tree" };

/** Commands whose flat array reply alternates names and values, and their column names. */
const PAIRED: Record<string, [string, string]> = {
  HGETALL: ["field", "value"],
  "CONFIG GET": ["parameter", "value"],
  "PUBSUB NUMSUB": ["channel", "subscribers"],
  "PUBSUB SHARDNUMSUB": ["shard channel", "subscribers"],
  ZPOPMIN: ["member", "score"],
  ZPOPMAX: ["member", "score"],
};

/** Commands pairing their reply with an option (`ZRANGE … WITHSCORES`, `HRANDFIELD … WITHVALUES`). */
const PAIRED_WITH: Record<string, [string, [string, string]]> = {
  WITHSCORES: ["Z", ["member", "score"]],
  WITHVALUES: ["HRANDFIELD", ["field", "value"]],
};

/** The command name words of an echoed command line (`CONFIG GET maxmemory` → `CONFIG GET`). */
function commandWords(text: string): string[] {
  return splitLine(text).words.map((w) => w.value.text.toUpperCase());
}

function pairColumns(text: string): [string, string] | null {
  const words = commandWords(text);
  const [a = "", b = ""] = words;
  const named = PAIRED[`${a} ${b}`] ?? PAIRED[a];
  if (named) return named;
  for (const w of words.slice(1)) {
    const p = PAIRED_WITH[w];
    if (p && a.startsWith(p[0])) return p[1];
  }
  return null;
}

const isScalar = (r: RedisReply) => !isAggregate(r);

/** How a reply of command `text` is laid out in its Result tab. */
export function replyLayout(r: RedisReply, text: string): ReplyLayout {
  if (r.kind === "map") {
    if (r.entries.every((e) => isScalar(e.key) && isScalar(e.value)))
      return {
        kind: "pairs",
        columns: ["key", "value"],
        rows: r.entries.map((e) => [cellText(e.key), cellText(e.value)]),
      };
    return { kind: "tree" };
  }
  if (r.kind !== "array" && r.kind !== "set") return { kind: "text" };
  const items = r.items;
  if (items.every(isScalar)) {
    const columns = r.kind === "array" ? pairColumns(text) : null;
    if (columns && items.length % 2 === 0) {
      const rows: Array<[string | null, string | null]> = [];
      for (let i = 0; i < items.length; i += 2) rows.push([cellText(items[i]!), cellText(items[i + 1]!)]);
      return { kind: "pairs", columns, rows };
    }
    return { kind: "list", columns: ["index", r.kind === "set" ? "member" : "value"] };
  }
  // RESP3 pairs: `[[member, score], …]`.
  const columns = pairColumns(text);
  if (columns && items.every((i) => i.kind === "array" && i.items.length === 2 && i.items.every(isScalar)))
    return {
      kind: "pairs",
      columns,
      rows: items.map((i) => {
        const [k, v] = (i as Extract<RedisReply, { kind: "array" }>).items as [RedisReply, RedisReply];
        return [cellText(k), cellText(v)];
      }),
    };
  return { kind: "tree" };
}
