/**
 * Maven / Gradle tool window state: the build model of the open project (static
 * parse + cached sync, from `build_model`), background syncs and Maven tasks
 * (`build_sync`, `maven_task`, shown as cancellable background tasks and in the
 * Build tool window's Sync tab), Settings › Maven (offline, Skip Tests, ignored
 * projects, goal task activation are project settings, as in IDEA), the explicit
 * profiles and view options (per project, in localStorage) and running goals through
 * the run feature's actions.
 */
import { confirm } from "@/workbench/messages";
import { tx } from "@/platform/i18n";
import { create } from "zustand";
import { Channel } from "@tauri-apps/api/core";
import { executeAction } from "@/platform/actions";
import {
  call,
  commands,
  isCancelled,
  isTauri,
  nextRequestId,
  type ArtifactFilter,
  type BuildModel,
  type BuildTool,
  type MavenTaskKind,
  type MavenTaskSettings,
  type MavenUserFile,
  type RequestId,
  type RunConfig,
  type SyncProgress,
} from "@/platform/ipc";
import { downloadJdkActions } from "@/platform/jdk";
import { basename, useProject } from "@/platform/project";
import { editorService, notifications, toolWindowService } from "@/workbench/contributions";
import { cancelTask, removeTask, upsertTask, useTasks } from "@/workbench/tasks";
import { finishSyncView, startSyncView, syncViewOutput } from "@/features/build/syncView";
import { DEFAULT_MAVEN_VIEW, profilesList, type GradleRunOptions, type MavenViewOptions } from "./model";

export interface BuildSettings {
  maven: { profiles: Record<string, boolean> };
  gradle: GradleRunOptions;
}

export const DEFAULT_SETTINGS: BuildSettings = {
  maven: { profiles: {} },
  gradle: { offline: false },
};

/** The parts of Settings › Maven / Build Tools the tool window shows and toggles. */
export interface MavenProjectSettings {
  workOffline: boolean;
  skipTests: boolean;
  ignoredFiles: string[];
  ignoredPatterns: string[];
  tasks: MavenTaskSettings;
  /** Settings › Build Tools › "Sync project after changes in the build scripts". */
  autoReload: "all" | "selective" | "none";
}

export const DEFAULT_MAVEN_SETTINGS: MavenProjectSettings = {
  workOffline: false,
  skipTests: false,
  ignoredFiles: [],
  ignoredPatterns: [],
  tasks: {},
  autoReload: "selective",
};

interface SyncState {
  request: RequestId;
  message: string;
  fraction: number | null;
}

interface BuildState {
  /** Project the model belongs to. */
  root: string | null;
  model: BuildModel | null;
  loading: boolean;
  error: string | null;
  /** Run configurations (for the "Run Configurations" nodes). */
  configs: RunConfig[];
  syncing: Partial<Record<BuildTool, SyncState>>;
  /** A Maven task (update folders, downloads) running in the background. */
  mavenTask: { request: RequestId; kind: MavenTaskKind } | null;
  settings: BuildSettings;
  maven: MavenProjectSettings;
  view: MavenViewOptions;
  expanded: Record<BuildTool, Set<string>>;
  /** Execute Goal / Task popup. */
  executeOpen: BuildTool | null;
  /** Project selected in each tree (Maven `pom`, Gradle path): where Execute Goal runs. */
  current: Partial<Record<BuildTool, string>>;
  /** Maven `pom`s of the selected project nodes (Unlink, Sync Project). */
  selectedPoms: string[];
  /** The last action of the Sync split button (IDEA shows and runs it). */
  syncAction: "maven.syncAll" | "maven.reload";
  /** A node to select and scroll to (Select In › Maven). */
  reveal: { key: string; seq: number } | null;
}

export const useBuild = create<BuildState>(() => ({
  root: null,
  model: null,
  loading: false,
  error: null,
  configs: [],
  syncing: {},
  mavenTask: null,
  settings: DEFAULT_SETTINGS,
  maven: DEFAULT_MAVEN_SETTINGS,
  view: DEFAULT_MAVEN_VIEW,
  expanded: { maven: new Set(), gradle: new Set() },
  executeOpen: null,
  current: {},
  selectedPoms: [],
  syncAction: "maven.syncAll",
  reveal: null,
}));

