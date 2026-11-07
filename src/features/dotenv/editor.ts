/**
 * Editor support of the .env files plugin, per document:
 *  - code reading environment variables (`usages.ts`): completion of the variables with
 *    their values, ⌘B / ⌘-click to their declarations, Find Usages;
 *  - `.env` files: the DotEnv inspections with their quick fixes, `${…}` completion and
 *    navigation, ⌘B on a key showing its usages, values folded when hidden;
 *  - docker-compose files and Dockerfiles: their declarations and `${NAME}` references.
 */
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { foldEffect } from "@codemirror/language";
import { EditorState, type Extension, type Text } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { Location } from "@/bindings";
import {
  CONTRIBUTED_DEFINITION,
  CONTRIBUTED_USAGES,
  intentionProviders,
  quickFixProviders,
  type ContributedDefinition,
  type ContributedIntention,
  type ContributedUsages,
  type EditorDocContext,
} from "@/editor/api";
import { setFileDiagnostics } from "@/editor/lsp/diagnostics";
import { showHint } from "@/editor/lsp/hint";
import { chooserTitle, locationItems, navigateTo, pinToFind } from "@/editor/lsp/navigation";
import { caretAnchor, openPopup } from "@/editor/lsp/popupStore";
import { offsetsToRange } from "@/editor/lsp/positions";
import { executeAction } from "@/platform/actions";
import { dotenvPrefs } from "@/platform/dotenvSettings";
import { tx } from "@/platform/i18n";
import { DOTENV_INSPECTIONS, inspectDotEnv, undefinedNested, type DotEnvProblem } from "./inspections";
import { DOTENV_LANGUAGE } from "./language";
import { declarationsIn, sourceKind, type KeyValue } from "./providers";
import { findEnvUsages } from "./search";
import { allKeyValues, declarationsOf, isDeclared, updateOpenSource } from "./store";
import { parseDotEnv, symbolAt as dotenvSymbolAt, type DotEnvFile, type Span } from "./syntax";
import { providersFor, usageAtColumn, usagesInLine, type UsageProvider } from "./usages";

type DocKind = "dotenv" | "compose" | "dockerfile" | "code";

export interface EnvSymbol {
  kind: "declaration" | "reference";
  key: string;
  span: Span;
}

export function docKind(ctx: Pick<EditorDocContext, "language" | "path">): DocKind | null {
  if (ctx.language === DOTENV_LANGUAGE) return "dotenv";
  const source = sourceKind(ctx.path);
  if (source === "compose" || source === "dockerfile") return source;
  return providersFor(ctx.language, ctx.path).length ? "code" : null;
}

const parsed = new WeakMap<Text, DotEnvFile>();
export function dotenvFileOf(doc: Text): DotEnvFile {
  let file = parsed.get(doc);
  if (!file) parsed.set(doc, (file = parseDotEnv(doc.toString())));
  return file;
}

const declared = new WeakMap<Text, KeyValue[]>();
function declarationsOfDoc(kind: "compose" | "dockerfile", doc: Text): KeyValue[] {
  let list = declared.get(doc);
  if (!list) declared.set(doc, (list = declarationsIn(kind, doc.toString())));
  return list;
}

/** The variable at `pos`: a declaration (a `.env` key) or a reference to one (code, `${NAME}`). */
export function envSymbolAt(
  kind: DocKind,
  providers: readonly UsageProvider[],
  state: EditorState,
  pos: number,
): EnvSymbol | null {
  if (kind === "dotenv") return dotenvSymbolAt(dotenvFileOf(state.doc), pos);
  if (kind !== "code") {
    const d = declarationsOfDoc(kind, state.doc).find((d) => d.keySpan.from <= pos && pos <= d.keySpan.to);
    if (d) return { kind: "declaration", key: d.key, span: d.keySpan };
  }
  const line = state.doc.lineAt(pos);
  const usage = usagesInLine(providers, line.text, line.from).find((u) => u.span.from <= pos && pos <= u.span.to);
  return usage ? { kind: "reference", ...usage } : null;
}

