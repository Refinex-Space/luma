/**
 * The live preview's block layer (block widgets must come from state): tables, display math,
 * Mermaid diagrams and HTML blocks replaced by their rendering, and every code block's fences
 * replaced by the card's top and footer (see `codeBlocks.ts`). Math and diagrams show their
 * source when the caret enters them, as a code card with the rendering kept below; a table is
 * edited in its cells and shows its source only when the caret is put inside it ("Edit Table
 * as Source"). The hidden fence lines are atomic ranges.
 */
import { syntaxTree } from "@codemirror/language";
import {
  RangeSet,
  RangeSetBuilder,
  StateField,
  type EditorState,
  type Range,
  type RangeValue,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { CodeFooterWidget, CodeTopWidget, fenceShape } from "./codeBlocks";
import { DIAGRAM_LANGS, MATH_LANGS, fenceLang } from "./inline";
import { inside, isLive, liveState, touches } from "./state";
import { TableWidget } from "./table";
import { HtmlWidget, MathWidget, MermaidWidget } from "./widgets";

/** Documents past this size keep their block constructs as source (each pass walks all blocks). */
const MAX_DOC = 2_000_000;

/** Nodes whose content is inline: nothing block-level inside. */
const INLINE_CONTAINERS = new Set([
  "Paragraph",
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
  "SetextHeading1",
  "SetextHeading2",
  "Table",
  "HTMLBlock",
  "CommentBlock",
  "LinkReference",
  "FrontMatter",
]);

interface Blocks {
  deco: DecorationSet;
  atomic: RangeSet<RangeValue>;
}

const ATOMIC = Decoration.mark({});

function fenceBody(state: EditorState, node: SyntaxNode): string {
  const text = node.getChild("CodeText");
  return text ? state.sliceDoc(text.from, text.to).replace(/\n+$/, "") : "";
}

function build(state: EditorState, doc: string): Blocks {
  if (!isLive(state) || state.doc.length > MAX_DOC) return { deco: Decoration.none, atomic: RangeSet.empty };
  const out: Range<Decoration>[] = [];
  const atomic: [number, number][] = [];
  const lines = state.doc;
  const replace = (node: SyntaxNode, widget: Decoration) => {
    out.push(widget.range(lines.lineAt(node.from).from, lines.lineAt(node.to).to));
  };
  const after = (node: SyntaxNode, widget: MathWidget | MermaidWidget) =>
    out.push(Decoration.widget({ widget, block: true, side: 1 }).range(lines.lineAt(node.to).to));
  /** Offset of the caret from the block's start when its rendering is clicked: the first body line. */
  const bodyOffset = (node: SyntaxNode) => {
    const first = lines.lineAt(node.from);
    return first.to < node.to ? first.to + 1 - first.from : 2;
  };
  /** The code card: fences hidden (atomic), the footer with the language. */
  const card = (node: SyntaxNode): boolean => {
    const shape = fenceShape(state, node);
    if (!shape) return false;
    out.push(Decoration.replace({ widget: new CodeTopWidget(), block: true }).range(shape.open.from, shape.open.to));
    out.push(
      Decoration.replace({
        widget: new CodeFooterWidget(shape.lang, node.name === "FencedCode"),
        block: true,
      }).range(shape.close.from, shape.close.to),
    );
    // With the line breaks around them, so the caret steps from the text around straight into the code.
    atomic.push(
      [Math.max(0, shape.open.from - 1), shape.open.to + 1],
      [shape.close.from - 1, Math.min(lines.length, shape.close.to + 1)],
    );
    return true;
  };

  syntaxTree(state).iterate({
    enter(ref) {
      const node = ref.node;
      switch (ref.name) {
        case "Table": {
          if (node.parent?.name !== "Document" || inside(state, ref.from, ref.to)) return false;
          const from = lines.lineAt(ref.from).from;
          const to = lines.lineAt(ref.to).to;
          out.push(
            Decoration.replace({ widget: new TableWidget(state.sliceDoc(from, to)), block: true }).range(from, to),
          );
          return false;
        }
        case "BlockMath": {
          const marks = node.getChildren("BlockMathMark");
          const tex = state.sliceDoc(marks[0]?.to ?? ref.from, marks.length > 1 ? marks[1]!.from : ref.to).trim();
          if (!touches(state, ref.from, ref.to))
            replace(node, Decoration.replace({ widget: new MathWidget(tex, true, bodyOffset(node)), block: true }));
          else {
            card(node);
            after(node, new MathWidget(tex, true));
          }
          return false;
        }
        case "FencedCode": {
          const lang = fenceLang(state, node);
          const diagram = DIAGRAM_LANGS.has(lang);
          const math = MATH_LANGS.has(lang);
          const revealed = touches(state, ref.from, ref.to);
          if ((diagram || math) && !revealed) {
            const body = fenceBody(state, node);
            const widget = diagram
              ? new MermaidWidget(body, bodyOffset(node))
              : new MathWidget(body, true, bodyOffset(node));
            replace(node, Decoration.replace({ widget, block: true }));
            return false;
          }
          card(node);
          if (diagram) after(node, new MermaidWidget(fenceBody(state, node), -1));
          else if (math) after(node, new MathWidget(fenceBody(state, node), true));
          return false;
        }
        case "HTMLBlock": {
          if (node.parent?.name !== "Document" || touches(state, ref.from, ref.to)) return false;
          const html = state.sliceDoc(ref.from, ref.to);
          // Comments and lone closing tags stay as (dimmed) source.
          if (/^\s*<!--/.test(html) || !/<[a-z]/i.test(html)) return false;
          replace(node, Decoration.replace({ widget: new HtmlWidget(doc, html), block: true }));
          return false;
        }
      }
      return INLINE_CONTAINERS.has(ref.name) ? false : undefined;
    },
  });
  const b = new RangeSetBuilder<RangeValue>();
  for (const [from, to] of atomic.sort((x, y) => x[0] - y[0])) if (from < to) b.add(from, to, ATOMIC);
  return { deco: Decoration.set(out, true), atomic: b.finish() };
}

export function blockLayer(doc: string) {
  const field = StateField.define<Blocks>({
    create: (state) => build(state, doc),
    update(value, tr) {
      const live = tr.state.field(liveState, false);
      if (
        tr.docChanged ||
        live !== tr.startState.field(liveState, false) ||
        syntaxTree(tr.state) !== syntaxTree(tr.startState)
      )
        return build(tr.state, doc);
      return value;
    },
    provide: (f) => [
      EditorView.decorations.from(f, (v) => v.deco),
      EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
    ],
  });
  return field;
}
