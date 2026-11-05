/**
 * A Markdown table edited in place: each cell is its own small text field showing the cell's
 * rendered Markdown, and its source while focused. Typing rewrites just that cell in the
 * document (one undo step per typing run, through the editor's history). Hovering shows row
 * and column handles with their menus and bars to append a row or column; right-click offers
 * the same. The table re-reads its position from the document on every action, so edits
 * elsewhere never make it write to a stale place.
 */
import { redo, undo } from "@codemirror/commands";
import { Annotation, type ChangeSpec } from "@codemirror/state";
import { WidgetType, type EditorView } from "@codemirror/view";
import DOMPurify from "dompurify";
import { Marked } from "marked";
import { tx } from "@/platform/i18n";
import { showContextMenu, type MenuItem } from "@/ui/Menu";
import { liveState } from "./state";
import {
  alignColumn,
  cellText,
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  parseTable,
  setCell,
  type Align,
  type Change,
  type TableModel,
} from "./tableModel";

/** Marks transactions made by a table's own cell typing. */
export const tableTyping = Annotation.define<boolean>();

const inline = new Marked({ gfm: true, breaks: false });
let purifier: ReturnType<typeof DOMPurify> | null = null;

/** A cell's Markdown as sanitized inline HTML (images shown as their alt text). */
function cellHtml(src: string): string {
  if (!/[*_`~[\]<\\$&]/.test(src)) return "";
  purifier ??= DOMPurify(window);
  const html = inline.parseInline(src.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1"), { async: false }) as string;
  return purifier.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ["img", "style"] });
}

/** Runs `f` once the pointer press in progress ends (after the editor has placed its selection). */
function afterPointerRelease(f: () => void) {
  const done = () => {
    window.removeEventListener("mouseup", done, true);
    window.removeEventListener("blur", done);
    requestAnimationFrame(f);
  };
  window.addEventListener("mouseup", done, true);
  window.addEventListener("blur", done);
}

function renderCell(cell: HTMLElement, raw: string) {
  const html = cellHtml(raw);
  if (html) cell.innerHTML = html;
  else cell.textContent = raw;
  cell.dataset.raw = raw;
}

const controllers = new WeakMap<HTMLElement, TableController>();

class TableController {
  readonly dom: HTMLElement;
  private table!: HTMLTableElement;
  private model: TableModel;
  private composing = false;
  private hover: { row: number; col: number } | null = null;
  private readonly rowHandle: HTMLButtonElement;
  private readonly colHandle: HTMLButtonElement;
  private readonly addRow: HTMLButtonElement;
  private readonly addCol: HTMLButtonElement;

  constructor(
    private readonly view: EditorView,
    source: string,
  ) {
    this.model = parseTable(source, 0)!;
    this.dom = document.createElement("div");
    this.dom.className = "cm-md-table";
    this.rowHandle = this.handle("cm-md-table-row-handle", tx("Row Actions"), () => this.rowMenu());
    this.colHandle = this.handle("cm-md-table-col-handle", tx("Column Actions"), () => this.columnMenu());
    this.addRow = this.handle("cm-md-table-add-row", tx("Add Row"), () =>
      this.apply((t) => insertRow(t, t.rows.length), { row: this.model.rows.length + 1, col: 0 }),
    );
    this.addCol = this.handle("cm-md-table-add-col", tx("Add Column"), () =>
      this.apply((t) => insertColumn(t, t.columns), { row: 0, col: this.model.columns }),
    );
    this.render();
    this.listen();
    controllers.set(this.dom, this);
  }

  private handle(cls: string, label: string, run: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `cm-md-table-handle ${cls}`;
    b.title = label;
    b.setAttribute("aria-label", label);
    b.tabIndex = -1;
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", (e) => {
      e.preventDefault();
      run();
    });
    return b;
  }

  // ---- rendering

  private render() {
    const focus = this.focused();
    const table = document.createElement("table");
    const head = table.createTHead().insertRow();
    this.fillRow(head, 0, "th");
    const body = table.createTBody();
    this.model.rows.forEach((_, i) => this.fillRow(body.insertRow(), i + 1, "td"));
    const scroll = document.createElement("div");
    scroll.className = "cm-md-table-scroll";
    scroll.append(table);
    this.dom.replaceChildren(scroll, this.rowHandle, this.colHandle, this.addRow, this.addCol);
    this.table = table;
    this.hover = null;
    this.dom.dataset.hover = "";
    if (focus) this.focusCell(focus.row, focus.col, "end");
  }

  private fillRow(tr: HTMLTableRowElement, row: number, tag: "th" | "td") {
    const line = row === 0 ? this.model.header : this.model.rows[row - 1]!;
    for (let col = 0; col < this.model.columns; col++) {
      const td = document.createElement(tag);
      const align = this.model.aligns[col];
      if (align) td.style.textAlign = align;
      const cell = document.createElement("div");
      cell.className = "cm-md-cell";
      cell.contentEditable = "plaintext-only";
      cell.spellcheck = false;
      cell.dataset.row = String(row);
      cell.dataset.col = String(col);
      renderCell(cell, cellText(line.segs[col]));
      td.append(cell);
      tr.append(td);
    }
  }

  /** Brings the DOM in line with `source` (after an edit, undo or a change elsewhere). */
  update(source: string) {
    const next = parseTable(source, 0);
    if (!next) return;
    const same = next.columns === this.model.columns && next.rows.length === this.model.rows.length;
    const alignsSame = next.aligns.every((a, i) => a === this.model.aligns[i]);
    this.model = next;
    if (!same || !alignsSame) {
      this.render();
      return;
    }
    for (const cell of this.dom.querySelectorAll<HTMLElement>(".cm-md-cell")) {
      const row = Number(cell.dataset.row);
      const col = Number(cell.dataset.col);
      const line = row === 0 ? next.header : next.rows[row - 1]!;
      const raw = cellText(line.segs[col]);
      if (cell === document.activeElement) {
        if (cell.textContent !== raw && !this.composing) {
          cell.textContent = raw;
          placeCaret(cell, "end");
        }
        cell.dataset.raw = raw;
      } else if (cell.dataset.raw !== raw) renderCell(cell, raw);
    }
  }

  // ---- positions

  /** The table as it is in the document now. */
  private current(): TableModel | null {
    let pos: number;
    try {
      pos = this.view.posAtDOM(this.dom);
    } catch {
      return null;
    }
    const doc = this.view.state.doc;
    if (pos < 0 || pos > doc.length) return null;
    const start = doc.lineAt(pos);
    let end = start;
    while (end.number < doc.lines && /\|/.test(doc.line(end.number + 1).text)) end = doc.line(end.number + 1);
    return parseTable(doc.sliceString(start.from, end.to), start.from);
  }

  /** Applies an edit to the current table, then focuses `focus` (row 0 = header). */
  apply(edit: (t: TableModel) => Change | Change[] | null, focus?: { row: number; col: number }) {
    const t = this.current();
    if (!t) return;
    const change = edit(t);
    if (!change) return;
    this.view.dispatch({ changes: change as ChangeSpec, userEvent: "input.table", scrollIntoView: false });
    if (focus) requestAnimationFrame(() => tableAt(this.view, t.from)?.focusCell(focus.row, focus.col, "all"));
  }

  private commit(cell: HTMLElement) {
    const t = this.current();
    if (!t) return;
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    const text = (cell.textContent ?? "").replace(/ /g, " ");
    if (text === cell.dataset.raw) return;
    const change = setCell(t, row, col, text);
    cell.dataset.raw = text;
    if (change) this.view.dispatch({ changes: change, userEvent: "input.type", annotations: tableTyping.of(true) });
  }

  // ---- focus

  private focused(): { row: number; col: number } | null {
    const a = document.activeElement as HTMLElement | null;
    if (!a || !this.dom.contains(a) || !a.classList.contains("cm-md-cell")) return null;
    return { row: Number(a.dataset.row), col: Number(a.dataset.col) };
  }

  private cell(row: number, col: number): HTMLElement | null {
    return this.dom.querySelector<HTMLElement>(`.cm-md-cell[data-row="${row}"][data-col="${col}"]`);
  }

  focusCell(row: number, col: number, caret: "start" | "end" | "all") {
    const cell = this.cell(row, col);
    if (!cell) return;
    cell.focus({ preventScroll: true });
    cell.scrollIntoView({ block: "nearest", inline: "nearest" });
    placeCaret(cell, caret);
  }

  /** Moves the editor caret out of the table, before or after it. */
  private leave(where: "before" | "after") {
    const t = this.current();
    if (!t) return;
    const doc = this.view.state.doc;
    const first = doc.lineAt(t.from);
    const last = doc.lineAt(t.to);
    let anchor: number;
    if (where === "before") {
      if (first.number === 1) {
        this.view.dispatch({ changes: { from: 0, insert: "\n" }, selection: { anchor: 0 } });
        this.view.focus();
        return;
      }
      anchor = doc.line(first.number - 1).to;
    } else {
      if (last.number === doc.lines) {
        this.view.dispatch({ changes: { from: last.to, insert: "\n" }, selection: { anchor: last.to + 1 } });
        this.view.focus();
        return;
      }
      anchor = doc.line(last.number + 1).from;
    }
    this.view.dispatch({ selection: { anchor }, scrollIntoView: true });
    this.view.focus();
  }

  private move(cell: HTMLElement, dRow: number, dCol: number, caret: "start" | "end" | "all"): boolean {
    let row = Number(cell.dataset.row) + dRow;
    let col = Number(cell.dataset.col) + dCol;
    const rows = this.model.rows.length + 1;
    if (col >= this.model.columns) {
      col = 0;
      row++;
    } else if (col < 0) {
      col = this.model.columns - 1;
      row--;
    }
    if (row < 0) {
      this.leave("before");
      return true;
    }
    if (row >= rows) return false;
    this.focusCell(row, col, caret);
    return true;
  }

  // ---- events

  private listen() {
    const d = this.dom;
    d.addEventListener("input", (e) => {
      const cell = e.target as HTMLElement;
      if (!this.composing && cell.classList.contains("cm-md-cell")) this.commit(cell);
    });
    d.addEventListener("compositionstart", () => (this.composing = true));
    d.addEventListener("compositionend", (e) => {
      this.composing = false;
      this.commit(e.target as HTMLElement);
    });
    d.addEventListener("focusin", (e) => {
      const cell = e.target as HTMLElement;
      if (!cell.classList.contains("cm-md-cell")) return;
      d.dataset.editing = "true";
      // Show the source while editing (only when it differs from what is shown).
      const raw = cell.dataset.raw ?? "";
      if (cell.textContent !== raw || cell.childElementCount) {
        cell.textContent = raw;
        placeCaret(cell, "end");
        // The table's height may have changed behind the editor's back: its height map must
        // follow, or the next click in the text resolves against stale line positions.
        this.view.requestMeasure();
      }
    });
    d.addEventListener("focusout", (e) => {
      const cell = e.target as HTMLElement;
      if (!cell.classList.contains("cm-md-cell")) return;
      delete d.dataset.editing;
      const render = () => {
        // Clicked back into the cell meanwhile: it keeps showing the source.
        if (document.activeElement === cell) return;
        renderCell(cell, cell.dataset.raw ?? "");
        this.view.requestMeasure();
      };
      // A click in the text takes focus from the cell while the editor works out where it landed:
      // re-rendering now would move the text under the pointer between the press and its first
      // selection, turning the click into a selection. Like the reveal, wait for the release.
      if (this.view.state.field(liveState, false)?.selecting) afterPointerRelease(render);
      else render();
    });
    d.addEventListener("keydown", (e) => this.keydown(e));
    d.addEventListener("paste", (e) => {
      const cell = e.target as HTMLElement;
      if (!cell.classList?.contains("cm-md-cell")) return;
      e.preventDefault();
      const text = (e.clipboardData?.getData("text/plain") ?? "").replace(/\r?\n/g, " ");
      document.execCommand("insertText", false, text);
    });
    d.addEventListener("mousemove", (e) => this.hoverAt(e));
    d.addEventListener("mouseleave", () => {
      this.hover = null;
      d.dataset.hover = "";
    });
    d.addEventListener("contextmenu", (e) => {
      const cell = (e.target as Element).closest<HTMLElement>(".cm-md-cell");
      if (!cell) return;
      e.preventDefault();
      e.stopPropagation();
      this.hover = { row: Number(cell.dataset.row), col: Number(cell.dataset.col) };
      showContextMenu(e, this.cellMenu());
    });
  }

  private keydown(e: KeyboardEvent) {
    const cell = e.target as HTMLElement;
    if (!cell.classList.contains("cm-md-cell") || e.isComposing || this.composing) return;
    const mod = e.metaKey || e.ctrlKey;
    const done = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (mod && !e.altKey && (e.key === "z" || e.key === "Z" || e.key === "y")) {
      done();
      if (e.key === "y" || e.shiftKey) redo(this.view);
      else undo(this.view);
      return;
    }
    // Inline formats inside the cell (the editor's own shortcuts would format the document).
    const wrap = mod && !e.altKey ? CELL_FORMATS[`${e.shiftKey ? "Shift+" : ""}${e.key.toLowerCase()}`] : undefined;
    if (wrap) {
      done();
      wrapCellSelection(wrap);
      return;
    }
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    const last = row === this.model.rows.length && col === this.model.columns - 1;
    switch (e.key) {
      case "Tab":
        done();
        if (e.shiftKey) {
          if (row === 0 && col === 0) this.leave("before");
          else this.move(cell, 0, -1, "all");
        } else if (last) this.apply((t) => insertRow(t, t.rows.length), { row: row + 1, col: 0 });
        else this.move(cell, 0, 1, "all");
        return;
      case "Enter":
        done();
        if (mod) this.apply((t) => insertRow(t, row), { row: row + 1, col });
        else if (row === this.model.rows.length) this.leave("after");
        else this.move(cell, 1, 0, "end");
        return;
      case "Escape":
        done();
        this.leave("after");
        return;
      case "ArrowUp":
        if (e.shiftKey || mod) return;
        done();
        if (row === 0) this.leave("before");
        else this.move(cell, -1, 0, "end");
        return;
      case "ArrowDown":
        if (e.shiftKey || mod) return;
        done();
        if (row === this.model.rows.length) this.leave("after");
        else this.move(cell, 1, 0, "end");
        return;
      case "ArrowLeft":
      case "ArrowRight": {
        if (e.shiftKey || mod || e.altKey) return;
        const caret = caretOffset(cell);
        const len = (cell.textContent ?? "").length;
        if (e.key === "ArrowLeft" && caret === 0) {
          done();
          if (row === 0 && col === 0) this.leave("before");
          else this.move(cell, 0, -1, "end");
        } else if (e.key === "ArrowRight" && caret === len) {
          done();
          if (last) this.leave("after");
          else this.move(cell, 0, 1, "start");
        }
        return;
      }
    }
    // Everything else is the cell's own; keep editor shortcuts out of it.
    if (!mod || ["a", "c", "v", "x"].includes(e.key.toLowerCase())) e.stopPropagation();
  }

  // ---- handles and menus

  private hoverAt(e: MouseEvent) {
    const cellEl = (e.target as Element).closest<HTMLElement>("th, td");
    if (!cellEl) return;
    const cell = cellEl.querySelector<HTMLElement>(".cm-md-cell");
    if (!cell) return;
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    if (this.hover?.row === row && this.hover.col === col) return;
    this.hover = { row, col };
    const box = this.dom.getBoundingClientRect();
    const r = cellEl.getBoundingClientRect();
    const tr = (cellEl.parentElement as HTMLElement).getBoundingClientRect();
    const t = this.table.getBoundingClientRect();
    Object.assign(this.rowHandle.style, { top: `${tr.top - box.top}px`, height: `${tr.height}px` });
    Object.assign(this.colHandle.style, {
      left: `${r.left - box.left}px`,
      width: `${r.width}px`,
      top: `${t.top - box.top - 14}px`,
    });
    Object.assign(this.addRow.style, {
      left: `${t.left - box.left}px`,
      width: `${t.width}px`,
      top: `${t.bottom - box.top + 2}px`,
    });
    Object.assign(this.addCol.style, {
      top: `${t.top - box.top}px`,
      height: `${t.height}px`,
      left: `${t.right - box.left + 2}px`,
    });
    this.dom.dataset.hover = [
      "cell",
      row === this.model.rows.length ? "last-row" : "",
      col === this.model.columns - 1 ? "last-col" : "",
    ].join(" ");
  }

  private rowItems(row: number): MenuItem[] {
    const body = row > 0;
    const n = this.model.rows.length;
    return [
      {
        label: "Insert Row Above",
        icon: "md-row-above",
        disabled: !body,
        run: () => this.apply((t) => insertRow(t, row - 1), { row, col: 0 }),
      },
      {
        label: "Insert Row Below",
        icon: "md-row-below",
        run: () => this.apply((t) => insertRow(t, row), { row: row + 1, col: 0 }),
      },
      {
        label: "Move Row Up",
        disabled: row <= 1,
        run: () => this.apply((t) => moveRow(t, row, -1), { row: row - 1, col: 0 }),
      },
      {
        label: "Move Row Down",
        disabled: !body || row >= n,
        run: () => this.apply((t) => moveRow(t, row, 1), { row: row + 1, col: 0 }),
      },
      { kind: "separator" },
      {
        label: "Delete Row",
        icon: "trash",
        danger: true,
        disabled: !body,
        run: () => this.apply((t) => deleteRow(t, row)),
      },
    ];
  }

  private columnItems(col: number): MenuItem[] {
    const align = this.model.aligns[col] ?? null;
    const setAlign = (a: Align) => () => this.apply((t) => alignColumn(t, col, a));
    return [
      {
        label: "Insert Column Left",
        icon: "md-column-left",
        run: () => this.apply((t) => insertColumn(t, col), { row: 0, col }),
      },
      {
        label: "Insert Column Right",
        icon: "md-column-right",
        run: () => this.apply((t) => insertColumn(t, col + 1), { row: 0, col: col + 1 }),
      },
      {
        label: "Move Column Left",
        disabled: col === 0,
        run: () => this.apply((t) => moveColumn(t, col, -1), { row: 0, col: col - 1 }),
      },
      {
        label: "Move Column Right",
        disabled: col >= this.model.columns - 1,
        run: () => this.apply((t) => moveColumn(t, col, 1), { row: 0, col: col + 1 }),
      },
      {
        label: "Alignment",
        icon: `md-align-${align ?? "left"}`,
        submenu: [
          { label: "Align Left", icon: "md-align-left", checked: align === "left", run: setAlign("left") },
          { label: "Align Center", icon: "md-align-center", checked: align === "center", run: setAlign("center") },
          { label: "Align Right", icon: "md-align-right", checked: align === "right", run: setAlign("right") },
          { kind: "separator" },
          { label: "Default", checked: align === null, run: setAlign(null) },
        ],
      },
      { kind: "separator" },
      {
        label: "Delete Column",
        icon: "trash",
        danger: true,
        disabled: this.model.columns <= 1,
        run: () => this.apply((t) => deleteColumn(t, col)),
      },
    ];
  }

  private tableItems(): MenuItem[] {
    return [
      { label: "Edit Table as Source", icon: "md-source-code", run: () => this.editSource() },
      { label: "Delete Table", icon: "trash", danger: true, run: () => this.deleteTable() },
    ];
  }

  private at(el: HTMLElement): { x: number; y: number } {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.bottom + 2 };
  }

  private rowMenu() {
    if (this.hover)
      showContextMenu(this.at(this.rowHandle), [
        ...this.rowItems(this.hover.row),
        { kind: "separator" },
        ...this.tableItems(),
      ]);
  }

  private columnMenu() {
    if (this.hover)
      showContextMenu(this.at(this.colHandle), [
        ...this.columnItems(this.hover.col),
        { kind: "separator" },
        ...this.tableItems(),
      ]);
  }

  private cellMenu(): MenuItem[] {
    const { row, col } = this.hover ?? { row: 0, col: 0 };
    return [
      { label: "Row", icon: "md-row-below", submenu: this.rowItems(row) },
      { label: "Column", icon: "md-column-right", submenu: this.columnItems(col) },
      { kind: "separator" },
      ...this.tableItems(),
    ];
  }

  private editSource() {
    const t = this.current();
    if (!t) return;
    this.view.dispatch({ selection: { anchor: t.header.from + 1 }, scrollIntoView: true });
    this.view.focus();
  }

  private deleteTable() {
    const t = this.current();
    if (!t) return;
    const doc = this.view.state.doc;
    const last = doc.lineAt(t.to);
    const to = last.number < doc.lines ? last.to + 1 : last.to;
    this.view.dispatch({ changes: { from: t.from, to, insert: "" }, userEvent: "delete" });
    this.view.focus();
  }
}

/** Markers typed around the cell selection by the format shortcuts. */
const CELL_FORMATS: Record<string, string> = { b: "**", i: "*", "Shift+x": "~~", e: "`" };

function wrapCellSelection(mark: string) {
  const sel = window.getSelection();
  if (!sel) return;
  const text = sel.toString();
  document.execCommand("insertText", false, `${mark}${text}${mark}`);
  if (!text) for (let i = 0; i < mark.length; i++) sel.modify("move", "backward", "character");
}

function placeCaret(cell: HTMLElement, where: "start" | "end" | "all") {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(cell);
  if (where !== "all") range.collapse(where === "start");
  sel.removeAllRanges();
  sel.addRange(range);
}

function caretOffset(cell: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return -1;
  const range = sel.getRangeAt(0).cloneRange();
  range.selectNodeContents(cell);
  range.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
  return range.toString().length;
}

/** The live table widget whose source starts at `from`, if it is shown. */
export function tableAt(view: EditorView, from: number): TableController | null {
  for (const el of view.contentDOM.querySelectorAll<HTMLElement>(".cm-md-table")) {
    try {
      if (view.posAtDOM(el) === from) return controllers.get(el) ?? null;
    } catch {
      // Not in the document any more.
    }
  }
  return null;
}

export class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(o: TableWidget) {
    return o.source === this.source;
  }
  toDOM(view: EditorView) {
    return new TableController(view, this.source).dom;
  }
  updateDOM(dom: HTMLElement) {
    const c = controllers.get(dom);
    if (!c) return false;
    c.update(this.source);
    return true;
  }
  ignoreEvent() {
    return true;
  }
  get estimatedHeight() {
    return (this.source.split("\n").length - 1) * 34;
  }
}
