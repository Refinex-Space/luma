/**
 * The Project Structure dialog's state: which page and item are shown, and the draft of what
 * it edits (the project name, the project SDK, the folder marks). Apply writes the draft
 * (`project_rename`, project-scope settings); Cancel drops it.
 */
import { create } from "zustand";
import { call, commands, isTauri } from "@/platform/ipc";
import { loadSettings, useProject } from "@/platform/project";
import { validateLanguages, validateProjectStructure, type ProjectStructureValid } from "@/platform/languageSettings";

export type PageId =
  | "project"
  | "modules"
  | "libraries"
  | "facets"
  | "artifacts"
  | "sdks"
  | "globalLibraries"
  | "problems";

export interface Draft {
  name?: string;
  /** `languages.java.jdk`: a JDK home; "" = Auto. */
  jdk?: string;
  structure?: ProjectStructureValid;
}

interface State {
  open: boolean;
  page: PageId;
  /** Selected item per master-detail page. */
  selected: Partial<Record<PageId, string>>;
  /** Pages visited, for Back / Forward. */
  history: PageId[];
  at: number;
  draft: Draft;
  applying: boolean;
  error: string | null;
}

const initial = (): State => ({
  open: false,
  page: "project",
  selected: {},
  history: ["project"],
  at: 0,
  draft: {},
  applying: false,
  error: null,
});

export const useProjectStructure = create<State>(initial);

export function openProjectStructure(page: PageId = "project", item?: string) {
  useProjectStructure.setState({
    ...initial(),
    open: true,
    page,
    history: [page],
    selected: item ? { [page]: item } : {},
  });
}

export function closeProjectStructure() {
  useProjectStructure.setState(initial());
}

/** Shows `page` (and selects `item` on it), recording it for Back / Forward. */
export function showPage(page: PageId, item?: string) {
  useProjectStructure.setState((s) => {
    const history = s.page === page ? s.history : [...s.history.slice(0, s.at + 1), page];
    return {
      page,
      history,
      at: history.length - 1,
      selected: item ? { ...s.selected, [page]: item } : s.selected,
    };
  });
}

export function goBack(delta: -1 | 1) {
  useProjectStructure.setState((s) => {
    const at = Math.min(s.history.length - 1, Math.max(0, s.at + delta));
    return { at, page: s.history[at]! };
  });
}

export function select(page: PageId, id: string) {
  useProjectStructure.setState((s) => ({ selected: { ...s.selected, [page]: id } }));
}

export function editDraft(patch: Draft) {
  useProjectStructure.setState((s) => ({ draft: { ...s.draft, ...patch }, error: null }));
}

/** What the dialog edits, as saved now. */
export function savedValues() {
  const { project, settings } = useProject.getState();
  return {
    name: project?.name ?? "",
    jdk: validateLanguages((settings as { languages?: unknown } | null)?.languages).java.jdk,
    structure: validateProjectStructure((settings as { projectStructure?: unknown } | null)?.projectStructure),
  };
}

const STRUCTURE_KEYS = [
  "sourceRoots",
  "testRoots",
  "resourceRoots",
  "testResourceRoots",
  "excluded",
  "unmarked",
  "contentRoots",
  "excludeFiles",
] as const;

/** The settings writes the draft makes (key → JSON value), and whether the name changes. */
export function draftChanges(
  draft: Draft,
  saved = savedValues(),
): { rename: string | null; settings: Array<[string, string]> } {
  const settings: Array<[string, string]> = [];
  if (draft.jdk !== undefined && draft.jdk !== saved.jdk)
    settings.push(["languages.java.jdk", JSON.stringify(draft.jdk)]);
  if (draft.structure)
    for (const k of STRUCTURE_KEYS)
      if (JSON.stringify(draft.structure[k]) !== JSON.stringify(saved.structure[k]))
        settings.push([`projectStructure.${k}`, JSON.stringify(draft.structure[k])]);
  // An empty name stands for the folder's name.
  const name = draft.name === undefined ? null : draft.name.trim();
  return { rename: name !== null && name !== saved.name ? name : null, settings };
}

export function isDirty(draft: Draft): boolean {
  const c = draftChanges(draft);
  return c.rename !== null || c.settings.length > 0;
}

/** Writes the draft; false (with `error` set) when something could not be saved. */
export async function applyDraft(): Promise<boolean> {
  const { draft } = useProjectStructure.getState();
  const changes = draftChanges(draft);
  if (changes.rename === null && !changes.settings.length) return true;
  if (!isTauri()) {
    useProjectStructure.setState({ draft: {} });
    return true;
  }
  useProjectStructure.setState({ applying: true, error: null });
  try {
    if (changes.rename !== null) {
      const info = await call(commands.projectRename(changes.rename));
      useProject.setState((s) => ({
        project: s.project && { ...s.project, name: info.name },
        settings: info.settings,
      }));
      void commands.menuRefresh();
    }
    for (const [key, value] of changes.settings) await call(commands.settingsSet("project", key, value));
    if (changes.settings.length) await loadSettings();
    useProjectStructure.setState({ draft: {}, applying: false });
    return true;
  } catch (e) {
    useProjectStructure.setState({ applying: false, error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}
