/**
 * Hot Reload plugin state: what is installed (HotswapAgent, the JetBrains Runtimes, JRebel's
 * agent), downloading it with progress (the plugin card, the settings page, the status bar's
 * background tasks and launches waiting for it), and turning the plugin on and off.
 */
import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { HotReloadStatus, InstallEvent } from "@/bindings";
import { call, commands, isCancelled, isTauri, nextRequestId } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { hotReloadPrefs } from "@/platform/hotReloadSettings";
import { tx } from "@/platform/i18n";
import { notifications } from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";
import { DOWNLOAD_QUEUE } from "@/features/tools/store";
import { queueTask, upsertTask } from "@/workbench/tasks";

export const SETTINGS_PAGE = "build.debugger.hotswap";
/** The runtime enabling the plugin downloads (most Spring Boot 3 projects). */
export const DEFAULT_MAJOR = 21;
export const RUNTIME_SIZE = "230 MB";
export const AGENT_SIZE = "2 MB";

export type InstallPhase = "prepare" | "agent" | "runtime" | "verify" | "unpack";

export interface InstallJob {
  request: number;
  phase: InstallPhase;
  /** The runtime being downloaded (`runtime` / `unpack`). */
  major: number | null;
  fraction: number | null;
  detail: string | null;
}

