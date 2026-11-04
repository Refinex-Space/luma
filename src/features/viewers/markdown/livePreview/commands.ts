/**
 * Markdown editing commands on the source: inline formats toggled on the selection, line
 * blocks (paragraph, headings, lists, tasks, quotes) converted in place, and blocks inserted
 * (tables, code, math, diagrams, callouts…). Shared by the slash menu, the context menu, the
 * selection toolbar and the keyboard shortcuts; each is one undo step.
 */
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type ChangeSpec, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { tx } from "@/platform/i18n";
import { tableAt } from "./table";
import { newTable } from "./tableModel";

// ---------------------------------------------------------------------------
// Inline formats

export type InlineFormat = "bold" | "italic" | "strikethrough" | "code" | "math" | "highlight";

const FORMATS: Record<InlineFormat, { node: string | null; mark: string; marks: string | null }> = {
  bold: { node: "StrongEmphasis", mark: "**", marks: "EmphasisMark" },
  italic: { node: "Emphasis", mark: "*", marks: "EmphasisMark" },
  strikethrough: { node: "Strikethrough", mark: "~~", marks: "StrikethroughMark" },
  code: { node: "InlineCode", mark: "`", marks: "CodeMark" },
  math: { node: "InlineMath", mark: "$", marks: "InlineMathMark" },
  highlight: { node: null, mark: "==", marks: null },
};

/** The innermost `name` node around `[from, to]`. */
function around(state: EditorState, from: number, to: number, name: string): SyntaxNode | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(from, from === to ? 0 : 1); n; n = n.parent)
    if (n.name === name && n.from <= from && n.to >= to) return n;
  return null;
}

const WORD = /[\p{L}\p{N}_]/u;

function wordAt(state: EditorState, pos: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(pos);
  let a = pos - line.from;
  let b = a;
  while (a > 0 && WORD.test(line.text[a - 1]!)) a--;
  while (b < line.text.length && WORD.test(line.text[b]!)) b++;
  return a < b ? { from: line.from + a, to: line.from + b } : null;
}

/** Toggles `format` on each selection range: unwraps a range already formatted, else wraps it. */
export function toggleInline(view: EditorView, format: InlineFormat): boolean {
  const { state } = view;
  const f = FORMATS[format];
  const tr = state.changeByRange((range) => {
    const node = f.node ? around(state, range.from, range.to, f.node) : null;
    if (node && f.marks) {
      const marks = node.getChildren(f.marks);
      const open = marks[0];
      const close = marks.at(-1);
      if (open && close && open !== close) {
        const changes = [
          { from: open.from, to: open.to },
          { from: close.from, to: close.to },
        ];
        const shift = open.to - open.from;
        return {
          changes,
          range: EditorSelection.range(
            Math.max(open.from, range.anchor - shift),
            Math.max(open.from, Math.min(close.from - shift, range.head - shift)),
          ),
        };
      }
    }
    const m = f.mark;
    // Already wrapped just outside the selection: unwrap.
    if (
      !range.empty &&
      state.sliceDoc(range.from - m.length, range.from) === m &&
      state.sliceDoc(range.to, range.to + m.length) === m
    )
      return {
        changes: [
          { from: range.from - m.length, to: range.from },
          { from: range.to, to: range.to + m.length },
        ],
        range: EditorSelection.range(range.from - m.length, range.to - m.length),
      };
    const target = range.empty ? wordAt(state, range.from) : range;
    if (!target) {
      return {
        changes: { from: range.from, insert: m + m },
        range: EditorSelection.cursor(range.from + m.length),
      };
    }
    return {
      changes: [
        { from: target.from, insert: m },
        { from: target.to, insert: m },
      ],
      range: range.empty
        ? EditorSelection.cursor(range.from + m.length)
        : EditorSelection.range(target.from + m.length, target.to + m.length),
    };
  });
  view.dispatch(state.update(tr, { userEvent: "input.format", scrollIntoView: true }));
  view.focus();
  return true;
}

/** Wraps the selection in a link (`[text](url)`), the caret in the URL, or opens one at the caret. */
export function insertLink(view: EditorView): boolean {
  const { state } = view;
  const tr = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    if (/^(https?:\/\/|www\.)\S+$/i.test(text)) {
      const insert = `[](${text})`;
      return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + 1) };
    }
    const insert = `[${text}]()`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + (text ? insert.length - 1 : 1)),
    };
  });
  view.dispatch(state.update(tr, { userEvent: "input.format", scrollIntoView: true }));
  view.focus();
  return true;
}

// ---------------------------------------------------------------------------
// Line blocks

export type BlockKind = "paragraph" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "bullet" | "ordered" | "task" | "quote";

interface LineShape {
  indent: string;
  quote: string;
  heading: number;
  list: "bullet" | "ordered" | null;
  task: string | null;
  /** Where the line's content starts (after all markers). */
  content: number;
}

