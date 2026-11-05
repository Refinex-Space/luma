import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { inlineMathEnd, markdownSupport } from "@/editor/core/cm/markdownLang";
import { slashGroups } from "./catalog";
import { codeBlockKeys, fenceShape, languageSuggestions } from "./codeBlocks";
import { insertBlock, lineShape, setBlock, toggleInline } from "./commands";
import { blockLayer } from "./blocks";
import { liveState, setLiveFocus, setLivePreview, setPointerSelecting, touches } from "./state";
import {
  alignColumn,
  cellSource,
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  parseTable,
  setCell,
  type Change,
} from "./tableModel";

const apply = (text: string, changes: Change | Change[] | null) => {
  if (!changes) return text;
  const list = (Array.isArray(changes) ? changes : [changes]).slice().sort((a, b) => b.from - a.from);
  for (const c of list) text = text.slice(0, c.from) + c.insert + text.slice(c.to);
  return text;
};

const nodes = (doc: string) => {
  const state = EditorState.create({ doc, extensions: [markdownSupport()] });
  const names: string[] = [];
  ensureSyntaxTree(state, doc.length, 5000)!.iterate({ enter: (n) => void names.push(n.name) });
  return names;
};

describe("Markdown syntax", () => {
  it("parses inline and display math by Pandoc's rules", () => {
    expect(inlineMathEnd("$x^2$ and", 0)).toBe(4);
    expect(inlineMathEnd("$ x$", 0)).toBe(-1);
    expect(inlineMathEnd("costs $5 or $6", 6)).toBe(-1);
    expect(inlineMathEnd("$a \\$ b$", 0)).toBe(7);
    expect(nodes("Euler $e^{i\\pi}$ here")).toContain("InlineMath");
    expect(nodes("$$\n\\int x\n$$\n")).toContain("BlockMath");
    expect(nodes("$$ a + b $$\n")).toContain("BlockMath");
    expect(nodes("Costs $5 and $10.")).not.toContain("InlineMath");
  });

  it("reads front matter only at the top, and GFM tables and tasks", () => {
    expect(nodes("---\ntitle: x\n---\n# A\n")).toContain("FrontMatter");
    expect(nodes("# A\n\n---\ntitle: x\n---\n")).not.toContain("FrontMatter");
    const gfm = nodes("| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n");
    expect(gfm).toContain("Table");
    expect(gfm).toContain("TaskMarker");
  });
});

describe("table model", () => {
  const src = "| Name | Age |\n|---|:-:|\n| Ada | 36 |\n| Bob |  |";

  it("splits cells at unescaped pipes outside code spans", () => {
    const t = parseTable("| `a|b` | c \\| d | e |\n|---|---|---|", 0)!;
    expect(t.columns).toBe(3);
    expect(t.header.segs.map((s) => s.trim())).toEqual(["`a|b`", "c \\| d", "e"]);
    expect(t.aligns).toEqual([null, null, null]);
    expect(parseTable(src, 0)!.aligns).toEqual([null, "center"]);
  });

  it("edits one cell and leaves every other byte alone", () => {
    const t = parseTable(src, 0)!;
    expect(apply(src, setCell(t, 1, 0, "Ada L."))).toBe("| Name | Age |\n|---|:-:|\n| Ada L. | 36 |\n| Bob |  |");
    expect(apply(src, setCell(t, 2, 1, "41"))).toBe("| Name | Age |\n|---|:-:|\n| Ada | 36 |\n| Bob | 41 |");
    expect(cellSource("a|b\nc")).toBe("a\\|b<br>c");
  });

  it("inserts, deletes and moves rows and columns", () => {
    const t = parseTable(src, 0)!;
    expect(apply(src, insertRow(t, 1))).toBe("| Name | Age |\n|---|:-:|\n| Ada | 36 |\n|  |  |\n| Bob |  |");
    expect(apply(src, deleteRow(t, 1))).toBe("| Name | Age |\n|---|:-:|\n| Bob |  |");
    expect(apply(src, moveRow(t, 1, 1))).toBe("| Name | Age |\n|---|:-:|\n| Bob |  |\n| Ada | 36 |");
    expect(apply(src, insertColumn(t, 1))).toBe("| Name |  | Age |\n|---|---|:-:|\n| Ada |  | 36 |\n| Bob |  |  |");
    expect(apply(src, deleteColumn(t, 0))).toBe("| Age |\n|:-:|\n| 36 |\n|  |");
    expect(apply(src, moveColumn(t, 0, 1))).toBe("| Age | Name |\n|:-:|---|\n| 36 | Ada |\n|  | Bob |");
    expect(apply(src, alignColumn(t, 0, "right"))).toBe("| Name | Age |\n|---:|:-:|\n| Ada | 36 |\n| Bob |  |");
    expect(deleteRow(t, 0)).toBeNull();
    expect(moveColumn(t, 1, 1)).toBeNull();
  });
});

