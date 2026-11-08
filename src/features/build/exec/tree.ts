/**
 * IDEA's build event tree (`ExecutionNode` / `BuildTreeConsoleView`), shared by the
 * Build tool window (Sync, Build Output) and Maven runs in the Run tool window:
 * nodes a build's events start and finish, messages grouped under a node per file,
 * error / warning counts propagated to the ancestors, and each node's own output.
 *
 * Mutable; `version` is bumped on every change (views re-render on it).
 */
import { tx } from "@/platform/i18n";

export type ExecResult = "success" | "failed" | "skipped";
export type MessageKind = "error" | "warning" | "info";

export interface FilePosition {
  path: string;
  /** 0-based; null when the message names only the file. */
  line: number | null;
  col: number | null;
}

export interface ExecNode {
  id: string;
  parent: ExecNode | null;
  children: ExecNode[];
  /** Bold `title: ` before the name (the root). */
  title: string | null;
  name: string;
  /** Grey text after the name. */
  hint: string | null;
  kind: "step" | "file" | "message";
  /** Outcome of a finished step; message nodes carry `severity` instead. */
  result: ExecResult | null;
  running: boolean;
  severity: MessageKind | null;
  file: FilePosition | null;
  /** Full text of a message (shown beside the tree when selected). */
  detail: string | null;
  startedAt: number;
  endedAt: number | null;
  errors: number;
  warnings: number;
  infos: number;
  /** The node's own console output (and its descendants'), for the console beside the tree. */
  output: string[];
}

/** Lines kept per node; the root's console is the session's full one. */
const MAX_NODE_OUTPUT = 5000;

function makeNode(id: string, parent: ExecNode | null, name: string, kind: ExecNode["kind"], now: number): ExecNode {
  return {
    id,
    parent,
    children: [],
    title: null,
    name,
    hint: null,
    kind,
    result: null,
    running: kind === "step",
    severity: null,
    file: null,
    detail: null,
    startedAt: now,
    endedAt: kind === "step" ? null : now,
    errors: 0,
    warnings: 0,
    infos: 0,
    output: [],
  };
}

export class ExecTree {
  readonly root: ExecNode;
  version = 0;
  private readonly nodes = new Map<string, ExecNode>();
  private readonly listeners = new Set<() => void>();

  /** `base`: the project root, which file nodes' directory hints are relative to. */
  constructor(
    title: string,
    now = Date.now(),
    private readonly base: string | null = null,
  ) {
    this.root = makeNode("root", null, "", "step", now);
    this.root.title = title;
    this.nodes.set(this.root.id, this.root);
  }

  get(id: string): ExecNode | undefined {
    return this.nodes.get(id);
  }

  /** Called after every change (batched by the caller's render loop). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed() {
    this.version++;
    for (const l of this.listeners) l();
  }

  /** Starts a step under `parentId` (the root when null or unknown). Restarting a known id is ignored. */
  start(id: string, parentId: string | null, name: string, now = Date.now(), hint: string | null = null): ExecNode {
    const existing = this.nodes.get(id);
    if (existing) return existing;
    const parent = (parentId && this.nodes.get(parentId)) || this.root;
    const node = makeNode(id, parent, name, "step", now);
    node.hint = hint;
    parent.children.push(node);
    this.nodes.set(id, node);
    this.changed();
    return node;
  }

  /** Finishes a step; its still running descendants are skipped (IDEA's `setAllDescendantResults`). */
  finish(id: string, result: ExecResult, now = Date.now()) {
    const node = this.nodes.get(id);
    if (!node || node.kind !== "step") return;
    this.close(node, result, now);
    this.changed();
  }

  private close(node: ExecNode, result: ExecResult, now: number) {
    for (const c of node.children) if (c.running) this.close(c, "skipped", now);
    node.running = false;
    node.result = result;
    node.endedAt = now;
  }

  /** Appends a continuation line to a message (javac's `symbol:` / `location:` lines). */
  appendDetail(id: string, line: string) {
    const node = this.nodes.get(id);
    if (!node || node.kind !== "message") return;
    node.detail = `${node.detail ?? ""}\n${line}`;
    this.changed();
  }

