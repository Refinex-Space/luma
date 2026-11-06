import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  dbCatalog: vi.fn(),
  dbConnect: vi.fn(),
  dbSchemas: vi.fn(),
  dbTables: vi.fn(),
  dbSchemaObjects: vi.fn(),
  dbTableDetails: vi.fn(),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, ...ipc } };
});

import type { DataSource, DbCatalog, DbCatalogObject } from "@/platform/ipc";
import { _resetCatalogs } from "./catalog";
import { databaseHits, matchObject, searchDatabase } from "./search";
import { refresh, useDatabase } from "./store";
import { useRedis } from "./redis/store";
import { provideToolWindowService } from "@/workbench/contributions";

const show = vi.fn();
provideToolWindowService({ show } as never);

const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });
const o = (
  kind: DbCatalogObject["kind"],
  schema: string,
  table: string,
  name: string,
  detail = "",
): DbCatalogObject => ({
  kind,
  schema,
  table,
  name,
  detail,
});

const CATALOG: DbCatalog = {
  at: 1,
  truncated: false,
  schemas: ["information_schema", "luma", "performance_schema"],
  objects: [
    o("table", "luma", "", "orders"),
    o("table", "luma", "", "order_item"),
    o("view", "luma", "", "order_summary"),
    o("column", "luma", "order_item", "order_id", "bigint"),
    o("foreignKey", "luma", "order_item", "fk_item_order", "orders"),
    o("foreignKey", "luma", "orders", "fk_orders_customer", "customer"),
    o("index", "luma", "orders", "fk_orders_customer"),
    o("index", "luma", "orders", "idx_orders_status"),
    o("function", "luma", "", "order_total", "o bigint"),
    o("function", "luma", "", "order_total", "o bigint, c text"),
    o("column", "information_schema", "TRIGGERS", "ACTION_ORDER", "bigint"),
    o("table", "luma", "", "customer"),
  ],
};

const source = (patch: Partial<DataSource> = {}): DataSource =>
  ({ id: "my", name: "@localhost", driver: "mysql", ...patch }) as DataSource;

beforeEach(() => {
  _resetCatalogs();
  useDatabase.setState({ sources: [source()], loaded: true, connected: new Set(), databases: {} });
  useRedis.setState({ keys: {} });
});
afterEach(() => vi.clearAllMocks());

describe("matching database objects", () => {
  it("matches names word by word, and dotted queries against the qualified name", () => {
    expect(matchObject("order_item", "luma.order_item", "item")?.indices).toEqual([6, 7, 8, 9]);
    expect(matchObject("ACTION_ORDER", "information_schema.TRIGGERS.ACTION_ORDER", "order")).not.toBeNull();
    // Scattered letters across words don't match (IDEA's name matcher).
    expect(matchObject("customer", "luma.customer", "cmr")).toBeNull();
    const dotted = matchObject("orders", "luma.orders", "luma.ord");
    expect(dotted?.indices).toEqual([0, 1, 2]);
    expect(matchObject("orders", "shop.orders", "luma.ord")).toBeNull();
  });
});

