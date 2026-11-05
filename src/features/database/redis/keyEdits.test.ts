import { describe, expect, it } from "vitest";
import type { RedisBytes, RedisValuePage } from "@/platform/ipc";
import { emptyEdits, type PendingEdits } from "../model";
import { addRow, deleteRows, setCell } from "../rowEdits";
import {
  appendPage,
  bytesOf,
  cellEditable,
  cellText,
  draftValue,
  firstPage,
  initialDraft,
  formatJson,
  hexDump,
  isScore,
  jsonError,
  keyEditCommands,
  looksLikeJson,
  pageRequest,
  replyErrors,
  saveValueCommand,
  type RedisRow,
} from "./keyEdits";

const t = (text: string): RedisBytes => ({ text, binary: false });
const bin = (hex: string): RedisBytes => ({ text: hex, binary: true });
const key = t("k");
/** Commands as `redis-cli` words (binary as `\x..`). */
const words = (cmds: RedisBytes[][]) => cmds.map((c) => c.map((a) => (a.binary ? `<${a.text}>` : a.text)).join(" "));

function commands(kind: string, columns: string[], rows: RedisRow[], edit: (e: PendingEdits) => PendingEdits) {
  const r = keyEditCommands(kind, key, columns, rows, edit(emptyEdits()), "SENTINEL");
  if (!r.ok) throw new Error(r.error);
  return words(r.commands);
}

function error(kind: string, columns: string[], rows: RedisRow[], edit: (e: PendingEdits) => PendingEdits) {
  const r = keyEditCommands(kind, key, columns, rows, edit(emptyEdits()), "SENTINEL");
  return r.ok ? null : r.error;
}

/** Grid edits over the shown text of `rows`. */
const shown = (rows: RedisRow[]) => rows.map((r) => r.map(cellText));

describe("hash edits", () => {
  const columns = ["field", "value"];
  const rows: RedisRow[] = [
    [t("name"), t("Ada")],
    [t("age"), t("36")],
    [t("city"), t("London")],
  ];
  const names = columns;
  const cells = shown(rows);

  it("sets values, renames fields, deletes and adds", () => {
    expect(commands("hash", columns, rows, (e) => setCell(e, cells, names, 0, 1, "Grace"))).toEqual([
      "HSET k name Grace",
    ]);
    expect(commands("hash", columns, rows, (e) => setCell(e, cells, names, 1, 0, "years"))).toEqual([
      "HDEL k age",
      "HSET k years 36",
    ]);
    expect(
      commands("hash", columns, rows, (e) => {
        let x = deleteRows(e, rows.length, [2]);
        x = addRow(x, names);
        return setCell(setCell(x, cells, names, 3, 0, "zip"), cells, names, 3, 1, "NW1");
      }),
    ).toEqual(["HDEL k city", "HSET k zip NW1"]);
  });

  it("swaps two field names without losing either", () => {
    expect(
      commands("hash", columns, rows, (e) =>
        setCell(setCell(e, cells, names, 0, 0, "age"), cells, names, 1, 0, "name"),
      ),
    ).toEqual(["HDEL k name age", "HSET k age Ada name 36"]);
  });

  it("needs a field name for a new row; an empty value is fine", () => {
    expect(error("hash", columns, rows, (e) => addRow(e, names))).toBe("Enter a field name for each new row");
    expect(commands("hash", columns, rows, (e) => setCell(addRow(e, names), cells, names, 3, 0, "x"))).toEqual([
      "HSET k x ",
    ]);
  });

  it("keeps binary fields as bytes and refuses to edit binary values", () => {
    const binRows: RedisRow[] = [
      [bin("ff00"), t("v")],
      [t("f"), bin("01")],
    ];
    const binCells = shown(binRows);
    expect(cellEditable("hash", binRows, 0, 0)).toBe(false);
    expect(cellEditable("hash", binRows, 0, 1)).toBe(true);
    expect(commands("hash", columns, binRows, (e) => setCell(e, binCells, names, 0, 1, "w"))).toEqual([
      "HSET k <ff00> w",
    ]);
    expect(error("hash", columns, binRows, (e) => setCell(e, binCells, names, 1, 1, "x"))).toBe(
      "Binary values cannot be edited",
    );
  });

  it("writes nothing for edits set back to the loaded value", () => {
    expect(
      commands("hash", columns, rows, (e) => setCell(setCell(e, cells, names, 0, 1, "x"), cells, names, 0, 1, "Ada")),
    ).toEqual([]);
  });
});

