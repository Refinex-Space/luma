/**
 * A Redis server kept in the page for the Redis Browser's end-to-end tests (browser mode
 * has no backend): the `commands` the Browser calls answer from an in-memory keyspace
 * the way `ide_db::redis` does (shapes verified against Redis 8 by
 * `crates/ide-db/tests/redis.rs`), commands typed in its command line included.
 */
import { commands } from "../src/bindings";
import { loadSources, useDatabase, DB_TOOL_WINDOW } from "../src/features/database/store";
import { toolWindowService } from "../src/workbench/contributions";

type Bytes = { text: string; binary: boolean };
type Value =
  | { kind: "string" | "ReJSON-RL"; v: string }
  | { kind: "hash"; v: Array<[string, string]> }
  | { kind: "list" | "set"; v: string[] }
  | { kind: "zset"; v: Array<[string, number]> }
  | { kind: "stream"; v: Array<[string, Record<string, string>]> };
interface Entry {
  value: Value;
  /** Expiry (`Date.now()` ms), or none. */
  expires: number | null;
}

const t = (text: string): Bytes => ({ text, binary: false });
const ok = (data: unknown) => Promise.resolve({ status: "ok", data });

function seed(): Map<string, Entry> {
  const now = Date.now();
  const e = (value: Value, ttlSeconds?: number): Entry => ({
    value,
    expires: ttlSeconds ? now + ttlSeconds * 1000 : null,
  });
  const settings = '{"theme":"dark","locale":"zh-CN","notify":{"email":true,"push":false},"shortcuts":["⌘K","⌘P"]}';
  return new Map<string, Entry>([
    [
      "user:1001:profile",
      e({
        kind: "hash",
        v: [
          ["name", "Ada Lovelace"],
          ["email", "ada@example.com"],
          ["plan", "enterprise"],
          ["signup", "2026-01-04T09:12:44Z"],
          ["settings", settings],
        ],
      }),
    ],
    ["user:1001:cart", e({ kind: "list", v: ["sku:42", "sku:7", "sku:19", "sku:42", "sku:3"] }, 1800)],
    [
      "user:1002:profile",
      e({
        kind: "hash",
        v: [
          ["name", "Linus Torvalds"],
          ["plan", "free"],
        ],
      }),
    ],
    ["user:1002:cart", e({ kind: "list", v: ["sku:88"] }, 42)],
    [
      "user:1003:profile",
      e({
        kind: "hash",
        v: [
          ["name", "Grace Hopper"],
          ["plan", "pro"],
        ],
      }),
    ],
    ["session:9f2c1a", e({ kind: "string", v: '{"uid":1001,"ip":"10.0.4.21","roles":["admin","billing"]}' }, 3540)],
    ["session:77ab0e", e({ kind: "string", v: '{"uid":1002,"ip":"10.0.4.88","roles":["viewer"]}' }, 12)],
    [
      "leaderboard:weekly",
      e({
        kind: "zset",
        v: [
          ["ada", 3820],
          ["grace", 3610],
          ["linus", 2990],
          ["alan", 2410],
          ["barbara", 1730],
          ["ken", 980],
        ],
      }),
    ],
    [
      "leaderboard:daily",
      e(
        {
          kind: "zset",
          v: [
            ["grace", 410],
            ["ada", 388],
          ],
        },
        86400,
      ),
    ],
    ["tags:popular", e({ kind: "set", v: ["redis", "rust", "tauri", "react", "postgres"] })],
    [
      "events:orders",
      e({
        kind: "stream",
        v: [
          ["1762300120001-0", { order: "A-1042", status: "PAID", total: "658.00" }],
          ["1762300187331-0", { order: "A-1043", status: "NEW", total: "1299.00" }],
          ["1762300201554-0", { order: "A-1042", status: "SHIPPED", total: "658.00" }],
        ],
      }),
    ],
    ["config:feature-flags", e({ kind: "ReJSON-RL", v: '{"newCheckout":true,"betaSearch":{"rollout":0.25}}' })],
    ["counter:visits", e({ kind: "string", v: "184023" })],
    ["cache:product:42", e({ kind: "string", v: '{"id":42,"name":"Mechanical Keyboard","price":899}' }, 280)],
    ["cache:product:7", e({ kind: "string", v: '{"id":7,"name":"USB-C Hub","price":239}' }, 160)],
    ["lock:invoice:2026-11", e({ kind: "string", v: "worker-3" }, 8)],
    ["app:version", e({ kind: "string", v: "1.24.0" })],
  ]);
}

