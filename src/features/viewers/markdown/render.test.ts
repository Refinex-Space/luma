import { describe, expect, it } from "vitest";
import { joinPath, previewOffsetForLine, renderMarkdown, resolveLink, slugify, toggleTaskSource } from "./render";

function dom(md: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdown(md);
  return root;
}

describe("markdown preview rendering", () => {
  it("tags blocks with their source line", () => {
    const html = renderMarkdown("# Title\n\nPara one\nstill one\n\n- a\n- b\n");
    const root = document.createElement("div");
    root.innerHTML = html;
    const lines = [...root.querySelectorAll<HTMLElement>(":scope > [data-line]")].map((e) => [
      e.dataset.line,
      e.firstElementChild?.tagName,
    ]);
    expect(lines).toEqual([
      ["0", "H1"],
      ["2", "P"],
      ["5", "UL"],
    ]);
    expect(root.querySelector("h1")?.id).toBe("user-content-title");
  });

  it("sanitizes and defers image loading", () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown(
      '<script>alert(1)</script>\n\n![x](img/a.png) <a href="javascript:alert(1)">j</a>\n',
    );
    expect(root.querySelector("script")).toBeNull();
    const img = root.querySelector("img")!;
    expect(img.getAttribute("src")).toBeNull();
    expect(img.dataset.src).toBe("img/a.png");
    expect(root.querySelector("a")?.getAttribute("href")).toBeNull();
  });

  it("dedupes heading anchors", () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown("## Same\n\n## Same\n");
    expect([...root.querySelectorAll("h2")].map((h) => h.id)).toEqual(["user-content-same", "user-content-same-1"]);
    expect(slugify("Hello, World! v2")).toBe("hello-world-v2");
  });

  it("resolves links against the file", () => {
    const file = "/repo/docs/guide.md";
    expect(resolveLink(file, "https://x.dev")).toEqual({ kind: "external", url: "https://x.dev" });
    expect(resolveLink(file, "#setup")).toEqual({ kind: "anchor", id: "setup" });
    expect(resolveLink(file, "../src/main.rs#L12")).toEqual({ kind: "file", path: "/repo/src/main.rs", line: 11 });
    expect(resolveLink(file, "other%20file.md#intro")).toEqual({
      kind: "file",
      path: "/repo/docs/other file.md",
      anchor: "intro",
    });
    expect(resolveLink(file, "javascript:alert(1)")).toBeNull();
    expect(joinPath("C:/repo/docs", "../a.md")).toBe("C:/repo/a.md");
    expect(joinPath("/repo", "../../a.md")).toBe("/a.md");
  });

  it("interpolates the preview offset between blocks", () => {
    const blocks = [
      { line: 0, top: 0 },
      { line: 10, top: 100 },
    ];
    expect(previewOffsetForLine(blocks, 5, 400)).toBe(50);
    expect(previewOffsetForLine(blocks, 10, 400)).toBe(100);
    expect(previewOffsetForLine(blocks, 10.5, 400)).toBe(250);
    expect(previewOffsetForLine([], 3, 400)).toBe(0);
  });

  it("emits math placeholders for $…$, $$…$$ and math fences, leaving prices alone", () => {
    const root = dom(
      "Euler $e^{i\\pi}+1=0$ costs $5 and $10, not $ x$.\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n$$a^2$$\n\n```math\nb^2\n```\n\n\\$escaped$\n",
    );
    const math = [...root.querySelectorAll<HTMLElement>("[data-math]")].map((e) => [e.dataset.math, e.textContent]);
    expect(math).toEqual([
      ["inline", "e^{i\\pi}+1=0"],
      ["display", "\\int_0^1 x\\,dx"],
      ["display", "a^2"],
      ["display", "b^2"],
    ]);
    expect(root.textContent).toContain("costs $5 and $10, not $ x$.");
    expect(root.textContent).toContain("$escaped$");
    // Display blocks keep the source lines of what follows.
    const lines = [...root.querySelectorAll<HTMLElement>(":scope > [data-line]")].map((e) => e.dataset.line);
    expect(lines).toEqual(["0", "2", "6", "8", "12"]);
  });

  it("renders GitHub alerts as titled callouts", () => {
    const root = dom("> [!WARNING]\n> Mind the **gap**.\n\n> [!tip] Pro move\n> Do it.\n\n> plain quote\n");
    const [warning, tip] = [...root.querySelectorAll<HTMLElement>(".callout")];
    expect(warning!.className).toBe("callout callout-warning");
    expect(warning!.querySelector(".callout-title")!.textContent).toBe("Warning");
    expect(warning!.querySelector("strong")!.textContent).toBe("gap");
    expect(tip!.querySelector(".callout-title")!.textContent).toBe("Pro move");
    expect(root.querySelectorAll("blockquote")).toHaveLength(1);
  });

  it("numbers footnotes by first reference and links both ways", () => {
    const root = dom("One[^b] two[^a] again[^b] none[^zz].\n\n[^a]: Alpha.\n[^b]: Beta\n    continued.\n");
    const refs = [...root.querySelectorAll(".footnote-ref a")].map((a) => [
      a.textContent,
      a.getAttribute("href"),
      a.id,
    ]);
    expect(refs).toEqual([
      ["1", "#fn-b", "user-content-fnref-b"],
      ["2", "#fn-a", "user-content-fnref-a"],
      ["1", "#fn-b", "user-content-fnref-b-2"],
    ]);
    expect(root.textContent).toContain("none[^zz]");
    const items = [...root.querySelectorAll(".footnotes li")];
    expect(items.map((li) => li.id)).toEqual(["user-content-fn-b", "user-content-fn-a"]);
    expect(items[0]!.textContent).toContain("Beta\ncontinued.");
    expect(items[0]!.querySelector(".footnote-backref")!.getAttribute("href")).toBe("#fnref-b");
    // Definitions are not shown where they are written.
    expect(root.querySelectorAll(":scope > [data-line]")).toHaveLength(1);
  });

  it("tags task items with their source line and toggles them in the source", () => {
    const root = dom(
      "# Todo\n\n- [ ] one\n- [x] two\n  - [ ] nested\n\n```md\n- [ ] not a task\n```\n\n> - [X] quoted\n",
    );
    const tasks = [...root.querySelectorAll<HTMLElement>("[data-task-line]")].map((li) => [
      li.dataset.taskLine,
      li.querySelector<HTMLInputElement>(":scope input.task-checkbox, :scope > p > input")!.checked,
    ]);
    expect(tasks).toEqual([
      ["2", false],
      ["3", true],
      ["4", false],
      ["10", true],
    ]);
    expect(root.querySelector("ul")!.classList.contains("contains-task-list")).toBe(true);
    expect(root.querySelector("input.task-checkbox")!.hasAttribute("disabled")).toBe(false);
    expect(toggleTaskSource("  - [ ] nested")).toEqual({ at: 5, mark: "x" });
    expect(toggleTaskSource("> 1. [X] quoted")).toEqual({ at: 6, mark: " " });
    expect(toggleTaskSource("- [ ]x")).toBeNull();
    expect(toggleTaskSource("plain")).toBeNull();
  });

  it("shows front matter as a table and keeps the following lines", () => {
    const root = dom('---\ntitle: "Hello"\ntags:\n  - a\n  - b\n---\n\n# Body\n');
    const rows = [...root.querySelectorAll("table.front-matter tr")].map((tr) => [
      tr.querySelector("th")!.textContent,
      tr.querySelector("td")!.innerHTML,
    ]);
    expect(rows).toEqual([
      ["title", "Hello"],
      ["tags", "- a<br>- b"],
    ]);
    expect(root.querySelector("hr")).toBeNull();
    expect(root.querySelector("h1")!.closest<HTMLElement>("[data-line]")!.dataset.line).toBe("7");
  });

  it("labels code blocks and links headings to themselves", () => {
    const root = dom("## Setup\n\n```ts\nlet a = 1;\n```\n");
    expect(root.querySelector(".code-block > .code-lang")!.textContent).toBe("ts");
    expect(root.querySelector(".code-block > pre > code.language-ts")!.textContent).toBe("let a = 1;");
    const anchor = root.querySelector("h2 > a.heading-anchor")!;
    expect(anchor.getAttribute("href")).toBe("#setup");
    expect(root.querySelector("h2")!.textContent).toBe("Setup");
  });
});
