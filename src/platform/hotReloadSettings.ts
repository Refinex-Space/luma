/**
 * Hot Reload settings (`settings.hotReload`, the bundled plugin's `hotReload.*` keys) with
 * every field present: the Settings dialog edits them, the hot reload feature reads them
 * when a JVM launches. Mirrors `ide-core::hot_reload` defaults.
 */
import { useMemo } from "react";
import type { HotReloadSettings } from "./ipc";
import { useProject } from "./project";

export type HotReloadEngine = "hotswapAgent" | "jrebel";

export interface HotReloadPrefs {
  enabled: boolean;
  engine: HotReloadEngine;
  agentPath: string;
  jrebelAgentPath: string;
  disabledPlugins: string[];
  extraClasspath: string[];
  watchResources: string[];
  disableDevtoolsRestart: boolean;
  editorFeedback: boolean;
  springBootDefault: boolean;
  logLevel: string;
}

export const DEFAULT_HOT_RELOAD: HotReloadPrefs = {
  enabled: false,
  engine: "hotswapAgent",
  agentPath: "",
  jrebelAgentPath: "",
  disabledPlugins: [],
  extraClasspath: [],
  watchResources: [],
  disableDevtoolsRestart: true,
  editorFeedback: true,
  springBootDefault: false,
  logLevel: "info",
};

const strings = (v: unknown, d: string[]) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [...d];

export function validateHotReload(raw: HotReloadSettings | unknown): HotReloadPrefs {
  const d = DEFAULT_HOT_RELOAD;
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const bool = (x: unknown, fallback: boolean) => (typeof x === "boolean" ? x : fallback);
  const str = (x: unknown, fallback: string) => (typeof x === "string" ? x : fallback);
  return {
    enabled: bool(v.enabled, d.enabled),
    engine: v.engine === "jrebel" ? "jrebel" : "hotswapAgent",
    agentPath: str(v.agentPath, d.agentPath),
    jrebelAgentPath: str(v.jrebelAgentPath, d.jrebelAgentPath),
    disabledPlugins: strings(v.disabledPlugins, d.disabledPlugins),
    extraClasspath: strings(v.extraClasspath, d.extraClasspath),
    watchResources: strings(v.watchResources, d.watchResources),
    disableDevtoolsRestart: bool(v.disableDevtoolsRestart, d.disableDevtoolsRestart),
    editorFeedback: bool(v.editorFeedback, d.editorFeedback),
    springBootDefault: bool(v.springBootDefault, d.springBootDefault),
    logLevel: str(v.logLevel, d.logLevel) || d.logLevel,
  };
}

let cachedRaw: unknown = Symbol("unset");
let cached = DEFAULT_HOT_RELOAD;

/** The applied settings of this window. */
export function hotReloadPrefs(): HotReloadPrefs {
  const raw = useProject.getState().settings?.hotReload;
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = validateHotReload(raw);
  }
  return cached;
}

/** React hook: the applied settings. */
export function useHotReloadPrefs(): HotReloadPrefs {
  const raw = useProject((s) => s.settings?.hotReload);
  return useMemo(() => validateHotReload(raw), [raw]);
}
