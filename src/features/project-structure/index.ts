/**
 * File › Project Structure… (IDEA: ⌘; on macOS, Ctrl+Alt+Shift+S elsewhere): the project's
 * modules, libraries, facets, artifacts and SDKs in IDEA's dialog. Also in the main toolbar's
 * gear menu. `executeAction("file.projectStructure", "sdks")` opens a given page.
 */
import { createElement } from "react";
import { lazyComponent } from "@/ui";
import { registerActions } from "@/platform/actions";
import { registerOverlay } from "@/workbench/contributions";
import { openProjectStructure, useProjectStructure, type PageId } from "./store";

export const PROJECT_STRUCTURE_ACTION = "file.projectStructure";

const PAGES: readonly PageId[] = [
  "project",
  "modules",
  "libraries",
  "facets",
  "artifacts",
  "sdks",
  "globalLibraries",
  "problems",
];

const Dialog = lazyComponent(() => import("./ProjectStructureDialog").then((m) => m.ProjectStructureDialog));

/** Loads the dialog's code only when it opens. */
function ProjectStructureOverlay() {
  const open = useProjectStructure((s) => s.open);
  return open ? createElement(Dialog) : null;
}

export function activate(): () => void {
  const disposers = [
    registerOverlay({ id: "projectStructure.dialog", component: ProjectStructureOverlay }),
    registerActions([
      {
        id: PROJECT_STRUCTURE_ACTION,
        title: "Project Structure…",
        category: "File",
        icon: "module",
        when: "projectOpen",
        keywords: ["module settings", "project settings", "modules", "libraries", "facets", "artifacts", "sdk", "jdk"],
        run: ({ arg }) =>
          openProjectStructure(
            typeof arg === "string" && (PAGES as readonly string[]).includes(arg) ? (arg as PageId) : "project",
          ),
      },
    ]),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
