/**
 * Build › Build Project state: one build at a time, run by the backend
 * (`build_run`) with its output streamed into the Build tool window, progress
 * as a cancellable background task and a notification when it finishes.
 * Compiler messages reach the Problems view and editors as `build`
 * diagnostics, published (and cleared on the next build) by the backend.
 *
 * Explicit builds show the tool window without taking focus. A failed build
 * also selects the first error and opens its location in the editor.
 */
import { create } from "zustand";
import { Channel } from "@tauri-apps/api/core";
import { setContext } from "@/platform/context";
import {
  call,
  commands,
  isCancelled,
  nextRequestId,
  type BuildEvent,
  type BuildKind,
  type BuildMessage,
  type BuildResult,
  type BuildSystem,
  type RequestId,
} from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { maybeEditorService, notifications, toolWindowService } from "@/workbench/contributions";
import { cancelTask, removeTask, upsertTask, useTasks } from "@/workbench/tasks";
import { basename } from "@/platform/project";
import { tx } from "@/platform/i18n";
import { MavenOutputParser } from "./exec/maven";
import { ExecTree, finishedAtHint } from "./exec/tree";
import { appendOutput, finishSummary, firstError, messageFiles, type BuildStatus, type ConsoleLine } from "./model";
import { selectBuildTab } from "./syncView";

export const BUILD_TASK_ID = "build:compile";
export const BUILD_RUNNING = "build.running";
/** Outcome of the last build (`success` | `failed` | `cancelled`), e.g. for Run's "Build" before launch task. */
export const BUILD_LAST_STATUS = "build.lastStatus";

/** How builds reach the backend; replaced in tests. */
export interface BuildBackend {
  run(
    kind: BuildKind,
    file: string | null,
    request: RequestId,
    clear: string[],
    onEvent: (e: BuildEvent) => void,
  ): Promise<BuildResult>;
  cancel(request: RequestId): void;
}

const tauriBackend: BuildBackend = {
  run(kind, file, request, clear, onEvent) {
    const channel = new Channel<BuildEvent>();
    channel.onmessage = onEvent;
    return call(commands.buildRun(kind, file, request, clear, channel));
  },
  cancel(request) {
    void commands.cancelRequest(request);
  },
};

let backend: BuildBackend = tauriBackend;

export function setBuildBackend(b: BuildBackend | null) {
  backend = b ?? tauriBackend;
}

export interface BuildState {
  request: RequestId | null;
  kind: BuildKind | null;
  /** Module file or folder of a Build Module, `null` for the project. */
  file: string | null;
  title: string;
  system: BuildSystem | null;
  status: BuildStatus | null;
  message: string | null;
  durationMs: number | null;
  messages: BuildMessage[];
  lines: ConsoleLine[];
  /** Files with diagnostics from the last build. */
  files: string[];
  /** Id of the selected tree node (a message node shows its detail beside the tree). */
  selected: string | null;
  /** The build's event tree (IDEA's Build Output): Maven projects and goals, files, messages. */
  tree: ExecTree | null;
}

const INITIAL: BuildState = {
  request: null,
  kind: null,
  file: null,
  title: "",
  system: null,
  status: null,
  message: null,
  durationMs: null,
  messages: [],
  lines: [],
  files: [],
  selected: null,
  tree: null,
};

export const useBuildRun = create<BuildState>(() => INITIAL);

const TITLES: Record<BuildKind, string> = { build: "Build", rebuild: "Rebuild", artifacts: "Build Artifacts" };

/** Applies one streamed event (pure; batched by the caller). */
export function applyBuildEvent(s: BuildState, e: BuildEvent): Partial<BuildState> {
  switch (e.kind) {
    case "started":
      return { title: e.title, system: e.system };
    case "step":
      return { lines: appendOutput(s.lines, `${e.command}\n`, "system") };
    case "output":
      return { lines: appendOutput(s.lines, e.text, e.stderr ? "err" : "out") };
    case "message":
      return { messages: [...s.messages, e.message] };
    case "progress":
      return { message: e.message };
  }
}

/** The root's text when a build ends (IDEA's `build.messages.finished` / `failed` / `cancelled`). */
const OUTCOME: Record<BuildKind, Record<"finished" | "failed" | "cancelled", () => string>> = {
  build: {
    finished: () => tx("build finished"),
    failed: () => tx("build failed"),
    cancelled: () => tx("build cancelled"),
  },
  rebuild: {
    finished: () => tx("rebuild finished"),
    failed: () => tx("rebuild failed"),
    cancelled: () => tx("rebuild cancelled"),
  },
  artifacts: {
    finished: () => tx("build artifacts finished"),
    failed: () => tx("build artifacts failed"),
    cancelled: () => tx("build artifacts cancelled"),
  },
};

