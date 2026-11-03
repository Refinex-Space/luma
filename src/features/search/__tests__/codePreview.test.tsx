import { describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { Text } from "@codemirror/state";

vi.mock("../find/preview", () => ({
  loadPreviewText: async () => "fun a() {}\nval order = 1\norder()\n",
  clearPreviewCache: () => {},
}));

const { CodePreview, previewDecorations } = await import("../find/parts");

describe("CodePreview", () => {
  it("marks matches (the current line's as current) and the current line", () => {
    const doc = Text.of(["ab", "order order", "x"]);
    const set = previewDecorations(doc, 1, [
      {
        line: 1,
        ranges: [
          [0, 5],
          [6, 11],
        ],
      },
      { line: 2, ranges: [[0, 9]] },
      { line: 7, ranges: [[0, 1]] },
    ]);
    const out: string[] = [];
    set.between(0, doc.length, (from, to, d) => {
      out.push(`${from}-${to}:${(d.spec as { class: string }).class}`);
    });
    expect(out).toEqual([
      "3-3:cm-activeLine",
      "3-8:cm-lama-findMatch cm-lama-findMatch-current",
      "9-14:cm-lama-findMatch cm-lama-findMatch-current",
      "15-16:cm-lama-findMatch",
    ]);
  });

  it("shows the file read-only in an editor view with the matches highlighted", async () => {
    const { container } = render(<CodePreview path="/p/a.kt" line={1} highlights={[{ line: 1, ranges: [[4, 9]] }]} />);
    await act(() => new Promise((r) => setTimeout(r, 150)));
    expect(container.querySelector(".cm-content")?.textContent).toContain("val order = 1");
    expect(container.querySelector(".cm-content")?.getAttribute("contenteditable")).not.toBe("true");
    expect(container.querySelector(".cm-lama-findMatch")?.textContent).toBe("order");
  });
});
