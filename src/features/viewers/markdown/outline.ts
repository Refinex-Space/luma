/** The headings of a Markdown document, for its outline (ATX and setext; code and front matter skipped). */

export interface MarkdownHeading {
  level: number;
  /** Plain text: inline Markdown (links, emphasis, code marks) removed. */
  text: string;
  /** 0-based source line. */
  line: number;
}

/** `text` without inline Markdown: what a reader sees of a heading. */
export function plainHeading(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/(\*\*|__|~~|\*|_|`|==)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/\\([\\`*_{}[\]()#+\-.!|~])/g, "$1")
    .replace(/\s+#+\s*$/, "")
    .trim();
}

export function markdownHeadings(source: string): MarkdownHeading[] {
  const lines = source.split("\n");
  const out: MarkdownHeading[] = [];
  let fence: string | null = null;
  let i = 0;
  // Front matter.
  if (/^(---|\+\+\+)\s*$/.test(lines[0] ?? "")) {
    const mark = lines[0]!.trim();
    for (i = 1; i < lines.length; i++)
      if (lines[i]!.trim() === mark || (mark === "---" && lines[i]!.trim() === "...")) break;
    i++;
  }
  /** The previous line was paragraph text (a setext underline needs a paragraph's first line). */
  let inParagraph = false;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && !line.slice(f[0].length).trim()) fence = null;
      continue;
    }
    if (f) {
      fence = f[1]!;
      inParagraph = false;
      continue;
    }
    const atx = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*$/.exec(line);
    if (atx) {
      const text = plainHeading(atx[2] ?? "");
      if (text) out.push({ level: atx[1]!.length, text, line: i });
      inParagraph = false;
      continue;
    }
    if (!line.trim()) {
      inParagraph = false;
      continue;
    }
    // Setext: a paragraph's line underlined by === or ---.
    const next = lines[i + 1];
    const under = next === undefined ? null : /^ {0,3}(=+|-+)\s*$/.exec(next);
    if (under && !inParagraph && !/^\s*([-*+>]|\d+[.)])\s/.test(line) && !/^\s*\|/.test(line)) {
      out.push({ level: under[1]![0] === "=" ? 1 : 2, text: plainHeading(line), line: i });
      i++;
      inParagraph = false;
      continue;
    }
    inParagraph = true;
  }
  return out;
}

/** The heading the reader is in: the last one at or above `line` (-1 before the first). */
export function activeHeading(headings: readonly MarkdownHeading[], line: number): number {
  let active = -1;
  for (let i = 0; i < headings.length && headings[i]!.line <= line; i++) active = i;
  return active;
}
