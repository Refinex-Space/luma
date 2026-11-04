/** Read-only build context shared by file and folder presentation consumers. */
import { useEffect } from "react";
import { create } from "zustand";
import { call, commands, isTauri, onIdeEvent, type BuildModel } from "./ipc";
import { useProject } from "./project";

export interface BuildPresentation {
  modules: ReadonlyMap<string, "maven" | "gradle">;
  spring: boolean;
}
const EMPTY: BuildPresentation = { modules: new Map(), spring: false };
export const useBuildPresentation = create<BuildPresentation>(() => EMPTY);

export function buildPresentation(model: BuildModel): BuildPresentation {
  const modules = new Map<string, "maven" | "gradle">();
  for (const p of model.maven?.projects ?? []) modules.set(p.dir, "maven");
  for (const p of model.gradle?.projects ?? []) modules.set(p.dir, "gradle");
  const spring =
    (model.maven?.projects ?? []).some(
      (p) =>
        p.dependencies.some((d) => d.groupId.startsWith("org.springframework")) ||
        p.plugins.some((p) => p.groupId.startsWith("org.springframework")),
    ) || (model.gradle?.projects ?? []).some((p) => p.tasks.some((t) => t.name === "bootRun"));
  return { modules, spring };
}

/** A Maven / Gradle module folder below the project root: IDEA shows its name in bold. */
export function isModuleFolder(rel: string, root: boolean, modules: BuildPresentation["modules"]): boolean {
  return !root && rel !== "" && modules.has(rel);
}

/**
 * The icon of a Maven / Gradle module folder: a folder with the tool's badge, the project root
 * as well, so the tree's folders share one style (the tool's own logo is for its tool window).
 *
 * @param rel the folder, relative to the project root ("" for the root)
 * @param modules the build model's module folders and their tool
 * @returns the icon name, or `null` for a folder that is no module
 */
export function moduleFolderIcon(rel: string, modules: BuildPresentation["modules"]): string | null {
  const tool = modules.get(rel);
  return tool ? `${tool}-module` : null;
}

let users = 0;
let generation = 0;
let dispose: (() => void) | undefined;
async function load() {
  const gen = ++generation;
  if (!useProject.getState().project || !isTauri()) {
    useBuildPresentation.setState(EMPTY);
    return;
  }
  try {
    const model = await call(commands.buildModel());
    if (generation === gen) useBuildPresentation.setState(buildPresentation(model));
  } catch {
    /* Presentation keeps its filename fallback. */
  }
}

export function useProjectPresentation(): BuildPresentation {
  useEffect(() => {
    if (users++ === 0) {
      void load();
      const project = useProject.subscribe((s, prev) => {
        if (s.project === prev.project) return;
        useBuildPresentation.setState(EMPTY);
        void load();
      });
      const roots = onIdeEvent("projectRootsChanged", () => void load());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const files = onIdeEvent("fsChanged", (e) => {
        if (
          ![...e.created, ...e.modified, ...e.removed].some((p) =>
            /(?:^|\/)(pom\.xml|(?:build|settings)\.gradle(?:\.kts)?)$/.test(p),
          )
        )
          return;
        clearTimeout(timer);
        timer = setTimeout(() => void load(), 100);
      });
      dispose = () => {
        project();
        roots();
        files();
        clearTimeout(timer);
        generation++;
      };
    }
    return () => {
      if (--users === 0) dispose?.();
    };
  }, []);
  return useBuildPresentation();
}
