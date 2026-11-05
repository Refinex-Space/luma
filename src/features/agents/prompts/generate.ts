/**
 * The Prompt Library's built-in actions: one-off generations (a commit message, a pull request
 * description) answered by the agent chosen for them, and the actions that start a
 * conversation (self-review, documentation, unit tests, find problems, a chat on the
 * selection).
 */
import { create } from "zustand";
import type { AgentPrompt, AgentProvider } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, commands, nextRequestId, type RequestId } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { notifications } from "@/workbench/contributions";
import { activeEditor } from "@/editor/api";
import { REGISTRY_PAGE } from "../model";
import { sendSelection } from "../references";
import { openConversation, openHome, sendToConversation, startPromptTask, useAgents } from "../store";
import { isVirtualUri } from "@/platform/virtualDocs";
import { fillTemplate, languageOf, type Prompt, type VariableValues } from "./library";
import { libraryGroups, promptById, usePromptLibrary, type GenerationChoice } from "./store";
import { changeValues, commitValues, localValues } from "./values";

/** Settings › AI › Prompt Library. */
export const PROMPTS_PAGE = "ai.prompts";

/** One-off generations under way, by what they are for: clicking again cancels. */
export type GenerationKind = "commitMessage" | "prSummary";
export const useGenerating = create<Partial<Record<GenerationKind, RequestId>>>(() => ({}));

const openPrompt = (id: string) => () => void executeAction("file.settings", `${PROMPTS_PAGE}#${id}`);

/**
 * The agent a one-off generation uses: the one chosen in the Prompt Library while installed,
 * else the one the last task used, else the first installed one (with its default model).
 *
 * @param providers the agents Luma knows
 * @param chosen the Prompt Library's choice
 * @returns the agent and its settings, or `null` when no agent is installed; `stale` when the
 *   chosen agent is not installed any more (the caller says so)
 */
export function generationChoice(
  providers: readonly AgentProvider[],
  chosen: GenerationChoice | null,
  last: string | null,
): { choice: GenerationChoice; stale: boolean } | null {
  const installed = providers.filter((p) => p.installed);
  if (chosen && installed.some((p) => p.id === chosen.provider)) return { choice: chosen, stale: false };
  const fallback = installed.find((p) => p.id === last) ?? installed[0];
  return fallback ? { choice: { provider: fallback.id, config: [] }, stale: !!chosen } : null;
}

/** The agent's answer without what models wrap it in (a code fence, quotes). */
export function cleanAnswer(text: string): string {
  let t = text.trim();
  const fence = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(t);
  if (fence) t = fence[1]!.trim();
  return t;
}

/**
 * Asks the chosen agent for `prompt`'s text with `values` filled in.
 *
 * @param kind what for: one at a time, a second call while one runs cancels it
 * @param promptId the prompt (its settings page entry is where errors lead)
 * @param values the template's values
 * @returns the answer, or `null` when cancelled or failed (the user was told how to go on)
 */
async function generate(kind: GenerationKind, promptId: string, values: VariableValues): Promise<string | null> {
  const prompt = promptById(promptId);
  if (!prompt) return null;
  const { providers, draft } = useAgents.getState();
  const picked = generationChoice(providers, usePromptLibrary.getState().generation, draft.provider);
  if (!picked) {
    notifications().notify({
      level: "warning",
      title: tx("Install an agent to generate with AI"),
      actions: [{ label: tx("Install an Agent…"), run: () => void executeAction("file.settings", REGISTRY_PAGE) }],
    });
    return null;
  }
  if (picked.stale) {
    notifications().notify({
      level: "info",
      title: tx("The agent chosen for AI generation is not installed: using another one"),
      actions: [{ label: tx("Choose…"), run: openPrompt(promptId) }],
    });
  }
  const id = nextRequestId();
  useGenerating.setState({ [kind]: id });
  try {
    const answer = await call(
      commands.agentGenerate(
        { provider: picked.choice.provider, config: picked.choice.config, prompt: fillTemplate(prompt.text, values) },
        id,
      ),
    );
    return cleanAnswer(answer) || null;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/cancel/i.test(message)) return null;
    const unavailable = /does not offer/.test(message);
    notifications().notify({
      level: "error",
      title: tx(unavailable ? "The model chosen for AI generation is not available" : "AI generation failed"),
      body: message,
      actions: [{ label: tx(unavailable ? "Choose a Model…" : "Settings…"), run: openPrompt(promptId) }],
    });
    return null;
  } finally {
    if (useGenerating.getState()[kind] === id) useGenerating.setState({ [kind]: undefined });
  }
}

