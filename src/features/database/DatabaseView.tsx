/**
 * Database tool window (IDEA's layout): data source → database (PostgreSQL) → schema → `tables` /
 * `views` / `materialized views` / `routines` / `sequences` folders → table → `columns` / `keys` /
 * `foreign keys` / `indexes` / `triggers`,
 * with counts and column types, loaded lazily. Double-click a table to open its data, a data
 * source to open its query console.
 */
import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import clsx from "clsx";
import type { DbDatabases, DbServerObjectKind, DbTableDetails } from "@/platform/ipc";
import { setContext } from "@/platform/context";
import { executeAction } from "@/platform/actions";
import { shortcutLabel } from "@/platform/keymap";
import {
  Button,
  EmptyState,
  Icon,
  IconButton,
  Menu,
  Spinner,
  Tree,
  showContextMenu,
  tooltipAttrs,
  type TreeHandle,
  T,
} from "@/ui";
import { colorVar, databaseKey, passesObjectFilter, shownNames, sourceIcon, splitTarget, targetOf } from "./model";
import { nodeTarget, schemaObjectOf, tableFolder, type DbNode as Node, type Folder, type Group } from "./nodes";
import {
  connect,
  detailsKey,
  hasServerObjects,
  listsDatabases,
  loadDatabases,
  loadDetails,
  loadSchemas,
  loadServerObjects,
  loadSources,
  loadTables,
  openConsole,
  openObjectDdl,
  tablesKey,
  useDatabase,
  type Loaded,
} from "./store";
import { DB_VIEW_FOCUS, openTableData } from "./treeActions";
import { KindChip } from "./redis/KindChip";
import { bytesLabel, keyId, redisTarget, splitRedisTarget } from "./redis/model";
import {
  loadKeys,
  loadKeyspace,
  openBrowser,
  openKey,
  openRedisConsoleOf,
  separatorOf,
  shownDatabases as redisDatabases,
  useRedis,
  type DbKeys,
} from "./redis/store";
import { indexKeys, type KeyIndex } from "./redis/tree";
import { newMenu, nodeMenu } from "./treeMenu";
import styles from "./Database.module.css";
import { tx } from "@/platform/i18n";
import type { EsIndices } from "@/platform/ipc";
import { compactCount, healthColor } from "./elastic/model";
import { fieldsOf, loadIndices, openDiscover, openEsConsole, showsHidden, useElastic } from "./elastic/store";
import esStyles from "./elastic/Elastic.module.css";
import { sizeLabel } from "./redis/model";

// IDEA's lower-case folder names.
const GROUP_LABELS: Record<Group, () => string> = {
  columns: () => tx("columns"),
  keys: () => tx("keys"),
  foreignKeys: () => tx("foreign keys"),
  indexes: () => tx("indexes"),
  triggers: () => tx("triggers"),
};

const FOLDER_LABELS: Record<Folder, () => string> = {
  tables: () => tx("tables"),
  views: () => tx("views"),
  materializedViews: () => tx("materialized views"),
  routines: () => tx("routines"),
  sequences: () => tx("sequences"),
};

const SERVER_GROUP_LABELS: Record<DbServerObjectKind, () => string> = {
  collations: () => tx("collations"),
  users: () => tx("users"),
  roles: () => tx("roles"),
  tablespaces: () => tx("tablespaces"),
};

const SERVER_OBJECT_ICONS: Record<DbServerObjectKind, string> = {
  collations: "db-collation",
  users: "db-user",
  roles: "db-user",
  tablespaces: "db-tablespace",
};

const FOLDERS: readonly Folder[] = ["tables", "views", "materializedViews", "routines", "sequences"];

function esHealthTitle(health: string): string {
  if (!health) return tx("Closed");
  return tx`Health: ${health}`;
}

/** What an Elasticsearch index, data stream or alias node searches. */
function esName(n: Extract<Node, { kind: "esIndex" | "esDataStream" | "esAlias" }>): string {
  return n.kind === "esIndex" ? n.index.name : n.kind === "esDataStream" ? n.stream.name : n.alias.name;
}

