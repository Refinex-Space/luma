/**
 * Which words of a statement are SQL vocabulary (IDEA's Code Style › Case: keywords,
 * built-in types, built-in functions) and so follow the keyword case. Identifiers never
 * do: a word next to `.`, quoted, or a non-reserved word outside a type position (a
 * column named `date` or `status`) keeps its case.
 */
import type { DbDriver } from "@/platform/ipc";
import { CLAUSE_WORDS, DATA_TYPES, functions, isReserved } from "./dialect";

export interface Word {
  kind: string;
  text: string;
  upper: string;
}

/** Keywords beyond the reserved ones that no one names a column after. */
const KEYWORDS = new Set([
  ...CLAUSE_WORDS,
  ..."ADD ALTER ANALYZE AUTO_INCREMENT AUTOINCREMENT BEGIN CASCADE CHANGE COMMIT CONFLICT DATABASE DECLARE DO DUPLICATE ENGINE ESCAPE EXPLAIN FOLLOWING IF IGNORE ILIKE INDEX LATERAL MATERIALIZED MODIFY NOTHING NULLS OVER PARTITION PRECEDING RANGE RECURSIVE RENAME REPLACE RESTRICT RETURNING ROLLBACK ROWS SAVEPOINT SCHEMA SHOW SIMILAR TOP TRANSACTION TRIGGER TRUNCATE UNBOUNDED UNSIGNED VIEW WITHOUT ZEROFILL".split(
    " ",
  ),
]);

/** Keywords only after these words (`PRIMARY KEY`, `NULLS FIRST`, `ON DELETE NO ACTION`). */
const AFTER: Record<string, readonly string[]> = {
  KEY: ["PRIMARY", "FOREIGN", "UNIQUE", "DUPLICATE"],
  FIRST: ["NULLS", "FETCH"],
  LAST: ["NULLS"],
  ROW: ["CURRENT", "EACH", "FOR", "ONLY", "NEXT", "FIRST"],
  ONLY: ["ROW", "ROWS"],
  NEXT: ["FETCH"],
  ACTION: ["NO"],
  NO: ["ON", "DELETE", "UPDATE"],
  ZONE: ["TIME"],
  TIME: ["WITH", "WITHOUT"],
  PRECISION: ["DOUBLE"],
  VARYING: ["CHARACTER", "BIT"],
  COLUMN: ["ADD", "DROP", "ALTER", "RENAME", "MODIFY", "CHANGE"],
  TYPE: ["COLUMN"],
  COMMENT: [],
};

/** Built-in types, cased only where a type is written (definitions, casts, `::`). */
const TYPES = new Set(
  [
    ...Object.values(DATA_TYPES).flatMap((list) => list.flatMap((t) => t.split(" "))),
    ..."INT INTEGER BIGINT SMALLINT TINYINT MEDIUMINT DECIMAL DEC NUMERIC FLOAT DOUBLE REAL PRECISION CHAR CHARACTER VARCHAR VARYING NCHAR NVARCHAR TEXT TINYTEXT MEDIUMTEXT LONGTEXT CLOB BLOB TINYBLOB MEDIUMBLOB LONGBLOB BINARY VARBINARY BOOLEAN BOOL BIT DATE TIME DATETIME DATETIME2 DATETIMEOFFSET SMALLDATETIME TIMESTAMP TIMESTAMPTZ TIMETZ INTERVAL YEAR UUID UNIQUEIDENTIFIER JSON JSONB XML BYTEA SERIAL BIGSERIAL SMALLSERIAL MONEY ENUM INET CIDR GEOMETRY POINT UNSIGNED ZEROFILL ZONE".split(
      " ",
    ),
  ].map((t) => t.toUpperCase()),
);

/** A built-in type word (`VARCHAR`, `PRECISION`, `UNSIGNED`). */
export function isTypeWord(upper: string): boolean {
  return TYPES.has(upper);
}

