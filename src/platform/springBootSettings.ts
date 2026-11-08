/**
 * Spring Boot settings (`settings.springBoot`, the bundled plugin's `springBoot.*` keys) with
 * every field present: the Settings dialog edits them, the Spring Boot feature reads them.
 * Mirrors `ide-core::spring_boot` defaults (the plugin is on by default).
 */
import { useMemo } from "react";
import type { SpringBootSettings } from "./ipc";
import { useProject } from "./project";

export interface SpringBootPrefs {
  enabled: boolean;
  /** Configuration file names besides `application`. */
  configNames: string[];
  /** More configuration files, project-relative. */
  configFiles: string[];
  /** Connect to running Boot applications with Actuator. */
  liveData: boolean;
  /** Seconds between Health refreshes. */
  healthRefresh: number;
  /** New run configurations disable the launch optimization. */
  disableLaunchOptimization: boolean;
}

export const DEFAULT_SPRING_BOOT: SpringBootPrefs = {
  enabled: true,
  configNames: [],
  configFiles: [],
  liveData: true,
  healthRefresh: 15,
  disableLaunchOptimization: false,
};

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim()) : [];

export function validateSpringBoot(raw: SpringBootSettings | unknown): SpringBootPrefs {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SPRING_BOOT;
  const refresh =
    typeof v.healthRefresh === "number" && Number.isFinite(v.healthRefresh) ? v.healthRefresh : d.healthRefresh;
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : d.enabled,
    configNames: Array.isArray(v.configNames) ? strings(v.configNames) : d.configNames,
    configFiles: Array.isArray(v.configFiles) ? strings(v.configFiles) : d.configFiles,
    liveData: typeof v.liveData === "boolean" ? v.liveData : d.liveData,
    healthRefresh: Math.min(3600, Math.max(1, Math.round(refresh))),
    disableLaunchOptimization:
      typeof v.disableLaunchOptimization === "boolean" ? v.disableLaunchOptimization : d.disableLaunchOptimization,
  };
}

let cachedRaw: unknown = Symbol("unset");
let cached = DEFAULT_SPRING_BOOT;

/** The applied settings of this window. */
export function springBootPrefs(): SpringBootPrefs {
  const raw = useProject.getState().settings?.springBoot;
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = validateSpringBoot(raw);
  }
  return cached;
}

/** React hook: the applied settings. */
export function useSpringBootPrefs(): SpringBootPrefs {
  const raw = useProject((s) => s.settings?.springBoot);
  return useMemo(() => validateSpringBoot(raw), [raw]);
}
