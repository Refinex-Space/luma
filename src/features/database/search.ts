/**
 * Database objects in Search Everywhere (IDEA's database symbol contributor): the tables,
 * views, columns, keys, indexes, routines, triggers and sequences of the data sources'
 * catalogs (`./catalog`), the Redis keys the tree loaded and the Elasticsearch indices,
 * data streams and aliases. The Schemas tab's choice and object filter apply as in the tree.
 * Enter selects the object in the Database tool window; ⌥↵ offers Edit Data / Go to DDL.
 */
import type { DataSource, DbCatalog, DbCatalogKind, DbCatalogObject, DbTableKind } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import type { DatabaseSearchItem, DatabaseSearchResult } from "@/workbench/contributions";
import { matchText } from "@/features/search/common/rank";
import { catalogOf, introspectCatalog, readSavedCatalog } from "./catalog";
import { passesObjectFilter, shownNames, targetOf } from "./model";
import {
  connectedTargets,
  loadSources,
  openDdl,
  openObjectDdl,
  revealInTree,
  revealKey,
  revealSchemaChild,
  targetLabel,
  useDatabase,
} from "./store";
import { openTableData } from "./treeActions";
import { bytesLabel, keyId, kindMeta, redisTarget, splitRedisTarget } from "./redis/model";
import { openKey, separatorOf, useRedis } from "./redis/store";
import { openDiscover, showsHidden, useElastic } from "./elastic/store";

const ICONS: Record<DbCatalogKind, string> = {
  table: "db-table",
  view: "db-view",
  materializedView: "db-matview",
  column: "db-column",
  primaryKey: "db-key",
  foreignKey: "db-foreign-key",
  index: "db-index",
  uniqueIndex: "db-index",
  function: "db-routine",
  procedure: "db-routine",
  trigger: "db-trigger",
  sequence: "db-sequence",
};

/** Ties: tables before routines before columns before keys. */
const KIND_RANK: Record<DbCatalogKind, number> = {
  table: 0,
  view: 0,
  materializedView: 0,
  function: 1,
  procedure: 1,
  sequence: 1,
  column: 2,
  primaryKey: 3,
  foreignKey: 3,
  index: 3,
  uniqueIndex: 3,
  trigger: 3,
};

const TABLE_KINDS: Partial<Record<DbCatalogKind, DbTableKind>> = {
  table: "table",
  view: "view",
  materializedView: "materializedView",
};

interface Hit {
  score: number;
  rank: number;
  name: string;
  /** Built for the results shown only. */
  build: (indices: number[]) => DatabaseSearchItem;
  indices: number[];
}

/**
 * `query` against `name`; a dotted query (`luma.orders`, `orders.id`) against the
 * qualified name, its highlight kept on the name. Word-aligned, as IDEA's name matcher.
 */
export function matchObject(
  name: string,
  qualified: string,
  query: string,
): { score: number; indices: number[] } | null {
  if (!query.includes(".")) return matchText(name, query, { wordAligned: true });
  const hit = matchText(qualified, query, { wordAligned: true });
  if (!hit) return null;
  const off = qualified.length - name.length;
  return { score: hit.score, indices: hit.indices.filter((i) => i >= off).map((i) => i - off) };
}

/** Whether `name` can match at all: every query letter occurs in it (a cheap filter over large catalogs). */
function mayMatch(lower: string, letters: readonly string[]): boolean {
  let from = 0;
  for (const c of letters) {
    const i = lower.indexOf(c, from);
    if (i < 0) return false;
    from = i + 1;
  }
  return true;
}

/** Objects of a catalog the tree shows: the Schemas tab's schemas, the object filter's tables and routines. */
export function shownObjects(source: DataSource, catalog: DbCatalog): DbCatalogObject[] {
  return searchable(source, catalog).objects;
}

interface Searchable {
  /** The Schemas tab's choice it was built for. */
  sig: string;
  objects: DbCatalogObject[];
  lower: string[];
}

/** Shown objects and their lower-case names, per catalog (rebuilt when the Schemas tab changes). */
const searchables = new WeakMap<DbCatalog, Searchable>();

function searchable(source: DataSource, catalog: DbCatalog): Searchable {
  const intro = source.introspection;
  const sig = JSON.stringify([intro?.allSchemas, intro?.schemas, intro?.objectFilter]);
  const cached = searchables.get(catalog);
  if (cached?.sig === sig) return cached;
  const schemas = new Set(shownNames(catalog.schemas, intro?.allSchemas, intro?.schemas));
  const filter = intro?.objectFilter;
  const objects = catalog.objects.filter(
    (o) => schemas.has(o.schema) && (!filter || passesObjectFilter(o.table || o.name, filter)),
  );
  const s = { sig, objects, lower: objects.map((o) => o.name.toLowerCase()) };
  searchables.set(catalog, s);
  return s;
}

