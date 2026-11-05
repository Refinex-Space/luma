/**
 * Live preview state of one Markdown editor: whether it is on, and the selection that decides
 * which constructs show their source ("revealed"). While the mouse is selecting, the reveal
 * stays where it was so the text does not shift under the pointer; it catches up on release.
 */
import { EditorSelection, StateEffect, StateField, type EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { minimapHidden } from "@/editor/api";

export const setLivePreview = StateEffect.define<boolean>();
/** The editor gained (true) or lost (false) focus. */
export const setLiveFocus = StateEffect.define<boolean>();
/** The pointer went down (true) or up (false) in the text. */
export const setPointerSelecting = StateEffect.define<boolean>();

export interface LiveState {
  on: boolean;
  focused: boolean;
  selecting: boolean;
  /** The selection constructs reveal their source for, or null when nothing is revealed. */
  reveal: EditorSelection | null;
}

const revealOf = (s: LiveState, sel: EditorSelection) => (s.focused ? sel : null);

export const liveState = StateField.define<LiveState>({
  create: () => ({ on: false, focused: false, selecting: false, reveal: null }),
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setLivePreview)) next = { ...next, on: e.value };
      else if (e.is(setLiveFocus)) next = { ...next, focused: e.value };
      else if (e.is(setPointerSelecting)) next = { ...next, selecting: e.value };
    }
    if (next.selecting) {
      // Map the frozen reveal through edits; keep it otherwise.
      if (next.reveal && tr.docChanged) next = { ...next, reveal: next.reveal.map(tr.changes) };
      return next;
    }
    const reveal = revealOf(next, tr.state.selection);
    const same = reveal === null ? value.reveal === null : value.reveal !== null && reveal.eq(value.reveal);
    return next === value && same ? value : { ...next, reveal };
  },
  provide: (f) => [
    // A document to read: the outline beside it does the minimap's job.
    minimapHidden.from(f, (s) => s.on),
    EditorView.editorAttributes.from(f, (s): Record<string, string> => (s.on ? { class: "cm-md-live" } : {})),
    // Prose wraps at the column's width (never a sideways scroll).
    EditorView.contentAttributes.from(f, (s): Record<string, string> => (s.on ? { class: "cm-lineWrapping" } : {})),
  ],
});

export const isLive = (state: EditorState) => state.field(liveState, false)?.on ?? false;

/** Whether the reveal selection touches `[from, to]` (ends included). */
export function touches(state: EditorState, from: number, to: number): boolean {
  const reveal = state.field(liveState, false)?.reveal;
  return !!reveal && reveal.ranges.some((r) => r.from <= to && r.to >= from);
}

/** Whether the reveal selection lies strictly inside `(from, to)` (used by rendered blocks you edit in place). */
export function inside(state: EditorState, from: number, to: number): boolean {
  const reveal = state.field(liveState, false)?.reveal;
  return !!reveal && reveal.ranges.some((r) => r.from > from && r.to < to);
}

/** Whether the reveal selection touches the lines of `[from, to]`. */
export function touchesLines(state: EditorState, from: number, to: number): boolean {
  const doc = state.doc;
  return touches(state, doc.lineAt(from).from, doc.lineAt(to).to);
}

/** Keeps focus and pointer state up to date. */
export const liveTracking = EditorView.domEventHandlers({
  focus: (_e, view) => void view.dispatch({ effects: setLiveFocus.of(true) }),
  blur: (_e, view) => {
    // Focus moving into a widget of this editor (a table cell) or to nothing keeps the reveal.
    queueMicrotask(() => {
      if (!view.hasFocus && view.state.field(liveState).focused) view.dispatch({ effects: setLiveFocus.of(false) });
    });
  },
  mousedown: (e, view) => {
    if (e.button !== 0) return false;
    view.dispatch({ effects: setPointerSelecting.of(true) });
    const up = () => {
      window.removeEventListener("mouseup", up, true);
      // After the click's own selection change.
      requestAnimationFrame(() => {
        if (view.state.field(liveState, false)?.selecting) view.dispatch({ effects: setPointerSelecting.of(false) });
      });
    };
    window.addEventListener("mouseup", up, true);
    return false;
  },
});
