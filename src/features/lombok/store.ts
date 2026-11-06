/**
 * The Lombok plugin's state: what the backend reports (`lombok_status`: the agent jdtls
 * runs with, whether the project uses Lombok, its `lombok.config` files), refreshed when
 * the project or the plugin's settings change.
 */
import { create } from "zustand";
import { call, commands, isTauri, type LombokStatus } from "@/platform/ipc";
import { lombokPrefs } from "@/platform/lombokSettings";
import { useProject } from "@/platform/project";

export const SETTINGS_PAGE = "languages.lombok";
/** Context key: the Lombok plugin is on (its actions' `when`). */
export const LOMBOK_ENABLED = "lombokEnabled";

interface LombokState {
  status: LombokStatus | null;
  loading: boolean;
}

export const useLombok = create<LombokState>(() => ({ status: null, loading: false }));

let pending: Promise<LombokStatus | null> | null = null;

export function refreshStatus(): Promise<LombokStatus | null> {
  if (!isTauri()) return Promise.resolve(null);
  pending ??= (async () => {
    useLombok.setState({ loading: true });
    try {
      const status = await call(commands.lombokStatus());
      useLombok.setState({ status });
      return status;
    } catch {
      return null;
    } finally {
      useLombok.setState({ loading: false });
      pending = null;
    }
  })();
  return pending;
}

/**
 * Whether Java editors offer Lombok support: the plugin is on and the project uses Lombok
 * (else a file importing `lombok.` still counts: `imports` is its text's verdict).
 */
export function lombokActive(imports = false): boolean {
  if (!lombokPrefs().enabled) return false;
  return imports || useLombok.getState().status?.usesLombok === true;
}

/** Whether `text` (a Java source) imports Lombok. */
export const importsLombok = (text: string) => /^\s*import\s+(static\s+)?lombok\./m.test(text);

/** Writes `lombok.<field>` (in the browser build: in memory). */
export async function writeSetting(field: "enabled" | "agentPath", value: unknown) {
  if (!isTauri()) {
    const settings = useProject.getState().settings;
    if (settings) useProject.setState({ settings: { ...settings, lombok: { ...settings.lombok, [field]: value } } });
    return;
  }
  useProject.setState({
    settings: await call(commands.settingsSet("global", `lombok.${field}`, JSON.stringify(value))),
  });
}

/** jdtls attaches the agent at start: it restarts with the new one. */
export async function restartJavaServer(): Promise<void> {
  if (!isTauri()) return;
  try {
    const servers = await call(commands.lspServers());
    await Promise.all(servers.filter((s) => s.name === "jdtls").map((s) => call(commands.lspRestart(s.id))));
  } catch {
    // No project or server: the next start picks the setting up.
  }
}

/** Turns the plugin on or off (`index.ts` restarts jdtls with or without the agent). */
export async function setEnabled(on: boolean): Promise<void> {
  if (lombokPrefs().enabled !== on) await writeSetting("enabled", on);
}
