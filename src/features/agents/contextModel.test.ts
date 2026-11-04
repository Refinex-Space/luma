import { describe, expect, it } from "vitest";
import type { AgentCommand } from "@/bindings";
import { canSend, commandTokens, emptyDraft, hoistCommands, toPrompt } from "./composerModel";
import {
  addContext,
  commitNote,
  isSkill,
  matchesQuery,
  middleEllipsis,
  rangeLabel,
  skillsFirst,
  withSkills,
  type ContextItem,
} from "./contextModel";

const file = (rel: string, dir = false): ContextItem => ({ kind: "file", path: `/p/${rel}`, rel, dir });
const commit: Extract<ContextItem, { kind: "commit" }> = {
  kind: "commit",
  id: "1a2b3c4d5e",
  shortId: "1a2b3c4",
  summary: "Cap page size at 100",
  author: "Ann",
  timeMs: Date.UTC(2026, 10, 4),
};
const command = (name: string, description = ""): AgentCommand => ({ name, description, hint: null });

describe("context chips", () => {
  it("keeps one chip per file, commit or skill", () => {
    const list = addContext([file("a.ts")], [file("a.ts"), file("src", true), commit, commit]);
    expect(list.map((c) => c.kind)).toEqual(["file", "file", "commit"]);
  });

  it("goes with the message: files once, commits as notes, skills as the commands it starts with", () => {
    const draft = {
      ...emptyDraft(),
      text: "look at @a.ts please",
      files: [{ path: "/p/a.ts", rel: "a.ts" }],
      context: [
        file("a.ts"),
        file("src", true),
        commit,
        { kind: "skill", name: "review", description: "" } as ContextItem,
      ],
    };
    const prompt = toPrompt(draft);
    expect(prompt.files).toEqual(["/p/a.ts", "/p/src"]);
    expect(prompt.text).toBe("/review look at @a.ts please");
    expect(prompt.context).toEqual([commitNote(commit)]);
    expect(prompt.context![0]!.text).toBe("Context: commit 1a2b3c4d5e by Ann, 2026-11-04: Cap page size at 100");
  });

  it("can send a chip alone", () => {
    expect(canSend(emptyDraft())).toBe(false);
    expect(canSend({ ...emptyDraft(), context: [file("a.ts")] })).toBe(true);
    expect(withSkills("", [{ kind: "skill", name: "skill:pdf", description: "" }])).toBe("/skill:pdf");
  });

  it("lists skills before the other commands", () => {
    const { skills, others } = skillsFirst([
      command("compact"),
      command("skill:pdf"),
      command("review", "A skill to review"),
    ]);
    expect(skills.map((c) => c.name)).toEqual(["review", "skill:pdf"]);
    expect(others.map((c) => c.name)).toEqual(["compact"]);
    expect(isSkill(command("plan"))).toBe(false);
    expect(matchesQuery("OrderController.java src/main", "order main")).toBe(true);
  });

  it("sends a selection as its lines and code, not the whole file", () => {
    const selection: ContextItem = {
      kind: "file",
      path: "/p/src/KnowledgeBase.java",
      rel: "src/KnowledgeBase.java",
      dir: false,
      lines: { from: 81, to: 86 },
      code: "return chunks.size();",
    };
    const prompt = toPrompt({ ...emptyDraft(), text: "why?", context: [selection, file("src/KnowledgeBase.java")] });
    // The same file whole is a separate chip: it goes as a reference.
    expect(prompt.files).toEqual(["/p/src/KnowledgeBase.java"]);
    expect(prompt.context).toEqual([
      {
        label: "KnowledgeBase.java:81-86",
        text: "Context: lines 81-86 of /p/src/KnowledgeBase.java\n```\nreturn chunks.size();\n```",
      },
    ]);
    expect(rangeLabel("a/B.java", { from: 3, to: 3 })).toBe("B.java:3");
  });

  it("cuts long chip names in the middle, keeping the end", () => {
    expect(middleEllipsis("short.java")).toBe("short.java");
    const cut = middleEllipsis("CappedBatchingStrategyFactoryConfiguration.java:81-86", 30);
    expect([...cut]).toHaveLength(30);
    expect(cut.startsWith("CappedBatchin")).toBe(true);
    expect(cut.endsWith(".java:81-86")).toBe(true);
    expect(cut).toContain("…");
  });
});

describe("commands in the text", () => {
  const names = new Set(["commit", "review"]);

  it("finds the agent's commands written anywhere, as words of their own", () => {
    expect(commandTokens("/commit 测试 /review", names)).toEqual([
      { from: 0, to: 7, name: "commit" },
      { from: 11, to: 18, name: "review" },
    ]);
    // Not commands: unknown names, inside a word, a path.
    expect(commandTokens("/nope a/commit /commit/x", names)).toEqual([]);
  });

  it("sends them first, as an agent only runs a command that starts the message", () => {
    expect(hoistCommands("/commit 测试", ["commit"])).toBe("/commit 测试");
    expect(hoistCommands("fix this /review please", ["review"])).toBe("/review fix this please");
    expect(hoistCommands("测试 /commit", ["commit"])).toBe("/commit 测试");
    // Only the ones the user picked: other slashes stay where they are.
    expect(hoistCommands("see /review", [])).toBe("see /review");
    const prompt = toPrompt({ ...emptyDraft(), text: "测试 /commit", commands: ["commit"] });
    expect(prompt.text).toBe("/commit 测试");
  });
});
