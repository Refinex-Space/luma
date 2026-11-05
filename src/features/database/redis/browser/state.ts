/**
 * UI state of the Redis Browser tabs, kept while a tab is hidden: the layout (key list
 * as a tree or flat, its width, the command line's height and whether it is open —
 * remembered across sessions), and per database the expanded folders and the command
 * line's output and history.
 */
import { create } from "zustand";
import type { RedisReply } from "@/platform/ipc";
import type { RedisTarget } from "../model";

export interface CliEntry {
  id: number;
  /** The prompt it ran at (`cache:db0`). */
  prompt: string;
  text: string;
  reply: RedisReply | null;
  error: string | null;
  ms: number | null;
}

export interface CliSession {
  /** Where the next command runs (`SELECT n` moves it). */
  target: RedisTarget;
  entries: CliEntry[];
  /** Commands run, newest first. */
  history: string[];
}

interface Layout {
  flat: boolean;
  cliOpen: boolean;
  cliHeight: number;
  keysWidth: number;
}

/** The key list's node key of a folder (`prefix`: `user:42:`); keys are `k:<keyId>`. */
export const folderNodeKey = (prefix: string) => `f:${prefix}`;

interface BrowserUi extends Layout {
  /** Browser target → its expanded folders (`folderNodeKey`s). */
  expanded: Record<RedisTarget, readonly string[]>;
  /** Browser target → its command line. */
  cli: Record<RedisTarget, CliSession>;
  /** Browser target → bumped when keys may have changed underneath (the command line). */
  reload: Record<RedisTarget, number>;
}

const LAYOUT_KEY = "luma.redisBrowser.layout";
export const CLI_MIN = 96;
export const KEYS_MIN = 220;
const DEFAULTS: Layout = { flat: false, cliOpen: true, cliHeight: 220, keysWidth: 340 };

function storedLayout(): Layout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return DEFAULTS;
    const v = JSON.parse(raw) as Partial<Layout>;
    return {
      flat: typeof v.flat === "boolean" ? v.flat : DEFAULTS.flat,
      cliOpen: typeof v.cliOpen === "boolean" ? v.cliOpen : DEFAULTS.cliOpen,
      cliHeight: typeof v.cliHeight === "number" ? Math.max(CLI_MIN, v.cliHeight) : DEFAULTS.cliHeight,
      keysWidth: typeof v.keysWidth === "number" ? Math.max(KEYS_MIN, v.keysWidth) : DEFAULTS.keysWidth,
    };
  } catch {
    return DEFAULTS;
  }
}

export const useBrowserUi = create<BrowserUi>(() => ({ ...storedLayout(), expanded: {}, cli: {}, reload: {} }));

useBrowserUi.subscribe((s, prev) => {
  if (
    s.flat === prev.flat &&
    s.cliOpen === prev.cliOpen &&
    s.cliHeight === prev.cliHeight &&
    s.keysWidth === prev.keysWidth
  )
    return;
  try {
    const layout: Layout = { flat: s.flat, cliOpen: s.cliOpen, cliHeight: s.cliHeight, keysWidth: s.keysWidth };
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // Private mode / blocked storage: the layout lasts the session.
  }
});

export const setLayout = (p: Partial<Layout>) => useBrowserUi.setState(p);

export function setExpanded(target: RedisTarget, prefixes: Iterable<string>) {
  useBrowserUi.setState((s) => ({ expanded: { ...s.expanded, [target]: [...prefixes] } }));
}

export function bumpReload(target: RedisTarget) {
  useBrowserUi.setState((s) => ({ reload: { ...s.reload, [target]: (s.reload[target] ?? 0) + 1 } }));
}

/** Most entries a command line keeps (older ones scroll away for good). */
export const MAX_ENTRIES = 300;
const MAX_HISTORY = 200;

export function cliSession(browser: RedisTarget): CliSession {
  return useBrowserUi.getState().cli[browser] ?? { target: browser, entries: [], history: [] };
}

export function updateCli(browser: RedisTarget, f: (s: CliSession) => CliSession) {
  useBrowserUi.setState((s) => ({ cli: { ...s.cli, [browser]: f(s.cli[browser] ?? cliSession(browser)) } }));
}

export function pushHistory(history: readonly string[], line: string): string[] {
  return [line, ...history.filter((h) => h !== line)].slice(0, MAX_HISTORY);
}
