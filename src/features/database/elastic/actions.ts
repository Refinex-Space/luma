/**
 * Elasticsearch actions (category Elasticsearch, in Find Action and the command palette)
 * and the Database tree's menus of Elasticsearch nodes: Discover, console, cluster
 * overview, index operations. They act on the tree node passed as `arg`, else the
 * selected node, else the only Elasticsearch data source.
 */
import { registerActions, type Action } from "@/platform/actions";
import type { MenuItem } from "@/ui";
import { copyText } from "@/ui/selectableText";
import { useDatabase } from "../store";
import type { DbNode } from "../nodes";
import {
  deleteIndex,
  isElasticSource,
  openCluster,
  openDiscover,
  openEsConsole,
  openEsDialog,
  refreshElastic,
  refreshIndex,
  setIndexOpen,
} from "./store";

const OPEN = "projectOpen";

function isNode(v: unknown): v is DbNode {
  return !!v && typeof v === "object" && "kind" in v && "key" in v;
}

const nodeOf = (arg: unknown): DbNode | null => (isNode(arg) ? arg : useDatabase.getState().selectedNode);

/** The Elasticsearch data source of a node, else of the selection, else the only one. */
export function elasticSourceOf(n: DbNode | null): string | null {
  if (n?.kind === "source") return n.source.driver === "elasticsearch" ? (n.source.id ?? null) : null;
  if (n && "id" in n && typeof n.id === "string" && isElasticSource(n.id)) return n.id;
  const { sources, selectedSource } = useDatabase.getState();
  if (selectedSource && isElasticSource(selectedSource)) return selectedSource;
  const es = sources.filter((s) => s.driver === "elasticsearch");
  return es.length === 1 ? (es[0]!.id ?? null) : null;
}

type Searchable = Extract<DbNode, { kind: "esIndex" | "esDataStream" | "esAlias" }>;
const searchable = (n: DbNode | null): Searchable | null =>
  n?.kind === "esIndex" || n?.kind === "esDataStream" || n?.kind === "esAlias" ? n : null;

/** What a node searches: an index, data stream or alias name (`*`: the whole cluster). */
export function patternOf(n: DbNode | null): string {
  const s = searchable(n);
  if (!s) return n?.kind === "esField" ? n.pattern : "*";
  return s.kind === "esIndex" ? s.index.name : s.kind === "esDataStream" ? s.stream.name : s.alias.name;
}

const indexOf = (n: DbNode | null) => (n?.kind === "esIndex" ? n.index : null);

/** A search request block for the console. */
export function searchRequest(pattern: string): string {
  return `GET /${pattern}/_search\n{\n  "query": {\n    "match_all": {}\n  },\n  "size": 20\n}\n`;
}

export function registerElasticActions(): () => void {
  const a = (action: Omit<Action, "category" | "when">): Action => ({
    category: "Elasticsearch",
    when: OPEN,
    ...action,
  });
  return registerActions([
    a({
      id: "es.discover",
      title: "Discover",
      icon: "search",
      keywords: ["elasticsearch", "kibana", "search", "documents", "kql", "browse"],
      run: ({ arg }) => {
        const n = nodeOf(arg);
        const id = elasticSourceOf(n);
        if (id) void openDiscover(id, patternOf(n));
      },
    }),
    a({
      id: "es.console",
      title: "Elasticsearch Console",
      icon: "db-console",
      keywords: ["dev tools", "console", "rest", "query dsl", "elasticsearch"],
      run: ({ arg }) => {
        const n = nodeOf(arg);
        const id = elasticSourceOf(n);
        if (id) void openEsConsole(id, searchable(n) ? searchRequest(patternOf(n)) : undefined);
      },
    }),
    a({
      id: "es.cluster",
      title: "Cluster Overview",
      icon: "db-chart",
      keywords: ["elasticsearch", "health", "nodes", "shards", "stats"],
      run: ({ arg }) => {
        const id = elasticSourceOf(nodeOf(arg));
        if (id) openCluster(id);
      },
    }),
    a({
      id: "es.createIndex",
      title: "New Index…",
      icon: "plus",
      keywords: ["elasticsearch", "create index", "mapping"],
      run: ({ arg }) => {
        const id = elasticSourceOf(nodeOf(arg));
        if (id) openEsDialog({ kind: "createIndex", id });
      },
    }),
    a({
      id: "es.refreshIndex",
      title: "Refresh Index",
      keywords: ["_refresh", "searchable"],
      run: ({ arg }) => {
        const n = nodeOf(arg);
        const i = indexOf(n);
        if (i && n && "id" in n) void refreshIndex(n.id as string, i.name);
      },
    }),
    a({
      id: "es.openIndex",
      title: "Open Index",
      run: ({ arg }) => {
        const n = nodeOf(arg);
        const i = indexOf(n);
        if (i && n && "id" in n) void setIndexOpen(n.id as string, i.name, true);
      },
    }),
    a({
      id: "es.closeIndex",
      title: "Close Index…",
      run: ({ arg }) => {
        const n = nodeOf(arg);
        const i = indexOf(n);
        if (i && n && "id" in n) void setIndexOpen(n.id as string, i.name, false);
      },
    }),
    a({
      id: "es.deleteIndex",
      title: "Delete Index…",
      icon: "trash",
      run: ({ arg }) => {
        const n = nodeOf(arg);
        const i = indexOf(n);
        if (i && n && "id" in n) void deleteIndex(n.id as string, i.name, i.docs);
      },
    }),
    a({
      id: "es.copyName",
      title: "Copy Name",
      icon: "copy",
      run: ({ arg }) => {
        const n = nodeOf(arg);
        if (n?.kind === "esField") void copyText(n.field.name);
        else if (searchable(n)) void copyText(patternOf(n));
      },
    }),
    a({
      id: "es.refresh",
      title: "Refresh Indices",
      icon: "refresh",
      run: ({ arg }) => {
        const id = elasticSourceOf(nodeOf(arg));
        if (id) void refreshElastic(id);
      },
    }),
  ]);
}

const act = (action: string, n: DbNode, extra: Partial<{ label: string; disabled: boolean }> = {}): MenuItem => ({
  kind: "action",
  action,
  arg: n,
  ...extra,
});
const sep: MenuItem = { kind: "separator" };

/** The Database tree's menu of an Elasticsearch node (`source` ones get the shared items around these). */
export function elasticNodeMenu(n: DbNode, readOnly: boolean): MenuItem[] {
  const writes = (items: MenuItem[]) => (readOnly ? [] : items);
  switch (n.kind) {
    case "source":
      return [
        act("es.discover", n),
        act("es.console", n),
        act("es.cluster", n),
        ...writes([sep, act("es.createIndex", n)]),
      ];
    case "esIndex": {
      const closed = n.index.status === "close";
      return [
        act("es.discover", n, { disabled: closed }),
        act("es.console", n, { label: "Query in Console" }),
        act("es.copyName", n),
        ...writes([
          sep,
          act("es.refreshIndex", n, { disabled: closed }),
          closed ? act("es.openIndex", n) : act("es.closeIndex", n),
          sep,
          act("es.deleteIndex", n),
        ]),
      ];
    }
    case "esDataStream":
    case "esAlias":
      return [act("es.discover", n), act("es.console", n, { label: "Query in Console" }), act("es.copyName", n)];
    case "esField":
      return [act("es.copyName", n)];
    case "esGroup":
      return [act("es.refresh", n)];
    default:
      return [];
  }
}