describe("list edits", () => {
  const columns = ["index", "value"];
  const rows: RedisRow[] = [
    [t("10"), t("a")],
    [t("11"), t("b")],
    [t("12"), t("a")],
  ];
  const cells = shown(rows);

  it("sets by index, deletes through one sentinel, appends new rows", () => {
    expect(
      commands("list", columns, rows, (e) => {
        let x = setCell(e, cells, columns, 1, 1, "B");
        x = setCell(x, cells, columns, 0, 1, "ignored");
        x = deleteRows(x, rows.length, [0, 2]);
        x = addRow(x, columns);
        return setCell(x, cells, columns, 3, 1, "d");
      }),
    ).toEqual(["LSET k 11 B", "LSET k 10 SENTINEL", "LSET k 12 SENTINEL", "LREM k 0 SENTINEL", "RPUSH k d"]);
  });

  it("never edits the index column", () => {
    expect(cellEditable("list", rows, 0, 0)).toBe(false);
    expect(cellEditable("list", rows, 5, 0)).toBe(false);
    expect(cellEditable("list", rows, 0, 1)).toBe(true);
  });
});

describe("set edits", () => {
  const columns = ["member"];
  const rows: RedisRow[] = [[t("red")], [t("green")]];
  const cells = shown(rows);

  it("replaces changed members, removes deleted ones and adds new ones", () => {
    expect(
      commands("set", columns, rows, (e) => {
        let x = setCell(e, cells, columns, 0, 0, "blue");
        x = deleteRows(x, rows.length, [1]);
        x = addRow(x, columns);
        return setCell(x, cells, columns, 2, 0, "cyan");
      }),
    ).toEqual(["SREM k green red", "SADD k blue cyan"]);
  });

  it("needs a member for each new row", () => {
    expect(error("set", columns, rows, (e) => addRow(e, columns))).toBe("Enter a member for each new row");
  });
});

describe("sorted set edits", () => {
  const columns = ["member", "score"];
  const rows: RedisRow[] = [
    [t("alice"), t("10")],
    [t("bob"), t("2.5")],
  ];
  const cells = shown(rows);

  it("re-scores, renames, removes and adds", () => {
    expect(commands("zset", columns, rows, (e) => setCell(e, cells, columns, 0, 1, " 11 "))).toEqual([
      "ZADD k 11 alice",
    ]);
    expect(commands("zset", columns, rows, (e) => setCell(e, cells, columns, 1, 0, "carol"))).toEqual([
      "ZREM k bob",
      "ZADD k 2.5 carol",
    ]);
    expect(
      commands("zset", columns, rows, (e) => {
        let x = deleteRows(e, rows.length, [0]);
        x = addRow(x, columns);
        x = setCell(x, cells, columns, 2, 0, "dave");
        return setCell(x, cells, columns, 2, 1, "-inf");
      }),
    ).toEqual(["ZREM k alice", "ZADD k -inf dave"]);
  });

  it("validates scores", () => {
    expect(isScore("1e3")).toBe(true);
    expect(isScore("+inf")).toBe(true);
    expect(isScore("-.5")).toBe(true);
    expect(isScore("ten")).toBe(false);
    expect(isScore("")).toBe(false);
    expect(error("zset", columns, rows, (e) => setCell(e, cells, columns, 0, 1, "ten"))).toBe(
      "Score is not a number: ten",
    );
    expect(error("zset", columns, rows, (e) => setCell(addRow(e, columns), cells, columns, 2, 0, "x"))).toBe(
      "Enter a score for each new row",
    );
  });
});

describe("stream edits", () => {
  const columns = ["id", "temp", "unit"];
  const rows: RedisRow[] = [
    [t("1700000000000-0"), t("21"), t("C")],
    [t("1700000000001-0"), t("70"), null],
  ];
  const cells = shown(rows);

  it("keeps entries read-only, deletes by id, adds with the filled fields", () => {
    expect(cellEditable("stream", rows, 0, 1)).toBe(false);
    expect(cellEditable("stream", rows, 2, 0)).toBe(false);
    expect(cellEditable("stream", rows, 2, 1)).toBe(true);
    expect(
      commands("stream", columns, rows, (e) => {
        let x = deleteRows(e, rows.length, [1]);
        x = addRow(x, columns);
        return setCell(x, cells, columns, 2, 1, "22");
      }),
    ).toEqual(["XDEL k 1700000000001-0", "XADD k * temp 22"]);
  });

  it("needs a field for a new entry", () => {
    expect(error("stream", columns, rows, (e) => addRow(e, columns))).toBe(
      "Enter at least one field value for each new entry",
    );
  });
});

