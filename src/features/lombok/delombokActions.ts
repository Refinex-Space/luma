/**
 * Refactor › Delombok (IDEA's Delombok group): on the Java file in the editor, or on the
 * Java files and directories selected in the Project view. Every file is read (the editor's
 * text when open), delomboked by Lombok's own `delombok` in one run with its module's
 * classpath, and rewritten in one undoable workspace edit.
 */
import { indentUnit } from "@codemirror/language";
import { activeEditor, editorsFor } from "@/editor/api";
import { registerActions, type ActionContext } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands, nextRequestId, type DelombokInput, type WorkspaceEdit } from "@/platform/ipc";
import { jvmModuleDir } from "@/platform/javaLaunch";
import { useProject } from "@/platform/project";
import { notifications, projectViewSelection, showStatusInfo } from "@/workbench/contributions";
import { LOMBOK_ENABLED } from "./store";
import { applyDelombok, delombokInput, DELOMBOK_TARGETS, hasDelombokWork, type DelombokTarget } from "./delombok";

/** Action ids, `delombok.<target>`. */
export const delombokAction = (target: DelombokTarget) => `delombok.${target}`;

/** Titles for Find Action (the Delombok submenu shows the target's label). */
const TITLES: Record<DelombokTarget, string> = {
  all: "Delombok All Lombok Annotations",
  data: "Delombok @Data",
  value: "Delombok @Value",
  with: "Delombok @With",
  delegate: "Delombok @Delegate",
  builder: "Delombok @Builder",
  superBuilder: "Delombok @SuperBuilder",
  constructors: "Delombok Constructors",
  getter: "Delombok @Getter",
  setter: "Delombok @Setter",
  equalsAndHashCode: "Delombok @EqualsAndHashCode",
  toString: "Delombok @ToString",
  logger: "Delombok @Log",
  fieldNameConstants: "Delombok @FieldNameConstants",
  utilityClass: "Delombok @UtilityClass",
  standardException: "Delombok @StandardException",
};

const SKIP_DIRS = new Set(["target", "build", "out", "bin", "node_modules", ".git", ".gradle", ".idea", ".luma"]);
const isJava = (path: string) => path.endsWith(".java");

/** Java files of `paths` (directories walked, build output skipped). */
export async function javaFilesOf(paths: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  const walk = async (path: string, depth: number) => {
    if (out.length > 2000) return;
    if (isJava(path)) return void out.push(path);
    if (depth > 30) return;
    let entries;
    try {
      entries = await call(commands.fsReadDir(path));
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.kind === "dir") {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) await walk(e.path, depth + 1);
      } else if (isJava(e.name)) out.push(e.path);
    }
  };
  for (const p of paths) await walk(p, 0);
  return [...new Set(out)];
}

/** The files an action applies to: the given paths, the Project view's selection, else the editor's file. */
function targetPaths(ctx: ActionContext | undefined): { paths: string[]; fromEditor: boolean } {
  const arg = ctx?.arg;
  if (Array.isArray(arg) && arg.every((p) => typeof p === "string"))
    return { paths: arg as string[], fromEditor: false };
  const editor = activeEditor();
  if (editor && isJava(editor.ctx.path)) return { paths: [editor.ctx.path], fromEditor: true };
  return { paths: projectViewSelection(), fromEditor: false };
}

async function textOf(path: string): Promise<string | null> {
  const open = editorsFor(path)[0];
  if (open) return open.view.state.doc.toString();
  try {
    return await call(commands.fsReadText(path));
  } catch {
    return null;
  }
}

/** The file's indentation: the editor's unit, else its first indented line's. */
function unitOf(path: string, text: string): string {
  const open = editorsFor(path)[0];
  if (open) return open.view.state.facet(indentUnit);
  const m = /^([ \t]+)\S/m.exec(text);
  return m?.[1]?.startsWith("\t") ? "\t" : "    ";
}

const relOf = (path: string) => {
  const root = useProject.getState().project?.root ?? "";
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
};

