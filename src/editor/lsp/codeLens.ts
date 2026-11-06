/**
 * "N usages" code lenses above declarations (IDEA's usages inlay), and before them
 * the AI actions menu of methods and functions (`registerDeclarationActions`). Cheap by
 * construction: only declarations in (and near) the viewport are counted, one
 * debounced pass after edits / scrolling, results cached per document text
 * and symbol, and at most a few reference requests in flight. Beside each
 * count, the declaration's last author from VCS blame (`authorLens`).
 *
 * Java files ask the backend's incremental counts instead (`javaUsageCounts`): the counts
 * known from before show at once, then the ones whose files changed are recounted, cheap
 * ones first and costly ones (names found in very many files) one by one.
 */
import { EditorSelection, MapMode, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import {
  codeLenses,
  declarationActions,
  hasDeclarationActions,
  type CodeLens,
  type DeclarationRef,
} from "@/editor/api";
import { declarationStart } from "@/editor/core/cm/codeLens";
import { showContextMenu, useContextMenuStore, type MenuItem } from "@/ui";
import { executeAction } from "@/platform/actions";
import {
  commands,
  nextRequestId,
  type OutlineItem,
  type RequestId,
  type SymbolKind,
  type UsageCount,
  type UsagePass,
} from "@/platform/ipc";
import type { EditorDocContext } from "@/editor/api";
import { useProject } from "@/platform/project";
import { debounce, docOf, isUnavailable, lspRequest } from "./lsp";
import { posToOffset } from "./positions";
import { featureBackoff, onLspRefresh, onServerSettled } from "./availability";
import { editorPrefs } from "@/platform/editorSettings";
import { authorLabel, authorSummary, authorTooltip, blameFor, onBlameInvalidated } from "./authorLens";
import { tx } from "@/platform/i18n";

const LENS_KINDS = new Set<SymbolKind>([
  "class",
  "interface",
  "struct",
  "enum",
  "trait",
  "function",
  "method",
  "constructor",
  "typeAlias",
  "macro",
]);

/** Declarations with the AI actions menu. */
const AI_KINDS = new Set<SymbolKind>(["function", "method", "constructor"]);

const MAX_PER_PASS = 40;
const CONCURRENCY = 4;
/** Delay before counting after an edit; opening and scrolling show known counts sooner. */
const EDIT_DELAY = 900;
const VIEW_DELAY = 60;
/** Java declarations counted per request. */
const JAVA_BATCH = 12;
/** Lines above/below the viewport that are counted too, so scrolling feels instant. */
const MARGIN_LINES = 60;
const usagesBackoff = featureBackoff();

export interface LensTarget {
  name: string;
  kind: SymbolKind;
  /** 0-based line / UTF-16 col of the identifier. */
  line: number;
  col: number;
  /** 0-based lines of the whole declaration. */
  startLine: number;
  endLine: number;
}

/** Servers name callbacks and anonymous functions (`<function>`, `map() callback`); they have no usages. */
const anonymous = (name: string) => /^<.*>$/.test(name) || / callback$/.test(name);

/** Declarations worth a usages lens, in document order. Exported for tests. */
export function lensTargets(items: readonly OutlineItem[]): LensTarget[] {
  const out: LensTarget[] = [];
  const walk = (list: readonly OutlineItem[]) => {
    for (const it of list) {
      if (LENS_KINDS.has(it.kind) && !anonymous(it.name))
        out.push({
          name: it.name,
          kind: it.kind,
          line: it.selection_range.start.line,
          col: it.selection_range.start.col,
          startLine: it.range.start.line,
          endLine: it.range.end.line,
        });
      if (it.children.length) walk(it.children);
    }
  };
  walk(items);
  const seen = new Set<number>();
  return out
    .sort((a, b) => a.line - b.line || a.col - b.col)
    .filter((t) => (seen.has(t.line) ? false : (seen.add(t.line), true)));
}

export function usagesLabel(n: number): string {
  if (n === 0) return "no usages";
  return n === 1 ? "1 usage" : `${n} usages`;
}

const setLenses = StateEffect.define<CodeLens[]>();

const lensField = StateField.define<CodeLens[]>({
  create: () => [],
  update(lenses, tr) {
    for (const e of tr.effects) if (e.is(setLenses)) return e.value;
    if (!tr.docChanged || !lenses.length) return lenses;
    // Keep lenses on their lines while typing; drop ones whose line was deleted.
    const out: CodeLens[] = [];
    for (const l of lenses) {
      const pos = tr.changes.mapPos(l.pos, -1, MapMode.TrackDel);
      if (pos !== null) out.push({ ...l, pos });
    }
    return out;
  },
  provide: (f) => codeLenses.from(f),
});

const usagesEnabled = () => editorPrefs().inlay.codeVisionUsages;
const authorEnabled = () => editorPrefs().inlay.codeVisionAuthor;
const aiEnabled = () => editorPrefs().inlay.codeVisionAi && hasDeclarationActions();

const relative = (path: string) => {
  const root = useProject.getState().project?.root;
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
};

/**
 * Declaration `t` of `text`, `shift` lines further down (edits above it since the outline):
 * its whole lines, with the doc comment and annotations above it.
 */
export function declarationRef(path: string, text: Text, t: LensTarget, shift = 0): DeclarationRef | null {
  const first = Math.min(t.startLine, t.line) + 1 + shift;
  const last = Math.max(t.endLine, t.line) + 1 + shift;
  if (first < 1 || last > text.lines || first > last) return null;
  return {
    path,
    rel: relative(path),
    name: t.name,
    kind: t.kind,
    lines: { from: first, to: last },
    code: text.sliceString(text.line(first).from, text.line(last).to),
  };
}

/** The AI actions menu of a declaration, below its lens. */
function openAiMenu(view: EditorView, event: MouseEvent, path: string, t: LensTarget, widgetLine: number) {
  const button = (event.target as Element | null)?.closest("button");
  if (!button) return;
  // Lines moved since the outline: the lens row sits where the declaration starts now.
  const shift = view.state.doc.lineAt(view.posAtDOM(button)).number - widgetLine;
  const ref = declarationRef(path, view.state.doc, t, shift);
  if (!ref) return;
  const items: MenuItem[] = [];
  for (const a of declarationActions(ref)) {
    if (a.group && items.length) items.push({ kind: "separator" });
    items.push({
      id: a.id,
      label: a.label,
      icon: a.icon,
      run: () => void Promise.resolve(a.run()).catch(console.error),
    });
  }
  if (!items.length) return;
  const r = button.getBoundingClientRect();
  button.setAttribute("aria-expanded", "true");
  showContextMenu({ x: r.left, y: r.bottom + 2 }, items);
  const shown = useContextMenuStore.getState().menu;
  const off = useContextMenuStore.subscribe((s) => {
    if (s.menu === shown) return;
    off();
    button.removeAttribute("aria-expanded");
  });
}

function openUsages(view: EditorView, offset: number) {
  view.dispatch({ selection: EditorSelection.cursor(offset), userEvent: "select.lens" });
  view.focus();
  void executeAction("find.showUsages");
}

/** Java declarations counted by the backend: what they need next. */
export function javaFollowUps(states: readonly UsageCount[]): { cheap: number[]; costly: number[] } {
  const cheap: number[] = [];
  const costly: number[] = [];
  states.forEach((c, i) => {
    if (c.state === "stale") cheap.push(i);
    else if (c.state === "costly") costly.push(i);
  });
  return { cheap, costly };
}

class UsagesLensPlugin {
  private schedule = debounce(() => void this.run(), EDIT_DELAY);
  private scheduleSoon = debounce(() => void this.run(), VIEW_DELAY);
  /** The Java usage counts extension is missing: count with reference requests. */
  private javaUnsupported = false;
  /** `${line}:${col}:${name}` → count, valid for `cacheDoc`. */
  private cache = new Map<string, number>();
  private cacheDoc: Text | null = null;
  private outline: { doc: Text; targets: LensTarget[] } | null = null;
  private generation = 0;
  private pending = new Set<RequestId>();
  private incomplete = false;
  private unsubscribe: () => void;
  private offReady: () => void;
  private offSettled: () => void;
  private offBlame: () => void;

  constructor(private view: EditorView) {
    this.refresh(true);
    this.unsubscribe = useProject.subscribe((s, prev) => {
      if (s.settings !== prev.settings) this.refresh();
    });
    // Counts computed while the server was indexing may be incomplete.
    this.offReady = onLspRefresh("codeLens", () => {
      this.cache.clear();
      this.refresh();
    });
    this.offSettled = onServerSettled(() => {
      if (this.incomplete) this.refresh();
    });
    this.offBlame = onBlameInvalidated(() => this.refresh());
  }

  update(u: ViewUpdate) {
    if (u.docChanged) this.refresh();
    else if (u.viewportChanged) this.refresh(true);
  }

  private cancel() {
    this.generation++;
    for (const id of this.pending) void commands.cancelRequest(id).catch(() => {});
    this.pending.clear();
  }

  /** `soon`: nothing was edited, known counts can show at once. */
  private refresh(soon = false) {
    this.cancel();
    if (soon) {
      this.schedule.cancel();
      this.scheduleSoon();
    } else {
      this.scheduleSoon.cancel();
      this.schedule();
    }
  }

  /**
   * Counts `targets` of a Java file with the backend's incremental counts, rendering after
   * each step. False when the backend cannot (no extension): count the other way.
   */
  private async countJava(
    doc: EditorDocContext,
    targets: readonly LensTarget[],
    key: (t: LensTarget) => string,
    wanted: () => boolean,
    render: () => void,
  ): Promise<boolean> {
    const ask = async (pass: UsagePass, ts: readonly LensTarget[]) => {
      const request = nextRequestId();
      try {
        return await lspRequest(() => {
          this.pending.add(request);
          const positions = ts.map((t) => ({ line: t.line, col: t.col }));
          return commands.javaUsageCounts(request, doc.doc, positions, pass);
        }, wanted);
      } finally {
        this.pending.delete(request);
      }
    };
    const apply = (ts: readonly LensTarget[], counts: readonly UsageCount[]) => {
      ts.forEach((t, i) => {
        const c = counts[i];
        if (c?.count != null) this.cache.set(key(t), c.count);
        else if (c?.state === "none") this.cache.delete(key(t));
      });
      render();
    };
    try {
      const known = await ask("cached", targets);
      if (!wanted()) return true;
      apply(targets, known);
      const { cheap, costly } = javaFollowUps(known);
      // A few declarations per request, some at once: counts show as each batch is done.
      const batches: number[][] = [];
      for (let i = 0; i < cheap.length; i += JAVA_BATCH) batches.push(cheap.slice(i, i + JAVA_BATCH));
      const next = async (): Promise<void> => {
        const batch = batches.shift();
        if (!batch || !wanted()) return;
        const ts = batch.map((i) => targets[i]!);
        const counted = await ask("cheap", ts);
        if (!wanted()) return;
        apply(ts, counted);
        // A recount found more files to count than expected.
        javaFollowUps(counted).costly.forEach((i) => costly.push(batch[i]!));
        await next();
      };
      await Promise.all(Array.from({ length: CONCURRENCY - 1 }, next));
      if (!wanted()) return true;
      for (const i of costly.sort((a, b) => a - b)) {
        if (!wanted()) return true;
        const t = targets[i]!;
        apply([t], await ask("full", [t]));
      }
      return true;
    } catch (e) {
      if (isUnavailable(e)) {
        this.javaUnsupported = true;
        return false;
      }
      throw e;
    }
  }

  private async run() {
    const view = this.view;
    if (!view.dom.isConnected) return;
    const doc = docOf(view);
    if (!doc) return;
    const gen = this.generation;
    const usages = usagesEnabled() && !usagesBackoff.active(doc.doc);
    const authors = authorEnabled() && !doc.virtual;
    const ai = aiEnabled() && !doc.virtual;
    if (!usages && !authors && !ai) {
      if (view.state.field(lensField).length) view.dispatch({ effects: setLenses.of([]) });
      return;
    }
    const text = view.state.doc;
    const wanted = () => gen === this.generation && view.state.doc === text;
    this.incomplete = false;
    // Blame runs beside the reference requests; it never holds up the counts.
    const blame = authors ? blameFor(doc.path, text) : Promise.resolve(null);
    if (this.cacheDoc !== text) {
      this.cache = new Map();
      this.cacheDoc = text;
    }
    try {
      if (this.outline?.doc !== text) {
        const items = await lspRequest(() => commands.docOutline(doc.doc), wanted);
        if (!wanted()) return;
        this.outline = { doc: text, targets: lensTargets(items) };
      }
      const { from, to } = view.viewport;
      const firstLine = Math.max(0, text.lineAt(from).number - 1 - MARGIN_LINES);
      const lastLine = text.lineAt(to).number - 1 + MARGIN_LINES;
      const visible = this.outline.targets
        .filter((t) => t.line >= firstLine && t.line <= lastLine)
        .slice(0, MAX_PER_PASS);
      const key = (t: LensTarget) => `${t.line}:${t.col}:${t.name}`;
      let lines: Awaited<typeof blame> = null;
      const render = () => {
        if (wanted()) this.render(doc.path, text, visible, usages, ai, lines, key);
      };
      void blame.then((l) => {
        lines = l;
        render();
      });
      const java = usages && doc.language === "java" && !doc.virtual && !this.javaUnsupported;
      const counted = java && (await this.countJava(doc, visible, key, wanted, render));
      if (!wanted()) return;
      const todo = usages && !counted ? visible.filter((t) => !this.cache.has(key(t))) : [];
      let unavailable = false;
      for (let i = 0; i < todo.length && !unavailable; i += CONCURRENCY) {
        await Promise.all(
          todo.slice(i, i + CONCURRENCY).map(async (t) => {
            const request = nextRequestId();
            try {
              const { locations: refs, incomplete } = await lspRequest(() => {
                this.pending.add(request);
                // Opening candidate files for each count triggers expensive server analysis.
                // Only an explicit Find Usages should widen the server's scope.
                return commands.lspReferences(request, doc.doc, { line: t.line, col: t.col }, false, false);
              }, wanted);
              if (wanted()) {
                if (incomplete) this.incomplete = true;
                else this.cache.set(key(t), refs.length);
              }
            } catch (e) {
              if (wanted() && isUnavailable(e)) unavailable = true;
            } finally {
              this.pending.delete(request);
            }
          }),
        );
        if (!wanted()) return;
      }
      if (unavailable) usagesBackoff.mark(doc.doc);
      lines = await blame;
      render();
    } catch (e) {
      if (wanted() && isUnavailable(e)) usagesBackoff.mark(doc.doc);
    }
  }

  /** Lenses of `visible` from the counts and blame known so far. */
  private render(
    path: string,
    text: Text,
    visible: readonly LensTarget[],
    usages: boolean,
    ai: boolean,
    lines: Awaited<ReturnType<typeof blameFor>>,
    key: (t: LensTarget) => string,
  ) {
    const view = this.view;
    const lenses: CodeLens[] = [];
    for (const t of visible) {
      const offset = posToOffset(text, { line: t.line, col: t.col });
      if (ai && AI_KINDS.has(t.kind)) {
        const widgetLine = text.lineAt(declarationStart(view.state, text.lineAt(offset).number)).number;
        lenses.push({
          pos: offset,
          title: "",
          icon: "ai",
          menu: true,
          tooltip: tx("AI Actions"),
          order: 0,
          run: (v, e) => openAiMenu(v, e, path, t, widgetLine),
        });
      }
      const who = lines && authorSummary(lines, t.startLine, t.endLine);
      if (who)
        lenses.push({ pos: offset, title: authorLabel(who), tooltip: authorTooltip(who), icon: "user", order: 20 });
      const n = usages ? this.cache.get(key(t)) : undefined;
      if (n === undefined) continue;
      lenses.push({
        pos: offset,
        title: usagesLabel(n),
        tooltip: tx`Show usages of ${t.name}`,
        order: 10,
        run: (v) => openUsages(v, Math.min(offset, v.state.doc.length)),
      });
    }
    if (!sameLenses(view.state.field(lensField), lenses)) view.dispatch({ effects: setLenses.of(lenses) });
  }

  destroy() {
    this.schedule.cancel();
    this.scheduleSoon.cancel();
    this.unsubscribe();
    this.offReady();
    this.offSettled();
    this.offBlame();
    this.cancel();
  }
}

function sameLenses(a: readonly CodeLens[], b: readonly CodeLens[]) {
  return (
    a.length === b.length &&
    a.every((l, i) => l.pos === b[i]!.pos && l.title === b[i]!.title && l.tooltip === b[i]!.tooltip)
  );
}

export function usagesLensExtension(): Extension {
  return [lensField, ViewPlugin.fromClass(UsagesLensPlugin)];
}
