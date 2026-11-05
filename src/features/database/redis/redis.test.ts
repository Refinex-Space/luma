import { describe, expect, it } from "vitest";
import { parseSourceUrl } from "../model";
import { sourceUrl } from "../vendors";
import { bytesLabel, kindMeta, sizeLabel, splitRedisTarget, ttlLabel } from "./model";
import { newKeyCommands } from "./RedisDialogs";
import { commandStats, parseClients, parseInfo, parseSlowlog } from "./ServerInfo";

describe("Redis data sources", () => {
  it("reads redis:// and rediss:// URLs and writes them back", () => {
    expect(parseSourceUrl("redis://:s3cret@cache.local:6380/2")).toEqual({
      source: { driver: "redis", host: "cache.local", port: 6380, user: "", database: "2", ssl: "disable" },
      password: "s3cret",
    });
    expect(parseSourceUrl("rediss://ops@cache.example.com:6379/0")?.source).toMatchObject({
      driver: "redis",
      ssl: "require",
      user: "ops",
    });
    expect(parseSourceUrl("valkey://localhost")?.source).toMatchObject({ driver: "redis", vendor: "valkey" });
    expect(
      sourceUrl({ driver: "redis", host: "cache", port: 6380, database: "3", ssl: "require", user: "ops" } as never),
    ).toBe("rediss://ops@cache:6380/3");
  });

  it("names targets, keys, sizes and times to live", () => {
    expect(splitRedisTarget("cache:3")).toEqual({ id: "cache", db: 3 });
    expect(splitRedisTarget("cache")).toEqual({ id: "cache", db: 0 });
    expect(bytesLabel({ text: "ff00", binary: true })).toBe("\\xff\\x00");
    expect(ttlLabel(-1)).toBe("No limit");
    expect(ttlLabel(-2)).toBe("Expired");
    expect(ttlLabel(93_784_000)).toBe("1d 2h");
    expect(ttlLabel(42_000)).toBe("42s");
    expect(sizeLabel(1536)).toBe("1.5 KB");
    expect(kindMeta("zset").short).toBe("ZSET");
    expect(kindMeta("TSDB-TYPE").short).toBe("TSDB");
  });

  it("creates keys of every type with their first value and expiry", () => {
    const v = { value: "Ada", field: "name", score: "1.5" };
    expect(newKeyCommands("hash", "user:1", v, null)).toEqual([["HSET", "user:1", "name", "Ada"]]);
    expect(newKeyCommands("zset", "rank", v, 60)).toEqual([
      ["ZADD", "rank", "1.5", "Ada"],
      ["EXPIRE", "rank", "60"],
    ]);
    expect(newKeyCommands("stream", "events", v, null)).toEqual([["XADD", "events", "*", "name", "Ada"]]);
    expect(newKeyCommands("ReJSON-RL", "doc", { ...v, value: "{}" }, null)).toEqual([["JSON.SET", "doc", "$", "{}"]]);
  });
});

describe("Redis server information", () => {
  it("parses INFO sections", () => {
    const s = parseInfo(
      "# Server\r\nredis_version:8.0.0\r\nredis_mode:standalone\r\n\r\n# Keyspace\r\ndb0:keys=8,expires=1,avg_ttl=0\r\n",
    );
    expect(s.map((x) => x.name)).toEqual(["Server", "Keyspace"]);
    expect(s[0]!.fields).toEqual([
      ["redis_version", "8.0.0"],
      ["redis_mode", "standalone"],
    ]);
  });

  it("parses the slow log and the client list", () => {
    const int = (text: string) => ({ kind: "int" as const, text });
    const bulk = (text: string) => ({ kind: "bulk" as const, value: { text, binary: false } });
    expect(
      parseSlowlog({
        kind: "array",
        items: [
          {
            kind: "array",
            items: [
              int("7"),
              int("1700000000"),
              int("12500"),
              { kind: "array", items: [bulk("KEYS"), bulk("*")] },
              bulk("127.0.0.1:5000"),
              bulk(""),
            ],
          },
        ],
      }),
    ).toEqual([{ id: "7", time: 1_700_000_000_000, micros: 12500, command: "KEYS *", client: "127.0.0.1:5000" }]);
    expect(parseClients("id=3 addr=127.0.0.1:5000 name= db=0 cmd=client|list\n")).toEqual([
      { id: "3", addr: "127.0.0.1:5000", name: "", db: "0", cmd: "client|list" },
    ]);
  });
});

describe("Redis command statistics", () => {
  it("ranks the busiest commands with their average time", () => {
    const sections = parseInfo(
      "# Commandstats\r\ncmdstat_set:calls=3,usec=9,usec_per_call=3.00\r\ncmdstat_get:calls=10,usec=20,usec_per_call=2.00\r\ncmdstat_client|list:calls=1,usec=30,usec_per_call=30.00\r\ncmdstat_ping:calls=0,usec=0,usec_per_call=0.00\r\n",
    );
    expect(commandStats(sections)).toEqual([
      { name: "GET", calls: 10, usecPerCall: 2 },
      { name: "SET", calls: 3, usecPerCall: 3 },
      { name: "CLIENT LIST", calls: 1, usecPerCall: 30 },
    ]);
  });
});
