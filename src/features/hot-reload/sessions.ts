/**
 * Hot-reloading sessions: Run tool window tabs (`run:<id>`) and debug sessions
 * (`debug:<id>`) whose JVM runs with hot reload. Each has a timeline fed by its console
 * (the agent's log) and by HotSwap; the session's tab is marked with ⚡, gets the Hot Reload
 * view and its agent lines fold. The latest reload drives the editor chip and the status bar.
 */
import { create } from "zustand";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import {
  selectSessionView,
  setSessionMark,
  toolWindowService,
  useDebugRunSessions,
  type SessionMark,
} from "@/workbench/contributions";
import { rerunSession, useRun } from "@/features/run/store";
import { useDebug, isLive, selectSession, type DebugSession } from "@/features/debugger/state";
import { AGENT_PREFIX } from "./parser";
import { Timeline, reloadedAnything, statusOf, type ReloadEntry } from "./timeline";

export const VIEW_ID = "hotReload";

export const MARK: SessionMark = {
  icon: "hot-reload",
  tooltip: "Hot Reload",
  views: [VIEW_ID],
  quiet: [AGENT_PREFIX],
};

export interface HotSession {
  key: string;
  name: string;
  configId: string;
  mode: "run" | "debug";
  engine: string;
  /** `JetBrains Runtime 21.0.11` or the project JDK (JRebel). */
  runtime: string;
  /** Module directory relative to the project root ("" for the root). */
  module: string;
  /** The run session's `startedAt` this timeline belongs to (a rerun in the same tab starts another). */
  startedAt: number;
  live: boolean;
  timeline: Timeline;
  /** Bumped when the timeline changes. */
  version: number;
}

/** The reload the editor chip and the status bar show. */
export interface LatestReload {
  key: string;
  entry: ReloadEntry;
  /** Bumped per change of the entry (the chip restarts its fade). */
  seq: number;
}

interface HotSessionsState {
  sessions: Readonly<Record<string, HotSession>>;
  latest: LatestReload | null;
}

export const useHotSessions = create<HotSessionsState>(() => ({ sessions: {}, latest: null }));

let seq = 0;

function update(key: string, entry: ReloadEntry | null) {
  useHotSessions.setState((s) => {
    const session = s.sessions[key];
    if (!session) return s;
    const sessions = { ...s.sessions, [key]: { ...session, version: session.version + 1 } };
    // A lone warning (no reload) only updates the timeline unless it continues the shown reload.
    const shows = entry && (reloadedAnything(entry) || statusOf(entry) !== "ok" || s.latest?.entry === entry);
    return shows ? { sessions, latest: { key, entry: { ...entry }, seq: ++seq } } : { sessions };
  });
}

/** Starts the timeline of `key` (a launch with hot reload is starting). */
export function attachSession(
  key: string,
  info: Omit<HotSession, "key" | "live" | "timeline" | "version">,
): (line: string) => void {
  const timeline = new Timeline();
  useHotSessions.setState((s) => ({
    sessions: { ...s.sessions, [key]: { ...info, key, live: true, timeline, version: 0 } },
    latest: s.latest?.key === key ? null : s.latest,
  }));
  setSessionMark(key, MARK);
  return (line) => {
    if (!line.includes(AGENT_PREFIX) || useHotSessions.getState().sessions[key]?.timeline !== timeline) return;
    const entry = timeline.feedText(line);
    update(key, entry);
  };
}

export function detachSession(key: string) {
  setSessionMark(key, null);
  selectSessionView(key, null);
  useHotSessions.setState((s) => {
    if (!s.sessions[key]) return s;
    const sessions = { ...s.sessions };
    delete sessions[key];
    return { sessions, latest: s.latest?.key === key ? null : s.latest };
  });
}

function setLive(key: string, live: boolean) {
  useHotSessions.setState((s) => {
    const session = s.sessions[key];
    if (!session || session.live === live) return s;
    return { sessions: { ...s.sessions, [key]: { ...session, live } } };
  });
}

/** A HotSwap's result in session `key`. */
export function recordHotSwap(key: string, classes: readonly string[], errors: readonly string[], durationMs: number) {
  const session = useHotSessions.getState().sessions[key];
  if (!session) return;
  update(key, session.timeline.hotSwap(classes, errors, durationMs));
}

