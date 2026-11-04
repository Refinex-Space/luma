import { describe, expect, it } from "vitest";
import { activeHeading, markdownHeadings, plainHeading } from "./outline";

describe("outline", () => {
  it("lists ATX and setext headings, skipping code and front matter", () => {
    const doc = [
      "---",
      "title: x",
      "---",
      "# Top",
      "",
      "```",
      "# not a heading",
      "```",
      "Sub",
      "---",
      "",
      "### **Bold** `code` [link](u) ##",
    ].join("\n");
    expect(markdownHeadings(doc)).toEqual([
      { level: 1, text: "Top", line: 3 },
      { level: 2, text: "Sub", line: 8 },
      { level: 3, text: "Bold code link", line: 11 },
    ]);
    expect(plainHeading("a \\* b")).toBe("a * b");
  });

  it("marks the last heading at or above the reading line", () => {
    const hs = markdownHeadings("# A\n\ntext\n\n## B\n\nmore");
    expect(activeHeading(hs, 0)).toBe(0);
    expect(activeHeading(hs, 3)).toBe(0);
    expect(activeHeading(hs, 4)).toBe(1);
    expect(activeHeading(markdownHeadings("text\n# A"), 0)).toBe(-1);
  });
});
