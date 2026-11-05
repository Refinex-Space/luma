import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES } from "@/features/templates/live/builtins";
import { recased } from "./format";

describe("SQL live templates follow the keyword case", () => {
  const body = (abbrev: string) => BUILTIN_TEMPLATES.find((t) => t.group === "SQL" && t.abbrev === abbrev)!.body;

  it("upper-cases keywords around the template variables", () => {
    expect(recased(body("selw"), "sqlite", "upper")).toBe("SELECT *\nFROM $table$ $alias$\nWHERE $alias$.$END$;");
    expect(recased(body("selc"), "sqlite", "upper")).toBe(
      "SELECT COUNT(*)\nFROM $table$ $alias$\nWHERE $alias$.$END$;",
    );
    expect(recased(body("tab"), "sqlite", "upper")).toBe("CREATE TABLE $table$\n(\n    $col$ $type$ $null$$END$\n);");
    expect(recased(body("ins"), "sqlite", "lower")).toBe(body("ins"));
  });

  it("cases default values without context", () => {
    expect(recased("not null", "sqlite", "upper", true)).toBe("NOT NULL");
    expect(recased("int", "sqlite", "upper", true)).toBe("INT");
    expect(recased("new_table", "sqlite", "upper", true)).toBe("new_table");
  });
});
