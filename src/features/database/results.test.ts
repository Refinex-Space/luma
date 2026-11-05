import { beforeEach, expect, it, vi } from "vitest";
import type { DbStatementOutcome, SqlStatement } from "@/platform/ipc";
import { countResult, fetchAllRows, pageResult, rerunResult, sortResult, useDatabase, type ResultTab } from "./store";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    call: (value: unknown) => value,
    commands: { ...real.commands, dbExecute: mocks.execute },
  };
});

const statement: SqlStatement = { from: 0, to: 22, text: "select * from orders;" };
const page = (rows: string[][], hasMore: boolean): DbStatementOutcome => ({
  statement,
  error: null,
  result: {
    statement: statement.text,
    columns: [
      { name: "id", typeName: "BIGINT" },
      { name: "status", typeName: "VARCHAR" },
    ],
    rows,
    affected: null,
    hasMore,
    elapsedMs: 1,
    executionMs: 1,
  } as DbStatementOutcome["result"],
});

function tab(shape: Partial<ResultTab["shape"]> = {}): ResultTab {
  return {
    id: 7,
    title: "Result 7",
    path: "/c.sql",
    sourceId: "my:luma",
    outcome: page([["1", "PAID"]], true),
    shape: { sort: [], offset: 0, pageSize: 2, total: null, fixed: false, ...shape },
  };
}

const sent = () => (mocks.execute.mock.calls.at(-1)![2] as SqlStatement[])[0]!.text;
const maxRows = () => mocks.execute.mock.calls.at(-1)![3] as number;
const current = () => useDatabase.getState().results[0]!;

beforeEach(() => {
  mocks.execute.mockReset();
  useDatabase.setState({
    sources: [{ id: "my", name: "luma-mysql", driver: "mysql", host: "127.0.0.1" }],
    connected: new Set(["my:luma"]),
    results: [tab()],
    output: [],
  });
});

it("sorts every row of the query with ORDER BY, from the first page", async () => {
  useDatabase.setState({ results: [tab({ offset: 2 })] });
  mocks.execute.mockResolvedValue([page([["9", "NEW"]], true)]);
  await sortResult(7, [{ column: "status", descending: true }]);
  expect(sent()).toBe("SELECT * FROM (\nselect * from orders\n) luma_q ORDER BY 2 DESC LIMIT 3");
  expect(maxRows()).toBe(2);
  expect(current().shape).toMatchObject({ sort: [{ column: "status", descending: true }], offset: 0 });
  // The tab keeps the statement the user ran.
  expect(current().outcome.statement.text).toBe("select * from orders;");
  expect(current().outcome.result?.rows).toEqual([["9", "NEW"]]);
});

it("pages forward, counts the rows and jumps to the last page", async () => {
  mocks.execute.mockResolvedValueOnce([page([["3", "x"]], true)]);
  await pageResult(7, "next");
  expect(sent()).toBe("SELECT * FROM (\nselect * from orders\n) luma_q LIMIT 3 OFFSET 2");
  expect(current().shape?.offset).toBe(2);

  mocks.execute.mockResolvedValueOnce([page([["5"]], false)]);
  mocks.execute.mockResolvedValueOnce([page([["5", "y"]], false)]);
  await pageResult(7, "last");
  expect(mocks.execute.mock.calls.at(-2)![2][0].text).toBe("SELECT COUNT(*) FROM (\nselect * from orders\n) luma_q");
  expect(sent()).toBe("SELECT * FROM (\nselect * from orders\n) luma_q LIMIT 3 OFFSET 4");
  expect(current().shape).toMatchObject({ offset: 4, total: 5 });
});

it("counts on demand and re-queries the same page on rerun", async () => {
  mocks.execute.mockResolvedValueOnce([page([["42"]], false)]);
  await countResult(7);
  expect(current().shape?.total).toBe(42);
  mocks.execute.mockResolvedValueOnce([page([["1", "PAID"]], true)]);
  await rerunResult(7);
  // The first page, unsorted: the statement as written.
  expect(sent()).toBe("select * from orders;");
  expect(current().shape?.total).toBeNull();
});

it("leaves statements it cannot re-query alone", async () => {
  useDatabase.setState({ results: [tab({ fixed: true })] });
  await sortResult(7, [{ column: "id", descending: false }]);
  await pageResult(7, "next");
  expect(mocks.execute).not.toHaveBeenCalled();
});

it("fetches all rows for Export Data in the current sort", async () => {
  useDatabase.setState({ results: [tab({ sort: [{ column: "id", descending: false }] })] });
  mocks.execute.mockResolvedValueOnce([page([["1"], ["2"]], false)]);
  const all = await fetchAllRows(7);
  expect(sent()).toBe("SELECT * FROM (\nselect * from orders\n) luma_q ORDER BY 1 LIMIT 100001");
  expect(all?.rows).toHaveLength(2);
});
