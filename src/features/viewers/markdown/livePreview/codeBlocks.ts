/**
 * Code blocks in the live preview (marklyra's model): the fences are never shown. The code
 * sits in a card; its footer holds the language field (bottom right, with suggestions) and a
 * copy button. Diagram and math blocks being edited look the same, their rendering below.
 * The hidden fence lines are atomic, so the caret moves from the line above straight into the
 * code; Backspace and Delete at the code's edges never merge it with a fence, and typing a
 * fence and Enter closes the block at once.
 */
import { syntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Prec, type EditorState } from "@codemirror/state";
import { EditorView, keymap, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { tx } from "@/platform/i18n";
import { iconMarkup } from "@/ui/icons";
import { isLive } from "./state";

/** How a fenced block (or a `$$` block) lies in the document. */
export interface FenceShape {
  /** Opening and closing fence lines. */
  open: { from: number; to: number };
  close: { from: number; to: number };
  /** Where the info string goes (after the fence marks) and what it is now. */
  infoFrom: number;
  infoTo: number;
  lang: string;
}

/** The shape of a fenced code block whose fences can hide: closed, with a line of code between. */
export function fenceShape(state: EditorState, node: SyntaxNode): FenceShape | null {
  const doc = state.doc;
  const open = doc.lineAt(node.from);
  const close = doc.lineAt(node.to);
  if (close.number < open.number + 2) return null;
  if (node.name === "BlockMath") {
    if (open.text.trim() !== "$$" || close.text.trim() !== "$$") return null;
    return { open, close, infoFrom: -1, infoTo: -1, lang: "LaTeX" };
  }
  const marks = node.getChildren("CodeMark");
  if (marks.length < 2 || marks[1]!.from < close.from) return null;
  const info = node.getChild("CodeInfo");
  const lang = info ? state.sliceDoc(info.from, info.to).trim() : "";
  return {
    open,
    close,
    infoFrom: info ? info.from : marks[0]!.to,
    infoTo: info ? info.to : marks[0]!.to,
    lang,
  };
}

/** The code block (fenced or `$$`) around `pos`. */
function blockAt(state: EditorState, pos: number): SyntaxNode | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent)
    if (n.name === "FencedCode" || n.name === "BlockMath") return n;
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent)
    if (n.name === "FencedCode" || n.name === "BlockMath") return n;
  return null;
}

/** The card's top edge (in place of the opening fence). */
export class CodeTopWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const d = document.createElement("div");
    d.className = "cm-md-code-top";
    d.setAttribute("aria-hidden", "true");
    return d;
  }
  ignoreEvent() {
    return false;
  }
}

const LANGUAGE_NAMES: string[] = (() => {
  const seen = new Set<string>();
  const out: string[] = [];
  // Common ones first: what people write most in notes and READMEs.
  for (const n of [
    "java",
    "bash",
    "shell",
    "javascript",
    "typescript",
    "python",
    "json",
    "yaml",
    "sql",
    "xml",
    "html",
    "css",
    "go",
    "rust",
    "kotlin",
    "c",
    "cpp",
    "csharp",
    "markdown",
    "mermaid",
    "diff",
    "dockerfile",
    "properties",
    "text",
  ]) {
    seen.add(n);
    out.push(n);
  }
  for (const l of languages)
    for (const n of [l.name, ...l.alias].map((s) => s.toLowerCase()))
      if (!seen.has(n) && !/\s/.test(n)) {
        seen.add(n);
        out.push(n);
      }
  return out;
})();

/** Language suggestions for what was typed: prefix matches first, then substrings. */
export function languageSuggestions(query: string, max = 8): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return LANGUAGE_NAMES.slice(0, max);
  const starts = LANGUAGE_NAMES.filter((n) => n.startsWith(q));
  const contains = LANGUAGE_NAMES.filter((n) => !n.startsWith(q) && n.includes(q));
  return [...starts, ...contains].slice(0, max);
}

