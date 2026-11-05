import { afterEach, describe, expect, it } from "vitest";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { minimapHidden } from "@/editor/api";
import {
  charColumns,
  clampMinimapWidth,
  minimap,
  minimapGeometry,
  MINIMAP_WIDTH,
  scrollAfterDrag,
  scrollToCenterSlider,
  type MinimapMetrics,
} from "./minimap";

const metrics = (o: Partial<MinimapMetrics> = {}): MinimapMetrics => ({
  docHeight: 20_000,
  scrollTop: 0,
  scrollHeight: 20_008,
  clientHeight: 800,
  docOffset: 4,
  height: 800,
  scale: 3 / 20,
  ...o,
});

describe("minimap geometry", () => {
  it("draws a short document as is: the window never scrolls", () => {
    const g = minimapGeometry(metrics({ docHeight: 2000, scrollHeight: 2008, scrollTop: 600 }));
    expect(g.total).toBe(300);
    expect(g.offset).toBe(0);
    expect(g.sliderTop).toBeCloseTo((600 - 4) * 0.15);
    expect(g.sliderHeight).toBeCloseTo(120);
  });

  it("scrolls a long document's window so the slider stays in view, top to bottom", () => {
    const max = 20_008 - 800;
    const top = minimapGeometry(metrics());
    expect(top.offset).toBe(0);
    const bottom = minimapGeometry(metrics({ scrollTop: max }));
    expect(bottom.offset).toBeCloseTo(bottom.total - 800);
    // The slider covers the visible lines: at the very bottom it ends at the minimap's foot
    // (within the document's 4px padding, scaled).
    expect(Math.abs(bottom.sliderTop + bottom.sliderHeight - 800)).toBeLessThan(1);
  });

  it("puts the slider's middle where the minimap was clicked", () => {
    for (const docHeight of [2000, 20_000, 400_000]) {
      const base = metrics({ docHeight, scrollHeight: docHeight + 8 });
      const g0 = minimapGeometry(base);
      const y = Math.min(500, g0.total - 10);
      const scroll = scrollToCenterSlider(g0, y);
      const g = minimapGeometry({ ...base, scrollTop: scroll });
      // Clamped at the ends; otherwise centred on the click.
      if (scroll > 0 && scroll < base.scrollHeight - base.clientHeight)
        expect(g.sliderTop + g.sliderHeight / 2).toBeCloseTo(y, 1);
    }
  });

  it("moves the slider with the pointer while dragging, and stops at the ends", () => {
    for (const docHeight of [2000, 20_000, 400_000]) {
      const base = metrics({ docHeight, scrollHeight: docHeight + 8, scrollTop: docHeight / 4 });
      const g = minimapGeometry(base);
      const dy = 37;
      const moved = minimapGeometry({ ...base, scrollTop: scrollAfterDrag(g, base.scrollTop, dy) });
      expect(moved.sliderTop - g.sliderTop).toBeCloseTo(dy, 3);
    }
    const g = minimapGeometry(metrics());
    expect(scrollAfterDrag(g, 0, -50)).toBe(0);
    expect(scrollAfterDrag(g, 0, 10_000)).toBe(20_008 - 800);
  });

  it("counts wide characters as two columns, like the editor", () => {
    expect(["a", "中", "가", "（", "😀"].map((c) => charColumns(c.charCodeAt(0)))).toEqual([1, 2, 2, 2, 2]);
    expect(charColumns("😀".charCodeAt(1))).toBe(0);
  });

  it("keeps the width within its limits", () => {
    expect(clampMinimapWidth(10)).toBe(MINIMAP_WIDTH.min);
    expect(clampMinimapWidth(1000)).toBe(MINIMAP_WIDTH.max);
    expect(clampMinimapWidth(Number.NaN)).toBe(MINIMAP_WIDTH.initial);
    expect(clampMinimapWidth(132.6)).toBe(133);
  });
});

describe("minimap view", () => {
  let view: EditorView | null = null;
  afterEach(() => view?.destroy());

  it("sits in the scroller beside the text, leaves room for it, and steps aside when hidden", () => {
    const hide = new Compartment();
    view = new EditorView({
      state: EditorState.create({
        doc: "fun main() {\n  println(1)\n}\n",
        extensions: [minimap({ width: 300, style: "characters", showMarkers: true }), hide.of([])],
      }),
      parent: document.body,
    });
    const el = view.scrollDOM.querySelector<HTMLElement>(":scope > .cm-luma-minimap");
    expect(el).not.toBeNull();
    // Clamped to the maximum width; the room is published for overlays (sticky lines, corner).
    expect(el!.style.width).toBe(`${MINIMAP_WIDTH.max}px`);
    expect(view.dom.style.getPropertyValue("--luma-minimap-space")).toBe(`${MINIMAP_WIDTH.max}px`);

    view.dispatch({ effects: hide.reconfigure(minimapHidden.of(true)) });
    expect(view.scrollDOM.querySelector(".cm-luma-minimap")).toBeNull();
    expect(view.dom.style.getPropertyValue("--luma-minimap-space")).toBe("");

    view.dispatch({ effects: hide.reconfigure([]) });
    expect(view.scrollDOM.querySelector(".cm-luma-minimap")).not.toBeNull();
  });
});