/**
 * Feeds the event tree: a Maven build's console goes through the Maven parser (projects,
 * goals, compiler messages, as IDEA's delegated build); other builds list their messages by file.
 */
class TreeFeed {
  private maven: MavenOutputParser | null = null;
  private partial = "";
  private cwd: string | null = null;

  constructor(readonly tree: ExecTree) {}

  apply(e: BuildEvent) {
    switch (e.kind) {
      case "started":
        if (e.system === "maven")
          this.maven = new MavenOutputParser(this.tree, {
            mode: "run",
            resolvePath: (p) => (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || !this.cwd ? p : `${this.cwd}/${p}`),
          });
        break;
      case "step":
        this.cwd = e.cwd;
        break;
      case "output": {
        if (!this.maven) break;
        const text = this.partial + e.text;
        const parts = text.split("\n");
        this.partial = parts.pop() ?? "";
        for (const line of parts) this.maven.feed(line);
        break;
      }
      case "message":
        if (!this.maven) this.add(e.message);
        break;
    }
  }

  private add(m: BuildMessage) {
    const start = m.range?.start;
    this.tree.message(
      null,
      m.severity === "error" ? "error" : m.severity === "warning" ? "warning" : "info",
      m.text,
      m.path ? { path: m.path, line: start?.line ?? null, col: start?.col ?? null } : null,
    );
  }

  finish(success: boolean, cancelled: boolean, messages: readonly BuildMessage[]) {
    // The backend's messages are the build's final list: those the stream did not bring
    // (another console format, a message sent only with the result) are added.
    const known = new Set(this.tree.messages().map((n) => `${n.file?.path ?? ""}:${n.file?.line ?? ""}:${n.name}`));
    for (const m of messages) {
      const key = `${m.path ?? ""}:${m.range?.start.line ?? ""}:${m.text.split("\n")[0]!.trim()}`;
      if (!known.has(key) && (m.path || !success || !this.maven)) this.add(m);
    }
    if (this.maven) {
      if (this.partial) this.maven.feed(this.partial);
      this.maven.finish(success ? 0 : 1, cancelled);
    } else {
      this.tree.finishBuild(cancelled ? "skipped" : success ? "success" : "failed");
    }
  }
}

export function isBuilding(): boolean {
  return useBuildRun.getState().status === "running";
}

/**
 * Builds the project (`file` null) or the module containing `file`. Saves all
 * documents first; a second build while one runs is ignored (IDEA disables the actions).
 */
