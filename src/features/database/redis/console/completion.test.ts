import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { REDIS_COMMANDS, commandDoc, findCommand, isContainer, isKeyPosition, optionWords } from "./commands";
import { argText, argumentAt, argumentKind, keyPattern, redisCompletionSource } from "./completion";

const mocks = vi.hoisted(() => ({ scan: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    call: (value: unknown) => value,
    commands: { ...real.commands, redisScan: mocks.scan },
  };
});

describe("catalogue", () => {
  it("covers the common command set, each named once", () => {
    expect(REDIS_COMMANDS.length).toBeGreaterThan(250);
    const names = REDIS_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const g of ["string", "generic", "hash", "list", "set", "sorted-set", "stream", "pubsub", "scripting"])
      expect(REDIS_COMMANDS.some((c) => c.group === g)).toBe(true);
    for (const c of REDIS_COMMANDS) {
      expect(c.name).toBe(c.name.toUpperCase());
      expect(c.since).toMatch(/^\d+\.\d+\.\d+$/);
      expect(c.summary).not.toBe("");
    }
  });

  it("finds subcommands before their container", () => {
    expect(findCommand(["config", "get", "maxmemory"])?.name).toBe("CONFIG GET");
    expect(findCommand(["XINFO", "STREAM", "s"])?.name).toBe("XINFO STREAM");
    expect(findCommand(["COMMAND"])?.name).toBe("COMMAND");
    expect(findCommand(["hset", "h"])?.name).toBe("HSET");
    expect(findCommand(["NOPE"])).toBeNull();
    expect(isContainer("client")).toBe(true);
    expect(isContainer("GET")).toBe(false);
    expect(commandDoc("json.set")?.group).toBe("json");
  });

  it("knows the option words of a synopsis", () => {
    expect(optionWords(commandDoc("SET")!)).toEqual(
      expect.arrayContaining(["NX", "XX", "GET", "EX", "PX", "EXAT", "PXAT", "KEEPTTL"]),
    );
    expect(optionWords(commandDoc("ZRANGE")!)).toContain("WITHSCORES");
  });
});

describe("key positions", () => {
  const keyAt = (line: string, index: number) => {
    const words = line.split(" ");
    return isKeyPosition(findCommand(words)!, words, index);
  };

  it("reads first / last / step specs", () => {
    expect(keyAt("GET k", 1)).toBe(true);
    expect(keyAt("SET k v", 2)).toBe(false);
    expect(keyAt("DEL a b c", 3)).toBe(true);
    expect(keyAt("MSET a 1 b 2", 3)).toBe(true);
    expect(keyAt("MSET a 1 b 2", 4)).toBe(false);
    expect(keyAt("RENAME a b", 2)).toBe(true);
    expect(keyAt("BLPOP a b 0", 2)).toBe(true);
    expect(keyAt("OBJECT ENCODING k", 2)).toBe(true);
    expect(keyAt("MEMORY USAGE k", 1)).toBe(false);
  });

  it("counts numkeys", () => {
    expect(keyAt("EVAL s 2 a b c", 3)).toBe(true);
    expect(keyAt("EVAL s 2 a b c", 4)).toBe(true);
    expect(keyAt("EVAL s 2 a b c", 5)).toBe(false);
    expect(keyAt("ZUNIONSTORE d 2 a b", 1)).toBe(true);
    expect(keyAt("ZUNIONSTORE d 2 a b", 4)).toBe(true);
    expect(keyAt("ZUNIONSTORE d 2 a b", 2)).toBe(false);
  });

  it("finds stream keys after STREAMS until the first id", () => {
    expect(keyAt("XREAD COUNT 2 STREAMS s1 s2", 5)).toBe(true);
    expect(keyAt("XREAD COUNT 2 STREAMS s1 0", 6)).toBe(false);
    expect(keyAt("XREAD COUNT 2 STREAMS s1", 2)).toBe(false);
  });
});

describe("argumentAt", () => {
  it("finds the word being typed and its index", () => {
    expect(argumentAt("hg", 10)).toEqual({ words: [], index: 0, prefix: "hg", from: 10 });
    expect(argumentAt("HGET ", 0)).toEqual({ words: ["HGET"], index: 1, prefix: "", from: 5 });
    expect(argumentAt("HGET us", 0)).toEqual({ words: ["HGET"], index: 1, prefix: "us", from: 5 });
  });

  it("leaves comments and quoted words alone", () => {
    expect(argumentAt("# GET", 0)).toBeNull();
    expect(argumentAt('GET "us', 0)).toBeNull();
    expect(argumentAt('GET "us"', 0)).toBeNull();
  });

  it("tells keys from other arguments", () => {
    expect(argumentKind(["HSET"], 1)?.keys).toBe(true);
    expect(argumentKind(["HSET", "h"], 2)?.keys).toBe(false);
    expect(argumentKind(["FOO"], 1)).toBeNull();
  });
});

it("writes keys as command line words", () => {
  expect(argText({ text: "user:1", binary: false })).toBe("user:1");
  expect(argText({ text: "a b", binary: false })).toBe('"a b"');
  expect(argText({ text: 'say "hi"', binary: false })).toBe('"say \\"hi\\""');
  expect(argText({ text: "ff00", binary: true })).toBe('"\\xff\\x00"');
  expect(argText({ text: "", binary: false })).toBe('""');
  expect(keyPattern("a*b?[c]")).toBe("a\\*b\\?\\[c\\]*");
});

describe("completion source", () => {
  beforeEach(() => mocks.scan.mockReset());

  async function complete(doc: string, explicit = false, target: string | null = "r:0") {
    const state = EditorState.create({ doc });
    const source = redisCompletionSource(() => target);
    return source(new CompletionContext(state, doc.length, explicit));
  }

  it("completes command names upper case, synopsis beside", async () => {
    const r = await complete("hge");
    const hget = r!.options.find((o) => o.label === "HGET")!;
    expect(hget.detail).toBe("key field");
    expect(r!.options.some((o) => o.label === "CONFIG GET")).toBe(true);
    // Listening commands are refused by the console.
    expect(r!.options.some((o) => o.label === "SUBSCRIBE")).toBe(false);
  });

  it("completes subcommands of a container", async () => {
    const r = await complete("CONFIG ", true);
    expect(r!.options.map((o) => o.label)).toEqual(["GET", "RESETSTAT", "REWRITE", "SET"]);
  });

  it("completes key names in key positions", async () => {
    mocks.scan.mockResolvedValue({
      cursor: "0",
      done: true,
      keys: [
        { key: { text: "user:1", binary: false }, kind: "hash", ttlMs: -1, memory: null },
        { key: { text: "user 2", binary: false }, kind: "string", ttlMs: -1, memory: null },
      ],
    });
    const r = await complete("HGETALL us");
    expect(mocks.scan).toHaveBeenCalledWith("r:0", "us*", null, "0", 100);
    expect(r!.options.map((o) => [o.label, o.apply])).toEqual([
      ["user:1", "user:1"],
      ["user 2", '"user 2"'],
    ]);
    expect(r!.validFor).toBeTruthy();
  });

  it("completes option words elsewhere, keys never without a data source", async () => {
    const r = await complete("SET k v E");
    expect(r!.options.map((o) => o.label)).toContain("EX");
    expect(await complete("GET k", false, null)).toBeNull();
    expect(mocks.scan).not.toHaveBeenCalled();
  });
});
