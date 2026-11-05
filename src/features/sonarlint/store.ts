/**
 * SonarQube for IDE, UI side: the engine's status, its download (SonarSource's
 * package from Open VSX plus a Java 21 runtime when none is installed), turning
 * it on and off, and per-rule overrides (`sonarlint.rules`).
 */
import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { InstallEvent, SonarLintSettings, SonarRule, SonarStatus } from "@/bindings";
import { call, commands, isCancelled, isTauri, nextRequestId } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { tx } from "@/platform/i18n";
import { notifications } from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";
import { DOWNLOAD_QUEUE } from "@/features/tools/store";
import { queueTask, upsertTask } from "@/workbench/tasks";

export const SETTINGS_PAGE = "tools.sonarlint";
export const TOOL = "sonarlint";
/** The universal package from Open VSX, unpacked (analyzers, server, JS bridge). */
export const ENGINE_SIZE = "180 MB";

/** A rule override with its defaults filled in. */
export interface RuleOverride {
  level: "on" | "off";
  parameters: Record<string, string>;
}
export type RuleOverrides = Record<string, RuleOverride>;

/** `sonarlint` settings with every field present. */
export interface SonarPrefs {
  enabled: boolean;
  rules: RuleOverrides;
  testFilePattern: string;
  analysisExcludes: string;
  nodePath: string;
  vmArgs: string;
}

export function sonarPrefs(s: SonarLintSettings | null | undefined): SonarPrefs {
  const rules: RuleOverrides = {};
  for (const [key, r] of Object.entries(s?.rules ?? {})) {
    if (r) rules[key] = { level: r.level === "off" ? "off" : "on", parameters: { ...(r.parameters ?? {}) } };
  }
  return {
    enabled: s?.enabled ?? false,
    rules,
    testFilePattern: s?.testFilePattern ?? "",
    analysisExcludes: s?.analysisExcludes ?? "",
    nodePath: s?.nodePath ?? "",
    vmArgs: s?.vmArgs ?? "",
  };
}

/** The applied settings of this window. */
export const appliedPrefs = () => sonarPrefs(useProject.getState().settings?.sonarlint);

/** Where a download stands, for the progress shown on the plugin and settings pages. */
export type InstallPhase = "prepare" | "engine" | "unpack" | "java" | "javaUnpack";

export interface InstallJob {
  request: number;
  phase: InstallPhase;
  /** 0..1 of the current download; null while indeterminate. */
  fraction: number | null;
  /** Bytes so far ("74.3 / 168.3 MB"), or what is happening. */
  detail: string | null;
}

export function phaseTitle(phase: InstallPhase): string {
  switch (phase) {
    case "prepare":
      return tx("Preparing the download…");
    case "engine":
      return tx("Downloading the analysis engine");
    case "unpack":
      return tx("Unpacking the analysis engine…");
    case "java":
      return tx("Downloading a Java 21 runtime");
    case "javaUnpack":
      return tx("Unpacking the Java runtime…");
  }
}

/** The installer's next state after event `e` (its lines name the steps). */
export function nextJob(job: InstallJob, e: InstallEvent): InstallJob {
  if (e.type === "progress") {
    const total = /([\d.]+) of ([\d.]+) MB/.exec(e.message);
    const sofar = /([\d.]+) MB/.exec(e.message);
    const detail = total ? `${total[1]} / ${total[2]} MB` : sofar ? `${sofar[1]} MB` : job.detail;
    return { ...job, fraction: e.fraction ?? null, detail };
  }
  const text = e.text;
  const java = job.phase === "java" || job.phase === "javaUnpack";
  if (/^Downloading a Java/.test(text)) return { ...job, phase: "java", fraction: 0, detail: null };
  if (/^Downloading /.test(text)) return { ...job, phase: java ? "java" : "engine", fraction: 0, detail: null };
  if (/^(Extracting|Checksum verified)/.test(text))
    return { ...job, phase: java ? "javaUnpack" : "unpack", fraction: null, detail: null };
  if (/^Connection interrupted/.test(text)) return { ...job, detail: tx("Connection interrupted, resuming…") };
  return job;
}

interface SonarState {
  status: SonarStatus | null;
  loading: boolean;
  job: InstallJob | null;
  error: string | null;
  /** Why the last download failed (shown with Retry until the next attempt). */
  installError: string | null;
}

export const useSonar = create<SonarState>(() => ({
  status: null,
  loading: false,
  job: null,
  error: null,
  installError: null,
}));

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function refreshStatus(): Promise<SonarStatus | null> {
  if (!isTauri()) {
    useSonar.setState({ status: { installed: false, version: null, java: null, node: null } });
    return useSonar.getState().status;
  }
  useSonar.setState({ loading: true });
  try {
    const status = await call(commands.sonarStatus());
    useSonar.setState({ status, loading: false, error: null });
    return status;
  } catch (e) {
    useSonar.setState({ loading: false, error: errorText(e) });
    return null;
  }
}

export const ready = (s: SonarStatus | null) => !!s?.installed && !!s.java;

let running: Promise<boolean> | null = null;

