import { beforeEach, describe, expect, it } from "vitest";
import { useProject } from "@/platform/project";
import { DEFAULT_PROJECT_STRUCTURE } from "@/platform/languageSettings";
import { draftChanges, goBack, isDirty, openProjectStructure, showPage, useProjectStructure } from "./store";

beforeEach(() => {
  useProject.setState({
    project: { root: "/p", name: "lab" } as never,
    settings: { languages: { java: { jdk: "/jdk/21" } }, projectStructure: { sourceRoots: ["src"] } } as never,
  });
});

describe("project structure draft", () => {
  it("writes only what changed", () => {
    expect(isDirty({})).toBe(false);
    expect(isDirty({ name: "lab", jdk: "/jdk/21" })).toBe(false);
    const structure = { ...DEFAULT_PROJECT_STRUCTURE, sourceRoots: ["src"], excluded: ["out"] };
    expect(draftChanges({ name: " lab2 ", jdk: "", structure })).toEqual({
      rename: "lab2",
      settings: [
        ["languages.java.jdk", '""'],
        ["projectStructure.excluded", '["out"]'],
      ],
    });
    // An empty name renames back to the folder's name.
    expect(draftChanges({ name: "" }).rename).toBe("");
  });

  it("opens on a page and walks the pages visited", () => {
    openProjectStructure("sdks", "jdk:/jdk/21");
    expect(useProjectStructure.getState()).toMatchObject({
      open: true,
      page: "sdks",
      selected: { sdks: "jdk:/jdk/21" },
    });
    showPage("modules");
    showPage("problems");
    goBack(-1);
    expect(useProjectStructure.getState().page).toBe("modules");
    goBack(1);
    expect(useProjectStructure.getState().page).toBe("problems");
  });
});
