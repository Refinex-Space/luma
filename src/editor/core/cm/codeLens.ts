/**
 * Renders `codeLenses` (editor/api) as one small hint row above the target
 * line, indented like the line (IDEA "3 usages | Run test" inlays).
 */
import { EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { codeLenses, type CodeLens } from "@/editor/api";

/** Groups lenses by line start, ordered by line then `order`. Exported for tests. */
export function groupLenses(
  state: EditorState,
  lenses: readonly CodeLens[],
): Array<{ lineFrom: number; lenses: CodeLens[] }> {
  const byLine = new Map<number, CodeLens[]>();
  const len = state.doc.length;
  for (const l of lenses) {
    if (!(l.pos >= 0 && l.pos <= len)) continue;
    const from = declarationStart(state, state.doc.lineAt(l.pos).number);
    const list = byLine.get(from);
    if (list) list.push(l);
    else byLine.set(from, [l]);
  }
  return [...byLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([lineFrom, list]) => ({
      lineFrom,
      lenses: list.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title)),
    }));
}

/** Attribute / annotation / decorator lines that open the declaration below. */
const PREFIX_LINE = /^\s*(#!?\[|@[\w.])/;

/**
 * Line start where a declaration's lens goes: right above the declaration, its attributes,
 * annotations and decorators included (`#[test]`, `@Override`), below its doc comment.
 */
export function declarationStart(state: EditorState, lineNumber: number): number {
  let n = lineNumber;
  for (let i = 0; i < 50 && n > 1; i++) {
    const prev = state.doc.line(n - 1);
    if (!PREFIX_LINE.test(prev.text)) break;
    n--;
  }
  return state.doc.line(n).from;
}

/** Visual indentation (columns) of a line's leading whitespace. */
export function indentColumns(text: string, tabSize: number): number {
  let col = 0;
  for (const ch of text) {
    if (ch === " ") col++;
    else if (ch === "\t") col += tabSize - (col % tabSize);
    else break;
  }
  return col;
}

const ICONS: Record<string, string> = {
  run: "M4 3l9 5-9 5z",
  user: "M8 2a3 3 0 110 6 3 3 0 010-6zM2.5 14c0-3 2.5-5 5.5-5s5.5 2 5.5 5z",
  debug: "M8 2a3 3 0 013 3v1h1v2h-1v1h1v2h-1a3 3 0 01-6 0H4V9h1V8H4V6h1V5a3 3 0 013-3z",
  // AI actions: a four-point sparkle with a small one beside it.
  ai: "M6.5 1.5l1.3 3.7 3.7 1.3-3.7 1.3-1.3 3.7-1.3-3.7-3.7-1.3 3.7-1.3zM12.5 9l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z",
};

/** The chevron after a menu lens's icon. */
const CHEVRON = "M4 6.5h8L8 10.5z";

function svgIcon(d: string, size: number, className: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add(className);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "currentColor");
  svg.appendChild(path);
  return svg;
}

class LensWidget extends WidgetType {
  constructor(
    readonly lenses: CodeLens[],
    readonly indent: number,
  ) {
    super();
  }

  private get key(): string {
    return (
      this.indent +
      "\u0000" +
      this.lenses
        .map((l) => `${l.icon ?? ""}|${l.title}|${l.tooltip ?? ""}|${l.run ? 1 : 0}|${l.menu ? 1 : 0}`)
        .join("\u0001")
    );
  }

  override eq(other: LensWidget): boolean {
    return this.key === other.key && this.lenses.every((l, i) => l.run === other.lenses[i]?.run);
  }

  override toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement("div");
    dom.className = "cm-luma-lens";
    this.fill(dom, view);
    return dom;
  }

  override updateDOM(dom: HTMLElement, view: EditorView): boolean {
    this.fill(dom, view);
    return true;
  }

  private fill(dom: HTMLElement, view: EditorView) {
    dom.textContent = "";
    dom.style.paddingLeft = `${Math.round(this.indent * view.defaultCharacterWidth) + 6}px`;
    dom.setAttribute("role", "group");
    dom.setAttribute("aria-label", "Code lens");
    this.lenses.forEach((lens, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "cm-luma-lensSep";
        sep.textContent = "|";
        sep.setAttribute("aria-hidden", "true");
        dom.appendChild(sep);
      }
      const el = document.createElement(lens.run ? "button" : "span");
      el.className = lens.run ? "cm-luma-lensItem cm-luma-lensAction" : "cm-luma-lensItem";
      if (lens.menu) el.classList.add("cm-luma-lensMenu");
      if (lens.tooltip) el.title = lens.tooltip;
      if (!lens.title && lens.tooltip) el.setAttribute("aria-label", lens.tooltip);
      if (lens.menu) el.setAttribute("aria-haspopup", "menu");
      if (lens.icon && ICONS[lens.icon])
        el.appendChild(svgIcon(ICONS[lens.icon]!, lens.menu ? 12 : 10, `cm-luma-lensIcon-${lens.icon}`));
      if (lens.title) el.appendChild(document.createTextNode(lens.title));
      if (lens.menu) el.appendChild(svgIcon(CHEVRON, 9, "cm-luma-lensChevron"));
      if (lens.run) {
        const button = el as HTMLButtonElement;
        button.type = "button";
        button.tabIndex = -1;
        button.addEventListener("mousedown", (e) => e.preventDefault());
        button.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          lens.run?.(view, e);
        });
      }
      dom.appendChild(el);
    });
  }

  override get estimatedHeight(): number {
    return 16;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const lenses = state.facet(codeLenses);
  if (!lenses.length) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (const group of groupLenses(state, lenses)) {
    const line = state.doc.lineAt(group.lineFrom);
    const widget = new LensWidget(group.lenses, indentColumns(line.text, state.tabSize));
    builder.add(line.from, line.from, Decoration.widget({ widget, block: true, side: -1 }));
  }
  return builder.finish();
}

const lensTheme = EditorView.theme({
  ".cm-luma-lens": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    height: "16px",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--fs-tiny)",
    color: "var(--fg-muted)",
    WebkitUserSelect: "none",
    userSelect: "none",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  ".cm-luma-lensItem": {
    display: "inline-flex",
    alignItems: "center",
    gap: "3px",
    padding: "0",
    border: "none",
    background: "none",
    font: "inherit",
    color: "inherit",
  },
  ".cm-luma-lensAction": { cursor: "pointer" },
  ".cm-luma-lensAction:hover": { color: "var(--accent)", textDecoration: "underline" },
  ".cm-luma-lensSep": { color: "var(--fg-faint)" },
  ".cm-luma-lensIcon-run": { color: "var(--success)" },
  // The AI actions menu: an icon button, no underline; the chevron says it opens a menu.
  ".cm-luma-lensMenu": {
    gap: "1px",
    height: "16px",
    padding: "0 3px",
    margin: "0 -3px",
    borderRadius: "var(--radius-small, 4px)",
  },
  ".cm-luma-lensMenu:hover, .cm-luma-lensMenu[aria-expanded=true]": {
    color: "var(--fg)",
    background: "var(--bg-hover)",
    textDecoration: "none",
  },
  ".cm-luma-lensIcon-ai": { color: "var(--accent)" },
  ".cm-luma-lensChevron": { opacity: "0.7" },
});

/** Base extension (always installed): no cost until a provider contributes lenses. */
export const codeLensExtension: Extension = [EditorView.decorations.compute([codeLenses], buildDecorations), lensTheme];
