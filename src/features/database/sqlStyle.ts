/**
 * The effective Editor › Code Style › SQL: what Reformat Code, completion and the SQL
 * live templates follow. Unset options take Luma's defaults (upper-case keywords, IDEA's
 * aligned layout, aligned aliases), so SQL looks right without visiting the page.
 */
import { editorPrefs, type LanguageCodeStyle } from "@/platform/editorSettings";
import { DEFAULT_SQL_STYLE, type SqlStyle } from "./sql/format";
import type { KeywordCase } from "./sql/keywords";

export const SQL_LANGUAGE_ID = "sql";

const CASES: readonly KeywordCase[] = ["upper", "lower", "preserve"];

export function sqlStyleOf(own: LanguageCodeStyle | undefined): SqlStyle {
  return {
    keywordCase: CASES.includes(own?.keywordCase as KeywordCase)
      ? (own!.keywordCase as KeywordCase)
      : DEFAULT_SQL_STYLE.keywordCase,
    layout: own?.listLayout === "indented" ? "indented" : "aligned",
    alignAliases: own?.alignAliases ?? DEFAULT_SQL_STYLE.alignAliases,
    indent: own?.indent ?? own?.tabSize ?? DEFAULT_SQL_STYLE.indent,
  };
}

export function currentSqlStyle(): SqlStyle {
  return sqlStyleOf(editorPrefs().codeStyle.languages[SQL_LANGUAGE_ID]);
}