// ---------------------------------------------------------------------------
// Per-project local state (profiles, Gradle offline, view options)

const SETTINGS_KEY = "luma.buildTools:";
const VIEW_KEY = "luma.mavenNavigator:";
const HISTORY_KEY = "luma.buildTools.history:";

export function readSettings(root: string): BuildSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY + root) ?? "null") as Partial<BuildSettings> | null;
    return {
      maven: { profiles: { ...raw?.maven?.profiles } },
      gradle: { ...DEFAULT_SETTINGS.gradle, ...raw?.gradle },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function writeLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

function readView(root: string): MavenViewOptions {
  try {
    return { ...DEFAULT_MAVEN_VIEW, ...(JSON.parse(localStorage.getItem(VIEW_KEY + root) ?? "null") as object | null) };
  } catch {
    return DEFAULT_MAVEN_VIEW;
  }
}

export function updateSettings(patch: (s: BuildSettings) => BuildSettings) {
  const settings = patch(useBuild.getState().settings);
  useBuild.setState({ settings });
  const root = useBuild.getState().root;
  if (root) writeLocal(SETTINGS_KEY + root, settings);
}

/** The tool window's options menu (Group Modules, Show Ignored Projects, …). */
export function setViewOption(key: keyof MavenViewOptions, value: boolean) {
  const view = { ...useBuild.getState().view, [key]: value };
  useBuild.setState({ view });
  const root = useBuild.getState().root;
  if (root) writeLocal(VIEW_KEY + root, view);
}

export const toggleGradleOffline = () =>
  updateSettings((s) => ({ ...s, gradle: { ...s.gradle, offline: !s.gradle.offline } }));

/** Sets an explicit profile choice (`undefined` = back to its default). */
export function setProfile(id: string, choice: boolean | undefined) {
  updateSettings((s) => {
    const profiles = { ...s.maven.profiles };
    if (choice === undefined) delete profiles[id];
    else profiles[id] = choice;
    return { ...s, maven: { profiles } };
  });
}

/** Reset Profiles: every profile back to its default. */
export function resetProfiles() {
  updateSettings((s) => ({ ...s, maven: { profiles: {} } }));
}

/** Explicit profiles and Skip Tests for a Maven run started from the tool window. */
export function mavenRunOptions() {
  const { settings, maven } = useBuild.getState();
  return { profiles: settings.maven.profiles, skipTests: maven.skipTests };
}

export function readHistory(tool: BuildTool): string[] {
  const root = useBuild.getState().root;
  try {
    const raw = JSON.parse(localStorage.getItem(`${HISTORY_KEY}${tool}:${root}`) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function pushHistory(tool: BuildTool, line: string) {
  const root = useBuild.getState().root;
  const next = [line, ...readHistory(tool).filter((h) => h !== line)].slice(0, 20);
  writeLocal(`${HISTORY_KEY}${tool}:${root}`, next);
}

// ---------------------------------------------------------------------------
// Project settings (Settings › Maven)

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function mavenProjectSettings(settings: unknown): MavenProjectSettings {
  const root = obj(settings);
  const maven = obj(obj(obj(root.languages).java).maven);
  const runner = obj(maven.runner);
  const auto = obj(root.buildTools).autoReload;
  return {
    workOffline: maven.workOffline === true,
    skipTests: runner.skipTests === true,
    ignoredFiles: strings(maven.ignoredFiles),
    ignoredPatterns: strings(maven.ignoredPatterns),
    tasks: obj(maven.tasks) as MavenTaskSettings,
    autoReload: auto === "all" || auto === "none" ? auto : "selective",
  };
}

async function readMavenSettings(): Promise<MavenProjectSettings> {
  try {
    return mavenProjectSettings(await commands.settingsGet());
  } catch {
    return useBuild.getState().maven;
  }
}

/** Writes a project setting under `languages.java.maven` (re-reads the model through `settingsChanged`). */
async function setMavenSetting(key: string, value: unknown) {
  const root = useBuild.getState().root;
  if (!root || !isTauri()) return;
  await call(commands.settingsSet("project", `languages.java.maven.${key}`, JSON.stringify(value)));
  if (useBuild.getState().root === root) useBuild.setState({ maven: await readMavenSettings() });
}

export const toggleMavenOffline = () => void setMavenSetting("workOffline", !useBuild.getState().maven.workOffline);
export const toggleSkipTests = () => void setMavenSetting("runner.skipTests", !useBuild.getState().maven.skipTests);

/** Ignore / Unignore Projects. */
export async function setIgnored(poms: readonly string[], ignored: boolean) {
  const current = useBuild.getState().maven.ignoredFiles;
  const next = ignored ? [...new Set([...current, ...poms])] : current.filter((p) => !poms.includes(p));
  await setMavenSetting("ignoredFiles", next);
}

/** Whether `pom` is ignored through a pattern (only Settings › Ignored Files can change that). */
export function ignoredByPattern(pom: string): boolean {
  const patterns = useBuild
    .getState()
    .maven.ignoredPatterns.flatMap((p) => p.split(/[\s,]+/))
    .filter(Boolean);
  return patterns.some((p) => {
    const re = new RegExp(
      `^${p
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")}$`,
    );
    return re.test(pom);
  });
}

export type TaskPhase = keyof MavenTaskSettings;

/** Execute Before Build / After Build / Before Rebuild / After Rebuild for `goals` of `pom`. */
export async function toggleTask(phase: TaskPhase, pom: string, goals: readonly string[], on: boolean) {
  const tasks = useBuild.getState().maven.tasks;
  const list = (tasks[phase] ?? []).filter((t) => !(t.pom === pom && goals.includes(t.goal ?? "")));
  const next = on ? [...list, ...goals.map((goal) => ({ pom, goal }))] : list;
  await setMavenSetting("tasks", { ...tasks, [phase]: next });
}

export function taskActive(phase: TaskPhase, pom: string, goal: string): boolean {
  return !!useBuild.getState().maven.tasks[phase]?.some((t) => t.pom === pom && t.goal === goal);
}

// ---------------------------------------------------------------------------
// Model

let generation = 0;
let externalChange = false;
let anyChange = false;

/**
 * A build file changed outside the editor (VCS update, another tool): the next model load
 * syncs a build it finds stale, IDEA's default "External changes". Edits in the editor only
 * show "Sync Maven Changes", unless Settings › Build Tools says "Any changes".
 */
export function noteExternalBuildChange() {
  externalChange = true;
}

/** A build file changed, also by an editor save (Build Tools › "Any changes"). */
export function noteBuildChange() {
  anyChange = true;
}

/** How long after the IDE saves a build file its file-system events still count as that save. */
const IDE_SAVE_WINDOW_MS = 5000;
/** Build files the IDE saved, with when: their file-system events are edits made in the IDE. */
const savedByIde = new Map<string, number>();

/** The IDE saved `path` (an editor save, not a tool rewriting it). */
export function noteIdeSave(path: string, now = Date.now()) {
  savedByIde.set(path, now);
}

/**
 * Whether any of the changed build files was written by something other than the IDE's own
 * save: a VCS update or a tool, also when the file is open in an editor tab.
 */
export function changedOutsideIde(paths: readonly string[], now = Date.now()): boolean {
  let external = false;
  for (const path of paths) {
    const at = savedByIde.get(path);
    if (at !== undefined && now - at <= IDE_SAVE_WINDOW_MS) continue;
    savedByIde.delete(path);
    external = true;
  }
  return external;
}

/** Re-reads the build model (and the run configurations) of the open project. */
export async function loadModel(): Promise<void> {
  const root = useProject.getState().project?.root ?? null;
  const gen = ++generation;
  if (root !== useBuild.getState().root) {
    useBuild.setState({
      root,
      model: null,
      configs: [],
      error: null,
      settings: root ? readSettings(root) : DEFAULT_SETTINGS,
      view: root ? readView(root) : DEFAULT_MAVEN_VIEW,
      expanded: { maven: new Set(), gradle: new Set() },
      current: {},
      selectedPoms: [],
    });
  }
  if (!root || useProject.getState().project?.trusted === false || !isTauri()) return;
  useBuild.setState({ loading: true });
  try {
    const [model, configs, maven] = await Promise.all([
      call(commands.buildModel()),
      call(commands.runConfigs()).catch(() => [] as RunConfig[]),
      readMavenSettings(),
    ]);
    if (gen !== generation) return;
    useBuild.setState({ model, configs, maven, loading: false, error: null });
    const auto = maven.autoReload;
    const reload = (auto === "selective" && externalChange) || (auto === "all" && (externalChange || anyChange));
    externalChange = false;
    anyChange = false;
    if (reload) {
      const m = model.maven;
      if (m?.stale && m.syncedAt !== null && !useBuild.getState().syncing.maven) void syncTool("maven");
    }
  } catch (e) {
    if (gen === generation) useBuild.setState({ loading: false, error: e instanceof Error ? e.message : String(e) });
  }
}

const UNLINKED_PROJECTS = "languages.java.maven.unlinkedProjects";

async function setLinked(root: string, pom: string, linked: boolean) {
  if (useProject.getState().project?.root !== root) return;
  const settings = await commands.settingsGet();
  if (useProject.getState().project?.root !== root) return;
  const previous = settings.languages.java?.maven?.unlinkedProjects ?? [];
  const next = linked ? previous.filter((p) => p !== pom) : [...new Set([...previous, pom])];
  if (JSON.stringify(next) === JSON.stringify(previous)) return;
  await call(commands.settingsSet("project", UNLINKED_PROJECTS, JSON.stringify(next)));
  await loadModel();
}

/** Root projects among `poms` (Unlink is offered for projects without an aggregator only). */
export function unlinkable(poms: readonly string[]): string[] {
  const projects = useBuild.getState().model?.maven?.projects ?? [];
  return poms.filter((pom) => projects.some((p) => p.pom === pom && !p.aggregated));
}

export async function unlinkProjects(pom: string | null) {
  const { root, model } = useBuild.getState();
  if (!root || !pom || !model?.maven?.projects.some((p) => p.pom === pom && !p.aggregated)) return;
  const name = model.maven.projects.find((p) => p.pom === pom)?.displayName ?? pom;
  if (
    !(await confirm({
      title: tx`Unlink Maven Project(s)`,
      message: tx`Maven Module(s) ${name} will be unlinked.\nNo files will be deleted.`,
      ok: "Remove",
    }))
  )
    return;
  cancelSync("maven");
  await setLinked(root, pom, false);
}

export async function addProjects() {
  const root = useProject.getState().project?.root;
  if (!root || !isTauri()) return;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    title: tx`Add Maven Projects`,
    directory: false,
    multiple: false,
    defaultPath: root,
    filters: [{ name: "pom.xml", extensions: ["xml"] }],
  });
  if (typeof picked !== "string") return;
  const base = root.replace(/\\/g, "/").replace(/\/$/, "");
  const path = picked.replace(/\\/g, "/");
  if (!path.startsWith(`${base}/`)) return;
  const pom = path.slice(base.length + 1);
  if (pom.split("/").some((part) => part === ".." || part === ".") || pom.split("/").pop() !== "pom.xml") return;
  await setLinked(root, pom, true);
}

/** Tree keys expanded on first show: the root projects. */
export function initialExpanded(tool: BuildTool, model: BuildModel): Set<string> {
  if (tool === "maven")
    return new Set(model.maven?.projects.filter((p) => !p.aggregated).map((p) => `mvn:${p.pom}`) ?? []);
  return new Set(model.gradle ? ["gradle::"] : []);
}

const TITLES: Record<BuildTool, string> = { maven: "Syncing Maven projects", gradle: "Syncing Gradle projects" };

function projectName(): string {
  const p = useProject.getState().project;
  return p?.name ?? basename(p?.root ?? "");
}

/** Maven paths and `group:artifact` ids → the project's POMs (Sync tab file messages). */
function mavenPaths() {
  const { root, model } = useBuild.getState();
  const projects = model?.maven?.projects ?? [];
  return {
    resolvePath: (p: string) => (p.startsWith("/") || !root ? p : `${root}/${p}`),
    pomOf: (id: string) => {
      const p = projects.find((x) => `${x.groupId}:${x.artifactId}` === id);
      return p && root ? `${root}/${p.pom}` : undefined;
    },
  };
}

/** Sync All Maven Projects: syncs only when a build file changed since (or never synced), else re-reads the model. */
export async function syncIncrementally(): Promise<void> {
  useBuild.setState({ syncAction: "maven.syncAll" });
  const m = useBuild.getState().model?.maven;
  if (!m || m.stale || m.syncedAt == null) return syncTool("maven");
  await loadModel();
}

/** Reloads all projects of `tool` from the build tool itself (effective POM, dependency tree, task list). */
export async function syncTool(tool: BuildTool): Promise<void> {
  const state = useBuild.getState();
  const gen = generation;
  const root = state.root;
  if (!root || !isTauri() || state.syncing[tool]) return;
  const request = nextRequestId();
  const taskId = `build-sync:${tool}`;
  const cancel = () => void commands.cancelRequest(request);
  const setSync = (s: SyncState | undefined) => useBuild.setState((st) => ({ syncing: { ...st.syncing, [tool]: s } }));
  setSync({ request, message: TITLES[tool], fraction: null });
  upsertTask({ id: taskId, title: TITLES[tool], message: null, fraction: null, done: false, cancel });
  startSyncView({
    tool,
    project: projectName(),
    rerun: () => void syncTool(tool),
    stop: () => cancelSync(tool),
    maven: tool === "maven" ? mavenPaths() : undefined,
  });
  const channel = new Channel<SyncProgress>();
  channel.onmessage = (p) => {
    if (useBuild.getState().syncing[tool]?.request !== request) return;
    if (p.output != null) syncViewOutput(p.output);
    const current = useBuild.getState().syncing[tool];
    if (current?.message === p.message && current.fraction === p.fraction) return;
    setSync({ request, message: p.message, fraction: p.fraction });
    upsertTask({ id: taskId, title: TITLES[tool], message: p.message, fraction: p.fraction, done: false, cancel });
  };
  const { settings, model } = state;
  const profiles = tool === "maven" && model?.maven ? profilesList(model.maven.profiles, settings.maven.profiles) : [];
  const offline = tool === "maven" ? state.maven.workOffline : settings.gradle.offline;
  try {
    const next = await call(commands.buildSync(tool, request, offline, profiles, channel));
    if (useBuild.getState().root !== root || gen !== generation) return;
    const configs = await call(commands.runConfigs()).catch(() => useBuild.getState().configs);
    useBuild.setState({ model: next, configs });
    const error = tool === "maven" ? next.maven?.syncError : next.gradle?.syncError;
    finishSyncView(error ? "failed" : "success", error);
    if (error)
      notifications().notify({
        group: "run",
        level: "warning",
        title: tool === "maven" ? "Maven sync finished with errors" : "Gradle sync failed",
        body: error,
        key: `build-sync-${tool}`,
        actions: [
          { label: "Show Build", run: () => toolWindowService().show("build", true) },
          ...downloadJdkActions(error),
        ],
      });
  } catch (e) {
    finishSyncView(
      isCancelled(e) ? "cancelled" : "failed",
      isCancelled(e) ? null : e instanceof Error ? e.message : String(e),
    );
    if (!isCancelled(e))
      notifications().notify({
        group: "run",
        level: "error",
        title: tool === "maven" ? "Cannot reload Maven projects" : "Cannot reload Gradle projects",
        body: e instanceof Error ? e.message : String(e),
        key: `build-sync-${tool}`,
      });
  } finally {
    if (useBuild.getState().syncing[tool]?.request === request) setSync(undefined);
    upsertTask({ id: taskId, title: TITLES[tool], message: null, fraction: 1, done: true });
  }
}

export function cancelSync(tool: BuildTool) {
  const s = useBuild.getState().syncing[tool];
  if (!s) return;
  const taskId = `build-sync:${tool}`;
  if (useTasks.getState().tasks.some((t) => t.id === taskId && t.cancel)) cancelTask(taskId);
  else void commands.cancelRequest(s.request);
}

const TASK_TITLES: Record<MavenTaskKind, string> = {
  updateFolders: "Generate Sources and Update Folders",
  downloadSources: "Download Sources",
  downloadDocs: "Download Documentation",
  downloadSourcesAndDocs: "Download Sources and Documentation",
};

/**
 * Generate Sources and Update Folders / Download Sources and/or Documentation, for the
 * projects `poms` (all when empty) and the selected `artifacts`, in the background with
 * its console in the Sync tab.
 */
export async function runMavenTask(
  kind: MavenTaskKind,
  poms: readonly string[] = [],
  artifacts: readonly ArtifactFilter[] = [],
): Promise<void> {
  const { root, model, settings, mavenTask } = useBuild.getState();
  if (!root || !isTauri() || mavenTask || !model?.maven) return;
  const request = nextRequestId();
  const taskId = "maven-task";
  const title = TASK_TITLES[kind];
  const cancel = () => void commands.cancelRequest(request);
  useBuild.setState({ mavenTask: { request, kind } });
  upsertTask({ id: taskId, title, message: null, fraction: null, done: false, cancel });
  startSyncView({
    tool: "maven",
    project: projectName(),
    rerun: () => void runMavenTask(kind, poms, artifacts),
    stop: cancel,
    maven: mavenPaths(),
  });
  const channel = new Channel<SyncProgress>();
  channel.onmessage = (p) => {
    if (p.output != null) syncViewOutput(p.output);
    else upsertTask({ id: taskId, title, message: p.message, fraction: p.fraction, done: false, cancel });
  };
  const profiles = profilesList(model.maven.profiles, settings.maven.profiles);
  try {
    const error = await call(commands.mavenTask(kind, [...poms], [...artifacts], profiles, request, channel));
    finishSyncView(error ? "failed" : "success", error);
    if (useBuild.getState().root === root) await loadModel();
    if (error)
      notifications().notify({
        group: "run",
        level: "warning",
        title: tx`${tx(title)} finished with errors`,
        body: error,
        key: "maven-task",
        actions: [{ label: "Show Build", run: () => toolWindowService().show("build", true) }],
      });
  } catch (e) {
    finishSyncView(isCancelled(e) ? "cancelled" : "failed", isCancelled(e) ? null : String(e));
    if (!isCancelled(e))
      notifications().notify({
        group: "run",
        level: "error",
        title: tx`${tx(title)} failed`,
        body: e instanceof Error ? e.message : String(e),
        key: "maven-task",
      });
  } finally {
    if (useBuild.getState().mavenTask?.request === request) useBuild.setState({ mavenTask: null });
    upsertTask({ id: taskId, title, message: null, fraction: 1, done: true });
  }
}

/** Show Effective POM: evaluates it with Maven and opens it in an editor. */
export async function showEffectivePom(pom: string) {
  const { model, settings } = useBuild.getState();
  if (!isTauri() || !model?.maven) return;
  const request = nextRequestId();
  const taskId = "maven-effective-pom";
  upsertTask({
    id: taskId,
    title: "Evaluating effective POM",
    message: null,
    fraction: null,
    done: false,
    cancel: () => void commands.cancelRequest(request),
  });
  try {
    const path = await call(
      commands.mavenEffectivePom(pom, profilesList(model.maven.profiles, settings.maven.profiles), request),
    );
    await editorService().openFile(path, { focus: true });
  } catch (e) {
    if (!isCancelled(e))
      notifications().notify({
        group: "run",
        level: "error",
        title: "Failed to evaluate effective pom.",
        body: e instanceof Error ? e.message : String(e),
        key: "maven-effective-pom",
      });
  } finally {
    upsertTask({ id: taskId, title: "Evaluating effective POM", message: null, fraction: 1, done: true });
  }
}

/** Whether the user `settings.xml` / `toolchains.xml` exists (Open … vs Create …). */
export const useUserFiles = create<Partial<Record<MavenUserFile, boolean>>>(() => ({}));

export async function refreshUserFiles() {
  if (!isTauri()) return;
  const exists = async (kind: MavenUserFile) => {
    try {
      return !!(await call(commands.mavenUserFile(kind, false)));
    } catch {
      return false;
    }
  };
  const [settings, toolchains] = await Promise.all([exists("settings"), exists("toolchains")]);
  useUserFiles.setState({ settings, toolchains });
}

/** Open 'settings.xml' / Create 'settings.xml' (and toolchains.xml). */
export async function openUserFile(kind: MavenUserFile) {
  if (!isTauri()) return;
  const path = await call(commands.mavenUserFile(kind, true));
  if (path) await editorService().openFile(path, { focus: true });
  void refreshUserFiles();
}

export function resetBuild() {
  generation++;
  useAnalyzer.setState({ pom: null });
  for (const tool of ["maven", "gradle"] as const) {
    cancelSync(tool);
    removeTask(`build-sync:${tool}`);
  }
  const task = useBuild.getState().mavenTask;
  if (task) void commands.cancelRequest(task.request);
  removeTask("maven-task");
  useBuild.setState({
    root: null,
    model: null,
    configs: [],
    syncing: {},
    mavenTask: null,
    error: null,
    executeOpen: null,
    current: {},
    selectedPoms: [],
    settings: DEFAULT_SETTINGS,
    maven: DEFAULT_MAVEN_SETTINGS,
    view: DEFAULT_MAVEN_VIEW,
    expanded: { maven: new Set(), gradle: new Set() },
  });
}

// ---------------------------------------------------------------------------
// Running (through the run feature's actions)

export function runConfig(config: RunConfig, mode: "run" | "debug") {
  void executeAction(mode === "debug" ? "run.debugConfig" : "run.runConfig", { config, temporary: true });
}

export async function createRunConfig(config: RunConfig) {
  await executeAction("run.createConfig", config);
  await refreshConfigs();
}

export async function refreshConfigs() {
  const configs = await call(commands.runConfigs()).catch(() => useBuild.getState().configs);
  useBuild.setState({ configs });
}

export function setExpanded(tool: BuildTool, expanded: Set<string>) {
  useBuild.setState((s) => ({ expanded: { ...s.expanded, [tool]: expanded } }));
}

export function setCurrentProject(tool: BuildTool, id: string | undefined) {
  if (useBuild.getState().current[tool] !== id) useBuild.setState((s) => ({ current: { ...s.current, [tool]: id } }));
}

// ---------------------------------------------------------------------------
// Dependency Analyzer (an editor tab)

export const ANALYZER_KIND = "maven.dependencyAnalyzer";

/** Module the Dependency Analyzer shows (`pom`, project-relative); `null` = the first one. */
export const useAnalyzer = create<{ pom: string | null; focus: { text: string; seq: number } | null }>(() => ({
  pom: null,
  focus: null,
}));

let focusSeq = 0;

/** Opens (or focuses) the Dependency Analyzer tab, showing the module `pom` (and an artifact) when given. */
export async function openAnalyzer(pom: string | null, focus: string | null = null) {
  if (pom) useAnalyzer.setState({ pom, focus: focus ? { text: focus, seq: ++focusSeq } : null });
  await editorService().openInput({ kind: ANALYZER_KIND, key: ANALYZER_KIND, data: {} }, { focus: true });
}
