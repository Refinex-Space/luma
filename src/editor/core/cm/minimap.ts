/**
 * Minimap: the file scaled down beside the scrollbar (IDEA's CodeGlance, VS Code's minimap),
 * with a slider over the visible part. Click to jump, drag the slider to scroll, drag the left
 * edge to resize.
 *
 * Performance first: the work per frame is bounded by the minimap's height, never the file's.
 *  - One <canvas>; only the lines inside the minimap's window are painted.
 *  - The slider is a DOM element moved with a transform: when the whole file fits, scrolling
 *    repaints nothing.
 *  - When the window itself scrolls, the painted pixels are shifted and only the strip that
 *    came into view is painted.
 *  - Reads and paints go through `requestMeasure`, at most once per frame, after CodeMirror's
 *    own layout; the syntax tree is never forced (unparsed text paints in the default colour).
 *  - Colours are resolved once per theme (class → colour cache).
 */
import { Facet, type EditorState, type Extension } from "@codemirror/state";
import { foldedRanges, highlightingFor, syntaxTree } from "@codemirror/language";
import { BlockType, EditorView, ViewPlugin, type BlockInfo, type ViewUpdate } from "@codemirror/view";
import { highlightTree, type Highlighter, type Tag } from "@lezer/highlight";
import { minimapHidden, scrollbarMarks, type ScrollbarMark } from "@/editor/api";
import { syntaxHighlightField } from "./syntaxHighlight";

export type MinimapStyle = "characters" | "blocks";

export interface MinimapConfig {
  width: number;
  style: MinimapStyle;
  showMarkers: boolean;
}

export const MINIMAP_WIDTH = { min: 48, max: 240, initial: 110 } as const;

export const clampMinimapWidth = (w: number) =>
  Math.round(Math.min(MINIMAP_WIDTH.max, Math.max(MINIMAP_WIDTH.min, Number.isFinite(w) ? w : MINIMAP_WIDTH.initial)));

/** One source line on the minimap, in CSS px; text and spacing scale by the same factor. */
export const MINIMAP_LINE = 3;

const minimapConfig = Facet.define<MinimapConfig, MinimapConfig>({
  combine: (v) => v[0] ?? { width: MINIMAP_WIDTH.initial, style: "characters", showMarkers: true },
});

// ---------------------------------------------------------------------------
// Geometry (pure, tested)

export interface MinimapMetrics {
  /** Height of the document (no scroll-past-end space), editor px. */
  docHeight: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** Where the document starts in the scroller's content (top padding), px. */
  docOffset: number;
  /** Minimap height, CSS px. */
  height: number;
  /** Minimap px per editor px. */
  scale: number;
}

export interface MinimapGeometry extends MinimapMetrics {
  /** The whole document on the minimap, px. */
  total: number;
  /** How far the minimap's own window is scrolled, px. */
  offset: number;
  sliderTop: number;
  sliderHeight: number;
  /** Slider px per editor scroll px (the slider's speed). */
  speed: number;
}

/**
 * Where the minimap's window and slider are. A document taller than the minimap scrolls the
 * window in proportion to the editor (VS Code's model), so the slider never leaves the view.
 */
export function minimapGeometry(m: MinimapMetrics): MinimapGeometry {
  const total = m.docHeight * m.scale;
  const maxScroll = Math.max(0, m.scrollHeight - m.clientHeight);
  const overflow = Math.max(0, total - m.height);
  const offset = maxScroll > 0 ? (Math.min(Math.max(m.scrollTop, 0), maxScroll) / maxScroll) * overflow : 0;
  const speed = Math.max(1e-6, m.scale - (maxScroll > 0 ? overflow / maxScroll : 0));
  return {
    ...m,
    total,
    offset,
    sliderTop: (m.scrollTop - m.docOffset) * m.scale - offset,
    sliderHeight: Math.max(8, m.clientHeight * m.scale),
    speed,
  };
}

const clampScroll = (g: MinimapMetrics, s: number) =>
  Math.min(Math.max(0, g.scrollHeight - g.clientHeight), Math.max(0, s));

/** The editor scroll that puts the slider's middle at `y` (minimap px). */
export function scrollToCenterSlider(g: MinimapGeometry, y: number): number {
  return clampScroll(g, (y - g.sliderHeight / 2 + g.docOffset * g.scale) / g.speed);
}

