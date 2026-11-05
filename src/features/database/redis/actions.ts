/**
 * Redis actions (category Redis, in Find Action and the command palette) and the
 * Database tree's menus of Redis nodes: new key, filter, rename, TTL, delete, flush,
 * server info, console. They act on the tree node passed as `arg`, else the
 * selected node, else the only Redis data source.
 */
import { registerActions, type Action } from "@/platform/actions";
import type { MenuItem } from "@/ui";
import { copyText } from "@/ui/selectableText";
import { useDatabase } from "../store";
import type { DbNode } from "../nodes";
import { bytesLabel, redisTarget, splitRedisTarget, type RedisTarget } from "./model";
import {
  deleteKey,
  flushDatabase,
  isRedisSource,
  loadKeys,
  openBrowser,
  openKey,
  openKeyTab,
  openRedisConsoleOf,
  openRedisDialog,
  openPubSub,
  openServerInfo,
  refreshRedis,
} from "./store";
import { folderPattern } from "./tree";

const OPEN = "projectOpen";

function isNode(v: unknown): v is DbNode {
  return !!v && typeof v === "object" && "kind" in v && "key" in v;
}

/** The node an action acts on: its argument, else the tree's selection. */
function nodeOf(arg: unknown): DbNode | null {
  return isNode(arg) ? arg : useDatabase.getState().selectedNode;
}

/** The Redis target of a node: a database (`<id>:<n>`) or, for a data source, its configured database. */
export function redisTargetOf(n: DbNode | null): RedisTarget | null {
  if (n && "id" in n && typeof n.id === "string" && n.kind.startsWith("redis")) return n.id;
  const sourceId =
    n?.kind === "source"
      ? (n.source.id ?? null)
      : (() => {
          const { sources, selectedSource } = useDatabase.getState();
          if (selectedSource && isRedisSource(selectedSource)) return splitRedisTarget(selectedSource).id;
          const redis = sources.filter((s) => s.driver === "redis");
          return redis.length === 1 ? (redis[0]!.id ?? null) : null;
        })();
  if (!sourceId || !isRedisSource(sourceId)) return null;
  const s = useDatabase.getState().sources.find((x) => x.id === sourceId);
  return redisTarget(sourceId, Number(s?.database?.trim() || 0));
}

const keyOf = (n: DbNode | null) => (n?.kind === "redisKey" ? n : null);