export async function startBuild(
  kind: BuildKind,
  file: string | null = null,
  activate = true,
): Promise<BuildResult | null> {
  if (isBuilding() || !useProject.getState().project) return null;
  const request = nextRequestId();
  const taskTitle = TITLES[kind];
  const cancel = () => backend.cancel(request);
  const previous = useBuildRun.getState().files;
  // IDEA titles the tree with the project for Build / Rebuild, else with the build's name.
  const project = useProject.getState().project;
  const tree = new ExecTree(
    kind === "artifacts" ? tx(taskTitle) : (project?.name ?? basename(project?.root ?? "")),
    Date.now(),
    project?.root ?? null,
  );
  const feed = new TreeFeed(tree);
  useBuildRun.setState({ ...INITIAL, request, kind, file, title: taskTitle, status: "running", files: previous, tree });
  selectBuildTab("build");
  setContext(BUILD_RUNNING, true);
  if (activate) {
    try {
      toolWindowService().show("build", false);
    } catch {
      // No workbench (tests / settings window).
    }
  }
  upsertTask({ id: BUILD_TASK_ID, title: taskTitle, message: null, fraction: null, done: false, cancel });
  await maybeEditorService()
    ?.saveAll()
    .catch(() => undefined);

  let queue: BuildEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    const events = queue;
    queue = [];
    if (useBuildRun.getState().request !== request || !events.length) return;
    let s = useBuildRun.getState();
    for (const e of events) {
      s = { ...s, ...applyBuildEvent(s, e) };
      feed.apply(e);
    }
    useBuildRun.setState(s);
    if (s.message)
      upsertTask({ id: BUILD_TASK_ID, title: taskTitle, message: s.message, fraction: null, done: false, cancel });
  };
  const onEvent = (e: BuildEvent) => {
    queue.push(e);
    timer ??= setTimeout(flush, 16);
  };

  let result: BuildResult | null = null;
  try {
    result = await backend.run(kind, file, request, previous, onEvent);
    clearTimeout(timer);
    flush();
    const status: BuildStatus = result.success ? "success" : "failed";
    feed.finish(result.success, false, result.messages);
    tree.describe("root", OUTCOME[kind][result.success ? "finished" : "failed"](), finishedAtHint(Date.now()));
    useBuildRun.setState({
      status,
      title: result.title,
      system: result.system,
      messages: result.messages,
      durationMs: result.durationMs,
      files: messageFiles(result.messages),
      message: null,
    });
    const summary = finishSummary(result);
    notifications().notify({
      group: "run",
      level: result.success ? (result.warnings ? "warning" : "info") : "error",
      title: summary,
      key: "build-finished",
      sticky: false,
      actions:
        result.success && !result.warnings
          ? undefined
          : [{ label: "Show Build", run: () => toolWindowService().show("build", true) }],
    });
    if (!result.success) showFailure();
  } catch (e) {
    clearTimeout(timer);
    flush();
    if (isCancelled(e)) {
      feed.finish(false, true, []);
      tree.describe("root", OUTCOME[kind].cancelled(), finishedAtHint(Date.now()));
      useBuildRun.setState({ status: "cancelled", files: [], message: null });
    } else {
      const text = e instanceof Error ? e.message : String(e);
      tree.message(null, "error", text);
      feed.finish(false, false, []);
      tree.describe("root", OUTCOME[kind].failed(), finishedAtHint(Date.now()));
      useBuildRun.setState((s) => ({
        status: "failed",
        files: [],
        message: null,
        lines: appendOutput(s.lines, `${text}\n`, "err"),
        messages: [...s.messages, { severity: "error", text, path: null, range: null, code: null }],
      }));
      notifications().notify({
        group: "run",
        level: "error",
        title: "Build failed",
        body: text,
        key: "build-finished",
      });
      showFailure();
    }
  } finally {
    if (useBuildRun.getState().request === request) useBuildRun.setState({ request: null });
    setContext(
      BUILD_LAST_STATUS,
      result?.success ? "success" : useBuildRun.getState().status === "cancelled" ? "cancelled" : "failed",
    );
    setContext(BUILD_RUNNING, false);
    upsertTask({ id: BUILD_TASK_ID, title: taskTitle, message: null, fraction: 1, done: true });
  }
  return result;
}

/** Opens the source of a build message; `focus` moves focus to the editor (otherwise a preview). */
export function navigateToMessage(m: BuildMessage, focus: boolean) {
  if (!m.path) return;
  const start = m.range?.start;
  void maybeEditorService()
    ?.openFile(m.path, { selection: start ? { line: start.line, col: start.col } : undefined, focus, preview: !focus })
    .catch(() => undefined);
}

export function selectBuildNode(key: string | null) {
  if (useBuildRun.getState().selected !== key) useBuildRun.setState({ selected: key });
}

/**
 * A failed build activates the tool window without focusing it, selects the
 * first error and navigates to it, as IDEA does by default.
 */
function showFailure() {
  try {
    toolWindowService().show("build", false);
  } catch {
    // No workbench (tests / settings window).
  }
  const { messages, tree } = useBuildRun.getState();
  const first = firstError(messages);
  const node = tree?.firstError();
  if (node) selectBuildNode(node.id);
  if (first) navigateToMessage(first.message, true);
  else if (node?.file)
    void maybeEditorService()
      ?.openFile(node.file.path, {
        selection: node.file.line != null ? { line: node.file.line, col: node.file.col ?? 0 } : undefined,
        focus: true,
      })
      .catch(() => undefined);
}

export function stopBuild() {
  const { request } = useBuildRun.getState();
  if (request == null) return;
  // Through the task, so its progress says "Cancelling…" until the build has stopped.
  if (useTasks.getState().tasks.some((t) => t.id === BUILD_TASK_ID && t.cancel)) cancelTask(BUILD_TASK_ID);
  else backend.cancel(request);
}

/** Runs the last build again (the tool window's rerun button). */
export function rerunBuild() {
  const { kind, file } = useBuildRun.getState();
  return startBuild(kind ?? "build", file);
}

export function resetBuildRun() {
  stopBuild();
  removeTask(BUILD_TASK_ID);
  setContext(BUILD_RUNNING, false);
  useBuildRun.setState(INITIAL);
}