/** The editor scroll after dragging the slider `dy` px from where it was at `startScroll`. */
export function scrollAfterDrag(g: MinimapGeometry, startScroll: number, dy: number): number {
  return clampScroll(g, startScroll + dy / g.speed);
}

// ---------------------------------------------------------------------------
// Colours

/** Theme changes (scheme, light / dark) invalidate every resolved colour. */
let themeEpoch = 0;
const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | null = null;

function watchTheme(f: () => void): () => void {
  themeListeners.add(f);
  if (!themeObserver && typeof MutationObserver !== "undefined") {
    themeObserver = new MutationObserver(() => {
      themeEpoch++;
      for (const l of themeListeners) l();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
  }
  return () => {
    themeListeners.delete(f);
    if (!themeListeners.size) {
      themeObserver?.disconnect();
      themeObserver = null;
    }
  };
}

class Palette {
  private byClass = new Map<string, string>();
  private byCss = new Map<string, string>();
  private epoch = -1;
  text = "#888";
  widget = "rgba(128,128,128,.12)";
  selection = "rgba(80,120,255,.3)";
  fold = "rgba(128,128,128,.3)";

  constructor(
    private probe: HTMLElement,
    private view: EditorView,
  ) {}

  /** Re-resolves the base colours when the theme changed since the last paint. */
  sync() {
    if (this.epoch === themeEpoch) return;
    this.epoch = themeEpoch;
    this.byClass.clear();
    this.byCss.clear();
    this.text = getComputedStyle(this.view.contentDOM).color || this.text;
    this.widget = this.css("color-mix(in srgb, var(--fg) 9%, transparent)");
    this.selection = this.css("var(--editor-selection)");
    this.fold = this.css("var(--editor-fold-chip)");
  }

  forClass(cls: string): string {
    let c = this.byClass.get(cls);
    if (c === undefined) {
      this.probe.className = `cm-luma-minimap-probe ${cls}`;
      this.probe.style.color = "";
      c = getComputedStyle(this.probe).color || this.text;
      this.byClass.set(cls, c);
    }
    return c;
  }

  /** Any CSS colour (tokens, `color-mix`) as a canvas colour. */
  css(value: string): string {
    let c = this.byCss.get(value);
    if (c === undefined) {
      this.probe.className = "cm-luma-minimap-probe";
      this.probe.style.color = value;
      c = getComputedStyle(this.probe).color || this.text;
      this.byCss.set(value, c);
    }
    return c;
  }
}

// ---------------------------------------------------------------------------
// Painting

/** Glyph shape of a character: 0 none (space), 1 small (x-height), 2 tall, 3 low punctuation. */
function glyph(code: number): number {
  if (code === 32 || code === 9) return 0;
  if (code >= 97 && code <= 122) return "bdfhklt".includes(String.fromCharCode(code)) ? 2 : 1;
  if ((code >= 65 && code <= 90) || (code >= 48 && code <= 57)) return 2;
  // . , ; : ' " ` - _ ~
  if (code === 46 || code === 44 || code === 59 || code === 58 || code === 39 || code === 34 || code === 96) return 3;
  if (code === 45 || code === 95 || code === 126 || code === 61 || code === 43 || code === 42) return 3;
  // Brackets, operators, CJK: full height.
  return 2;
}

/** Columns a character takes in a monospace editor: 2 for East Asian wide and emoji, 0 for a pair's tail. */
export function charColumns(code: number): number {
  if (code < 0x1100) return 1;
  if (code >= 0xdc00 && code <= 0xdfff) return 0;
  if (code >= 0xd800 && code <= 0xdbff) return 2;
  return code <= 0x115f ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
    ? 2
    : 1;
}

interface Span {
  from: number;
  to: number;
  color: string;
}

/** Token colours of `[from, to)`: the parsed syntax tree, else backend highlighting. */
function tokenSpans(state: EditorState, from: number, to: number, palette: Palette): Span[] {
  const spans: Span[] = [];
  const cache = new Map<readonly Tag[], string | null>();
  const highlighter: Highlighter = {
    style(tags) {
      let cls = cache.get(tags);
      if (cls === undefined) cache.set(tags, (cls = highlightingFor(state, tags)));
      return cls;
    },
  };
  highlightTree(
    syntaxTree(state),
    highlighter,
    (f, t, cls) => spans.push({ from: f, to: t, color: palette.forClass(cls) }),
    from,
    to,
  );
  const backend = state.field(syntaxHighlightField, false);
  if (backend && backend.size) {
    const own: Span[] = [];
    backend.between(from, to, (f, t, deco) => {
      const cls = deco.spec.class as string | undefined;
      if (cls) own.push({ from: f, to: t, color: palette.forClass(cls) });
    });
    if (own.length) {
      spans.push(...own);
      spans.sort((a, b) => a.from - b.from);
    }
  }
  return spans;
}

interface Frame {
  g: MinimapGeometry;
  width: number;
  dpr: number;
  /** Editor char width and line height, px. */
  charWidth: number;
  lineHeight: number;
  /** Columns per row when soft-wrapped (Infinity otherwise). */
  wrapCols: number;
  /** Room kept on the right for the overview lane where the scrollbar takes none (overlay scrollbars). */
  lanePad: number;
}

const TEXT_X = 4;
/** Width of the overview lane over the scrollbar (cm/lanes.ts). */
const OVERVIEW_LANE = 12;

/** What a frame paints: decided and laid out in the read phase. */
interface Plan {
  f: Frame;
  key: string;
  resize: boolean;
  /** Minimap px the painted pixels move up (negative: down). */
  shift: number;
  /** Nothing to draw in the window (an empty document): clear it. */
  clearAll: boolean;
  layouts: Layout[];
  range: [number, number];
}

/** A rectangle-to-be, located in the read phase (editor layout can't be read while painting). */
interface Located {
  /** Block of the start: its line start and top; bottom of the end's block. */
  lineFrom: number;
  sameLine: boolean;
  top: number;
  bottom: number;
}

/** Everything a paint of minimap rows `[top, bottom)` needs from the editor's layout. */
interface Layout {
  top: number;
  bottom: number;
  blocks: BlockInfo[];
  from: number;
  to: number;
  spans: Span[];
  folds: Array<{ from: number; to: number }>;
  selection: Array<Located & { from: number; to: number }>;
  marks: Array<Located & { mark: ScrollbarMark }>;
}

/** Read phase: the blocks, selection and marks in minimap rows `[top, bottom)`. */
function layoutFor(
  view: EditorView,
  g: MinimapGeometry,
  top: number,
  bottom: number,
  palette: Palette,
  cfg: MinimapConfig,
): Layout | null {
  const s = g.scale;
  const docTop = Math.max(0, (top + g.offset) / s);
  const docBottom = (bottom + g.offset) / s;
  const blocks: BlockInfo[] = [];
  for (let at = docTop; at < docBottom && blocks.length < 4000;) {
    const b = view.lineBlockAtHeight(at);
    const last = blocks[blocks.length - 1];
    // A block's bottom edge still belongs to it: step just past it.
    if (!last || b.from > last.from) blocks.push(b);
    else if (b.to >= view.state.doc.length) break;
    at = Math.max(at, b.bottom) + 0.01;
  }
  if (!blocks.length) return null;
  const state = view.state;
  const from = blocks[0]!.from;
  const to = blocks[blocks.length - 1]!.to;
  const locate = (a: number, b: number): Located => {
    const ba = view.lineBlockAt(a);
    const bb = b === a ? ba : view.lineBlockAt(b);
    return { lineFrom: ba.from, sameLine: ba.from === bb.from, top: ba.top, bottom: bb.bottom };
  };
  const selection: Layout["selection"] = [];
  for (const r of state.selection.ranges) {
    if (r.empty || r.to < from || r.from > to) continue;
    const a = Math.max(r.from, from);
    const b = Math.min(r.to, to);
    selection.push({ ...locate(a, b), from: a, to: b });
  }
  const marks: Layout["marks"] = [];
  if (cfg.showMarkers)
    for (const m of state.facet(scrollbarMarks)) {
      if (m.from > to || (m.to ?? m.from) < from) continue;
      if (marks.length >= 2000) break;
      const a = Math.max(m.from, from);
      marks.push({ ...locate(a, m.kind === "thin" ? a : Math.min(m.to ?? m.from, to)), mark: m });
    }
  const folds: Layout["folds"] = [];
  foldedRanges(state).between(from, to, (a, b) => void folds.push({ from: a, to: b }));
  return { top, bottom, blocks, from, to, spans: tokenSpans(state, from, to, palette), folds, selection, marks };
}

class Painter {
  constructor(
    private view: EditorView,
    private ctx: CanvasRenderingContext2D,
    private palette: Palette,
  ) {}

  /** Paints the rows of `layout` (cleared first). No editor layout is read here. */
  paint(f: Frame, cfg: MinimapConfig, layout: Layout) {
    const { ctx, view } = this;
    const { g, dpr } = f;
    const { top, bottom } = layout;
    const state = view.state;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, top, f.width, bottom - top);
    ctx.beginPath();
    ctx.rect(0, top, f.width, bottom - top);
    ctx.clip();

    const s = g.scale;
    const pitch = f.lineHeight * s;
    const cw = f.charWidth * s;
    const maxCols = Math.ceil((f.width - TEXT_X) / cw);
    const y = (docY: number) => docY * s - g.offset;

    // Selection, under the text.
    ctx.fillStyle = this.palette.selection;
    for (const r of layout.selection) {
      const x0 = r.sameLine ? TEXT_X + this.column(state, r.lineFrom, r.from) * cw : 0;
      const x1 = r.sameLine ? TEXT_X + this.column(state, r.lineFrom, r.to) * cw : f.width;
      ctx.fillRect(x0, y(r.top), Math.max(1, x1 - x0), Math.max(pitch, (r.bottom - r.top) * s));
    }

    // Text, softened: the minimap is read as shapes, not letters.
    ctx.globalAlpha = cfg.style === "characters" ? 0.78 : 0.6;
    const cursor = { i: 0 };
    const tabSize = state.tabSize;
    for (const block of layout.blocks) {
      const parts: readonly BlockInfo[] = Array.isArray(block.type) ? (block.type as readonly BlockInfo[]) : [block];
      for (const part of parts) {
        const rowTop = y(part.top);
        if (part.type !== BlockType.Text) {
          // Rendered widgets (tables, images) as a quiet card; small ones (code lenses) stay blank.
          if (part.type === BlockType.WidgetRange && part.height > f.lineHeight * 1.5) {
            ctx.fillStyle = this.palette.widget;
            ctx.fillRect(TEXT_X, rowTop + 1, Math.min(f.width - TEXT_X - 2, 60 * cw), Math.max(1, part.height * s - 2));
          }
          continue;
        }
        const rows = f.wrapCols < Infinity ? Math.max(1, Math.round(part.height / f.lineHeight)) : 1;
        this.text(f, cfg, part, rowTop, pitch, cw, maxCols, rows, layout.spans, cursor, layout.folds, tabSize);
      }
    }

    ctx.globalAlpha = 1;

    // Markers: search hits over their columns, line marks (errors, changes) as a left bar.
    for (const { mark: m, ...at } of layout.marks) {
      const color = this.palette.css(m.color);
      if (m.kind === "thin") {
        const x = TEXT_X + this.column(state, at.lineFrom, m.from) * cw;
        const endCol = this.column(state, at.lineFrom, Math.max(m.from, m.to ?? m.from));
        const w = Math.max(cw * 2, (endCol - this.column(state, at.lineFrom, m.from)) * cw);
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = color;
        ctx.fillRect(x, y(at.top), Math.min(w, f.width - x), pitch);
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = color;
        ctx.fillRect(0, y(at.top), 2, Math.max(pitch, (at.bottom - at.top) * s));
      }
    }
    ctx.restore();
  }

  /** Visual column of `pos` in its line (tabs expanded). */
  private column(state: EditorState, lineFrom: number, pos: number): number {
    const line = state.doc.lineAt(lineFrom);
    const text = line.text.slice(0, Math.min(pos - line.from, 400));
    let col = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      col = code === 9 ? col + state.tabSize - (col % state.tabSize) : col + charColumns(code);
    }
    return col;
  }

  private text(
    f: Frame,
    cfg: MinimapConfig,
    block: BlockInfo,
    top: number,
    pitch: number,
    cw: number,
    maxCols: number,
    rows: number,
    spans: Span[],
    cursor: { i: number },
    folds: ReadonlyArray<{ from: number; to: number }>,
    tabSize: number,
  ) {
    const { ctx } = this;
    const doc = this.view.state.doc;
    const chars = cfg.style === "characters";
    const rowCols = Math.min(maxCols, f.wrapCols);
    // Glyph metrics within a row: lines stay apart, like text seen from afar.
    const base = top + pitch * 0.78;
    const tall = pitch * 0.56;
    const small = pitch * 0.38;
    const low = pitch * 0.18;
    const w = chars ? Math.max(0.5, cw * 0.82) : cw;

    let row = 0;
    let col = 0;
    let runColor = "";
    let runX = 0;
    let runEnd = 0;
    let runRow = 0;
    const flush = () => {
      if (runEnd > runX) {
        ctx.fillStyle = runColor;
        ctx.fillRect(runX, base + runRow * pitch - pitch * 0.5, runEnd - runX, pitch * 0.5);
      }
      runEnd = runX = 0;
    };

    let pos = block.from;
    const end = block.to;
    let fold = 0;
    while (fold < folds.length && folds[fold]!.to <= pos) fold++;
    // Long lines: never look further than the minimap can show.
    const limit = rows * Math.max(rowCols, 1) * tabSize + 1;
    let seen = 0;
    while (pos < end && row < rows && seen < limit) {
      const f2 = folds[fold];
      if (f2 && f2.from <= pos) {
        // A folded range: a chip, then the text after it.
        flush();
        const x = TEXT_X + col * cw;
        ctx.fillStyle = this.palette.fold;
        ctx.fillRect(x, base + row * pitch - small, Math.max(1, cw * 3), small);
        col += 4;
        pos = Math.max(pos, f2.to);
        fold++;
        continue;
      }
      const stop = Math.min(end, f2 ? f2.from : end, pos + 512);
      const text = doc.sliceString(pos, stop);
      for (let i = 0; i < text.length && row < rows; i++, seen++) {
        const at = pos + i;
        const code = text.charCodeAt(i);
        if (code === 10) continue;
        if (col >= rowCols) {
          if (row + 1 >= rows) {
            row = rows;
            break;
          }
          flush();
          row++;
          col = 0;
        }
        const width = code === 9 ? tabSize - (col % tabSize) : charColumns(code);
        if (!width) continue;
        const shape = glyph(code);
        if (shape) {
          while (cursor.i < spans.length && spans[cursor.i]!.to <= at) cursor.i++;
          const span = spans[cursor.i];
          const color = span && span.from <= at ? span.color : this.palette.text;
          const x = TEXT_X + col * cw;
          if (chars) {
            ctx.fillStyle = color;
            const h = shape === 2 ? tall : shape === 1 ? small : low;
            ctx.fillRect(x, base + row * pitch - h, w + (width - 1) * cw, h);
          } else if (color === runColor && runRow === row && Math.abs(runEnd - x) < 0.01) {
            runEnd = x + cw * width;
          } else {
            flush();
            runColor = color;
            runRow = row;
            runX = x;
            runEnd = x + cw * width;
          }
        } else if (!chars) flush();
        col += width;
      }
      pos = stop;
    }
    flush();
  }
}

