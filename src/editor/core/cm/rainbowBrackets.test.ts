import { describe, expect, it } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { BracketScanner, bracketClass, tagMarks } from "./rainbowBrackets";
import { rainbowGuideStyle } from "./indentGuides";
import { heavyExtension } from "./setup";
import type { EditorSettings } from "@/platform/ipc";

const cStyle = EditorState.languageData.of(() => [
  { commentTokens: { line: "//", block: { open: "/*", close: "*/" } } },
]);

/** `char@depth` of every coloured bracket (`!` for unmatched). */
function marks(doc: string, ext: Extension = [], from = 0, to = doc.length, scanner = new BracketScanner()) {
  const state = EditorState.create({ doc, extensions: ext });
  ensureSyntaxTree(state, doc.length, 5000);
  return scanner.marks(state, from, to).map((m) => `${doc[m.from]}${m.depth < 0 ? "!" : m.depth}`);
}

const lang = (name: string) => languages.find((l) => l.name === name)!.load();
const javascript = () => lang("JavaScript");

describe("rainbow brackets", () => {
  it("colours brackets by nesting depth, cycling through the palette", () => {
    expect(marks("f(a[b{c}d]e)")).toEqual(["(0", "[1", "{2", "}2", "]1", ")0"]);
    expect([0, 1, 2, 3, 4, 5, 6].map(bracketClass)).toEqual([
      "cm-rainbow-bracket-1",
      "cm-rainbow-bracket-2",
      "cm-rainbow-bracket-3",
      "cm-rainbow-bracket-4",
      "cm-rainbow-bracket-5",
      "cm-rainbow-bracket-1",
      "cm-rainbow-bracket-2",
    ]);
  });

  it("marks unmatched and mismatched brackets", () => {
    expect(marks("a)b")).toEqual([")!"]);
    expect(marks("(]")).toEqual(["(!", "]!"]);
    expect(marks("x(y")).toEqual(["(!"]);
    expect(marks("((a)")).toEqual(["(!", "(1", ")1"]);
    expect(bracketClass(-1)).toBe("cm-rainbow-bracket-unmatched");
  });

  it("skips strings and comments lexically when there is no syntax tree", () => {
    const doc = "f(\"(\", '[', `{\n)`) // (\n/* ] */ g()";
    expect(marks(doc, cStyle)).toEqual(["(0", ")0", "(0", ")0"]);
    // Primes and lifetimes are not quotes.
    expect(marks("f x' = (x', y)", cStyle)).toEqual(["(0", ")0"]);
  });

  it("skips strings, comments and regexps with the syntax tree", async () => {
    const doc = 'f("(", /[(]/, `{`) // )\n/* ] */ g([1, {a: 2}])';
    expect(marks(doc, await javascript())).toEqual(["(0", ")0", "(0", "[1", "{2", "}2", "]1", ")0"]);
  });

  it("knows the depth at a viewport far into the document and after edits", () => {
    const body = "x(y)\n".repeat(5000);
    const doc = `{\n${body}[z]\n}`;
    const scanner = new BracketScanner();
    const at = doc.indexOf("[z]");
    expect(marks(doc, cStyle, at, doc.length, scanner)).toEqual(["[1", "]1", "}0"]);
    // Checkpoints make the rescan start near the viewport; an edit before it invalidates them.
    let state = EditorState.create({ doc, extensions: cStyle });
    const tr = state.update({ changes: { from: 100, insert: "(" } });
    scanner.invalidate(100);
    state = tr.state;
    const from = at + 1;
    expect(
      scanner
        .marks(state, from, state.doc.length)
        .map((m) => `${state.doc.sliceString(m.from, m.from + 1)}${m.depth < 0 ? "!" : m.depth}`),
    ).toEqual(["[2", "]2", "}!"]);
  });

  it("is installed by the Rainbow brackets setting", () => {
    const render = (rainbowBrackets: boolean) => {
      const view = new EditorView({
        state: EditorState.create({
          doc: "f(a[b])",
          extensions: [cStyle, heavyExtension(7, { rainbowBrackets } as unknown as EditorSettings)],
        }),
        parent: document.body,
      });
      const classes = [...view.contentDOM.querySelectorAll("[class*=cm-rainbow-bracket]")].map((e) => e.className);
      view.destroy();
      return classes;
    };
    expect(render(false)).toEqual([]);
    expect(render(true)).toEqual([
      "cm-rainbow-bracket-1",
      "cm-rainbow-bracket-2",
      "cm-rainbow-bracket-2",
      "cm-rainbow-bracket-1",
    ]);
  });

  it("colours the angle brackets of type arguments, never comparisons", async () => {
    const java = "Map<String, List<Optional<R>>> m = a < b ? f(x > y) : g();";
    expect(marks(java, await lang("Java"))).toEqual(["<0", "<1", "<2", ">2", ">1", ">0", "(0", ")0", "(0", ")0"]);
    const ts = "let a: Map<string, Array<number>> = f<T>(x < 1);";
    expect(marks(ts, await lang("TypeScript"))).toEqual(["<0", "<1", ">1", ">0", "<0", ">0", "(0", ")0"]);
    const rust = "fn f<T>(v: Vec<Option<T>>) {}";
    expect(marks(rust, await lang("Rust"))).toEqual(["<0", ">0", "(0", "<1", "<2", ">2", ">1", ")0", "{0", "}0"]);
    // Without a syntax tree, `<` stays an operator.
    expect(marks("if (a < b) { x = c > d; }", cStyle)).toEqual(["(0", ")0", "{0", "}0"]);
  });

  it("colours HTML, XML and JSX tags by element depth, mismatched close tags as unmatched", async () => {
    const tags = async (doc: string, name: string) => {
      const state = EditorState.create({ doc, extensions: await lang(name) });
      ensureSyntaxTree(state, doc.length, 5000);
      return tagMarks(state, 0, doc.length).map(
        (m) => `${doc.slice(m.from, m.from + m.length)}${m.depth < 0 ? "!" : m.depth}`,
      );
    };
    expect(await tags('<div><a href="x">t</a><br/></div></p>', "HTML")).toEqual([
      "<0",
      "div0",
      ">0",
      "<1",
      "a1",
      ">1",
      "</1",
      "a1",
      ">1",
      "<1",
      "br1",
      "/>1",
      "</0",
      "div0",
      ">0",
      "</!",
      "p!",
      ">!",
    ]);
    expect(await tags('const x = <div className="a"><Foo.Bar a={1}/></div>;', "TSX")).toEqual([
      "<0",
      "div0",
      ">0",
      "<1",
      "Foo.Bar1",
      "/>1",
      "</0",
      "div0",
      ">0",
    ]);
  });

  it("draws rainbow indent guides in the bracket colours, one layer per level but the outermost", () => {
    const style = rainbowGuideStyle(7, 4);
    // Levels 1–6: the outermost block (a class body as long as the file) has no guide.
    expect(style.match(/linear-gradient/g)).toHaveLength(6);
    expect(style).not.toContain("calc(6px + 0ch)");
    expect(style.split("linear-gradient")[1]).toContain("--luma-rainbow-guide-2");
    // Level 5 wraps to the first colour.
    expect(style.split("linear-gradient")[5]).toContain("--luma-rainbow-guide-1");
    expect(style).toContain("calc(6px + 24ch) 0");
    expect(rainbowGuideStyle(1, 4)).not.toContain("linear-gradient");
  });

  it("colours only the bracket kinds that are switched on", () => {
    const render = (rainbow: Record<string, boolean>) => {
      const view = new EditorView({
        state: EditorState.create({
          doc: "f(a[b{c}])",
          extensions: [cStyle, heavyExtension(10, { rainbowBrackets: true, rainbow } as unknown as EditorSettings)],
        }),
        parent: document.body,
      });
      const text = [...view.contentDOM.querySelectorAll("[class*=cm-rainbow-bracket]")].map((e) => e.textContent);
      view.destroy();
      return text.join("");
    };
    expect(render({})).toBe("([{}])");
    expect(render({ square: false })).toBe("({})");
    expect(render({ round: false, curly: false })).toBe("[]");
  });
});
