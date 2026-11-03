/**
 * Hooks for the performance harness (`perf/`), exposed as `window.__lamaPerf`.
 * Loaded only in dev and in `vite build --mode perf`; release builds never
 * include it. Measurement itself lives in the harness so it stays out of the app.
 */
import { syntaxParserRunning } from "@codemirror/language";
import { executeAction } from "@/platform/actions";
import { bindingsFor } from "@/platform/keymap";
import { activeEditor } from "@/editor/api";
import { docBackend, type MemoryBackend } from "@/editor/core/backend";
import { editorService } from "./contributions";

export interface PerfProbe {
  /** Seeds file contents for the in-memory document backend (plain-browser mode). */
  seed(path: string, text: string): void;
  openFile(path: string): Promise<void>;
  runAction(id: string): Promise<boolean>;
  /** Effective keymap bindings of an action, e.g. `["Ctrl+Shift+A"]`. */
  bindings(id: string): string[];
  /** Moves the caret of the active editor and focuses it. */
  setCursor(offset: number): void;
  /** True while the active editor's background syntax parser still has work. */
  parsing(): boolean;
  /** Document length and caret of the active editor. */
  editorState(): { path: string; length: number; lines: number; head: number } | null;
}

export function installPerfProbe(): () => void {
  const probe: PerfProbe = {
    seed(path, text) {
      const backend = docBackend() as Partial<MemoryBackend>;
      if (!backend.files) throw new Error("seed() needs the in-memory backend");
      backend.files.set(path, text);
    },
    openFile: (path) => editorService().openFile(path),
    runAction: (id) => executeAction(id),
    bindings: (id) => bindingsFor(id),
    setCursor(offset) {
      const view = activeEditor()?.view;
      if (!view) throw new Error("no active editor");
      view.dispatch({ selection: { anchor: Math.min(offset, view.state.doc.length) }, scrollIntoView: true });
      view.focus();
    },
    parsing() {
      const view = activeEditor()?.view;
      return !!view && syntaxParserRunning(view);
    },
    editorState() {
      const e = activeEditor();
      if (!e) return null;
      const { doc, selection } = e.view.state;
      return { path: e.ctx.path, length: doc.length, lines: doc.lines, head: selection.main.head };
    },
  };
  const w = window as unknown as { __lamaPerf?: PerfProbe };
  w.__lamaPerf = probe;
  return () => void delete w.__lamaPerf;
}
