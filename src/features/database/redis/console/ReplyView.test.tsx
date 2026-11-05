import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RedisCommandOutcome, RedisReply } from "@/platform/ipc";
import { useDatabase } from "../../store";
import { RedisReplyView } from "./ReplyView";
import { cliText, isTrivialReply, replyLayout, replySummary } from "./reply";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 24,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 24, key: index })),
    scrollToIndex: () => {},
    measureElement: () => {},
  }),
}));

const bulk = (text: string): RedisReply => ({ kind: "bulk", value: { text, binary: false } });
const array = (...items: RedisReply[]): RedisReply => ({ kind: "array", items });
const int = (text: string): RedisReply => ({ kind: "int", text });

const outcome = (text: string, reply: RedisReply): RedisCommandOutcome => ({
  from: 0,
  to: text.length,
  text,
  reply,
  error: null,
  elapsedMs: 2,
  select: null,
  writes: false,
});

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  useDatabase.setState({ sources: [{ id: "r", name: "cache", driver: "redis", host: "127.0.0.1" }] });
});

describe("reply text", () => {
  it("prints replies like redis-cli", () => {
    expect(cliText({ kind: "nil" })).toBe("(nil)");
    expect(cliText(int("3"))).toBe("(integer) 3");
    expect(cliText(bulk('a "b"\n'))).toBe('"a \\"b\\"\\n"');
    expect(cliText({ kind: "bulk", value: { text: "ff00", binary: true } })).toBe('"\\xff\\x00"');
    expect(cliText(array())).toBe("(empty array)");
    expect(cliText(array(bulk("a"), array(bulk("b"), int("1"))))).toBe('1) "a"\n2) 1) "b"\n   2) (integer) 1');
    expect(cliText({ kind: "map", entries: [{ key: bulk("f"), value: bulk("v") }] })).toBe('1# "f" => "v"');
  });

  it("keeps simple replies in Output and summarizes the rest", () => {
    expect(isTrivialReply({ kind: "status", text: "OK" })).toBe(true);
    expect(isTrivialReply(bulk("short"))).toBe(true);
    expect(isTrivialReply(bulk('{"a":1}'))).toBe(false);
    expect(isTrivialReply(bulk("x".repeat(500)))).toBe(false);
    expect(isTrivialReply(array())).toBe(true);
    expect(isTrivialReply(array(bulk("a")))).toBe(false);
    expect(replySummary(array(bulk("a"), bulk("b")), 3)).toBe("2 items retrieved in 3 ms");
    expect(replySummary(int("7"), 1)).toBe("(integer) 7");
  });

  it("lays out pairs by command", () => {
    const flat = array(bulk("f1"), bulk("v1"), bulk("f2"), bulk("v2"));
    expect(replyLayout(flat, "HGETALL h")).toEqual({
      kind: "pairs",
      columns: ["field", "value"],
      rows: [
        ["f1", "v1"],
        ["f2", "v2"],
      ],
    });
    expect(replyLayout(flat, "ZRANGE z 0 -1 WITHSCORES").kind).toBe("pairs");
    expect(replyLayout(flat, "LRANGE l 0 -1")).toEqual({ kind: "list", columns: ["index", "value"] });
    expect(replyLayout(array(array(bulk("m"), bulk("1"))), "ZRANGE z 0 -1 WITHSCORES").kind).toBe("pairs");
    expect(replyLayout(array(array(bulk("m"))), "XRANGE s - +").kind).toBe("tree");
    expect(replyLayout(bulk("x"), "GET k").kind).toBe("text");
  });
});

describe("RedisReplyView", () => {
  it("shows scalars as an index / value grid", () => {
    render(<RedisReplyView outcome={outcome("LRANGE l 0 -1", array(bulk("a"), bulk("b")))} target="r:0" />);
    const cells = screen.getAllByRole("gridcell").map((c) => c.textContent);
    expect(cells).toEqual(expect.arrayContaining(["0", "a", "1", "b"]));
    expect(screen.getByText("cache: db0")).toBeTruthy();
  });

  it("shows pairs as a field / value grid", () => {
    render(<RedisReplyView outcome={outcome("HGETALL h", array(bulk("name"), bulk("Ada")))} target="r:2" />);
    expect(screen.getByRole("columnheader", { name: /field/ })).toBeTruthy();
    expect(screen.getAllByRole("gridcell").map((c) => c.textContent)).toEqual(expect.arrayContaining(["name", "Ada"]));
  });

  it("shows nested replies as a tree, copied as redis-cli prints them", async () => {
    const reply = array(array(bulk("1-0"), array(bulk("f"), bulk("v"))));
    render(<RedisReplyView outcome={outcome("XRANGE s - +", reply)} target="r:0" />);
    expect(screen.getByRole("tree")).toBeTruthy();
    expect(screen.getByText('"1-0"')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy as redis-cli Output" })));
    expect(writeText).toHaveBeenCalledWith(cliText(reply));
  });

  it("pretty-prints a JSON string and switches to its text", async () => {
    render(<RedisReplyView outcome={outcome("GET doc", bulk('{"a":[1,2]}'))} target="r:0" />);
    const text = () => screen.getByLabelText("GET doc").textContent;
    expect(text()).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Text" })));
    expect(text()).toBe('{"a":[1,2]}');
    expect(screen.getByRole("button", { name: "JSON" }).hasAttribute("disabled")).toBe(false);
  });

  it("offers no JSON view of plain text", () => {
    render(
      <RedisReplyView outcome={outcome("INFO", { kind: "verbatim", format: "txt", text: "a\nb" })} target="r:0" />,
    );
    expect(screen.getByRole("button", { name: "JSON" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText("INFO").textContent).toBe("a\nb");
  });
});
