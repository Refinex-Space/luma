import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { highlightingFor, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { lumaHighlightStyle } from "./highlight";
import { setSyntaxHighlights, syntaxHighlightField } from "./syntaxHighlight";

function marks(state: EditorState) {
  const out: { text: string; cls: string }[] = [];
  state.field(syntaxHighlightField).between(0, state.doc.length, (from, to, d) => {
    out.push({ text: state.doc.sliceString(from, to), cls: d.spec.class as string });
  });
  return out;
}

describe("syntaxHighlightField", () => {
  const create = () =>
    EditorState.create({
      doc: "def hi, do: :ok",
      extensions: [syntaxHighlighting(lumaHighlightStyle), syntaxHighlightField],
    });

  it("styles backend ranges with the active highlight style and maps them through edits", () => {
    let state = create();
    state = state.update({
      effects: setSyntaxHighlights.of({
        kinds: ["keyword", "atom", "functionCall"],
        data: [0, 3, 0, 4, 6, 2, 12, 15, 1, 99, 120, 0],
      }),
    }).state;
    const keyword = highlightingFor(state, [t.keyword]);
    const atom = highlightingFor(state, [t.atom]);
    expect(keyword).toBeTruthy();
    expect(marks(state)).toEqual([
      { text: "def", cls: keyword },
      { text: "hi", cls: highlightingFor(state, [t.function(t.variableName)]) },
      { text: ":ok", cls: atom },
    ]);

    state = state.update({ changes: { from: 0, insert: "  " } }).state;
    expect(marks(state).map((m) => m.text)).toEqual(["def", "hi", ":ok"]);
  });
});
