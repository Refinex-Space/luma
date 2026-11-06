/**
 * Database tools (IDEA's Database tool window, scoped): data sources for
 * SQLite / PostgreSQL / MySQL-MariaDB, a schema tree, query consoles with
 * results grids, and a table data editor. Connections, introspection and
 * statements run in Rust (`ide-db`).
 */
import { lazyComponent } from "@/ui";
import { activeEditor, registerEditorContribution, registerLanguageMode } from "@/editor/api";
import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import {
  registerCodeStyleSection,
  registerDatabaseSearch,
  registerEditorKind,
  registerOverlay,
  registerToolWindow,
  setFileDecorations,
  toolWindowService,
} from "@/workbench/contributions";
import { SQL_LANGUAGE, consoleExtension, executeInView, explainInView } from "./console";
import { tx } from "@/platform/i18n";
import { DatabaseDialogs } from "./Dialogs";
import { redisLanguageDescription } from "./redis/console/language";
import { REDIS_LANGUAGE, executeRedisInView, redisConsoleExtension } from "./redis/console/RedisConsole";
import { redisTargetOf, registerRedisActions } from "./redis/actions";
import { ES_CLUSTER_KIND, ES_DISCOVER_KIND, type EsClusterRef, type EsDiscoverRef } from "./elastic/model";
import { registerElasticActions } from "./elastic/actions";
import { esLanguageDescription } from "./elastic/console/language";
import { ES_LANGUAGE, esConsoleExtension, executeEsRequests } from "./elastic/EsConsole";
import "./elastic/Elastic.module.css";
import {
  REDIS_BROWSER_KIND,
  REDIS_INFO_KIND,
  REDIS_KEY_KIND,
  REDIS_PUBSUB_KIND,
  redisKeyTitle,
  splitRedisTarget,
  type RedisBrowserRef,
  type RedisInfoRef,
} from "./redis/model";
import { openRedisConsoleOf } from "./redis/store";
import { SQL_LANGUAGE_ID } from "./sqlStyle";
import { TABLE_KIND, tableTitle } from "./tableInput";
import { nodeTarget, type DbNode } from "./nodes";
import { registerDatabaseTreeActions } from "./treeActions";
import {
  DB_TOOL_WINDOW,
  RESULTS_WINDOW,
  consoleSource,
  consoleTints,
  loadSources,
  openConsole,
  openHistory,
  openSourceDialog,
  sourceById,
  useDatabase,
  watchIdleConnections,
} from "./store";

