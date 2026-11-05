import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProblemRef } from "@/editor/api";

const store = vi.hoisted(() => ({
  openConversation: vi.fn<() => string | null>(),
  sendToConversation: vi.fn(async () => {}),
  startPromptTask: vi.fn(async () => {}),
  addToComposer: vi.fn(),
}));
vi.mock("./store", async (orig) => ({ ...(await orig<typeof import("./store")>()), ...store }));
const { addProblemToContext, fixProblemText, fixWithAgent, problemContext } = await import("./problems");

const problem: ProblemRef = {
  path: "/p/src/Advisor.java",
  rel: "src/Advisor.java",
  fence: "java",
  severity: "warning",
  message: 'A "NullPointerException" could be thrown; "getResult()" can return null.',
  source: "sonarqube",
  code: "java:S2259",
  server: "sonarlint",
  start: { line: 113, column: 68 },
  end: { line: 113, column: 105 },
  lines: { from: 113, to: 113 },
  snippet: "    if (r.getResult() != null) {",
};

beforeEach(() => vi.clearAllMocks());

describe("agent actions on a problem", () => {
  it("fills the Fix Problem prompt with the problem, its origin, location and lines", () => {
    const text = fixProblemText(problem);
    expect(text).toContain("`src/Advisor.java:113:68-105` (sonarqube java:S2259)");
    expect(text).toContain(problem.message);
    expect(text).toContain("113 |     if (r.getResult() != null) {");
  });

  it("sends to the open conversation, else starts one", async () => {
    store.openConversation.mockReturnValue("t1");
    await fixWithAgent(problem);
    expect(store.sendToConversation).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ files: ["/p/src/Advisor.java"], text: fixProblemText(problem) }),
    );
    expect(store.startPromptTask).not.toHaveBeenCalled();

    store.openConversation.mockReturnValue(null);
    await fixWithAgent(problem);
    expect(store.startPromptTask).toHaveBeenCalledWith(expect.objectContaining({ text: fixProblemText(problem) }));
  });

  it("adds the problem and its lines as chips, without sending", () => {
    expect(problemContext(problem)).toEqual([
      {
        kind: "note",
        label: "sonarqube java:S2259 · Advisor.java:113",
        text: `Problem (sonarqube java:S2259) at src/Advisor.java:113:68-105:\n${problem.message}`,
      },
      {
        kind: "file",
        path: "/p/src/Advisor.java",
        rel: "src/Advisor.java",
        dir: false,
        lines: { from: 113, to: 113 },
        code: problem.snippet,
      },
    ]);
    store.openConversation.mockReturnValue(null);
    addProblemToContext(problem);
    expect(store.addToComposer).toHaveBeenCalledWith("home", problemContext(problem));
    expect(store.sendToConversation).not.toHaveBeenCalled();
  });
});
