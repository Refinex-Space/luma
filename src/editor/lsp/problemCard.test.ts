import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setDiagnostics } from "@codemirror/lint";
import type { Diagnostic } from "@/bindings";
import { registerProblemActions } from "@/editor/api";
import { useProject } from "@/platform/project";

const { lspDoc } = await import("./lsp");
const { diagnosticsAt, toLintDiagnostics } = await import("./diagnostics");
const { problemRef, problemText, numberedSnippet } = await import("./problems");
const { renderProblems } = await import("./problemCard");
const { problemItems } = await import("./intentions");

const TEXT = "class A {\n  void f() {\n    int unused = 1;\n  }\n}\n";
const unused: Diagnostic = {
  range: { start: { line: 2, col: 8 }, end: { line: 2, col: 14 } },
  severity: "warning",
  message: 'Remove this unused "unused" local variable.',
  source: "sonarqube",
  code: "java:S1481",
  unnecessary: false,
  deprecated: false,
  server: "sonarlint",
};

let view: EditorView;
beforeEach(() => {
  useProject.setState({ project: { root: "/p", name: "p" } } as never);
  const state = EditorState.create({
    doc: TEXT,
    selection: { anchor: TEXT.indexOf("unused") + 2 },
    extensions: [lspDoc.of({ doc: 1, path: "/p/src/A.java", language: "java", uiMode: "Java", readOnly: false })],
  });
  view = new EditorView({ state, parent: document.body.appendChild(document.createElement("div")) });
  view.dispatch(setDiagnostics(view.state, toLintDiagnostics(view.state.doc, [unused])));
});
afterEach(() => {
  view.destroy();
  document.body.replaceChildren();
});

const at = () => diagnosticsAt(view, TEXT.indexOf("unused") + 2);

describe("a problem as text", () => {
  it("knows its file, range, origin and lines", () => {
    const p = problemRef(view, at()[0]!)!;
    expect(p).toMatchObject({
      rel: "src/A.java",
      fence: "java",
      source: "sonarqube",
      code: "java:S1481",
      server: "sonarlint",
      start: { line: 3, column: 9 },
      end: { line: 3, column: 15 },
      lines: { from: 3, to: 3 },
      snippet: "    int unused = 1;",
    });
    expect(numberedSnippet(p)).toBe("3 |     int unused = 1;");
    expect(problemText(p)).toBe(
      [
        "src/A.java:3:9-15",
        'Warning [sonarqube java:S1481]: Remove this unused "unused" local variable.',
        "",
        "```java",
        "3 |     int unused = 1;",
        "```",
      ].join("\n"),
    );
  });
});

describe("the problem hover card", () => {
  it("offers Copy and ⋮ on each problem, and contributed primary actions in its action row", async () => {
    const fix = vi.fn();
    const off = registerProblemActions((p) => [
      { id: "fix", label: "Fix with Agent", primary: true, run: () => fix(p.code) },
      { id: "ctx", label: "Add to Agent Context", run: vi.fn() },
    ]);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const card = renderProblems(view, at());
    document.body.appendChild(card);
    const copy = card.querySelector<HTMLButtonElement>('button[aria-label="Copy Problem"]')!;
    expect(card.querySelector('button[aria-label="More"]')).not.toBeNull();
    copy.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("src/A.java:3:9-15")));
    await vi.waitFor(() => expect(copy.getAttribute("aria-label")).toBe("Copied"));
    const row = card.querySelector(".cm-lsp-problem-actions")!;
    expect(row.textContent).toContain("More actions…");
    const agent = [...row.querySelectorAll("button")].find((b) => b.textContent === "Fix with Agent")!;
    agent.click();
    expect(fix).toHaveBeenCalledWith("java:S1481");
    // ⌥↵ lists the same actions for the problem at the caret.
    expect(problemItems(view).map((i) => i.label)).toEqual(["Fix with Agent", "Add to Agent Context"]);
    off();
  });
});
