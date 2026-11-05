/**
 * Redis browsing state: each server's keyspace (databases and key counts), and per
 * database the keys found so far by `SCAN` (a filter pattern and type, a cursor to load
 * more from), once for the Database tool window's tree and once for the Redis Browser
 * tab, so filtering one leaves the other be. Also the Browser's selected key per
 * database, and the Redis dialogs (new key, rename, TTL, delete matching), shown by
 * `RedisDialogs`.
 */
import { create } from "zustand";
import {
  call,
  commands,
  isCancelled,
  nextRequestId,
  type RedisBytes,
  type RedisKeyEntry,
  type RedisKeyspace,
} from "@/platform/ipc";
import { editorService, notifications } from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";
import { tx } from "@/platform/i18n";
import { bindConsole, sourceById, useDatabase, withConnection, type Loaded } from "../store";
import {
  bytesLabel,
  keyId,
  redisBrowserInput,
  redisInfoInput,
  redisKeyInput,
  redisPubSubInput,
  redisTarget,
  splitRedisTarget,
  type RedisTarget,
} from "./model";
import { bumpReload, folderNodeKey, setExpanded, useBrowserUi } from "./browser/state";

/** Keys a tree page loads at once (the backend scans until it found this many). */
export const KEY_PAGE = 500;

export interface DbKeys {
  /** `MATCH` pattern (`*` when unfiltered). */
  pattern: string;
  /** `SCAN … TYPE` filter (`null`: every type). */
  type: string | null;
  keys: RedisKeyEntry[];
  /** When the page was read (`Date.now()`): TTLs count down from it. */
  at: number;
  cursor: string;
  done: boolean;
  loading: boolean;
  error?: string;
}

export type RedisDialog =
  | { kind: "newKey"; target: RedisTarget; prefix: string }
  | { kind: "rename"; target: RedisTarget; key: RedisBytes }
  | { kind: "ttl"; target: RedisTarget; key: RedisBytes; ttlMs: number }
  | { kind: "filter"; target: RedisTarget }
  | { kind: "deleteMatching"; target: RedisTarget; pattern: string };

/** The two key lists of a database: the tool window's tree and the Redis Browser's. */
export type KeyList = "tree" | "browser";

interface RedisState {
  /** Data source id → its server's databases. */
  keyspace: Record<string, Loaded<RedisKeyspace>>;
  /** Target → keys of that database loaded so far (the tool window's tree). */
  keys: Record<RedisTarget, DbKeys>;
  /** Target → keys the Redis Browser of that database loaded so far. */
  browserKeys: Record<RedisTarget, DbKeys>;
  /** Target → the key the Redis Browser shows. */
  browserKey: Record<RedisTarget, RedisBytes | null>;
  /** Target → a key the Browser should scroll to (bumped by `openBrowser`, renames). */
  reveal: Record<RedisTarget, { key: RedisBytes; seq: number }>;
  dialog: RedisDialog | null;
}

export const useRedis = create<RedisState>(() => ({
  keyspace: {},
  keys: {},
  browserKeys: {},
  browserKey: {},
  reveal: {},
  dialog: null,
}));

const field = (list: KeyList) => (list === "tree" ? "keys" : "browserKeys");

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function isRedisSource(id: string | null | undefined): boolean {
  return sourceById(id)?.driver === "redis";
}

/** Key separator of a Redis data source's tree (`:` by default). */
export function separatorOf(id: string): string {
  return sourceById(id)?.options?.keySeparator || ":";
}

export async function loadKeyspace(id: string): Promise<void> {
  useRedis.setState((s) => ({ keyspace: { ...s.keyspace, [id]: { status: "loading" } } }));
  try {
    const value = await withConnection(id, () => call(commands.redisKeyspace(id)));
    useRedis.setState((s) => ({ keyspace: { ...s.keyspace, [id]: { status: "ok", value } } }));
  } catch (e) {
    useRedis.setState((s) => ({ keyspace: { ...s.keyspace, [id]: { status: "error", message: message(e) } } }));
  }
}