// ---------------------------------------------------------------------------
// The view

/** Live minimaps: a width drag resizes them all (split editors stay alike). */
const instances = new Set<Minimap>();

/** Persists a new width; provided by the editor setup (settings live outside this module). */
let persistWidth: (width: number) => void = () => {};
let openMenu: (view: EditorView, e: MouseEvent) => void = () => {};

/** Wires the settings write and the context menu (kept out of the CodeMirror layer). */
export function configureMinimap(o: {
  persistWidth: (w: number) => void;
  menu: (view: EditorView, e: MouseEvent) => void;
}) {
  persistWidth = o.persistWidth;
  openMenu = o.menu;
}

class Minimap {
  dom: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private slider: HTMLElement;
  private probe: HTMLElement;
  private palette: Palette;
  private painter: Painter | null;
  private cfg: MinimapConfig;
  private width: number;
  private hidden: boolean;
  private scheduled = false;
  /** Everything the painted pixels depend on besides the window offset. */
  private paintedKey = "";
  private paintedOffset = 0;
  private paintedRange: [number, number] = [0, -1];
  private dirty = true;
  private geometry: MinimapGeometry | null = null;
  private unwatch: () => void;
  private dragging = false;
  private lanePad = 0;

  constructor(private view: EditorView) {
    this.cfg = view.state.facet(minimapConfig);
    this.width = clampMinimapWidth(this.cfg.width);
    this.hidden = view.state.facet(minimapHidden);
    const dom = (this.dom = document.createElement("div"));
    dom.className = "cm-luma-minimap";
    dom.setAttribute("aria-hidden", "true");
    this.canvas = document.createElement("canvas");
    this.canvas.className = "cm-luma-minimap-canvas";
    this.slider = document.createElement("div");
    this.slider.className = "cm-luma-minimap-slider";
    const resize = document.createElement("div");
    resize.className = "cm-luma-minimap-resize";
    this.probe = document.createElement("span");
    this.probe.className = "cm-luma-minimap-probe";
    dom.append(this.canvas, this.slider, resize, this.probe);
    this.ctx = this.canvas.getContext("2d", { alpha: true });
    this.palette = new Palette(this.probe, view);
    this.painter = this.ctx ? new Painter(view, this.ctx, this.palette) : null;

    dom.addEventListener("pointerdown", this.onPointerDown);
    dom.addEventListener("contextmenu", this.onContextMenu);
    resize.addEventListener("pointerdown", this.onResizeDown);
    resize.addEventListener("dblclick", this.onResetWidth);
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    this.unwatch = watchTheme(() => this.invalidate());
    instances.add(this);
    this.attach();
  }

