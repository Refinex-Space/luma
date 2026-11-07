/**
 * .env files settings (`settings.dotenv`, the bundled plugin's `dotenv.*` keys) with every
 * field present: the Settings dialog edits them, the .env feature reads them.
 * Mirrors `ide-core::dotenv` defaults (the plugin is on by default).
 */
import { useMemo } from "react";
import type { DotEnvSettings } from "./ipc";
import { useProject } from "./project";

export interface DotEnvPrefs {
  enabled: boolean;
  /** Complete environment variables in code. */
  completion: boolean;
  /** Show values in that completion. */
  showValues: boolean;
  /** Fold the values of `.env` files when they open. */
  hideValues: boolean;
}

export const DEFAULT_DOTENV: DotEnvPrefs = { enabled: true, completion: true, showValues: true, hideValues: false };

export function validateDotEnv(raw: DotEnvSettings | unknown): DotEnvPrefs {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const flag = (k: keyof DotEnvPrefs) => (typeof v[k] === "boolean" ? (v[k] as boolean) : DEFAULT_DOTENV[k]);
  return {
    enabled: flag("enabled"),
    completion: flag("completion"),
    showValues: flag("showValues"),
    hideValues: flag("hideValues"),
  };
}

let cachedRaw: unknown = Symbol("unset");
let cached = DEFAULT_DOTENV;

/** The applied settings of this window. */
export function dotenvPrefs(): DotEnvPrefs {
  const raw = useProject.getState().settings?.dotenv;
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = validateDotEnv(raw);
  }
  return cached;
}

/** React hook: the applied settings. */
export function useDotEnvPrefs(): DotEnvPrefs {
  const raw = useProject((s) => s.settings?.dotenv);
  return useMemo(() => validateDotEnv(raw), [raw]);
}