/** The databases a data source's tree lists: with keys, the configured one, or all (Options). */
export function shownDatabases(id: string, keyspace: RedisKeyspace): RedisKeyspace["databases"] {
  const source = sourceById(id);
  const configured = Number(source?.database?.trim() || 0);
  if (source?.options?.showEmptyDatabases) return keyspace.databases;
  return keyspace.databases.filter((d) => (d.keys ?? 0) > 0 || d.index === configured);
}

/** Most keys one reload reads again (the backend's `MAX_SCAN_KEYS`). */
const MAX_RELOAD = 10_000;
/** Scans of a list in flight: a newer one wins over an older one's late answer. */
const scans = new Map<string, number>();

/**
 * Loads the first page of keys of `target` (with `pattern` / `type`), or the next one
 * (`more`). Reloading the same filter keeps the keys shown until the new ones arrive and
 * reads as many as were loaded, so a refresh neither flickers nor shrinks the list.
 */
export async function loadKeys(
  target: RedisTarget,
  opts: { pattern?: string; type?: string | null; more?: boolean; list?: KeyList } = {},
): Promise<void> {
  const list = opts.list ?? "tree";
  const f = field(list);
  const prev = useRedis.getState()[f][target];
  const pattern = opts.pattern ?? prev?.pattern ?? "*";
  const type = opts.type !== undefined ? opts.type : (prev?.type ?? null);
  const same = !!prev && prev.pattern === pattern && prev.type === type;
  const more = !!opts.more && same && !prev.done;
  if (prev?.loading && more) return;
  const id = `${list}|${target}`;
  const seq = (scans.get(id) ?? 0) + 1;
  scans.set(id, seq);
  const kept = same ? prev.keys : [];
  const base: DbKeys = more
    ? prev!
    : { pattern, type, keys: kept, at: prev?.at ?? 0, cursor: "0", done: false, loading: true };
  const patch = (p: Partial<DbKeys>) => {
    if (scans.get(id) !== seq) return;
    useRedis.setState((s) => ({ [f]: { ...s[f], [target]: { ...(s[f][target] ?? base), ...p } } }));
  };
  patch({ ...base, loading: true, error: undefined });
  const limit = more ? KEY_PAGE : Math.min(MAX_RELOAD, Math.max(KEY_PAGE, kept.length));
  try {
    const page = await withConnection(target, () =>
      call(commands.redisScan(target, pattern, type, more ? base.cursor : "0", limit)),
    );
    const at = Date.now();
    if (!more) return patch({ keys: page.keys, at, cursor: page.cursor, done: page.done, loading: false });
    const seen = new Set(base.keys.map((k) => keyId(k.key)));
    const fresh = page.keys.filter((k) => !seen.has(keyId(k.key)));
    patch({ keys: [...base.keys, ...fresh], at, cursor: page.cursor, done: page.done, loading: false });
  } catch (e) {
    patch({ loading: false, error: message(e) });
  }
}

/** Re-reads a data source (keyspace, and the keys of the databases already listed). */
export async function refreshRedis(id: string): Promise<void> {
  const { id: source } = splitRedisTarget(id);
  const s = useRedis.getState();
  const of = (m: Record<string, DbKeys>) => Object.keys(m).filter((t) => splitRedisTarget(t).id === source);
  await loadKeyspace(source);
  await Promise.all([
    ...of(s.keys).map((t) => loadKeys(t)),
    ...of(s.browserKeys).map((t) => loadKeys(t, { list: "browser" })),
  ]);
}

/** Forgets what was loaded of a data source (disconnect, removal). */
export function forgetRedis(id: string) {
  const other = <V>(m: Record<string, V>) =>
    Object.fromEntries(Object.entries(m).filter(([t]) => splitRedisTarget(t).id !== id));
  useRedis.setState((s) => ({
    keyspace: Object.fromEntries(Object.entries(s.keyspace).filter(([k]) => k !== id)),
    keys: other(s.keys),
    browserKeys: other(s.browserKeys),
  }));
}

