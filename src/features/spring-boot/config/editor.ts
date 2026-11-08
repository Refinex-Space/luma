/**
 * Spring Boot configuration files (`application*.properties` / `application*.yml` of Boot
 * modules): completion of keys and values with YAML's structured insertion, Quick
 * Documentation, navigation of values and `${…}` placeholders, and the Spring Boot inspections
 * with their quick fixes. The analysis runs in the backend (`ide_spring_boot`) against the
 * metadata of the file's module.
 */
import {
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { EditorState, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet } from "@codemirror/view";
import {
  CONTRIBUTED_DEFINITION,
  CONTRIBUTED_HOVER,
  intentionProviders,
  quickFixProviders,
  type ContributedDefinition,
  type ContributedHover,
  type ContributedIntention,
  type EditorDocContext,
  editorsFor,
} from "@/editor/api";
import { setFileDiagnostics } from "@/editor/lsp/diagnostics";
import { showHint } from "@/editor/lsp/hint";
import { renderMarkup } from "@/editor/lsp/markdown";
import { chooserTitle, locationItems, navigateTo } from "@/editor/lsp/navigation";
import { caretAnchor, openPopup } from "@/editor/lsp/popupStore";
import { offsetsToRange } from "@/editor/lsp/positions";
import { editorService } from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";
import { tx, txTemplate } from "@/platform/i18n";
import {
  inspectionOption,
  inspectionProfile,
  SPRING_BOOT_PRODUCERS,
  SPRING_BOOT_REPLACEMENT_TOKENS,
  subscribeInspectionProfile,
} from "@/platform/inspections";
import {
  call,
  commands,
  onIdeEvent,
  type BootCompletion,
  type BootCompletionItem,
  type BootItemKind,
  type BootProblem,
  type BootSeverity,
  type Diagnostic,
} from "@/platform/ipc";
import { springBootPrefs } from "@/platform/springBootSettings";
import { useProject } from "@/platform/project";
import { hoverMarkdown, propertyDocMarkdown } from "./docs";
import { propertiesKeyText, yamlKeyEdit, type KeyEdit } from "./insert";
import { bootStatus } from "../status";

const INSPECT_DELAY = 300;

/** Files whose change can change a module's metadata. */
const METADATA_INPUT = /(spring-configuration-metadata\.json|\.java|pom\.xml|build\.gradle(\.kts)?)$/;

/** Whether `path` is named like a Spring Boot configuration file (the backend decides finally). */
export function isConfigPath(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? "";
  const m = /^(.+?)(?:-[^.]+)?\.(properties|ya?ml)$/.exec(name);
  if (!m) return false;
  const prefs = springBootPrefs();
  if (m[1] === "application" || prefs.configNames.includes(m[1]!)) return true;
  const root = useProject.getState().project?.root ?? "";
  return prefs.configFiles.some((f) => path === f || path === `${root}/${f}`);
}

const ICONS: Record<BootItemKind, string> = {
  property: "symbol-property",
  group: "symbol-namespace",
  value: "symbol-constant",
  enum: "symbol-enum",
  keyword: "symbol-keyword",
  profile: "spring",
  file: "symbol-file",
  class: "symbol-class",
  logger: "symbol-package",
  bean: "gutter-spring-bean",
};

// ---------------------------------------------------------------------------
// Inserted lines flash once (where a YAML key was merged)

const flashLines = StateEffect.define<readonly number[]>();
const flashMark = Decoration.line({ class: "cm-boot-inserted" });

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    let next = set.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(flashLines)) continue;
      next = e.value.length
        ? Decoration.set(
            e.value.map((pos) => flashMark.range(tr.state.doc.lineAt(pos).from)),
            true,
          )
        : Decoration.none;
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const flashTheme = EditorView.baseTheme({
  "@keyframes cm-boot-inserted": {
    from: { backgroundColor: "var(--luma-editor-search-match, rgba(255, 200, 0, 0.28))" },
    to: { backgroundColor: "transparent" },
  },
  ".cm-boot-inserted": { animation: "cm-boot-inserted 600ms ease-out" },
});

