import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { cleanSvg } from "./cleanSvg";
import { closeMediaViewer, disposeMediaViewer, isMediaViewerOpen, openMediaViewer } from "./mediaViewer";

afterEach(() => {
  act(() => disposeMediaViewer());
  vi.useRealTimers();
});

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("the media viewer", () => {
  it("opens an item as a modal dialog, replaces it with the next, and closes once", () => {
    const first = vi.fn();
    const second = vi.fn();
    act(() => openMediaViewer({ kind: "image", src: PNG, name: "shot.png" }, { onClose: first }));
    expect(isMediaViewerOpen()).toBe(true);
    const dialog = screen.getByRole("dialog", { name: "Image Preview" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("shot.png")).toBeTruthy();

    act(() => openMediaViewer({ kind: "image", src: PNG, name: "other.png" }, { onClose: second }));
    expect(first).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("shot.png")).toBeNull();
    expect(screen.getByText("other.png")).toBeTruthy();

    act(() => closeMediaViewer());
    act(() => closeMediaViewer());
    expect(second).toHaveBeenCalledTimes(1);
    expect(isMediaViewerOpen()).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape and gives focus back", () => {
    vi.useFakeTimers();
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    act(() => openMediaViewer({ kind: "image", src: PNG, name: "a.png" }));
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    act(() => void vi.runAllTimers());
    expect(isMediaViewerOpen()).toBe(false);
    expect(document.activeElement).toBe(button);
    button.remove();
  });

  it("shows a diagram on a card, labelled as a diagram", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="10" height="10"/></svg>`;
    act(() => openMediaViewer({ kind: "svg", svg, name: "flowchart" }));
    const dialog = screen.getByRole("dialog", { name: "Diagram Preview" });
    expect(dialog.querySelector("svg rect")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fit to Width" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rotate" })).toBeTruthy();
  });
});

describe("cleanSvg", () => {
  it("removes scripts, handlers and external references, and keeps its own #refs apart from the original", () => {
    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" id="m1" width="300" style="max-width: 300px" viewBox="0 0 300 150">`,
      `<style>@import url(https://x.test/a.css); #m1 .node { fill: red; } .bg { background: url(https://x.test/i.png) }</style>`,
      `<defs><marker id="m1-arrow"><path d="M0 0"/></marker></defs>`,
      `<script>alert(1)</script>`,
      `<path onclick="alert(2)" marker-end="url(#m1-arrow)" d="M0 0L10 10"/>`,
      `<a href="https://evil.test"><text>x</text></a>`,
      `<image xlink:href="https://x.test/p.png"/>`,
      `<use href="#m1-arrow"/>`,
      `</svg>`,
    ].join("");
    const out = cleanSvg(svg, "t")!;
    expect(out.width).toBe(300);
    expect(out.height).toBe(150);
    expect(out.markup).not.toMatch(/script|onclick|evil\.test|x\.test|@import/);
    expect(out.markup).toContain('id="m1-t"');
    expect(out.markup).toContain('id="m1-arrow-t"');
    expect(out.markup).toContain("url(#m1-arrow-t)");
    expect(out.markup).toContain('href="#m1-arrow-t"');
    expect(out.markup).toContain("#m1-t .node");
    expect(out.markup).not.toContain("max-width");
  });

  it("reads a diagram copied out of the page, its HTML labels included", () => {
    // `outerHTML` of Mermaid output: HTML-serialized, so not well-formed XML.
    const svg =
      '<svg id="m1" viewBox="0 0 200 100"><g><foreignObject width="80" height="20"><div><span>Docs<br>A&nbsp;B</span></div></foreignObject></g></svg>';
    const out = cleanSvg(svg, "t")!;
    expect(out).not.toBeNull();
    expect(out.width).toBe(200);
    expect(out.markup).toContain("Docs");
    expect(out.markup).toContain('id="m1-t"');
  });

  it("rejects what is not an SVG", () => {
    expect(cleanSvg("<div>no</div>", "t")).toBeNull();
    expect(cleanSvg("<svg", "t")).toBeNull();
  });
});