const sizeOf = (v: Value) => 48 + JSON.stringify(v.v).length * 3;
const ttlOf = (x: Entry) => (x.expires === null ? -1 : Math.max(0, x.expires - Date.now()));
const glob = (p: string) =>
  new RegExp(
    `^${p
      .replace(/[.+^${}()|\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
  );

/** `redis-cli`-shaped replies (`RedisReply`). */
const bulk = (s: string) => ({ kind: "bulk", value: t(s) });
const arr = (items: unknown[]) => ({ kind: "array", items });
const int = (n: number) => ({ kind: "int", text: String(n) });

export async function installFakeRedis(): Promise<void> {
  const dbs = new Map<number, Map<string, Entry>>([
    [0, seed()],
    [3, new Map([["jobs:pending", { value: { kind: "list", v: ["a", "b"] } as Value, expires: null }]])],
  ]);
  const db = (target: string) => {
    const n = Number(target.split(":")[1] ?? 0);
    if (!dbs.has(n)) dbs.set(n, new Map());
    return dbs.get(n)!;
  };
  const live = (target: string, key: string) => {
    const m = db(target);
    const x = m.get(key);
    if (x && x.expires !== null && x.expires <= Date.now()) {
      m.delete(key);
      return undefined;
    }
    return x;
  };

  /** One command (`redis_command`, the console): a reply, or throws its error text. */
  const exec = (target: string, args: string[]): unknown => {
    const [name = "", ...a] = args;
    const m = db(target);
    const x = a[0] !== undefined ? live(target, a[0]) : undefined;
    switch (name.toUpperCase()) {
      case "PING":
        return { kind: "status", text: "PONG" };
      case "DBSIZE":
        return int(m.size);
      case "TYPE":
        return { kind: "status", text: x?.value.kind ?? "none" };
      case "TTL":
        return int(x ? (x.expires === null ? -1 : Math.ceil(ttlOf(x) / 1000)) : -2);
      case "EXISTS":
        return int(a.filter((k) => live(target, k)).length);
      case "GET":
        if (!x) return { kind: "nil" };
        if (x.value.kind !== "string")
          throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        return bulk(x.value.v);
      case "SET":
        m.set(a[0]!, { value: { kind: "string", v: a[1] ?? "" }, expires: null });
        return { kind: "status", text: "OK" };
      case "HGETALL":
        if (!x) return arr([]);
        if (x.value.kind !== "hash")
          throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        return arr(x.value.v.flatMap(([f, v]) => [bulk(f), bulk(v)]));
      case "HSET": {
        const h = x?.value.kind === "hash" ? x.value.v : [];
        if (!x) m.set(a[0]!, { value: { kind: "hash", v: h }, expires: null });
        let added = 0;
        for (let i = 1; i + 1 < a.length; i += 2) {
          const at = h.findIndex(([f]) => f === a[i]);
          if (at >= 0) h[at] = [a[i]!, a[i + 1]!];
          else {
            h.push([a[i]!, a[i + 1]!]);
            added++;
          }
        }
        return int(added);
      }
      case "DEL":
      case "UNLINK":
        return int(a.filter((k) => m.delete(k)).length);
      case "RENAMENX":
        if (!x) throw new Error("ERR no such key");
        if (live(target, a[1]!)) return int(0);
        m.delete(a[0]!);
        m.set(a[1]!, x);
        return int(1);
      case "EXPIRE":
        if (!x) return int(0);
        x.expires = Date.now() + Number(a[1]) * 1000;
        return int(1);
      case "PERSIST":
        if (!x || x.expires === null) return int(0);
        x.expires = null;
        return int(1);
      case "KEYS":
        return arr(
          [...m.keys()]
            .filter((k) => glob(a[0] ?? "*").test(k))
            .sort()
            .map(bulk),
        );
      default:
        throw new Error(`ERR unknown command '${name}', with args beginning with: ${a.map((w) => `'${w}'`).join(" ")}`);
    }
  };
  const READS = new Set(["PING", "DBSIZE", "TYPE", "TTL", "EXISTS", "GET", "HGETALL", "KEYS"]);

  const c = commands as unknown as Record<string, unknown>;
  c.dbSources = () =>
    ok([
      { id: "cache", name: "luma-redis", driver: "redis", host: "127.0.0.1", port: 6379, database: "0", options: {} },
    ]);
  c.dbConnected = () => ok([]);
  c.dbConnect = () => ok(null);
  c.redisKeyspace = () =>
    ok({
      version: "8.0.2",
      mode: "standalone",
      databases: Array.from({ length: 16 }, (_, i) => ({
        index: i,
        keys: [...(dbs.get(i)?.keys() ?? [])].filter((k) => live(`cache:${i}`, k)).length,
        expires: 0,
      })),
    });
  c.redisScan = (target: string, pattern: string, type: string | null) => {
    const re = glob(pattern || "*");
    const keys = [...db(target).keys()]
      .filter((k) => re.test(k))
      .map((k) => [k, live(target, k)] as const)
      .filter((p): p is readonly [string, Entry] => !!p[1] && (!type || p[1].value.kind === type))
      .map(([k, x]) => ({ key: t(k), kind: x.value.kind, ttlMs: ttlOf(x), memory: sizeOf(x.value) }));
    return ok({ cursor: "0", done: true, keys });
  };
  c.redisKeyInfo = (target: string, key: Bytes) => {
    const x = live(target, key.text);
    if (!x) return ok({ key, kind: "none", ttlMs: -2, length: null, memory: null, encoding: null });
    const v = x.value;
    const length = typeof v.v === "string" ? new TextEncoder().encode(v.v).length : v.v.length;
    const encoding = { string: "embstr", hash: "listpack", list: "quicklist", set: "listpack", zset: "skiplist" }[
      v.kind as string
    ];
    return ok({ key, kind: v.kind, ttlMs: ttlOf(x), length, memory: sizeOf(v), encoding: encoding ?? v.kind });
  };
  c.redisValue = (target: string, key: Bytes, kind: string, req: { descending?: boolean }) => {
    const x = live(target, key.text);
    const page = (columns: string[], rows: Array<Array<Bytes | null>>) =>
      ok({ kind, columns, rows, cursor: null, offset: 0, total: rows.length, value: null, truncated: false });
    if (!x) return page([], []);
    const v = x.value;
    switch (v.kind) {
      case "string":
      case "ReJSON-RL":
        return ok({
          kind,
          columns: [],
          rows: [],
          cursor: null,
          offset: 0,
          total: v.v.length,
          value: t(v.v),
          truncated: false,
        });
      case "hash":
        return page(
          ["field", "value"],
          v.v.map(([f, s]) => [t(f), t(s)]),
        );
      case "list":
        return page(
          ["index", "value"],
          v.v.map((s, i) => [t(String(i)), t(s)]),
        );
      case "set":
        return page(
          ["member"],
          v.v.map((s) => [t(s)]),
        );
      case "zset": {
        const sorted = [...v.v].sort((a, b) => (req?.descending ? b[1] - a[1] : a[1] - b[1]));
        return page(
          ["member", "score"],
          sorted.map(([s, n]) => [t(s), t(String(n))]),
        );
      }
      case "stream": {
        const fields = [...new Set(v.v.flatMap(([, f]) => Object.keys(f)))];
        const rows = (req?.descending ? [...v.v].reverse() : v.v).map(([id, f]) => [
          t(id),
          ...fields.map((n) => (n in f ? t(f[n]!) : null)),
        ]);
        return page(["id", ...fields], rows);
      }
    }
  };
  c.redisCommand = (target: string, args: Bytes[]) => {
    try {
      return ok(
        exec(
          target,
          args.map((w) => w.text),
        ),
      );
    } catch (e) {
      return Promise.resolve({ status: "error", error: { kind: "Invalid", message: (e as Error).message } });
    }
  };
  c.redisTransaction = (target: string, cmds: Bytes[][]) =>
    ok(
      cmds.map((args) =>
        exec(
          target,
          args.map((w) => w.text),
        ),
      ),
    );
  c.redisExecute = async (_req: number, target: string, input: Array<{ from: number; to: number; args: Bytes[] }>) => {
    const out = [];
    for (const i of input) {
      const words = i.args.map((w) => w.text);
      const name = (words[0] ?? "").toUpperCase();
      const started = performance.now();
      const base = {
        from: i.from,
        to: i.to,
        text: words.join(" "),
        select: null as number | null,
        writes: !READS.has(name),
      };
      try {
        if (name === "SELECT") {
          out.push({
            ...base,
            reply: { kind: "status", text: "OK" },
            error: null,
            elapsedMs: 0.21,
            select: Number(words[1]),
          });
          continue;
        }
        const reply = exec(target, words);
        out.push({ ...base, reply, error: null, elapsedMs: performance.now() - started + 0.18 });
      } catch (e) {
        out.push({ ...base, reply: null, error: (e as Error).message, elapsedMs: 0.12 });
        break;
      }
    }
    return ok(out);
  };
  c.redisInfo = () => ok("# Server\r\nredis_version:8.0.2\r\n# Keyspace\r\ndb0:keys=17,expires=7,avg_ttl=0\r\n");

  useDatabase.setState({ loaded: false });
  await loadSources();
  toolWindowService().show(DB_TOOL_WINDOW, true);
}
