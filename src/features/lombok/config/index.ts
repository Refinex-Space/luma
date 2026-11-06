/**
 * `lombok.config` support of the Lombok plugin (IDEA's `Lombok.Config` language):
 * highlighting, completion of keys, operators and values, Quick Documentation of keys,
 * and the `lombok.config problems` inspection (unknown keys with a fix to the key meant,
 * values a key does not take, `+=` / `-=` on keys that are no list). Present while the
 * plugin is on.
 */
import { EditorState, type Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView } from "@codemirror/view";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import {
  CONTRIBUTED_HOVER,
  intentionProviders,
  quickFixProviders,
  registerEditorContribution,
  registerLanguageMode,
  type ContributedHover,
  type ContributedIntention,
  type EditorDocContext,
} from "@/editor/api";
import { setFileDiagnostics } from "@/editor/lsp/diagnostics";
import { offsetsToRange } from "@/editor/lsp/positions";
import { tx } from "@/platform/i18n";
import { LOMBOK_PRODUCERS } from "@/platform/inspections";
import { lombokPrefs } from "@/platform/lombokSettings";
import { useProject } from "@/platform/project";
import { CONFIG_KEYS, type ConfigKey } from "./keys";
import { LOMBOK_CONFIG_MODE, lombokConfigLanguageDescription } from "./language";
import { contextAt, keyAt, keyDoc, operatorsOf, validateConfig, type ConfigProblem } from "./model";

export const isLombokConfig = (ctx: Pick<EditorDocContext, "path" | "uiMode">) =>
  ctx.uiMode === LOMBOK_CONFIG_MODE || /(^|[\\/])lombok\.config$/.test(ctx.path);

const INSPECT_DELAY = 300;

function keyOption(k: ConfigKey): Completion & { icon: string; typeText: string } {
  return {
    label: k.key,
    type: "property",
    icon: "property",
    typeText: k.type,
    detail: k.default ? `= ${k.default}` : undefined,
    info: () => {
      const el = document.createElement("div");
      el.textContent = k.doc;
      return el;
    },
    // Keys are named by their feature (`lombok.getter.noIsPrefix`): later parts rank the same.
    boost: k.key.startsWith("lombok.") ? 0 : -1,
    apply: k.key,
  };
}

/** The directives besides `key = value` (keywords, not translated). */
const DIRECTIVES: ReadonlyArray<readonly [string, string]> = [
  ["clear", "Resets a key to its default"],
  ["import", "Reads another configuration file"],
];

/** Completion at the caret: keys (and `clear` / `import`), operators, values. */
export function completeConfig(ctx: Pick<CompletionContext, "state" | "pos" | "explicit">): CompletionResult | null {
  const text = ctx.state.doc.toString();
  const at = contextAt(text, ctx.pos);
  if (!at) return null;
  switch (at.kind) {
    case "directive":
      if (!at.typed && !ctx.explicit) return null;
      return {
        from: at.from,
        options: [
          ...CONFIG_KEYS.map((k) => ({ ...keyOption(k), apply: `${k.key} ${operatorsOf(k)[0]} ` })),
          ...DIRECTIVES.map(([word, detail]) => ({
            label: word,
            type: "keyword",
            apply: `${word} `,
            detail: tx(detail),
          })),
        ],
        validFor: /^[\w.]*$/,
      };
    case "clearKey":
      return { from: at.from, options: CONFIG_KEYS.map(keyOption), validFor: /^[\w.]*$/ };
    case "operator":
      return {
        from: at.from,
        options: operatorsOf(at.key).map((op) => ({
          label: op,
          type: "operator",
          apply: `${op} `,
          detail: op === "+=" ? tx("Add to the list") : op === "-=" ? tx("Remove from the list") : tx("Set"),
        })),
      };
    case "value": {
      const values = at.key.values ?? at.key.suggestions ?? [];
      if (!values.length) return null;
      return {
        from: at.from,
        options: values.map((v) => ({
          label: v,
          type: at.key.kind === "boolean" ? "keyword" : "enum",
          detail: v === at.key.default ? tx("default") : undefined,
        })),
        validFor: /^[\w.:-]*$/,
      };
    }
  }
}

const hover: ContributedHover = (state, pos) => {
  const found = keyAt(state.doc.toString(), pos);
  return found ? { from: found.from, to: found.to, markdown: keyDoc(found.key) } : null;
};

function problemsOf(view: EditorView): ConfigProblem[] {
  return validateConfig(view.state.doc.toString());
}

/** Fixes of the problems in `from`–`to`: an unknown key to the key it most likely means. */
function fixes(view: EditorView, from: number, to: number): ContributedIntention[] {
  if (view.state.readOnly) return [];
  const text = view.state.doc;
  return problemsOf(view)
    .filter((p) => p.replacement && p.from <= to && p.to >= from)
    .map((p) => {
      const key = p.replacement!;
      return {
        id: `lombok.config.key:${p.from}`,
        label: tx`Change to '${key}'`,
        quickFix: true,
        run: () => {
          if (view.state.doc !== text) return;
          view.dispatch({ changes: { from: p.from, to: p.to, insert: key }, userEvent: "input.quickfix" });
        },
      };
    });
}

/** The `lombok.config problems` inspection, re-run shortly after edits. */
function inspection(ctx: EditorDocContext): Extension {
  return ViewPlugin.define((view) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      const doc = view.state.doc;
      setFileDiagnostics(
        ctx.path,
        LOMBOK_PRODUCERS.config,
        problemsOf(view).map((p) => ({
          range: offsetsToRange(doc, p.from, p.to),
          severity: p.severity,
          message: p.message,
          source: "Lombok",
          code: null,
        })),
      );
    };
    run();
    return {
      update(u) {
        if (!u.docChanged) return;
        clearTimeout(timer);
        timer = setTimeout(run, INSPECT_DELAY);
      },
      destroy() {
        clearTimeout(timer);
        setFileDiagnostics(ctx.path, LOMBOK_PRODUCERS.config, []);
      },
    };
  });
}

function extension(ctx: EditorDocContext): Extension {
  const parts: Extension[] = [
    EditorState.languageData.of(() => [
      { lumaCompletion: (c: CompletionContext) => Promise.resolve(completeConfig(c)), [CONTRIBUTED_HOVER]: hover },
    ]),
  ];
  if (!ctx.virtual) {
    parts.push(inspection(ctx));
    if (!ctx.readOnly)
      parts.push(
        quickFixProviders.of(fixes),
        intentionProviders.of((view) => {
          const { from, to } = view.state.selection.main;
          return fixes(view, from, to);
        }),
      );
  }
  return parts;
}

/** The language mode and editor support, registered while the plugin is on. */
function register(): () => void {
  const disposers = [
    registerLanguageMode(lombokConfigLanguageDescription),
    registerEditorContribution({
      id: "lombok-config",
      extensions: (ctx) => (isLombokConfig(ctx) ? extension(ctx) : []),
    }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}

export function activateConfigSupport(): () => void {
  let off: (() => void) | null = null;
  const sync = () => {
    const on = lombokPrefs().enabled;
    if (on && !off) off = register();
    else if (!on && off) {
      off();
      off = null;
    }
  };
  sync();
  const unsubscribe = useProject.subscribe((s, prev) => {
    if (s.settings?.lombok !== prev.settings?.lombok) sync();
  });
  return () => {
    unsubscribe();
    off?.();
    off = null;
  };
}