function status<T>(key: string, l: Loaded<T> | undefined, map: (v: T) => Node[]): Node[] | undefined {
  if (!l) return undefined;
  if (l.status === "loading") return undefined;
  if (l.status === "error") return [{ kind: "message", key: `${key}/err`, text: l.message, error: true }];
  const nodes = map(l.value);
  return nodes.length ? nodes : [{ kind: "message", key: `${key}/empty`, text: "Empty" }];
}

const primaryKey = (d: DbTableDetails) => d.columns.filter((c) => c.primaryKey).map((c) => c.name);

/** Rows under a table: IDEA's columns / keys / foreign keys / indexes folders (empty ones left out). */
function groupsOf(d: DbTableDetails): Group[] {
  const g: Group[] = ["columns"];
  if (primaryKey(d).length) g.push("keys");
  if (d.foreignKeys.length) g.push("foreignKeys");
  if (d.indexes.length) g.push("indexes");
  if (d.triggers.length) g.push("triggers");
  return g;
}

function groupSize(d: DbTableDetails, g: Group): number {
  if (g === "columns") return d.columns.length;
  if (g === "keys") return primaryKey(d).length ? 1 : 0;
  if (g === "foreignKeys") return d.foreignKeys.length;
  if (g === "triggers") return d.triggers.length;
  return d.indexes.length;
}

const count = (n: number) => n.toLocaleString("en");

/** Grouped keys of a database, rebuilt only when its key list changes. */
const keyIndexes = new WeakMap<object, { separator: string; index: KeyIndex }>();
function keyIndexOf(keys: DbKeys, separator: string): KeyIndex {
  const cached = keyIndexes.get(keys.keys);
  if (cached && cached.separator === separator) return cached.index;
  const index = indexKeys(keys.keys, separator);
  keyIndexes.set(keys.keys, { separator, index });
  return index;
}

