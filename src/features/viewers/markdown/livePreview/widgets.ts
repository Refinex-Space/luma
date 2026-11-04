/**
 * The rendered pieces of the live preview: list bullets, task checkboxes, rules, images, math,
 * Mermaid diagrams, code block headers, callout titles and HTML blocks. Widgets compare by
 * content so unchanged ones keep their DOM while the document is edited.
 */
import { WidgetType, type EditorView } from "@codemirror/view";
import DOMPurify from "dompurify";
import { iconMarkup } from "@/ui/icons";
import { tx } from "@/platform/i18n";
import { renderMathSync, renderMath } from "../math";
import { cachedMermaid, renderMermaid, type MermaidResult } from "../mermaid";
import { openMediaViewer } from "../media/mediaViewer";
import { imageSource } from "./assets";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** A small round button over a rendered block (zoom, copy); clicks never reach the editor. */
function overlayButton(icon: string, title: string, run: (e: MouseEvent) => void): HTMLButtonElement {
  const b = el("button", "cm-md-overlay-button");
  b.type = "button";
  b.title = tx(title);
  b.setAttribute("aria-label", tx(title));
  b.innerHTML = iconMarkup(icon, 14) ?? "";
  b.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    run(e);
  });
  return b;
}

const fromOverlay = (e: Event) => (e.target as Element | null)?.closest?.(".cm-md-overlay-button") != null;

export class BulletWidget extends WidgetType {
  constructor(readonly depth: number) {
    super();
  }
  eq(o: BulletWidget) {
    return o.depth === this.depth;
  }
  toDOM() {
    const s = el("span", "cm-md-bullet");
    s.dataset.depth = String(this.depth % 3);
    s.setAttribute("aria-hidden", "true");
    return s;
  }
  ignoreEvent() {
    return false;
  }
}

/** A task's `[ ]` / `[x]`; clicking toggles it in the source. */
export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const box = el("input", "cm-md-checkbox");
    box.type = "checkbox";
    box.checked = this.checked;
    box.setAttribute("aria-label", tx("Task"));
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(box);
      const text = view.state.sliceDoc(pos, pos + 3);
      if (!/^\[[ xX]\]$/.test(text)) return;
      view.dispatch({
        changes: { from: pos + 1, to: pos + 2, insert: text[1] === " " ? "x" : " " },
        userEvent: "input.toggle",
      });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

export class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    return el("span", "cm-md-hr");
  }
  ignoreEvent() {
    return false;
  }
}

/** A callout's `[!NOTE]`: its icon, and its name unless the line gives its own title. */
export class CalloutTitleWidget extends WidgetType {
  constructor(
    readonly kind: string,
    readonly named: boolean,
  ) {
    super();
  }
  eq(o: CalloutTitleWidget) {
    return o.kind === this.kind && o.named === this.named;
  }
  toDOM() {
    const s = el("span", "cm-md-callout-label");
    s.append(el("span", "cm-md-callout-icon"));
    if (!this.named) s.append(el("span", undefined, tx(CALLOUT_TITLES[this.kind] ?? "Note")));
    return s;
  }
  ignoreEvent() {
    return false;
  }
}

export const CALLOUT_TITLES: Record<string, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};

/** A fence's opening line while the block is not edited: its language and a copy button. */
export class CodeHeaderWidget extends WidgetType {
  constructor(
    readonly lang: string,
    readonly code: string,
    readonly copyable = true,
  ) {
    super();
  }
  eq(o: CodeHeaderWidget) {
    return o.lang === this.lang && o.code === this.code && o.copyable === this.copyable;
  }
  toDOM() {
    const head = el("span", "cm-md-code-header");
    head.append(el("span", "cm-md-code-header-lang", this.lang));
    if (!this.copyable) return head;
    const copy = overlayButton("copy", "Copy Code", () => {
      void navigator.clipboard?.writeText(this.code).then(() => {
        copy.dataset.done = "true";
        copy.title = tx("Copied");
        setTimeout(() => {
          delete copy.dataset.done;
          copy.title = tx("Copy Code");
        }, 1200);
      });
    });
    head.append(copy);
    return head;
  }
  ignoreEvent(e: Event) {
    return fromOverlay(e);
  }
}

/** Shows a rendered block's source when clicked (puts the caret at `pos`). */
function revealOnClick(dom: HTMLElement, view: EditorView, pos: () => number) {
  dom.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || fromOverlay(e)) return;
    e.preventDefault();
    const at = pos();
    view.dispatch({ selection: { anchor: at }, scrollIntoView: false, userEvent: "select.pointer" });
    view.focus();
  });
}

export class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
    /** Offset of the caret in the source when clicked (from the widget's start), or -1 to keep CodeMirror's. */
    readonly caret = -1,
  ) {
    super();
  }
  eq(o: MathWidget) {
    return o.tex === this.tex && o.display === this.display && o.caret === this.caret;
  }
  toDOM(view: EditorView) {
    const dom = el(this.display ? "div" : "span", this.display ? "cm-md-math-block" : "cm-md-math");
    const html = renderMathSync(this.tex, this.display);
    if (html !== null) dom.innerHTML = html;
    else {
      dom.textContent = this.tex;
      dom.classList.add("cm-md-pending");
      void renderMath(this.tex, this.display).then((h) => {
        dom.classList.remove("cm-md-pending");
        dom.innerHTML = h;
        view.requestMeasure();
      });
    }
    if (this.caret >= 0) revealOnClick(dom, view, () => view.posAtDOM(dom) + this.caret);
    return dom;
  }
  ignoreEvent(e: Event) {
    return this.caret >= 0 ? e.type === "mousedown" : false;
  }
  get estimatedHeight() {
    return this.display ? 48 : -1;
  }
}

