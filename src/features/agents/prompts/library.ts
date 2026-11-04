/**
 * The Prompt Library (Settings › AI › Prompt Library): the prompts Luma sends for its AI actions
 * and the user's own, in groups. Built-in prompts can be edited and reset; groups and prompts
 * of one's own can be added, and a prompt with a command is offered as `/command` in the
 * agent composer.
 *
 * Templates are text with `$VARIABLES` filled in when the prompt is used ({@link fillTemplate});
 * each prompt lists the ones its action can fill. They are kept in English, once: what the
 * agent answers in follows the context (a commit message follows the repository's recent
 * commits, a chat follows the user's message), not the UI language.
 */

/** A `$VARIABLE` a template can use. */
export interface PromptVariable {
  name: string;
  /** What it is replaced with. */
  description: string;
  /** Shown in the variable picker as an example value. */
  example: string;
}

/** Every variable, in the order the picker lists them. */
export const VARIABLES: readonly PromptVariable[] = [
  { name: "USER_INPUT", description: "What follows the /command in the message", example: "check the paging" },
  { name: "SELECTION", description: "The selected code in the editor", example: "return chunks.size();" },
  { name: "FILE_PATH", description: "The current file, relative to the project", example: "src/main/java/App.java" },
  { name: "FILE_NAME", description: "The current file's name", example: "App.java" },
  { name: "LANGUAGE", description: "The current file's language", example: "Java" },
  { name: "PROJECT_NAME", description: "The project's name", example: "acme-api" },
  { name: "GIT_BRANCH_NAME", description: "The current Git branch", example: "feature/PAY-123-paging" },
  { name: "BASE_BRANCH", description: "The branch a pull request merges into", example: "main" },
  { name: "GIT_DIFF", description: "The changes, as a unified diff", example: "diff --git a/… b/…" },
  { name: "CHANGED_FILES", description: "The changed files, one per line", example: "M src/App.java" },
  { name: "RECENT_COMMITS", description: "The latest commit messages of the branch", example: "feat: add paging" },
  { name: "COMMITS", description: "The pull request's commits", example: "1a2b3c4 feat: add paging" },
  { name: "DATE", description: "Today's date (YYYY-MM-DD)", example: "2026-11-05" },
];

export type VariableName = (typeof VARIABLES)[number]["name"];
export type VariableValues = Partial<Record<string, string>>;

/** Where a built-in prompt is used: shown under the editor, so the user knows what it changes. */
export type PromptUse =
  | "instructions"
  | "commitMessage"
  | "selfReview"
  | "prSummary"
  | "documentation"
  | "unitTests"
  | "findProblems"
  | "newChat"
  | "command";

export interface Prompt {
  id: string;
  name: string;
  text: string;
  /** Offered as `/command` in the agent composer (custom prompts). */
  command?: string;
  /** A built-in prompt: it can be edited and reset, not removed or renamed. */
  builtin?: boolean;
  use?: PromptUse;
  /** The variables its action fills (built-in prompts; custom ones get the chat's). */
  variables?: readonly VariableName[];
  /** The file languages it is for (documentation, tests): file extensions. */
  extensions?: readonly string[];
}

export interface PromptGroup {
  id: string;
  name: string;
  builtin?: boolean;
  prompts: Prompt[];
}

const DIFF_VARS = ["GIT_DIFF", "CHANGED_FILES", "GIT_BRANCH_NAME", "RECENT_COMMITS", "PROJECT_NAME", "DATE"] as const;
const CODE_VARS = [
  "SELECTION",
  "FILE_PATH",
  "FILE_NAME",
  "LANGUAGE",
  "PROJECT_NAME",
  "GIT_BRANCH_NAME",
  "DATE",
] as const;
/** What a custom prompt used as `/command` can use. */
export const CHAT_VARS: readonly VariableName[] = [
  "USER_INPUT",
  "SELECTION",
  "FILE_PATH",
  "FILE_NAME",
  "LANGUAGE",
  "PROJECT_NAME",
  "GIT_BRANCH_NAME",
  "DATE",
];

const lines = (...l: string[]) => l.join("\n");

const COMMIT_MESSAGE = lines(
  "Write a commit message for the changes below.",
  "",
  "Follow the conventions of this repository's recent commits (listed below): their language, format and level of detail. When they show no clear convention, use Conventional Commits: `type(scope): summary`, with the summary in the imperative mood and at most 72 characters; add a body after a blank line only when the summary cannot say what changed and why, wrapped at 72 characters.",
  "",
  "Answer with the commit message only: no preamble, no explanation, no code fences.",
  "",
  "Branch: $GIT_BRANCH_NAME",
  "",
  "Recent commits:",
  "$RECENT_COMMITS",
  "",
  "Changed files:",
  "$CHANGED_FILES",
  "",
  "Diff:",
  "$GIT_DIFF",
);

