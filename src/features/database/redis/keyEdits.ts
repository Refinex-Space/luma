/**
 * The Redis key editor's model, free of IPC: how a value page shows in the grid, which
 * cells can change, the pending edits of a hash / list / set / sorted set / stream as
 * the Redis commands one Submit runs (`MULTI` / `EXEC`), paging (Load More), and the
 * string editor's JSON / hex views.
 */
import type { RedisBytes, RedisPageRequest, RedisReply, RedisValuePage } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import type { Cell, PendingEdits } from "../model";
import { bytesLabel, keyId, textBytes } from "./model";

export type RedisCell = RedisBytes | null;
export type RedisRow = readonly RedisCell[];
/** One command: its name, then its arguments. */
export type RedisArgs = RedisBytes[];

/** Values shown as a table (`redis_value` rows). */
export const GRID_KINDS: ReadonlySet<string> = new Set(["hash", "list", "set", "zset", "stream"]);
/** Values shown whole (`redis_value`'s `value`). */
export const VALUE_KINDS: ReadonlySet<string> = new Set(["string", "ReJSON-RL"]);
/** Values whose members can be filtered with `MATCH`. */
export const PATTERN_KINDS: ReadonlySet<string> = new Set(["hash", "set", "zset"]);
/** Values that page in either order (`descending`). */
export const ORDERED_KINDS: ReadonlySet<string> = new Set(["zset", "stream"]);

/** How a cell shows in the grid: text, `\xff…` for binary. */
export const cellText = (b: RedisCell): Cell => (b ? bytesLabel(b) : null);

export const sameBytes = (a: RedisBytes, b: RedisBytes) => a.text === b.text && !!a.binary === !!b.binary;

/** A list's index and a stream entry's id identify rows: never edited. */
export function isKeyColumn(kind: string, col: number): boolean {
  return (kind === "list" || kind === "stream") && col === 0;
}

/**
 * Whether cell (`row`, `col`) can change: not a key column, not a binary value (its
 * text is a hex rendering), not an existing stream entry (entries are immutable).
 */
export function cellEditable(kind: string, rows: readonly RedisRow[], row: number, col: number): boolean {
  if (isKeyColumn(kind, col)) return false;
  if (row >= rows.length) return true;
  if (kind === "stream") return false;
  return !rows[row]?.[col]?.binary;
}