  private attach() {
    if (this.hidden) {
      this.dom.remove();
      this.view.dom.style.removeProperty("--luma-minimap-space");
      return;
    }
    if (this.dom.parentNode !== this.view.scrollDOM) this.view.scrollDOM.appendChild(this.dom);
    this.applyWidth(this.width);
    this.invalidate();
  }

  private applyWidth(w: number) {
    this.width = w;
    this.dom.style.width = `${w}px`;
    this.view.dom.style.setProperty("--luma-minimap-space", `${w}px`);
  }

  /** During a width drag: every minimap follows (no settings round trip per move). */
  setLiveWidth(w: number) {
    if (this.hidden || w === this.width) return;
    this.applyWidth(w);
    this.invalidate();
  }

  update(u: ViewUpdate) {
    const cfg = u.state.facet(minimapConfig);
    const hidden = u.state.facet(minimapHidden);
    if (hidden !== this.hidden) {
      this.hidden = hidden;
      this.attach();
    }
    if (cfg !== this.cfg) {
      const widthChanged = cfg.width !== this.cfg.width;
      this.cfg = cfg;
      if (widthChanged && !this.dragging) this.applyWidth(clampMinimapWidth(cfg.width));
      this.dirty = true;
    }
    if (this.hidden) return;
    if (
      u.docChanged ||
      u.selectionSet ||
      u.heightChanged ||
      u.geometryChanged ||
      syntaxTree(u.state) !== syntaxTree(u.startState) ||
      u.state.field(syntaxHighlightField, false) !== u.startState.field(syntaxHighlightField, false) ||
      u.startState.facet(scrollbarMarks) !== u.state.facet(scrollbarMarks) ||
      foldedRanges(u.state) !== foldedRanges(u.startState)
    ) {
      // Changes outside the painted window (and not moving it) repaint nothing.
      if (!u.docChanged || u.heightChanged || this.touchesPainted(u)) this.dirty = true;
    }
    this.schedule();
  }

