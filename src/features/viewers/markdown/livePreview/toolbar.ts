/**
 * The selection toolbar of Markdown editors (IDEA's floating Markdown toolbar): over a text
 * selection, once the mouse is released, buttons for the inline formats, a link and the line
 * blocks. Not shown inside code, math or front matter.
 */
import { syntaxTree } from "@codemirror/language";
import { StateField, type EditorState } from "@codemirror/state";
import { EditorView, showTooltip, type Tooltip } from "@codemirror/view";
import { iconMarkup } from "@/ui/icons";
import { getAction } from "@/platform/actions";
import { bindingsFor, formatBinding } from "@/platform/keymap";
import { tx } from "@/platform/i18n";
import { blockAt, insertLink, setBlock, toggleInline, type BlockKind, type InlineFormat } from "./commands";
import { liveState } from "./state";

const NO_TOOLBAR = new Set(["FencedCode", "CodeBlock", "FrontMatter", "BlockMath", "Table", "HTMLBlock"]);

type Button =
  | { kind: "inline"; format: InlineFormat; icon: string; title: string; action: string }
  | { kind: "link"; icon: string; title: string; action: string }
  | { kind: "block"; block: BlockKind; icon: string; title: string; action: string }
  | { kind: "sep" };

const BUTTONS: Button[] = [
  { kind: "block", block: "h1", icon: "md-heading-1", title: "Heading 1", action: "markdown.heading1" },
  { kind: "block", block: "h2", icon: "md-heading-2", title: "Heading 2", action: "markdown.heading2" },
  { kind: "block", block: "h3", icon: "md-heading-3", title: "Heading 3", action: "markdown.heading3" },
  { kind: "sep" },
  { kind: "inline", format: "bold", icon: "md-bold", title: "Bold", action: "markdown.bold" },
  { kind: "inline", format: "italic", icon: "md-italic", title: "Italic", action: "markdown.italic" },
  {
    kind: "inline",
    format: "strikethrough",
    icon: "md-strikethrough",
    title: "Strikethrough",
    action: "markdown.strikethrough",
  },
  { kind: "inline", format: "code", icon: "md-inline-code", title: "Inline Code", action: "markdown.inlineCode" },
  { kind: "inline", format: "math", icon: "md-math", title: "Inline Math", action: "markdown.inlineMath" },
  { kind: "link", icon: "md-link", title: "Link", action: "markdown.link" },
  { kind: "sep" },
  { kind: "block", block: "bullet", icon: "md-bullet-list", title: "Bulleted List", action: "markdown.bulletList" },
  {
    kind: "block",
    block: "ordered",
    icon: "md-numbered-list",
    title: "Numbered List",
    action: "markdown.numberedList",
  },
  { kind: "block", block: "task", icon: "md-task-list", title: "Task List", action: "markdown.taskList" },
  { kind: "block", block: "quote", icon: "md-quote", title: "Quote", action: "markdown.quote" },
];

function wanted(state: EditorState): boolean {
  const sel = state.selection.main;
  if (sel.empty || state.selection.ranges.length > 1 || state.readOnly) return false;
  if (state.field(liveState, false)?.selecting) return false;
  if (state.doc.lineAt(sel.from).number !== state.doc.lineAt(sel.to).number && sel.to - sel.from > 4000) return false;
  for (
    let n: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(sel.from, 1);
    n;
    n = n.parent
  )
    if (NO_TOOLBAR.has(n.name)) return false;
  return true;
}

function title(b: Exclude<Button, { kind: "sep" }>): string {
  const keys = getAction(b.action) ? bindingsFor(b.action) : [];
  const t = tx(b.title);
  return keys[0] ? `${t}  ${formatBinding(keys[0])}` : t;
}

function create(view: EditorView): { dom: HTMLElement } {
  const dom = document.createElement("div");
  dom.className = "cm-md-toolbar";
  dom.setAttribute("role", "toolbar");
  dom.setAttribute("aria-label", tx("Markdown Formatting"));
  const current = blockAt(view.state);
  for (const b of BUTTONS) {
    if (b.kind === "sep") {
      dom.append(Object.assign(document.createElement("span"), { className: "cm-md-toolbar-sep" }));
      continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-md-toolbar-button";
    btn.innerHTML = iconMarkup(b.icon, 16) ?? "";
    btn.title = title(b);
    btn.setAttribute("aria-label", tx(b.title));
    if (b.kind === "block" && current === b.block) btn.setAttribute("aria-pressed", "true");
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => {
      if (b.kind === "inline") toggleInline(view, b.format);
      else if (b.kind === "link") insertLink(view);
      else setBlock(view, b.block);
    });
    dom.append(btn);
  }
  return { dom };
}

const toolbarField = StateField.define<readonly Tooltip[]>({
  create: (state) => tooltipFor(state),
  update(tips, tr) {
    if (!tr.docChanged && !tr.selection && tr.state.field(liveState, false) === tr.startState.field(liveState, false))
      return tips;
    return tooltipFor(tr.state);
  },
  provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
});

function tooltipFor(state: EditorState): readonly Tooltip[] {
  if (!wanted(state)) return [];
  const sel = state.selection.main;
  return [{ pos: sel.from, end: sel.to, above: true, arrow: false, create }];
}

const toolbarTheme = EditorView.baseTheme({
  ".cm-tooltip.cm-tooltip-above:has(> .cm-md-toolbar)": { border: "0", background: "transparent" },
  ".cm-md-toolbar": {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    padding: "3px",
    marginBottom: "6px",
    borderRadius: "var(--radius-floating-toolbar, 8px)",
    border: "1px solid var(--border)",
    background: "var(--bg-floating-toolbar, var(--bg-popup))",
    boxShadow: "0 4px 14px rgb(0 0 0 / 0.12), 0 1px 3px rgb(0 0 0 / 0.08)",
    fontFamily: "var(--font-ui)",
    animation: "cm-md-toolbar-in 140ms var(--ease, ease-out) 80ms both",
  },
  "@keyframes cm-md-toolbar-in": {
    from: { opacity: "0", transform: "translateY(3px)" },
    to: { opacity: "1", transform: "none" },
  },
  ".cm-md-toolbar-button": {
    display: "inline-grid",
    placeItems: "center",
    width: "26px",
    height: "26px",
    padding: "0",
    border: "0",
    borderRadius: "var(--radius-toolbar-button, 5px)",
    background: "transparent",
    color: "var(--fg-secondary)",
    cursor: "pointer",
  },
  ".cm-md-toolbar-button:hover": { background: "var(--bg-toolbar-hover, var(--bg-hover))", color: "var(--fg-strong)" },
  '.cm-md-toolbar-button[aria-pressed="true"]': {
    background: "var(--bg-toolbar-selected, var(--bg-selected))",
    color: "var(--fg-strong)",
  },
  ".cm-md-toolbar-sep": { width: "1px", height: "16px", margin: "0 3px", background: "var(--border)" },
  "@media (prefers-reduced-motion: reduce)": { ".cm-md-toolbar": { animation: "none" } },
});

export const selectionToolbar = [toolbarField, toolbarTheme];