export function DatabaseView() {
  const st = useDatabase();
  const redis = useRedis();
  const elastic = useElastic();
  const tree = useRef<TreeHandle>(null);
  useEffect(() => {
    if (!st.loaded) void loadSources();
  }, [st.loaded]);
  // Go to Declaration from a console: the rows exist once the expanded nodes render.
  useEffect(() => {
    if (!st.treeReveal) return;
    const key = st.treeReveal.key;
    const frame = requestAnimationFrame(() => {
      tree.current?.reveal(key);
      tree.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [st.treeReveal]);

  const roots = useMemo<Node[]>(
    () => st.sources.map((source) => ({ kind: "source", key: source.id ?? "", source })),
    [st.sources],
  );

  /** Schemas tab › Object filter of the data source of target `id`. */
  const shown = (id: string) => {
    const filter = sourceOf(id)?.introspection?.objectFilter;
    return (o: { name: string }) => passesObjectFilter(o.name, filter);
  };
  const tablesOf = (id: string, schema: string) => {
    const t = st.tables[tablesKey(id, schema)];
    return t?.status === "ok" ? t.value.filter(shown(id)) : null;
  };
  const routinesOf = (id: string, schema: string) =>
    (st.objects[tablesKey(id, schema)]?.routines ?? []).filter(shown(id));
  const sequencesOf = (id: string, schema: string) =>
    (st.objects[tablesKey(id, schema)]?.sequences ?? []).filter(shown(id));
  /** Members of a schema folder: tables / views / materialized views, routines or sequences. */
  const folderSize = (id: string, schema: string, folder: Folder): number => {
    if (folder === "routines") return routinesOf(id, schema).length;
    if (folder === "sequences") return sequencesOf(id, schema).length;
    return (tablesOf(id, schema) ?? []).filter((t) => tableFolder(t.kind) === folder).length;
  };
  const detailsOf = (id: string, schema: string, table: string) => {
    const d = st.details[detailsKey(id, schema, table)];
    return d?.status === "ok" ? d.value : null;
  };

  const sourceOf = (target: string) => st.sources.find((s) => s.id === splitTarget(target).id);
  /** The Schemas tab's choice. */
  const shownSchemas = (target: string, names: string[]) => {
    const i = sourceOf(target)?.introspection;
    return shownNames(names, i?.allSchemas, i?.schemas);
  };
  const shownDatabases = (id: string, v: DbDatabases) => {
    const i = sourceOf(id)?.introspection;
    return shownNames(v.names, i?.allDatabases, i?.databases, v.current);
  };

  /** The `Server Objects` folder after the databases / schemas of a MySQL or PostgreSQL data source. */
  const withServerObjects = (n: Extract<Node, { kind: "source" }>, nodes: Node[] | undefined) => {
    if (!nodes || !hasServerObjects(n.source)) return nodes;
    const id = n.source.id ?? "";
    const server: Node = { kind: "serverObjects", key: `${id}/~server`, id };
    return [...nodes.filter((x) => x.key !== `${n.key}/empty`), server];
  };
  const serverGroups = (n: Extract<Node, { kind: "serverObjects" }>) =>
    status(n.key, st.serverObjects[n.id], (groups) =>
      groups.map((g): Node => ({
        kind: "serverGroup",
        key: `${n.key}/${g.kind}`,
        id: n.id,
        group: g.kind,
        count: g.objects.length,
      })),
    );
  const serverObjectsOf = (n: Extract<Node, { kind: "serverGroup" }>): Node[] | undefined => {
    const l = st.serverObjects[n.id];
    if (l?.status !== "ok") return undefined;
    return (l.value.find((g) => g.kind === n.group)?.objects ?? []).map((object) => ({
      kind: "serverObject",
      key: `${n.key}/${object.name}@${object.detail}`,
      id: n.id,
      group: n.group,
      object,
    }));
  };

  const schemasOf = (key: string, id: string) =>
    status(key, st.schemas[id], (v) =>
      shownSchemas(id, v).map((schema) => ({ kind: "schema", key: `${id}/${schema}`, id, schema }) as Node),
    );

  /** Folders, keys and “Load more” under a Redis database or folder. */
  const redisChildren = (n: Extract<Node, { kind: "redisDb" | "redisFolder" }>): Node[] | undefined => {
    const target = n.id;
    const k = redis.keys[target];
    if (!k || (k.loading && !k.keys.length)) return undefined;
    if (k.error && !k.keys.length) return [{ kind: "message", key: `${n.key}/err`, text: k.error, error: true }];
    const level = keyIndexOf(k, separatorOf(splitRedisTarget(target).id)).levels.get(
      n.kind === "redisDb" ? "" : n.prefix,
    );
    const nodes: Node[] = [
      ...(level?.folders ?? []).map((f): Node => ({
        kind: "redisFolder",
        key: `${target}/f:${f.prefix}`,
        id: target,
        name: f.name,
        prefix: f.prefix,
        count: f.count,
      })),
      ...(level?.keys ?? []).map((x): Node => ({
        kind: "redisKey",
        key: `${target}/k:${keyId(x.entry.key)}`,
        id: target,
        entry: x.entry,
        name: x.name,
      })),
    ];
    if (n.kind === "redisDb" && !k.done) nodes.push({ kind: "redisMore", key: `${target}/more`, id: target });
    if (n.kind === "redisDb" && !nodes.length)
      return [
        {
          kind: "message",
          key: `${n.key}/empty`,
          text: k.pattern === "*" ? tx("No keys") : tx`No keys match ${k.pattern}`,
        },
      ];
    return nodes;
  };

  /** Indices of an Elasticsearch data source, then its Data Streams and Aliases folders. */
  const esRoots = (id: string, v: EsIndices): Node[] => {
    const hidden = showsHidden(id);
    const out: Node[] = v.indices
      // Data stream backing indices (`.ds-…`) are reached through their stream.
      .filter((index) => hidden || (!index.hidden && !index.dataStream))
      .map((index) => ({ kind: "esIndex", key: `${id}/i:${index.name}`, id, index }));
    const streams = v.dataStreams.filter((d) => hidden || !d.hidden).length;
    const aliases = v.aliases.filter((a) => hidden || !a.name.startsWith(".")).length;
    if (streams) out.push({ kind: "esGroup", key: `${id}/g:dataStreams`, id, group: "dataStreams", count: streams });
    if (aliases) out.push({ kind: "esGroup", key: `${id}/g:aliases`, id, group: "aliases", count: aliases });
    return out.length ? out : [{ kind: "message", key: `${id}/empty`, text: tx("No indices") }];
  };
  const esGroupChildren = (n: Extract<Node, { kind: "esGroup" }>): Node[] | undefined => {
    const l = elastic.indices[n.id];
    if (l?.status !== "ok") return undefined;
    const hidden = showsHidden(n.id);
    if (n.group === "dataStreams")
      return l.value.dataStreams
        .filter((d) => hidden || !d.hidden)
        .map((stream) => ({ kind: "esDataStream", key: `${n.key}/${stream.name}`, id: n.id, stream }));
    return l.value.aliases
      .filter((a) => hidden || !a.name.startsWith("."))
      .map((alias) => ({ kind: "esAlias", key: `${n.key}/${alias.name}`, id: n.id, alias }));
  };
  const esFieldNodes = (n: Node, id: string, pattern: string) =>
    status(n.key, elastic.fields[`${id}\u0000${pattern}`], (fields) => {
      // Kibana's field list: leaves only — an `object` is the prefix of the fields that follow it.
      const shown = fields.filter((f) => !f.metadata && !(f.types.length === 1 && f.types[0] === "object"));
      return shown.length
        ? shown.map((field) => ({ kind: "esField", key: `${n.key}/${field.name}`, id, pattern, field }) as Node)
        : [{ kind: "message", key: `${n.key}/empty`, text: tx("No fields") }];
    });

  const children = (n: Node): readonly Node[] | undefined => {
    switch (n.kind) {
      case "esGroup":
        return esGroupChildren(n);
      case "esIndex":
        return esFieldNodes(n, n.id, n.index.name);
      case "esDataStream":
        return esFieldNodes(n, n.id, n.stream.name);
      case "esAlias":
        return esFieldNodes(n, n.id, n.alias.name);
      case "source": {
        const id = n.source.id ?? "";
        if (n.source.driver === "elasticsearch") return status(n.key, elastic.indices[id], (v) => esRoots(id, v));
        if (n.source.driver === "redis")
          return status(n.key, redis.keyspace[id], (v) =>
            redisDatabases(id, v).map((d): Node => ({
              kind: "redisDb",
              key: `${id}/db${d.index}`,
              id: redisTarget(id, d.index),
              db: d.index,
              keys: d.keys ?? 0,
            })),
          );
        if (listsDatabases(n.source))
          return withServerObjects(
            n,
            status(n.key, st.databases[id], (v) =>
              shownDatabases(id, v).map((name) => ({
                kind: "database",
                key: databaseKey(id, name),
                id: targetOf(id, name, v.current),
                name,
                current: name === v.current,
              })),
            ),
          );
        return withServerObjects(n, schemasOf(n.key, id));
      }
      case "serverObjects":
        return serverGroups(n);
      case "serverGroup":
        return serverObjectsOf(n);
      case "database":
        return schemasOf(n.key, n.id);
      case "redisDb":
      case "redisFolder":
        return redisChildren(n);
      case "schema":
        return status(n.key, st.tables[tablesKey(n.id, n.schema)], () =>
          FOLDERS.filter((f) => folderSize(n.id, n.schema, f) > 0).map((folder): Node => ({
            kind: "folder",
            key: `${n.key}/${folder}`,
            id: n.id,
            schema: n.schema,
            folder,
          })),
        );
      case "folder": {
        const at = { id: n.id, schema: n.schema };
        if (n.folder === "routines")
          // Overloads share a name: the key tells them apart by their arguments.
          return routinesOf(n.id, n.schema).map((routine) => ({
            kind: "routine",
            key: `${n.key}/${routine.name}(${routine.arguments})`,
            routine,
            ...at,
          }));
        if (n.folder === "sequences")
          return sequencesOf(n.id, n.schema).map((sequence) => ({
            kind: "sequence",
            key: `${n.key}/${sequence.name}`,
            sequence,
            ...at,
          }));
        return (tablesOf(n.id, n.schema) ?? [])
          .filter((t) => tableFolder(t.kind) === n.folder)
          .map((table) => ({ kind: "table", key: `${n.key}/${table.name}`, table, ...at }));
      }
      case "table": {
        const d = st.details[detailsKey(n.id, n.schema, n.table.name)];
        if (!d || d.status === "loading") return undefined;
        if (d.status === "error") return [{ kind: "message", key: `${n.key}/err`, text: d.message, error: true }];
        return groupsOf(d.value).map((group) => ({
          kind: "group",
          key: `${n.key}/${group}`,
          id: n.id,
          schema: n.schema,
          table: n.table.name,
          group,
        }));
      }
      case "group": {
        const d = detailsOf(n.id, n.schema, n.table);
        if (!d) return undefined;
        const fkCols = new Set(d.foreignKeys.flatMap((k) => k.columns));
        const at = { id: n.id, schema: n.schema, table: n.table };
        switch (n.group) {
          case "columns":
            return d.columns.map((column) => ({
              kind: "column",
              key: `${n.key}/${column.name}`,
              column,
              foreignKey: fkCols.has(column.name),
              ...at,
            }));
          case "keys":
            return [{ kind: "key", key: `${n.key}/pk`, columns: primaryKey(d), ...at }];
          case "foreignKeys":
            return d.foreignKeys.map((fk, i) => ({ kind: "foreignKey", key: `${n.key}/${i}`, fk, ...at }));
          case "indexes":
            return d.indexes.map((index) => ({ kind: "index", key: `${n.key}/${index.name}`, index, ...at }));
          case "triggers":
            return d.triggers.map((trigger) => ({ kind: "trigger", key: `${n.key}/${trigger.name}`, trigger, ...at }));
        }
        return undefined;
      }
      default:
        return undefined;
    }
  };

  const load = async (n: Node) => {
    if (n.kind === "source" && n.source.driver === "elasticsearch") {
      const id = n.source.id ?? "";
      if (await connect(id)) await loadIndices(id);
      return;
    }
    if (n.kind === "esIndex" || n.kind === "esDataStream" || n.kind === "esAlias") {
      await fieldsOf(n.id, esName(n)).catch(() => undefined);
      return;
    }
    if (n.kind === "source" && n.source.driver === "redis") {
      const id = n.source.id ?? "";
      if (await connect(id)) await loadKeyspace(id);
      return;
    }
    if (n.kind === "redisDb") {
      if (!redis.keys[n.id]) await loadKeys(n.id);
      return;
    }
    if (n.kind === "serverObjects") {
      if (await connect(n.id)) await loadServerObjects(n.id);
      return;
    }
    if (n.kind === "source") {
      const id = n.source.id ?? "";
      if (!(await connect(id))) return;
      if (listsDatabases(n.source)) await loadDatabases(id);
      else await loadSchemas(id);
    } else if (n.kind === "database") {
      if (await connect(n.id)) await loadSchemas(n.id);
    } else if (n.kind === "schema") await loadTables(n.id, n.schema);
    else if (n.kind === "table") await loadDetails(n.id, n.schema, n.table.name);
  };

  const label = (n: Node): string => {
    switch (n.kind) {
      case "esIndex":
      case "esDataStream":
      case "esAlias":
        return esName(n);
      case "esGroup":
        return n.group === "dataStreams" ? tx("Data Streams") : tx("Aliases");
      case "esField":
        return n.field.name;
      case "source":
        return n.source.name ?? "";
      case "database":
        return n.name;
      case "schema":
        return n.schema;
      case "folder":
        return FOLDER_LABELS[n.folder]();
      case "routine":
        return n.routine.name;
      case "sequence":
        return n.sequence.name;
      case "trigger":
        return n.trigger.name;
      case "table":
        return n.table.name;
      case "group":
        return GROUP_LABELS[n.group]();
      case "serverObjects":
        return tx("Server Objects");
      case "serverGroup":
        return SERVER_GROUP_LABELS[n.group]();
      case "serverObject":
        return n.object.name;
      case "column":
        return n.column.name;
      // Unnamed (SQLite) keys are numbered like IDEA's `key #1` / `foreign-key #1`.
      case "key":
        return "key #1";
      case "foreignKey":
        return n.fk.name || `foreign-key #${Number(n.key.slice(n.key.lastIndexOf("/") + 1)) + 1}`;
      case "index":
        return n.index.name;
      case "redisDb":
        return `db${n.db}`;
      case "redisFolder":
        return n.name;
      case "redisKey":
        return n.name;
      case "redisMore":
        return tx("Load more keys…");
      case "message":
        return n.text;
    }
  };

  /** Grey text after the label: counts, column types, key columns. */
  const detail = (n: Node): string | undefined => {
    switch (n.kind) {
      case "esIndex":
        return n.index.status === "close" ? tx("closed") : compactCount(n.index.docs ?? 0);
      case "esGroup":
        return count(n.count);
      case "esAlias":
        return count(n.alias.indices.length);
      case "esField":
        return n.field.types.join(" | ");
      case "source": {
        const id = n.source.id ?? "";
        if (listsDatabases(n.source)) {
          const d = st.databases[id];
          return d?.status === "ok" ? String(shownDatabases(id, d.value).length) : undefined;
        }
        const s = st.schemas[id];
        return s?.status === "ok" ? String(shownSchemas(id, s.value).length) : undefined;
      }
      case "database": {
        const s = st.schemas[n.id];
        return s?.status === "ok" ? String(shownSchemas(n.id, s.value).length) : undefined;
      }
      case "folder":
        return String(folderSize(n.id, n.schema, n.folder));
      case "routine":
        return `(${n.routine.arguments})${n.routine.returns ? `: ${n.routine.returns}` : ""}`;
      case "sequence":
        return n.sequence.dataType;
      case "trigger":
        return `${n.trigger.timing} ${n.trigger.events}`.trim();
      case "group": {
        const d = detailsOf(n.id, n.schema, n.table);
        return d ? String(groupSize(d, n.group)) : undefined;
      }
      case "column":
        return n.column.dataType;
      case "key":
        return `(${n.columns.join(", ")})`;
      case "foreignKey":
        return `(${n.fk.columns.join(", ")}) → ${n.fk.refTable} (${n.fk.refColumns.join(", ")})`;
      case "index":
        return `${n.index.unique ? "unique " : ""}(${n.index.columns.join(", ")})`;
      case "redisDb": {
        const k = redis.keys[n.id];
        // Loaded keys of a filtered or partly scanned database: `120 / 5,300`.
        return k && (k.pattern !== "*" || !k.done) ? `${k.keys.length} / ${count(n.keys)}` : count(n.keys);
      }
      case "redisFolder":
      case "serverGroup":
        return count(n.count);
      case "serverObject":
        // MySQL users: `luma@%`; PostgreSQL roles that can log in.
        if (n.group === "users") return n.object.detail ? `@${n.object.detail}` : undefined;
        return n.object.detail || undefined;
      default:
        return undefined;
    }
  };

  const icon = (n: Node): string | undefined => {
    switch (n.kind) {
      case "esIndex":
        return "db-table";
      case "esDataStream":
        return "db-view";
      case "esAlias":
        return "db-foreign-key";
      case "esGroup":
        return "db-folder";
      case "esField":
        return "db-column";
      case "source":
        return sourceIcon(n.source);
      case "database":
        return "database";
      case "schema":
        return "db-schema";
      case "folder":
      case "group":
        return "db-folder";
      case "table":
        return n.table.kind === "view" ? "db-view" : n.table.kind === "materializedView" ? "db-matview" : "db-table";
      case "routine":
        return "db-routine";
      case "sequence":
        return "db-sequence";
      case "trigger":
        return "db-trigger";
      case "column":
        return n.column.primaryKey ? "db-column-key" : n.foreignKey ? "db-column-fk" : "db-column";
      case "key":
        return "db-key";
      case "foreignKey":
        return "db-foreign-key";
      case "index":
        return "db-index";
      case "redisDb":
        return "database";
      case "redisFolder":
        return "db-folder";
      case "redisKey":
        return undefined;
      case "redisMore":
        return redis.keys[n.id]?.loading ? undefined : "more-horizontal";
      case "serverObjects":
        return "db-server-objects";
      case "serverGroup":
        return "db-folder";
      case "serverObject":
        return SERVER_OBJECT_ICONS[n.group];
      case "message":
        return n.error ? "error" : undefined;
    }
  };

  if (st.loaded && !st.sources.length)
    return (
      <div className={styles.dbView}>
        <DatabaseToolbar />
        <EmptyState title="No data sources">
          <Button variant="ghost" onClick={() => void executeAction("db.newDataSource")}>
            <T>New Data Source…</T>
          </Button>
        </EmptyState>
      </div>
    );

  return (
    <div className={styles.dbView}>
      <DatabaseToolbar />
      <div
        className={styles.treeHost}
        onFocus={(e) => setContext(DB_VIEW_FOCUS, (e.target as HTMLElement).getAttribute("role") === "tree")}
        onBlur={() => setContext(DB_VIEW_FOCUS, false)}
      >
        <Tree<Node>
          aria-label="Data sources"
          roots={roots}
          handleRef={tree}
          expanded={st.treeExpanded}
          onExpandedChange={(treeExpanded) => useDatabase.setState({ treeExpanded })}
          getKey={(n) => n.key}
          getLabel={label}
          getChildren={children}
          isExpandable={(n) =>
            n.kind === "source" ||
            n.kind === "database" ||
            n.kind === "schema" ||
            n.kind === "folder" ||
            n.kind === "table" ||
            n.kind === "group" ||
            n.kind === "redisDb" ||
            n.kind === "redisFolder" ||
            n.kind === "esGroup" ||
            n.kind === "esIndex" ||
            n.kind === "esDataStream" ||
            n.kind === "esAlias" ||
            n.kind === "serverObjects" ||
            n.kind === "serverGroup"
          }
          loadChildren={load}
          getIcon={(n) => icon(n)}
          getDetail={detail}
          getColor={(n) => (n.kind === "message" && n.error ? "var(--danger)" : undefined)}
          renderNode={(n: Node) => {
            const i = icon(n);
            const d = detail(n);
            const counted =
              n.kind === "source" ||
              n.kind === "database" ||
              n.kind === "folder" ||
              n.kind === "group" ||
              n.kind === "redisDb" ||
              n.kind === "redisFolder" ||
              n.kind === "esIndex" ||
              n.kind === "esGroup" ||
              n.kind === "esAlias" ||
              n.kind === "serverGroup";
            // IDEA: `luma@%`, the host greyed right after the user.
            const host = n.kind === "serverObject" && n.group === "users";
            const labelClass =
              n.kind === "message" && n.error
                ? styles.treeError
                : n.kind === "key" || n.kind === "foreignKey"
                  ? styles.keyLabel
                  : styles.nodeLabel;
            const live = n.kind === "source" && [...st.connected].some((t) => splitTarget(t).id === n.source.id);
            const target = nodeTarget(n);
            // IDEA tints every row of a coloured data source.
            const tint = colorVar(target ? sourceOf(target)?.color : null);
            return (
              <span
                className={tint ? `${styles.nodeRow} ${styles.tinted}` : styles.nodeRow}
                style={tint ? ({ "--db-tint": tint } as CSSProperties) : undefined}
                title={n.kind === "source" && n.source.comment ? n.source.comment : undefined}
              >
                {i && (
                  <span className={styles.nodeIcon}>
                    <Icon name={i} size={16} />
                    {/* IDEA: a green dot on the data source icon while connected. */}
                    {live && <span className={styles.connectedDot} title={tx("Connected")} />}
                  </span>
                )}
                {n.kind === "redisKey" && <KindChip kind={n.entry.kind} />}
                {n.kind === "esIndex" && (
                  <span
                    className={esStyles.healthDot}
                    style={{ "--dot": healthColor(n.index.health) } as CSSProperties}
                    title={esHealthTitle(n.index.health)}
                  />
                )}
                {n.kind === "redisMore" && redis.keys[n.id]?.loading && <Spinner size={12} />}
                <span
                  className={clsx(labelClass, n.kind === "esIndex" && n.index.status === "close" && styles.treeDetail)}
                  title={
                    n.kind === "redisKey"
                      ? bytesLabel(n.entry.key)
                      : n.kind === "esIndex"
                        ? tx`${count(n.index.docs ?? 0)} documents · ${sizeLabel(n.index.storeBytes ?? 0)}`
                        : undefined
                  }
                >
                  {label(n)}
                  {host && d && <span className={styles.userHost}>{d}</span>}
                </span>
                {d && !host && (
                  <span
                    className={
                      n.kind === "source"
                        ? styles.treeBadge
                        : counted
                          ? styles.treeCount
                          : n.kind === "column"
                            ? styles.treeType
                            : styles.treeDetail
                    }
                  >
                    {d}
                  </span>
                )}
              </span>
            );
          }}
          onSelectionChange={(_, lead) =>
            useDatabase.setState({ selectedSource: lead ? nodeTarget(lead) : null, selectedNode: lead })
          }
          onActivate={(n) => {
            if (n.kind === "esIndex" || n.kind === "esDataStream" || n.kind === "esAlias")
              return void openDiscover(n.id, esName(n));
            if (n.kind === "source" && n.source.driver === "elasticsearch")
              return void openEsConsole(n.source.id ?? "");
            if (n.kind === "redisKey") return openKey(n.id, n.entry.key);
            if (n.kind === "redisDb") return openBrowser(n.id);
            if (n.kind === "redisMore") return void loadKeys(n.id, { more: true });
            if (n.kind === "source" && n.source.driver === "redis") return void openRedisConsoleOf(n.source.id ?? "");
            if (n.kind === "table") openTableData(n.id, n.schema, n.table.name);
            else if (n.kind === "source") void openConsole(n.source.id ?? "");
            else if (n.kind === "database") void openConsole(n.id);
            else {
              const o = schemaObjectOf(n);
              if (o) void openObjectDdl(o.id, o.schema, o.kind, o.name);
            }
          }}
          activateExpandable={(n) =>
            n.kind === "table" ||
            n.kind === "redisDb" ||
            n.kind === "esIndex" ||
            n.kind === "esDataStream" ||
            n.kind === "esAlias"
          }
          onContextMenu={(n, _sel, e) => {
            const items = nodeMenu(n);
            if (items.length) showContextMenu(e, items);
          }}
          speedSearch
        />
      </div>
    </div>
  );
}

/**
 * The toolbar row of IDEA's Database tool window, always shown under the
 * title: New ▸, Properties | Refresh, Deactivate | Jump to Query Console,
 * Edit Data, DDL.
 */
function DatabaseToolbar() {
  const node = useDatabase((s) => s.selectedNode);
  const connected = useDatabase((s) => s.connected);
  const sources = useDatabase((s) => s.sources);
  const plus = useRef<HTMLButtonElement>(null);
  const newOpen = useDatabase((s) => s.newMenuOpen);
  const setNewOpen = (v: boolean) => useDatabase.setState({ newMenuOpen: v });
  const table = node?.kind === "table" || node?.kind === "column" || node?.kind === "group";
  const target = node ? nodeTarget(node) : sources.length === 1 ? (sources[0]!.id ?? null) : null;
  const active = !!target && [...connected].some((t) => splitTarget(t).id === splitTarget(target).id);
  const button = { size: "small", iconSize: 16 } as const;
  return (
    <div className={styles.dbToolbar} role="toolbar" aria-label={tx("Database actions")}>
      <IconButton
        ref={plus}
        {...button}
        icon="db-add"
        title="New"
        shortcut={shortcutLabel("db.new")}
        aria-haspopup="menu"
        aria-expanded={newOpen}
        onClick={() => setNewOpen(!newOpen)}
      />
      <Menu
        open={newOpen}
        anchor={plus}
        items={newMenu()}
        placement="bottom-start"
        onClose={() => setNewOpen(false)}
        aria-label="New"
      />
      <IconButton {...button} icon="db-properties" action="db.properties" disabled={!sources.length} />
      <span className={styles.dbToolbarSep} />
      <IconButton {...button} icon="refresh" action="db.refresh" disabled={!sources.length} />
      <IconButton {...button} icon="db-disconnect" action="db.disconnect" disabled={node ? !active : !connected.size} />
      <span className={styles.dbToolbarSep} />
      <IconButton {...button} icon="db-console" action="db.jumpToConsole" disabled={!target} />
      <IconButton {...button} icon="db-table" action="db.editData" disabled={!table} />
      {/* IDEA labels this one with text. */}
      <button
        type="button"
        className={styles.textTool}
        aria-label={tx("Go to DDL")}
        disabled={!table}
        onClick={() => void executeAction("db.goToDdl")}
        {...tooltipAttrs("Go to DDL", shortcutLabel("db.goToDdl"))}
      >
        <T>DDL</T>
      </button>
    </div>
  );
}

/** Header controls (shown on hover, like IDEA's): Collapse All. */
export function DatabaseHeaderActions() {
  return <IconButton icon="collapse-all" action="db.collapseAll" size="small" iconSize={16} />;
}