  private touchesPainted(u: ViewUpdate): boolean {
    const [a, b] = this.paintedRange;
    let hit = false;
    u.changes.iterChangedRanges((fromA, toA) => {
      if (toA >= a && fromA <= b) hit = true;
    });
    return hit;
  }

  private invalidate() {
    this.dirty = true;
    this.schedule();
  }

  private onScroll = () => this.schedule();

  private schedule() {
    if (this.scheduled || this.hidden) return;
    this.scheduled = true;
    this.view.requestMeasure({ key: this, read: () => this.read(), write: (g) => this.write(g) });
  }

  /**
   * Read phase: geometry, what to repaint (all, a strip after a window shift, or nothing) and
   * the layout of those rows. The write phase then only draws.
   */
  private read(): Plan | null {
    this.scheduled = false;
    const v = this.view;
    const s = v.scrollDOM;
    const height = s.clientHeight;
    if (!height || this.hidden || !this.painter) return null;
    const lineHeight = v.defaultLineHeight || 18;
    const scale = MINIMAP_LINE / lineHeight;
    const docOffset = v.documentTop - s.getBoundingClientRect().top + s.scrollTop;
    const dpr = window.devicePixelRatio || 1;
    const raw = minimapGeometry({
      docHeight: Math.max(1, v.lineBlockAt(v.state.doc.length).bottom),
      scrollTop: s.scrollTop,
      scrollHeight: s.scrollHeight,
      clientHeight: height,
      docOffset,
      height,
      scale,
    });
    // Snap the window to device pixels so shifted pixels stay crisp.
    const g = { ...raw, offset: Math.round(raw.offset * dpr) / dpr };
    const charWidth = v.defaultCharacterWidth || 7;
    let wrapCols = Infinity;
    if (v.lineWrapping) {
      // `.cm-line` side padding (6px + 24px when wrapping), as laid out.
      wrapCols = Math.max(8, Math.floor((v.contentDOM.clientWidth - 30) / charWidth));
    }
    const lanePad = Math.max(0, OVERVIEW_LANE - (s.offsetWidth - s.clientWidth));
    const f: Frame = { g, width: this.width, dpr, charWidth, lineHeight, wrapCols, lanePad };
    this.palette.sync();

    const resize = this.canvas.width !== Math.round(f.width * dpr) || this.canvas.height !== Math.round(height * dpr);
    const key = `${f.width}|${dpr}|${scale}|${wrapCols}|${this.cfg.style}|${this.cfg.showMarkers}|${themeEpoch}`;
    const dy = g.offset - this.paintedOffset;
    let shift = 0;
    let regions: Array<[number, number]> = [];
    if (resize || this.dirty || key !== this.paintedKey || Math.abs(dy) >= height) regions = [[0, height]];
    else if (dy !== 0) {
      shift = dy;
      regions = [dy > 0 ? [Math.max(0, height - dy - 1), height] : [0, Math.min(height, -dy + 1)]];
    }
    const layouts = regions
      .map(([a, b]) => layoutFor(v, g, a, b, this.palette, this.cfg))
      .filter((l): l is Layout => !!l);
    const range: [number, number] = [
      v.lineBlockAtHeight(Math.max(0, g.offset / scale)).from,
      v.lineBlockAtHeight((g.offset + height) / scale).to,
    ];
    return { f, key, resize, shift, clearAll: regions.length > 0 && !layouts.length, layouts, range };
  }

