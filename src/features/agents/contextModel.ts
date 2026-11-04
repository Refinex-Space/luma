/**
 * Context attached to a message from the composer's "+" menu (IDEA's "Add Context"): project
 * files and folders, files from the computer, commits and skills. They show as chips above the
 * text and go with the message: files as references, commits as text notes, a skill as the
 * command it runs.
 */
import type { AgentCommand, AgentContextNote, Commit } from "@/bindings";
import { tx } from "@/platform/i18n";

export type ContextItem =
  /**
   * A file or folder; `rel` is what the chip shows (relative to the task's directory). With
   * `lines`, the editor selection "Send to Agent" took: those lines and their `code`.
   */
  | { kind: "file"; path: string; rel: string; dir: boolean; lines?: { from: number; to: number }; code?: string }
  | { kind: "commit"; id: string; shortId: string; summary: string; author: string; timeMs: number | null }
  | { kind: "skill"; name: string; description: string }
  /** Text context as sent (a queued message's commit, taken back to edit). */
  | { kind: "note"; label: string; text: string };

/** One chip per file, commit or skill: adding one again keeps the first. */
export function contextKey(item: ContextItem): string {
  switch (item.kind) {
    case "file":
      return item.lines ? `file:${item.path}:${item.lines.from}-${item.lines.to}` : `file:${item.path}`;
    case "commit":
      return `commit:${item.id}`;
    case "skill":
      return `skill:${item.name}`;
    case "note":
      return `note:${item.label}\n${item.text}`;
  }
}

export function addContext(list: readonly ContextItem[], items: readonly ContextItem[]): ContextItem[] {
  const keys = new Set(list.map(contextKey));
  const out = [...list];
  for (const item of items) {
    const key = contextKey(item);
    if (keys.has(key)) continue;
    keys.add(key);
    out.push(item);
  }
  return out;
}

/** What the agent reads for a commit: enough to find it (`git show <id>`) and know what it is. */
export function commitNote(c: Extract<ContextItem, { kind: "commit" }>): AgentContextNote {
  const when = c.timeMs != null ? `, ${new Date(c.timeMs).toISOString().slice(0, 10)}` : "";
  // For the agent to read: not UI text.
  const text = ["Context: commit", c.id, "by", `${c.author}${when}:`, c.summary].join(" ");
  return { label: `${tx("Commit")} ${c.shortId}`, text };
}

/** Code sent with a selection: enough for the agent to work from without opening the file. */
const MAX_SELECTION = 20_000;

/** What the chip of a selection shows: the file and its lines ("Orders.java:81-86"). */
export function rangeLabel(rel: string, lines: { from: number; to: number }): string {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  return lines.from === lines.to ? `${name}:${lines.from}` : `${name}:${lines.from}-${lines.to}`;
}

/** A selection as text for the agent: where it is, then the code. */
export function selectionNote(c: Extract<ContextItem, { kind: "file" }>): AgentContextNote | null {
  if (!c.lines) return null;
  const where = c.lines.from === c.lines.to ? `line ${c.lines.from}` : `lines ${c.lines.from}-${c.lines.to}`;
  const code = c.code && c.code.length <= MAX_SELECTION ? ["", "```", c.code, "```"].join("\n") : "";
  const text = ["Context:", where, "of", c.path].join(" ") + code;
  return { label: rangeLabel(c.rel, c.lines), text };
}

/** The text notes a prompt carries for its chips: selections, commits, and notes kept as sent. */
export function contextNotes(context: readonly ContextItem[]): AgentContextNote[] {
  return context.flatMap((c) => {
    if (c.kind === "file") return c.lines ? [selectionNote(c)!] : [];
    if (c.kind === "commit") return [commitNote(c)];
    if (c.kind === "note") return [{ label: c.label, text: c.text }];
    return [];
  });
}

/**
 * `label` cut in the middle to `max` characters, so both its start and its end (the extension,
 * a line range) stay readable: "KnowledgeBase…Strategy.java:81-86".
 */
export function middleEllipsis(label: string, max = 36): string {
  const chars = [...label];
  if (chars.length <= max) return label;
  const tail = Math.ceil((max - 1) * 0.55);
  return `${chars.slice(0, max - 1 - tail).join("")}…${chars.slice(chars.length - tail).join("")}`;
}

export const commitItem = (c: Commit): ContextItem => ({
  kind: "commit",
  id: c.id,
  shortId: c.shortId,
  summary: c.summary,
  author: c.author,
  timeMs: c.timeMs,
});

/**
 * The message text with the skills to run: a command is read only as a message's first word,
 * so the skills go first (`/name`), then the text.
 */
export function withSkills(text: string, context: readonly ContextItem[]): string {
  const skills = context.flatMap((c) => (c.kind === "skill" ? [`/${c.name}`] : []));
  if (!skills.length) return text;
  return text ? `${skills.join(" ")} ${text}` : skills.join(" ");
}

/**
 * Skills among an agent's commands: `skill:` ones (pi), or ones described as a skill. The rest
 * (`/compact`, prompts…) are listed after them as commands.
 */
export function isSkill(c: AgentCommand): boolean {
  return /^skills?:/i.test(c.name) || /\bskill\b/i.test(c.description);
}

/** The agent's commands for the Skills page: skills first, each group by name. */
export function skillsFirst(commands: readonly AgentCommand[]): { skills: AgentCommand[]; others: AgentCommand[] } {
  const byName = (a: AgentCommand, b: AgentCommand) => a.name.localeCompare(b.name);
  return {
    skills: commands.filter(isSkill).sort(byName),
    others: commands.filter((c) => !isSkill(c)).sort(byName),
  };
}

/** Case-insensitive match of every word of `query` in `text`. */
export function matchesQuery(text: string, query: string): boolean {
  const t = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => t.includes(w));
}