/** Downloads (or updates / repairs) the engine; true when it is ready afterwards. */
export function installEngine(): Promise<boolean> {
  if (running) return running;
  const request = nextRequestId();
  const taskId = "sonarlint:install";
  const title = tx("Downloading SonarQube for IDE");
  const cancel = () => void commands.cancelRequest(request).catch(() => {});
  const show = (job: InstallJob) => {
    useSonar.setState({ job });
    const message = job.detail ? `${phaseTitle(job.phase)} · ${job.detail}` : phaseTitle(job.phase);
    upsertTask({ id: taskId, title, message, fraction: job.fraction, done: false, cancel });
  };
  useSonar.setState({
    job: { request, phase: "prepare", fraction: null, detail: null },
    error: null,
    installError: null,
  });
  running = (async () => {
    try {
      const status = await queueTask(DOWNLOAD_QUEUE, { id: taskId, title }, () => {
        show({ request, phase: "prepare", fraction: null, detail: null });
        const channel = new Channel<InstallEvent>();
        channel.onmessage = (e) => {
          const job = useSonar.getState().job;
          if (job?.request === request) show(nextJob(job, e));
        };
        return call(commands.sonarInstall(request, channel));
      });
      useSonar.setState({ status, job: null });
      upsertTask({ id: taskId, title, message: null, fraction: 1, done: true });
      return ready(status);
    } catch (e) {
      upsertTask({ id: taskId, title, message: null, fraction: null, done: true });
      if (isCancelled(e)) {
        useSonar.setState({ job: null });
        return false;
      }
      const message = errorText(e);
      useSonar.setState({ job: null, installError: message });
      notifications().notify({
        group: "sonarlint",
        level: "error",
        title: "Failed to download SonarQube for IDE",
        body: message,
        key: "sonarlint.install",
      });
      return false;
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Retry after a failed download: download, then turn on. */
export async function retryInstall(): Promise<void> {
  if (await installEngine()) await writeSetting("sonarlint.enabled", true);
}

export function cancelInstall() {
  const job = useSonar.getState().job;
  if (job) void commands.cancelRequest(job.request).catch(() => {});
}

/** Removes the downloaded engine (the Java runtime stays: other servers use it). */
export async function removeEngine(): Promise<void> {
  await setEnabled(false);
  try {
    await call(commands.toolsUninstall(TOOL));
  } catch (e) {
    useSonar.setState({ error: errorText(e) });
  }
  await refreshStatus();
}

async function writeSetting(key: string, value: unknown) {
  if (!isTauri()) return;
  useProject.setState({ settings: await call(commands.settingsSet("global", key, JSON.stringify(value))) });
}

/** What "Download and Enable" will fetch, for the confirmation. */
function downloadNote(status: SonarStatus | null): string {
  return status?.java
    ? tx`SonarSource's analysis engine (about ${ENGINE_SIZE}) is downloaded from Open VSX. Its analyzers are licensed by SonarSource under SSALv1.`
    : tx`SonarSource's analysis engine (about ${ENGINE_SIZE}) and a Java 21 runtime are downloaded. Its analyzers are licensed by SonarSource under SSALv1.`;
}

/**
 * Turns SonarQube for IDE on or off. Turning it on first downloads the engine
 * when it isn't there, after the user agreed to the download.
 */
export async function setEnabled(on: boolean): Promise<void> {
  if (!on) {
    await writeSetting("sonarlint.enabled", false);
    return;
  }
  const status = useSonar.getState().status ?? (await refreshStatus());
  if (!ready(status)) {
    const ok = await confirm({
      title: tx("Download SonarQube for IDE?"),
      message: downloadNote(status),
      ok: tx("Download and Enable"),
      icon: "question",
    });
    if (!ok || !(await installEngine())) return;
  }
  await writeSetting("sonarlint.enabled", true);
}

/** A rule's effective activation: its override, else Sonar's way. */
export function isActive(rule: SonarRule, rules: RuleOverrides): boolean {
  const level = rules[rule.key]?.level;
  return level === "off" ? false : level === "on" ? true : rule.activeByDefault;
}

/** `rules` with `rule` turned on or off; an override equal to the default (and without parameters) goes away. */
export function withActivation(rules: RuleOverrides, rule: SonarRule, on: boolean): RuleOverrides {
  const next = { ...rules };
  const parameters = next[rule.key]?.parameters ?? {};
  if (on === rule.activeByDefault && !Object.keys(parameters).length) delete next[rule.key];
  else next[rule.key] = { level: on ? "on" : "off", parameters };
  return next;
}

/** `rules` with parameter `name` of `rule` set (empty: back to its default). */
export function withParameter(rules: RuleOverrides, rule: SonarRule, name: string, value: string): RuleOverrides {
  const current: RuleOverride = rules[rule.key] ?? { level: rule.activeByDefault ? "on" : "off", parameters: {} };
  const parameters = { ...current.parameters };
  if (value.trim()) parameters[name] = value.trim();
  else delete parameters[name];
  const next: RuleOverrides = { ...rules, [rule.key]: { ...current, parameters } };
  if ((current.level === "on") === rule.activeByDefault && !Object.keys(parameters).length) delete next[rule.key];
  return next;
}

/** The code action's "Deactivate rule 'java:S1135'": the IDE-level override. */
export async function deactivateRule(key: string): Promise<void> {
  const rules = appliedPrefs().rules;
  const parameters = rules[key]?.parameters ?? {};
  await writeSetting("sonarlint.rules", { ...rules, [key]: { level: "off", parameters } });
  notifications().notify({
    group: "sonarlint",
    level: "info",
    title: tx`Rule ${key} deactivated`,
    key: `sonarlint.deactivated.${key}`,
    actions: [
      {
        label: "Undo",
        run: () => {
          const next = { ...appliedPrefs().rules };
          const previous = rules[key];
          if (previous) next[key] = previous;
          else delete next[key];
          void writeSetting("sonarlint.rules", next);
        },
      },
    ],
  });
}