const SELF_REVIEW = lines(
  "Review the changes below before I commit them, as a careful senior engineer on this project.",
  "",
  "Look for bugs and unhandled edge cases, security problems, broken error handling, race conditions, missing or outdated tests, and code that does not follow the project's conventions. Read the surrounding code where you need to; do not change any files.",
  "",
  "List the findings most important first. For each: the file and line, what is wrong, why it matters, and how to fix it. Say plainly when you find nothing worth changing.",
  "",
  "Branch: $GIT_BRANCH_NAME",
  "",
  "Changed files:",
  "$CHANGED_FILES",
  "",
  "Diff:",
  "$GIT_DIFF",
);

const PR_SUMMARY = lines(
  "Write a GitHub pull request description for the changes below.",
  "",
  "Use Markdown with these sections:",
  "## Summary: what the pull request does and why, in two to four sentences.",
  "## Changes: the notable changes as a short bulleted list.",
  "## Testing: how it was verified, or what a reviewer should check.",
  "",
  "Write in the language of the commit messages. Answer with the description only: no preamble, no code fences around it.",
  "",
  "Branch $GIT_BRANCH_NAME into $BASE_BRANCH.",
  "",
  "Commits:",
  "$COMMITS",
  "",
  "Diff:",
  "$GIT_DIFF",
);

const docs = (language: string, style: string) =>
  lines(
    `Write documentation comments for the ${language} code selected in \`$FILE_PATH\`, in ${style}.`,
    "",
    "Document what each declaration is for, its parameters, return value and the exceptions or errors it can raise, and anything a caller must know (side effects, threading, nullability). Do not restate what the code obviously says. Keep the language and the style of the comments already in the file.",
    "",
    "Edit the file in place: add or update the comments only, and do not change the code.",
    "",
    "Selected code:",
    "```",
    "$SELECTION",
    "```",
  );

const tests = (language: string, frameworks: string) =>
  lines(
    `Write unit tests for the ${language} code selected in \`$FILE_PATH\`.`,
    "",
    `Use the test framework and assertion style this project already uses (${frameworks} when it has none yet), and put the tests where the project keeps its tests, following the naming of the existing ones.`,
    "",
    "Cover the normal behaviour, the edge cases (empty, null, limits) and the error paths, one behaviour per test with a name that says what it checks. Mock only what crosses a boundary (network, file system, clock). Run the tests and fix them until they pass; if the code under test has a bug, say so instead of testing around it.",
    "",
    "Selected code:",
    "```",
    "$SELECTION",
    "```",
  );

const FIND_PROBLEMS = lines(
  "Find problems in the $LANGUAGE code selected in `$FILE_PATH`: bugs, unhandled edge cases, security issues, performance traps and misleading names. Read the code around it where you need to; do not change any files.",
  "",
  "List the problems most important first, each with the line, what goes wrong and a fix. Say so when the code looks right.",
  "",
  "```",
  "$SELECTION",
  "```",
);

const NEW_CHAT = "Look at the code I selected in `$FILE_PATH`. ";

const INSTRUCTIONS = lines(
  "Answer in the language I write in.",
  "Prefer small, focused changes that follow this project's conventions, and say what you verified and how.",
);

const JS = ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"];

