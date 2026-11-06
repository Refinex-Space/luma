/**
 * A hot-reloading session's timeline: agent lines and debugger reloads grouped into
 * reloads. Lines that follow each other within `BURST_GAP_MS` (the agent reloads classes,
 * then Spring refreshes beans a few hundred ms later) are one reload, with the time from
 * its first to its last action. Lines before the first reload describe the start-up.
 */
import { agentEvent, parseAgentLine, type AgentLine } from "./parser";

/** Agent loggers that report plugin set-up per class loader, never a reload's outcome. */
const SETUP_LOGGER = /\.(InitHandler|PluginRegistry|PluginManager\$\w+|URLClassPathHelper|WatchResourcesPlugin)$/;

export const BURST_GAP_MS = 2000;
const DAY_MS = 86_400_000;

export type ReloadStatus = "ok" | "warning" | "error";

export interface ReloadEntry {
  id: number;
  /** Wall-clock time the reload began (ms since epoch). */
  at: number;
  /** `17:09:21` of its first action. */
  time: string;
  /** Milliseconds since midnight of the first / last action. */
  startMs: number;
  endMs: number;
  classes: string[];
  beansAdded: string[];
  beansRefreshed: string[];
  /** Reloaded property files (`application.properties`); "" when the agent didn't name one. */
  properties: string[];
  mappers: string[];
  warnings: string[];
  errors: string[];
  /** Reloaded by the debugger (HotSwap) rather than the agent's file watcher. */
  hotSwap: boolean;
  /** Changed files the application only picks up on a restart. */
  restartFiles: string[];
}

export interface StartupInfo {
  agent: string | null;
  plugins: Array<{ name: string; version: string | null }>;
  warnings: string[];
}

export const msOfDay = (date: Date) =>
  ((date.getHours() * 60 + date.getMinutes()) * 60 + date.getSeconds()) * 1000 + date.getMilliseconds();

const formatTime = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600) % 24)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
};

/** `b - a` across midnight. */
const elapsed = (a: number, b: number) => {
  const d = b - a;
  return d < -DAY_MS / 2 ? d + DAY_MS : d;
};

const push = (list: string[], value: string) => {
  if (!list.includes(value)) list.push(value);
};

export const durationOf = (e: ReloadEntry) => elapsed(e.startMs, e.endMs);

export function statusOf(e: ReloadEntry): ReloadStatus {
  return e.errors.length ? "error" : e.warnings.length ? "warning" : "ok";
}

/** Whether the entry changed anything (a lone warning reports a problem, not a reload). */
export const reloadedAnything = (e: ReloadEntry) =>
  e.classes.length + e.beansAdded.length + e.beansRefreshed.length + e.properties.length + e.mappers.length > 0;

let nextId = 1;

export class Timeline {
  readonly startup: StartupInfo = { agent: null, plugins: [], warnings: [] };
  readonly entries: ReloadEntry[] = [];
  /** Agent lines seen (the console's folded lines). */
  lines = 0;

  /** The reload a new action at `ms` joins, or a new one. */
  private burst(ms: number, now: number): ReloadEntry {
    const last = this.entries[this.entries.length - 1];
    if (last && elapsed(last.endMs, ms) <= BURST_GAP_MS && elapsed(last.endMs, ms) >= -BURST_GAP_MS) {
      if (elapsed(last.endMs, ms) > 0) last.endMs = ms;
      return last;
    }
    const entry: ReloadEntry = {
      id: nextId++,
      at: now,
      time: formatTime(ms),
      startMs: ms,
      endMs: ms,
      classes: [],
      beansAdded: [],
      beansRefreshed: [],
      properties: [],
      mappers: [],
      warnings: [],
      errors: [],
      hotSwap: false,
      restartFiles: [],
    };
    this.entries.push(entry);
    return entry;
  }

  /** A console line; the reload it changed, if any. */
  feedText(text: string, now = Date.now()): ReloadEntry | null {
    const line = parseAgentLine(text);
    return line ? this.feed(line, now) : null;
  }

  feed(line: AgentLine, now = Date.now()): ReloadEntry | null {
    this.lines++;
    const event = agentEvent(line);
    const started = this.entries.length > 0;
    switch (event.kind) {
      case "started":
        this.startup.agent = event.version;
        return null;
      case "plugin":
        if (!this.startup.plugins.some((p) => p.name === event.name))
          this.startup.plugins.push({ name: event.name, version: event.version });
        return null;
      case "other":
        return null;
      case "noChange": {
        // Part of a reload under way (it doesn't extend its duration), never one of its own.
        const last = this.entries[this.entries.length - 1];
        return last && Math.abs(elapsed(last.endMs, line.ms)) <= BURST_GAP_MS ? last : null;
      }
      case "warning":
      case "error":
        // A plugin failing to set up for a class loader (also ones created late, like Tomcat's
        // webapp loader) is about the agent, not about a reload.
        if (!started || SETUP_LOGGER.test(line.logger)) {
          this.startup.warnings.push(event.message);
          return null;
        }
        break;
    }
    const entry = this.burst(line.ms, now);
    switch (event.kind) {
      case "classes":
        event.classes.forEach((c) => push(entry.classes, c));
        break;
      case "beanAdded":
        push(entry.beansAdded, event.bean);
        break;
      case "beanRefreshed":
        push(entry.beansRefreshed, event.bean ?? "");
        break;
      case "properties":
        if (event.file || !entry.properties.length) push(entry.properties, event.file ?? "");
        if (event.file) entry.properties = entry.properties.filter((p) => p);
        break;
      case "mapper":
        push(entry.mappers, event.name);
        break;
      case "warning":
        entry.warnings.push(event.message);
        break;
      case "error":
        entry.errors.push(event.message);
        break;
    }
    return entry;
  }

  /** `file` changed but the application applies it only on a restart (`message` says why). */
  restartNeeded(file: string, message: string, now = Date.now()): ReloadEntry {
    const entry = this.burst(msOfDay(new Date(now)), now);
    push(entry.restartFiles, file);
    push(entry.warnings, message);
    return entry;
  }

  /** The Spring Boot version the agent's Spring Boot plugin reported, if any. */
  get springBootVersion(): string | null {
    return this.startup.plugins.find((p) => /^spring ?boot$/i.test(p.name))?.version ?? null;
  }

  /** A debugger HotSwap (java-debug `redefineClasses`): joins the agent's reload under way. */
  hotSwap(classes: readonly string[], errors: readonly string[], durationMs: number, now = Date.now()): ReloadEntry {
    const end = msOfDay(new Date(now));
    const entry = this.burst(Math.round(end - durationMs), now);
    if (elapsed(entry.endMs, end) > 0) entry.endMs = end;
    entry.hotSwap = true;
    classes.forEach((c) => push(entry.classes, c));
    entry.errors.push(...errors);
    return entry;
  }
}
