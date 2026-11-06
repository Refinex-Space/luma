/**
 * Object catalogs of connection targets: every table, view, column, key, index, routine,
 * trigger and sequence (backend `db_catalog`), what Search Everywhere finds database objects
 * in. A target's saved catalog is read from disk without connecting (IDEA's introspection
 * cache); a connected target is introspected again once per session and after Refresh / DDL,
 * in the background.
 */
import { call, commands, type DbCatalog } from "@/platform/ipc";
import { splitTarget } from "./model";

const catalogs = new Map<string, DbCatalog>();
/** Targets introspected this session (their catalog is current). */
const fresh = new Set<string>();
const reads = new Map<string, Promise<void>>();
const introspections = new Map<string, Promise<void>>();
let version = 0;

/** Changes whenever a catalog does (results to recompute). */
export const catalogVersion = () => version;

export function catalogOf(target: string): DbCatalog | undefined {
  return catalogs.get(target);
}

/** Targets with a catalog in memory. */
export function catalogTargets(): string[] {
  return [...catalogs.keys()];
}

function store(target: string, c: DbCatalog | null) {
  if (!c) return;
  catalogs.set(target, c);
  version++;
}

/** Reads the saved catalog of `target` once (absent before its first introspection). */
export function readSavedCatalog(target: string): Promise<void> {
  if (catalogs.has(target)) return Promise.resolve();
  let p = reads.get(target);
  if (!p) {
    p = call(commands.dbCatalog(target, false))
      .then((c) => {
        if (!catalogs.has(target)) store(target, c);
      })
      .catch(() => undefined);
    reads.set(target, p);
  }
  return p;
}

/** Introspects connected `target` unless it already was this session; resolves when done (errors ignored). */
export function introspectCatalog(target: string): Promise<void> {
  if (fresh.has(target)) return Promise.resolve();
  let p = introspections.get(target);
  if (!p) {
    p = call(commands.dbCatalog(target, true))
      .then((c) => {
        store(target, c);
        fresh.add(target);
      })
      .catch(() => undefined)
      .finally(() => introspections.delete(target));
    introspections.set(target, p);
  }
  return p;
}

/**
 * The objects of `id` changed (Refresh, a DDL statement): its catalogs are introspected
 * again on the next search; a data source id covers all its databases.
 */
export function catalogStale(id: string) {
  const whole = !splitTarget(id).database;
  for (const t of [...fresh]) if (t === id || (whole && splitTarget(t).id === id)) fresh.delete(t);
}

/** Forgets the catalogs of data source `id` (removed, or moved to another server). */
export function dropCatalogs(id: string) {
  for (const t of [...catalogs.keys()])
    if (splitTarget(t).id === id) {
      catalogs.delete(t);
      fresh.delete(t);
      reads.delete(t);
      version++;
    }
}

/** Test reset. */
export function _resetCatalogs() {
  catalogs.clear();
  fresh.clear();
  reads.clear();
  introspections.clear();
  version++;
}
