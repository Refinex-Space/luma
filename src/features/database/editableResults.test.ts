import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbStatementOutcome, SqlStatement } from "@/platform/ipc";
import { emptyEdits } from "./model";
import { addRow, deleteRows, editCount, editedValue, revertCells, setCell } from "./rowEdits";
import { mapResultColumns, queryTableOf } from "./sql/editable";
import { resolveResultEdit, submitResultEdits, useDatabase, type ResultTab } from "./store";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), details: vi.fn(), apply: vi.fn(), completion: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    call: (value: unknown) => value,
    commands: {
      ...real.commands,
      dbExecute: mocks.execute,
      dbTableDetails: mocks.details,
      dbApplyEdits: mocks.apply,
      dbCompletion: mocks.completion,
    },
  };
});

const table = [
  { name: "id", dataType: "bigint", nullable: false, default: null, primaryKey: true },
  { name: "status", dataType: "varchar", nullable: false, default: null, primaryKey: false },
  { name: "total", dataType: "decimal", nullable: true, default: null, primaryKey: false },
];

describe("which results can be edited", () => {
  it("takes plain single-table queries", () => {
    expect(queryTableOf("select * from orders where total > 1", "mysql")).toEqual({ schema: null, name: "orders" });
    expect(queryTableOf("SELECT o.id FROM shop.orders o", "postgres")).toEqual({ schema: "shop", name: "orders" });
    expect(queryTableOf("select * from orders o join customer c on c.id = o.customer_id", "mysql")).toBeNull();
    expect(queryTableOf("select id from a union select id from a", "mysql")).toBeNull();
    expect(queryTableOf("with x as (select * from orders) select * from x", "postgres")).toBeNull();
    expect(queryTableOf("select * from orders for update", "postgres")).toBeNull();
    expect(queryTableOf("show tables", "mysql")).toBeNull();
  });

  it("needs the whole primary key; expressions stay read-only", () => {
    expect(mapResultColumns(["ID", "status", "total * 2"], table)).toEqual({
      columns: ["id", "status", null],
      primaryKey: ["id"],
    });
    expect(mapResultColumns(["status", "total"], table)).toBeNull();
    expect(mapResultColumns(["id", "id"], table)).toBeNull();
  });
});

describe("pending edits", () => {
  const rows = [
    ["1", "PAID", "10"],
    ["2", "NEW", null],
  ];
  const names = ["id", "status", null];

  it("edits, adds, deletes and reverts over the loaded rows", () => {
    let e = setCell(emptyEdits(), rows, names, 0, 1, "SHIPPED");
    expect(editedValue(e, rows, names, 0, 1)).toBe("SHIPPED");
    // Expression columns take no edit.
    expect(setCell(e, rows, names, 0, 2, "x")).toBe(e);
    // Back to the loaded value: no edit left.
    expect(setCell(e, rows, names, 0, 1, "PAID").updates.size).toBe(0);
    e = addRow(e, names, (c) => rows[1]![c] ?? null);
    expect(editedValue(e, rows, names, 2, 1)).toBe("NEW");
    e = deleteRows(e, 2, [1]);
    expect(editCount(e)).toBe(3);
    e = revertCells(e, names, 2, [0, 1, 2], [0, 1, 2]);
    expect(editCount(e)).toBe(0);
  });
});

describe("editable query results", () => {
  const statement: SqlStatement = { from: 0, to: 26, text: "select id, status from orders" };
  const outcome: DbStatementOutcome = {
    statement,
    error: null,
    result: {
      statement: statement.text,
      columns: [
        { name: "id", typeName: "BIGINT" },
        { name: "status", typeName: "VARCHAR" },
      ],
      rows: [
        ["1", "PAID"],
        ["2", "NEW"],
      ],
      affected: null,
      hasMore: false,
      elapsedMs: 1,
      executionMs: 1,
    } as DbStatementOutcome["result"],
  };
  const tab = (): ResultTab => ({ id: 3, title: "Result 3", path: "/c.sql", sourceId: "my:luma", outcome });

  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
    mocks.completion.mockResolvedValue({ defaultSchema: "luma", tables: [], foreignKeys: [] });
    mocks.details.mockResolvedValue({ columns: table, indexes: [], foreignKeys: [], triggers: [] });
    useDatabase.setState({
      sources: [{ id: "my", name: "luma-mysql", driver: "mysql", host: "127.0.0.1" }],
      connected: new Set(["my:luma"]),
      results: [tab()],
      details: {},
      completion: {},
      output: [],
    });
  });

  it("resolves the table in the console's database and submits by primary key", async () => {
    await resolveResultEdit(3);
    expect(mocks.details).toHaveBeenCalledWith("my:luma", "luma", "orders");
    const edit = useDatabase.getState().results[0]!.edit!;
    expect(edit).toMatchObject({ schema: "luma", table: "orders", primaryKey: ["id"], columns: ["id", "status"] });

    const rows = outcome.result!.rows;
    let e = setCell(emptyEdits(), rows, edit.columns, 1, 1, "SHIPPED");
    e = deleteRows(e, 2, [0]);
    useDatabase.setState((s) => ({ results: s.results.map((r) => ({ ...r, edits: e })) }));
    mocks.apply.mockResolvedValue(2);
    mocks.execute.mockResolvedValue([outcome]);
    expect(await submitResultEdits(3)).toBe(true);
    expect(mocks.apply).toHaveBeenCalledWith("my:luma", "luma", "orders", [
      { kind: "update", key: [{ column: "id", value: "2" }], values: [{ column: "status", value: "SHIPPED" }] },
      { kind: "delete", key: [{ column: "id", value: "1" }] },
    ]);
    // Re-queried, nothing pending.
    expect(mocks.execute).toHaveBeenCalled();
    expect(useDatabase.getState().results[0]!.edits).toBeUndefined();
  });

  it("keeps read-only data sources and keyless results read-only", async () => {
    useDatabase.setState({ sources: [{ id: "my", name: "m", driver: "mysql", host: "h", readOnly: true }] });
    await resolveResultEdit(3);
    expect(useDatabase.getState().results[0]!.edit).toBeNull();
    expect(mocks.details).not.toHaveBeenCalled();
  });
});