  /** Renames a node and sets its hint (the root's "build finished" / "At …" once done). */
  describe(id: string, name: string, hint: string | null) {
    const node = this.nodes.get(id);
    if (!node) return;
    node.name = name;
    node.hint = hint;
    this.changed();
  }

  /** The build finished: every running step ends with the build's result (or skipped below it). */
  finishBuild(result: ExecResult, now = Date.now()) {
    this.close(this.root, result, now);
    this.changed();
  }

  /**
   * Adds a message under `parentId`; one with a file goes under that file's node (created
   * on first use, named after the file, the directory as hint). Exact duplicates are dropped.
   */
  message(
    parentId: string | null,
    severity: MessageKind,
    text: string,
    file: FilePosition | null = null,
    now = Date.now(),
  ): ExecNode | null {
    let parent = (parentId && this.nodes.get(parentId)) || this.root;
    if (file) parent = this.fileNode(parent, file.path, now);
    const name = text.split("\n")[0]!.trim() || text.trim();
    const hint = file?.line != null ? `:${file.line + 1}` : null;
    if (
      parent.children.some(
        (c) => c.kind === "message" && c.severity === severity && c.detail === text && c.hint === hint,
      )
    )
      return null;
    const id = `${parent.id}\u0000m${parent.children.length}`;
    const node = makeNode(id, parent, name, "message", now);
    node.severity = severity;
    node.detail = text;
    node.file = file;
    node.hint = hint;
    parent.children.push(node);
    this.nodes.set(id, node);
    for (let p: ExecNode | null = parent; p; p = p.parent) {
      if (severity === "error") p.errors++;
      else if (severity === "warning") p.warnings++;
      else p.infos++;
    }
    this.changed();
    return node;
  }

  private fileNode(parent: ExecNode, path: string, now: number): ExecNode {
    const id = `${parent.id}\u0000f:${path}`;
    const existing = this.nodes.get(id);
    if (existing) return existing;
    const slash = path.lastIndexOf("/");
    const node = makeNode(id, parent, slash >= 0 ? path.slice(slash + 1) : path, "file", now);
    node.file = { path, line: null, col: null };
    const dir = slash > 0 ? path.slice(0, slash) : "";
    const base = this.base?.replace(/\/+$/, "");
    node.hint =
      (base && (dir === base ? "" : dir.startsWith(`${base}/`) ? dir.slice(base.length + 1) : dir)) ||
      (base ? null : dir || null);
    parent.children.push(node);
    this.nodes.set(id, node);
    return node;
  }

  /** Appends a console line to the node `id` and its ancestors below the root. */
  output(id: string | null, line: string) {
    for (let n = id ? this.nodes.get(id) : undefined; n && n !== this.root; n = n.parent ?? undefined) {
      n.output.push(line);
      if (n.output.length > MAX_NODE_OUTPUT) n.output.splice(0, n.output.length - MAX_NODE_OUTPUT);
    }
  }

  /** Every message node, in tree order. */
  messages(): ExecNode[] {
    const out: ExecNode[] = [];
    const walk = (n: ExecNode) => {
      if (n.kind === "message") out.push(n);
      n.children.forEach(walk);
    };
    walk(this.root);
    return out;
  }

  firstError(): ExecNode | undefined {
    return this.messages().find((m) => m.severity === "error");
  }
}

// ---------------------------------------------------------------------------
// Filters (IDEA's Show Warnings / Show Successful Steps)

export interface ExecFilters {
  showWarnings: boolean;
  showSuccessful: boolean;
}

/** IDEA's defaults (`WarningsToggleAction` on, `SuccessfulStepsToggleAction` off). */
export const DEFAULT_FILTERS: ExecFilters = { showWarnings: true, showSuccessful: false };

export const isFailed = (n: ExecNode) => n.result === "failed" || n.severity === "error" || n.errors > 0;
const hasWarnings = (n: ExecNode) => n.warnings > 0 || n.severity === "warning";
const hasInfos = (n: ExecNode) => n.infos > 0 || n.severity === "info";

/** IDEA's `BuildTreeConsoleView.getFilter`: the root, running and failed nodes are always shown. */
export function isVisible(n: ExecNode, f: ExecFilters): boolean {
  if (!n.parent || n.running || isFailed(n)) return true;
  if (f.showWarnings && (hasWarnings(n) || hasInfos(n))) return true;
  return f.showSuccessful && !hasWarnings(n);
}

