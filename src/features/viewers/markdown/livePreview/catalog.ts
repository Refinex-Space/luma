/**
 * The Markdown commands the slash menu offers (and searches): blocks, lists, inserts and
 * diagrams, each with its icon, the Markdown it writes (shown as a hint) and search aliases —
 * English, the Markdown marker, pinyin and its initials, so `/bt` finds 标题 as `/h` does.
 */
import type { EditorView } from "@codemirror/view";
import { tx } from "@/platform/i18n";
import { insertBlock, setBlock, type BlockKind, type InsertKind } from "./commands";

export type SlashSection = "Basic Blocks" | "Lists" | "Insert" | "Diagrams";

export interface SlashCommand {
  id: string;
  label: string;
  icon: string;
  section: SlashSection;
  /** The Markdown it writes, shown beside the label. */
  hint?: string;
  keywords: readonly string[];
  /** Found by searching only, not listed in the default menu. */
  searchOnly?: boolean;
  run(view: EditorView, replace: { from: number; to: number }): void;
}

/** A line block applied to the caret's line, the `/query` removed first. */
function block(kind: BlockKind) {
  return (view: EditorView, replace: { from: number; to: number }) => {
    view.dispatch({ changes: replace, userEvent: "input.slash" });
    setBlock(view, kind);
  };
}

const insert = (kind: InsertKind) => (view: EditorView, replace: { from: number; to: number }) =>
  insertBlock(view, kind, replace);

const HEADINGS = ["Heading 1", "Heading 2", "Heading 3", "Heading 4", "Heading 5", "Heading 6"];

const heading = (n: 1 | 2 | 3 | 4 | 5 | 6, pinyin: string): SlashCommand => ({
  id: `h${n}`,
  label: HEADINGS[n - 1]!,
  icon: `md-heading-${n}`,
  section: "Basic Blocks",
  hint: "#".repeat(n),
  keywords: [
    `h${n}`,
    `heading${n}`,
    "heading",
    "title",
    "#".repeat(n),
    "biaoti",
    "bt",
    `${pinyin}jibiaoti`,
    `${pinyin[0]}jbt`,
    "标题",
  ],
  searchOnly: n > 3,
  run: block(`h${n}` as BlockKind),
});

const diagram = (id: string, label: string, keywords: string[], kind: InsertKind): SlashCommand => ({
  id,
  label,
  icon: "md-diagram",
  section: "Diagrams",
  hint: "mermaid",
  keywords: ["mermaid", "diagram", "chart", "tubiao", "tb", "图表", ...keywords],
  run: insert(kind),
});