export function registerRedisActions(): () => void {
  const a = (action: Omit<Action, "category" | "when">): Action => ({ category: "Redis", when: OPEN, ...action });
  return registerActions([
    a({
      id: "redis.newKey",
      title: "New Key…",
      icon: "plus",
      keywords: ["redis", "add key", "set", "hset", "lpush", "sadd", "zadd", "xadd"],
      run: ({ arg }) => {
        const n = nodeOf(arg);
        const target = redisTargetOf(n);
        if (target) openRedisDialog({ kind: "newKey", target, prefix: n?.kind === "redisFolder" ? n.prefix : "" });
      },
    }),
    a({
      id: "redis.browseKeys",
      title: "Browse Keys",
      icon: "db-redis",
      keywords: ["redis browser", "keys", "scan", "explore", "values"],
      run: ({ arg }) => {
        const n = nodeOf(arg);
        if (n?.kind === "redisKey") return openKey(n.id, n.entry.key);
        const target = redisTargetOf(n);
        if (target) openBrowser(target);
      },
    }),
    a({
      id: "redis.filterKeys",
      title: "Filter Keys…",
      icon: "filter",
      keywords: ["redis", "scan", "match", "pattern", "search keys"],
      run: ({ arg }) => {
        const target = redisTargetOf(nodeOf(arg));
        if (target) openRedisDialog({ kind: "filter", target });
      },
    }),
    a({
      id: "redis.openConsole",
      title: "Redis Console",
      icon: "db-console",
      keywords: ["redis-cli", "command line", "console"],
      run: ({ arg }) => {
        const target = redisTargetOf(nodeOf(arg));
        if (target) void openRedisConsoleOf(target);
      },
    }),
    a({
      id: "redis.serverInfo",
      title: "Server Information",
      icon: "info",
      keywords: ["redis", "info", "memory", "clients", "slowlog", "stats", "dashboard"],
      run: ({ arg }) => {
        const target = redisTargetOf(nodeOf(arg));
        if (target) openServerInfo(target);
      },
    }),
    a({
      id: "redis.pubSub",
      title: "Pub/Sub",
      icon: "toolwindow-notifications",
      keywords: ["redis", "subscribe", "publish", "channels", "messages"],
      run: ({ arg }) => {
        const target = redisTargetOf(nodeOf(arg));
        if (target) openPubSub(target);
      },
    }),
    a({
      id: "redis.openKey",
      title: "Open Key",
      run: ({ arg }) => {
        const k = keyOf(nodeOf(arg));
        if (k) openKey(k.id, k.entry.key);
      },
    }),
    a({
      id: "redis.openKeyInNewTab",
      title: "Open Key in New Tab",
      icon: "external-link",
      run: ({ arg }) => {
        const k = keyOf(nodeOf(arg));
        if (k) openKeyTab(k.id, k.entry.key);
      },
    }),
    a({
      id: "redis.copyKeyName",
      title: "Copy Key Name",
      icon: "copy",
      run: ({ arg }) => {
        const n = nodeOf(arg);
        if (n?.kind === "redisKey") void copyText(bytesLabel(n.entry.key));
        else if (n?.kind === "redisFolder") void copyText(folderPattern(n.prefix));
      },
    }),
    a({
      id: "redis.renameKey",
      title: "Rename Key…",
      icon: "edit",
      run: ({ arg }) => {
        const k = keyOf(nodeOf(arg));
        if (k) openRedisDialog({ kind: "rename", target: k.id, key: k.entry.key });
      },
    }),
    a({
      id: "redis.setTtl",
      title: "Set Time to Live…",
      icon: "clock",
      keywords: ["expire", "ttl", "persist"],
      run: ({ arg }) => {
        const k = keyOf(nodeOf(arg));
        if (k) openRedisDialog({ kind: "ttl", target: k.id, key: k.entry.key, ttlMs: -1 });
      },
    }),
    a({
      id: "redis.deleteKey",
      title: "Delete Key…",
      icon: "trash",
      run: ({ arg }) => {
        const k = keyOf(nodeOf(arg));
        if (k) void deleteKey(k.id, k.entry.key);
      },
    }),
    a({
      id: "redis.deleteMatching",
      title: "Delete Keys Matching…",
      icon: "trash",
      keywords: ["unlink", "pattern", "bulk delete"],
      run: ({ arg }) => {
        const n = nodeOf(arg);
        const target = redisTargetOf(n);
        if (target)
          openRedisDialog({
            kind: "deleteMatching",
            target,
            pattern: n?.kind === "redisFolder" ? folderPattern(n.prefix) : "",
          });
      },
    }),
    a({
      id: "redis.flushDb",
      title: "Flush Database…",
      icon: "trash",
      keywords: ["flushdb", "clear", "empty"],
      run: ({ arg }) => {
        const target = redisTargetOf(nodeOf(arg));
        if (target) void flushDatabase(target);
      },
    }),
    a({
      id: "redis.refresh",
      title: "Refresh Keys",
      icon: "refresh",
      run: ({ arg }) => {
        const n = nodeOf(arg);
        const target = redisTargetOf(n);
        if (!target) return;
        if (n?.kind === "source") void refreshRedis(splitRedisTarget(target).id);
        else void loadKeys(target);
      },
    }),
  ]);
}

const act = (
  action: string,
  n: DbNode,
  extra: Partial<{ label: string; disabled: boolean; icon: string }> = {},
): MenuItem => ({
  kind: "action",
  action,
  arg: n,
  ...extra,
});
const sep: MenuItem = { kind: "separator" };

/** The Database tree's menu of a Redis node (`source` ones get the shared items around these). */
export function redisNodeMenu(n: DbNode, readOnly: boolean): MenuItem[] {
  const writes = (items: MenuItem[]) => (readOnly ? [] : items);
  switch (n.kind) {
    case "source":
      return [
        act("redis.browseKeys", n),
        act("redis.openConsole", n),
        act("redis.serverInfo", n),
        act("redis.pubSub", n),
        sep,
        ...writes([act("redis.newKey", n)]),
        act("redis.filterKeys", n),
      ];
    case "redisDb":
      return [
        act("redis.browseKeys", n),
        sep,
        ...writes([act("redis.newKey", n), sep]),
        act("redis.filterKeys", n),
        act("redis.refresh", n),
        sep,
        act("redis.openConsole", n),
        act("redis.serverInfo", n),
        ...writes([sep, act("redis.deleteMatching", n), act("redis.flushDb", n)]),
      ];
    case "redisFolder":
      return [
        ...writes([act("redis.newKey", n, { label: "New Key Here…" }), sep]),
        act("redis.copyKeyName", n, { label: "Copy Pattern" }),
        act("redis.refresh", n),
        ...writes([sep, act("redis.deleteMatching", n, { label: "Delete Keys in Folder…" })]),
      ];
    case "redisKey":
      return [
        act("redis.openKey", n, { label: "Open" }),
        act("redis.openKeyInNewTab", n, { label: "Open in New Tab" }),
        act("redis.copyKeyName", n),
        ...writes([sep, act("redis.renameKey", n), act("redis.setTtl", n), sep, act("redis.deleteKey", n)]),
      ];
    default:
      return [];
  }
}
