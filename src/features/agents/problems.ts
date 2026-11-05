/**
 * Agent actions on a problem in the editor (its hover card, ⋮ menu and ⌥↵):
 * - Fix with Agent: the Prompt Library's Fix Problem prompt, sent to the conversation the user
 *   has open (queued while it works), else to a new one.
 * - Add to Agent Context: the problem and its lines as chips in that composer, sent by the user.
 */
import type { ProblemAction, ProblemRef } from "@/editor/api";
import { numberedSnippet, problemRange } from "@/editor/lsp/problems";
import { basename } from "@/platform/project";
import { tx } from "@/platform/i18n";
import { notifications } from "@/workbench/contributions";
import type { ContextItem } from "./contextModel";
import { fillTemplate, languageOf, type VariableValues } from "./prompts/library";
import { promptById } from "./prompts/store";
import { localValues } from "./prompts/values";
import { addToComposer, HOME, openConversation, sendToConversation, startPromptTask } from "./store";

const SEVERITY: Record<ProblemRef["severity"], string> = {
  error: "error",
  warning: "warning",
  info: "info",
  hint: "hint",
};

/** `sonarqube java:S2259`, else the severity. */
const origin = (p: ProblemRef) => [p.source, p.code].filter(Boolean).join(" ") || SEVERITY[p.severity];

/** The Prompt Library's variables for `problem`. */
export function problemValues(problem: ProblemRef): VariableValues {
  return {
    ...localValues(),
    FILE_PATH: problem.rel,
    FILE_NAME: basename(problem.path),
    LANGUAGE: languageOf(problem.path),
    SELECTION: problem.snippet,
    PROBLEM: problem.message,
    PROBLEM_ORIGIN: origin(problem),
    PROBLEM_LOCATION: `${problem.rel}:${problemRange(problem)}`,
    PROBLEM_CODE: numberedSnippet(problem),
  };
}

/** The message Fix with Agent sends. */
export function fixProblemText(problem: ProblemRef): string {
  const prompt = promptById("chat.fix-problem");
  return prompt ? fillTemplate(prompt.text, problemValues(problem)).trim() : problem.message;
}

export async function fixWithAgent(problem: ProblemRef): Promise<void> {
  const prompt = { text: fixProblemText(problem), files: [problem.path], images: [] };
  try {
    const task = openConversation();
    if (task) await sendToConversation(task, prompt);
    else await startPromptTask(prompt);
  } catch (e) {
    notifications().notify({
      level: "error",
      title: tx("Couldn't send the problem to the agent"),
      body: e instanceof Error ? e.message : String(e),
    });
  }
}

/** The chips Add to Agent Context writes: the problem as a note, its lines as a selection. */
export function problemContext(problem: ProblemRef): ContextItem[] {
  const where = `${problem.rel}:${problemRange(problem)}`;
  return [
    {
      kind: "note",
      label: `${origin(problem)} · ${basename(problem.path)}:${problem.start.line}`,
      text: [`Problem (${origin(problem)}) at ${where}:`, problem.message].join("\n"),
    },
    {
      kind: "file",
      path: problem.path,
      rel: problem.rel,
      dir: false,
      lines: problem.lines,
      code: problem.snippet,
    },
  ];
}

export function addProblemToContext(problem: ProblemRef) {
  addToComposer(openConversation() ?? HOME, problemContext(problem));
}

/** The two actions, on every problem that has a file. */
export function agentProblemActions(problem: ProblemRef): ProblemAction[] {
  return [
    {
      id: "agents.fixProblem",
      label: "Fix with Agent",
      icon: "toolwindow-agents",
      primary: true,
      run: () => fixWithAgent(problem),
    },
    {
      id: "agents.addProblemToContext",
      label: "Add to Agent Context",
      icon: "plus",
      run: () => addProblemToContext(problem),
    },
  ];
}