describe("editing commands", () => {
  let view: EditorView | null = null;
  afterEach(() => view?.destroy());

  const make = (doc: string, anchor: number, head = anchor) => {
    view = new EditorView({
      state: EditorState.create({
        doc,
        selection: EditorSelection.single(anchor, head),
        extensions: [markdownSupport()],
      }),
      parent: document.body,
    });
    ensureSyntaxTree(view.state, doc.length, 5000);
    return view;
  };

  it("wraps and unwraps inline formats", () => {
    const v = make("say hello world", 4, 9);
    toggleInline(v, "bold");
    expect(v.state.doc.toString()).toBe("say **hello** world");
    expect(v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to)).toBe("hello");
    ensureSyntaxTree(v.state, v.state.doc.length, 5000);
    toggleInline(v, "bold");
    expect(v.state.doc.toString()).toBe("say hello world");
    // A caret in a word formats the word.
    v.dispatch({ selection: { anchor: 12 } });
    toggleInline(v, "code");
    expect(v.state.doc.toString()).toBe("say hello `world`");
  });

  it("converts lines between paragraphs, headings, lists, tasks and quotes", () => {
    const v = make("one\ntwo", 0, 7);
    setBlock(v, "ordered");
    expect(v.state.doc.toString()).toBe("1. one\n2. two");
    v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
    setBlock(v, "task");
    expect(v.state.doc.toString()).toBe("- [ ] one\n- [ ] two");
    setBlock(v, "task");
    expect(v.state.doc.toString()).toBe("one\ntwo");
    v.dispatch({ selection: { anchor: 0 } });
    setBlock(v, "h2");
    expect(v.state.doc.toString()).toBe("## one\ntwo");
    setBlock(v, "h2");
    expect(v.state.doc.toString()).toBe("one\ntwo");
    setBlock(v, "quote");
    expect(v.state.doc.toString()).toBe("> one\ntwo");
    // The caret moves past the markers it was in front of.
    expect(v.state.selection.main.head).toBe(2);
    expect(lineShape("  > - [x] item")).toMatchObject({ indent: "  ", quote: "> ", list: "bullet", task: "[x] " });
  });

  it("inserts blocks on their own lines, replacing the slash command", () => {
    const v = make("intro\n/tab", 10);
    insertBlock(v, "code", { from: 6, to: 10 });
    // A blank line keeps the block apart from the paragraph above.
    expect(v.state.doc.toString()).toBe("intro\n\n```\n\n```\n");
    expect(v.state.selection.main.head).toBe(11);
    const w = make("text", 4);
    insertBlock(w, "mermaid:pie");
    expect(w.state.doc.toString()).toMatch(/^text\n\n```mermaid\npie title Share\n/);
  });
});

describe("slash menu", () => {
  it("lists sections when empty and finds by English, Markdown or pinyin", () => {
    expect(slashGroups("").map((g) => g.section)).toEqual(["Basic Blocks", "Lists", "Insert", "Diagrams"]);
    expect(slashGroups("h2")[0]!.items[0]!.id).toBe("h2");
    expect(slashGroups("bg")[0]!.items[0]!.id).toBe("table");
    expect(slashGroups("lct")[0]!.items[0]!.id).toBe("flowchart");
    expect(slashGroups("qqqqq")).toEqual([]);
  });
});

describe("reveal", () => {
  it("shows a construct's source only while the focused selection touches it", () => {
    const state = EditorState.create({ doc: "a **b** c", selection: { anchor: 0 }, extensions: [liveState] });
    const on = state.update({ effects: [setLivePreview.of(true)] }).state;
    expect(touches(on, 2, 7)).toBe(false);
    const focused = on.update({ effects: setLiveFocus.of(true), selection: { anchor: 4 } }).state;
    expect(touches(focused, 2, 7)).toBe(true);
    expect(touches(focused.update({ selection: { anchor: 9 } }).state, 2, 7)).toBe(false);
  });
});

describe("code cards", () => {
  let view: EditorView | null = null;
  afterEach(() => view?.destroy());

  const live = (doc: string, anchor: number) => {
    view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor },
        extensions: [markdownSupport(), liveState, codeBlockKeys],
      }),
      parent: document.body,
    });
    view.dispatch({ effects: setLivePreview.of(true) });
    ensureSyntaxTree(view.state, doc.length, 5000);
    return view;
  };
  const key = (v: EditorView, k: string) =>
    v.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

  it("finds the fences to hide and the language to show", () => {
    const state = EditorState.create({ doc: "```ts\nlet a\n```\n\n```\n```", extensions: [markdownSupport()] });
    const tree = ensureSyntaxTree(state, state.doc.length, 5000)!;
    const fences: ReturnType<typeof fenceShape>[] = [];
    tree.iterate({ enter: (n) => void (n.name === "FencedCode" && fences.push(fenceShape(state, n.node))) });
    expect(fences[0]).toMatchObject({ lang: "ts", open: { from: 0, to: 5 }, close: { from: 12, to: 15 } });
    // Nothing between the fences: they stay visible.
    expect(fences[1]).toBeNull();
    expect(languageSuggestions("py")[0]).toBe("python");
    expect(languageSuggestions("")).toContain("java");
  });

  it("closes a typed fence on Enter and keeps Backspace out of the fences", () => {
    const v = live("```js", 5);
    key(v, "Enter");
    expect(v.state.doc.toString()).toBe("```js\n\n```");
    expect(v.state.selection.main.head).toBe(6);
    ensureSyntaxTree(v.state, v.state.doc.length, 5000);
    key(v, "Backspace");
    // An empty block goes away whole.
    expect(v.state.doc.toString()).toBe("");
    const w = live("```\ncode\n```\nafter", 13);
    key(w, "Backspace");
    expect(w.state.doc.toString()).toBe("```\ncode\n```\nafter");
    expect(w.state.selection.main.head).toBe(8);
  });
});

