/**
 * HotSwap (IDEA: Run › Debugging Actions › Reload Changed Classes) through
 * java-debug's hot code replace: compile with jdtls, then `redefineClasses`
 * in every Java debug session. When jdtls finishes a build on its own (after
 * a save) java-debug reports `BUILD_COMPLETE` and Settings › Debugger › HotSwap ›
 * "Reload classes after compilation" decides: Always reloads (with a result
 * notification), Ask offers the reload, Never leaves it.
 */
import { call, commands, isTauri, type DebugEvent, type DebugSessionId } from "@/platform/ipc";
import { workflowSettings, type ReloadClassesPolicy } from "@/platform/workflowSettings";
import { maybeEditorService, notifications } from "@/workbench/contributions";
import { isLive, useDebug, type DebugSession } from "./state";
import { tx } from "@/platform/i18n";

const KEY = "debug.hotswap";
/** `BUILD_COMPLETE` events of our own build are not worth a prompt. */
let quietUntil = 0;

/** A reload's outcome, for features that report it elsewhere (Hot Reload's timeline). */
export interface HotSwapReport {
  sessions: readonly DebugSession[];
  changed: readonly string[];
  errors: readonly string[];
  durationMs: number;
}

/**
 * Hot Reload's hold on HotSwap: its debug sessions always reload (no prompt) and it
 * reports the outcome itself; `report` returns true when no notification is needed.
 */
export interface HotSwapObserver {
  policy(session: DebugSession): ReloadClassesPolicy | null;
  report(result: HotSwapReport): boolean;
}

let observer: HotSwapObserver | null = null;

export function setHotSwapObserver(o: HotSwapObserver): () => void {
  observer = o;
  return () => {
    if (observer === o) observer = null;
  };
}

/** What a finished build does in `session`: the observer's policy, else the setting. */
export function reloadPolicy(session: DebugSession | undefined): ReloadClassesPolicy {
  return (session && observer?.policy(session)) ?? workflowSettings().debugger.reloadClasses;
}

export function hotSwapSessions(): DebugSession[] {
  return Object.values(useDebug.getState().sessions).filter((s) => isLive(s) && !!s.caps?.hotCodeReplace);
}

/** "3 classes", translated per count (the sentence around it is translated on its own). */
const classesText = (n: number) => (n === 1 ? tx`${n} class` : tx`${n} classes`);

/** Message for the reload result (IDEA wording). */
export function hotSwapMessage(
  changed: number,
  errors: string[],
): { level: "info" | "error"; title: string; body?: string } {
  if (errors.length) return { level: "error", title: "Hot Swap failed", body: errors.join("\n") };
  if (changed === 0) return { level: "info", title: "Loaded classes are up to date. Nothing to reload." };
  return { level: "info", title: tx`${classesText(changed)} reloaded` };
}

/** Compiles (unless `build` is false) and reloads changed classes into every Java debug session. */
export async function reloadChangedClasses(build = true, configId?: string): Promise<void> {
  const sessions = hotSwapSessions().filter((s) => !configId || s.runConfig?.id === configId);
  if (!sessions.length || !isTauri()) {
    notifications().notify({ group: "run", level: "info", key: KEY, title: "No debug session can reload classes" });
    return;
  }
  quietUntil = Date.now() + 60_000;
  try {
    if (build) {
      try {
        await maybeEditorService()?.saveAll();
      } catch {
        /* best effort */
      }
      const modules = new Set(sessions.map((s) => s.launch?.cwd ?? ""));
      for (const module of modules) {
        const status = await call(commands.javaBuildWorkspace(module)).catch(() => null);
        if (status === "failed" || status === "withErrors") {
          notifications().notify({
            group: "run",
            level: "error",
            key: KEY,
            title: "Hot Swap failed",
            body: "Compilation failed: fix the errors and reload again.",
          });
          return;
        }
      }
    }
    const changed = new Set<string>();
    const errors: string[] = [];
    const started = performance.now();
    for (const s of sessions) {
      try {
        const r = await call(commands.debugRedefineClasses(s.id));
        r.changedClasses.forEach((c) => changed.add(c));
        if (r.errorMessage) errors.push(r.errorMessage);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    const handled = observer?.report({
      sessions,
      changed: [...changed],
      errors,
      durationMs: performance.now() - started,
    });
    if (handled) return;
    const m = hotSwapMessage(changed.size, errors);
    notifications().notify({ group: "run", key: KEY, ...m });
  } finally {
    quietUntil = Date.now() + 2_000;
  }
}

/** java-debug's `hotcodereplace` events of a session this window owns. */
export function onHotCodeReplace(session: DebugSessionId, event: Extract<DebugEvent, { kind: "hotCodeReplace" }>) {
  const s = useDebug.getState().sessions[session];
  if (!s) return;
  switch (event.changeType) {
    case "BUILD_COMPLETE": {
      if (Date.now() < quietUntil) return;
      const policy = reloadPolicy(s);
      if (policy === "never") return;
      if (policy === "always") {
        void reloadChangedClasses(false);
        return;
      }
      notifications().notify({
        group: "run",
        level: "info",
        key: KEY,
        title: "Classes changed",
        body: "Reload the changed classes into the running debug session?",
        actions: [{ label: "Reload", run: () => void reloadChangedClasses(false) }],
      });
      break;
    }
    case "ERROR":
    case "WARNING":
      notifications().notify({
        group: "run",
        level: event.changeType === "ERROR" ? "error" : "warning",
        key: KEY,
        title: "Hot Swap",
        body: event.message,
      });
      break;
  }
}
