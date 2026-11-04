import { beforeEach, describe, expect, it } from "vitest";
import { katexLoaded, loadKatex, renderMath, renderMathIn, renderMathSync, resetMathForTests } from "./math";

describe("math", () => {
  beforeEach(() => resetMathForTests());

  it("renders nothing synchronously until KaTeX has loaded", async () => {
    expect(renderMathSync("x^2", false)).toBeNull();
    await loadKatex();
    expect(katexLoaded()).toBe(true);
    const html = renderMathSync("x^2", false)!;
    expect(html).toContain('class="katex"');
    expect(renderMathSync("x^2", true)).toContain("katex-display");
    // Cached: the same string again.
    expect(renderMathSync("x^2", false)).toBe(html);
  });

  it("shows invalid TeX as its source with the error as a tooltip", async () => {
    const html = await renderMath("\\frac{1", false);
    const el = document.createElement("div");
    el.innerHTML = html;
    const error = el.querySelector(".math-error")!;
    expect(error.textContent).toBe("\\frac{1");
    expect(error.getAttribute("title")).toMatch(/KaTeX parse error/);
  });

  it("typesets placeholders once, after loading", async () => {
    const root = document.createElement("div");
    root.innerHTML = '<span data-math="inline">a+b</span><div data-math="display">c</div>';
    document.body.append(root);
    const pending = renderMathIn(root);
    expect(pending).toBeInstanceOf(Promise);
    await pending;
    const [inline, display] = [...root.querySelectorAll<HTMLElement>("[data-math]")];
    expect(inline!.dataset.mathState).toBe("done");
    expect(inline!.querySelector(".katex")).not.toBeNull();
    expect(display!.querySelector(".katex-display")).not.toBeNull();
    expect(renderMathIn(root)).toBeNull();
    root.remove();
  });
});