/** Keys changed (an editor, a dialog, the command line): the key lists and counts follow. */
export function keyChanged(target: RedisTarget) {
  const { id } = splitRedisTarget(target);
  void loadKeyspace(id);
  const s = useRedis.getState();
  if (s.keys[target]) void loadKeys(target);
  if (s.browserKeys[target]) void loadKeys(target, { list: "browser" });
}

/** A key's value or TTL changed outside the views showing it (a dialog): they reload too. */
export function valueChanged(target: RedisTarget) {
  keyChanged(target);
  bumpReload(target);
}

/** Drops `keys` from both key lists of `target` (deleted, renamed away). */
function dropKeys(target: RedisTarget, keys: readonly RedisBytes[]) {
  const gone = new Set(keys.map(keyId));
  const without = (k: DbKeys | undefined) => k && { ...k, keys: k.keys.filter((e) => !gone.has(keyId(e.key))) };
  useRedis.setState((s) => {
    const shown = s.browserKey[target];
    return {
      keys: s.keys[target] ? { ...s.keys, [target]: without(s.keys[target])! } : s.keys,
      browserKeys: s.browserKeys[target]
        ? { ...s.browserKeys, [target]: without(s.browserKeys[target])! }
        : s.browserKeys,
      browserKey: shown && gone.has(keyId(shown)) ? { ...s.browserKey, [target]: null } : s.browserKey,
    };
  });
}

/** Shows `key` (or nothing) in the Redis Browser of `target`. */
export function selectBrowserKey(target: RedisTarget, key: RedisBytes | null) {
  useRedis.setState((s) => ({ browserKey: { ...s.browserKey, [target]: key } }));
}

let revealSeq = 0;

/** Selects `key` in the Browser of `target` and scrolls the key list to it (its folders opened). */
export function revealBrowserKey(target: RedisTarget, key: RedisBytes) {
  const separator = separatorOf(splitRedisTarget(target).id);
  if (!key.binary && separator) {
    const parts = key.text.split(separator);
    const open = new Set(useBrowserUi.getState().expanded[target] ?? []);
    const before = open.size;
    for (let i = 1; i < parts.length; i++) open.add(folderNodeKey(parts.slice(0, i).join(separator) + separator));
    if (open.size !== before) setExpanded(target, open);
  }
  useRedis.setState((s) => ({
    browserKey: { ...s.browserKey, [target]: key },
    reveal: { ...s.reveal, [target]: { key, seq: ++revealSeq } },
  }));
}

/** A key was renamed: a Browser showing it follows to the new name. */
export function keyRenamed(target: RedisTarget, from: RedisBytes, to: RedisBytes) {
  const shown = useRedis.getState().browserKey[target];
  if (shown && keyId(shown) === keyId(from)) revealBrowserKey(target, to);
  keyChanged(target);
}

/** Opens the Redis Browser of `target` (one tab per database), showing `key` if given. */
export function openBrowser(target: RedisTarget, key?: RedisBytes) {
  if (key) revealBrowserKey(target, key);
  void editorService().openInput(redisBrowserInput(target), { focus: true });
}

/** Opens `key` where keys open: its database's Redis Browser. */
export function openKey(target: RedisTarget, key: RedisBytes) {
  openBrowser(target, key);
}

/** Opens `key` in a tab of its own (the key editor). */
export function openKeyTab(target: RedisTarget, key: RedisBytes) {
  void editorService().openInput(redisKeyInput(target, key), { focus: true });
}

export function openServerInfo(id: string) {
  void editorService().openInput(redisInfoInput(splitRedisTarget(id).id), { focus: true });
}

export function openPubSub(id: string) {
  void editorService().openInput(redisPubSubInput(splitRedisTarget(id).id), { focus: true });
}

export const openRedisDialog = (dialog: RedisDialog) => useRedis.setState({ dialog });
export const closeRedisDialog = () => useRedis.setState({ dialog: null });

function fail(title: string, e: unknown) {
  if (!isCancelled(e)) notifications().notify({ level: "error", title, body: message(e) });
}

