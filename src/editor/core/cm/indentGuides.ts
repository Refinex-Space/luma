/**
 * Indent guides drawn as a repeating background on each line's indentation
 * (cheap: one line decoration per visible line, no extra DOM). Blank lines
 * inherit the smaller level of their neighbours so guides stay continuous.
 * Rainbow Brackets colours each level like the brackets of that depth: one
 * 1px background layer per level, in `--syn-bracket-<n>`. The outermost level
 * (a top-level class's body, as long as the file) is left out, as in IDEA's
 * Rainbow Brackets.
 */
import { RangeSetBuilder, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { getIndentUnit } from "@codemirror/language";

/** Colours the rainbow guides cycle through (the bracket palette). */
const GUIDE_COLORS = 5;
/** Levels drawn in colour at most; deeper ones are rare and stay plain. */
const MAX_RAINBOW_LEVELS = 24;

/**
 * The background layers of `levels` rainbow guides, `step` columns apart; level 0 (the
 * outermost block) gets none.
 */
export function rainbowGuideStyle(levels: number, step: number): string {
  const n = Math.min(levels, MAX_RAINBOW_LEVELS);
  const images: string[] = [];
  const positions: string[] = [];
  for (let k = 1; k < n; k++) {
    const color = `var(--luma-rainbow-guide-${(k % GUIDE_COLORS) + 1})`;
    images.push(`linear-gradient(${color}, ${color})`);
    positions.push(`calc(6px + ${k * step}ch) 0`);
  }
  return [
    `background-image: ${images.join(", ")}`,
    `background-position: ${positions.join(", ")}`,
    "background-size: 1px 100%",
    "background-repeat: no-repeat",
  ].join("; ");
}

const cache = new Map<string, Decoration>();
function guideDeco(levels: number, step: number, rainbow: boolean) {
  const key = `${levels}:${step}:${rainbow}`;
  let d = cache.get(key);
  if (!d) {
    d = Decoration.line({
      attributes: rainbow
        ? { class: "cm-luma-guides-rainbow", style: rainbowGuideStyle(levels, step) }
        : { class: "cm-luma-guides", style: `--luma-guide-levels: ${levels}; --luma-guide-step: ${step}` },
    });
    cache.set(key, d);
  }
  return d;
}

function indentColumns(text: string, tabSize: number): number | null {
  let col = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 32) col++;
    else if (ch === 9) col += tabSize - (col % tabSize);
    else return col;
  }
  return null; // blank
}

const LOOKAROUND = 200;

function levelOf(state: EditorState, lineNo: number, step: number, dir: 1 | -1): number {
  const doc = state.doc;
  for (let n = lineNo, i = 0; n >= 1 && n <= doc.lines && i < LOOKAROUND; n += dir, i++) {
    const cols = indentColumns(doc.line(n).text, state.tabSize);
    if (cols !== null) return Math.floor(cols / step);
  }
  return 0;
}

function build(view: EditorView, rainbow: boolean): DecorationSet {
  const state = view.state;
  const step = Math.max(1, getIndentUnit(state));
  const b = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      if (line.length < 10_000) {
        const cols = indentColumns(line.text, state.tabSize);
        let levels: number;
        if (cols === null) {
          levels = Math.min(levelOf(state, line.number - 1, step, -1), levelOf(state, line.number + 1, step, 1));
        } else {
          levels = Math.floor(cols / step);
        }
        // Rainbow guides skip the outermost level: a line at level 1 has none.
        if (levels > (rainbow ? 1 : 0)) b.add(line.from, line.from, guideDeco(levels, step, rainbow));
      }
      pos = line.to + 1;
    }
  }
  return b.finish();
}

function guides(rainbow: boolean): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, rainbow);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.startState.tabSize !== u.state.tabSize)
          this.decorations = build(u.view, rainbow);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** Plain indent guides. */
export const indentGuides: Extension = guides(false);
/** Indent guides in the colours of the bracket depths (Rainbow Brackets). */
export const rainbowIndentGuides: Extension = guides(true);
