/**
 * Lombok settings (`settings.lombok`, the bundled plugin's `lombok.*` keys) with every
 * field present: the Settings dialog edits them, the Lombok feature reads them.
 * Mirrors `ide-core::lombok` defaults (the plugin is on by default).
 */
import { useMemo } from "react";
import type { LombokSettings } from "./ipc";
import { useProject } from "./project";

export interface LombokPrefs {
  enabled: boolean;
  /** A Lombok jar instead of the bundled one; empty: bundled. */
  agentPath: string;
}

export const DEFAULT_LOMBOK: LombokPrefs = { enabled: true, agentPath: "" };

export function validateLombok(raw: LombokSettings | unknown): LombokPrefs {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULT_LOMBOK.enabled,
    agentPath: typeof v.agentPath === "string" ? v.agentPath : DEFAULT_LOMBOK.agentPath,
  };
}

let cachedRaw: unknown = Symbol("unset");
let cached = DEFAULT_LOMBOK;

/** The applied settings of this window. */
export function lombokPrefs(): LombokPrefs {
  const raw = useProject.getState().settings?.lombok;
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = validateLombok(raw);
  }
  return cached;
}

/** React hook: the applied settings. */
export function useLombokPrefs(): LombokPrefs {
  const raw = useProject((s) => s.settings?.lombok);
  return useMemo(() => validateLombok(raw), [raw]);
}