function locationOf(d: { path: string; line: number; col: number; key: string }): Location {
  return {
    path: d.path,
    range: { start: { line: d.line, col: d.col }, end: { line: d.line, col: d.col + d.key.length } },
  };
}

async function gotoDeclarations(view: EditorView, symbol: EnvSymbol) {
  const locations = (await declarationsOf(symbol.key)).map(locationOf);
  if (!locations.length) {
    showHint(view, tx("Cannot find declaration to go to"), { pos: symbol.span.from });
    return;
  }
  if (locations.length === 1) {
    await navigateTo(locations[0]!);
    return;
  }
  openPopup({
    kind: "list",
    anchor: caretAnchor(view, symbol.span.from),
    title: chooserTitle("declaration", symbol.key, locations.length),
    items: await locationItems(locations),
    pin: pinToFind(symbol.key, locations),
  });
}

/** One line of a value, shortened for the lookup's tail text. */
export function shortValue(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat;
}

async function variableOptions(): Promise<Completion[]> {
  return (await allKeyValues()).map(({ key, value }): Completion & { icon: string } => ({
    label: key,
    type: "variable",
    icon: "file-dotenv",
    detail: value ? `= ${shortValue(value)}` : undefined,
    boost: 1,
  }));
}

const VALID_KEY = /^[A-Za-z0-9_.$-]*$/;

/** Inside a double-quoted value of a `.env` file (nested variables are expanded only there). */
function inDoubleQuotes(file: DotEnvFile, pos: number): boolean {
  return file.properties.some(({ value: v }) => {
    if (v?.quote !== '"' || pos <= v.from) return false;
    const closed = v.raw.length > 1 && v.raw.endsWith('"');
    return closed ? pos < v.to : pos <= v.to;
  });
}

/** `${NAME}` completion in `.env` values, and `${…}` itself after a `$` (the plugin's). */
async function completeNested(c: CompletionContext): Promise<CompletionResult | null> {
  const file = dotenvFileOf(c.state.doc);
  if (!inDoubleQuotes(file, c.pos)) return null;
  const line = c.state.doc.lineAt(c.pos);
  const before = line.text.slice(0, c.pos - line.from);
  const open = /\$\{([A-Za-z0-9_.-]*)$/.exec(before);
  if (open) return { from: c.pos - open[1]!.length, options: await variableOptions(), validFor: VALID_KEY };
  if (before.endsWith("$") && !before.endsWith("\\$"))
    return {
      from: c.pos - 1,
      options: [
        {
          label: "${...}",
          type: "keyword",
          apply: (view, _completion, from, to) =>
            view.dispatch({ changes: { from, to, insert: "${}" }, selection: { anchor: from + 2 } }),
        },
      ],
    };
  return null;
}

function codeCompletion(kind: DocKind, providers: readonly UsageProvider[]) {
  return async (c: CompletionContext): Promise<CompletionResult | null> => {
    if (kind === "dotenv") return completeNested(c);
    if (!dotenvPrefs().completion) return null;
    const line = c.state.doc.lineAt(c.pos);
    const usage = usageAtColumn(providers, line.text, c.pos - line.from);
    if (!usage) return null;
    const options = await variableOptions();
    return options.length ? { from: line.from + usage.span.from, options, validFor: VALID_KEY } : null;
  };
}

// ---------------------------------------------------------------------------
// .env files: inspections, quick fixes, hidden values

const INSPECT_DELAY = 300;
const PRODUCERS = Object.values(DOTENV_INSPECTIONS);

function publish(path: string, doc: Text, problems: readonly DotEnvProblem[], only?: string) {
  for (const producer of PRODUCERS) {
    if (only && producer !== only) continue;
    setFileDiagnostics(
      path,
      producer,
      problems
        .filter((p) => p.producer === producer)
        .map((p) => ({
          range: offsetsToRange(doc, p.from, p.to),
          severity: p.severity,
          message: p.message,
          source: ".env",
          code: null,
        })),
    );
  }
}

function inspections(ctx: EditorDocContext): Extension {
  return ViewPlugin.define((view) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const run = () => {
      const doc = view.state.doc;
      const file = dotenvFileOf(doc);
      publish(ctx.path, doc, inspectDotEnv(doc.toString(), file));
      void undefinedNested(file, isDeclared).then((problems) => {
        if (disposed || view.state.doc !== doc) return;
        publish(ctx.path, doc, problems, DOTENV_INSPECTIONS.undefinedNested);
      });
    };
    run();
    return {
      update(u) {
        if (!u.docChanged) return;
        clearTimeout(timer);
        timer = setTimeout(run, INSPECT_DELAY);
      },
      destroy() {
        disposed = true;
        clearTimeout(timer);
        for (const producer of PRODUCERS) setFileDiagnostics(ctx.path, producer, []);
      },
    };
  });
}

