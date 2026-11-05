import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { DataSource, RedisCommandInput, RedisCommandOutcome } from "@/platform/ipc";
import { OUTPUT_TAB, bindConsole, useDatabase } from "../../store";
import { executeRedisInView, redisConsoleExtension, redisConsoleTarget } from "./RedisConsole";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), keyspace: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    call: (value: unknown) => value,
    commands: { ...real.commands, redisExecute: mocks.execute, redisKeyspace: mocks.keyspace },
  };
});
vi.mock("@/workbench/contributions", async (original) => {
  const real = await original<typeof import("@/workbench/contributions")>();
  return { ...real, toolWindowService: () => ({ show: () => {} }) };
});

const PATH = "/consoles/db/r/console.redis";
const redis: DataSource = { id: "r", name: "cache", driver: "redis", host: "127.0.0.1", database: "" };
const sqlite: DataSource = { id: "s", name: "local", driver: "sqlite", host: "" };

let view: EditorView | null = null;

async function mount(doc: string) {
  await act(async () => {
    view = new EditorView({
      parent: document.body.appendChild(document.createElement("div")),
      state: EditorState.create({
        doc,
        extensions: redisConsoleExtension({ doc: 1, path: PATH, language: "redis", uiMode: "Redis", readOnly: false }),
      }),
    });
  });
  return view!;
}

/** Answers each command as the backend would: `SELECT n` with `select`, the rest `OK`. */
function answer(_request: number, _target: string, inputs: RedisCommandInput[]): RedisCommandOutcome[] {
  return inputs.map((c) => {
    const name = c.args[0]!.text.toUpperCase();
    return {
      from: c.from,
      to: c.to,
      text: c.args.map((a) => a.text).join(" "),
      reply:
        name === "LRANGE"
          ? { kind: "array", items: [{ kind: "bulk", value: { text: "a" } }] }
          : { kind: "status", text: "OK" },
      error: null,
      elapsedMs: 1,
      select: name === "SELECT" ? Number(c.args[1]!.text) : null,
      writes: false,
    };
  });
}

beforeEach(() => {
  mocks.execute.mockImplementation(async (...a: Parameters<typeof answer>) => answer(...a));
  mocks.keyspace.mockResolvedValue({
    databases: [
      { index: 0, keys: 12, expires: 0 },
      { index: 1, keys: 0, expires: 0 },
    ],
    version: "8.0.0",
    mode: "standalone",
  });
  useDatabase.setState({
    sources: [sqlite, redis],
    loaded: true,
    consoles: {},
    connected: new Set(["r:0", "r:3"]),
    results: [],
    output: [],
    running: {},
  });
});

afterEach(() => {
  act(() => view?.destroy());
  view = null;
  document.body.innerHTML = "";
});

it("runs on the only Redis data source, never a SQL one", () => {
  expect(redisConsoleTarget(PATH)).toBe("r:0");
  bindConsole(PATH, "s");
  expect(redisConsoleTarget(PATH)).toBe("r:0");
  bindConsole(PATH, "r:4");
  expect(redisConsoleTarget(PATH)).toBe("r:4");
});

it("shows the data source and its databases with key counts", async () => {
  bindConsole(PATH, "r:0");
  await mount("PING");
  expect(mocks.keyspace).toHaveBeenCalledWith("r");
  expect(screen.getByRole("button", { name: "Data source" }).textContent).toContain("cache");
  await vi.waitFor(() => expect(screen.getByRole("button", { name: "Database" }).textContent).toContain("db0"));
});

it("runs the caret's command and opens a result tab for collections", async () => {
  const v = await mount("SET k v\nLRANGE l 0 -1");
  act(() => v.dispatch({ selection: EditorSelection.cursor(v.state.doc.length) }));
  await act(() => executeRedisInView(v, PATH));
  expect(mocks.execute).toHaveBeenCalledTimes(1);
  expect(mocks.execute.mock.calls[0]![1]).toBe("r:0");
  expect((mocks.execute.mock.calls[0]![2] as RedisCommandInput[]).map((c) => c.args.map((a) => a.text))).toEqual([
    ["LRANGE", "l", "0", "-1"],
  ]);
  const s = useDatabase.getState();
  expect(s.results).toHaveLength(1);
  expect(s.results[0]!.redis?.outcome.text).toBe("LRANGE l 0 -1");
  expect(s.activeResult).toBe(s.results[0]!.id);
  expect(s.output.map((l) => l.text)).toEqual(["LRANGE l 0 -1", "1 item retrieved in 1 ms"]);
  expect(v.dom.querySelector(".cm-luma-db-timing")?.textContent).toBe("1 ms");
});

it("moves to the selected database after SELECT, for the rest of the run too", async () => {
  const v = await mount("SELECT 3\nSET k v");
  act(() => v.dispatch({ selection: EditorSelection.range(0, v.state.doc.length) }));
  await act(() => executeRedisInView(v, PATH));
  expect(mocks.execute.mock.calls.map((c) => c[1])).toEqual(["r:0", "r:3"]);
  expect(redisConsoleTarget(PATH)).toBe("r:3");
  const s = useDatabase.getState();
  expect(s.results).toEqual([]);
  expect(s.activeResult).toBe(OUTPUT_TAB);
  expect(s.output.map((l) => [l.prompt ?? "", l.text])).toEqual([
    ["db0>", "SELECT 3"],
    ["", "OK"],
    ["db3>", "SET k v"],
    ["", "OK"],
  ]);
});

it("does not send a line with unbalanced quotes", async () => {
  const v = await mount('SET k "v');
  await act(() => executeRedisInView(v, PATH));
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(v.dom.querySelector(".cm-luma-db-banner")?.textContent).toContain("Unbalanced quotes");
});