/** The built-in groups, in order. Ids are stable: they key the user's edits. */
export const BUILTIN_GROUPS: readonly PromptGroup[] = [
  {
    id: "general",
    name: "General",
    builtin: true,
    prompts: [
      {
        id: "general.chat-instructions",
        name: "Chat Instructions",
        text: INSTRUCTIONS,
        builtin: true,
        use: "instructions",
        variables: ["PROJECT_NAME", "GIT_BRANCH_NAME", "DATE"],
      },
    ],
  },
  {
    id: "builtin",
    name: "Built-in Actions",
    builtin: true,
    prompts: [
      {
        id: "builtin.commit-message",
        name: "Commit Message Generation",
        text: COMMIT_MESSAGE,
        builtin: true,
        use: "commitMessage",
        variables: DIFF_VARS,
      },
      {
        id: "builtin.self-review",
        name: "AI Self-Review",
        text: SELF_REVIEW,
        builtin: true,
        use: "selfReview",
        variables: DIFF_VARS,
      },
    ],
  },
  {
    id: "docs",
    name: "Write Documentation",
    builtin: true,
    prompts: [
      {
        id: "docs.pr-summary",
        name: "GitHub Pull Request AI Summary",
        text: PR_SUMMARY,
        builtin: true,
        use: "prSummary",
        variables: ["GIT_DIFF", "COMMITS", "GIT_BRANCH_NAME", "BASE_BRANCH", "PROJECT_NAME", "DATE"],
      },
      ...(
        [
          ["javascript", "JavaScript", "JSDoc (TSDoc for TypeScript)", JS],
          ["java", "Java", "Javadoc", ["java"]],
          ["kotlin", "Kotlin", "KDoc", ["kt", "kts"]],
          ["go", "Go", "Go doc comments", ["go"]],
        ] as const
      ).map(([id, name, style, extensions]): Prompt => ({
        id: `docs.${id}`,
        name,
        text: docs(name, style),
        builtin: true,
        use: "documentation",
        variables: CODE_VARS,
        extensions,
      })),
    ],
  },
  {
    id: "tests",
    name: "Generate Unit Tests",
    builtin: true,
    prompts: (
      [
        ["javascript", "JavaScript", "Vitest", JS],
        ["java", "Java", "JUnit 5 with AssertJ", ["java"]],
        ["kotlin", "Kotlin", "JUnit 5 with kotlin.test", ["kt", "kts"]],
        ["go", "Go", "the testing package with table-driven tests", ["go"]],
        ["vue", "Vue", "Vitest with Vue Test Utils", ["vue"]],
      ] as const
    ).map(([id, name, frameworks, extensions]): Prompt => ({
      id: `tests.${id}`,
      name,
      text: tests(name, frameworks),
      builtin: true,
      use: "unitTests",
      variables: CODE_VARS,
      extensions,
    })),
  },
  {
    id: "chat",
    name: "Chat Actions",
    builtin: true,
    prompts: [
      {
        id: "chat.find-problems",
        name: "Find Problems",
        command: "find-problems",
        text: FIND_PROBLEMS,
        builtin: true,
        use: "findProblems",
        variables: CODE_VARS,
      },
      {
        id: "chat.new-chat-with-selection",
        name: "New Chat Using Selection",
        text: NEW_CHAT,
        builtin: true,
        use: "newChat",
        variables: CODE_VARS,
      },
    ],
  },
];

const BUILTINS = new Map(BUILTIN_GROUPS.flatMap((g) => g.prompts.map((p) => [p.id, p] as const)));

/** A built-in prompt as shipped. */
export const builtinPrompt = (id: string): Prompt | undefined => BUILTINS.get(id);

/**
 * The template with its variables filled in. `$NAME` is replaced when `values` has `NAME`
 * (missing values become empty: there is no selection, say); `$$` writes a `$`. Names that
 * are no variable are kept as written.
 *
 * @param text the template
 * @param values the values, by variable name (without the `$`)
 * @returns the text to send
 */
export function fillTemplate(text: string, values: VariableValues): string {
  const known = new Set(VARIABLES.map((v) => v.name));
  return text.replace(/\$\$|\$([A-Z][A-Z0-9_]*)/g, (m, name: string | undefined) => {
    if (!name) return "$";
    if (!known.has(name)) return m;
    return values[name] ?? "";
  });
}

/** A `$VARIABLE` written in a template: its range and whether the prompt's action fills it. */
export interface VariableToken {
  from: number;
  to: number;
  name: string;
  known: boolean;
}

/**
 * The variables written in `text`, for highlighting in the editor.
 *
 * @param text the template
 * @param available the variables the prompt's action fills
 * @returns the tokens, in order; `known` is false for names it will not fill
 */
export function variableTokens(text: string, available: readonly string[]): VariableToken[] {
  const out: VariableToken[] = [];
  for (const m of text.matchAll(/\$\$|\$([A-Z][A-Z0-9_]*)/g)) {
    if (!m[1]) continue;
    out.push({ from: m.index!, to: m.index! + m[0].length, name: m[1], known: available.includes(m[1]) });
  }
  return out;
}

/** A command name as typed after `/`: lower case words joined by `-`. */
export function commandName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/** The language name of a file, for `$LANGUAGE`. */
export function languageOf(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const names: Record<string, string> = {
    java: "Java",
    kt: "Kotlin",
    kts: "Kotlin",
    go: "Go",
    js: "JavaScript",
    jsx: "JavaScript",
    mjs: "JavaScript",
    cjs: "JavaScript",
    ts: "TypeScript",
    tsx: "TypeScript",
    vue: "Vue",
    py: "Python",
    rs: "Rust",
    rb: "Ruby",
    cs: "C#",
    cpp: "C++",
    c: "C",
    swift: "Swift",
    php: "PHP",
    scala: "Scala",
    sql: "SQL",
  };
  return names[ext] ?? (ext ? ext.toUpperCase() : "");
}
