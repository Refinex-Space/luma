/**
 * The live preview's inline layer (visible part of the document only): Markdown marks hidden
 * unless the selection touches their construct, headings, quotes, callouts, lists, tasks, code
 * blocks and front matter styled by line, links, images, inline math and rules rendered.
 */
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { fenceShape } from "./codeBlocks";
import { isLive, liveState, touches, touchesLines } from "./state";
import {
  BulletWidget,
  CALLOUT_TITLES,
  CalloutTitleWidget,
  CheckboxWidget,
  CodeHeaderWidget,
  ImageWidget,
  MathWidget,
  RuleWidget,
} from "./widgets";

const HIDE = Decoration.replace({});
/** Fence languages drawn by the block layer. */
export const DIAGRAM_LANGS = new Set(["mermaid"]);
export const MATH_LANGS = new Set(["math", "latex", "tex", "katex"]);
const CALLOUT = /^(\s*>\s?)\[!(\w+)\][+-]?(\s*)(.*)$/;

export const fenceLang = (state: EditorState, node: SyntaxNode) => {
  const info = node.getChild("CodeInfo");
  return info ? (state.sliceDoc(info.from, info.to).trim().split(/[\s{]/)[0] ?? "").toLowerCase() : "";
};

/** The text of an image or link's destination and title. */
export function linkParts(state: EditorState, node: SyntaxNode) {
  const url = node.getChild("URL");
  const title = node.getChild("LinkTitle");
  const marks = node.getChildren("LinkMark");
  const textFrom = marks[0]?.to ?? node.from;
  const textTo = marks[1]?.from ?? textFrom;
  return {
    url: url ? state.sliceDoc(url.from, url.to) : "",
    title: title ? state.sliceDoc(title.from + 1, title.to - 1) : "",
    textFrom,
    textTo,
    hasTarget: !!url || !!node.getChild("LinkLabel"),
  };
}

class Builder {
  readonly out: Range<Decoration>[] = [];
  private readonly lines = new Map<number, { cls: Set<string>; attrs: Record<string, string> }>();

  constructor(readonly state: EditorState) {}

  hide(from: number, to: number) {
    if (from < to && this.state.doc.lineAt(from).to >= to) this.out.push(HIDE.range(from, to));
  }
  mark(from: number, to: number, cls: string, attributes?: Record<string, string>) {
    if (from < to) this.out.push(Decoration.mark({ class: cls, attributes }).range(from, to));
  }
  replace(from: number, to: number, widget: Decoration) {
    if (from <= to && this.state.doc.lineAt(from).to >= to) this.out.push(widget.range(from, to));
  }
  line(pos: number, cls: string, attrs?: Record<string, string>) {
    const from = this.state.doc.lineAt(pos).from;
    let l = this.lines.get(from);
    if (!l) this.lines.set(from, (l = { cls: new Set(), attrs: {} }));
    for (const c of cls.split(" ")) l.cls.add(c);
    if (attrs) Object.assign(l.attrs, attrs);
  }
  /** Each line of `[from, to]` within `[vFrom, vTo]`. */
  eachLine(
    from: number,
    to: number,
    vFrom: number,
    vTo: number,
    f: (lineFrom: number, first: boolean, last: boolean) => void,
  ) {
    const doc = this.state.doc;
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    const a = Math.max(first, doc.lineAt(Math.max(from, vFrom)).number);
    const b = Math.min(last, doc.lineAt(Math.min(to, vTo)).number);
    for (let n = a; n <= b; n++) f(doc.line(n).from, n === first, n === last);
  }
  finish(): DecorationSet {
    for (const [from, l] of this.lines)
      this.out.push(Decoration.line({ class: [...l.cls].join(" "), attributes: l.attrs }).range(from));
    return Decoration.set(this.out, true);
  }
}

function listDepth(node: SyntaxNode): number {
  let depth = 0;
  for (let p = node.parent; p; p = p.parent) if (p.name === "BulletList" || p.name === "OrderedList") depth++;
  return Math.max(0, depth - 1);
}

function heading(b: Builder, node: SyntaxNode, level: number) {
  const { state } = b;
  b.line(node.from, `cm-md-h cm-md-h${level}`);
  if (touchesLines(state, node.from, node.to)) return;
  const line = state.doc.lineAt(node.from);
  for (const mark of node.getChildren("HeaderMark")) {
    if (mark.from === line.from + (line.text.length - line.text.trimStart().length)) {
      // `## ` at the start, with the spaces after it.
      let end = mark.to;
      while (end < line.to && state.sliceDoc(end, end + 1) === " ") end++;
      b.hide(mark.from, end);
    } else {
      // A closing `##` and the spaces before it.
      let start = mark.from;
      while (start > line.from && state.sliceDoc(start - 1, start) === " ") start--;
      b.hide(start, mark.to);
    }
  }
}

function blockquote(b: Builder, node: SyntaxNode, vFrom: number, vTo: number) {
  const { state } = b;
  const first = state.doc.lineAt(node.from);
  const callout = node.parent?.name === "Document" ? CALLOUT.exec(first.text) : null;
  const kind = callout ? callout[2]!.toLowerCase() : "";
  b.eachLine(node.from, node.to, vFrom, vTo, (from, isFirst, isLast) => {
    const depth = Number(depthAt.get(from) ?? 0) + 1;
    depthAt.set(from, depth);
    b.line(from, "cm-md-quote", { "data-depth": String(depth) });
    if (callout) {
      b.line(from, `cm-md-callout cm-md-callout-${CALLOUT_TITLES[kind] ? kind : "note"}`);
      if (isFirst) b.line(from, "cm-md-callout-first");
      if (isLast) b.line(from, "cm-md-callout-last");
    }
  });
  if (callout && first.from >= vFrom && !touchesLines(state, first.from, first.to)) {
    const at = first.from + callout[1]!.length;
    const named = callout[4]!.trim().length > 0;
    b.replace(
      at,
      at + kind.length + 3 + callout[3]!.length,
      Decoration.replace({ widget: new CalloutTitleWidget(CALLOUT_TITLES[kind] ? kind : "note", named) }),
    );
  }
}
/** Quote depth per line start while one pass runs. */
const depthAt = new Map<number, number>();

function fencedCode(b: Builder, node: SyntaxNode, vFrom: number, vTo: number) {
  const { state } = b;
  const lang = node.name === "FencedCode" ? fenceLang(state, node) : "";
  const revealed = touches(state, node.from, node.to);
  // Diagrams and math are the block layer's while not edited.
  if (!revealed && (node.name === "BlockMath" || DIAGRAM_LANGS.has(lang) || MATH_LANGS.has(lang))) return;
  const shape = fenceShape(state, node);
  if (shape) {
    // A card: its fences are the block layer's widgets; the code lines between are styled here.
    b.eachLine(shape.open.to + 1, shape.close.from - 1, vFrom, vTo, (from) => b.line(from, "cm-md-code"));
    return;
  }
  // An unclosed or empty fence stays visible as source, styled as code.
  b.eachLine(node.from, node.to, vFrom, vTo, (from, first, last) =>
    b.line(from, `cm-md-code${first ? " cm-md-code-first" : ""}${last ? " cm-md-code-last" : ""}`),
  );
}

function footnote(b: Builder, node: SyntaxNode, p: ReturnType<typeof linkParts>) {
  const { state } = b;
  const line = state.doc.lineAt(node.from);
  const definition = node.from === line.from && state.sliceDoc(node.to, node.to + 1) === ":";
  const end = definition ? node.to + 1 : node.to;
  if (definition) b.line(node.from, "cm-md-footnote-def");
  if (touches(state, node.from, end)) {
    b.mark(node.from, end, "cm-md-footnote-source");
    return;
  }
  b.hide(node.from, p.textFrom + 1);
  b.hide(p.textTo, end);
  b.mark(p.textFrom + 1, p.textTo, definition ? "cm-md-footnote-label" : "cm-md-footnote-ref");
}

function link(b: Builder, node: SyntaxNode) {
  const { state } = b;
  const p = linkParts(state, node);
  if (!p.hasTarget) {
    if (state.sliceDoc(p.textFrom, p.textFrom + 1) === "^" && p.textTo > p.textFrom + 1) footnote(b, node, p);
    return;
  }
  const attrs = { "data-href": p.url, title: p.url };
  if (touches(state, node.from, node.to)) {
    b.mark(p.textFrom, p.textTo, "cm-md-link", attrs);
    return;
  }
  b.hide(node.from, p.textFrom);
  b.hide(p.textTo, node.to);
  b.mark(p.textFrom, p.textTo, "cm-md-link", attrs);
}

function image(b: Builder, node: SyntaxNode, doc: string) {
  const { state } = b;
  const p = linkParts(state, node);
  const alt = state.sliceDoc(p.textFrom, p.textTo);
  const line = state.doc.lineAt(node.from);
  const block = line.text.trim() === state.sliceDoc(node.from, node.to) && node.parent?.name === "Paragraph";
  const widget = new ImageWidget(doc, p.url, alt, p.title, block);
  if (touches(state, node.from, node.to)) b.out.push(Decoration.widget({ widget, side: 1 }).range(node.to));
  else b.replace(node.from, node.to, Decoration.replace({ widget }));
}

function listMark(b: Builder, node: SyntaxNode) {
  const { state } = b;
  const item = node.parent;
  if (item?.getChild("Task")) return;
  if (item?.parent?.name === "BulletList") {
    if (!touches(state, node.from, node.to))
      b.replace(node.from, node.to, Decoration.replace({ widget: new BulletWidget(listDepth(item)) }));
  } else b.mark(node.from, node.to, "cm-md-list-number");
}

function task(b: Builder, node: SyntaxNode) {
  const { state } = b;
  const marker = node.getChild("TaskMarker");
  const mark = node.parent?.getChild("ListMark");
  if (!marker) return;
  const checked = /x/i.test(state.sliceDoc(marker.from, marker.to));
  if (checked) b.mark(marker.to, node.to, "cm-md-task-done");
  if (touches(state, marker.from, marker.to)) return;
  if (mark && node.parent?.parent?.name === "BulletList") b.hide(mark.from, marker.from);
  b.replace(marker.from, marker.to, Decoration.replace({ widget: new CheckboxWidget(checked) }));
}

/** Inline HTML styled in place: `<kbd>`, `<sup>`, `<mark>`… */
const INLINE_TAGS = new Set(["kbd", "sup", "sub", "mark", "u", "ins", "s", "del", "b", "strong", "i", "em", "small"]);

function htmlTag(b: Builder, node: SyntaxNode) {
  const { state } = b;
  const text = state.sliceDoc(node.from, node.to);
  if (/^<br\s*\/?>$/i.test(text)) {
    if (!touches(state, node.from, node.to)) b.hide(node.from, node.to);
    return;
  }
  const open = /^<([a-z]+)>$/i.exec(text);
  const name = open?.[1]!.toLowerCase();
  if (!name || !INLINE_TAGS.has(name)) return;
  const close = new RegExp(`^</${name}>$`, "i");
  for (let n = node.nextSibling; n; n = n.nextSibling) {
    if (n.name !== "HTMLTag" || !close.test(state.sliceDoc(n.from, n.to))) continue;
    if (state.doc.lineAt(n.to).number !== state.doc.lineAt(node.from).number) return;
    const revealed = touches(state, node.from, n.to);
    if (!revealed) {
      b.hide(node.from, node.to);
      b.hide(n.from, n.to);
    }
    b.mark(node.to, n.from, `cm-md-html-${name}`);
    return;
  }
}

function frontMatter(b: Builder, node: SyntaxNode, vFrom: number, vTo: number) {
  const { state } = b;
  b.eachLine(node.from, node.to, vFrom, vTo, (from, first, last) =>
    b.line(from, `cm-md-frontmatter${first ? " cm-md-code-first" : ""}${last ? " cm-md-code-last" : ""}`),
  );
  if (touches(state, node.from, node.to)) return;
  const marks = node.getChildren("FrontMatterMark");
  const open = state.doc.lineAt(node.from);
  b.replace(open.from, open.to, Decoration.replace({ widget: new CodeHeaderWidget("properties", "", false) }));
  if (marks.length > 1) {
    const close = state.doc.lineAt(marks[1]!.from);
    b.hide(close.from, close.to);
  }
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  if (!isLive(state)) return Decoration.none;
  const b = new Builder(state);
  const { from: vFrom, to: vTo } = view.viewport;
  depthAt.clear();
  syntaxTree(state).iterate({
    from: vFrom,
    to: vTo,
    enter(ref) {
      const node = ref.node;
      switch (ref.name) {
        case "ATXHeading1":
        case "ATXHeading2":
        case "ATXHeading3":
        case "ATXHeading4":
        case "ATXHeading5":
        case "ATXHeading6":
          heading(b, node, Number(ref.name.slice(-1)));
          break;
        case "SetextHeading1":
        case "SetextHeading2": {
          const level = ref.name.slice(-1);
          const mark = node.getChild("HeaderMark");
          b.eachLine(ref.from, mark ? mark.from - 1 : ref.to, vFrom, vTo, (from) =>
            b.line(from, `cm-md-h cm-md-h${level}`),
          );
          if (mark) b.line(mark.from, "cm-md-setext-mark");
          break;
        }
        case "Emphasis":
        case "StrongEmphasis":
        case "Strikethrough":
          if (!touches(state, ref.from, ref.to))
            for (const m of node.getChildren(ref.name === "Strikethrough" ? "StrikethroughMark" : "EmphasisMark"))
              b.hide(m.from, m.to);
          break;
        case "InlineCode": {
          const marks = node.getChildren("CodeMark");
          if (touches(state, ref.from, ref.to) || marks.length < 2) b.mark(ref.from, ref.to, "cm-md-inline-code");
          else {
            b.hide(marks[0]!.from, marks[0]!.to);
            b.hide(marks[1]!.from, marks[1]!.to);
            b.mark(marks[0]!.to, marks[1]!.from, "cm-md-inline-code");
          }
          return false;
        }
        case "Link":
          link(b, node);
          break;
        case "Image":
          image(b, node, docOf(view));
          return false;
        case "Autolink": {
          const url = node.getChild("URL");
          if (!url) break;
          if (!touches(state, ref.from, ref.to)) {
            b.hide(ref.from, url.from);
            b.hide(url.to, ref.to);
          }
          const href = state.sliceDoc(url.from, url.to);
          b.mark(url.from, url.to, "cm-md-link", { "data-href": href, title: href });
          return false;
        }
        case "URL": {
          const parent = node.parent?.name;
          if (parent === "Link" || parent === "Image" || parent === "LinkReference") break;
          const href = state.sliceDoc(ref.from, ref.to);
          b.mark(ref.from, ref.to, "cm-md-link", {
            "data-href": /^www\./i.test(href) ? `https://${href}` : href,
            title: href,
          });
          break;
        }
        case "Escape":
          if (!touches(state, ref.from, ref.to)) b.hide(ref.from, ref.from + 1);
          break;
        case "Blockquote":
          blockquote(b, node, vFrom, vTo);
          break;
        case "QuoteMark": {
          if (touchesLines(state, ref.from, ref.to)) break;
          const next = state.sliceDoc(ref.to, ref.to + 1) === " " ? ref.to + 1 : ref.to;
          b.hide(ref.from, next);
          break;
        }
        case "ListMark":
          listMark(b, node);
          break;
        case "Task":
          task(b, node);
          break;
        case "HorizontalRule":
          if (!touchesLines(state, ref.from, ref.to))
            b.replace(ref.from, ref.to, Decoration.replace({ widget: new RuleWidget() }));
          b.line(ref.from, "cm-md-hr-line");
          return false;
        case "FencedCode":
          fencedCode(b, node, vFrom, vTo);
          return false;
        case "CodeBlock":
          b.eachLine(ref.from, ref.to, vFrom, vTo, (from, first, last) =>
            b.line(
              from,
              `cm-md-code cm-md-code-indented${first ? " cm-md-code-first" : ""}${last ? " cm-md-code-last" : ""}`,
            ),
          );
          return false;
        case "InlineMath": {
          const tex = state.sliceDoc(ref.from + 1, ref.to - 1);
          if (touches(state, ref.from, ref.to)) b.mark(ref.from, ref.to, "cm-md-math-source");
          else b.replace(ref.from, ref.to, Decoration.replace({ widget: new MathWidget(tex, false) }));
          return false;
        }
        case "BlockMath":
          fencedCode(b, node, vFrom, vTo);
          return false;
        case "FrontMatter":
          frontMatter(b, node, vFrom, vTo);
          return false;
        case "HTMLTag":
          htmlTag(b, node);
          break;
        case "Table":
          b.eachLine(ref.from, ref.to, vFrom, vTo, (from) => b.line(from, "cm-md-table-source"));
          return false;
        case "HTMLBlock":
        case "CommentBlock":
        case "LinkReference":
          b.eachLine(ref.from, ref.to, vFrom, vTo, (from) => b.line(from, "cm-md-meta-line"));
          return false;
      }
      return undefined;
    },
  });
  // Empty lines away from the caret: paragraph spacing rather than a full line.
  for (let n = state.doc.lineAt(vFrom).number, last = state.doc.lineAt(vTo).number; n <= last; n++) {
    const line = state.doc.line(n);
    if (!line.length && !touches(state, line.from, line.to)) b.line(line.from, "cm-md-blank");
  }
  return b.finish();
}

/** The document path each editor's plugin was made for. */
const docs = new WeakMap<EditorView, string>();
const docOf = (view: EditorView) => docs.get(view) ?? "";

export function inlineLayer(doc: string) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        docs.set(view, doc);
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        const live = u.state.field(liveState, false);
        const was = u.startState.field(liveState, false);
        if (u.docChanged || u.viewportChanged || live !== was || syntaxTree(u.state) !== syntaxTree(u.startState))
          this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
