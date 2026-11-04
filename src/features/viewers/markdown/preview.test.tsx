import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { _addEditor, _removeEditor, type EditorDocContext } from "@/editor/api";

const viewer = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("./media/mediaViewer", () => ({ openMediaViewer: viewer.open }));
const clipboard = vi.hoisted(() => ({ copy: vi.fn(async () => {}) }));
vi.mock("@/ui", async (importOriginal) => ({ ...(await importOriginal<object>()), copyText: clipboard.copy }));

const { useLiveMarkdown } = await import("./live");
const { MarkdownEditor } = await import("./MarkdownEditor");
const { useMarkdownModes } = await import("./modes");

const PATH = "/p/notes.md";
const ctx: EditorDocContext = { doc: 1, path: PATH, language: "markdown", uiMode: null, readOnly: false };

function open(doc: string) {
  const view = new EditorView({ state: EditorState.create({ doc }) });
  const handle = { view, ctx };
  _addEditor(handle);
  act(() => {
    useLiveMarkdown.setState({ [PATH]: { text: doc, topLine: 0, scrollSeq: 0, fontZoom: 0 } });
    useMarkdownModes.setState((s) => ({ byPath: { ...s.byPath, [PATH]: "preview" } }));
  });
  render(
    <MarkdownEditor path={PATH} tabId="t">
      <div />
    </MarkdownEditor>,
  );
  return {
    view,
    preview: screen.getByRole("document", { name: "Markdown preview" }),
    close: () => {
      _removeEditor(handle);
      view.destroy();
    },
  };
}

describe("the Markdown preview", () => {
  const closers: Array<() => void> = [];
  afterEach(() => {
    cleanup();
    closers.splice(0).forEach((c) => c());
    useLiveMarkdown.setState({}, true);
    viewer.open.mockClear();
  });

  it("toggles a task item in the editor's source", () => {
    const { view, preview, close } = open("# Todo\n\n- [ ] write\n- [x] test\n");
    closers.push(close);
    const boxes = preview.querySelectorAll<HTMLInputElement>("input.task-checkbox");
    fireEvent.click(boxes[0]!);
    expect(view.state.doc.line(3).text).toBe("- [x] write");
    fireEvent.click(boxes[1]!);
    expect(view.state.doc.line(4).text).toBe("- [ ] test");
  });

  it("copies a code block and shows it was copied", async () => {
    const { preview, close } = open("```js\nlet a = 1;\n```\n");
    closers.push(close);
    const copy = preview.querySelector<HTMLButtonElement>(".code-block > button.code-copy")!;
    expect(copy.getAttribute("aria-label")).toBe("Copy");
    await act(async () => fireEvent.click(copy));
    expect(clipboard.copy).toHaveBeenCalledWith("let a = 1;");
    expect(copy.hasAttribute("data-copied")).toBe(true);
  });

  it("opens a loaded image in the viewer, but follows a linked one", () => {
    const { preview, close } = open(
      "![Logo](data:image/png;base64,AAAA)\n\n[![Badge](data:image/png;base64,BBBB)](#top)\n",
    );
    closers.push(close);
    const [logo, badge] = [...preview.querySelectorAll("img")];
    fireEvent.click(logo!);
    expect(viewer.open).toHaveBeenCalledWith({ kind: "image", src: "data:image/png;base64,AAAA", name: "Logo" });
    fireEvent.click(badge!);
    expect(viewer.open).toHaveBeenCalledTimes(1);
  });
});
