import { describe, expect, it } from "vitest";
import {
  effectiveExtractor,
  exportData,
  extractorOptions,
  redisArg,
  selectionData,
  sqlLiteral,
  type ExportData,
} from "./export";
import { cellMatcher, heat, imageUrl, nextSort, numberRange, parseGoTo, visibleRows } from "./resultView";
import { canReshape, countQuery, reshapeQuery } from "./sql/reshape";

const orders: ExportData = {
  columns: [
    { name: "id", type: "BIGINT", primaryKey: true },
    { name: "status", type: "VARCHAR" },
    { name: "total", type: "DECIMAL" },
    { name: "paid", type: "BOOLEAN" },
  ],
  rows: [
    ["1", "PAID", "658.00", "true"],
    ["2", "O'Hara", null, "false"],
  ],
  table: "orders",
  driver: "postgres",
};

describe("data extractors", () => {
  it("writes INSERT statements per row and as one multi-row statement", () => {
    expect(exportData("sql", orders)).toBe(
      [
        "INSERT INTO orders (id, status, total, paid) VALUES (1, 'PAID', 658.00, TRUE);",
        "INSERT INTO orders (id, status, total, paid) VALUES (2, 'O''Hara', NULL, FALSE);",
      ].join("\n"),
    );
    expect(exportData("sqlMultirow", { ...orders, schema: "shop" })).toBe(
      [
        "INSERT INTO shop.orders (id, status, total, paid)",
        "VALUES (1, 'PAID', 658.00, TRUE),",
        "       (2, 'O''Hara', NULL, FALSE);",
      ].join("\n"),
    );
  });

  it("writes UPDATE statements keyed by the primary key, else by every value", () => {
    expect(exportData("sqlUpdate", orders).split("\n")[1]).toBe(
      "UPDATE orders SET status = 'O''Hara', total = NULL, paid = FALSE WHERE id = 2;",
    );
    const noKey = { ...orders, columns: orders.columns.map((c) => ({ ...c, primaryKey: false })) };
    expect(exportData("sqlUpdate", noKey).split("\n")[1]).toBe(
      "UPDATE orders SET id = 2, status = 'O''Hara', total = NULL, paid = FALSE " +
        "WHERE id = 2 AND status = 'O''Hara' AND total IS NULL AND paid = FALSE;",
    );
  });

  it("quotes literals per dialect", () => {
    expect(sqlLiteral("a\\b'c", "text", "mysql")).toBe("'a\\\\b''c'");
    expect(sqlLiteral("上海", "text", "sqlServer")).toBe("N'上海'");
    expect(sqlLiteral("true", "boolean", "sqlServer")).toBe("1");
    expect(sqlLiteral("0xCAFE", "binary", "postgres")).toBe("'\\xcafe'::bytea");
    expect(sqlLiteral("0xCAFE", "binary", "sqlite")).toBe("X'CAFE'");
    expect(sqlLiteral("12abc", "number", "postgres")).toBe("'12abc'");
  });

  it("writes One Row, JSON, XML, HTML and a pretty text table", () => {
    expect(exportData("oneRow", { ...orders, columns: orders.columns.slice(0, 1), rows: [["1"], ["2"]] })).toBe("1, 2");
    expect(JSON.parse(exportData("json", orders))[1]).toEqual({ id: 2, status: "O'Hara", total: null, paid: false });
    expect(exportData("xml", { ...orders, rows: [orders.rows[1]!] })).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<data>",
        "  <row>",
        "    <id>2</id>",
        "    <status>O'Hara</status>",
        "    <total/>",
        "    <paid>false</paid>",
        "  </row>",
        "</data>",
      ].join("\n"),
    );
    expect(exportData("html", { ...orders, rows: [["1", "<b>", null, "true"]] })).toContain(
      "<tr><td>1</td><td>&lt;b&gt;</td><td><i>NULL</i></td><td>true</td></tr>",
    );
    expect(exportData("text", { ...orders, rows: [["1", "已付", "658.00", null]] })).toBe(
      [
        "+----+--------+--------+--------+",
        "| id | status | total  | paid   |",
        "+----+--------+--------+--------+",
        "|  1 | 已付   | 658.00 | <null> |",
        "+----+--------+--------+--------+",
      ].join("\n"),
    );
  });

  it("writes the CSV formats with quoting where needed", () => {
    const d = { ...orders, rows: [["1", "a;b", "2", "x|y"]] };
    expect(exportData("semicolon", d)).toBe('id;status;total;paid\n1;"a;b";2;x|y');
    expect(exportData("pipe", d)).toBe('id|status|total|paid\n1|a;b|2|"x|y"');
  });

  it("extracts the selected rows and columns only", () => {
    const value = (r: number, c: number) => orders.rows[r]![c] ?? null;
    const d = selectionData(orders, orders.columns, [1], [0, 1], value);
    expect(exportData("sql", d)).toBe("INSERT INTO orders (id, status) VALUES (2, 'O''Hara');");
  });

  it("lists the extractors in IDEA's sections", () => {
    const options = extractorOptions();
    expect(options.filter((o) => o.section).map((o) => o.label)).toEqual(["Built-in", "CSV"]);
    expect(options.findIndex((o) => o.value === "csv")).toBeGreaterThan(options.findIndex((o) => o.label === "CSV"));
  });
});

