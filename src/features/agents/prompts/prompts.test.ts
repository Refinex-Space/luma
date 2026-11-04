import { beforeEach, describe, expect, it } from "vitest";
import type { AgentProvider } from "@/bindings";
import { expandPromptCommand } from "./expand";
import { cleanAnswer, generationChoice } from "./generate";
import { BUILTIN_GROUPS, commandName, fillTemplate, variableTokens } from "./library";
import {
  addGroup,
  addPrompt,
  editPrompt,
  isEdited,
  libraryGroups,
  promptById,
  promptCommands,
  resetAllPrompts,
  resetPrompt,
  setCommand,
  usePromptLibrary,
} from "./store";

beforeEach(() => {
  localStorage.clear();
  usePromptLibrary.setState({ edited: {}, added: {}, groups: [], generation: null });
});

describe("templates", () => {
  it("fill the variables they know, keep other $words, and write $$ as $", () => {
    const text = "On $GIT_BRANCH_NAME: $SELECTION costs $$5, see $HOME";
    expect(fillTemplate(text, { GIT_BRANCH_NAME: "main" })).toBe("On main:  costs $5, see $HOME");
  });

  it("mark the variables a prompt's action does not fill", () => {
    const tokens = variableTokens("$GIT_DIFF and $SELECTION, $$", ["GIT_DIFF"]);
    expect(tokens.map((t) => [t.name, t.known])).toEqual([
      ["GIT_DIFF", true],
      ["SELECTION", false],
    ]);
  });

  it("ship a default for every built-in prompt, its variables filled by its action", () => {
    for (const p of BUILTIN_GROUPS.flatMap((g) => g.prompts)) {
      expect(p.text.trim(), p.id).not.toBe("");
      const unknown = variableTokens(p.text, p.variables ?? []).filter((t) => !t.known);
      expect(unknown, p.id).toEqual([]);
    }
    expect(commandName("  Review API Changes! ")).toBe("review-api-changes");
  });
});

describe("the library", () => {
  it("edits a built-in prompt and puts it back", () => {
    editPrompt("builtin.commit-message", { text: "Short messages only." });
    expect(promptById("builtin.commit-message")!.text).toBe("Short messages only.");
    expect(isEdited("builtin.commit-message")).toBe(true);
    resetPrompt("builtin.commit-message");
    expect(isEdited("builtin.commit-message")).toBe(false);
    expect(promptById("builtin.commit-message")!.text).toContain("$GIT_DIFF");
    // Setting the shipped text again is no edit either.
    editPrompt("docs.java", { text: "x" });
    editPrompt("tests.go", { text: "y" });
    resetAllPrompts();
    expect(usePromptLibrary.getState().edited).toEqual({});
  });

  it("adds groups and prompts of one's own, each with a /command no other prompt has", () => {
    const group = addGroup("Mine");
    const a = addPrompt(group);
    const b = addPrompt(group);
    expect(promptById(a)!.command).toBe("new-prompt");
    expect(promptById(b)!.command).toBe("new-prompt-2");
    setCommand(b, "Find Problems");
    // Taken by the built-in Find Problems.
    expect(promptById(b)!.command).toBe("find-problems-2");
    const added = addPrompt("chat");
    expect(
      libraryGroups(usePromptLibrary.getState())
        .find((g) => g.id === "chat")!
        .prompts.at(-1)!.id,
    ).toBe(added);
    expect(promptCommands(usePromptLibrary.getState()).map((c) => c.name)).toEqual([
      "find-problems",
      "new-prompt-2",
      "new-prompt",
      "find-problems-2",
    ]);
  });

  it("sends a /command as its prompt, the rest of the message as $USER_INPUT", () => {
    const group = addGroup("Mine");
    const id = addPrompt(group);
    editPrompt(id, { text: "Review the API of $USER_INPUT for breaking changes." });
    setCommand(id, "api");
    expect(expandPromptCommand("/api OrderController")).toBe("Review the API of OrderController for breaking changes.");
    // Without $USER_INPUT the rest follows the prompt.
    editPrompt(id, { text: "Be brief." });
    expect(expandPromptCommand("/api and polite")).toBe("Be brief.\n\nand polite");
    // The agent's own command of that name is its; other text is sent as written.
    expect(expandPromptCommand("/api x", ["api"])).toBe("/api x");
    expect(expandPromptCommand("hello /api")).toBe("hello /api");
  });
});

describe("one-off generation", () => {
  const provider = (id: string, installed = true) => ({ id, installed }) as AgentProvider;

  it("uses the chosen agent while installed, else the last task's, else the first installed", () => {
    const providers = [provider("codex"), provider("pi-acp"), provider("gemini", false)];
    const chosen = { provider: "pi-acp", config: [{ id: "model", value: "m" }] };
    expect(generationChoice(providers, chosen, "codex")).toEqual({ choice: chosen, stale: false });
    expect(generationChoice(providers, { provider: "gemini", config: [] }, "codex")).toEqual({
      choice: { provider: "codex", config: [] },
      stale: true,
    });
    expect(generationChoice(providers, null, "nope")!.choice.provider).toBe("codex");
    expect(generationChoice([provider("gemini", false)], null, null)).toBeNull();
  });

  it("takes the answer out of a code fence", () => {
    expect(cleanAnswer("```text\nfeat: add paging\n```")).toBe("feat: add paging");
    expect(cleanAnswer("  fix: x  ")).toBe("fix: x");
  });
});
