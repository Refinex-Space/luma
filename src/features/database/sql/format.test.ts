import { describe, expect, it } from "vitest";
import type { DbDriver } from "@/platform/ipc";
import { DEFAULT_SQL_STYLE, formatSql, formatted, type SqlStyle } from "./format";

const keep: SqlStyle = { ...DEFAULT_SQL_STYLE, keywordCase: "preserve" };
const fmt = (sql: string, style: SqlStyle = keep, driver: DbDriver = "sqlite") => formatted(sql, driver, style);

describe("formatSql (IDEA's layout)", () => {
  it("lays out a query: items aligned after their keyword, joins under the first table", () => {
    expect(
      fmt(
        "SELECT u.id,u.name , count( * ) AS n FROM users u LEFT JOIN orders o ON o.user_id=u.id WHERE u.id>1 AND o.total BETWEEN 1 AND 5 OR o.status='x' GROUP BY u.id ORDER BY n DESC LIMIT 10;",
      ),
    ).toBe(
      [
        "SELECT u.id,",
        "       u.name,",
        "       count(*) AS n",
        "FROM users u",
        "     LEFT JOIN orders o ON o.user_id = u.id",
        "WHERE u.id > 1",
        "  AND o.total BETWEEN 1 AND 5",
        "   OR o.status = 'x'",
        "GROUP BY u.id",
        "ORDER BY n DESC",
        "LIMIT 10;",
      ].join("\n"),
    );
  });

  it("aligns subqueries and CTEs after their parenthesis", () => {
    expect(
      fmt(
        "with big as (select user_id, total from orders where total > 10) select * from big where exists (select 1 from users u where u.id = big.user_id);",
      ),
    ).toBe(
      [
        "with big as (select user_id,",
        "                    total",
        "             from orders",
        "             where total > 10)",
        "select *",
        "from big",
        "where exists (select 1",
        "              from users u",
        "              where u.id = big.user_id);",
      ].join("\n"),
    );
  });

  it("formats DML and DDL", () => {
    expect(fmt("insert into users(email,name) values('a', -1),('b',cast(2 as text));")).toBe(
      "insert into users (email, name)\nvalues ('a', -1),\n       ('b', cast(2 as text));",
    );
    expect(fmt("update users set name='x', email = 'y' where id=1;")).toBe(
      "update users\nset name = 'x',\n    email = 'y'\nwhere id = 1;",
    );
    expect(fmt("delete from orders where id = 1;")).toBe("delete\nfrom orders\nwhere id = 1;");
    expect(fmt("select 1 union all select 2;")).toBe("select 1\nunion all\nselect 2;");
  });

  it("keeps comments, text between statements and the range", () => {
    const sql = "-- head\nselect a -- why\n, b from t;\n\n\nselect   1;";
    expect(fmt(sql)).toBe("-- head\nselect a, -- why\n       b\nfrom t;\n\n\nselect 1;");
    const edits = formatSql(sql, "sqlite", { from: sql.length - 2, to: sql.length - 1 }, keep);
    expect(edits).toEqual([{ from: sql.lastIndexOf("select"), to: sql.length, insert: "select 1;" }]);
  });
});

describe("SQL code style", () => {
  it("upper-cases keywords, types and built-in functions by default, never identifiers", () => {
    expect(
      formatted(
        "select o.date, status, count(*) total, cast(o.total as decimal(10,2)) as amount from orders o where o.status is not null and o.date > now();",
        "mysql",
      ),
    ).toBe(
      [
        "SELECT o.date,",
        "       status,",
        "       COUNT(*)                        AS total,",
        "       CAST(o.total AS DECIMAL(10, 2)) AS amount",
        "FROM orders o",
        "WHERE o.status IS NOT NULL",
        "  AND o.date > NOW();",
      ].join("\n"),
    );
    // Quoted names, strings and comments are text.
    expect(formatted("select `select`, 'from' from t -- where", "mysql")).toBe(
      "SELECT `select`,\n       'from'\nFROM t -- where",
    );
    expect(fmt("SELECT A FROM T", { ...keep, keywordCase: "lower" })).toBe("select A\nfrom T");
  });

  it("aligns a table body's names, types and constraints", () => {
    expect(
      formatted(
        "create table product (id bigint unsigned not null auto_increment, name varchar(120) not null comment 'name', created_at timestamp with time zone default now(), date date, primary key (id));",
        "mysql",
      ),
    ).toBe(
      [
        "CREATE TABLE product",
        "(",
        "    id         BIGINT UNSIGNED          NOT NULL AUTO_INCREMENT,",
        "    name       VARCHAR(120)             NOT NULL COMMENT 'name',",
        "    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),",
        "    date       DATE,",
        "    PRIMARY KEY (id)",
        ");",
      ].join("\n"),
    );
  });

  it("indents items under their clause in the indented layout", () => {
    const style: SqlStyle = { ...DEFAULT_SQL_STYLE, layout: "indented", indent: 2 };
    expect(
      formatted(
        "select a, b from t join u on u.id = t.id where a = 1 and b in (select id from v) order by a;",
        "postgres",
        style,
      ),
    ).toBe(
      [
        "SELECT",
        "  a,",
        "  b",
        "FROM",
        "  t",
        "  JOIN u ON u.id = t.id",
        "WHERE",
        "  a = 1",
        "  AND b IN (",
        "    SELECT",
        "      id",
        "    FROM",
        "      v",
        "  )",
        "ORDER BY",
        "  a;",
      ].join("\n"),
    );
  });

  it("can leave aliases unaligned", () => {
    expect(
      formatted("select a as x, longer_name as y from t", "sqlite", { ...DEFAULT_SQL_STYLE, alignAliases: false }),
    ).toBe("SELECT a AS x,\n       longer_name AS y\nFROM t");
  });
});