/** Cancels the generation of `kind`, when one runs; whether one did. */
export function cancelGeneration(kind: GenerationKind): boolean {
  const id = useGenerating.getState()[kind];
  if (id === undefined) return false;
  void commands.cancelRequest(id);
  useGenerating.setState({ [kind]: undefined });
  return true;
}

/**
 * A commit message for `files` (the changes to commit), written by the chosen agent with the
 * Commit Message Generation prompt.
 *
 * @returns the message, or `null` (cancelled, failed, or nothing to commit)
 */
export async function generateCommitMessage(
  files: ReadonlyArray<{ kind: string; path: string }>,
): Promise<string | null> {
  if (cancelGeneration("commitMessage")) return null;
  if (!files.length) {
    notifications().notify({ level: "info", title: tx("Select the changes to commit first") });
    return null;
  }
  const values = { ...localValues(), ...(await changeValues(files)) };
  return generate("commitMessage", "builtin.commit-message", values);
}

/**
 * A pull request description for `commits` (oldest first), with the GitHub Pull Request AI
 * Summary prompt.
 */
export async function generatePrDescription(
  commits: ReadonlyArray<{ id: string; shortId: string; summary: string }>,
  base: string,
): Promise<string | null> {
  if (cancelGeneration("prSummary")) return null;
  if (!commits.length) return null;
  const values = { ...localValues(), BASE_BRANCH: base, ...(await commitValues(commits)) };
  return generate("prSummary", "docs.pr-summary", values);
}

/**
 * The prompt of a group (documentation, unit tests) for a file's language: the one listing its
 * extension, else the group's first built-in one.
 *
 * @param groupId the group
 * @param path the file
 */
export function promptForFile(groupId: string, path: string | undefined): Prompt | undefined {
  const ext = path?.slice(path.lastIndexOf(".") + 1).toLowerCase() ?? "";
  const prompts = libraryGroups(usePromptLibrary.getState()).find((g) => g.id === groupId)?.prompts ?? [];
  return prompts.find((p) => p.extensions?.includes(ext)) ?? prompts.find((p) => p.builtin);
}

/**
 * Reviews the changes to commit in a new conversation (AI Self-Review).
 *
 * @param files the changes to commit
 */
export async function selfReview(files: ReadonlyArray<{ kind: string; path: string }>): Promise<void> {
  if (!files.length) {
    notifications().notify({ level: "info", title: tx("Select the changes to review first") });
    return;
  }
  const prompt = promptById("builtin.self-review");
  if (!prompt) return;
  const values = { ...localValues(), ...(await changeValues(files)) };
  await startPromptTask({ text: fillTemplate(prompt.text, values).trim(), files: [], images: [] });
}

/** The AI code actions (Prompt Library prompts sent with a piece of code). */
export type CodeActionKind = "explain" | "unitTests" | "documentation" | "optimize" | "findProblems";

/** What a code action is about: a method from its code vision row, or the editor's selection. */
export interface CodeTarget {
  path: string;
  rel: string;
  /** 1-based lines, inclusive. */
  lines: { from: number; to: number };
  code: string;
  /** The method or function, when the target is one. */
  name?: string;
  kind?: string;
}

