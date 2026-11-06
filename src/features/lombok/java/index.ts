/**
 * Lombok in Java editors (IDEA's Lombok plugin): its inspections (@Getter / @Setter may be
 * used, @Slf4j, deprecated annotations) as diagnostics with quick fixes and context
 * actions, and the Refactor › Lombok actions on the class at the caret. Active while the
 * plugin is on and the project (or the file) uses Lombok.
 */
import type { Text } from "@codemirror/state";
import { ViewPlugin, type EditorView } from "@codemirror/view";
import {
  activeEditor,
  intentionProviders,
  quickFixProviders,
  registerEditorContribution,
  type ContributedIntention,
} from "@/editor/api";
import { setFileDiagnostics } from "@/editor/lsp/diagnostics";
import { showHint } from "@/editor/lsp/hint";
import { offsetsToRange } from "@/editor/lsp/positions";
import { registerActions } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import {
  inspectionProfile,
  LOMBOK_PRODUCERS,
  producerInspectionId,
  subscribeInspectionProfile,
} from "@/platform/inspections";
import { useProject } from "@/platform/project";
import { confirm } from "@/workbench/messages";
import { importsLombok, LOMBOK_ENABLED, lombokActive, useLombok } from "../store";
import { lombokProblems, type Problem, type ProblemKind } from "./checks";
import { minimalChange } from "./edits";
import { applyLombok, loggerFields, lombokUnavailable, type LombokHandler } from "./refactor";
import { classAt, parseJava } from "./syntax";

const PRODUCER: Record<ProblemKind, string> = LOMBOK_PRODUCERS;
const KINDS = Object.keys(PRODUCER) as ProblemKind[];
const INSPECT_DELAY = 400;

interface Analysis {
  text: string;
  /** Empty while Lombok support is off for the file. */
  problems: Problem[];
}

/** Analyses per document version (the light bulb asks on every caret move). */
const analyses = new WeakMap<Text, Analysis>();
/** Bumped when the plugin's state changes: cached analyses don't apply any more. */
let generation = 0;
const generations = new WeakMap<Text, number>();

function analyse(doc: Text): Analysis {
  const cached = analyses.get(doc);
  if (cached && generations.get(doc) === generation) return cached;
  const text = doc.toString();
  const out = { text, problems: lombokActive(importsLombok(text)) ? lombokProblems(text) : [] };
  analyses.set(doc, out);
  generations.set(doc, generation);
  return out;
}

const enabledKind = (kind: ProblemKind) => inspectionProfile()[producerInspectionId(PRODUCER[kind])]?.enabled !== false;

/** Applies `problem`'s fix when `view` still shows the text it was found in. */
function applyFix(view: EditorView, analysis: Analysis, problem: Problem) {
  if (view.state.doc.toString() !== analysis.text) return;
  const change = minimalChange(analysis.text, problem.fix.apply());
  if (change) view.dispatch({ changes: change, userEvent: "input.lombok", scrollIntoView: true });
}

const intention = (view: EditorView, analysis: Analysis, p: Problem): ContributedIntention => ({
  id: `lombok.fix:${p.kind}:${p.from}`,
  label: p.fix.label,
  icon: "bulb-fix",
  quickFix: true,
  run: () => applyFix(view, analysis, p),
});

function quickFixes(view: EditorView, from: number, to: number): ContributedIntention[] {
  const a = analyse(view.state.doc);
  return a.problems
    .filter((p) => enabledKind(p.kind) && p.from <= to && from <= p.to)
    .map((p) => intention(view, a, p));
}

function caretIntentions(view: EditorView): ContributedIntention[] {
  if (view.state.readOnly) return [];
  const a = analyse(view.state.doc);
  const pos = view.state.selection.main.head;
  return a.problems
    .filter((p) => enabledKind(p.kind) && p.scopeFrom <= pos && pos <= p.scopeTo)
    .map((p) => intention(view, a, p));
}