function applyKeyEdit(view: EditorView, edit: KeyEdit) {
  view.dispatch({
    changes: edit.changes,
    selection: { anchor: edit.cursor },
    userEvent: "input.complete",
    scrollIntoView: true,
  });
  // The lines the edit wrote, in the new document.
  const inserted: number[] = [];
  let shift = 0;
  for (const c of [...edit.changes].sort((a, b) => a.from - b.from)) {
    if (c.insert.includes("\n")) {
      const start = c.from + shift;
      for (let i = 0, at = start; i <= c.insert.length; i++) {
        if (i === c.insert.length || c.insert[i] === "\n") {
          if (at <= view.state.doc.length) inserted.push(at);
          at = start + i + 1;
        }
      }
    }
    shift += c.insert.length - (c.to - c.from);
  }
  if (inserted.length > 1) {
    view.dispatch({ effects: flashLines.of(inserted) });
    setTimeout(() => view.dom.isConnected && view.dispatch({ effects: flashLines.of([]) }), 650);
  }
  if (edit.retrigger) setTimeout(() => view.dom.isConnected && startCompletion(view), 0);
}

// ---------------------------------------------------------------------------
// Completion

type BootOption = Completion & { icon: string; typeText?: string; deprecated?: boolean };

async function describeInfo(path: string, key: string): Promise<Node | null> {
  const doc = await call(commands.springBootDescribe(path, key)).catch(() => null);
  if (!doc) return null;
  const el = document.createElement("div");
  el.appendChild(renderMarkup({ kind: "markdown", value: propertyDocMarkdown(doc) }, null));
  return el;
}

function option(path: string, res: BootCompletion, item: BootCompletionItem, yaml: boolean): BootOption {
  const o: BootOption = {
    label: item.label,
    type: item.kind === "property" ? "property" : item.kind,
    icon: ICONS[item.kind],
    boost: Math.max(-99, Math.min(99, item.boost)),
    deprecated: item.deprecated,
  };
  if (item.detail) o.typeText = item.detail;
  if (item.isDefault) o.detail = tx("default");
  else if (item.replacement) o.detail = `→ ${item.replacement}`;
  if (item.key) o.info = () => describeInfo(path, item.key!);
  else if (item.description) {
    const text = item.description;
    o.info = () => {
      const el = document.createElement("div");
      el.appendChild(renderMarkup({ kind: "markdown", value: text }, null));
      return el;
    };
  }
  const isKey = item.kind === "property" || item.kind === "group";
  if (isKey && yaml && res.yaml && item.elements.length) {
    const ctx = res.yaml;
    o.apply = (view, _c, from, to) => {
      // Typing since the request lengthened the line: paths after it moved as much.
      const line = view.state.doc.lineAt(from);
      const delta = line.to - ctx.lineTo;
      const fresh = {
        ...ctx,
        lineFrom: line.from,
        lineTo: line.to,
        paths: ctx.paths.map((p) => (p.at > ctx.lineFrom ? { ...p, at: p.at + delta } : p)),
      };
      applyKeyEdit(view, yamlKeyEdit(view.state.doc.toString(), fresh, from, to, item.elements, item.suffix));
    };
  } else if (isKey && !yaml) {
    o.apply = (view, _c, from, to) => {
      const { text, retrigger } = propertiesKeyText(item.insert ?? item.label, item.suffix);
      applyKeyEdit(view, { changes: [{ from, to, insert: text }], cursor: from + text.length, retrigger });
    };
  } else if (item.insert) {
    o.apply = item.insert;
  }
  return o;
}

function completionSource(path: string, yaml: boolean) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const status = await bootStatus(path);
    if (!status?.configFile) return null;
    const res = await call(commands.springBootComplete(path, ctx.state.doc.toString(), ctx.pos, ctx.explicit)).catch(
      () => null,
    );
    if (!res || ctx.aborted) return null;
    return {
      from: res.from,
      options: res.items.map((i) => option(path, res, i, yaml)),
      validFor: res.complete ? /^[\w.\-[\]]*$/ : undefined,
    };
  };
}

// ---------------------------------------------------------------------------
// Hover and navigation

function hover(path: string): ContributedHover {
  return async (state, pos) => {
    const status = await bootStatus(path);
    if (!status?.configFile) return null;
    const h = await call(commands.springBootHover(path, state.doc.toString(), pos)).catch(() => null);
    if (!h) return null;
    return { from: h.from, to: h.to, markdown: hoverMarkdown(h.content) };
  };
}

