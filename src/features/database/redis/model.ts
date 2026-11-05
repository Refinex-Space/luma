/**
 * Redis data sources, shared vocabulary of the Database feature's Redis parts (tree,
 * key editor, console, server info): targets, key display, value types and the
 * editor inputs that open them. Backend: `ide_db::redis` (`redis_*` commands).
 */
import type { RedisBytes } from "@/platform/ipc";
import type { EditorInput } from "@/workbench/contributions";

/** A Redis target: `<data source id>:<database index>` (the backend's `split_target`). */
export type RedisTarget = string;

export function redisTarget(id: string, db: number): RedisTarget {
  return `${id}:${db}`;
}

/** Data source id and database index of a target (`<id>` alone: database 0). */
export function splitRedisTarget(target: RedisTarget): { id: string; db: number } {
  const i = target.indexOf(":");
  if (i < 0) return { id: target, db: 0 };
  const db = Number(target.slice(i + 1));
  return { id: target.slice(0, i), db: Number.isInteger(db) && db >= 0 ? db : 0 };
}

/** How a key or value reads: its text, or `\xff\x00…` for binary (as `redis-cli` prints it). */
export function bytesLabel(b: RedisBytes): string {
  if (!b.binary) return b.text;
  return b.text.replace(/../g, (h) => `\\x${h}`);
}

/** A stable string id of a key (binary keys differ from text keys spelling the same hex). */
export const keyId = (b: RedisBytes) => (b.binary ? `\u0000${b.text}` : b.text);

export const textBytes = (text: string): RedisBytes => ({ text, binary: false });

/** Redis value types (`TYPE`), and modules' (`ReJSON-RL`). */
export type RedisKind = "string" | "hash" | "list" | "set" | "zset" | "stream" | "ReJSON-RL" | (string & {});

/** Badge of a value type: short label and its colour token (RedisInsight-like chips). */
export const KIND_META: Record<string, { label: string; short: string; color: string }> = {
  string: { label: "String", short: "STR", color: "var(--redis-string)" },
  hash: { label: "Hash", short: "HASH", color: "var(--redis-hash)" },
  list: { label: "List", short: "LIST", color: "var(--redis-list)" },
  set: { label: "Set", short: "SET", color: "var(--redis-set)" },
  zset: { label: "Sorted Set", short: "ZSET", color: "var(--redis-zset)" },
  stream: { label: "Stream", short: "STRM", color: "var(--redis-stream)" },
  "ReJSON-RL": { label: "JSON", short: "JSON", color: "var(--redis-json)" },
};

export function kindMeta(kind: string): { label: string; short: string; color: string } {
  return KIND_META[kind] ?? { label: kind, short: kind.slice(0, 4).toUpperCase(), color: "var(--redis-other)" };
}

/** `-1` (no expiry) / `-2` (gone) / milliseconds → `No limit`, `Expired`, `1d 3h`, `42s`. */
export function ttlLabel(ms: number): string {
  if (ms === -1) return "No limit";
  if (ms < 0) return "Expired";
  const s = Math.ceil(ms / 1000);
  const units: Array<[number, string]> = [
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
    [1, "s"],
  ];
  const parts: string[] = [];
  let rest = s;
  for (const [n, u] of units) {
    if (rest >= n) {
      parts.push(`${Math.floor(rest / n)}${u}`);
      rest %= n;
    }
    if (parts.length === 2) break;
  }
  return parts.join(" ") || "0s";
}

/** Bytes as `512 B`, `1.2 KB`, `3.4 MB`. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// ---- editor inputs -----------------------------------------------------------------------

/** The key editor tab: one key of one database. */
export const REDIS_KEY_KIND = "redis-key";

export interface RedisKeyRef {
  target: RedisTarget;
  key: RedisBytes;
}

export function redisKeyInput(target: RedisTarget, key: RedisBytes): EditorInput {
  const data: RedisKeyRef = { target, key };
  return { kind: REDIS_KEY_KIND, key: `${REDIS_KEY_KIND}:${target}:${keyId(key)}`, data };
}

export function redisKeyTitle(input: EditorInput): string {
  return bytesLabel((input.data as RedisKeyRef).key);
}

/** The server information tab of a data source. */
export const REDIS_INFO_KIND = "redis-info";

export interface RedisInfoRef {
  id: string;
}

export function redisInfoInput(id: string): EditorInput {
  const data: RedisInfoRef = { id };
  return { kind: REDIS_INFO_KIND, key: `${REDIS_INFO_KIND}:${id}`, data };
}

/** The Pub/Sub tab of a data source. */
export const REDIS_PUBSUB_KIND = "redis-pubsub";

export function redisPubSubInput(id: string): EditorInput {
  const data: RedisInfoRef = { id };
  return { kind: REDIS_PUBSUB_KIND, key: `${REDIS_PUBSUB_KIND}:${id}`, data };
}

/** The Redis Browser tab of one database: key list, the selected key's value, a command line. */
export const REDIS_BROWSER_KIND = "redis-browser";

export interface RedisBrowserRef {
  target: RedisTarget;
}

export function redisBrowserInput(target: RedisTarget): EditorInput {
  const data: RedisBrowserRef = { target };
  return { kind: REDIS_BROWSER_KIND, key: `${REDIS_BROWSER_KIND}:${target}`, data };
}
