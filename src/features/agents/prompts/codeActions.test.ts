import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  openConversation: vi.fn<() => string | null>(),
  sendToConversation: vi.fn(async () => {}),
  startPromptTask: vi.fn(async () => {}),
}));
vi.mock("../store", async (orig) => ({ ...(await orig<typeof import("../store")>()), ...store }));
const { codeAction, codeActionMessage, codeActionPrompt } = await import("./generate");
const { useI18n } = await import("@/platform/i18n");

const method = {
  path: "/p/src/ModerationVerdict.java",
  rel: "src/ModerationVerdict.java",
  lines: { from: 26, to: 48 },
  code: "public static ModerationVerdict from(ModerationResponse response) {\n  return null;\n}",
  name: "from",
  kind: "method",
};

beforeEach(() => vi.clearAllMocks());

describe("AI code actions on a method", () => {
  it("use the Prompt Library: Explain / Optimize built-ins, documentation and tests by language", () => {
    expect(codeActionPrompt("explain", method.path)?.id).toBe("chat.explain-code");
    expect(codeActionPrompt("optimize", method.path)?.id).toBe("chat.optimize-code");
    expect(codeActionPrompt("documentation", method.path)?.id).toBe("docs.java");
    expect(codeActionPrompt("unitTests", method.path)?.id).toBe("tests.java");
  });

  it("send the method's code, the file and where the method is", () => {
    useI18n.setState({ locale: "zh" });
    const message = codeActionMessage("explain", method)!;
    expect(message.text).toContain("Explain the Java code below, from `src/ModerationVerdict.java`");
    expect(message.text).toContain("Answer in Simplified Chinese.");
    expect(message.text).toContain(method.code);
    expect(message.files).toEqual([method.path]);
    expect(message.context).toEqual([
      {
        label: "ModerationVerdict.java:26-48",
        text: "Context: lines 26-48 of /p/src/ModerationVerdict.java (the method `from`)",
      },
    ]);
    expect(codeActionMessage("unitTests", method)!.text).toContain("Write unit tests for the Java code below");
    useI18n.setState({ locale: "en" });
  });

  it("go to the open conversation, else a new one", async () => {
    store.openConversation.mockReturnValue("t1");
    await codeAction("optimize", method);
    expect(store.sendToConversation).toHaveBeenCalledWith("t1", codeActionMessage("optimize", method));
    store.openConversation.mockReturnValue(null);
    await codeAction("documentation", method);
    expect(store.startPromptTask).toHaveBeenCalledWith(codeActionMessage("documentation", method));
  });
});