  private write(plan: Plan | null) {
    if (!plan || !this.ctx || !this.painter) return;
    const { f, shift } = plan;
    const { g, dpr } = f;
    this.geometry = g;
    if (this.lanePad !== f.lanePad) {
      this.lanePad = f.lanePad;
      this.dom.style.paddingRight = `${f.lanePad}px`;
    }
    if (plan.resize) {
      this.canvas.width = Math.round(f.width * dpr);
      this.canvas.height = Math.round(g.height * dpr);
      this.canvas.style.width = `${f.width}px`;
      this.canvas.style.height = `${g.height}px`;
    }
    if (shift) {
      // Shift what is painted; the strip that came into view is painted below.
      const ctx = this.ctx;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "copy";
      ctx.drawImage(this.canvas, 0, -Math.round(shift * dpr));
      ctx.restore();
    }
    if (plan.clearAll) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (const layout of plan.layouts) this.painter.paint(f, this.cfg, layout);
    this.dirty = false;
    this.paintedKey = plan.key;
    this.paintedOffset = g.offset;
    this.paintedRange = plan.range;

    // The slider.
    const top = Math.max(0, Math.min(g.height - g.sliderHeight, g.sliderTop));
    this.slider.style.height = `${g.sliderHeight}px`;
    this.slider.style.transform = `translateY(${top}px)`;
    this.slider.hidden = g.scrollHeight <= g.clientHeight + 1;
  }

