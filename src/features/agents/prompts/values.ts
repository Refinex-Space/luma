/**
 * Values for the Prompt Library's `$VARIABLES`: what is at hand at once (the editor, the
 * project, the branch) and what Git has to be asked for (diffs, commits).
 */
import type { AgentContextNote } from "@/bindings";
import { activeEditor } from "@/editor/api";
import { currentRepo, useVcs } from "@/features/vcs/store";
import { call, commands } from "@/platform/ipc";
import { basename, relativePath, useProject } from "@/platform/project";
import { fillTemplate, languageOf, type VariableValues } from "./library";
import { promptById } from "./store";
import { useI18n } from "@/platform/i18n";

/** `$UI_LANGUAGE`: the interface language, named for an agent. */
const UI_LANGUAGES: Record<string, string> = { en: "English", zh: "Simplified Chinese" };

/** A diff past this many characters is cut (the agent can read the files itself). */
const MAX_DIFF = 60_000;
const RECENT_COMMITS = 10;

/**
 * The values known without asking anyone: the editor's file and selection, the project, the
 * branch and the date.
 *
 * @returns the values; absent ones (no editor, no repository) are left out
 */
export function localValues(): VariableValues {
  const project = useProject.getState().project;
  const values: VariableValues = {
    DATE: new Date().toISOString().slice(0, 10),
    PROJECT_NAME: project?.name,
    GIT_BRANCH_NAME: useVcs.getState().branch?.head ?? undefined,
    UI_LANGUAGE: UI_LANGUAGES[useI18n.getState().locale] ?? "English",
  };
  const editor = activeEditor();
  if (editor) {
    const path = editor.ctx.path;
    const { state } = editor.view;
    const sel = state.selection.main;
    values.FILE_PATH = project?.root && path.startsWith(`${project.root}/`) ? relativePath(project.root, path) : path;
    values.FILE_NAME = basename(path);
    values.LANGUAGE = languageOf(path);
    if (!sel.empty) values.SELECTION = state.sliceDoc(sel.from, sel.to);
  }
  return values;
}

/** `text` cut to `max` characters, saying so. */
function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters cut)`;
}

/**
 * The Git values for local changes: their diff, the changed files and the branch's recent
 * commit messages.
 *
 * @param files the changes, as `[status letter, repository-relative or absolute path]`
 * @returns the values (`GIT_DIFF`, `CHANGED_FILES`, `RECENT_COMMITS`)
 */
export async function changeValues(files: ReadonlyArray<{ kind: string; path: string }>): Promise<VariableValues> {
  const repo = currentRepo();
  const [diff, log] = await Promise.all([
    call(commands.vcsCreatePatch(repo, { from: "changes", paths: files.map((f) => f.path), reverse: false })).catch(
      () => "",
    ),
    call(
      commands.vcsLog(repo, {
        branch: null,
        path: null,
        author: null,
        text: null,
        skip: 0,
        limit: RECENT_COMMITS,
      }),
    ).catch(() => []),
  ]);
  const root = useVcs.getState().root ?? "";
  return {
    GIT_DIFF: cut(diff, MAX_DIFF),
    CHANGED_FILES: files
      .map((f) => `${f.kind} ${root && f.path.startsWith(`${root}/`) ? f.path.slice(root.length + 1) : f.path}`)
      .join("\n"),
    RECENT_COMMITS: log.map((c) => c.message.trim()).join("\n\n---\n\n"),
  };
}

/**
 * The Git values for commits (a pull request): their diff and their list.
 *
 * @param commits the commits, oldest first, as `[id, short id, summary]`
 */
export async function commitValues(
  commits: ReadonlyArray<{ id: string; shortId: string; summary: string }>,
): Promise<VariableValues> {
  const diff = await call(
    commands.vcsCreatePatch(currentRepo(), { from: "commits", commits: commits.map((c) => c.id), reverse: false }),
  ).catch(() => "");
  return {
    GIT_DIFF: cut(diff, MAX_DIFF),
    COMMITS: commits.map((c) => `${c.shortId} ${c.summary}`).join("\n"),
  };
}

/**
 * The Chat Instructions as the note sent with a new conversation's first message, or nothing
 * when they are empty.
 */
export function instructionsNote(): AgentContextNote | null {
  const prompt = promptById("general.chat-instructions");
  const text = prompt ? fillTemplate(prompt.text, localValues()).trim() : "";
  // The text is for the agent: not UI text.
  return text ? { label: "Chat Instructions", text: ["Instructions for this conversation:", text].join("\n") } : null;
}
