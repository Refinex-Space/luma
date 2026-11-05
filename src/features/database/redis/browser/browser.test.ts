import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataSource, RedisKeyEntry, RedisScanPage } from "@/platform/ipc";
import { useDatabase } from "../../store";
import { textBytes } from "../model";
import { deleteKeys, keyRenamed, loadKeys, revealBrowserKey, selectBrowserKey, useRedis } from "../store";
import { shortTtl } from "./KeyList";
import { keyFilterPattern } from "./RedisBrowser";
import { folderNodeKey, pushHistory, useBrowserUi } from "./state";

const mocks = vi.hoisted(() => ({ scan: vi.fn(), command: vi.fn(), keyspace: vi.fn(), confirm: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    call: (value: unknown) => value,
    commands: {
      ...real.commands,
      redisScan: mocks.scan,
      redisCommand: mocks.command,
      redisKeyspace: mocks.keyspace,
    },
  };
});
vi.mock("@/workbench/messages", () => ({ confirm: mocks.confirm }));

const source: DataSource = { id: "r", name: "cache", driver: "redis", host: "127.0.0.1", database: "" };
const T = "r:0";
const entry = (text: string, kind = "string"): RedisKeyEntry => ({ key: textBytes(text), kind, ttlMs: -1, memory: 64 });
const page = (keys: RedisKeyEntry[]): RedisScanPage => ({ cursor: "0", done: true, keys });

beforeEach(() => {
  vi.clearAllMocks();
  useDatabase.setState({ sources: [source], loaded: true, connected: new Set([T]) });
  useRedis.setState({ keyspace: {}, keys: {}, browserKeys: {}, browserKey: {}, reveal: {}, dialog: null });
  useBrowserUi.setState({ expanded: {}, cli: {}, reload: {} });
  mocks.keyspace.mockResolvedValue({ version: "8", mode: "standalone", databases: [] });
  mocks.command.mockResolvedValue({ kind: "int", text: "1" });
});

describe("Redis Browser", () => {
  it("filters by glob as typed, else by substring", () => {
    expect(keyFilterPattern("")).toBe("*");
    expect(keyFilterPattern("  user:*  ")).toBe("user:*");
    expect(keyFilterPattern("session")).toBe("*session*");
    expect(keyFilterPattern("a]b")).toBe("*a\\]b*");
  });

  it("shows times to live in one unit", () => {
    expect(shortTtl(-1)).toBe("");
    expect(shortTtl(400)).toBe("1s");
    expect(shortTtl(42_000)).toBe("42s");
    expect(shortTtl(5 * 60_000 + 3000)).toBe("5m");
    expect(shortTtl(3 * 3_600_000)).toBe("3h");
    expect(shortTtl(2 * 86_400_000 + 5)).toBe("2d");
  });

  it("keeps its key list apart from the tree's, filtered by pattern and type", async () => {
    mocks.scan.mockResolvedValueOnce(page([entry("user:1", "hash")]));
    await loadKeys(T, { list: "browser", pattern: "user:*", type: "hash" });
    expect(mocks.scan).toHaveBeenLastCalledWith(T, "user:*", "hash", "0", 500);
    expect(useRedis.getState().browserKeys[T]).toMatchObject({ pattern: "user:*", type: "hash", done: true });
    expect(useRedis.getState().keys[T]).toBeUndefined();
  });

  it("reloads without emptying the list, and as many keys as were loaded", async () => {
    const many = Array.from({ length: 700 }, (_, i) => entry(`k:${i}`));
    mocks.scan.mockResolvedValueOnce(page(many));
    await loadKeys(T, { list: "browser" });
    let resolve!: (p: RedisScanPage) => void;
    mocks.scan.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const reload = loadKeys(T, { list: "browser" });
    // Still shown while the new scan runs.
    expect(useRedis.getState().browserKeys[T]).toMatchObject({ loading: true });
    expect(useRedis.getState().browserKeys[T]!.keys).toHaveLength(700);
    expect(mocks.scan).toHaveBeenLastCalledWith(T, "*", null, "0", 700);
    resolve(page([entry("k:1")]));
    await reload;
    expect(useRedis.getState().browserKeys[T]!.keys).toHaveLength(1);
    // A different filter starts empty.
    mocks.scan.mockReturnValueOnce(new Promise(() => {}));
    void loadKeys(T, { list: "browser", pattern: "x*" });
    expect(useRedis.getState().browserKeys[T]!.keys).toHaveLength(0);
  });

  it("lets a newer scan win over an older one's late answer", async () => {
    let first!: (p: RedisScanPage) => void;
    mocks.scan.mockReturnValueOnce(new Promise((r) => (first = r)));
    const older = loadKeys(T, { list: "browser", pattern: "a*" });
    mocks.scan.mockResolvedValueOnce(page([entry("b:1")]));
    await loadKeys(T, { list: "browser", pattern: "b*" });
    first(page([entry("a:1")]));
    await older;
    expect(useRedis.getState().browserKeys[T]).toMatchObject({ pattern: "b*" });
    expect(useRedis.getState().browserKeys[T]!.keys.map((k) => k.key.text)).toEqual(["b:1"]);
  });

  it("reveals a key with its folders opened, and follows it when renamed", () => {
    revealBrowserKey(T, textBytes("user:42:profile"));
    expect(useRedis.getState().browserKey[T]).toEqual(textBytes("user:42:profile"));
    expect(useBrowserUi.getState().expanded[T]).toEqual([folderNodeKey("user:"), folderNodeKey("user:42:")]);
    const seq = useRedis.getState().reveal[T]!.seq;

    mocks.scan.mockResolvedValue(page([]));
    keyRenamed(T, textBytes("other"), textBytes("x"));
    expect(useRedis.getState().browserKey[T]).toEqual(textBytes("user:42:profile"));
    keyRenamed(T, textBytes("user:42:profile"), textBytes("user:42:card"));
    expect(useRedis.getState().browserKey[T]).toEqual(textBytes("user:42:card"));
    expect(useRedis.getState().reveal[T]!.seq).toBeGreaterThan(seq);
  });

  it("deletes several keys with one confirmation and one UNLINK", async () => {
    mocks.scan.mockResolvedValueOnce(page([entry("a"), entry("b"), entry("c")]));
    await loadKeys(T, { list: "browser" });
    selectBrowserKey(T, textBytes("b"));
    mocks.confirm.mockResolvedValueOnce(true);
    expect(await deleteKeys(T, [textBytes("a"), textBytes("b")])).toBe(true);
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.command).toHaveBeenCalledWith(T, [textBytes("UNLINK"), textBytes("a"), textBytes("b")]);
    expect(useRedis.getState().browserKeys[T]!.keys.map((k) => k.key.text)).toEqual(["c"]);
    expect(useRedis.getState().browserKey[T]).toBeNull();

    mocks.confirm.mockResolvedValueOnce(false);
    expect(await deleteKeys(T, [textBytes("c"), textBytes("d")])).toBe(false);
    expect(mocks.command).toHaveBeenCalledTimes(1);
  });

  it("keeps the command line's history newest first, once each", () => {
    expect(pushHistory(["GET a", "PING"], "PING")).toEqual(["PING", "GET a"]);
    expect(pushHistory([], "  ")).toEqual(["  "]);
  });
});