/** Publishes the file's Lombok problems (debounced), refreshed on edits and plugin / profile changes. */
function inspections(path: string) {
  return ViewPlugin.define((view) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = () => {
      const { problems } = analyse(view.state.doc);
      for (const kind of KINDS)
        setFileDiagnostics(
          path,
          PRODUCER[kind],
          problems
            .filter((p) => p.kind === kind)
            .map((p) => ({
              range: offsetsToRange(view.state.doc, p.from, p.to),
              severity: p.severity,
              message: p.message,
              source: "Lombok",
              code: null,
            })),
        );
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(publish, INSPECT_DELAY);
    };
    schedule();
    const refresh = () => {
      generation++;
      schedule();
    };
    const offs = [
      useLombok.subscribe((s, prev) => s.status !== prev.status && refresh()),
      useProject.subscribe((s, prev) => s.settings?.lombok !== prev.settings?.lombok && refresh()),
      subscribeInspectionProfile(refresh),
    ];
    return {
      update: (u) => {
        if (u.docChanged) schedule();
      },
      destroy: () => {
        clearTimeout(timer);
        offs.forEach((off) => off());
        for (const kind of KINDS) setFileDiagnostics(path, PRODUCER[kind], []);
      },
    };
  });
}

/** Refactor › Lombok: the handler on the class at the caret of the active Java editor. */
async function runHandler(handler: LombokHandler) {
  const editor = activeEditor();
  if (!editor || editor.ctx.language !== "java" || editor.view.state.readOnly) return;
  const view = editor.view;
  const text = view.state.doc.toString();
  const file = parseJava(text);
  const cls = classAt(file, view.state.selection.main.head);
  const reason = lombokUnavailable(file, cls, handler);
  if (reason || !cls) return showHint(view, reason ?? "", { tone: "warning" });
  if (handler === "logger") {
    const odd = loggerFields(file, cls).find((l) => !l.conventional);
    if (
      odd &&
      !(await confirm({
        title: tx("Attention!"),
        message: tx`Logger field "${odd.name}" is not a private static final field named "log". Refactor anyway?`,
        ok: tx("Refactor"),
        icon: "question",
      }))
    )
      return;
    if (view.state.doc.toString() !== text) return;
  }
  const change = minimalChange(text, applyLombok(text, cls, handler));
  if (!change) return showHint(view, tx("Nothing to replace with Lombok"), { tone: "info" });
  view.dispatch({ changes: change, userEvent: "input.lombok", scrollIntoView: true });
  view.focus();
}

/** IDEA's Refactor › Lombok actions (its texts). */
export const LOMBOK_ACTIONS: ReadonlyArray<{ id: string; title: string; handler: LombokHandler; description: string }> =
  [
    {
      id: "lombok.addData",
      title: "Default @Data",
      handler: "data",
      description: "Replace getter / setter / equals / hashCode / toString methods with Lombok's @Data",
    },
    {
      id: "lombok.addGetter",
      title: "Default @Getter",
      handler: "getter",
      description: "Replace all getter methods with Lombok's @Getter",
    },
    {
      id: "lombok.addSetter",
      title: "Default @Setter",
      handler: "setter",
      description: "Replace all setter methods with Lombok's @Setter",
    },
    {
      id: "lombok.addEqualsAndHashCode",
      title: "Default @EqualsAndHashCode",
      handler: "equalsAndHashCode",
      description: "Replace the equals and hashCode methods with Lombok's @EqualsAndHashCode",
    },
    {
      id: "lombok.addToString",
      title: "Default @ToString",
      handler: "toString",
      description: "Replace the toString method with Lombok's @ToString",
    },
    {
      id: "lombok.addLogger",
      title: "@Log (and friends)",
      handler: "logger",
      description: "Replace the logger field with Lombok's @Log, @Slf4j, @Log4j2… annotation",
    },
  ];

export function activateJavaSupport(): () => void {
  const disposers = [
    registerEditorContribution({
      id: "lombok-java",
      extensions: (ctx) =>
        ctx.language !== "java" || ctx.virtual || ctx.readOnly
          ? []
          : [inspections(ctx.path), quickFixProviders.of(quickFixes), intentionProviders.of(caretIntentions)],
    }),
    registerActions(
      LOMBOK_ACTIONS.map((a) => ({
        id: a.id,
        title: a.title,
        category: "Refactor",
        description: a.description,
        keywords: ["lombok", "refactor", "annotation"],
        when: `editorTextFocus && editorLangId == java && ${LOMBOK_ENABLED}`,
        run: () => runHandler(a.handler),
      })),
    ),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