const SHAPE = /^(\s*)((?:>\s?)*)(?:(#{1,6})\s+|([-*+])\s+|(\d{1,9})[.)]\s+)?(\[[ xX]\]\s+)?/;

export function lineShape(text: string): LineShape {
  const m = SHAPE.exec(text)!;
  const list = m[4] ? "bullet" : m[5] ? "ordered" : null;
  return {
    indent: m[1]!,
    quote: m[2]!,
    heading: m[3]?.length ?? 0,
    list,
    task: list && m[6] ? m[6] : null,
    content: m[0].length,
  };
}

const kindOf = (s: LineShape): BlockKind =>
  s.heading
    ? (`h${s.heading}` as BlockKind)
    : s.task
      ? "task"
      : s.list === "bullet"
        ? "bullet"
        : s.list === "ordered"
          ? "ordered"
          : "paragraph";

/** Turns the selected lines into `kind` (back into paragraphs when they all are `kind` already). */
export function setBlock(view: EditorView, kind: BlockKind): boolean {
  const { state } = view;
  const lines = new Map<number, { from: number; text: string }>();
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
      const l = state.doc.line(n);
      lines.set(l.from, { from: l.from, text: l.text });
    }
  }
  const all = [...lines.values()].sort((a, b) => a.from - b.from);
  // Blank lines stay blank unless the caret is on one.
  const targets = all.length > 1 ? all.filter((l) => l.text.trim()) : all;
  if (!targets.length) return false;
  const shapes = targets.map((l) => lineShape(l.text));
  const changes: ChangeSpec[] = [];
  if (kind === "quote") {
    const quoted = shapes.every((s) => s.quote);
    targets.forEach((l, i) => {
      const s = shapes[i]!;
      if (quoted) {
        const m = /^>\s?/.exec(l.text.slice(s.indent.length))!;
        changes.push({ from: l.from + s.indent.length, to: l.from + s.indent.length + m[0].length });
      } else changes.push({ from: l.from + s.indent.length, insert: "> " });
    });
  } else {
    const same = shapes.every((s) => kindOf(s) === kind);
    const to: BlockKind = same ? "paragraph" : kind;
    targets.forEach((l, i) => {
      const s = shapes[i]!;
      const heading = /^h(\d)$/.exec(to);
      let prefix: string;
      if (heading) prefix = `${s.quote}${"#".repeat(Number(heading[1]))} `;
      else if (to === "bullet") prefix = `${s.indent}${s.quote}- `;
      else if (to === "ordered") prefix = `${s.indent}${s.quote}${i + 1}. `;
      else if (to === "task") prefix = `${s.indent}${s.quote}- ${s.task ?? "[ ] "}`;
      else prefix = `${s.heading ? "" : s.indent}${s.quote}`;
      changes.push({ from: l.from, to: l.from + s.content, insert: prefix });
    });
  }
  const set = state.changes(changes);
  // A caret at a line's start follows the markers inserted there.
  view.dispatch({
    changes: set,
    selection: state.selection.map(set, 1),
    userEvent: "input.format",
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

/** The block kind of the caret's line (for checked menu items). */
export function blockAt(state: EditorState): BlockKind {
  const line = state.doc.lineAt(state.selection.main.head);
  const s = lineShape(line.text);
  return kindOf(s);
}

// ---------------------------------------------------------------------------
// Inserted blocks

export type MermaidKind = "flowchart" | "sequence" | "class" | "state" | "er" | "gantt" | "pie" | "mindmap";

export const MERMAID_TEMPLATES: Record<MermaidKind, string> = {
  flowchart: "flowchart LR\n    A[Start] --> B{Ready?}\n    B -->|Yes| C[Ship]\n    B -->|No| D[Fix] --> B",
  sequence:
    "sequenceDiagram\n    participant C as Client\n    participant S as Server\n    C->>S: Request\n    S-->>C: Response",
  class:
    'classDiagram\n    class Order {\n        +String id\n        +submit()\n    }\n    class Item\n    Order "1" --> "*" Item',
  state: "stateDiagram-v2\n    [*] --> Draft\n    Draft --> Review\n    Review --> Published\n    Published --> [*]",
  er: "erDiagram\n    CUSTOMER ||--o{ ORDER : places\n    ORDER ||--|{ LINE_ITEM : contains",
  gantt:
    "gantt\n    dateFormat YYYY-MM-DD\n    section Build\n    Design   :a1, 2026-01-01, 5d\n    Develop  :after a1, 10d",
  pie: 'pie title Share\n    "A" : 40\n    "B" : 35\n    "C" : 25',
  mindmap: "mindmap\n  root((Topic))\n    Idea\n      Detail\n    Question",
};

export type CalloutKind = "note" | "tip" | "important" | "warning" | "caution";

export type InsertKind =
  | "table"
  | "code"
  | "math"
  | "hr"
  | "image"
  | "link"
  | "footnote"
  | "frontMatter"
  | `mermaid:${MermaidKind}`
  | `callout:${CalloutKind}`;

/** Where a block goes: the caret's line when it is empty, else a new paragraph after it. */
function blockSlot(state: EditorState, at: number, replace: { from: number; to: number } | null) {
  const line = state.doc.lineAt(at);
  const rest = replace
    ? line.text.slice(0, replace.from - line.from) + line.text.slice(replace.to - line.from)
    : line.text;
  const empty = !rest.trim();
  const prev = line.number > 1 ? state.doc.line(line.number - 1).text : "";
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1).text : null;
  if (empty) {
    return {
      from: line.from,
      to: line.to,
      before: line.number > 1 && prev.trim() ? "\n" : "",
      after: next === null ? "\n" : next.trim() ? "\n" : "",
      keep: "",
    };
  }
  return {
    from: line.to,
    to: line.to,
    before: "\n\n",
    after: next === null ? "\n" : next.trim() ? "\n" : "",
    keep: "",
  };
}

/**
 * Inserts `kind` at the caret. `replace` is text to drop first (the slash command's `/query`).
 */
export function insertBlock(view: EditorView, kind: InsertKind, replace: { from: number; to: number } | null = null) {
  const { state } = view;
  const head = state.selection.main.head;
  const pre: ChangeSpec[] = replace ? [{ from: replace.from, to: replace.to }] : [];
  const inlineAt = replace ? replace.from : head;
  const shiftAfter = (pos: number) => (replace && pos > replace.from ? pos - (replace.to - replace.from) : pos);

  // Inline insertions.
  if (kind === "link" || kind === "image") {
    const insert = kind === "link" ? "[]()" : "![]()";
    // The caret goes inside the brackets (the link text, the image's alt text).
    view.dispatch({
      changes: [...pre, { from: replace ? replace.to : head, insert }],
      selection: { anchor: inlineAt + (kind === "link" ? 1 : 2) },
      userEvent: "input.insert",
    });
    view.focus();
    return;
  }
  if (kind === "footnote") {
    const used = [...state.doc.toString().matchAll(/\[\^(\d+)\]/g)].map((m) => Number(m[1]));
    const n = (used.length ? Math.max(...used) : 0) + 1;
    const ref = `[^${n}]`;
    const end = state.doc.length;
    const tail = state.doc.sliceString(Math.max(0, end - 2));
    const sep = tail.endsWith("\n\n") ? "" : tail.endsWith("\n") ? "\n" : "\n\n";
    const def = `${sep}[^${n}]: `;
    view.dispatch({
      changes: [...pre, { from: replace ? replace.to : head, insert: ref }, { from: end, insert: def }],
      userEvent: "input.insert",
    });
    view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
    view.focus();
    return;
  }
  if (kind === "frontMatter") {
    if (/^(---|\+\+\+)\s*$/m.test(state.doc.line(1).text)) {
      view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true });
      view.focus();
      return;
    }
    const insert = `---\ntitle: \n---\n\n`;
    view.dispatch({ changes: [...pre, { from: 0, insert }], userEvent: "input.insert" });
    view.dispatch({ selection: { anchor: "---\ntitle: ".length }, scrollIntoView: true });
    view.focus();
    return;
  }

  // Blocks: text, and the caret's offset in it.
  let text: string;
  let caret: number;
  if (kind === "table") {
    text = newTable(3, 2, (i) => tx`Column ${i + 1}`);
    caret = 0;
  } else if (kind === "code") {
    text = "```\n\n```";
    caret = 4;
  } else if (kind === "math") {
    text = "$$\n\n$$";
    caret = 3;
  } else if (kind === "hr") {
    text = "---\n";
    caret = text.length;
  } else if (kind.startsWith("mermaid:")) {
    const body = MERMAID_TEMPLATES[kind.slice(8) as MermaidKind];
    text = `\`\`\`mermaid\n${body}\n\`\`\``;
    caret = "```mermaid\n".length + body.indexOf("\n");
  } else {
    const callout = kind.slice(8).toUpperCase();
    text = `> [!${callout}]\n> `;
    caret = text.length;
  }
  const slot = blockSlot(state, replace ? replace.from : head, replace);
  // With the slash text gone, an empty line is replaced whole.
  const changes: ChangeSpec[] =
    slot.from === slot.to
      ? [...pre, { from: slot.from, insert: slot.before + text + slot.after }]
      : [{ from: slot.from, to: slot.to, insert: slot.before + text + slot.after }];
  view.dispatch({ changes, userEvent: "input.insert" });
  const start = (slot.from === slot.to ? shiftAfter(slot.from) : slot.from) + slot.before.length;
  view.dispatch({ selection: { anchor: start + caret }, scrollIntoView: true });
  view.focus();
  if (kind === "table") {
    // The rendered table takes the caret: its first header cell, selected.
    requestAnimationFrame(() => tableAt(view, start)?.focusCell(0, 0, "all"));
  }
}