export function activate(): () => void {
  const disposers = [
    // Tables, columns, keys, routines, Redis keys… in Search Everywhere's All and Symbols tabs.
    registerDatabaseSearch({
      search: (query, limit, emit) => import("./search").then((m) => m.searchDatabase(query, limit, emit)),
    }),
    registerToolWindow({
      id: DB_TOOL_WINDOW,
      title: "Database",
      icon: "toolwindow-database",
      anchor: "left",
      secondary: true,
      order: 20,
      component: lazyComponent(() => import("./DatabaseView").then((m) => m.DatabaseView)),
      headerActions: lazyComponent(() => import("./DatabaseView").then((m) => m.DatabaseHeaderActions)),
    }),
    registerToolWindow({
      id: RESULTS_WINDOW,
      title: "Database Console",
      icon: "db-console",
      anchor: "bottom",
      stripe: "onUse",
      order: 9,
      component: lazyComponent(() => import("./ResultsView").then((m) => m.ResultsView)),
      headerContent: lazyComponent(() => import("./ResultsView").then((m) => m.ResultTabs)),
    }),
    registerEditorKind({
      kind: TABLE_KIND,
      component: lazyComponent(() => import("./TableEditor").then((m) => m.TableEditor)),
      title: tableTitle,
      icon: () => "database",
    }),
    registerOverlay({ id: "database.dialogs", component: DatabaseDialogs }),
    registerOverlay({
      id: "database.elasticDialogs",
      component: lazyComponent(() => import("./elastic/EsDialogs").then((m) => m.EsDialogs)),
    }),
    registerOverlay({
      id: "database.redisDialogs",
      component: lazyComponent(() => import("./redis/RedisDialogs").then((m) => m.RedisDialogs)),
    }),
    registerEditorKind({
      kind: REDIS_KEY_KIND,
      component: lazyComponent(() => import("./redis/KeyEditor").then((m) => m.RedisKeyEditor)),
      title: redisKeyTitle,
      icon: () => "db-redis",
    }),
    registerEditorKind({
      kind: REDIS_BROWSER_KIND,
      component: lazyComponent(() => import("./redis/browser/RedisBrowser").then((m) => m.RedisBrowser)),
      title: (input) => {
        const { id, db } = splitRedisTarget((input.data as RedisBrowserRef).target);
        return `${sourceById(id)?.name ?? "Redis"} · db${db}`;
      },
      icon: () => "db-redis",
      restorable: true,
    }),
    registerEditorKind({
      kind: ES_DISCOVER_KIND,
      component: lazyComponent(() => import("./elastic/discover/Discover").then((m) => m.EsDiscover)),
      title: (input) => (input.data as EsDiscoverRef).index,
      icon: () => "db-elasticsearch",
      restorable: true,
    }),
    registerEditorKind({
      kind: ES_CLUSTER_KIND,
      component: lazyComponent(() => import("./elastic/ClusterView").then((m) => m.EsClusterView)),
      title: (input) => {
        const name = sourceById((input.data as EsClusterRef).id)?.name ?? "Elasticsearch";
        return tx`${name} Cluster`;
      },
      icon: () => "db-elasticsearch",
      restorable: true,
    }),
    registerEditorKind({
      kind: REDIS_PUBSUB_KIND,
      component: lazyComponent(() => import("./redis/PubSub").then((m) => m.RedisPubSub)),
      title: (input) => {
        const name = sourceById((input.data as RedisInfoRef).id)?.name ?? "Redis";
        return tx`${name} Pub/Sub`;
      },
      icon: () => "db-redis",
    }),
    registerEditorKind({
      kind: REDIS_INFO_KIND,
      component: lazyComponent(() => import("./redis/ServerInfo").then((m) => m.RedisServerInfo)),
      title: (input) => {
        const name = sourceById((input.data as RedisInfoRef).id)?.name ?? "Redis";
        return tx`${name} Server`;
      },
      icon: () => "db-redis",
    }),
    registerRedisActions(),
    registerElasticActions(),
    registerCodeStyleSection({
      id: "database.sqlFormatting",
      language: SQL_LANGUAGE_ID,
      component: lazyComponent(() => import("./SqlStyleSettings").then((m) => m.SqlStyleSettings)),
    }),
    registerEditorContribution({ id: "database.console", order: 57, extensions: consoleExtension }),
    registerLanguageMode(redisLanguageDescription),
    registerEditorContribution({ id: "database.redisConsole", order: 57, extensions: redisConsoleExtension }),
    registerLanguageMode(esLanguageDescription),
    registerEditorContribution({ id: "database.esConsole", order: 57, extensions: esConsoleExtension }),
    // A reopened project starts with a fresh backend: forget the old one's state.
    useProject.subscribe((s, prev) => {
      if (s.project?.root === prev.project?.root) return;
      useDatabase.setState({
        sources: [],
        loaded: false,
        connected: new Set(),
        databases: {},
        schemas: {},
        tables: {},
        details: {},
        objects: {},
        completion: {},
        results: [],
        output: [],
        activeResult: null,
        selectedSource: null,
        selectedNode: null,
        treeExpanded: new Set(),
        treeReveal: null,
        manualCommit: new Set(),
        pendingTx: new Set(),
        running: {},
        dialog: null,
        newMenuOpen: false,
      });
    }),
    // Consoles of coloured data sources get a tinted tab.
    useDatabase.subscribe((s, prev) => {
      if (s.consoles !== prev.consoles || s.sources !== prev.sources) setFileDecorations("database", consoleTints(s));
    }),
    () => setFileDecorations("database", new Map()),
    watchIdleConnections(),
    registerDatabaseTreeActions(),
    registerActions([
      {
        id: "db.showToolWindow",
        title: "Database",
        category: "Tools",
        icon: "toolwindow-database",
        keywords: ["data sources", "sql", "tables"],
        when: "projectOpen",
        run: () => toolWindowService().show(DB_TOOL_WINDOW, true),
      },
      {
        id: "db.newDataSource",
        title: "New Data Source…",
        category: "Tools",
        icon: "plus",
        keywords: ["database", "connection", "postgres", "mysql", "sqlite"],
        when: "projectOpen",
        run: async () => {
          if (!useDatabase.getState().loaded) await loadSources();
          openSourceDialog(null);
        },
      },
      {
        id: "db.openConsole",
        title: "Query Console",
        category: "Tools",
        icon: "file-sql",
        keywords: ["database", "sql console"],
        when: "projectOpen",
        run: async ({ arg }) => {
          const s = useDatabase.getState();
          if (!s.loaded) await loadSources();
          const { sources, selectedSource } = useDatabase.getState();
          // A tree node (New ▸ Query Console) opens its data source's console.
          const node = arg && typeof arg === "object" && "kind" in arg ? nodeTarget(arg as DbNode) : null;
          const id = node ?? selectedSource ?? (sources.length === 1 ? sources[0]!.id : null);
          if (id && sourceById(id)?.driver === "redis")
            await openRedisConsoleOf(
              redisTargetOf(arg && typeof arg === "object" && "kind" in arg ? (arg as DbNode) : null) ?? id,
            );
          else if (id) await openConsole(id);
          else toolWindowService().show(DB_TOOL_WINDOW, true);
        },
      },
      {
        id: "db.execute",
        title: "Execute SQL Statement",
        category: "Tools",
        icon: "run",
        when: `editorTextFocus && (editorLangId == ${SQL_LANGUAGE} || editorLangId == ${REDIS_LANGUAGE} || editorLangId == ${ES_LANGUAGE})`,
        run: async () => {
          const e = activeEditor();
          if (!e) return;
          // A Redis console runs its command lines (⌘↩ as in a SQL console).
          if (e.ctx.language === REDIS_LANGUAGE) {
            if (!useDatabase.getState().loaded) await loadSources();
            return executeRedisInView(e.view, e.ctx.path);
          }
          // An Elasticsearch console runs the request at the caret (Kibana's ▶).
          if (e.ctx.language === ES_LANGUAGE) return executeEsRequests(e.view, e.ctx.path);
          if (e.ctx.language !== SQL_LANGUAGE) return;
          if (!useDatabase.getState().loaded) await loadSources();
          if (!consoleSource(e.ctx.path) && !useDatabase.getState().sources.length) {
            openSourceDialog(null);
            return;
          }
          await executeInView(e.view, e.ctx.path);
        },
      },
      {
        id: "db.explainPlan",
        title: "Explain Plan",
        category: "Tools",
        icon: "db-plan",
        keywords: ["query plan", "explain", "sql"],
        when: `editorTextFocus && editorLangId == ${SQL_LANGUAGE}`,
        run: async () => {
          const e = activeEditor();
          if (!e || e.ctx.language !== SQL_LANGUAGE) return;
          if (!useDatabase.getState().loaded) await loadSources();
          await explainInView(e.view, e.ctx.path);
        },
      },
      {
        id: "db.queryHistory",
        title: "Browse Query History",
        category: "Tools",
        icon: "history",
        keywords: ["database", "sql", "history"],
        when: "projectOpen",
        run: async () => {
          if (!useDatabase.getState().loaded) await loadSources();
          const e = activeEditor();
          const path = e?.ctx.language === SQL_LANGUAGE ? e.ctx.path : null;
          const s = useDatabase.getState();
          const id =
            (path && consoleSource(path)) ?? s.selectedSource ?? (s.sources.length === 1 ? s.sources[0]!.id : null);
          openHistory(path, id ?? null);
        },
      },
    ]),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
