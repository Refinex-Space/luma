import { describe, expect, it } from "vitest";
import type { RedisKeyEntry } from "@/platform/ipc";
import { folderPattern, indexKeys } from "./tree";

const k = (text: string, kind = "string", binary = false): RedisKeyEntry => ({
  key: { text, binary },
  kind,
  ttlMs: -1,
  memory: null,
});

describe("Redis key tree", () => {
  it("groups keys into folders by the separator, counting keys at any depth", () => {
    const idx = indexKeys(
      [
        k("user:2:profile", "hash"),
        k("user:10:profile", "hash"),
        k("user:2:cart", "list"),
        k("config"),
        k("ff00", "string", true),
      ],
      ":",
    );
    const top = idx.levels.get("")!;
    expect(top.folders).toEqual([{ name: "user", prefix: "user:", count: 3 }]);
    expect(top.keys.map((x) => x.name)).toEqual(["config", "ff00"]);
    // Numeric segments sort naturally.
    expect(idx.levels.get("user:")!.folders.map((f) => [f.name, f.count])).toEqual([
      ["2", 2],
      ["10", 1],
    ]);
    expect(idx.levels.get("user:2:")!.keys.map((x) => x.name)).toEqual(["cart", "profile"]);
  });

  it("escapes glob characters of a folder's pattern", () => {
    expect(folderPattern("cache[1]:")).toBe("cache\\[1\\]:*");
  });
});