/** The classpath of `module` from jdtls (delombok resolves types with it); empty when unknown. */
async function classpathOf(module: string): Promise<string[]> {
  try {
    return (await call(commands.javaResolveLaunch(module, false, false, nextRequestId()))).classPaths;
  } catch {
    return [];
  }
}

function wholeFileEdit(path: string, before: string, after: string): WorkspaceEdit {
  const lines = before.split(/\r\n|\r|\n/);
  const end = { line: lines.length - 1, col: lines[lines.length - 1]!.length };
  return { files: [{ kind: "edit", path, edits: [{ range: { start: { line: 0, col: 0 }, end }, new_text: after }] }] };
}

/** Delomboks `target` in `paths` (files or directories); resolves with the number of files changed. */
export async function delombok(target: DelombokTarget, paths: readonly string[]): Promise<number> {
  const files = await javaFilesOf(paths);
  const work: Array<{ path: string; text: string }> = [];
  for (const path of files) {
    const text = await textOf(path);
    if (text !== null && hasDelombokWork(text, target)) work.push({ path, text });
  }
  const label = DELOMBOK_TARGETS.find((t) => t.id === target)?.label ?? target;
  if (!work.length) {
    showStatusInfo(tx`Nothing to delombok: no ${label} in the selection`);
    return 0;
  }
  showStatusInfo(tx("Delomboking…"));
  // One delombok run per module: each with its own classpath.
  const byModule = new Map<string, typeof work>();
  for (const w of work) {
    const module = jvmModuleDir(relOf(w.path));
    byModule.set(module, [...(byModule.get(module) ?? []), w]);
  }
  const edit: WorkspaceEdit = { files: [] };
  const failures: string[] = [];
  let annotations = 0;
  for (const [module, group] of byModule) {
    const inputs: DelombokInput[] = group.map((w) => ({ path: w.path, text: delombokInput(w.text, target) }));
    const outputs = await call(commands.lombokDelombok(inputs, await classpathOf(module), nextRequestId()));
    outputs.forEach((out, i) => {
      const w = group[i]!;
      if (out.text === null) {
        failures.push(`${relOf(w.path)}: ${out.error ?? "no output"}`);
        return;
      }
      const crlf = w.text.includes("\r\n");
      const result = applyDelombok(
        w.text.replace(/\r\n/g, "\n"),
        out.text.replace(/\r\n/g, "\n"),
        target,
        unitOf(w.path, w.text),
      );
      const next = crlf ? result.text.replace(/\n/g, "\r\n") : result.text;
      if (next === w.text) return;
      annotations += result.removed;
      edit.files.push(...wholeFileEdit(w.path, w.text, next).files);
    });
  }
  if (edit.files.length) await call(commands.applyWorkspaceEdit(edit));
  if (failures.length)
    notifications().notify({
      group: "lombok",
      level: "error",
      title: tx("Delombok failed"),
      body: failures.join("\n"),
    });
  if (edit.files.length) {
    const one =
      edit.files.length === 1 && edit.files[0]!.kind === "edit" ? relOf(edit.files[0]!.path).split("/").pop()! : "";
    showStatusInfo(
      one
        ? tx`Delomboked ${String(annotations)} annotations in ${one}`
        : tx`Delomboked ${String(annotations)} annotations in ${String(edit.files.length)} files`,
    );
  }
  return edit.files.length;
}

async function run(target: DelombokTarget, ctx?: ActionContext) {
  const { paths } = targetPaths(ctx);
  if (!paths.length) return;
  try {
    await delombok(target, paths);
  } catch (e) {
    notifications().notify({
      group: "lombok",
      level: "error",
      title: tx("Delombok failed"),
      body: e instanceof Error ? e.message : String(e),
    });
  }
}

export function registerDelombok(): () => void {
  return registerActions(
    DELOMBOK_TARGETS.map((t) => ({
      id: delombokAction(t.id),
      title: TITLES[t.id],
      category: "Refactor",
      icon: t.id === "all" ? "annotation" : undefined,
      keywords: ["delombok", "lombok", t.label],
      when: `projectOpen && ${LOMBOK_ENABLED}`,
      run: (ctx) => run(t.id, ctx),
    })),
  );
}
