/** A Prompt Library `/command` in a message, turned into its prompt when the message is sent. */
import { fillTemplate } from "./library";
import { libraryGroups, usePromptLibrary } from "./store";
import { localValues } from "./values";

/**
 * The message with a leading Prompt Library command replaced by its prompt: `/name rest`
 * becomes the prompt's template filled in, `rest` as `$USER_INPUT`. A template without
 * `$USER_INPUT` gets `rest` after it. Any other text is sent as written.
 *
 * @param text the message, its commands already moved to its start
 * @param agentCommands the agent's own commands: a name it has is its, not the library's
 * @returns what is sent
 */
export function expandPromptCommand(text: string, agentCommands: readonly string[] = []): string {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!m || agentCommands.includes(m[1]!)) return text;
  const prompt = libraryGroups(usePromptLibrary.getState())
    .flatMap((g) => g.prompts)
    .find((p) => p.command === m[1]);
  if (!prompt) return text;
  const input = (m[2] ?? "").trim();
  const filled = fillTemplate(prompt.text, { ...localValues(), USER_INPUT: input }).trim();
  return prompt.text.includes("$USER_INPUT") || !input ? filled : `${filled}\n\n${input}`;
}