const SCORE = /^[+-]?(inf|(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?)$/i;

/** A `ZADD` score: a number, `inf`, `+inf` or `-inf`. */
export const isScore = (text: string) => SCORE.test(text.trim());

/** A value no list holds: deleted list rows become it, then `LREM` drops them. */
export function deleteSentinel(): string {
  return `__luma_deleted_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}__`;
}

export type KeyEditResult = { ok: true; commands: RedisArgs[] } | { ok: false; error: string };

/**
 * The commands writing `edits` of the loaded `rows` (`columns` as `redis_value` names
 * them) of `key` of type `kind`, in order:
 * - hash: `HDEL` (deleted fields, renamed fields' old names), then `HSET` (changes, new rows);
 * - list: `LSET` changes, `LSET` deleted rows to `sentinel` + `LREM key 0 sentinel`, `RPUSH` new rows;
 * - set: `SREM` (deleted, changed members' old values), then `SADD`;
 * - zset: `ZREM` (deleted, renamed members' old names), then `ZADD score member`;
 * - stream: `XDEL` deleted entries, `XADD key * field value…` per new row.
 * Removals come first, so swapping two names keeps both.
 */
export function keyEditCommands(
  kind: string,
  key: RedisBytes,
  columns: readonly string[],
  rows: readonly RedisRow[],
  edits: PendingEdits,
  sentinel: string = deleteSentinel(),
): KeyEditResult {
  const fail = (error: string): KeyEditResult => ({ ok: false, error });
  const loaded = (r: number, c: number): RedisBytes => rows[r]?.[c] ?? textBytes("");
  const deleted = [...edits.deletes].filter((r) => r < rows.length).sort((a, b) => a - b);
  const updates = [...edits.updates]
    .filter(([r, changes]) => r < rows.length && !edits.deletes.has(r) && changes.size > 0)
    .sort(([a], [b]) => a - b);
  // A changed binary cell would write its `\xff` rendering: refuse.
  for (const [r, changes] of updates)
    for (const name of changes.keys()) {
      const c = columns.indexOf(name);
      if (c >= 0 && !isKeyColumn(kind, c) && rows[r]?.[c]?.binary) return fail(tx("Binary values cannot be edited"));
    }
  /** The cell's value after the edits: the new text, else the loaded bytes. */
  const edited = (r: number, changes: ReadonlyMap<string, Cell>, c: number): RedisBytes => {
    const name = columns[c]!;
    return changes.has(name) ? textBytes(changes.get(name) ?? "") : loaded(r, c);
  };
  const isChanged = (r: number, changes: ReadonlyMap<string, Cell>, c: number) =>
    changes.has(columns[c]!) && !sameBytes(edited(r, changes, c), loaded(r, c));
  const commands: RedisArgs[] = [];
  const add = (name: string, args: RedisBytes[]) => {
    if (args.length) commands.push([textBytes(name), key, ...args]);
  };

  switch (kind) {
    case "hash": {
      const removed = deleted.map((r) => loaded(r, 0));
      const set: RedisBytes[] = [];
      for (const [r, changes] of updates) {
        if (!isChanged(r, changes, 0) && !isChanged(r, changes, 1)) continue;
        if (isChanged(r, changes, 0)) removed.push(loaded(r, 0));
        set.push(edited(r, changes, 0), edited(r, changes, 1));
      }
      for (const row of edits.inserts) {
        const field = row.get(columns[0]!);
        if (field == null) return fail(tx("Enter a field name for each new row"));
        set.push(textBytes(field), textBytes(row.get(columns[1]!) ?? ""));
      }
      add("HDEL", removed);
      add("HSET", set);
      break;
    }
    case "list": {
      const index = (r: number) => loaded(r, 0);
      for (const [r, changes] of updates)
        if (isChanged(r, changes, 1)) commands.push([textBytes("LSET"), key, index(r), edited(r, changes, 1)]);
      for (const r of deleted) commands.push([textBytes("LSET"), key, index(r), textBytes(sentinel)]);
      if (deleted.length) commands.push([textBytes("LREM"), key, textBytes("0"), textBytes(sentinel)]);
      add(
        "RPUSH",
        edits.inserts.map((row) => textBytes(row.get(columns[1]!) ?? "")),
      );
      break;
    }
    case "set": {
      const removed = deleted.map((r) => loaded(r, 0));
      const added: RedisBytes[] = [];
      for (const [r, changes] of updates) {
        if (!isChanged(r, changes, 0)) continue;
        removed.push(loaded(r, 0));
        added.push(edited(r, changes, 0));
      }
      for (const row of edits.inserts) {
        const member = row.get(columns[0]!);
        if (member == null) return fail(tx("Enter a member for each new row"));
        added.push(textBytes(member));
      }
      add("SREM", removed);
      add("SADD", added);
      break;
    }
    case "zset": {
      const removed = deleted.map((r) => loaded(r, 0));
      const added: RedisBytes[] = [];
      const score = (text: string | null | undefined): RedisBytes | string => {
        if (text == null || !text.trim()) return tx("Enter a score for each new row");
        return isScore(text) ? textBytes(text.trim()) : tx`Score is not a number: ${text}`;
      };
      for (const [r, changes] of updates) {
        const memberChanged = isChanged(r, changes, 0);
        if (!memberChanged && !isChanged(r, changes, 1)) continue;
        let s: RedisBytes | string = loaded(r, 1);
        if (isChanged(r, changes, 1)) s = score(changes.get(columns[1]!));
        if (typeof s === "string") return fail(s);
        if (memberChanged) removed.push(loaded(r, 0));
        added.push(s, edited(r, changes, 0));
      }
      for (const row of edits.inserts) {
        const member = row.get(columns[0]!);
        if (member == null) return fail(tx("Enter a member for each new row"));
        const s = score(row.get(columns[1]!));
        if (typeof s === "string") return fail(s);
        added.push(s, textBytes(member));
      }
      add("ZREM", removed);
      add("ZADD", added);
      break;
    }
    case "stream": {
      add(
        "XDEL",
        deleted.map((r) => loaded(r, 0)),
      );
      for (const row of edits.inserts) {
        const fields = columns.slice(1).flatMap((name) => {
          const v = row.get(name);
          return v == null || v === "" ? [] : [textBytes(name), textBytes(v)];
        });
        if (!fields.length) return fail(tx("Enter at least one field value for each new entry"));
        commands.push([textBytes("XADD"), key, textBytes("*"), ...fields]);
      }
      break;
    }
    default:
      return fail(tx`Values of type ${kind} cannot be edited`);
  }
  return { ok: true, commands };
}

/** Errors among `EXEC`'s replies (Redis runs the other commands regardless). */
export function replyErrors(replies: readonly RedisReply[]): string[] {
  return replies.flatMap((r) => (r.kind === "error" ? [r.text] : []));
}

// ---- paging ----------------------------------------------------------------------------

/** The pages of a value loaded so far (Load More appends). */
export interface LoadedValue {
  kind: string;
  columns: string[];
  rows: RedisRow[];
  /** Where the next page starts; `null`: everything is loaded. */
  cursor: string | null;
  total: number | null;
}

export function firstPage(page: RedisValuePage): LoadedValue {
  return { kind: page.kind, columns: page.columns, rows: page.rows, cursor: page.cursor, total: page.total };
}

/**
 * `prev` with `page` appended: stream pages may bring new fields (columns are united);
 * `SCAN` may return a hash field or member twice (it is listed once).
 */
export function appendPage(prev: LoadedValue, page: RedisValuePage): LoadedValue {
  const columns = [...prev.columns];
  for (const c of page.columns) if (!columns.includes(c)) columns.push(c);
  const remap = (from: readonly string[]) => (row: RedisRow) =>
    columns.map((c) => {
      const i = from.indexOf(c);
      return i < 0 ? null : (row[i] ?? null);
    });
  const before = columns.length === prev.columns.length ? prev.rows : prev.rows.map(remap(prev.columns));
  let added = page.rows.map(remap(page.columns));
  if (PATTERN_KINDS.has(prev.kind)) {
    const seen = new Set(before.map((r) => (r[0] ? keyId(r[0]) : "")));
    added = added.filter((r) => {
      const id = r[0] ? keyId(r[0]) : "";
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }
  return { ...prev, columns, rows: [...before, ...added], cursor: page.cursor, total: page.total ?? prev.total };
}

export interface PageOptions {
  count: number;
  /** `MATCH` pattern (hash, set, sorted set); empty: all. */
  pattern: string;
  descending: boolean;
}

/** The request of the page at `cursor` (`null`: the first). Lists and unfiltered sorted sets page by offset. */
export function pageRequest(kind: string, options: PageOptions, cursor: string | null): RedisPageRequest {
  const pattern = PATTERN_KINDS.has(kind) && options.pattern.trim() ? options.pattern.trim() : null;
  const base: RedisPageRequest = {
    count: options.count,
    pattern,
    descending: ORDERED_KINDS.has(kind) && options.descending,
    cursor: null,
    offset: 0,
  };
  if (cursor === null) return base;
  const byOffset = kind === "list" || (kind === "zset" && !pattern);
  return byOffset ? { ...base, offset: Number(cursor) || 0 } : { ...base, cursor };
}

// ---- strings -----------------------------------------------------------------------------

/** Save of a string (`SET … KEEPTTL`: the time to live stays) or a JSON value (`JSON.SET … $`). */
export function saveValueCommand(kind: string, key: RedisBytes, text: string): RedisArgs {
  return kind === "ReJSON-RL"
    ? [textBytes("JSON.SET"), key, textBytes("$"), textBytes(text)]
    : [textBytes("SET"), key, textBytes(text), textBytes("KEEPTTL")];
}

/** `null` for valid JSON, else the parser's message. */
export function jsonError(text: string): string | null {
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Whether a string value reads as a JSON object or array (opens in the JSON view). */
export function looksLikeJson(text: string): boolean {
  return /^\s*[[{]/.test(text) && jsonError(text) === null;
}

/**
 * Valid JSON re-spaced, its tokens kept as written (big numbers keep their digits, which
 * `JSON.parse` would round): `indent` 0 writes it compact.
 */
export function formatJson(text: string, indent = 2): string {
  let out = "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  const newline = () => (indent ? "\n" + " ".repeat(depth * indent) : "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    switch (ch) {
      case '"':
        inString = true;
        out += ch;
        break;
      case "{":
      case "[": {
        // `{}` / `[]` stay on one line.
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j]!)) j++;
        if (text[j] === (ch === "{" ? "}" : "]")) {
          out += ch + text[j];
          i = j;
          break;
        }
        depth++;
        out += ch + newline();
        break;
      }
      case "}":
      case "]":
        depth--;
        out += newline() + ch;
        break;
      case ",":
        out += "," + newline();
        break;
      case ":":
        out += indent ? ": " : ":";
        break;
      default:
        if (!/\s/.test(ch)) out += ch;
    }
  }
  return out;
}

/** The string editor's text. */
export interface ValueDraft {
  text: string;
  /** Shown as formatted JSON. */
  json: boolean;
  /** Typed into since loaded. */
  edited: boolean;
}

/** A loaded value's draft: JSON values (and strings reading as JSON) formatted. */
export function initialDraft(kind: string, value: RedisBytes | null): ValueDraft {
  const text = value && !value.binary ? value.text : "";
  const json = kind === "ReJSON-RL" || looksLikeJson(text);
  return { text: json && jsonError(text) === null ? formatJson(text) : text, json, edited: false };
}

/**
 * What Save writes for `draft` of `original` (`pretty`: `formatJson(original)`): its text;
 * from the JSON view the original when unchanged, else the JSON compact if the original
 * was (as shown when it was not). `null`: invalid JSON (a JSON value must stay JSON).
 */
export function draftValue(
  kind: string,
  draft: ValueDraft,
  original: string,
  pretty = formatJson(original),
): string | null {
  if (!draft.json) return kind === "ReJSON-RL" && jsonError(draft.text) !== null ? null : draft.text;
  if (draft.text === pretty) return original;
  if (jsonError(draft.text) !== null) return null;
  return original.includes("\n") ? draft.text : formatJson(draft.text, 0);
}

/** The bytes of a value: its hex digits for binary, else its UTF-8 text. */
export function bytesOf(b: RedisBytes): Uint8Array {
  if (!b.binary) return new TextEncoder().encode(b.text);
  const hex = b.text.startsWith("0x") ? b.text.slice(2) : b.text;
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Bytes a hex view shows at most. */
export const HEX_LIMIT = 256 * 1024;

/** `hexdump -C`: offset, 16 bytes in hex, their printable ASCII. `rest`: bytes beyond `limit`. */
export function hexDump(bytes: Uint8Array, limit = HEX_LIMIT): { text: string; rest: number } {
  const shown = Math.min(bytes.length, limit);
  const lines: string[] = [];
  for (let at = 0; at < shown; at += 16) {
    const chunk = bytes.subarray(at, Math.min(at + 16, shown));
    let hex = "";
    let ascii = "";
    for (let i = 0; i < 16; i++) {
      if (i === 8) hex += " ";
      const b = chunk[i];
      hex += b === undefined ? "   " : b.toString(16).padStart(2, "0") + " ";
      if (b !== undefined) ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
    }
    lines.push(`${at.toString(16).padStart(8, "0")}  ${hex} |${ascii}|`);
  }
  return { text: lines.join("\n"), rest: bytes.length - shown };
}
