/**
 * Markdown editing as IDE actions (Find Action, keymaps, menus): inline formats, line blocks
 * and inserts, plus the editor menu's Format / Paragraph / Insert submenus and, at the caret,
 * the image or diagram viewer.
 */
import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { activeEditor } from "@/editor/api";
import { registerActions, type Action } from "@/platform/actions";
import type { MenuItem } from "@/ui/Menu";
import { registerMenuGroup } from "@/workbench/contributions";
import { isMarkdownPath } from "../../fileKinds";
import { openMediaViewer } from "../media/mediaViewer";
import { cachedMermaid, renderMermaid } from "../mermaid";
import { imageSource } from "./assets";
import {
  blockAt,
  insertBlock,
  insertLink,
  setBlock,
  toggleInline,
  type BlockKind,
  type CalloutKind,
  type InlineFormat,
  type InsertKind,
  type MermaidKind,
} from "./commands";
import { linkParts } from "./inline";

/** The editor, or its context menu open over it, on a Markdown file. */
export const MARKDOWN_WHEN = "(editorTextFocus || textEditorActive && popupOpen) && editorLangId == markdown";

function markdownView(): EditorView | null {
  const e = activeEditor();
  return e && isMarkdownPath(e.ctx.path) && !e.view.state.readOnly ? e.view : null;
}

const action = (
  id: string,
  title: string,
  icon: string | undefined,
  run: (view: EditorView, arg: unknown) => void,
  extra: Partial<Action> = {},
): Action => ({
  id,
  title,
  icon,
  category: "Markdown",
  when: MARKDOWN_WHEN,
  keywords: ["markdown"],
  run: ({ arg }) => {
    const view = markdownView();
    if (view) run(view, arg);
  },
  ...extra,
});

const INLINE: ReadonlyArray<[InlineFormat, string, string, string[]]> = [
  ["bold", "Bold", "md-bold", ["strong", "**"]],
  ["italic", "Italic", "md-italic", ["emphasis", "*"]],
  ["strikethrough", "Strikethrough", "md-strikethrough", ["del", "~~"]],
  ["code", "Inline Code", "md-inline-code", ["code", "`"]],
  ["math", "Inline Math", "md-math", ["latex", "katex", "$"]],
];

const BLOCKS: ReadonlyArray<[BlockKind, string, string, string]> = [
  ["paragraph", "Text", "md-text", "markdown.paragraph"],
  ["h1", "Heading 1", "md-heading-1", "markdown.heading1"],
  ["h2", "Heading 2", "md-heading-2", "markdown.heading2"],
  ["h3", "Heading 3", "md-heading-3", "markdown.heading3"],
  ["h4", "Heading 4", "md-heading-4", "markdown.heading4"],
  ["h5", "Heading 5", "md-heading-5", "markdown.heading5"],
  ["h6", "Heading 6", "md-heading-6", "markdown.heading6"],
  ["bullet", "Bulleted List", "md-bullet-list", "markdown.bulletList"],
  ["ordered", "Numbered List", "md-numbered-list", "markdown.numberedList"],
  ["task", "Task List", "md-task-list", "markdown.taskList"],
  ["quote", "Quote", "md-quote", "markdown.quote"],
];

const INSERTS: ReadonlyArray<[InsertKind, string, string, string, string]> = [
  ["table", "Table", "md-table", "markdown.insertTable", "Insert Table"],
  ["code", "Code Block", "md-code-block", "markdown.insertCodeBlock", "Insert Code Block"],
  ["math", "Math Block", "md-math", "markdown.insertMathBlock", "Insert Math Block"],
  ["hr", "Divider", "md-divider", "markdown.insertDivider", "Insert Divider"],
  ["image", "Image", "md-image", "markdown.insertImage", "Insert Image"],
  ["footnote", "Footnote", "md-footnote", "markdown.insertFootnote", "Insert Footnote"],
  ["frontMatter", "Front Matter", "md-front-matter", "markdown.insertFrontMatter", "Insert Front Matter"],
];

const CALLOUTS: ReadonlyArray<[CalloutKind, string]> = [
  ["note", "Note"],
  ["tip", "Tip"],
  ["important", "Important"],
  ["warning", "Warning"],
  ["caution", "Caution"],
];

const DIAGRAMS: ReadonlyArray<[MermaidKind, string]> = [
  ["flowchart", "Flowchart"],
  ["sequence", "Sequence Diagram"],
  ["class", "Class Diagram"],
  ["state", "State Diagram"],
  ["er", "ER Diagram"],
  ["gantt", "Gantt Chart"],
  ["pie", "Pie Chart"],
  ["mindmap", "Mind Map"],
];