  // ---- interaction

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).classList.contains("cm-luma-minimap-resize")) return;
    const g = this.geometry;
    if (!g) return;
    e.preventDefault();
    const s = this.view.scrollDOM;
    const rect = this.dom.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const top = Math.max(0, Math.min(g.height - g.sliderHeight, g.sliderTop));
    const onSlider = y >= top && y <= top + g.sliderHeight;
    let start = s.scrollTop;
    if (!onSlider) {
      // Jump so the slider centres on the click; keep dragging from there.
      start = scrollToCenterSlider(g, y);
      s.scrollTop = start;
    }
    const startY = e.clientY;
    const el = this.dom;
    el.setPointerCapture(e.pointerId);
    el.classList.add("cm-luma-minimap-dragging");
    const move = (ev: PointerEvent) => {
      s.scrollTop = scrollAfterDrag(g, start, ev.clientY - startY);
    };
    const up = () => {
      el.classList.remove("cm-luma-minimap-dragging");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  private onResizeDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    this.dragging = true;
    this.dom.classList.add("cm-luma-minimap-resizing");
    const startX = e.clientX;
    const startW = this.width;
    let frame = 0;
    let next = startW;
    const move = (ev: PointerEvent) => {
      next = clampMinimapWidth(startW + startX - ev.clientX);
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          for (const m of instances) m.setLiveWidth(next);
        });
    };
    const up = () => {
      cancelAnimationFrame(frame);
      for (const m of instances) m.setLiveWidth(next);
      this.dragging = false;
      this.dom.classList.remove("cm-luma-minimap-resizing");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      if (next !== startW) persistWidth(next);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  private onResetWidth = (e: MouseEvent) => {
    e.preventDefault();
    for (const m of instances) m.setLiveWidth(MINIMAP_WIDTH.initial);
    persistWidth(MINIMAP_WIDTH.initial);
  };

  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(this.view, e);
  };

  destroy() {
    instances.delete(this);
    this.unwatch();
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.view.dom.style.removeProperty("--luma-minimap-space");
    this.dom.remove();
  }
}

