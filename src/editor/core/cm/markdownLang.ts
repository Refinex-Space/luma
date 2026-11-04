/**
 * Markdown for the editor: GFM (tables, task lists, strikethrough, autolinks) with fenced code
 * highlighted in its own language, plus the syntax the preview renders that CommonMark lacks:
 * `$…$` / `$$…$$` math and a YAML front matter block at the top of the file.
 *
 * The node names (`InlineMath`, `BlockMath`, `FrontMatter` and their `…Mark`s) are what the
 * live preview decorates; the preview's renderer follows the same rules.
 */
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { LanguageDescription, type LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tags as t } from "@lezer/highlight";
import type { BlockContext, Line, MarkdownConfig } from "@lezer/markdown";

const DOLLAR = 36;
const BACKSLASH = 92;
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
const isDigit = (c: number) => c >= 48 && c <= 57;

/**
 * Where the inline math opened by the `$` at `start` of `text` closes (the index of its closing
 * `$`), or -1. Pandoc's rules: no space just inside either `$`, no digit right after the closing
 * one, `$$` is not inline math and `\$` is a literal dollar.
 */
export function inlineMathEnd(text: string, start: number): number {
  const open = text.charCodeAt(start + 1);
  if (Number.isNaN(open) || open === DOLLAR || isSpace(open)) return -1;
  for (let i = start + 1; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === BACKSLASH) {
      i++;
      continue;
    }
    if (c === 10 && text.charCodeAt(i + 1) === 10) return -1;
    if (c !== DOLLAR) continue;
    if (isSpace(text.charCodeAt(i - 1)) || isDigit(text.charCodeAt(i + 1))) continue;
    return i;
  }
  return -1;
}

const mathSyntax: MarkdownConfig = {
  defineNodes: [
    { name: "InlineMath", style: t.special(t.string) },
    { name: "InlineMathMark", style: t.processingInstruction },
    { name: "BlockMath", block: true, style: t.special(t.string) },
    { name: "BlockMathMark", style: t.processingInstruction },
  ],
  parseInline: [
    {
      name: "InlineMath",
      parse(cx, next, pos) {
        if (next !== DOLLAR || cx.char(pos - 1) === DOLLAR) return -1;
        // The inline context holds the paragraph's text from `cx.offset`.
        const end = inlineMathEnd(cx.text, pos - cx.offset);
        if (end < 0) return -1;
        const close = end + cx.offset;
        return cx.addElement(
          cx.elt("InlineMath", pos, close + 1, [
            cx.elt("InlineMathMark", pos, pos + 1),
            cx.elt("InlineMathMark", close, close + 1),
          ]),
        );
      },
      before: "Emphasis",
    },
  ],
  parseBlock: [
    {
      name: "BlockMath",
      parse(cx: BlockContext, line: Line) {
        if (line.next !== DOLLAR || line.text.charCodeAt(line.pos + 1) !== DOLLAR) return false;
        const start = cx.lineStart + line.pos;
        const marks = [cx.elt("BlockMathMark", start, start + 2)];
        const rest = line.text.slice(line.pos + 2);
        const close = rest.indexOf("$$");
        if (close >= 0) {
          // `$$ … $$` on one line, nothing after it.
          if (rest.slice(close + 2).trim()) return false;
          const end = start + 2 + close;
          marks.push(cx.elt("BlockMathMark", end, end + 2));
          cx.nextLine();
          cx.addElement(cx.elt("BlockMath", start, end + 2, marks));
          return true;
        }
        let end = cx.lineStart + line.text.length;
        while (cx.nextLine()) {
          const text = line.text.trimEnd();
          end = cx.lineStart + line.text.length;
          if (text.endsWith("$$")) {
            const at = cx.lineStart + text.length - 2;
            marks.push(cx.elt("BlockMathMark", at, at + 2));
            end = at + 2;
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt("BlockMath", start, end, marks));
        return true;
      },
      endLeaf: (_cx, line) => line.next === DOLLAR && line.text.charCodeAt(line.pos + 1) === DOLLAR,
      before: "FencedCode",
    },
  ],
};

const FENCE = /^(?:---|\+\+\+)\s*$/;

/** `---` YAML (or `+++` TOML) front matter, only as the file's first lines. */
const frontMatter: MarkdownConfig = {
  defineNodes: [
    { name: "FrontMatter", block: true, style: t.meta },
    { name: "FrontMatterMark", style: t.processingInstruction },
  ],
  parseBlock: [
    {
      name: "FrontMatter",
      parse(cx, line) {
        if (cx.lineStart !== 0 || line.pos !== 0 || !FENCE.test(line.text)) return false;
        const fence = line.text.trim();
        const marks = [cx.elt("FrontMatterMark", 0, 3)];
        let end = line.text.length;
        while (cx.nextLine()) {
          end = cx.lineStart + line.text.length;
          const text = line.text.trim();
          if (text === fence || (fence === "---" && text === "...")) {
            marks.push(cx.elt("FrontMatterMark", cx.lineStart, cx.lineStart + 3));
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt("FrontMatter", 0, end, marks));
        return true;
      },
      before: "HorizontalRule",
    },
  ],
};

/** The language of a fence's info string (`ts`, `java title="x"`), if one is known. */
function fenceLanguage(info: string): LanguageDescription | null {
  const name = info.trim().split(/[\s{]/)[0] ?? "";
  return name ? LanguageDescription.matchLanguageName(languages, name, true) : null;
}

export function markdownSupport(): LanguageSupport {
  return markdown({
    base: markdownLanguage,
    codeLanguages: fenceLanguage,
    extensions: [mathSyntax, frontMatter],
  });
}