function sqlActions(target: string, o: DbCatalogObject): DatabaseSearchItem["actions"] {
  const table = o.table || (TABLE_KINDS[o.kind] ? o.name : null);
  const kind = o.kind;
  switch (kind) {
    case "function":
    case "procedure":
    case "trigger":
    case "sequence":
      return [{ label: tx("Go to DDL"), run: () => void openObjectDdl(target, o.schema, kind, o.name) }];
    default:
      return table
        ? [
            { label: tx("Edit Data"), run: () => openTableData(target, o.schema, table) },
            { label: tx("Go to DDL"), run: () => void openDdl(target, o.schema, table) },
          ]
        : [];
  }
}

/** Selects a catalog object in the Database tool window. */
export function revealObject(target: string, o: DbCatalogObject, catalog: DbCatalog | undefined): Promise<void> {
  const tableKind = (name: string): DbTableKind => {
    const t = catalog?.objects.find((x) => !x.table && x.schema === o.schema && x.name === name && TABLE_KINDS[x.kind]);
    return (t && TABLE_KINDS[t.kind]) ?? "table";
  };
  switch (o.kind) {
    case "table":
    case "view":
    case "materializedView":
      return revealInTree(target, o.schema, o.name, TABLE_KINDS[o.kind]!);
    case "column":
      return revealInTree(target, o.schema, o.table, tableKind(o.table), o.name);
    case "primaryKey":
      return revealInTree(target, o.schema, o.table, tableKind(o.table), {
        group: "keys",
        leaf: (d) => (d.columns.some((c) => c.primaryKey) ? "pk" : null),
      });
    case "foreignKey":
      return revealInTree(target, o.schema, o.table, tableKind(o.table), {
        group: "foreignKeys",
        leaf: (d) => {
          const i = d.foreignKeys.findIndex((k) => k.name === o.name);
          return i < 0 ? null : String(i);
        },
      });
    case "index":
    case "uniqueIndex":
      return revealInTree(target, o.schema, o.table, tableKind(o.table), {
        group: "indexes",
        leaf: (d) => (d.indexes.some((x) => x.name === o.name) ? o.name : null),
      });
    case "trigger":
      return revealInTree(target, o.schema, o.table, tableKind(o.table), {
        group: "triggers",
        leaf: (d) => (d.triggers.some((x) => x.name === o.name) ? o.name : null),
      });
    case "function":
    case "procedure":
      return revealSchemaChild(target, o.schema, {
        folder: "routines",
        leaf: (objects) => {
          const r = objects.routines.find((x) => x.name === o.name && x.kind === o.kind);
          return r ? `${r.name}(${r.arguments})` : null;
        },
      });
    case "sequence":
      return revealSchemaChild(target, o.schema, {
        folder: "sequences",
        leaf: (objects) => (objects.sequences.some((x) => x.name === o.name) ? o.name : null),
      });
  }
}

/** The targets of a SQL data source whose catalogs are searched: its own, connected and listed databases'. */
function targetsOf(source: DataSource): string[] {
  const id = source.id ?? "";
  const st = useDatabase.getState();
  const out = new Set([id, ...connectedTargets(id)]);
  const dbs = st.databases[id];
  if (dbs?.status === "ok") {
    const intro = source.introspection;
    for (const name of shownNames(dbs.value.names, intro?.allDatabases, intro?.databases, dbs.value.current))
      out.add(targetOf(id, name, dbs.value.current));
  }
  return [...out];
}

function sqlHits(source: DataSource, target: string, query: string, letters: string[], out: Hit[]) {
  const catalog = catalogOf(target);
  if (!catalog) return;
  const label = targetLabel(target);
  const { objects, lower } = searchable(source, catalog);
  const seen = new Set<string>();
  for (let i = 0; i < objects.length; i++) {
    if (!mayMatch(lower[i]!, letters)) continue;
    const o = objects[i]!;
    const container = o.table ? `${o.schema}.${o.table}` : o.schema;
    const qualified = container ? `${container}.${o.name}` : o.name;
    const hit = matchObject(o.name, qualified, query);
    if (!hit) continue;
    const key = `db:${target}:${o.kind}:${o.schema}:${o.table}:${o.name}`;
    // Overloads share a name: one row.
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      score: hit.score,
      rank: KIND_RANK[o.kind],
      name: o.name,
      indices: hit.indices,
      build: (indices) => ({
        key,
        name: o.name,
        container,
        source: label,
        icon: ICONS[o.kind],
        indices,
        score: hit.score,
        qualifiedName: qualified,
        open: () => void revealObject(target, o, catalog),
        actions: sqlActions(target, o),
      }),
    });
  }
}