export function visibleChildren(n: ExecNode, f: ExecFilters): ExecNode[] {
  return n.children.filter((c) => isVisible(c, f));
}

// ---------------------------------------------------------------------------
// Presentation

const errorsText = (count: number) => (count === 1 ? tx("1 error") : tx`${count} errors`);
const warningsText = (count: number) => (count === 1 ? tx("1 warning") : tx`${count} warnings`);

/** `1 error, 2 warnings` (LangBundle `build.event.message.errors` / `.warnings`). */
export function issuesHint(n: ExecNode): string {
  const parts: string[] = [];
  if (n.errors > 0) parts.push(errorsText(n.errors));
  if (n.warnings > 0) parts.push(warningsText(n.warnings));
  return parts.join(", ");
}

/** The grey text after a node's name: its hint plus its issues (IDEA's `HintData`). */
export function nodeHint(n: ExecNode): string | null {
  const issues = n.kind === "message" ? "" : issuesHint(n);
  if (!issues) return n.hint;
  const hint = n.hint;
  if (!n.parent) return n.running ? `${hint ?? ""}  ${issues}`.trim() : hint ? tx`${hint} with ${issues}` : issues;
  return hint ? `${hint} ${issues}` : issues;
}

/** One duration fragment (`3 sec`), per unit so a locale can word it. */
const UNITS: Array<{ ms: number; text: (v: number) => string }> = [
  { ms: 86_400_000, text: (v) => (v === 1 ? tx("1 day") : tx`${v} days`) },
  { ms: 3_600_000, text: (v) => tx`${v} hr` },
  { ms: 60_000, text: (v) => tx`${v} min` },
  { ms: 1000, text: (v) => tx`${v} sec` },
  { ms: 1, text: (v) => tx`${v} ms` },
];

/**
 * IDEA's `NlsMessages.formatDuration`: `450 ms`, `1 sec, 234 ms`, `1 min, 0 sec, 100 ms`;
 * `maxFragments` (rounded) for the approximate duration of a running node.
 */
export function formatExecDuration(ms: number, maxFragments = Infinity): string {
  let total = Math.max(0, Math.round(ms));
  const parts = (value: number) => {
    const out: Array<{ value: number; unit: (typeof UNITS)[number] }> = [];
    let rest = value;
    for (const unit of UNITS) {
      const v = Math.floor(rest / unit.ms);
      rest -= v * unit.ms;
      if (v > 0 || out.length > 0) out.push({ value: v, unit });
    }
    // Trailing zero fragments are dropped (`1 sec`, not `1 sec, 0 ms`).
    while (out.length > 1 && out[out.length - 1]!.value === 0) out.pop();
    return out.length ? out : [{ value: 0, unit: UNITS[UNITS.length - 1]! }];
  };
  let frags = parts(total);
  if (frags.length > maxFragments) {
    const last = frags[maxFragments - 1]!.unit.ms;
    const next = frags[maxFragments]!;
    if (next.value * next.unit.ms >= last / 2) total += last;
    total -= total % last;
    frags = parts(total).slice(0, maxFragments);
  }
  return frags.map((f) => f.unit.text(f.value)).join(", ");
}

/** Duration shown at the end of a row: approximate while running, none for skipped steps. */
export function nodeDuration(n: ExecNode, now = Date.now()): string | null {
  if (n.kind !== "step" || n.result === "skipped") return null;
  if (n.running) {
    let d = now - n.startedAt;
    if (d > 1000) d -= d % 1000;
    return d < 1000 ? null : formatExecDuration(d, 2);
  }
  if (n.endedAt == null || n.endedAt === n.startedAt) return null;
  return formatExecDuration(n.endedAt - n.startedAt);
}

/** `At 11/7/26, 2:00 PM` for the root hint (IDEA's `FinishBuildEventImpl.getHint`). */
export function finishedAtHint(at: number, hint: string | null = null, locale?: string): string {
  const time = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(at);
  return hint ? tx`${hint} at ${time}` : tx`At ${time}`;
}