describe("Redis data", () => {
  const redis = (redisKind: string, columns: string[], rows: Array<Array<string | null>>): ExportData => ({
    columns: columns.map((name) => ({ name, type: "" })),
    rows,
    table: "user:1",
    driver: "redis",
    redisKind,
  });

  it("offers Redis commands, not SQL, and SQL grids no Redis commands", () => {
    const redisFormats = extractorOptions("redis").map((o) => o.value);
    expect(redisFormats).toContain("redis");
    expect(redisFormats).not.toContain("sql");
    expect(redisFormats).not.toContain("sqlUpdate");
    expect(redisFormats).toContain("csv");
    expect(extractorOptions("mysql").map((o) => o.value)).not.toContain("redis");
    // One preference for every grid: each reads its counterpart.
    expect(effectiveExtractor("sql", "redis")).toBe("redis");
    expect(effectiveExtractor("redis", "postgres")).toBe("sql");
    expect(effectiveExtractor("json", "redis")).toBe("json");
  });

  it("offers Elasticsearch data neither SQL nor Redis commands", () => {
    const esFormats = extractorOptions("elasticsearch").map((o) => o.value);
    expect(esFormats).toContain("json");
    expect(esFormats).toContain("csv");
    expect(esFormats).not.toContain("sql");
    expect(esFormats).not.toContain("sqlMultirow");
    expect(esFormats).not.toContain("sqlUpdate");
    expect(esFormats).not.toContain("oneRow");
    expect(esFormats).not.toContain("redis");
    expect(effectiveExtractor("sql", "elasticsearch")).toBe("json");
    expect(effectiveExtractor("redis", "elasticsearch")).toBe("json");
    expect(effectiveExtractor("csv", "elasticsearch")).toBe("csv");
  });

  it("writes rows back as the commands of their type", () => {
    expect(
      exportData(
        "redis",
        redis(
          "hash",
          ["field", "value"],
          [
            ["name", "Ada Lovelace"],
            ["plan", "pro"],
          ],
        ),
      ),
    ).toBe('HSET user:1 name "Ada Lovelace"\nHSET user:1 plan pro');
    expect(
      exportData(
        "redis",
        redis(
          "list",
          ["index", "value"],
          [
            ["0", "a"],
            ["1", ""],
          ],
        ),
      ),
    ).toBe('RPUSH user:1 a\nRPUSH user:1 ""');
    expect(exportData("redis", redis("set", ["member"], [["x"]]))).toBe("SADD user:1 x");
    expect(exportData("redis", redis("zset", ["member", "score"], [["ada", "3820"]]))).toBe("ZADD user:1 3820 ada");
    expect(
      exportData(
        "redis",
        redis(
          "stream",
          ["id", "order", "carrier"],
          [
            ["1-0", "A-1", null],
            ["2-0", "A-2", "SF"],
          ],
        ),
      ),
    ).toBe("XADD user:1 1-0 order A-1\nXADD user:1 2-0 order A-2 carrier SF");
    // Columns a command needs left out of the selection: the values, one row per line.
    expect(exportData("redis", redis("hash", ["value"], [["a b"], ["c"]]))).toBe('"a b"\nc');
  });

  it("quotes words as redis-cli reads them", () => {
    expect(redisArg("plain:key")).toBe("plain:key");
    expect(redisArg("")).toBe('""');
    expect(redisArg('say "hi"\n')).toBe('"say \\"hi\\"\\n"');
    expect(redisArg("a\\b")).toBe('"a\\\\b"');
  });
});

describe("sorting", () => {
  it("cycles a column and replaces the others without add (IDEA's header clicks)", () => {
    expect(nextSort([], "a", false)).toEqual([{ column: "a", descending: false }]);
    expect(nextSort([{ column: "a", descending: false }], "a", false)).toEqual([{ column: "a", descending: true }]);
    expect(nextSort([{ column: "a", descending: true }], "a", false)).toEqual([]);
    // Another column alone starts ascending, whatever it was.
    expect(
      nextSort(
        [
          { column: "a", descending: false },
          { column: "b", descending: true },
        ],
        "b",
        false,
      ),
    ).toEqual([{ column: "b", descending: false }]);
  });

  it("keeps priorities when adding (⌥-click, Add to ORDER BY)", () => {
    const two = nextSort([{ column: "a", descending: false }], "b", true);
    expect(two).toEqual([
      { column: "a", descending: false },
      { column: "b", descending: false },
    ]);
    expect(nextSort(two, "a", true)).toEqual([
      { column: "a", descending: true },
      { column: "b", descending: false },
    ]);
    expect(nextSort(two, "a", true, null)).toEqual([{ column: "b", descending: false }]);
    expect(nextSort(two, "b", false, "desc")).toEqual([{ column: "b", descending: true }]);
  });

  it("sorts loaded rows by several keys", () => {
    const rows = [
      ["b", "2"],
      ["a", "10"],
      ["b", "1"],
      ["a", "9"],
    ];
    const value = (r: number, c: number) => rows[r]![c]!;
    expect(
      visibleRows(4, value, new Map(), [
        { column: 0, descending: false },
        { column: 1, descending: true },
      ]),
    ).toEqual([1, 3, 0, 2]);
  });
});

