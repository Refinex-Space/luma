import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const presentation = vi.hoisted(() => vi.fn((_path: string) => ({ icon: "class", runnable: false })));
vi.mock("./filePresentation", () => ({ useFilePresentation: presentation }));

const { FileIcon } = await import("./FileIcon");

describe("FileIcon", () => {
  it("draws a repository-relative path as the Project view draws the file on disk", () => {
    render(<FileIcon path="src/main/java/App.java" root="/work/repo/" />);
    expect(presentation).toHaveBeenLastCalledWith("/work/repo/src/main/java/App.java");
  });

  it("keeps absolute paths, and relative ones without a root", () => {
    render(<FileIcon path="/work/repo/App.java" root="/elsewhere" />);
    expect(presentation).toHaveBeenLastCalledWith("/work/repo/App.java");
    render(<FileIcon path={"C:\\repo\\App.java"} root="/elsewhere" />);
    expect(presentation).toHaveBeenLastCalledWith("C:\\repo\\App.java");
    render(<FileIcon path="App.java" />);
    expect(presentation).toHaveBeenLastCalledWith("App.java");
  });
});