/** Runs one command on `target`; notifies and returns false on error. */
export async function redisRun(target: RedisTarget, args: RedisBytes[], title: string): Promise<boolean> {
  try {
    await withConnection(target, () => call(commands.redisCommand(target, args)));
    return true;
  } catch (e) {
    fail(title, e);
    return false;
  }
}

const text = (t: string): RedisBytes => ({ text: t, binary: false });

export async function deleteKey(target: RedisTarget, key: RedisBytes): Promise<boolean> {
  const ok = await confirm({
    title: "Delete Key",
    message: tx`Delete key '${bytesLabel(key)}' from database ${splitRedisTarget(target).db}? This cannot be undone.`,
    ok: "Delete",
  });
  if (!ok || !(await redisRun(target, [text("UNLINK"), key], "Cannot delete the key"))) return false;
  dropKeys(target, [key]);
  void loadKeyspace(splitRedisTarget(target).id);
  return true;
}

/** Deletes several keys (one confirmation, one `UNLINK`). */
export async function deleteKeys(target: RedisTarget, keys: readonly RedisBytes[]): Promise<boolean> {
  if (keys.length === 1) return deleteKey(target, keys[0]!);
  if (!keys.length) return false;
  const n = keys.length;
  const db = splitRedisTarget(target).db;
  const ok = await confirm({
    title: "Delete Keys",
    message: tx`Delete ${n} keys from database ${db}? This cannot be undone.`,
    ok: "Delete",
  });
  if (!ok || !(await redisRun(target, [text("UNLINK"), ...keys], "Cannot delete the keys"))) return false;
  dropKeys(target, keys);
  void loadKeyspace(splitRedisTarget(target).id);
  return true;
}

export async function flushDatabase(target: RedisTarget): Promise<void> {
  const { id, db } = splitRedisTarget(target);
  const name = sourceById(id)?.name ?? id;
  const ok = await confirm({
    title: "Flush Database",
    message: tx`Delete every key of database ${db} of ${name}? This cannot be undone.`,
    ok: "Flush",
  });
  if (ok && (await redisRun(target, [text("FLUSHDB")], "Cannot flush the database"))) keyChanged(target);
}

/** Deletes the keys matching `pattern` (the tree's folder action), cancellable. */
export async function deleteMatching(target: RedisTarget, pattern: string): Promise<number | null> {
  const request = nextRequestId();
  try {
    const n = await withConnection(target, () => call(commands.redisDeleteMatching(request, target, pattern)));
    notifications().notify({ level: "info", title: tx`${n} keys deleted`, body: pattern, key: "redis-delete" });
    keyChanged(target);
    return n;
  } catch (e) {
    fail("Cannot delete the keys", e);
    return null;
  }
}

/** Targets of the databases of a source (`<id>:<n>`), for pickers. */
export function databaseTargets(id: string): Array<{ target: RedisTarget; db: number; keys: number }> {
  const ks = useRedis.getState().keyspace[id];
  const dbs = ks?.status === "ok" ? ks.value.databases : [];
  return dbs.map((d) => ({ target: redisTarget(id, d.index), db: d.index, keys: d.keys ?? 0 }));
}

// Disconnecting a data source forgets its keys.
useDatabase.subscribe((s, prev) => {
  if (s.connected === prev.connected) return;
  for (const id of Object.keys(useRedis.getState().keyspace))
    if (![...s.connected].some((t) => t === id || t.startsWith(`${id}:`))) forgetRedis(id);
});

/** Opens the console of the data source of `target` (one per data source), on that database. */
export async function openRedisConsoleOf(target: RedisTarget): Promise<void> {
  const { id, db } = splitRedisTarget(target);
  try {
    const path = await call(commands.redisConsolePath(id));
    // A data source id alone: the database the console was on, else the configured one.
    const bound = useDatabase.getState().consoles[path];
    const next = target.includes(":")
      ? target
      : (bound ?? redisTarget(id, Number(sourceById(id)?.database?.trim() || db)));
    bindConsole(path, next);
    await editorService().openFile(path, { focus: true });
  } catch (e) {
    fail("Cannot open the Redis console", e);
  }
}
