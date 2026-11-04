/**
 * The slash menu: typing `/` (or `、`, the same key in Chinese input methods) at the start of
 * a line or after a space opens a menu of Markdown blocks under the caret; what follows the
 * slash filters it. Arrow keys move, Enter or Tab inserts, Escape closes and keeps the text.
 * The menu itself is React (`SlashMenu`), fed by the store this plugin writes.
 */
import { Prec } from "@codemirror/state";
import { closeCompletion } from "@codemirror/autocomplete";
import { EditorView, keymap, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { create } from "zustand";
import { MAX_QUERY, slashGroups, type SlashCommand } from "./catalog";

let mounted = false;
/** The menu mounts on first use into its own body-level host. */
function mountSlashMenu() {
  if (mounted) return;
  mounted = true;
  void Promise.all([import("react"), import("react-dom/client"), import("./SlashMenu")]).then(([react, dom, m]) => {
    const host = document.createElement("div");
    host.dataset.slashMenu = "";
    document.body.append(host);
    dom.createRoot(host).render(react.createElement(m.SlashMenu));
  });
}

const TRIGGERS = new Set(["/", "、"]);

export interface SlashState {
  view: EditorView | null;
  /** Position of the slash. */
  from: number;
  query: string;
  active: number;
  /** Where to show the menu (the slash's screen box). */
  rect: DOMRect | null;
}

export const useSlash = create<SlashState>(() => ({ view: null, from: 0, query: "", active: 0, rect: null }));

export const slashItems = (query: string) => slashGroups(query).flatMap((g) => g.items);

export function closeSlash() {
  if (useSlash.getState().view) useSlash.setState({ view: null, rect: null, active: 0, query: "" });
}

/** Runs `item` for the open menu: the `/query` text is replaced by what it inserts. */
export function runSlash(item: SlashCommand) {
  const { view, from } = useSlash.getState();
  if (!view) return;
  const head = view.state.selection.main.head;
  closeSlash();
  item.run(view, { from, to: Math.max(from + 1, head) });
}

function caretRect(view: EditorView, pos: number): DOMRect | null {
  const c = view.coordsAtPos(pos);
  return c ? new DOMRect(c.left, c.top, Math.max(1, c.right - c.left), c.bottom - c.top) : null;
}

/** Whether a `/` typed at `pos` (just inserted) starts a command. */
function opensAt(view: EditorView, pos: number): boolean {
  const line = view.state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  // Line start, after a space, or after list / quote markers.
  return before === "" || /\s$/.test(before);
}

const slashPlugin = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {}

    update(u: ViewUpdate) {
      const s = useSlash.getState();
      const mine = s.view === this.view;
      if (u.docChanged) {
        let typed: { pos: number; text: string } | null = null;
        for (const tr of u.transactions) {
          if (!tr.isUserEvent("input.type")) continue;
          tr.changes.iterChanges((_fa, _ta, fromB, _tb, inserted) => {
            const text = inserted.toString();
            if (TRIGGERS.has(text)) typed = { pos: fromB, text };
          });
        }
        if (typed && opensAt(this.view, (typed as { pos: number }).pos)) {
          const pos = (typed as { pos: number }).pos;
          // Not while this update runs: closing completion dispatches.
          const view = this.view;
          queueMicrotask(() => closeCompletion(view));
          useSlash.setState({ view: this.view, from: pos, query: "", active: 0, rect: null });
          mountSlashMenu();
          this.measure(pos);
          return;
        }
      }
      if (!mine) return;
      const from = u.docChanged ? u.changes.mapPos(s.from) : s.from;
      const head = u.state.selection.main.head;
      const line = u.state.doc.lineAt(from);
      const valid =
        u.state.selection.main.empty &&
        head > from &&
        head <= line.to &&
        TRIGGERS.has(u.state.sliceDoc(from, from + 1));
      if (!valid) return closeSlash();
      const query = u.state.sliceDoc(from + 1, head);
      if (query.length > MAX_QUERY || /\s{2}|^\s/.test(query) || (/\s$/.test(query) && !slashItems(query).length))
        return closeSlash();
      if (query !== s.query || from !== s.from)
        useSlash.setState({ query, from, active: query !== s.query ? 0 : s.active });
      if (u.geometryChanged || u.viewportChanged || from !== s.from) this.measure(from);
    }

    measure(pos: number) {
      this.view.requestMeasure({
        read: (view) => caretRect(view, pos),
        write: (rect) => {
          if (useSlash.getState().view === this.view) useSlash.setState({ rect });
        },
      });
    }

    destroy() {
      if (useSlash.getState().view === this.view) closeSlash();
    }
  },
);

const open = (view: EditorView) => useSlash.getState().view === view;

function move(view: EditorView, d: number): boolean {
  if (!open(view)) return false;
  const n = slashItems(useSlash.getState().query).length;
  if (!n) return false;
  useSlash.setState((s) => ({ active: (s.active + d + n) % n }));
  return true;
}

function accept(view: EditorView): boolean {
  if (!open(view)) return false;
  const s = useSlash.getState();
  const item = slashItems(s.query)[s.active];
  if (!item) {
    closeSlash();
    return false;
  }
  runSlash(item);
  return true;
}

const slashKeys = Prec.highest(
  keymap.of([
    { key: "ArrowDown", run: (v) => move(v, 1) },
    { key: "ArrowUp", run: (v) => move(v, -1) },
    { key: "Ctrl-n", run: (v) => move(v, 1) },
    { key: "Ctrl-p", run: (v) => move(v, -1) },
    { key: "Enter", run: accept },
    { key: "Tab", run: accept },
    {
      key: "Escape",
      run: (v) => {
        if (!open(v)) return false;
        closeSlash();
        return true;
      },
    },
  ]),
);

export const slashMenu = [
  slashPlugin,
  slashKeys,
  EditorView.domEventHandlers({
    blur: (_e, view) => {
      // Clicking the menu keeps focus in the editor (its items don't take focus).
      if (open(view)) setTimeout(() => !view.hasFocus && open(view) && closeSlash(), 0);
    },
    scroll: (_e, view) => {
      if (open(view)) {
        const { from } = useSlash.getState();
        view.requestMeasure({
          read: (v) => caretRect(v, from),
          write: (rect) => open(view) && useSlash.setState({ rect }),
        });
      }
    },
  }),
];
