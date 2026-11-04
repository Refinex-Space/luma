/**
 * Markdown → sanitized HTML for the preview. Every top-level block is wrapped
 * in an element carrying its 0-based source line (`data-line`) for scroll
 * sync; images keep their source in `data-src` and are loaded by the preview
 * (local files through the backend, as the CSP blocks file URLs). Mermaid
 * blocks become `[data-mermaid]` placeholders, drawn by `./mermaid`; TeX math
 * becomes `[data-math]` elements holding their source, typeset by `./math`.
 *
 * Beyond GFM: `$…$` / `$$…$$` math, GitHub alerts (`> [!NOTE]`), footnotes,
 * clickable task items (`data-task-line`) and a YAML front matter table.
 */
import { Marked, type Token, type Tokens, type TokensList, type TokenizerAndRendererExtension } from "marked";
import DOMPurify from "dompurify";
import { tx } from "@/platform/i18n";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Heading ids carry GitHub's prefix: bare ids like `title` would clobber
 * `document` properties, so the sanitizer drops them.
 */
export const ANCHOR_PREFIX = "user-content-";

/** GitHub-style heading anchor: lower case, punctuation dropped, spaces → dashes. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

const countLines = (s: string) => {
  let n = 0;
  for (let i = s.indexOf("\n"); i >= 0; i = s.indexOf("\n", i + 1)) n++;
  return n;
};

// --- per-render state ----------------------------------------------------------

interface RenderState {
  /** Footnote definitions by label, as lexed. */
  defs: Map<string, Token[]>;
  /** Labels in the order of their first reference (their numbers). */
  order: string[];
  /** References made so far per label (for unique back-link ids). */
  refs: Map<string, number>;
  /** Source lines of the task items of the block being rendered, in order. */
  taskLines: number[];
}

let state: RenderState = { defs: new Map(), order: [], refs: new Map(), taskLines: [] };

// --- math ----------------------------------------------------------------------

/** `$$ tex $$` on one line, or `$$` fences on lines of their own. */
const MATH_BLOCK = /^ {0,3}\$\$(?:[ \t]*\n([\s\S]*?)\n {0,3}\$\$|((?:\\[\s\S]|[^\n$\\])+?)\$\$)[ \t]*(?:\n|$)/;
/** `$tex$`: not `$$`, no space inside either `$`, the closing one not followed by a digit. */
const MATH_INLINE = /^\$(?!\$)((?:\\[\s\S]|[^\\$\n])+?)\$(?!\d)/;

const mathElement = (tex: string, display: boolean) =>
  display
    ? `<div class="math-display" data-math="display">${escapeHtml(tex.trim())}</div>\n`
    : `<span class="math-inline" data-math="inline">${escapeHtml(tex)}</span>`;

const mathBlock: TokenizerAndRendererExtension = {
  name: "mathBlock",
  level: "block",
  start: (src) => src.match(/^ {0,3}\$\$/m)?.index,
  tokenizer(src) {
    const m = MATH_BLOCK.exec(src);
    if (!m) return undefined;
    const text = m[1] ?? m[2] ?? "";
    if (!text.trim()) return undefined;
    return { type: "mathBlock", raw: m[0], text };
  },
  renderer: (token) => mathElement(token.text as string, true),
};

const mathInline: TokenizerAndRendererExtension = {
  name: "mathInline",
  level: "inline",
  start: (src) => {
    const i = src.indexOf("$");
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    const m = MATH_INLINE.exec(src);
    if (!m || /^\s/.test(m[1]!) || /\s$/.test(m[1]!)) return undefined;
    return { type: "mathInline", raw: m[0], text: m[1]! };
  },
  renderer: (token) => mathElement(token.text as string, false),
};

// --- footnotes -----------------------------------------------------------------

/** `[^label]: text`, continued by indented lines (blank lines between them allowed). */
const FOOTNOTE_DEF = /^\[\^([^\]\s]+)\]:[ \t]*([^\n]*(?:\n(?:[ \t]*\n)*(?: {2,}|\t)[^\n]*)*)(?:\n|$)/;

const footnoteSlug = (label: string) => slugify(label) || "x";