/** The card's bottom edge (in place of the closing fence): the language field and copy. */
export class CodeFooterWidget extends WidgetType {
  constructor(
    readonly lang: string,
    /** The language can be changed (a code fence, not a `$$` block). */
    readonly editable: boolean,
  ) {
    super();
  }
  eq(o: CodeFooterWidget) {
    return o.lang === this.lang && o.editable === this.editable;
  }
  toDOM(view: EditorView) {
    const foot = document.createElement("div");
    foot.className = "cm-md-code-footer";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "cm-md-code-action";
    copy.title = tx("Copy Code");
    copy.setAttribute("aria-label", tx("Copy Code"));
    copy.innerHTML = iconMarkup("copy", 14) ?? "";
    copy.addEventListener("mousedown", (e) => e.preventDefault());
    copy.addEventListener("click", () => {
      const node = this.node(view, foot);
      const text = node?.getChild("CodeText");
      let code = text ? view.state.sliceDoc(text.from, text.to) : "";
      if (node?.name === "BlockMath") {
        const shape = fenceShape(view.state, node);
        if (shape) code = view.state.sliceDoc(shape.open.to + 1, shape.close.from - 1);
      }
      void navigator.clipboard?.writeText(code.replace(/\n$/, "")).then(() => {
        copy.dataset.done = "true";
        copy.innerHTML = iconMarkup("check", 14) ?? "";
        setTimeout(() => {
          delete copy.dataset.done;
          copy.innerHTML = iconMarkup("copy", 14) ?? "";
        }, 1200);
      });
    });
    if (!this.editable) {
      const label = document.createElement("span");
      label.className = "cm-md-code-lang-label";
      label.textContent = this.lang;
      foot.append(label, copy);
      return foot;
    }
    foot.append(this.languageField(view, foot), copy);
    return foot;
  }

  private node(view: EditorView, dom: HTMLElement): SyntaxNode | null {
    try {
      return blockAt(view.state, view.posAtDOM(dom));
    } catch {
      return null;
    }
  }

  private languageField(view: EditorView, foot: HTMLElement): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-md-code-lang";
    const input = document.createElement("input");
    input.className = "cm-md-code-lang-input";
    input.value = this.lang;
    input.placeholder = tx("Language");
    input.spellcheck = false;
    input.setAttribute("aria-label", tx("Code Language"));
    const list = document.createElement("div");
    list.className = "cm-md-code-lang-list";
    list.setAttribute("role", "listbox");
    wrap.append(input, list);
    let active = -1;
    let items: string[] = [];
    const size = () =>
      (input.style.width = `calc(${Math.max(4, input.value.length || input.placeholder.length) + 1}ch + 14px)`);
    size();
    const render = () => {
      items = languageSuggestions(input.value);
      list.replaceChildren(
        ...items.map((name, i) => {
          const o = document.createElement("div");
          o.className = "cm-md-code-lang-option";
          o.setAttribute("role", "option");
          o.setAttribute("aria-selected", String(i === active));
          o.textContent = name;
          o.addEventListener("mousedown", (e) => {
            e.preventDefault();
            input.value = name;
            commit(true);
          });
          return o;
        }),
      );
      wrap.dataset.open = items.length ? "true" : "";
    };
    const close = () => {
      wrap.dataset.open = "";
      active = -1;
    };
    const commit = (backToCode: boolean) => {
      close();
      const value = input.value.trim().replace(/\s+/g, "");
      const node = this.node(view, foot);
      const shape = node && fenceShape(view.state, node);
      if (!shape || value === shape.lang) {
        if (backToCode && shape) focusCode(view, shape);
        return;
      }
      view.dispatch({
        changes: { from: shape.infoFrom, to: shape.infoTo, insert: value },
        userEvent: "input.language",
      });
      if (backToCode) {
        const updated = blockAt(view.state, shape.open.from + 1);
        const s = updated && fenceShape(view.state, updated);
        if (s) focusCode(view, s);
      }
    };
    input.addEventListener("focus", () => {
      input.select();
      render();
    });
    input.addEventListener("input", () => {
      active = 0;
      size();
      render();
    });
    input.addEventListener("blur", () => commit(false));
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!items.length) return;
        active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        render();
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (active >= 0 && items[active]) input.value = items[active]!;
        commit(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        input.value = this.lang;
        commit(true);
      }
    });
    for (const t of ["mousedown", "click"] as const) input.addEventListener(t, (e) => e.stopPropagation());
    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}

