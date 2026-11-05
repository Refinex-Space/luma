/**
 * A problem under the pointer or caret as a {@link ProblemRef}: what Copy Problem quotes and
 * what actions on it (Fix with Agent…) get. Line and column are 1-based, as editors show them.
 */
import type { EditorView } from "@codemirror/view";
import type { Diagnostic as LintDiagnostic } from "@codemirror/lint";
import type { ProblemPos, ProblemRef } from "@/editor/api";
import { useProject } from "@/platform/project";
import { diagnosticOrigin, isInternalCode, type PlacedDiagnostic } from "./diagnostics";
import { docOf } from "./lsp";

/** Lines quoted at most; a longer problem is cut with an ellipsis line. */
const MAX_LINES = 30;

const FENCES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  py: "python",
  rb: "ruby",
  rs: "rust",
  kt: "kotlin",
  kts: "kotlin",
  md: "markdown",
  yml: "yaml",
  sh: "bash",
  cs: "csharp",
  h: "c",
  hpp: "cpp",
  cc: "cpp",
};

export function fenceOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return name.toLowerCase() === "dockerfile" ? "dockerfile" : "";
  const ext = name.slice(dot + 1).toLowerCase();
  return FENCES[ext] ?? ext;
}

const relative = (path: string) => {
  const root = useProject.getState().project?.root;
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
};

/** `lint` reported by `source` "sonarqube java:S2259": the producer and its code apart. */
function sourceAndCode(lint: LintDiagnostic): { source: string | null; code: string | null; server: string | null } {
  const origin = diagnosticOrigin(lint);
  if (origin)
    return {
      source: origin.source ?? null,
      code: isInternalCode(origin.code) ? null : (origin.code ?? null),
      server: origin.server ?? null,
    };
  const [source, ...rest] = (lint.source ?? "").split(" ");
  return { source: source || null, code: rest.join(" ") || null, server: null };
}

export function problemRef(view: EditorView, placed: PlacedDiagnostic): ProblemRef | null {
  const ctx = docOf(view);
  if (!ctx || ctx.virtual) return null;
  const doc = view.state.doc;
  const at = (offset: number): ProblemPos => {
    const line = doc.lineAt(offset);
    return { line: line.number, column: offset - line.from + 1 };
  };
  const start = at(placed.from);
  // A range ending at a line start does not reach into that line.
  const endOffset = placed.to > placed.from && doc.lineAt(placed.to).from === placed.to ? placed.to - 1 : placed.to;
  const end = at(placed.to);
  const last = doc.lineAt(endOffset).number;
  const to = Math.min(last, start.line + MAX_LINES - 1);
  const snippet = doc.sliceString(doc.line(start.line).from, doc.line(to).to) + (to < last ? "\n…" : "");
  return {
    path: ctx.path,
    rel: relative(ctx.path),
    fence: fenceOf(ctx.path),
    severity: placed.diagnostic.severity,
    message: placed.diagnostic.message,
    ...sourceAndCode(placed.diagnostic),
    start,
    end,
    lines: { from: start.line, to },
    snippet,
  };
}

/** `src/App.java:113:68` */
export const problemLocation = (p: ProblemRef) => `${p.rel}:${p.start.line}:${p.start.column}`;

/** `113:68-113:105`, or `113:68-105` on one line. */
export function problemRange(p: ProblemRef): string {
  const end = p.end.line === p.start.line ? `${p.end.column}` : `${p.end.line}:${p.end.column}`;
  return `${p.start.line}:${p.start.column}-${end}`;
}

/** `[sonarqube java:S2259]`, or nothing when no producer is known. */
export function problemOrigin(p: ProblemRef): string {
  const label = [p.source, p.code].filter(Boolean).join(" ");
  return label ? `[${label}]` : "";
}

const SEVERITY_WORD: Record<ProblemRef["severity"], string> = {
  error: "Error",
  warning: "Warning",
  info: "Info",
  hint: "Hint",
};

/** The problem's lines, numbered like the gutter. */
export function numberedSnippet(p: ProblemRef): string {
  const width = String(p.lines.to).length;
  return p.snippet
    .split("\n")
    .map((text, i) =>
      text === "…" && p.lines.from + i > p.lines.to ? text : `${String(p.lines.from + i).padStart(width)} | ${text}`,
    )
    .join("\n");
}

/**
 * Copy Problem: where it is (file, range), what it is and its lines, as plain text
 * that reads well pasted into an issue, a chat or a commit message.
 */
export function problemText(p: ProblemRef): string {
  const head = [SEVERITY_WORD[p.severity], problemOrigin(p)].filter(Boolean).join(" ");
  return [`${p.rel}:${problemRange(p)}`, `${head}: ${p.message}`, "", "```" + p.fence, numberedSnippet(p), "```"].join(
    "\n",
  );
}
