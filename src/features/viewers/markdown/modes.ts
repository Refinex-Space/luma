/**
 * Markdown editor layout per file: Live Preview (the editor renders the Markdown it edits),
 * Source (plain editor), Source and Preview side by side (IDEA's split editor), or Preview only.
 */
import { create } from "zustand";

export type MarkdownMode = "live" | "editor" | "split" | "preview";

// v2: Live Preview arrived as the default; earlier choices predate it.
const DEFAULT_KEY = "luma.markdown.defaultMode.v2";
export const MARKDOWN_MODES: readonly MarkdownMode[] = ["live", "editor", "split", "preview"];

function storedDefault(): MarkdownMode {
  try {
    const v = localStorage.getItem(DEFAULT_KEY);
    return MARKDOWN_MODES.includes(v as MarkdownMode) ? (v as MarkdownMode) : "live";
  } catch {
    return "live";
  }
}

interface ModesState {
  byPath: Record<string, MarkdownMode>;
  /** Mode of files not switched yet: the last one chosen. */
  fallback: MarkdownMode;
}

export const useMarkdownModes = create<ModesState>(() => ({ byPath: {}, fallback: storedDefault() }));

export const modeOf = (s: ModesState, path: string): MarkdownMode => s.byPath[path] ?? s.fallback;

export function setMarkdownMode(path: string, mode: MarkdownMode) {
  useMarkdownModes.setState((s) => ({ byPath: { ...s.byPath, [path]: mode }, fallback: mode }));
  try {
    localStorage.setItem(DEFAULT_KEY, mode);
  } catch {
    // Per-viewer convenience only.
  }
}