/** What is under the caret that has its own viewer: an image or a Mermaid diagram. */
function viewableAt(view: EditorView, doc: string): { open: () => void; label: string } | null {
  const { state } = view;
  const pos = state.selection.main.head;
  for (
    let n: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(pos, 0);
    n;
    n = n.parent
  ) {
    if (n.name === "Image") {
      const p = linkParts(state, n);
      const source = imageSource(doc, p.url);
      if (source.kind !== "url") return null;
      const name = state.sliceDoc(p.textFrom, p.textTo) || p.url.split("/").pop() || "";
      return {
        label: "View Image",
        open: () => void source.url.then((src) => openMediaViewer({ kind: "image", src, name })),
      };
    }
    if (n.name === "FencedCode") {
      const info = n.getChild("CodeInfo");
      if (!info || state.sliceDoc(info.from, info.to).trim().toLowerCase() !== "mermaid") return null;
      const text = n.getChild("CodeText");
      const body = text ? state.sliceDoc(text.from, text.to).replace(/\n+$/, "") : "";
      return {
        label: "View Diagram",
        open: () => {
          const show = (r: { svg: string } | { error: string }) =>
            "svg" in r && openMediaViewer({ kind: "svg", svg: r.svg, name: "Mermaid" });
          const cached = cachedMermaid(body);
          if (cached) show(cached);
          else void renderMermaid(body).then(show);
        },
      };
    }
  }
  return null;
}

export function registerMarkdownActions(): () => void {
  const disposers = [
    registerActions([
      ...INLINE.map(([f, title, icon, keywords]) =>
        action(
          `markdown.${f === "code" ? "inlineCode" : f === "math" ? "inlineMath" : f}`,
          title,
          icon,
          (v) => toggleInline(v, f),
          {
            keywords: ["markdown", "format", ...keywords],
          },
        ),
      ),
      action("markdown.link", "Link", "md-link", (v) => insertLink(v), { keywords: ["markdown", "url", "href"] }),
      ...BLOCKS.map(([kind, title, icon, id]) =>
        action(id, title, icon, (v) => setBlock(v, kind), { keywords: ["markdown", "paragraph", "heading", "list"] }),
      ),
      ...INSERTS.map(([kind, , icon, id, title]) =>
        action(id, title, icon, (v) => insertBlock(v, kind), { keywords: ["markdown", "insert"] }),
      ),
      action(
        "markdown.insertCallout",
        "Insert Callout",
        "md-callout",
        (v, arg) => insertBlock(v, `callout:${(arg as CalloutKind) ?? "note"}`),
        {
          keywords: ["markdown", "alert", "note", "admonition"],
        },
      ),
      action(
        "markdown.insertDiagram",
        "Insert Mermaid Diagram",
        "md-diagram",
        (v, arg) => insertBlock(v, `mermaid:${(arg as MermaidKind) ?? "flowchart"}`),
        {
          keywords: ["markdown", "mermaid", "flowchart", "chart"],
        },
      ),
    ]),
    registerMenuGroup({
      id: "markdown.edit",
      menus: ["editorTop"],
      order: 10,
      items: (_menu, { paths }) => {
        const path = paths[0];
        const view = markdownView();
        if (!path || !isMarkdownPath(path) || !view) return [];
        const current = blockAt(view.state);
        const viewable = viewableAt(view, path);
        const items: MenuItem[] = [
          {
            label: "Format",
            icon: "md-bold",
            submenu: [
              { kind: "action", action: "markdown.bold" },
              { kind: "action", action: "markdown.italic" },
              { kind: "action", action: "markdown.strikethrough" },
              { kind: "action", action: "markdown.inlineCode" },
              { kind: "action", action: "markdown.inlineMath" },
              { kind: "separator" },
              { kind: "action", action: "markdown.link" },
            ],
          },
          {
            label: "Paragraph",
            icon: "md-text",
            submenu: BLOCKS.flatMap(([kind, title, icon]): MenuItem[] => [
              ...(kind === "bullet" ? [{ kind: "separator" } as MenuItem] : []),
              { label: title, icon, checked: current === kind, run: () => setBlock(view, kind) },
            ]),
          },
          {
            label: "Insert",
            icon: "md-table",
            submenu: [
              ...INSERTS.slice(0, 4).map(([, title, , id]): MenuItem => ({ kind: "action", action: id, label: title })),
              {
                label: "Callout",
                icon: "md-callout",
                submenu: CALLOUTS.map(([kind, title]): MenuItem => ({
                  kind: "action",
                  action: "markdown.insertCallout",
                  arg: kind,
                  label: title,
                })),
              },
              {
                label: "Mermaid Diagram",
                icon: "md-diagram",
                submenu: DIAGRAMS.map(([kind, title]): MenuItem => ({
                  kind: "action",
                  action: "markdown.insertDiagram",
                  arg: kind,
                  label: title,
                })),
              },
              { kind: "separator" },
              ...INSERTS.slice(4).map(([, title, , id]): MenuItem => ({ kind: "action", action: id, label: title })),
            ],
          },
        ];
        if (viewable) items.push({ label: viewable.label, icon: "maximize", run: viewable.open });
        return items;
      },
    }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
