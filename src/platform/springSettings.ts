/**
 * Spring settings (`settings.spring`, the bundled plugin's `spring.*` keys) with every field
 * present: the Settings dialog edits them, the Spring feature reads them.
 * Mirrors `ide-core::spring` defaults (the plugin is on by default).
 */
import { useMemo } from "react";
import type { SpringSettings } from "./ipc";
import { useProject } from "./project";

export interface SpringPrefs {
  enabled: boolean;
  /** Profiles the IDE analyses with; empty: every profile may be active. */
  activeProfiles: string[];
  /** Beans of the libraries (auto-configuration), read through the Java language server. */
  libraryBeans: boolean;
}

export const DEFAULT_SPRING: SpringPrefs = { enabled: true, activeProfiles: [], libraryBeans: true };

export function validateSpring(raw: SpringSettings | unknown): SpringPrefs {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULT_SPRING.enabled,
    activeProfiles: Array.isArray(v.activeProfiles)
      ? v.activeProfiles.filter((p): p is string => typeof p === "string" && p.trim() !== "").map((p) => p.trim())
      : DEFAULT_SPRING.activeProfiles,
    libraryBeans: typeof v.libraryBeans === "boolean" ? v.libraryBeans : DEFAULT_SPRING.libraryBeans,
  };
}

let cachedRaw: unknown = Symbol("unset");
let cached = DEFAULT_SPRING;

/** The applied settings of this window. */
export function springPrefs(): SpringPrefs {
  const raw = useProject.getState().settings?.spring;
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = validateSpring(raw);
  }
  return cached;
}

/** React hook: the applied settings. */
export function useSpringPrefs(): SpringPrefs {
  const raw = useProject((s) => s.settings?.spring);
  return useMemo(() => validateSpring(raw), [raw]);
}
