/**
 * Maven and Gradle tool windows (right stripe), registered only while the open
 * project has that build system, like IDEA. The model is re-read when build
 * files change; running goals / tasks goes through the run feature's actions.
 */
import { onEditorEvent } from "@/editor/api";
import { executeAction, registerActions } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { onIdeEvent, type BuildModel, type BuildTool, type MavenProject } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import {
  registerEditorKind,
  registerMenuGroup,
  registerOverlay,
  registerRunAnythingProvider,
  registerToolWindow,
  toolWindowService,
} from "@/workbench/contributions";
import { lazyComponent, type MenuItem } from "@/ui";
import { GradleView, MavenView } from "./BuildToolView";
import { ExecutePopupHost } from "./ExecutePopup";
import { buildToolsRunAnything } from "./runAnything";
import {
  aggregatorOf,
  expandableKeys,
  gradleChildren,
  gradleRoots,
  mavenChildren,
  mavenRoots,
  type MavenViewOptions,
} from "./model";
import {
  ANALYZER_KIND,
  addProjects,
  unlinkProjects,
  unlinkable,
  cancelSync,
  loadModel,
  changedOutsideIde,
  noteBuildChange,
  noteExternalBuildChange,
  noteIdeSave,
  openAnalyzer,
  openUserFile,
  refreshUserFiles,
  resetBuild,
  resetProfiles,
  runMavenTask,
  setExpanded,
  setViewOption,
  showEffectivePom,
  syncIncrementally,
  syncTool,
  toggleGradleOffline,
  toggleMavenOffline,
  toggleSkipTests,
  useBuild,
} from "./store";

export const MAVEN_WHEN = "projectOpen && build.maven";
export const GRADLE_WHEN = "projectOpen && build.gradle";

/** Build files whose creation / change / removal re-reads the model. */
const BUILD_FILE = /(?:^|\/)(?:pom\.xml|(?:build|settings)\.gradle(?:\.kts)?|mvnw(?:\.cmd)?|gradlew(?:\.bat)?)$/;

function mavenContext() {
  const { model, configs, view, maven } = useBuild.getState();
  return model?.maven ? { model: model.maven, configs, view, tasks: maven.tasks } : null;
}

function expandAll(tool: BuildTool) {
  const { model, configs } = useBuild.getState();
  const ctx = mavenContext();
  if (tool === "maven" && ctx) {
    setExpanded(
      tool,
      expandableKeys(mavenRoots(ctx), (n) => mavenChildren(n, ctx)),
    );
  } else if (tool === "gradle" && model?.gradle) {
    const g = model.gradle;
    setExpanded(
      tool,
      expandableKeys(gradleRoots(g), (n) => gradleChildren(n, g, configs)),
    );
  }
}

function openExecute(tool: BuildTool) {
  useBuild.setState({ executeOpen: tool });
}

/** Project-relative `pom` of a Maven project from an action argument: `{ pom }`, or `{ path }` of a pom.xml. */
function analyzerPom(arg: unknown): string | null {
  const { model, root, current } = useBuild.getState();
  const projects = model?.maven?.projects ?? [];
  const a = (arg ?? {}) as { pom?: unknown; path?: unknown };
  if (typeof a.pom === "string") return a.pom;
  if (typeof a.path === "string" && root) {
    const rel = a.path.startsWith(`${root}/`) ? a.path.slice(root.length + 1) : a.path;
    if (projects.some((p) => p.pom === rel)) return rel;
  }
  return current.maven ?? null;
}

/** `poms` of an action argument (`{ poms }`), else the selected project nodes. */
function argPoms(arg: unknown): string[] {
  const a = (arg ?? {}) as { poms?: unknown };
  return Array.isArray(a.poms)
    ? a.poms.filter((p): p is string => typeof p === "string")
    : useBuild.getState().selectedPoms;
}