describe("paging", () => {
  const page = (p: Partial<RedisValuePage>): RedisValuePage => ({
    kind: "hash",
    columns: ["field", "value"],
    rows: [],
    cursor: null,
    offset: 0,
    total: null,
    value: null,
    truncated: false,
    ...p,
  });

  it("appends pages, listing a field SCAN returned twice once", () => {
    const first = firstPage(page({ rows: [[t("a"), t("1")]], cursor: "17", total: 3 }));
    const next = appendPage(
      first,
      page({
        rows: [
          [t("a"), t("1")],
          [t("b"), t("2")],
        ],
        cursor: null,
        total: null,
      }),
    );
    expect(next.rows.map((r) => r[0]?.text)).toEqual(["a", "b"]);
    expect(next.cursor).toBeNull();
    expect(next.total).toBe(3);
  });

  it("unites stream fields across pages", () => {
    const first = firstPage(page({ kind: "stream", columns: ["id", "a"], rows: [[t("1-0"), t("x")]], cursor: "1-1" }));
    const next = appendPage(first, page({ kind: "stream", columns: ["id", "b"], rows: [[t("2-0"), t("y")]] }));
    expect(next.columns).toEqual(["id", "a", "b"]);
    expect(next.rows).toEqual([
      [t("1-0"), t("x"), null],
      [t("2-0"), null, t("y")],
    ]);
  });

  it("pages lists and unfiltered sorted sets by offset, the rest by cursor", () => {
    const options = { count: 100, pattern: "", descending: true };
    expect(pageRequest("list", options, "100")).toMatchObject({ offset: 100, cursor: null, descending: false });
    expect(pageRequest("zset", options, "200")).toMatchObject({ offset: 200, cursor: null, descending: true });
    expect(pageRequest("zset", { ...options, pattern: "a*" }, "42")).toMatchObject({ cursor: "42", pattern: "a*" });
    expect(pageRequest("hash", { ...options, pattern: " u:* " }, null)).toMatchObject({ pattern: "u:*", offset: 0 });
    expect(pageRequest("list", { ...options, pattern: "x" }, null)).toMatchObject({ pattern: null });
    expect(pageRequest("stream", options, "5-1")).toMatchObject({ cursor: "5-1", descending: true });
  });
});

describe("strings", () => {
  it("saves strings keeping their time to live, JSON values at the root", () => {
    expect(words([saveValueCommand("string", key, "v")])).toEqual(["SET k v KEEPTTL"]);
    expect(words([saveValueCommand("ReJSON-RL", key, '{"a":1}')])).toEqual(['JSON.SET k $ {"a":1}']);
  });

  it("formats JSON keeping its tokens", () => {
    const text = '{"id":12345678901234567890,"tags":["a, b",{}],"s":"q\\"{x}","e":[]}';
    expect(formatJson(text)).toBe(
      '{\n  "id": 12345678901234567890,\n  "tags": [\n    "a, b",\n    {}\n  ],\n  "s": "q\\"{x}",\n  "e": []\n}',
    );
    expect(formatJson(formatJson(text), 0)).toBe(text);
    expect(looksLikeJson(" [1, 2] ")).toBe(true);
    expect(looksLikeJson("42")).toBe(false);
    expect(jsonError("{")).not.toBeNull();
  });

  it("saves what the JSON view shows: unchanged as loaded, edited compact like the original", () => {
    const compact = '{"a":1,"b":[1,2]}';
    const draft = initialDraft("string", t(compact));
    expect(draft).toMatchObject({ json: true, edited: false });
    expect(draftValue("string", draft, compact)).toBe(compact);
    expect(draftValue("string", { ...draft, text: draft.text.replace("1,", "2,") }, compact)).toBe('{"a":2,"b":[1,2]}');
    expect(draftValue("string", { ...draft, text: "{" }, compact)).toBeNull();
    // A pretty original keeps the shown layout; plain text saves as typed.
    const pretty = '{\n    "a": 1\n}';
    expect(draftValue("string", { text: '{\n  "a": 2\n}', json: true, edited: true }, pretty)).toBe('{\n  "a": 2\n}');
    expect(draftValue("string", { text: "{ oops", json: false, edited: true }, "x")).toBe("{ oops");
    // A JSON value stays JSON whatever the view.
    expect(draftValue("ReJSON-RL", { text: "{ oops", json: false, edited: true }, "{}")).toBeNull();
    expect(initialDraft("string", t("plain"))).toMatchObject({ text: "plain", json: false });
    expect(initialDraft("string", bin("ff"))).toMatchObject({ text: "", json: false });
  });

  it("dumps bytes like hexdump -C", () => {
    expect(hexDump(bytesOf(t("Hello\n"))).text).toBe(
      "00000000  48 65 6c 6c 6f 0a                                 |Hello.|",
    );
    const dump = hexDump(bytesOf(bin("00ff".repeat(10))), 16);
    expect(dump.rest).toBe(4);
    expect(dump.text.split("\n")).toHaveLength(1);
  });

  it("finds errors among EXEC replies", () => {
    expect(
      replyErrors([
        { kind: "int", text: "1" },
        { kind: "error", text: "ERR index out of range" },
      ]),
    ).toEqual(["ERR index out of range"]);
  });
});