describe("table cells", () => {
  let view: EditorView | null = null;
  afterEach(() => view?.destroy());

  const table = () => {
    const doc = "| Name | Starter |\n|---|---|\n| tools | `spring-ai` |";
    view = new EditorView({
      state: EditorState.create({ doc, extensions: [markdownSupport(), liveState, blockLayer("/doc.md")] }),
      parent: document.body,
    });
    ensureSyntaxTree(view.state, doc.length, 5000);
    view.dispatch({ effects: setLivePreview.of(true) });
    const cell = [...view.dom.querySelectorAll<HTMLElement>(".cm-md-cell")].find(
      (c) => c.dataset.raw === "`spring-ai`",
    )!;
    expect(cell.querySelector("code")).not.toBeNull();
    return { view, cell };
  };
  const focus = (cell: HTMLElement, type: "focusin" | "focusout") =>
    cell.dispatchEvent(new FocusEvent(type, { bubbles: true }));
  const frame = () => new Promise((r) => requestAnimationFrame(r));

  it("shows a cell's source while editing and renders it again on leaving", () => {
    const { cell } = table();
    focus(cell, "focusin");
    expect(cell.textContent).toBe("`spring-ai`");
    focus(cell, "focusout");
    expect(cell.querySelector("code")?.textContent).toBe("spring-ai");
  });

  it("keeps the layout still while a click in the text takes focus from a cell", async () => {
    const { view, cell } = table();
    focus(cell, "focusin");
    // The press in the text: the editor resolves the click while the cell loses focus.
    view.dispatch({ effects: setPointerSelecting.of(true) });
    focus(cell, "focusout");
    expect(cell.textContent).toBe("`spring-ai`");
    window.dispatchEvent(new MouseEvent("mouseup"));
    await frame();
    expect(cell.querySelector("code")?.textContent).toBe("spring-ai");
  });
});