/** Puts the caret at the end of the block's code. */
function focusCode(view: EditorView, shape: FenceShape) {
  view.dispatch({ selection: { anchor: shape.close.from - 1 }, scrollIntoView: true });
  view.focus();
}

/** Typing a fence and Enter opens a closed block; Backspace / Delete at the code's edge stay inside it. */
export const codeBlockKeys = Prec.high(
  keymap.of([
    {
      key: "Enter",
      run(view) {
        if (!isLive(view.state)) return false;
        const { state } = view;
        const sel = state.selection.main;
        if (!sel.empty) return false;
        const line = state.doc.lineAt(sel.head);
        const m = /^(\s*)(`{3,}|~{3,})([^`\s]*)\s*$/.exec(line.text);
        if (!m || sel.head !== line.to) return false;
        const node = blockAt(state, line.from + m[1]!.length + 1);
        // Already closed (this is a closing fence, or a block being edited): Enter as usual.
        if (node && node.getChildren("CodeMark").length > 1) return false;
        const indent = m[1]!;
        view.dispatch({
          changes: { from: line.to, insert: `\n${indent}\n${indent}${m[2]}` },
          selection: { anchor: line.to + 1 + indent.length },
          userEvent: "input",
          scrollIntoView: true,
        });
        return true;
      },
    },
    {
      key: "Backspace",
      run(view) {
        if (!isLive(view.state)) return false;
        const { state } = view;
        const sel = state.selection.main;
        if (!sel.empty) return false;
        const line = state.doc.lineAt(sel.head);
        if (sel.head !== line.from) return false;
        // At the code's first line: an empty block goes away, otherwise nothing joins the fence.
        const inner = blockAt(state, sel.head);
        const shape = inner && fenceShape(state, inner);
        if (shape && line.number === state.doc.lineAt(shape.open.to).number + 1) {
          if (shape.close.from - 1 === line.to && !line.text.trim())
            view.dispatch({ changes: { from: shape.open.from, to: shape.close.to }, userEvent: "delete" });
          return true;
        }
        // Just below a card: an empty line goes, otherwise the caret steps into the code.
        if (line.number > 1) {
          const above = blockAt(state, line.from - 1);
          const prev = above && fenceShape(state, above);
          if (prev && prev.close.to === line.from - 1) {
            if (!line.text.trim())
              view.dispatch({ changes: { from: line.from - 1, to: line.to }, userEvent: "delete" });
            else view.dispatch({ selection: { anchor: prev.close.from - 1 }, scrollIntoView: true });
            return true;
          }
        }
        return false;
      },
    },
    {
      key: "Delete",
      run(view) {
        if (!isLive(view.state)) return false;
        const { state } = view;
        const sel = state.selection.main;
        if (!sel.empty) return false;
        const line = state.doc.lineAt(sel.head);
        if (sel.head !== line.to) return false;
        const inner = blockAt(state, sel.head);
        const shape = inner && fenceShape(state, inner);
        if (shape && line.to === shape.close.from - 1) return true;
        // Just above a card: an empty line goes, otherwise the caret steps into the code.
        if (line.number < state.doc.lines) {
          const below = blockAt(state, line.to + 2);
          const next = below && fenceShape(state, below);
          if (next && next.open.from === line.to + 1) {
            if (!line.text.trim())
              view.dispatch({ changes: { from: line.from, to: line.to + 1 }, userEvent: "delete" });
            else view.dispatch({ selection: { anchor: next.open.to + 1 }, scrollIntoView: true });
            return true;
          }
        }
        return false;
      },
    },
  ]),
);