const minimapTheme = EditorView.baseTheme({
  ".cm-luma-minimap": {
    position: "sticky",
    top: "0",
    right: "0",
    flex: "none",
    alignSelf: "flex-start",
    height: "100%",
    zIndex: "3",
    cursor: "default",
    backgroundColor: "var(--bg-editor, var(--bg-island, var(--bg-app)))",
    overflow: "hidden",
    userSelect: "none",
    touchAction: "none",
  },
  ".cm-luma-minimap-canvas": { position: "absolute", top: "0", left: "0", pointerEvents: "none" },
  ".cm-luma-minimap-slider": {
    position: "absolute",
    top: "0",
    left: "0",
    right: "0",
    willChange: "transform",
    backgroundColor: "color-mix(in srgb, var(--fg) 6%, transparent)",
    boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--fg) 7%, transparent)",
    transition: "background-color 120ms ease",
    pointerEvents: "none",
  },
  ".cm-luma-minimap:hover .cm-luma-minimap-slider": {
    backgroundColor: "color-mix(in srgb, var(--fg) 10%, transparent)",
  },
  ".cm-luma-minimap-dragging .cm-luma-minimap-slider, .cm-luma-minimap-dragging:hover .cm-luma-minimap-slider": {
    backgroundColor: "color-mix(in srgb, var(--fg) 15%, transparent)",
    transition: "none",
  },
  // The left edge: drag to resize, double-click for the default width.
  ".cm-luma-minimap-resize": {
    position: "absolute",
    top: "0",
    bottom: "0",
    left: "0",
    width: "5px",
    cursor: "col-resize",
    zIndex: "1",
  },
  ".cm-luma-minimap-resize::after": {
    content: '""',
    position: "absolute",
    top: "0",
    bottom: "0",
    left: "0",
    width: "1px",
    backgroundColor: "transparent",
    transition: "background-color 120ms ease",
  },
  ".cm-luma-minimap-resize:hover::after, .cm-luma-minimap-resizing .cm-luma-minimap-resize::after": {
    backgroundColor: "var(--accent)",
  },
  ".cm-luma-minimap-probe": { position: "absolute", visibility: "hidden", pointerEvents: "none" },
});

/** The minimap with its settings. */
export function minimap(config: MinimapConfig): Extension {
  return [
    minimapConfig.of({ ...config, width: clampMinimapWidth(config.width) }),
    ViewPlugin.fromClass(Minimap),
    minimapTheme,
  ];
}