/** Keys the tree loaded (IDEA finds `queue:orders 0 [0@localhost]`). */
function redisHits(source: DataSource, query: string, out: Hit[]) {
  const id = source.id ?? "";
  for (const [target, list] of Object.entries(useRedis.getState().keys)) {
    if (splitRedisTarget(target).id !== id) continue;
    const db = splitRedisTarget(target).db;
    for (const entry of list.keys) {
      const name = bytesLabel(entry.key);
      const hit = matchObject(name, `${db}.${name}`, query);
      if (!hit) continue;
      const meta = kindMeta(entry.kind);
      out.push({
        score: hit.score,
        rank: 4,
        name,
        indices: hit.indices,
        build: (indices) => ({
          key: `redis:${target}:${keyId(entry.key)}`,
          name,
          container: String(db),
          source: source.name ?? id,
          icon: "db-redis",
          chip: { label: meta.short, title: meta.label, color: meta.color },
          indices,
          score: hit.score,
          qualifiedName: name,
          open: () => revealRedisKey(id, target, entry.key.text, !!entry.key.binary, keyId(entry.key)),
          actions: [{ label: tx("Open Value"), run: () => openKey(target, entry.key) }],
        }),
      });
    }
  }
}

function revealRedisKey(id: string, target: string, text: string, binary: boolean, kid: string) {
  const db = splitRedisTarget(target).db;
  const open = [id, `${id}/db${db}`];
  const separator = separatorOf(id);
  if (!binary && separator) {
    const parts = text.split(separator);
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      prefix += parts[i] + separator;
      open.push(`${redisTarget(id, db)}/f:${prefix}`);
    }
  }
  revealKey(open, `${redisTarget(id, db)}/k:${kid}`);
}

/** Indices, data streams and aliases of a connected Elasticsearch data source. */
function elasticHits(source: DataSource, query: string, out: Hit[]) {
  const id = source.id ?? "";
  const l = useElastic.getState().indices[id];
  if (l?.status !== "ok") return;
  const hidden = showsHidden(id);
  const add = (name: string, icon: string, nodeKey: string, open: string[]) => {
    const hit = matchObject(name, name, query);
    if (!hit) return;
    out.push({
      score: hit.score,
      rank: 0,
      name,
      indices: hit.indices,
      build: (indices) => ({
        key: `es:${id}:${nodeKey}`,
        name,
        container: "",
        source: source.name ?? id,
        icon,
        indices,
        score: hit.score,
        qualifiedName: name,
        open: () => revealKey(open, nodeKey),
        actions: [{ label: tx("Open in Discover"), run: () => void openDiscover(id, name) }],
      }),
    });
  };
  for (const index of l.value.indices)
    if (hidden || (!index.hidden && !index.dataStream)) add(index.name, "db-table", `${id}/i:${index.name}`, [id]);
  for (const stream of l.value.dataStreams)
    if (hidden || !stream.hidden)
      add(stream.name, "db-view", `${id}/g:dataStreams/${stream.name}`, [id, `${id}/g:dataStreams`]);
  for (const alias of l.value.aliases)
    if (hidden || !alias.name.startsWith("."))
      add(alias.name, "db-foreign-key", `${id}/g:aliases/${alias.name}`, [id, `${id}/g:aliases`]);
}

/** Every matching object in memory, best first. */
export function databaseHits(query: string, limit: number): DatabaseSearchResult {
  const q = query.trim();
  if (!q) return { items: [], hasMore: false };
  // The name holds the letters of the query's last part (`luma.ord` → `ord`).
  const letters = [...(q.split(".").pop() ?? "").toLowerCase().replace(/\s/g, "")];
  const hits: Hit[] = [];
  for (const source of useDatabase.getState().sources) {
    if (source.driver === "redis") redisHits(source, q, hits);
    else if (source.driver === "elasticsearch") elasticHits(source, q, hits);
    else for (const t of targetsOf(source)) sqlHits(source, t, q, letters, hits);
  }
  const better = (a: Hit, b: Hit) =>
    b.score - a.score || a.rank - b.rank || a.name.length - b.name.length || a.name.localeCompare(b.name);
  // The best `limit` without sorting every hit (a short query matches much of a large catalog).
  const top: Hit[] = [];
  for (const h of hits) {
    if (top.length === limit && better(h, top[top.length - 1]!) >= 0) continue;
    let i = top.length;
    while (i > 0 && better(h, top[i - 1]!) < 0) i--;
    top.splice(i, 0, h);
    if (top.length > limit) top.pop();
  }
  return { items: top.map((h) => h.build(h.indices)), hasMore: hits.length > limit };
}

/**
 * The Search Everywhere provider: answers from memory at once, then again as saved
 * catalogs are read and connected targets introspected (once per session).
 */
export async function searchDatabase(
  query: string,
  limit: number,
  emit: (r: DatabaseSearchResult) => void,
): Promise<void> {
  if (!query.trim()) return emit({ items: [], hasMore: false });
  if (!useDatabase.getState().loaded) await loadSources();
  emit(databaseHits(query, limit));
  const st = useDatabase.getState();
  const loads = st.sources
    .filter((s) => s.driver !== "redis" && s.driver !== "elasticsearch")
    .flatMap(targetsOf)
    .map(async (t) => {
      await readSavedCatalog(t);
      emit(databaseHits(query, limit));
      if (!useDatabase.getState().connected.has(t)) return;
      await introspectCatalog(t);
      emit(databaseHits(query, limit));
    });
  await Promise.all(loads);
}