describe("Search Everywhere's database objects", () => {
  it("reads the saved catalog without connecting and ranks objects by match", async () => {
    ipc.dbCatalog.mockReturnValue(ok(CATALOG));
    const emit = vi.fn();
    await searchDatabase("order", 50, emit);
    expect(ipc.dbCatalog).toHaveBeenCalledWith("my", false);
    expect(ipc.dbCatalog).not.toHaveBeenCalledWith("my", true);
    const last = emit.mock.lastCall![0] as ReturnType<typeof databaseHits>;
    const rows = last.items.map((i) => `${i.name} ${i.container} [${i.source}]`);
    expect(rows.slice(0, 2)).toEqual(["orders luma [@localhost]", "order_id luma.order_item [@localhost]"]);
    expect(rows).toContain("ACTION_ORDER information_schema.TRIGGERS [@localhost]");
    expect(rows).toContain("fk_item_order luma.order_item [@localhost]");
    // A key and an index of the same name are two objects; overloads are one.
    expect(rows.filter((r) => r.startsWith("fk_orders_customer "))).toHaveLength(2);
    expect(rows.filter((r) => r.startsWith("order_total "))).toHaveLength(1);
    expect(rows.some((r) => r.startsWith("customer "))).toBe(false);
    expect(last.items.find((i) => i.name === "order_summary")?.icon).toBe("db-view");
  });

  it("follows the Schemas tab and the object filter", async () => {
    ipc.dbCatalog.mockReturnValue(ok(CATALOG));
    useDatabase.setState({
      sources: [
        source({
          introspection: {
            allDatabases: true,
            databases: [],
            allSchemas: false,
            schemas: ["luma"],
            showSystem: false,
            showTemplates: false,
            objectFilter: "order_*",
          },
        }),
      ],
    });
    const emit = vi.fn();
    await searchDatabase("order", 50, emit);
    const names = (emit.mock.lastCall![0] as ReturnType<typeof databaseHits>).items.map((i) => i.name);
    expect(names).toContain("order_id");
    expect(names).not.toContain("orders");
    expect(names).not.toContain("ACTION_ORDER");
  });

  it("introspects connected data sources once per session, and again after Refresh", async () => {
    ipc.dbCatalog.mockImplementation((_id: string, refresh: boolean) => ok(refresh ? CATALOG : null));
    ipc.dbSchemas.mockReturnValue(ok(["luma"]));
    useDatabase.setState({ connected: new Set(["my"]) });
    const emit = vi.fn();
    await searchDatabase("orders", 50, emit);
    await searchDatabase("order_item", 50, emit);
    expect(ipc.dbCatalog.mock.calls.filter(([, live]) => live)).toHaveLength(1);
    expect((emit.mock.lastCall![0] as ReturnType<typeof databaseHits>).items[0]?.name).toBe("order_item");
    await refresh("my");
    await searchDatabase("orders", 50, emit);
    expect(ipc.dbCatalog.mock.calls.filter(([, live]) => live)).toHaveLength(2);
  });

  it("selects a foreign key in the Database tree by its name", async () => {
    ipc.dbCatalog.mockReturnValue(ok(CATALOG));
    ipc.dbConnect.mockReturnValue(ok(null));
    ipc.dbSchemas.mockReturnValue(ok(["luma"]));
    ipc.dbTables.mockReturnValue(ok([{ name: "order_item", kind: "table" }]));
    ipc.dbSchemaObjects.mockReturnValue(ok({ routines: [], sequences: [] }));
    ipc.dbTableDetails.mockReturnValue(
      ok({
        columns: [{ name: "order_id", dataType: "bigint", nullable: false, default: null, primaryKey: true }],
        indexes: [],
        triggers: [],
        foreignKeys: [
          {
            name: "fk_item_product",
            schema: "luma",
            table: "order_item",
            columns: [],
            refSchema: "luma",
            refTable: "product",
            refColumns: [],
          },
          {
            name: "fk_item_order",
            schema: "luma",
            table: "order_item",
            columns: [],
            refSchema: "luma",
            refTable: "orders",
            refColumns: [],
          },
        ],
      }),
    );
    const emit = vi.fn();
    await searchDatabase("fk_item_order", 50, emit);
    const fk = (emit.mock.lastCall![0] as ReturnType<typeof databaseHits>).items[0]!;
    expect(fk.qualifiedName).toBe("luma.order_item.fk_item_order");
    fk.open();
    await vi.waitFor(() =>
      expect(useDatabase.getState().treeReveal?.key).toBe("my/luma/tables/order_item/foreignKeys/1"),
    );
    expect([...useDatabase.getState().treeExpanded]).toEqual(
      expect.arrayContaining(["my", "my/luma", "my/luma/tables", "my/luma/tables/order_item"]),
    );
    expect(fk.actions.map((a) => a.label)).toEqual(["Edit Data", "Go to DDL"]);
  });

  it("finds the Redis keys the tree loaded", () => {
    useDatabase.setState({ sources: [source({ id: "r", name: "0@localhost", driver: "redis" })] });
    useRedis.setState({
      keys: {
        "r:0": {
          pattern: "*",
          type: null,
          keys: [{ key: { text: "queue:orders", binary: false }, kind: "list" }],
          at: 0,
          cursor: "0",
          done: true,
          loading: false,
          error: null,
        } as never,
      },
    });
    const hit = databaseHits("orders", 10).items[0]!;
    expect([hit.name, hit.container, hit.source, hit.chip?.label]).toEqual([
      "queue:orders",
      "0",
      "0@localhost",
      "LIST",
    ]);
    hit.open();
    expect(useDatabase.getState().treeReveal?.key).toBe("r:0/k:queue:orders");
    expect([...useDatabase.getState().treeExpanded]).toEqual(expect.arrayContaining(["r", "r/db0", "r:0/f:queue:"]));
    expect(show).toHaveBeenLastCalledWith("database", true);
  });
});