/** The editor's selection (the lines it touches), else its whole file. */
function editorTarget(): CodeTarget | null {
  const editor = activeEditor();
  if (!editor || isVirtualUri(editor.ctx.path)) return null;
  const { state } = editor.view;
  const sel = state.selection.main;
  const path = editor.ctx.path;
  const rel = localValues().FILE_PATH ?? path;
  if (sel.empty) return { path, rel, lines: { from: 1, to: state.doc.lines }, code: state.doc.toString() };
  // A selection ending at a line start does not include that line.
  const end = sel.to > sel.from && state.doc.lineAt(sel.to).from === sel.to ? sel.to - 1 : sel.to;
  return {
    path,
    rel,
    lines: { from: state.doc.lineAt(sel.from).number, to: state.doc.lineAt(end).number },
    code: state.sliceDoc(sel.from, sel.to),
  };
}

/** The Prompt Library prompt of `action` for a file at `path` (documentation and tests: by its language). */
export function codeActionPrompt(action: CodeActionKind, path: string): Prompt | undefined {
  switch (action) {
    case "explain":
      return promptById("chat.explain-code");
    case "optimize":
      return promptById("chat.optimize-code");
    case "findProblems":
      return promptById("chat.find-problems");
    case "documentation":
      return promptForFile("docs", path);
    case "unitTests":
      return promptForFile("tests", path);
  }
}

/** The Prompt Library's variables for `target`. */
export function codeTargetValues(target: CodeTarget): VariableValues {
  return {
    ...localValues(),
    FILE_PATH: target.rel,
    FILE_NAME: target.path.slice(target.path.lastIndexOf("/") + 1),
    LANGUAGE: languageOf(target.path),
    SELECTION: target.code,
  };
}

/**
 * The message of `action` on `target`: the filled prompt, the file attached, and where the code
 * is as context (the agent can read around it and edit it in place).
 */
export function codeActionMessage(action: CodeActionKind, target: CodeTarget): AgentPrompt | null {
  const prompt = codeActionPrompt(action, target.path);
  if (!prompt) return null;
  const { from, to } = target.lines;
  const lines = from === to ? `line ${from}` : `lines ${from}-${to}`;
  const what = target.name ? ` (the ${target.kind ?? "declaration"} \`${target.name}\`)` : "";
  const file = target.path.slice(target.path.lastIndexOf("/") + 1);
  return {
    text: fillTemplate(prompt.text, codeTargetValues(target)).trim(),
    files: [target.path],
    images: [],
    context: [
      {
        label: from === to ? `${file}:${from}` : `${file}:${from}-${to}`,
        // For the agent, in English (as the composer's selection notes).
        text: ["Context:", lines, "of", target.path].join(" ") + what,
      },
    ],
  };
}

/**
 * Sends a code action's prompt (Explain Code, Generate Unit Tests, Write Documentation, Optimize
 * Code, Find Problems) for `target`, else the editor's selection: to the conversation the user
 * has open (queued while the agent works), else to a new one.
 */
export async function codeAction(action: CodeActionKind, target?: CodeTarget): Promise<void> {
  const t = target ?? editorTarget();
  if (!t) {
    notifications().notify({ level: "info", title: tx("Open a file first") });
    return;
  }
  const message = codeActionMessage(action, t);
  if (!message) return;
  try {
    const task = openConversation();
    if (task) await sendToConversation(task, message);
    else await startPromptTask(message);
  } catch (e) {
    notifications().notify({
      level: "error",
      title: tx("Couldn't send the code to the agent"),
      body: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Opens a new chat on the editor's selection: it as a chip, the prompt as the message to finish. */
export function newChatWithSelection() {
  const values = localValues();
  const prompt = promptById("chat.new-chat-with-selection");
  if (!values.FILE_PATH || !prompt)
    return void notifications().notify({ level: "info", title: tx("Open a file first") });
  sendSelection();
  openHome(fillTemplate(prompt.text, values));
}
