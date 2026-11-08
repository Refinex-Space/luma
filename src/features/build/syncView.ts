/**
 * The Build tool window's Sync tab (IDEA's `MavenSyncConsole` / Gradle sync view):
 * the output of the last Maven or Gradle reload with its event tree (downloads,
 * POM problems, errors). The Maven / Gradle tool windows feed it while they sync.
 */
import { create } from "zustand";
import { tx } from "@/platform/i18n";
import type { BuildTool } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { MavenOutputParser, type MavenParserOptions } from "./exec/maven";
import { ExecTree, finishedAtHint } from "./exec/tree";
import { appendOutput, type ConsoleLine } from "./model";

export interface SyncViewState {
  tool: BuildTool | null;
  tree: ExecTree | null;
  lines: ConsoleLine[];
  running: boolean;
  /** Re-runs the sync (the tab's Rerun). */
  rerun: (() => void) | null;
  /** Stops it. */
  stop: (() => void) | null;
}

export const useSyncView = create<SyncViewState>(() => ({
  tool: null,
  tree: null,
  lines: [],
  running: false,
  rerun: null,
  stop: null,
}));

/** Which content of the Build tool window is shown (IDEA's Sync | Build Output tabs). */
export const useBuildTabs = create<{ active: "sync" | "build" }>(() => ({ active: "build" }));

export function selectBuildTab(active: "sync" | "build") {
  useBuildTabs.setState({ active });
}

let parser: MavenOutputParser | null = null;
let pending: string[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

function flush() {
  timer = undefined;
  if (!pending.length) return;
  const text = pending.join("\n") + "\n";
  pending = [];
  useSyncView.setState((s) => ({ lines: appendOutput(s.lines, text, "out") }));
}

export interface SyncStart {
  tool: BuildTool;
  project: string;
  rerun: () => void;
  stop: () => void;
  /** Maps paths and ids Maven prints to the project's POMs. */
  maven?: Omit<MavenParserOptions, "mode">;
}

/** A sync starts: a fresh tree titled "Sync", its console cleared; the tab becomes the shown one. */
export function startSyncView(start: SyncStart) {
  clearTimeout(timer);
  pending = [];
  const project = start.project;
  const tree = new ExecTree(tx("Sync"), Date.now(), useProject.getState().project?.root ?? null);
  tree.describe("root", tx`Sync ${project}`, null);
  parser = start.tool === "maven" ? new MavenOutputParser(tree, { mode: "sync", ...start.maven }) : null;
  useSyncView.setState({ tool: start.tool, tree, lines: [], running: true, rerun: start.rerun, stop: start.stop });
  selectBuildTab("sync");
}

/** A console line of the running sync. */
export function syncViewOutput(line: string) {
  if (!useSyncView.getState().running) return;
  parser?.feed(line);
  pending.push(line);
  timer ??= setTimeout(flush, 32);
}

/** The sync finished; `error` is the summary of a failed one (shown under the root when nothing else says why). */
export function finishSyncView(outcome: "success" | "failed" | "cancelled", error?: string | null) {
  clearTimeout(timer);
  flush();
  const tree = useSyncView.getState().tree;
  if (!tree) return;
  const now = Date.now();
  if (outcome === "failed" && error && tree.root.errors === 0)
    for (const line of error.split("\n").filter((l) => l.trim())) tree.message(null, "error", line.trim(), null, now);
  if (parser) parser.finish(outcome === "success" ? 0 : 1, outcome === "cancelled", now);
  else tree.finishBuild(outcome === "success" ? "success" : outcome === "cancelled" ? "skipped" : "failed", now);
  tree.describe("root", outcome === "cancelled" ? tx("cancelled") : "", finishedAtHint(now));
  parser = null;
  useSyncView.setState({ running: false, stop: null });
}

export function resetSyncView() {
  clearTimeout(timer);
  pending = [];
  parser = null;
  useSyncView.setState({ tool: null, tree: null, lines: [], running: false, rerun: null, stop: null });
}