/** The Maven project containing `path` (absolute): the deepest module directory above it. */
function projectOf(path: string): MavenProject | undefined {
  const { model, root } = useBuild.getState();
  if (!root || !path.startsWith(`${root}/`)) return undefined;
  const rel = path.slice(root.length + 1);
  return (model?.maven?.projects ?? [])
    .filter((p) => p.dir === "" || rel === p.dir || rel.startsWith(`${p.dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
}

/** Select in Maven: shows the tool window with the project node of `pom` selected. */
function selectInMaven(pom: string) {
  const { model, expanded } = useBuild.getState();
  const projects = model?.maven?.projects ?? [];
  const keys = new Set(expanded.maven);
  for (let p = projects.find((x) => x.pom === pom); p;) {
    const agg = model?.maven ? aggregatorOf(model.maven, p) : undefined;
    if (agg) keys.add(`mvn:${agg.pom}`);
    p = agg;
  }
  setExpanded("maven", keys);
  useBuild.setState((s) => ({ reveal: { key: `mvn:${pom}`, seq: (s.reveal?.seq ?? 0) + 1 } }));
  toolWindowService().show("maven", true);
}

const synced = new Set<string>();

/** Registers / unregisters the tool windows to match the model; first sync of a never-synced build. */
function apply(model: BuildModel | null, registered: Partial<Record<BuildTool, () => void>>) {
  const has: Record<BuildTool, boolean> = { maven: !!model?.maven, gradle: !!model?.gradle };
  setContext("build.maven", has.maven);
  setContext("build.gradle", has.gradle);
  for (const tool of ["maven", "gradle"] as const) {
    if (has[tool] && !registered[tool]) {
      registered[tool] =
        tool === "maven"
          ? registerToolWindow({
              id: "maven",
              title: "Maven",
              icon: "toolwindow-maven",
              // Right Top with the other trees looked up now and then (Database).
              anchor: "right",
              order: 30,
              component: MavenView,
              headerMenu: useMavenViewMenu,
              headerMenuInTitle: false,
            })
          : registerToolWindow({
              id: "gradle",
              title: "Gradle",
              icon: "toolwindow-gradle",
              // Right Top with the other trees looked up now and then (Database).
              anchor: "right",
              order: 31,
              component: GradleView,
            });
    } else if (!has[tool] && registered[tool]) {
      registered[tool]!();
      delete registered[tool];
    }
  }
  // IDEA imports a build when the project is first opened.
  const root = useBuild.getState().root;
  for (const tool of ["maven", "gradle"] as const) {
    const info = tool === "maven" ? model?.maven : model?.gradle;
    const key = `${tool}:${root}`;
    if (info && (tool !== "maven" || model?.maven?.projects.length) && info.syncedAt == null && !synced.has(key)) {
      synced.add(key);
      void syncTool(tool);
    }
  }
}

/** The tool window's options menu (IDEA's gear: Group Modules, Show Ignored Projects, …). */
function useMavenViewMenu(): MenuItem[] {
  const view = useBuild((s) => s.view);
  const item = (key: keyof MavenViewOptions, label: string): MenuItem => ({
    label,
    checked: view[key],
    run: () => setViewOption(key, !view[key]),
  });
  return [
    item("groupModules", "Group Modules"),
    item("showIgnored", "Show Ignored Projects"),
    item("basicPhasesOnly", "Show Basic Phases Only"),
    item("alwaysShowArtifactId", "Always Show ArtifactId"),
    item("showVersions", "Maven tool window: Show project version next to name"),
  ];
}

export function activate(): () => void {
  const registered: Partial<Record<BuildTool, () => void>> = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleLoad = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void loadModel(), 300);
  };
  const maven = (id: string, title: string, run: (arg: unknown) => unknown, extra: Record<string, unknown> = {}) => ({
    id,
    title,
    category: "Maven",
    when: MAVEN_WHEN,
    run: ({ arg }: { arg?: unknown }) => void run(arg),
    ...extra,
  });
  const disposers: Array<() => void> = [
    registerOverlay({ id: "build-tools.execute", component: ExecutePopupHost }),
    registerRunAnythingProvider(buildToolsRunAnything),
    registerEditorKind({
      kind: ANALYZER_KIND,
      component: lazyComponent(() => import("./DependencyAnalyzer").then((m) => m.DependencyAnalyzer)),
      title: () => "Dependency Analyzer",
      icon: () => "build-dependencies",
      restorable: true,
    }),
    // pom.xml in the editor, its tab and the project view: Analyze Dependencies of that module.
    registerMenuGroup({
      id: "maven.analyzeDependencies",
      menus: ["editor", "editorTab", "projectView"],
      order: 30,
      items: (_menu, { paths, dirs }) => {
        const path = paths.length === 1 && !dirs?.[0] ? paths[0]! : null;
        if (!path || !path.endsWith("/pom.xml")) return [];
        const { model, root } = useBuild.getState();
        const pom = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
        if (!pom || !model?.maven?.projects.some((p) => p.pom === pom)) return [];
        return [{ kind: "action", action: "maven.analyzeDependencies", arg: { pom }, label: "Analyze Dependencies…" }];
      },
    }),
    // Select In (⌥F1) › Maven: the project node of the file's module.
    registerMenuGroup({
      id: "maven.selectIn",
      menus: ["selectIn"],
      order: 20,
      items: (_menu, { paths }) => {
        const project = paths[0] ? projectOf(paths[0]) : undefined;
        if (!project) return [];
        return [{ label: "Maven", icon: "toolwindow-maven", run: () => selectInMaven(project.pom) }];
      },
    }),
    useBuild.subscribe((s, prev) => {
      if (s.model !== prev.model || s.root !== prev.root) apply(s.root ? s.model : null, registered);
    }),
    useProject.subscribe((s, prev) => {
      if (s.project?.root === prev.project?.root && s.project?.trusted === prev.project?.trusted) return;
      resetBuild();
      if (s.project) {
        void loadModel();
        void refreshUserFiles();
      }
    }),
    onEditorEvent((e) => {
      if (e.type === "docSaved" && BUILD_FILE.test(e.path)) noteIdeSave(e.path);
    }),
    onIdeEvent("fsChanged", (e) => {
      const changed = [...e.created, ...e.modified, ...e.removed].filter((p) => BUILD_FILE.test(p));
      if (!changed.length) return;
      // Changes the IDE's own saves didn't make came from outside (a VCS update, another tool),
      // also for a build file open in a tab.
      if (changedOutsideIde(changed)) noteExternalBuildChange();
      noteBuildChange();
      scheduleLoad();
    }),
    onIdeEvent("projectRootsChanged", scheduleLoad),
    // Project JDK / Maven home and options are applied to the model's launchers.
    onIdeEvent("settingsChanged", (e) => {
      if (e.key === "languages" || e.key.startsWith("languages.java") || e.key.startsWith("buildTools")) scheduleLoad();
    }),
    registerActions([
      maven("maven.syncAll", "Sync All Maven Projects", () => syncIncrementally(), {
        icon: "refresh",
        description: "Syncs the Maven projects whose build files changed since the last sync",
        keywords: ["maven", "sync", "import", "refresh"],
      }),
      maven(
        "maven.reload",
        "Reload All Maven Projects",
        () => {
          // The Sync split button shows (and runs) the last one chosen.
          useBuild.setState({ syncAction: "maven.reload" });
          return syncTool("maven");
        },
        {
          icon: "force-refresh",
          description: "Re-reads the effective POMs and dependency trees of every Maven project",
          keywords: ["maven", "sync", "reimport", "refresh", "reload"],
        },
      ),
      maven("maven.cancelReload", "Stop Reloading Maven Projects", () => cancelSync("maven"), {
        icon: "stop",
        hidden: true,
      }),
      maven(
        "maven.updateFolders",
        "Generate Sources and Update Folders For All Projects",
        () => runMavenTask("updateFolders"),
        {
          icon: "maven-update-folders",
          keywords: ["maven", "generate sources", "update folders", "generated-sources"],
        },
      ),
      maven(
        "maven.updateFoldersForProject",
        "Generate Sources and Update Folders",
        (arg) => runMavenTask("updateFolders", argPoms(arg)),
        {
          icon: "maven-update-folders",
          hidden: true,
        },
      ),
      maven(
        "maven.downloadSources",
        "Download Sources",
        (arg) => runMavenTask("downloadSources", [], artifactsOf(arg)),
        {
          icon: "download",
          description: "Download sources for all dependencies",
          keywords: ["maven", "sources", "download"],
        },
      ),
      maven(
        "maven.downloadDocs",
        "Download Documentation",
        (arg) => runMavenTask("downloadDocs", [], artifactsOf(arg)),
        {
          icon: "download",
          description: "Download documentation for all dependencies",
          keywords: ["maven", "javadoc", "documentation", "download"],
        },
      ),
      maven(
        "maven.downloadSourcesAndDocs",
        "Download Sources and Documentation",
        (arg) => runMavenTask("downloadSourcesAndDocs", [], artifactsOf(arg)),
        {
          icon: "download",
          description: "Download sources and documentation for all dependencies",
          keywords: ["maven", "sources", "javadoc", "download"],
        },
      ),
      {
        id: "maven.addProjects",
        title: "Add Maven Projects",
        description: "Add and reload Maven projects to the projects tree",
        category: "Maven",
        icon: "plus",
        when: "projectOpen",
        run: () => addProjects(),
      },
      maven(
        "maven.unlinkProjects",
        "Unlink Maven Projects",
        (arg) => {
          const poms = unlinkable(
            arg ? [analyzerPom(arg)].filter((p): p is string => !!p) : useBuild.getState().selectedPoms,
          );
          return poms[0] ? unlinkProjects(poms[0]) : undefined;
        },
        {
          icon: "minus",
          description: "Unlink selected Maven projects and their subprojects from the project tree",
        },
      ),
      maven("maven.executeGoal", "Execute Maven Goal…", () => openExecute("maven"), {
        icon: "run-anything",
        keywords: ["maven", "mvn", "goal", "run anything"],
      }),
      maven(
        "maven.analyzeDependencies",
        "Analyze Dependencies…",
        (arg) => {
          const a = (arg ?? {}) as { focus?: unknown };
          return openAnalyzer(analyzerPom(arg), typeof a.focus === "string" ? a.focus : null);
        },
        {
          icon: "build-dependencies",
          description: "Shows a Maven module's dependency tree, version conflicts and where each library comes from",
          keywords: ["maven", "dependency", "dependencies", "conflict", "tree", "exclude", "analyzer"],
        },
      ),
      maven("maven.toggleOffline", "Toggle Offline Mode", () => toggleMavenOffline(), {
        icon: "build-offline",
        description: "Toggle offline mode for Maven builds",
        keywords: ["maven", "offline"],
        toggled: () => useBuild.getState().maven.workOffline,
      }),
      maven("maven.toggleSkipTests", "Toggle 'Skip Tests' Mode", () => toggleSkipTests(), {
        icon: "skip-tests",
        description: "Toggle 'Skip tests' mode for Maven builds",
        keywords: ["maven", "skip tests"],
        toggled: () => useBuild.getState().maven.skipTests,
      }),
      maven("maven.expandAll", "Expand All", () => expandAll("maven"), { icon: "expand-all", hidden: true }),
      maven("maven.collapseAll", "Collapse All", () => setExpanded("maven", new Set()), {
        icon: "collapse-all",
        hidden: true,
      }),
      maven("maven.settings", "Maven Settings", () => executeAction("file.settings", "build.tools.maven"), {
        icon: "settings",
        description: "Edit Maven integration settings for the current project",
        keywords: ["maven home", "mvn", "settings", "preferences"],
      }),
      maven("maven.autoSyncSettings", "Auto-Sync Settings…", () => executeAction("file.settings", "build.tools"), {
        description: "Edit build tools settings for the current project",
        hidden: true,
      }),
      maven(
        "maven.showEffectivePom",
        "Show Effective POM",
        (arg) => {
          const pom = analyzerPom(arg);
          return pom ? showEffectivePom(pom) : undefined;
        },
        { hidden: true },
      ),
      maven("maven.openSettingsXml", "Open settings.xml", () => openUserFile("settings"), { hidden: true }),
      maven("maven.openToolchainsXml", "Open toolchains.xml", () => openUserFile("toolchains"), { hidden: true }),
      maven("maven.resetProfiles", "Reset Profiles", () => resetProfiles(), {
        hidden: true,
      }),
      {
        id: "gradle.reload",
        title: "Reload All Gradle Projects",
        description: "Re-reads the task list with Gradle",
        category: "Gradle",
        icon: "refresh",
        when: GRADLE_WHEN,
        keywords: ["gradle", "sync", "refresh"],
        run: () => syncTool("gradle"),
      },
      {
        id: "gradle.cancelReload",
        title: "Stop Reloading Gradle Projects",
        category: "Gradle",
        icon: "stop",
        hidden: true,
        when: GRADLE_WHEN,
        run: () => cancelSync("gradle"),
      },
      {
        id: "gradle.executeTask",
        title: "Execute Gradle Task…",
        category: "Gradle",
        icon: "run-anything",
        when: GRADLE_WHEN,
        keywords: ["gradle", "task", "run anything"],
        run: () => openExecute("gradle"),
      },
      {
        id: "gradle.toggleOffline",
        title: "Toggle Offline Mode",
        description: "Runs Gradle with --offline",
        category: "Gradle",
        icon: "build-offline",
        when: GRADLE_WHEN,
        keywords: ["gradle", "offline"],
        toggled: () => useBuild.getState().settings.gradle.offline,
        run: () => toggleGradleOffline(),
      },
      {
        id: "gradle.expandAll",
        title: "Expand All",
        category: "Gradle",
        icon: "expand-all",
        hidden: true,
        when: GRADLE_WHEN,
        run: () => expandAll("gradle"),
      },
      {
        id: "gradle.collapseAll",
        title: "Collapse All",
        category: "Gradle",
        icon: "collapse-all",
        hidden: true,
        when: GRADLE_WHEN,
        run: () => setExpanded("gradle", new Set()),
      },
    ]),
  ];
  if (useProject.getState().project) {
    void loadModel();
    void refreshUserFiles();
  }
  return () => {
    clearTimeout(timer);
    disposers.reverse().forEach((d) => d());
    for (const d of Object.values(registered)) d?.();
    setContext("build.maven", false);
    setContext("build.gradle", false);
    resetBuild();
  };
}

/** Selected artifacts of an action argument (`{ artifacts }`; Download for the selected dependencies). */
function artifactsOf(arg: unknown): Array<{ groupId: string; artifactId: string }> {
  const a = (arg ?? {}) as { artifacts?: unknown };
  return Array.isArray(a.artifacts)
    ? a.artifacts.filter(
        (x): x is { groupId: string; artifactId: string } =>
          !!x && typeof x === "object" && typeof (x as { groupId?: unknown }).groupId === "string",
      )
    : [];
}