/** Whether `pos` is in a value or a `${…}` (keys navigate through the Java language server). */
function inValue(state: EditorState, pos: number, yaml: boolean): boolean {
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  if (/\$\{[^}]*$/.test(before)) return true;
  if (/^\s*[#!]/.test(line.text)) return false;
  if (yaml) return /:\s/.test(before) || /^\s*-\s/.test(before);
  return /^[^=:]*[=:]/.test(before) || /^\s*\S+\s+\S/.test(before);
}

function definition(path: string, yaml: boolean): ContributedDefinition {
  return Object.assign(
    (view: EditorView, pos: number) => {
      if (!inValue(view.state, pos, yaml)) return false;
      void (async () => {
        const status = await bootStatus(path);
        const locations = status?.configFile
          ? await call(commands.springBootNavigate(path, view.state.doc.toString(), pos)).catch(() => [])
          : [];
        if (!locations.length) {
          showHint(view, tx("Cannot find declaration to go to"), { pos });
          return;
        }
        if (locations.length === 1) return navigateTo(locations[0]!);
        const word = view.state.wordAt(pos);
        openPopup({
          kind: "list",
          anchor: caretAnchor(view, pos),
          title: chooserTitle("declaration", word ? view.state.sliceDoc(word.from, word.to) : null, locations.length),
          items: await locationItems(locations),
        });
      })();
      return true;
    },
    { covers: (state: EditorState, pos: number) => inValue(state, pos, yaml) },
  );
}

// ---------------------------------------------------------------------------
// Inspections

const SEVERITY: Record<BootSeverity, Diagnostic["severity"]> = {
  error: "error",
  warning: "warning",
  weakWarning: "info",
};

/** Producers of the configuration file checks. */
const CONFIG_PRODUCERS = [
  SPRING_BOOT_PRODUCERS.SpringBootApplicationProperties,
  SPRING_BOOT_PRODUCERS.SpringBootApplicationYaml,
  SPRING_BOOT_PRODUCERS.SpringBootProfileSpecificProperty,
  SPRING_BOOT_PRODUCERS.SpringBootConfigImport,
  SPRING_BOOT_PRODUCERS.SpringBootUnresolvedPlaceholder,
  SPRING_BOOT_PRODUCERS.SpringDataNoDriverDependency,
];

interface Analysis {
  doc: Text;
  problems: BootProblem[];
}

const analyses = new WeakMap<EditorView, Analysis>();

/** The Replacement tokens option of the file's inspection. */
function replacementTokens(yaml: boolean): boolean {
  const producer = yaml
    ? SPRING_BOOT_PRODUCERS.SpringBootApplicationYaml
    : SPRING_BOOT_PRODUCERS.SpringBootApplicationProperties;
  return inspectionOption(inspectionProfile(), `builtin:${producer}`, SPRING_BOOT_REPLACEMENT_TOKENS);
}

export function problemDiagnostics(
  doc: Text,
  problems: readonly BootProblem[],
  producers: readonly string[],
): Map<string, Diagnostic[]> {
  const out = new Map<string, Diagnostic[]>(producers.map((p) => [p, []]));
  for (const p of problems) {
    if (p.to > doc.length) continue;
    const producer = SPRING_BOOT_PRODUCERS[p.inspection];
    const d: Diagnostic = {
      range: offsetsToRange(doc, p.from, p.to),
      severity: SEVERITY[p.severity],
      message: txTemplate(p.message),
      source: "Spring Boot",
      code: null,
    };
    if (p.deprecated) d.deprecated = true;
    out.get(producer)?.push(d);
  }
  return out;
}

async function defineKey(view: EditorView, path: string, name: string, ty: string) {
  let result = await call(commands.springBootDefineKey(path, name, ty, null)).catch((e: Error) => {
    showHint(view, e.message);
    return null;
  });
  if (!result) return;
  if (result.created) {
    // IDEA: "Cannot locate the additional metadata file. A new file will be created".
    const root = useProject.getState().project?.root ?? "";
    const shown = result.path.startsWith(`${root}/`) ? result.path.slice(root.length + 1) : result.path;
    const ok = await confirm({
      title: tx("Define Configuration Key"),
      message: tx`Create the additional metadata file ${shown}?`,
      ok: tx("Create"),
    });
    if (!ok) return;
    const dir = result.path.slice(0, result.path.lastIndexOf("/"));
    await call(commands.fsCreateDir(dir)).catch(() => {});
    await call(commands.fsCreateFile(result.path)).catch(() => {});
  }
  await editorService().openFile(result.path, { focus: true });
  const target = editorsFor(result.path)[0]?.view;
  if (!target) return;
  const current = target.state.doc.toString();
  if (current.trim() !== "")
    result = (await call(commands.springBootDefineKey(path, name, ty, current)).catch(() => null)) ?? result;
  target.dispatch({
    changes: { from: 0, to: target.state.doc.length, insert: result.text },
    selection: { anchor: result.selectFrom, head: result.selectTo },
    userEvent: "input.quickfix",
    scrollIntoView: true,
  });
  target.focus();
  // The key is known once the metadata is saved: the configuration file is checked again then.
}

function intentions(view: EditorView, path: string, a: Analysis, from: number, to: number): ContributedIntention[] {
  const profile = inspectionProfile();
  return a.problems
    .filter((p) => p.fixes.length && p.from <= to && from <= p.to)
    .filter((p) => profile[`builtin:${SPRING_BOOT_PRODUCERS[p.inspection]}`]?.enabled !== false)
    .flatMap((p) =>
      p.fixes.map((f, i): ContributedIntention => ({
        id: `spring-boot.fix:${p.inspection}:${p.from}:${i}`,
        label: txTemplate(f.label),
        icon: "bulb-fix",
        quickFix: true,
        run: async () => {
          if (f.define) return defineKey(view, path, f.define.name, f.define.ty);
          if (view.state.doc !== a.doc || view.state.readOnly) return;
          if (f.workspace) await call(commands.applyWorkspaceEdit(f.workspace));
          if (f.edits.length) view.dispatch({ changes: f.edits, userEvent: "input.quickfix", scrollIntoView: true });
          view.focus();
        },
      })),
    );
}

/**
 * Publishes the problems `fetch` finds in the file (debounced), refreshed on edits, profile and
 * settings changes, and when a module's metadata may have changed.
 */
export function inspectionsExtension(
  path: string,
  producers: readonly string[],
  fetch: (text: string) => Promise<BootProblem[]>,
): Extension {
  return ViewPlugin.define((view) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    const publish = async () => {
      const gen = ++generation;
      const doc = view.state.doc;
      const status = await bootStatus(path);
      const problems = status ? await fetch(doc.toString()).catch(() => []) : [];
      if (gen !== generation || view.state.doc !== doc) return;
      analyses.set(view, { doc, problems });
      for (const [producer, items] of problemDiagnostics(doc, problems, producers))
        setFileDiagnostics(path, producer, items);
    };
    const schedule = (delay = INSPECT_DELAY) => {
      clearTimeout(timer);
      timer = setTimeout(() => void publish(), delay);
    };
    schedule(0);
    const offs = [
      subscribeInspectionProfile(() => schedule()),
      useProject.subscribe((s, prev) => s.settings?.springBoot !== prev.settings?.springBoot && schedule()),
      // New metadata (a build, a saved additional metadata file, an edited properties class).
      onIdeEvent("fsChanged", (e) => {
        if ([...e.created, ...e.modified, ...e.removed].some((p) => METADATA_INPUT.test(String(p)))) schedule(800);
      }),
    ];
    return {
      update: (u) => {
        if (u.docChanged) schedule();
      },
      destroy: () => {
        clearTimeout(timer);
        generation++;
        offs.forEach((off) => off());
        for (const producer of producers) setFileDiagnostics(path, producer, []);
      },
    };
  });
}

/** Quick fixes (⌥↵ and the problem popup) of the problems the inspections found. */
export function fixesExtension(path: string): Extension {
  const fixes = (view: EditorView, from: number, to: number) => {
    const a = analyses.get(view);
    return a && a.doc === view.state.doc ? intentions(view, path, a, from, to) : [];
  };
  return [
    quickFixProviders.of(fixes),
    intentionProviders.of((view) => {
      const { head } = view.state.selection.main;
      return fixes(view, head, head);
    }),
  ];
}

export function configEditorExtension(ctx: EditorDocContext): Extension {
  if (ctx.virtual || ctx.doc < 0 || !isConfigPath(ctx.path)) return [];
  const yaml = /\.ya?ml$/i.test(ctx.path);
  const path = ctx.path;
  const parts: Extension[] = [
    flashField,
    flashTheme,
    EditorState.languageData.of(() => [
      {
        lumaCompletion: completionSource(path, yaml),
        [CONTRIBUTED_HOVER]: hover(path),
        [CONTRIBUTED_DEFINITION]: definition(path, yaml),
      },
    ]),
    inspectionsExtension(path, CONFIG_PRODUCERS, async (text) => {
      const status = await bootStatus(path);
      return status?.configFile ? call(commands.springBootProblems(path, text, replacementTokens(yaml))) : [];
    }),
  ];
  if (!ctx.readOnly) parts.push(fixesExtension(path));
  return parts;
}