function fixes(view: EditorView, from: number, to: number): ContributedIntention[] {
  if (view.state.readOnly) return [];
  const doc = view.state.doc;
  return inspectDotEnv(doc.toString(), dotenvFileOf(doc))
    .filter((p) => p.fix && p.from <= to && p.to >= from)
    .map((p) => ({
      id: `dotenv.fix:${p.producer}:${p.from}`,
      label: p.fix!.label,
      quickFix: true,
      run: () => {
        if (view.state.doc !== doc) return;
        view.dispatch({ changes: p.fix!.edits, userEvent: "input.quickfix" });
      },
    }));
}

/** Settings › .env files › Hide values: every value starts folded (Expand shows it). */
const hiddenValues = ViewPlugin.define((view) => {
  if (dotenvPrefs().hideValues) {
    const effects = dotenvFileOf(view.state.doc)
      .properties.filter((p) => p.value && p.value.to > p.value.from)
      .map((p) => foldEffect.of({ from: p.value!.from, to: p.value!.to }));
    if (effects.length) queueMicrotask(() => view.dispatch({ effects }));
  }
  return {};
});

/** Keeps the project model on an open source's unsaved text. */
function liveSource(path: string): Extension {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return EditorView.updateListener.of((u) => {
    if (!u.docChanged) return;
    clearTimeout(timer);
    timer = setTimeout(() => updateOpenSource(path, u.state.doc.toString()), INSPECT_DELAY);
  });
}

// ---------------------------------------------------------------------------

export function dotenvEditorExtension(ctx: EditorDocContext): Extension {
  if (ctx.virtual) return [];
  const kind = docKind(ctx);
  if (!kind) return [];
  const providers = providersFor(ctx.language, ctx.path);
  const symbolAt = (state: EditorState, pos: number) => envSymbolAt(kind, providers, state, pos);

  const definition: ContributedDefinition = Object.assign(
    (view: EditorView, pos: number) => {
      const symbol = symbolAt(view.state, pos);
      if (!symbol?.key) return false;
      if (symbol.kind === "declaration") {
        // ⌘B on a declaration shows its usages, as in IDEA.
        if (!view.state.selection.main.empty || view.state.selection.main.head !== pos)
          view.dispatch({ selection: { anchor: pos } });
        void executeAction("find.showUsages");
      } else void gotoDeclarations(view, symbol);
      return true;
    },
    { covers: (state: EditorState, pos: number) => !!symbolAt(state, pos)?.key },
  );

  const usages: ContributedUsages = (state, pos) => {
    const symbol = symbolAt(state, pos);
    if (!symbol?.key) return null;
    return { symbol: symbol.key, search: async () => ({ locations: await findEnvUsages(symbol.key) }) };
  };

  const parts: Extension[] = [
    EditorState.languageData.of(() => [
      {
        lumaCompletion: codeCompletion(kind, providers),
        [CONTRIBUTED_DEFINITION]: definition,
        [CONTRIBUTED_USAGES]: usages,
      },
    ]),
  ];
  if (kind !== "code") parts.push(liveSource(ctx.path));
  if (kind === "dotenv") {
    parts.push(inspections(ctx), hiddenValues);
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