/** A change the running application won't pick up (Spring Boot 4's configuration files). */
export function recordRestartNeeded(key: string, file: string, message: string) {
  const session = useHotSessions.getState().sessions[key];
  if (!session) return;
  update(key, session.timeline.restartNeeded(file, message));
}

export function dismissLatest() {
  useHotSessions.setState({ latest: null });
}

/** Opens session `key`'s Hot Reload view. */
export function showTimeline(key: string) {
  const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  selectSessionView(key, VIEW_ID);
  try {
    if (kind === "run") {
      useRun.setState({ activeSession: id });
      toolWindowService().show("run", true);
    } else {
      selectSession(Number(id));
      toolWindowService().show("debug", true);
    }
  } catch {
    /* no workbench (tests) */
  }
}

/** Restarts session `key`'s application (Rerun of its tab). */
export function restartSession(key: string) {
  const id = key.slice(key.indexOf(":") + 1);
  if (key.startsWith("run:")) {
    rerunSession(id);
    return;
  }
  const debug = useDebugRunSessions.getState().serviceSessions.find((s) => s.id === Number(id));
  if (debug?.rerun) debug.rerun();
  else void executeAction("debug.rerun");
}

/** Debug-mode launches (java-debug starts the JVM) waiting for their debug session. */
const pendingDebug = new Map<string, { at: number; info: Omit<HotSession, "key" | "live" | "timeline" | "version"> }>();

export function expectDebugSession(configId: string, info: Omit<HotSession, "key" | "live" | "timeline" | "version">) {
  pendingDebug.set(configId, { at: Date.now(), info });
}

/** Config ids of Maven / Gradle / Tomcat debug launches: their debugger's HotSwap reports to the run tab. */
const debugTargets = new Map<string, string>();

export function expectDebugTarget(configId: string, key: string) {
  debugTargets.set(configId, key);
}

/** The timeline a debug session's HotSwap belongs to. */
export function timelineKeyOf(session: DebugSession): string | null {
  const own = `debug:${session.id}`;
  if (useHotSessions.getState().sessions[own]) return own;
  const target = session.runConfig ? debugTargets.get(session.runConfig.id) : undefined;
  return target && useHotSessions.getState().sessions[target]?.live ? target : null;
}

/** Follows Run tabs and debug sessions: reruns, exits, closed tabs and debug consoles. */
export function trackSessions(): () => void {
  const consoles = new Map<string, { lines: unknown; seen: number; feed: (line: string) => void }>();
  const offRun = useRun.subscribe((s) => {
    for (const hot of Object.values(useHotSessions.getState().sessions)) {
      if (!hot.key.startsWith("run:")) continue;
      const session = s.sessions.find((x) => `run:${x.id}` === hot.key);
      if (!session || session.startedAt !== hot.startedAt) detachSession(hot.key);
      else setLive(hot.key, session.status === "running" || session.status === "starting");
    }
  });
  const offDebug = useDebug.subscribe((s) => {
    const now = Date.now();
    for (const [configId, p] of pendingDebug) {
      if (now - p.at > 120_000) {
        pendingDebug.delete(configId);
        continue;
      }
      const session = Object.values(s.sessions).find(
        (x) => x.id >= 0 && x.parent == null && x.runConfig?.id === configId && isLive(x),
      );
      if (!session) continue;
      pendingDebug.delete(configId);
      const key = `debug:${session.id}`;
      consoles.set(key, { lines: null, seen: 0, feed: attachSession(key, { ...p.info, startedAt: now }) });
    }
    for (const [key, c] of consoles) {
      const id = Number(key.slice("debug:".length));
      const session = s.sessions[id];
      if (!session) {
        consoles.delete(key);
        detachSession(key);
        continue;
      }
      setLive(key, isLive(session));
      const lines = s.console[id];
      if (!lines || lines === c.lines) continue;
      c.lines = lines;
      for (const line of lines) {
        if (line.id <= c.seen) continue;
        c.seen = line.id;
        c.feed(line.text);
      }
    }
  });
  return () => {
    offRun();
    offDebug();
    for (const key of Object.keys(useHotSessions.getState().sessions)) detachSession(key);
    pendingDebug.clear();
    debugTargets.clear();
  };
}

/** "3 classes", translated per count. */
export const classesText = (n: number) => (n === 1 ? tx`${n} class` : tx`${n} classes`);