describe("re-querying a result", () => {
  it("orders by column position over the whole query, with paging per dialect", () => {
    const q = "select * from orders where status <> 'x';";
    expect(reshapeQuery("postgres", q, [{ column: 4, descending: true }], 0, 501)).toBe(
      "SELECT * FROM (\nselect * from orders where status <> 'x'\n) luma_q ORDER BY 5 DESC LIMIT 501",
    );
    expect(reshapeQuery("mysql", q, [], 500, 501)).toBe(
      "SELECT * FROM (\nselect * from orders where status <> 'x'\n) luma_q LIMIT 501 OFFSET 500",
    );
    expect(reshapeQuery("sqlServer", q, [], 500, 501)).toBe(
      "SELECT * FROM (\nselect * from orders where status <> 'x'\n) luma_q " +
        "ORDER BY (SELECT NULL) OFFSET 500 ROWS FETCH NEXT 501 ROWS ONLY",
    );
    expect(countQuery(q)).toBe("SELECT COUNT(*) FROM (\nselect * from orders where status <> 'x'\n) luma_q");
  });

  it("re-queries only single read-only queries a derived table accepts", () => {
    expect(canReshape("SELECT id, name FROM t", ["id", "name"], "mysql")).toBe(true);
    expect(canReshape("with x as (select 1 a) select * from x", ["a"], "postgres")).toBe(true);
    // Duplicate names (a join) and statements that write or lock stay as they ran.
    expect(canReshape("select a.id, b.id from a join b", ["id", "id"], "mysql")).toBe(false);
    expect(canReshape("select * into t2 from t", ["id"], "sqlServer")).toBe(false);
    expect(canReshape("select * from t for update", ["id"], "postgres")).toBe(false);
    expect(canReshape("with d as (delete from t returning *) select * from d", ["id"], "postgres")).toBe(false);
    expect(canReshape("show tables", ["Tables_in_luma"], "mysql")).toBe(false);
    // A keyword inside a string is not one.
    expect(canReshape("select 'for update' as note", ["note"], "postgres")).toBe(true);
  });
});

describe("find and go to row", () => {
  it("matches cells with the find options", () => {
    const m = cellMatcher("pa", { caseSensitive: false, wholeWord: false, regex: false });
    expect(typeof m === "function" && m("PAID")).toBe(true);
    const word = cellMatcher("pa", { caseSensitive: false, wholeWord: true, regex: false });
    expect(typeof word === "function" && word("PAID")).toBe(false);
    const nul = cellMatcher("null", { caseSensitive: false, wholeWord: false, regex: false });
    expect(typeof nul === "function" && nul(null)).toBe(true);
    expect(cellMatcher("(", { caseSensitive: false, wholeWord: false, regex: true })).toBe("invalid");
  });

  it("reads row[:column] by number or name", () => {
    expect(parseGoTo("12", ["id", "name"])).toEqual({ row: 11, column: null });
    expect(parseGoTo("3:2", ["id", "name"])).toEqual({ row: 2, column: 1 });
    expect(parseGoTo("3, NAME", ["id", "name"])).toEqual({ row: 2, column: 1 });
    expect(parseGoTo("3:missing", ["id"])).toBeNull();
    expect(parseGoTo("x", ["id"])).toBeNull();
  });
});

describe("heatmap", () => {
  it("places numbers between the column's min and max", () => {
    const range = numberRange(["10", null, "x", "30", "20"]);
    expect(range).toEqual({ min: 10, max: 30 });
    expect(heat("20", range)).toBe(0.5);
    expect(heat("abc", range)).toBeNull();
    expect(numberRange(["5", "5"])).toBeNull();
  });
});

describe("value editor", () => {
  it("shows binary images by their signature", () => {
    expect(imageUrl("0x89504E470D0A1A0A0000")).toMatch(/^data:image\/png;base64,/);
    expect(imageUrl("0xFFD8FFE0")).toMatch(/^data:image\/jpeg;base64,/);
    expect(imageUrl("0xCAFE")).toBeNull();
    expect(imageUrl("plain text")).toBeNull();
  });
});
