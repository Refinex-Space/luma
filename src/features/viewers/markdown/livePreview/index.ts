/**
 * Live Preview for Markdown files: the editor renders the Markdown it edits (Obsidian-style),
 * the source showing only where the caret is. Contributed to every Markdown editor; on while
 * the file's layout is Live Preview, so switching layouts never recreates the editor.
 */
import { Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap, ViewPlugin } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { registerEditorContribution } from "@/editor/api";
import { isMarkdownPath } from "../../fileKinds";
import { modeOf, useMarkdownModes } from "../modes";
import { registerMarkdownActions } from "./actions";
import { blockLayer } from "./blocks";
import { codeBlockKeys } from "./codeBlocks";
import { inlineLayer } from "./inline";
import { followLink } from "./links";
import { isLive, liveState, liveTracking, setLiveFocus, setLivePreview } from "./state";
import { slashMenu } from "./slash";
import { tableAt } from "./table";
import { selectionToolbar } from "./toolbar";
import { liveTheme } from "./theme";

/** Keeps the editor's live preview in step with its file's layout. */
function modeSync(path: string) {
  return ViewPlugin.define((view) => {
    const apply = () => {
      const on = modeOf(useMarkdownModes.getState(), path) === "live";
      if (on !== isLive(view.state)) view.dispatch({ effects: setLivePreview.of(on) });
    };
    queueMicrotask(() => {
      if (view.hasFocus) view.dispatch({ effects: setLiveFocus.of(true) });
      apply();
    });
    const unsubscribe = useMarkdownModes.subscribe(apply);
    return { destroy: unsubscribe };
  });
}

/** ⌘/Ctrl held: links show they can be followed. */
const modKey = ViewPlugin.define((view) => {
  const set = (e: KeyboardEvent | MouseEvent) =>
    view.dom.classList.toggle("cm-md-mod", (e.metaKey || e.ctrlKey) && isLive(view.state));
  const clear = () => view.dom.classList.remove("cm-md-mod");
  window.addEventListener("keydown", set, true);
  window.addEventListener("keyup", set, true);
  window.addEventListener("blur", clear);
  view.dom.addEventListener("mousemove", set);
  return {
    destroy() {
      window.removeEventListener("keydown", set, true);
      window.removeEventListener("keyup", set, true);
      window.removeEventListener("blur", clear);
      view.dom.removeEventListener("mousemove", set);
    },
  };
});

function linkClicks(path: string) {
  return EditorView.domEventHandlers({
    mousedown(e, view) {
      if (!(e.metaKey || e.ctrlKey) || e.button !== 0 || !isLive(view.state)) return false;
      const link = (e.target as Element).closest<HTMLElement>(".cm-md-link");
      const href = link?.dataset.href;
      if (!href) return false;
      e.preventDefault();
      followLink(view, path, href);
      return true;
    },
  });
}

/** The top-level table starting on line `n`, if any (its `from`). */
function tableOnLine(view: EditorView, n: number): number | null {
  const doc = view.state.doc;
  if (n < 1 || n > doc.lines) return null;
  const line = doc.line(n);
  const node = syntaxTree(view.state).resolveInner(line.from, 1);
  for (let p: typeof node | null = node; p; p = p.parent)
    if (p.name === "Table") return p.from === line.from ? p.from : null;
  return null;
}

/** Arrow keys into a rendered table move into its cells. */
const tableArrows = Prec.high(
  keymap.of([
    {
      key: "ArrowDown",
      run(view) {
        if (!isLive(view.state) || !view.state.selection.main.empty) return false;
        const line = view.state.doc.lineAt(view.state.selection.main.head);
        if (view.moveVertically(view.state.selection.main, true).head <= line.to) return false;
        const from = tableOnLine(view, line.number + 1);
        const table = from === null ? null : tableAt(view, from);
        if (!table) return false;
        table.focusCell(0, 0, "end");
        return true;
      },
    },
    {
      key: "ArrowUp",
      run(view) {
        if (!isLive(view.state) || !view.state.selection.main.empty) return false;
        const doc = view.state.doc;
        const line = doc.lineAt(view.state.selection.main.head);
        if (view.moveVertically(view.state.selection.main, false).head >= line.from) return false;
        // The table ending on the line above.
        let n = line.number - 1;
        while (n > 1 && /\|/.test(doc.line(n - 1).text)) n--;
        const from = tableOnLine(view, n);
        const table = from === null ? null : tableAt(view, from);
        if (!table) return false;
        const rows = Math.max(0, line.number - 1 - n - 1);
        table.focusCell(rows, 0, "end");
        return true;
      },
    },
  ]),
);

export function livePreview(path: string): Extension {
  return [
    liveState,
    liveTracking,
    modeSync(path),
    inlineLayer(path),
    blockLayer(path),
    liveTheme,
    modKey,
    linkClicks(path),
    tableArrows,
    codeBlockKeys,
    slashMenu,
    selectionToolbar,
  ];
}

export function registerLivePreview(): () => void {
  const disposers = [
    registerEditorContribution({
      id: "viewers.markdownLivePreview",
      extensions: (ctx) => (!ctx.virtual && isMarkdownPath(ctx.path) ? livePreview(ctx.path) : []),
    }),
    registerMarkdownActions(),
  ];
  return () => disposers.reverse().forEach((d) => d());
}

export { isLive, liveState };