function showDiagram(dom: HTMLElement, result: MermaidResult, view: EditorView) {
  const body = dom.querySelector<HTMLElement>(".cm-md-diagram-body")!;
  if ("svg" in result) {
    body.innerHTML = result.svg;
    dom.dataset.state = "ok";
  } else {
    body.textContent = result.error;
    dom.dataset.state = "error";
  }
  view.requestMeasure();
}

export class MermaidWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly caret: number,
  ) {
    super();
  }
  eq(o: MermaidWidget) {
    return o.source === this.source && o.caret === this.caret;
  }
  toDOM(view: EditorView) {
    const dom = el("div", "cm-md-diagram");
    dom.append(el("div", "cm-md-diagram-body"));
    dom.append(
      overlayButton("maximize", "View Larger", () => {
        const svg = dom.querySelector(".cm-md-diagram-body > svg");
        if (svg) openMediaViewer({ kind: "svg", svg: svg.outerHTML, name: "Mermaid" });
      }),
    );
    const cached = cachedMermaid(this.source);
    if (cached) showDiagram(dom, cached, view);
    else {
      dom.dataset.state = "pending";
      void renderMermaid(this.source).then((r) => dom.isConnected !== false && showDiagram(dom, r, view));
    }
    if (this.caret >= 0) revealOnClick(dom, view, () => view.posAtDOM(dom) + this.caret);
    return dom;
  }
  ignoreEvent(e: Event) {
    return fromOverlay(e) || e.type === "mousedown";
  }
  get estimatedHeight() {
    return 160;
  }
}

/** An image: `src` resolved against the document `doc`. */
export class ImageWidget extends WidgetType {
  constructor(
    readonly doc: string,
    readonly src: string,
    readonly alt: string,
    readonly title: string,
    /** Alone on its line: shown as a block. */
    readonly block: boolean,
  ) {
    super();
  }
  eq(o: ImageWidget) {
    return (
      o.src === this.src && o.alt === this.alt && o.title === this.title && o.block === this.block && o.doc === this.doc
    );
  }
  toDOM(view: EditorView) {
    const wrap = el("span", this.block ? "cm-md-image cm-md-image-block" : "cm-md-image");
    const img = el("img");
    img.alt = this.alt;
    if (this.title) img.title = this.title;
    img.draggable = false;
    wrap.append(img);
    const source = imageSource(this.doc, this.src);
    const fail = (message: string) => {
      wrap.classList.add("cm-md-image-missing");
      img.remove();
      wrap.append(el("span", "cm-md-image-note", this.alt || message));
      wrap.title = message;
      view.requestMeasure();
    };
    if (source.kind === "url") {
      img.decoding = "async";
      void source.url.then(
        (url) => {
          img.src = url;
          img.addEventListener("load", () => view.requestMeasure(), { once: true });
          wrap.append(
            overlayButton("maximize", "View Larger", () =>
              openMediaViewer({ kind: "image", src: url, name: this.alt || this.src.split("/").pop() || "" }),
            ),
          );
        },
        () => fail(tx("Cannot load the image")),
      );
    } else if (source.kind === "remote") fail(tx("Remote images are not loaded"));
    else fail(tx("Cannot load the image"));
    return wrap;
  }
  ignoreEvent(e: Event) {
    return fromOverlay(e);
  }
  get estimatedHeight() {
    return this.block ? 120 : -1;
  }
}

let purifier: ReturnType<typeof DOMPurify> | null = null;

function sanitize(html: string): string {
  purifier ??= DOMPurify(window);
  return purifier.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "form", "input"] });
}

/** An HTML block rendered (sanitized); images in it load like Markdown images. */
export class HtmlWidget extends WidgetType {
  constructor(
    readonly doc: string,
    readonly html: string,
  ) {
    super();
  }
  eq(o: HtmlWidget) {
    return o.html === this.html && o.doc === this.doc;
  }
  toDOM(view: EditorView) {
    const dom = el("div", "cm-md-html");
    dom.innerHTML = sanitize(this.html);
    for (const img of dom.querySelectorAll("img")) {
      const src = img.getAttribute("src") ?? "";
      img.removeAttribute("src");
      const source = imageSource(this.doc, src);
      if (source.kind === "url")
        void source.url.then(
          (url) => {
            img.src = url;
            img.addEventListener("load", () => view.requestMeasure(), { once: true });
          },
          () => img.classList.add("cm-md-image-missing"),
        );
      else img.classList.add("cm-md-image-missing");
    }
    for (const a of dom.querySelectorAll("a")) a.addEventListener("click", (e) => e.preventDefault());
    revealOnClick(dom, view, () => view.posAtDOM(dom));
    return dom;
  }
  ignoreEvent(e: Event) {
    return e.type === "mousedown";
  }
  get estimatedHeight() {
    return 60;
  }
}