const footnoteDef: TokenizerAndRendererExtension = {
  name: "footnoteDef",
  level: "block",
  start: (src) => src.match(/^\[\^[^\]\s]+\]:/m)?.index,
  tokenizer(src) {
    const m = FOOTNOTE_DEF.exec(src);
    if (!m) return undefined;
    const label = m[1]!.toLowerCase();
    const body = m[2]!.replace(/\n(?: {1,4}|\t)/g, "\n");
    const tokens = this.lexer.blockTokens(body, []);
    if (!state.defs.has(label)) state.defs.set(label, tokens);
    return { type: "footnoteDef", raw: m[0], label, tokens: [] };
  },
  // Listed at the end of the document, numbered by first reference.
  renderer: () => "",
};

const footnoteRef: TokenizerAndRendererExtension = {
  name: "footnoteRef",
  level: "inline",
  start: (src) => {
    const i = src.indexOf("[^");
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    const m = /^\[\^([^\]\s]+)\]/.exec(src);
    // Without a definition the text stays as written (like GitHub).
    if (!m || !state.defs.has(m[1]!.toLowerCase())) return undefined;
    return { type: "footnoteRef", raw: m[0], label: m[1]!.toLowerCase() };
  },
  renderer(token) {
    const label = token.label as string;
    let n = state.order.indexOf(label) + 1;
    if (!n) n = state.order.push(label);
    const k = (state.refs.get(label) ?? 0) + 1;
    state.refs.set(label, k);
    const slug = footnoteSlug(label);
    const id = `${ANCHOR_PREFIX}fnref-${slug}${k > 1 ? `-${k}` : ""}`;
    return `<sup class="footnote-ref"><a href="#fn-${slug}" id="${id}">${n}</a></sup>`;
  },
};

// --- callouts & tasks ------------------------------------------------------------

const CALLOUTS = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
} as const;
const CALLOUT = /^\[!(note|tip|important|warning|caution)\][ \t]*([^\n]*)(?:\n|$)/i;

/** A task item: list marker (inside quotes too) followed by `[ ]` / `[x]`. */
const TASK_ITEM = /^(\s*(?:>\s*)*(?:[-*+]|\d{1,9}[.)])\s+\[)([ xX])\](?=\s|$)/;

/** Source lines (offset by `start`) of the task items in `raw`, skipping fenced code. */
function taskLinesIn(raw: string, start: number): number[] {
  const out: number[] = [];
  let fence: string | null = null;
  raw.split("\n").forEach((line, i) => {
    const f = /^\s*(?:>\s*)*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null;
      return;
    }
    if (f) fence = f[1]!;
    else if (TASK_ITEM.test(line)) out.push(start + i);
  });
  return out;
}

/**
 * Where to toggle the task item on source line `line`: the offset of its mark
 * inside the brackets and the mark to write there, or `null` for no task item.
 */
export function toggleTaskSource(line: string): { at: number; mark: " " | "x" } | null {
  const m = TASK_ITEM.exec(line);
  if (!m) return null;
  return { at: m[1]!.length, mark: m[2] === " " ? "x" : " " };
}

// --- the renderer ----------------------------------------------------------------