export function phaseTitle(job: Pick<InstallJob, "phase" | "major">): string {
  switch (job.phase) {
    case "prepare":
      return tx("Preparing the download…");
    case "agent":
      return tx("Downloading HotswapAgent");
    case "runtime": {
      const major = job.major ?? DEFAULT_MAJOR;
      return tx`Downloading JetBrains Runtime ${major}`;
    }
    case "verify":
      return tx("Verifying the download…");
    case "unpack":
      return tx("Unpacking the JetBrains Runtime…");
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
  if (/^Downloading HotswapAgent/.test(text)) return { ...job, phase: "agent", major: null, fraction: 0, detail: null };
  const runtime = /^Downloading jbr\w*-(\d+)/.exec(text);
  if (runtime) return { ...job, phase: "runtime", major: Number(runtime[1]), fraction: 0, detail: null };
  if (/^Checksum verified/.test(text))
    return { ...job, phase: job.phase === "agent" ? "agent" : "verify", fraction: null, detail: null };
  if (/^Extracting/.test(text)) return { ...job, phase: "unpack", fraction: null, detail: null };
  if (/^Checksum mismatch/.test(text)) return { ...job, detail: tx("Checksum mismatch, downloading again…") };
  if (/^Connection interrupted/.test(text)) return { ...job, detail: tx("Connection interrupted, resuming…") };
  return job;
}

interface HotReloadState {
  status: HotReloadStatus | null;
  job: InstallJob | null;
  error: string | null;
  /** Why the last download failed (shown with Retry until the next attempt). */
  installError: string | null;
}

export const useHotReload = create<HotReloadState>(() => ({
  status: null,
  job: null,
  error: null,
  installError: null,
}));

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Status in plain-browser mode: nothing installed, the pinned runtimes. */
const BROWSER_STATUS: HotReloadStatus = {
  engine: "hotswapAgent",
  agent: null,
  runtimes: [
    { major: 17, version: "17.0.14", build: "b1367.22", experimental: false, home: null },
    { major: 21, version: "21.0.11", build: "b1163.125", experimental: false, home: null },
    { major: 25, version: "25.0.4.1", build: "b635.79", experimental: true, home: null },
  ],
  platformSupported: true,
  jrebel: null,
};

export async function refreshStatus(): Promise<HotReloadStatus | null> {
  if (!isTauri()) {
    if (!useHotReload.getState().status) useHotReload.setState({ status: BROWSER_STATUS });
    return useHotReload.getState().status;
  }
  try {
    const status = await call(commands.hotReloadStatus());
    useHotReload.setState({ status, error: null });
    return status;
  } catch (e) {
    useHotReload.setState({ error: errorText(e) });
    return null;
  }
}

/** Whether the default engine can launch without downloading anything first. */
export function ready(status: HotReloadStatus | null, major = DEFAULT_MAJOR): boolean {
  if (!status) return false;
  if (hotReloadPrefs().engine === "jrebel") return true;
  return !!status.agent && (!status.platformSupported || !!status.runtimes.find((r) => r.major === major)?.home);
}

let running: { majors: string; promise: Promise<boolean> } | null = null;

/**
 * Downloads HotswapAgent (unless JRebel or an own jar is used) and JetBrains Runtimes `majors`;
 * true when they are installed afterwards. A download already under way is joined.
 */
export function installComponents(majors: readonly number[]): Promise<boolean> {
  const key = [...majors].sort().join(",");
  if (running) {
    const current = running;
    // The same download is joined; another one starts once it is done.
    return current.majors === key ? current.promise : current.promise.then(() => installComponents(majors));
  }
  const request = nextRequestId();
  const taskId = "hotReload:install";
  const title = tx("Downloading Hot Reload");
  const cancel = () => void commands.cancelRequest(request).catch(() => {});
  const show = (job: InstallJob) => {
    useHotReload.setState({ job });
    const message = job.detail ? `${phaseTitle(job)} · ${job.detail}` : phaseTitle(job);
    upsertTask({ id: taskId, title, message, fraction: job.fraction, done: false, cancel });
  };
  const first: InstallJob = { request, phase: "prepare", major: null, fraction: null, detail: null };
  useHotReload.setState({ job: first, error: null, installError: null });
  const promise = (async () => {
    try {
      if (!isTauri()) throw new Error(tx("Hot Reload needs the desktop app"));
      const status = await queueTask(DOWNLOAD_QUEUE, { id: taskId, title }, () => {
        show(first);
        const channel = new Channel<InstallEvent>();
        channel.onmessage = (e) => {
          const job = useHotReload.getState().job;
          if (job?.request === request) show(nextJob(job, e));
        };
        return call(commands.hotReloadInstall([...majors], request, channel));
      });
      useHotReload.setState({ status, job: null });
      upsertTask({ id: taskId, title, message: null, fraction: 1, done: true });
      return majors.every((m) => !!status.runtimes.find((r) => r.major === m)?.home);
    } catch (e) {
      upsertTask({ id: taskId, title, message: null, fraction: null, done: true });
      if (isCancelled(e)) {
        useHotReload.setState({ job: null });
        return false;
      }
      const message = errorText(e);
      useHotReload.setState({ job: null, installError: message });
      notifications().notify({
        group: "hotReload",
        level: "error",
        title: "Failed to download Hot Reload",
        body: message,
        key: "hotReload.install",
      });
      return false;
    } finally {
      running = null;
    }
  })();
  running = { majors: key, promise };
  return promise;
}

export function cancelInstall() {
  const job = useHotReload.getState().job;
  if (job) void commands.cancelRequest(job.request).catch(() => {});
}

export async function writeSetting(key: string, value: unknown) {
  if (!isTauri()) {
    const settings = useProject.getState().settings;
    if (!settings) return;
    const [section, field] = key.split(".") as ["hotReload", string];
    useProject.setState({
      settings: { ...settings, [section]: { ...settings[section], [field]: value } },
    });
    return;
  }
  useProject.setState({ settings: await call(commands.settingsSet("global", key, JSON.stringify(value))) });
}

/** Retry after a failed download: download, then turn on. */
export async function retryInstall(): Promise<void> {
  if (await installComponents([DEFAULT_MAJOR])) await writeSetting("hotReload.enabled", true);
}

/**
 * Turns Hot Reload on or off. Turning it on first downloads HotswapAgent and JetBrains
 * Runtime 21 when they aren't there, after the user agreed to the download.
 */
export async function setEnabled(on: boolean): Promise<void> {
  if (!on) {
    await writeSetting("hotReload.enabled", false);
    return;
  }
  const status = useHotReload.getState().status ?? (await refreshStatus());
  if (!ready(status)) {
    const ok = await confirm({
      title: tx("Download Hot Reload?"),
      message: tx`HotswapAgent (about ${AGENT_SIZE}) and JetBrains Runtime ${DEFAULT_MAJOR} (about ${RUNTIME_SIZE}) are downloaded. Other Java versions download when a project needs them.`,
      ok: tx("Download and Enable"),
      icon: "question",
    });
    if (!ok) return;
    const majors = status?.platformSupported === false ? [] : [DEFAULT_MAJOR];
    if (!(await installComponents(majors))) return;
  }
  await writeSetting("hotReload.enabled", true);
}
