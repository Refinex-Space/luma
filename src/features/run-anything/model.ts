/**
 * Run Anything (⌃⌃): command-line history, the rows offered for the typed
 * text (recent commands, then each provider's group) and the shell command
 * a plain line runs as.
 */
import type { RunConfig } from "@/platform/ipc";
import type { RunAnythingItem, RunAnythingProvider } from "@/workbench/contributions";

const HISTORY_PREFIX = "luma.runAnything.history.v1:";
export const MAX_HISTORY = 30;
/** Rows per provider group. */
const GROUP_LIMIT = 8;

export function readHistory(scope: string): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(HISTORY_PREFIX + scope) ?? "[]");
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).slice(0, MAX_HISTORY)
      : [];
  } catch {
    return [];
  }
}

/** Puts `line` first (once) in the history of `scope`. */
export function pushHistory(scope: string, line: string): string[] {
  const text = line.trim();
  if (!text) return readHistory(scope);
  const next = [text, ...readHistory(scope).filter((h) => h !== text)].slice(0, MAX_HISTORY);
  try {
    localStorage.setItem(HISTORY_PREFIX + scope, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
  return next;
}

export function clearHistory(scope: string) {
  try {
    localStorage.removeItem(HISTORY_PREFIX + scope);
  } catch {
    /* storage unavailable */
  }
}

export type Row =
  | { kind: "section"; key: string; label: string }
  | { kind: "item"; key: string; item: RunAnythingItem; group: string };

/** Case-insensitive: every word of `query` occurs in `text`. */
export function matches(text: string, query: string): boolean {
  const t = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => t.includes(w));
}

/** Rows for `query`: matching recent commands, then each provider's items under its group. */
export function buildRows(
  query: string,
  history: readonly string[],
  providers: readonly RunAnythingProvider[],
  runLine: (line: string) => void,
): Row[] {
  const rows: Row[] = [];
  const section = (key: string, label: string, items: RunAnythingItem[]) => {
    if (!items.length) return;
    rows.push({ kind: "section", key: `s:${key}`, label });
    for (const item of items) rows.push({ kind: "item", key: `${key}:${item.key}`, item, group: key });
  };
  section(
    "recent",
    "Recent",
    history
      .filter((h) => matches(h, query))
      .slice(0, GROUP_LIMIT)
      .map((h) => ({ key: h, label: h, icon: "history", completion: h, run: () => runLine(h) })),
  );
  for (const p of providers) {
    let items: RunAnythingItem[] = [];
    try {
      items = p.items(query).slice(0, GROUP_LIMIT);
    } catch (e) {
      console.error(`run anything provider ${p.id} failed`, e);
    }
    section(p.id, p.group, items);
  }
  return rows;
}

/** The program and arguments that run `line` through the platform shell. */
export function shellCommand(line: string, windows: boolean): { command: string; args: string[] } {
  return windows ? { command: "cmd.exe", args: ["/d", "/s", "/c", line] } : { command: "/bin/sh", args: ["-c", line] };
}

/** A temporary run configuration for a shell command line (shown in the Run tool window). */
export function shellRunConfig(line: string, cwd: string, windows: boolean): RunConfig {
  const { command, args } = shellCommand(line, windows);
  return {
    id: `runAnything:${line}`,
    name: line.length > 60 ? `${line.slice(0, 57)}…` : line,
    kind: "external",
    command,
    args,
    cwd,
    env: {},
    detected: false,
    isTest: false,
    debugAdapter: null,
  };
}