const marked: Marked = new Marked({
  gfm: true,
  breaks: false,
  extensions: [mathBlock, mathInline, footnoteDef, footnoteRef],
  renderer: {
    code({ text, lang }) {
      const name = lang?.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (name === "mermaid")
        return `<div data-mermaid=""><pre><code class="language-mermaid">${escapeHtml(text)}</code></pre></div>\n`;
      if (name === "math" || name === "latex") return mathElement(text, true);
      const safe = /^[\w#+.-]+$/.test(name) ? name : "";
      const cls = safe ? ` class="language-${safe}"` : "";
      const label = safe ? `<span class="code-lang">${escapeHtml(safe)}</span>` : "";
      return `<div class="code-block">${label}<pre><code${cls}>${escapeHtml(text)}</code></pre></div>\n`;
    },
    blockquote({ text }): string | false {
      const m = CALLOUT.exec(text);
      if (!m) return false;
      const kind = m[1]!.toLowerCase() as keyof typeof CALLOUTS;
      const title: string = m[2]!.trim()
        ? (marked.parseInline(m[2]!.trim(), { async: false }) as string)
        : tx(CALLOUTS[kind]);
      const rest = text.slice(m[0].length);
      const body = rest.trim() ? this.parser.parse(marked.lexer(rest)) : "";
      return `<div class="callout callout-${kind}"><p class="callout-title"><span class="callout-icon"></span>${title}</p>${body}</div>\n`;
    },
    list(token) {
      if (!token.items.some((i) => i.task)) return false;
      const tag = token.ordered ? "ol" : "ul";
      const start = token.ordered && token.start !== 1 && token.start !== "" ? ` start="${token.start}"` : "";
      return `<${tag}${start} class="contains-task-list">\n${token.items.map((i) => this.listitem(i)).join("")}</${tag}>\n`;
    },
    listitem(item) {
      if (!item.task) return false;
      const line = state.taskLines.shift();
      const attr = line === undefined ? "" : ` data-task-line="${line}"`;
      return `<li class="task-list-item"${attr}>${this.parser.parse(item.tokens)}</li>\n`;
    },
    checkbox({ checked }) {
      return `<input type="checkbox" class="task-checkbox"${checked ? " checked" : ""}> `;
    },
  },
});

// --- front matter ----------------------------------------------------------------

const FRONT_MATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

function frontMatterHtml(yaml: string): string {
  const rows: Array<[string, string]> = [];
  for (const line of yaml.split(/\r?\n/)) {
    const m = /^([^\s#:][^:]*?):(?:\s+(.*))?$/.exec(line);
    if (m) rows.push([m[1]!, (m[2] ?? "").trim()]);
    else if (rows.length && line.trim() && !line.trimStart().startsWith("#"))
      rows[rows.length - 1]![1] += (rows[rows.length - 1]![1] ? "\n" : "") + line.trim();
  }
  if (!rows.length)
    return `<div class="code-block"><span class="code-lang">yaml</span><pre><code class="language-yaml">${escapeHtml(yaml)}</code></pre></div>`;
  const unquote = (v: string) => v.replace(/^(["'])(.*)\1$/, "$2");
  const body = rows
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(unquote(v)).replace(/\n/g, "<br>")}</td></tr>`)
    .join("");
  return `<table class="front-matter"><tbody>${body}</tbody></table>`;
}

// --- sanitizing ------------------------------------------------------------------

// Own instance: hooks must not leak into the hover / documentation renderer.
let purifier: ReturnType<typeof DOMPurify> | null = null;

function purify(): ReturnType<typeof DOMPurify> {
  if (purifier) return purifier;
  const p = DOMPurify(window);
  p.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "IMG") {
      const src = node.getAttribute("src");
      node.removeAttribute("src");
      if (src) node.setAttribute("data-src", src);
    }
    if (node.tagName === "A" && node.getAttribute("href")) node.setAttribute("rel", "noopener noreferrer");
    // Only task checkboxes, and they act through the source (no form controls of the page).
    if (node.tagName === "INPUT" && !node.classList.contains("task-checkbox")) node.setAttribute("disabled", "");
  });
  purifier = p;
  return p;
}

export function renderMarkdown(text: string): string {
  state = { defs: new Map(), order: [], refs: new Map(), taskLines: [] };
  let html = "";
  let line = 0;
  const front = FRONT_MATTER.exec(text);
  if (front) {
    if (front[1]?.trim()) html += `<div data-line="0">${frontMatterHtml(front[1])}</div>`;
    line = countLines(front[0]);
    text = text.slice(front[0].length);
  }
  const tokens = marked.lexer(text);
  const slugs = new Map<string, number>();
  for (const token of tokens) {
    const start = line;
    line += countLines(token.raw);
    if (token.type === "space" || token.type === "footnoteDef") continue;
    state.taskLines = taskLinesIn(token.raw, start);
    const list = Object.assign([token], { links: tokens.links }) as TokensList;
    let body = marked.parser(list);
    if (token.type === "heading") {
      const base = slugify((token as Tokens.Heading).text);
      const n = slugs.get(base) ?? 0;
      slugs.set(base, n + 1);
      const slug = n ? `${base}-${n}` : base;
      body = body.replace(
        /^<h(\d)>/,
        `<h$1 id="${ANCHOR_PREFIX}${slug}"><a class="heading-anchor" href="#${slug}" aria-hidden="true" tabindex="-1"></a>`,
      );
    }
    // Tables fill the page width and scroll sideways inside their own box when wider.
    if (token.type === "table") body = `<div class="table-scroll">${body}</div>`;
    if (body) html += `<div data-line="${start}">${body}</div>`;
  }
  html += footnotesHtml(tokens.links);
  return purify().sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["data-src", "data-line", "data-task-line", "data-math"],
  });
}

/** The referenced footnotes in reference order, each with a link back to its first reference. */
function footnotesHtml(links: TokensList["links"]): string {
  if (!state.order.length) return "";
  let items = "";
  // A footnote may reference another: the order grows while rendering.
  for (let i = 0; i < state.order.length; i++) {
    const label = state.order[i]!;
    const slug = footnoteSlug(label);
    const back = `<a href="#fnref-${slug}" class="footnote-backref" aria-label="${escapeHtml(tx("Back to content"))}">↩</a>`;
    const tokens = Object.assign([...(state.defs.get(label) ?? [])], { links }) as TokensList;
    let body = marked.parser(tokens);
    body = /<\/p>\s*$/.test(body) ? body.replace(/<\/p>\s*$/, ` ${back}</p>`) : `${body}${back}`;
    items += `<li id="${ANCHOR_PREFIX}fn-${slug}">${body}</li>`;
  }
  return `<section class="footnotes"><ol>${items}</ol></section>`;
}

export type LinkTarget =
  | { kind: "external"; url: string }
  | { kind: "anchor"; id: string }
  | { kind: "file"; path: string; anchor?: string; line?: number };

/** Directory of `file` (forward slashes). */
const dirOf = (file: string) => file.slice(0, Math.max(0, file.lastIndexOf("/")));

/** Joins `rel` onto `dir`, resolving `.` / `..`. Absolute `rel` (leading `/`) is kept. */
export function joinPath(dir: string, rel: string): string {
  const parts = (rel.startsWith("/") ? rel : `${dir}/${rel}`).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") {
      if (out.length > 1) out.pop();
    } else if (p !== "." && (p !== "" || out.length === 0)) out.push(p);
  }
  return out.join("/") || "/";
}

/** Where a link in the Markdown file `file` points. */
export function resolveLink(file: string, href: string): LinkTarget | null {
  const h = href.trim();
  if (!h) return null;
  if (/^(https?|mailto):/i.test(h)) return { kind: "external", url: h };
  if (h.startsWith("#")) return { kind: "anchor", id: decodeURIComponent(h.slice(1)) };
  let rest = h;
  if (/^file:\/\//i.test(rest)) rest = rest.replace(/^file:\/\//i, "");
  else if (/^[a-z][a-z0-9+.-]*:/i.test(rest)) return null;
  const hash = rest.indexOf("#");
  const fragment = hash >= 0 ? decodeURIComponent(rest.slice(hash + 1)) : undefined;
  const pathPart = decodeURIComponent((hash >= 0 ? rest.slice(0, hash) : rest).replace(/\?.*$/, ""));
  const path = pathPart ? joinPath(dirOf(file), pathPart) : file;
  const lineMatch = fragment ? /^L(\d+)/.exec(fragment) : null;
  if (lineMatch) return { kind: "file", path, line: Math.max(0, Number(lineMatch[1]) - 1) };
  return { kind: "file", path, ...(fragment ? { anchor: fragment } : {}) };
}

/**
 * Preview scroll offset that shows source line `line` at the top: interpolates
 * between the blocks around it (`blocks` sorted by line, with their offsets).
 */
export function previewOffsetForLine(
  blocks: ReadonlyArray<{ line: number; top: number }>,
  line: number,
  end: number,
): number {
  if (!blocks.length) return 0;
  let i = 0;
  while (i + 1 < blocks.length && blocks[i + 1]!.line <= line) i++;
  const a = blocks[i]!;
  if (line <= a.line) return a.top;
  const b = blocks[i + 1];
  const nextLine = b?.line ?? a.line + 1;
  const nextTop = b?.top ?? end;
  const t = Math.min(1, (line - a.line) / Math.max(1, nextLine - a.line));
  return a.top + t * (nextTop - a.top);
}