const callout = (
  kind: "note" | "tip" | "important" | "warning" | "caution",
  label: string,
  keywords: string[],
): SlashCommand => ({
  id: `callout-${kind}`,
  label,
  icon: "md-callout",
  section: "Insert",
  hint: `[!${kind.toUpperCase()}]`,
  keywords: ["callout", "alert", "admonition", kind, "tishi", "ts", "提示", ...keywords],
  searchOnly: kind !== "note",
  run: insert(`callout:${kind}`),
});

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    id: "paragraph",
    label: "Text",
    icon: "md-text",
    section: "Basic Blocks",
    keywords: ["text", "paragraph", "body", "plain", "zhengwen", "zw", "duanluo", "dl", "正文", "段落"],
    run: block("paragraph"),
  },
  heading(1, "yi"),
  heading(2, "er"),
  heading(3, "san"),
  heading(4, "si"),
  heading(5, "wu"),
  heading(6, "liu"),
  {
    id: "bullet",
    label: "Bulleted List",
    icon: "md-bullet-list",
    section: "Lists",
    hint: "-",
    keywords: ["ul", "bullet", "unordered", "list", "-", "wuxuliebiao", "wxlb", "liebiao", "lb", "列表"],
    run: block("bullet"),
  },
  {
    id: "ordered",
    label: "Numbered List",
    icon: "md-numbered-list",
    section: "Lists",
    hint: "1.",
    keywords: ["ol", "numbered", "ordered", "list", "1.", "youxuliebiao", "yxlb", "liebiao", "lb", "编号"],
    run: block("ordered"),
  },
  {
    id: "task",
    label: "Task List",
    icon: "md-task-list",
    section: "Lists",
    hint: "[ ]",
    keywords: ["todo", "task", "checkbox", "check", "[]", "renwu", "rw", "daiban", "db", "待办", "任务", "清单"],
    run: block("task"),
  },
  {
    id: "quote",
    label: "Quote",
    icon: "md-quote",
    section: "Lists",
    hint: ">",
    keywords: ["quote", "blockquote", ">", "yinyong", "yy", "引用"],
    run: block("quote"),
  },
  {
    id: "table",
    label: "Table",
    icon: "md-table",
    section: "Insert",
    hint: "| |",
    keywords: ["table", "grid", "|", "biaoge", "bg", "表格"],
    run: insert("table"),
  },
  {
    id: "code",
    label: "Code Block",
    icon: "md-code-block",
    section: "Insert",
    hint: "```",
    keywords: ["code", "codeblock", "fence", "snippet", "```", "daima", "dm", "daimakuai", "dmk", "代码"],
    run: insert("code"),
  },
  {
    id: "math",
    label: "Math Block",
    icon: "md-math",
    section: "Insert",
    hint: "$$",
    keywords: [
      "math",
      "latex",
      "katex",
      "formula",
      "equation",
      "tex",
      "$$",
      "gongshi",
      "gs",
      "shuxue",
      "sx",
      "公式",
      "数学",
    ],
    run: insert("math"),
  },
  callout("note", "Callout", ["note", "zhuyi", "zy", "注意"]),
  callout("tip", "Tip Callout", ["tip", "jiqiao", "jq", "技巧"]),
  callout("important", "Important Callout", ["important", "zhongyao", "zy", "重要"]),
  callout("warning", "Warning Callout", ["warning", "jinggao", "jg", "警告"]),
  callout("caution", "Caution Callout", ["caution", "danger", "weixian", "wx", "危险"]),
  {
    id: "hr",
    label: "Divider",
    icon: "md-divider",
    section: "Insert",
    hint: "---",
    keywords: ["hr", "divider", "rule", "separator", "line", "---", "fengexian", "fgx", "分割线", "分隔线"],
    run: insert("hr"),
  },
  {
    id: "image",
    label: "Image",
    icon: "md-image",
    section: "Insert",
    hint: "![]()",
    keywords: ["image", "picture", "img", "photo", "tupian", "tp", "图片"],
    run: insert("image"),
  },
  {
    id: "link",
    label: "Link",
    icon: "md-link",
    section: "Insert",
    hint: "[]()",
    keywords: ["link", "url", "href", "lianjie", "lj", "链接"],
    run: insert("link"),
  },
  {
    id: "footnote",
    label: "Footnote",
    icon: "md-footnote",
    section: "Insert",
    hint: "[^1]",
    keywords: ["footnote", "note", "reference", "jiaozhu", "jz", "脚注"],
    run: insert("footnote"),
  },
  {
    id: "frontMatter",
    label: "Front Matter",
    icon: "md-front-matter",
    section: "Insert",
    hint: "---",
    keywords: ["front matter", "frontmatter", "yaml", "metadata", "properties", "yuanshuju", "ysj", "元数据", "属性"],
    searchOnly: true,
    run: insert("frontMatter"),
  },
  diagram("flowchart", "Flowchart", ["flowchart", "flow", "graph", "liuchengtu", "lct", "流程图"], "mermaid:flowchart"),
  diagram("sequence", "Sequence Diagram", ["sequence", "shixutu", "sxt", "时序图"], "mermaid:sequence"),
  diagram("class", "Class Diagram", ["class", "uml", "leitu", "lt", "类图"], "mermaid:class"),
  diagram("state", "State Diagram", ["state", "zhuangtaitu", "ztt", "状态图"], "mermaid:state"),
  diagram(
    "er",
    "ER Diagram",
    ["er", "entity", "relationship", "database", "shitiguanxi", "stgx", "实体关系"],
    "mermaid:er",
  ),
  diagram("gantt", "Gantt Chart", ["gantt", "schedule", "gantetu", "gtt", "甘特图"], "mermaid:gantt"),
  diagram("pie", "Pie Chart", ["pie", "bingtu", "bt", "饼图"], "mermaid:pie"),
  diagram("mindmap", "Mind Map", ["mindmap", "mind", "siweidaotu", "swdt", "思维导图"], "mermaid:mindmap"),
];

export const SECTION_ORDER: readonly SlashSection[] = ["Basic Blocks", "Lists", "Insert", "Diagrams"];

/** A query longer than this is prose, not a command search. */
export const MAX_QUERY = 24;
const MAX_RESULTS = 12;

function score(c: SlashCommand, q: string): number {
  const labels = [c.label.toLowerCase(), tx(c.label).toLowerCase()];
  let best = 0;
  for (const l of labels) {
    const flat = l.replace(/\s+/g, "");
    if (flat === q) return 100;
    if (flat.startsWith(q) || l.split(/\s+/).some((w) => w.startsWith(q))) best = Math.max(best, 90);
    else if (flat.includes(q)) best = Math.max(best, 70);
  }
  for (const k of c.keywords) {
    const v = k.toLowerCase().replace(/\s+/g, "");
    if (v === q) best = Math.max(best, 95);
    else if (v.startsWith(q)) best = Math.max(best, 80);
    else if (q.length > 1 && v.includes(q)) best = Math.max(best, 50);
  }
  return best;
}

export interface SlashGroup {
  section: SlashSection | null;
  items: SlashCommand[];
}

/** The menu for `raw`: the default sections when empty, else one ranked list. */
export function slashGroups(raw: string): SlashGroup[] {
  const q = raw.toLowerCase().replace(/\s+/g, "");
  if (!q)
    return SECTION_ORDER.map((section) => ({
      section,
      items: SLASH_COMMANDS.filter((c) => c.section === section && !c.searchOnly),
    }));
  const items = SLASH_COMMANDS.map((c, i) => ({ c, i, s: score(c, q) }))
    .filter((m) => m.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, MAX_RESULTS)
    .map((m) => m.c);
  return items.length ? [{ section: null, items }] : [];
}
