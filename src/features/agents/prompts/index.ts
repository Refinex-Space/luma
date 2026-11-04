/**
 * The Prompt Library's contributions: its settings page, the editor's AI Actions (documentation,
 * unit tests, find problems, a chat on the selection) and keeping windows in step.
 */
import { registerActions } from "@/platform/actions";
import { isVirtualUri } from "@/platform/virtualDocs";
import { lazyComponent } from "@/ui";
import { registerMenuGroup, registerSettingsPage } from "@/workbench/contributions";
import { codeAction, newChatWithSelection, PROMPTS_PAGE } from "./generate";
import { syncPromptLibrary } from "./store";

export { PROMPTS_PAGE } from "./generate";

/** Settings › AI › Prompt Library. */
export const registerPromptsPage = () =>
  registerSettingsPage({
    id: PROMPTS_PAGE,
    title: "Prompt Library",
    group: "AI",
    order: 510,
    keywords: ["prompt", "template", "commit message", "instructions", "documentation", "unit test", "review", "ai"],
    component: lazyComponent(() => import("./PromptLibraryPage").then((m) => m.PromptLibraryPage)),
  });

export function activatePrompts(): () => void {
  const disposers = [
    syncPromptLibrary(),
    registerActions([
      {
        id: "ai.writeDocumentation",
        title: "Write Documentation",
        description: "Asks an agent to document the selected code (Prompt Library › Write Documentation).",
        category: "AI",
        icon: "edit",
        // The editor, or its context menu open over it.
        when: "editorTextFocus || textEditorActive && popupOpen",
        keywords: ["ai", "agent", "javadoc", "jsdoc", "kdoc", "comment", "document"],
        run: () => void codeAction("documentation"),
      },
      {
        id: "ai.generateUnitTests",
        title: "Generate Unit Tests",
        description: "Asks an agent to write unit tests for the selected code (Prompt Library › Generate Unit Tests).",
        category: "AI",
        icon: "run",
        // The editor, or its context menu open over it.
        when: "editorTextFocus || textEditorActive && popupOpen",
        keywords: ["ai", "agent", "test", "junit", "vitest"],
        run: () => void codeAction("unitTests"),
      },
      {
        id: "ai.findProblems",
        title: "Find Problems",
        description: "Asks an agent to look for problems in the selected code (Prompt Library › Find Problems).",
        category: "AI",
        icon: "search",
        // The editor, or its context menu open over it.
        when: "editorTextFocus || textEditorActive && popupOpen",
        keywords: ["ai", "agent", "bug", "review", "problem"],
        run: () => void codeAction("findProblems"),
      },
      {
        id: "ai.newChatWithSelection",
        title: "New Chat Using Selection",
        description: "Opens a new agent chat on the selected code (Prompt Library › New Chat Using Selection).",
        category: "AI",
        icon: "toolwindow-agents",
        // The editor, or its context menu open over it.
        when: "editorTextFocus || textEditorActive && popupOpen",
        keywords: ["ai", "agent", "chat", "ask", "selection"],
        run: newChatWithSelection,
      },
      {
        id: "ai.promptLibrary",
        title: "Prompt Library",
        description: "Opens Settings › AI › Prompt Library.",
        category: "AI",
        icon: "settings",
        keywords: ["prompt", "template", "ai"],
        run: ({ arg }) => {
          const focus = typeof arg === "string" ? `#${arg}` : "";
          void import("@/platform/actions").then(({ executeAction }) =>
            executeAction("file.settings", PROMPTS_PAGE + focus),
          );
        },
      },
    ]),
    // IDEA's editor "AI Actions" submenu.
    registerMenuGroup({
      id: "ai.actions",
      menus: ["editor"],
      order: 79,
      items: (_menu, { paths }) =>
        paths.length && !paths.some(isVirtualUri)
          ? [
              {
                label: "AI Actions",
                icon: "toolwindow-agents",
                submenu: [
                  { kind: "action", action: "ai.newChatWithSelection" },
                  { kind: "separator" },
                  { kind: "action", action: "ai.findProblems" },
                  { kind: "action", action: "ai.writeDocumentation" },
                  { kind: "action", action: "ai.generateUnitTests" },
                  { kind: "separator" },
                  { kind: "action", action: "ai.promptLibrary" },
                ],
              },
            ]
          : [],
    }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
