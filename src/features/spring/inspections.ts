/**
 * Spring inspections in Java editors (IDEA's Spring › Spring Core › Code group): the Spring
 * model's problems of the file (`spring_problems`) as diagnostics, one producer per inspection
 * (Settings › Editor › Inspections › Spring), and their quick fixes as text edits.
 */
import type { Text } from "@codemirror/state";
import { ViewPlugin, type EditorView } from "@codemirror/view";
import {
  intentionProviders,
  quickFixProviders,
  registerEditorContribution,
  type ContributedIntention,
} from "@/editor/api";
import { setFileDiagnostics } from "@/editor/lsp/diagnostics";
import { openPopup } from "@/editor/lsp/popupStore";
import { rangeToOffsets } from "@/editor/lsp/positions";
import { txTemplate } from "@/platform/i18n";
import {
  inspectionProfile,
  producerInspectionId,
  SPRING_PRODUCERS,
  subscribeInspectionProfile,
} from "@/platform/inspections";
import {
  call,
  commands,
  isTauri,
  onIdeEvent,
  type Diagnostic,
  type SpringFix,
  type SpringProblem,
  type SpringProblemSeverity,
} from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { spelSupport } from "./spel/editor";

/** The Spring model's inspections (the SpEL ones are published by `spel/editor`). */
const PRODUCERS = Object.entries(SPRING_PRODUCERS)
  .filter(([key]) => !key.startsWith("spel"))
  .map(([, producer]) => producer);
const INSPECT_DELAY = 500;

const SEVERITY: Record<SpringProblemSeverity, Diagnostic["severity"]> = {
  error: "error",
  warning: "warning",
  weakWarning: "info",
};

export const producerOfProblem = (p: SpringProblem): string => SPRING_PRODUCERS[p.inspection];

/** The problems found for one document version. */
interface Analysis {
  doc: Text;
  problems: SpringProblem[];
}

const analyses = new WeakMap<EditorView, Analysis>();

const enabled = (p: SpringProblem) =>
  inspectionProfile()[producerInspectionId(producerOfProblem(p))]?.enabled !== false;

/** Diagnostics of each producer (all producers listed, so cleared ones are emptied). */
export function problemDiagnostics(doc: Text, problems: readonly SpringProblem[]): Map<string, Diagnostic[]> {
  const out = new Map<string, Diagnostic[]>(PRODUCERS.map((p) => [p, []]));
  for (const p of problems) {
    const { from, to } = rangeToOffsets(doc, p.range);
    if (from > doc.length || to > doc.length) continue;
    out.get(producerOfProblem(p))!.push({
      range: p.range,
      severity: SEVERITY[p.severity],
      message: txTemplate(p.message),
      source: "Spring",
      code: null,
    });
  }
  return out;
}

/** Applies a fix's edits when the editor still shows the text they were computed for. */
function applyFix(view: EditorView, a: Analysis, fix: SpringFix) {
  if (view.state.doc !== a.doc || view.state.readOnly) return;
  const changes = fix.edits.map((e) => ({ ...rangeToOffsets(a.doc, e.range), insert: e.text }));
  view.dispatch({ changes, userEvent: "input.spring", scrollIntoView: true });
  view.focus();
}

/** One action per fix label; fixes offering a choice (`Add qualifier` → a bean) open a chooser. */
export function fixActions(problem: SpringProblem): Array<{ label: string; fixes: SpringFix[] }> {
  const out: Array<{ label: string; fixes: SpringFix[] }> = [];
  for (const f of problem.fixes) {
    const same = f.choice !== null ? out.find((o) => o.label === f.label) : undefined;
    if (same) same.fixes.push(f);
    else out.push({ label: f.label, fixes: [f] });
  }
  return out;
}

function intentions(view: EditorView, a: Analysis, problem: SpringProblem): ContributedIntention[] {
  return fixActions(problem).map(({ label, fixes }, i) => ({
    id: `spring.fix:${problem.inspection}:${problem.range.start.line}:${problem.range.start.col}:${i}`,
    label: txTemplate(label),
    icon: "bulb-fix",
    quickFix: true,
    run: () => {
      if (fixes.length === 1 && fixes[0]!.choice === null) return applyFix(view, a, fixes[0]!);
      const at = view.coordsAtPos(view.state.selection.main.head);
      openPopup({
        kind: "list",
        anchor: at ? { x: at.left, y: at.bottom + 2 } : { x: 0, y: 0 },
        title: txTemplate(label),
        items: fixes.map((f, j) => ({
          id: `${j}`,
          label: f.choice ?? txTemplate(f.label),
          icon: "gutter-spring-bean",
          run: () => applyFix(view, a, f),
        })),
      });
    },
  }));
}

function quickFixes(view: EditorView, from: number, to: number): ContributedIntention[] {
  const a = analyses.get(view);
  if (!a || a.doc !== view.state.doc || view.state.readOnly) return [];
  return a.problems
    .filter((p) => p.fixes.length && enabled(p))
    .filter((p) => {
      const r = rangeToOffsets(a.doc, p.range);
      return r.from <= to && from <= r.to;
    })
    .flatMap((p) => intentions(view, a, p));
}

/** Alt+Enter at the caret: the fixes of the problems under it. */
function caretIntentions(view: EditorView): ContributedIntention[] {
  const pos = view.state.selection.main.head;
  return quickFixes(view, pos, pos);
}

/** Publishes the file's problems (debounced), refreshed on edits and model / profile changes. */
function inspections(path: string, doc: number) {
  return ViewPlugin.define((view) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    const publish = async () => {
      const gen = ++generation;
      const text = view.state.doc;
      let problems: SpringProblem[];
      try {
        problems = await call(commands.springProblems(doc));
      } catch {
        return;
      }
      if (gen !== generation || view.state.doc !== text) return;
      analyses.set(view, { doc: text, problems });
      for (const [producer, items] of problemDiagnostics(text, problems)) setFileDiagnostics(path, producer, items);
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void publish(), INSPECT_DELAY);
    };
    schedule();
    const offs = [
      onIdeEvent("springModelChanged", schedule),
      useProject.subscribe((s, prev) => s.settings?.spring !== prev.settings?.spring && schedule()),
      subscribeInspectionProfile(schedule),
    ];
    return {
      update: (u) => {
        if (u.docChanged) schedule();
      },
      destroy: () => {
        clearTimeout(timer);
        generation++;
        offs.forEach((off) => off());
        for (const producer of PRODUCERS) setFileDiagnostics(path, producer, []);
      },
    };
  });
}

/** Spring checks in Java editors while the plugin is active for the project. */
export function registerInspections(): () => void {
  if (!isTauri()) return () => {};
  return registerEditorContribution({
    id: "spring-inspections",
    extensions: (ctx) =>
      ctx.language !== "java" || ctx.virtual || ctx.doc < 0
        ? []
        : [
            inspections(ctx.path, ctx.doc),
            quickFixProviders.of(quickFixes),
            intentionProviders.of(caretIntentions),
            spelSupport(ctx.path, ctx.doc),
          ],
  });
}