const functionNames = new Map<DbDriver, Set<string>>();
function isFunction(upper: string, driver: DbDriver): boolean {
  let names = functionNames.get(driver);
  if (!names) {
    names = new Set([
      ...functions(driver).map((f) => f.name.toUpperCase()),
      ..."COUNT SUM AVG MIN MAX COALESCE NULLIF CAST CONVERT CONCAT SUBSTRING TRIM UPPER LOWER LENGTH ROUND ABS NOW EXTRACT GREATEST LEAST ROW_NUMBER RANK DENSE_RANK LAG LEAD".split(
        " ",
      ),
    ]);
    functionNames.set(driver, names);
  }
  return names.has(upper);
}

/** Words that name a table (or its column list) right before `(`: `into users (`. */
const TARGET_BEFORE_PAREN = new Set(["INTO", "TABLE", "EXISTS", "JOIN", "FROM", "UPDATE", "VIEW", "INDEX", "ON"]);

const isPunct = (t: Word | undefined, p: string) => !!t && t.kind === "punct" && t.text === p;

/**
 * Indexes of `tokens` (comments excluded) that are vocabulary and follow the keyword case.
 * `createBody` tells which `(` opens a CREATE TABLE body (its definitions declare types).
 */
export function vocabulary(tokens: readonly Word[], driver: DbDriver): Set<number> {
  const out = new Set<number>();
  // Per open paren: what owns it and, in a table body, the word index within the definition.
  const stack: Array<{ owner: string; body: boolean; word: number }> = [];
  const create =
    tokens
      .filter((t) => t.kind === "word")
      .slice(0, 3)
      .some((t) => t.upper === "TABLE") && tokens.find((t) => t.kind === "word")?.upper === "CREATE";
  let parens = 0;
  tokens.forEach((t, i) => {
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    const top = stack.at(-1);
    if (t.kind === "punct") {
      if (t.text === "(") {
        parens++;
        const owner = prev?.kind === "word" ? prev.upper : "";
        // The first top-level paren of CREATE TABLE name (…) is the body.
        const body = create && parens === 1 && (prev?.kind === "word" || prev?.kind === "quoted") && owner !== "AS";
        stack.push({ owner, body, word: 0 });
      } else if (t.text === ")") stack.pop();
      else if (t.text === "," && top) top.word = 0;
      return;
    }
    if (t.kind !== "word") {
      if (top?.body) top.word++;
      return;
    }
    const u = t.upper;
    // Qualified names are identifiers: `o.status`, `sales.date`.
    const qualified = isPunct(prev, ".") || isPunct(next, ".");
    const inBody = !!top?.body;
    const wordInDefinition = inBody ? top!.word++ : -1;
    if (qualified) return;
    if (isPunct(next, "(") && isFunction(u, driver) && !TARGET_BEFORE_PAREN.has(prev?.upper ?? "")) {
      out.add(i);
      return;
    }
    // Types: in a column definition (after its name), after `::`, in CAST(x AS type).
    const typePosition =
      (inBody && wordInDefinition >= 1) ||
      isPunct(prev, "::") ||
      (prev?.upper === "AS" && (top?.owner === "CAST" || top?.owner === "CONVERT" || top?.owner === "TRY_CAST")) ||
      prev?.upper === "TYPE";
    if (typePosition && TYPES.has(u)) {
      out.add(i);
      return;
    }
    const after = AFTER[u];
    if (after) {
      if (after.includes(prev?.upper ?? "") || (u === "COMMENT" && inBody && next?.kind === "string")) out.add(i);
      return;
    }
    if (isReserved(u) || KEYWORDS.has(u)) out.add(i);
  });
  return out;
}

/** A word that is vocabulary wherever it stands (template defaults such as `not null`, `int`). */
export function isVocabularyWord(upper: string): boolean {
  return isReserved(upper) || KEYWORDS.has(upper) || TYPES.has(upper);
}

export type KeywordCase = "upper" | "lower" | "preserve";

export function cased(text: string, keywordCase: KeywordCase): string {
  return keywordCase === "upper" ? text.toUpperCase() : keywordCase === "lower" ? text.toLowerCase() : text;
}
