/**
 * The Maven and Gradle tool windows. Maven follows IDEA's `MavenProjectsNavigator`:
 * the toolbar (Sync split button, Generate Sources, Download ▾, Add / Unlink, Run,
 * Execute Goal, Offline, Skip Tests, Analyze Dependencies, Expand / Collapse, Settings ▾),
 * the project tree with its per-node context menus, double-click / Enter / F4.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { executeAction } from "@/platform/actions";
import {
  call,
  commands,
  type BuildTool,
  type GradleModel,
  type MavenModel,
  type MavenProject,
  type RunConfig,
} from "@/platform/ipc";
import { downloadJdkActions } from "@/platform/jdk";
import { tx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { editorService } from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";
import {
  Button,
  Checkbox,
  Icon,
  IconButton,
  Spinner,
  Tree,
  showContextMenu,
  type MenuItem,
  type TreeHandle,
  T,
} from "@/ui";
import { deleteConfig } from "@/features/run/store";
import {
  gradleChildren,
  gradleRoots,
  gradleTaskConfig,
  isRunnable,
  mavenChildren,
  mavenGoalConfig,
  mavenNodeError,
  mavenRoots,
  nextProfileChoice,
  nodeIcon,
  nodeLabel,
  profileState,
  sortGoals,
  toggleProfileText,
  withGradleOptions,
  type BuildNode,
  type MavenTreeContext,
} from "./model";
import {
  createRunConfig,
  ignoredByPattern,
  initialExpanded,
  mavenRunOptions,
  refreshConfigs,
  runConfig,
  setCurrentProject,
  setExpanded,
  setIgnored,
  setProfile,
  syncTool,
  taskActive,
  toggleTask,
  unlinkable,
  useBuild,
  useUserFiles,
  type TaskPhase,
} from "./store";
import styles from "./BuildTools.module.css";

export function MavenView() {
  return <BuildToolView tool="maven" />;
}

export function GradleView() {
  return <BuildToolView tool="gradle" />;
}

/** The run configuration a runnable node (or several of one project) starts. */
export function nodeConfig(
  nodes: readonly BuildNode[],
  model: { maven?: MavenModel | null; gradle?: GradleModel | null },
) {
  const settings = useBuild.getState().settings;
  const first = nodes[0];
  if (!first) return null;
  if (first.kind === "runConfig")
    return first.config.kind === "gradle" ? withGradleOptions(first.config, settings.gradle) : first.config;
  if ((first.kind === "phase" || first.kind === "goal") && model.maven) {
    const same = nodes.filter(
      (n): n is Extract<BuildNode, { kind: "phase" | "goal" }> =>
        (n.kind === "phase" || n.kind === "goal") && n.project.pom === first.project.pom,
    );
    // IDEA runs the selected goals of one project together, phases in lifecycle order.
    const goals = sortGoals(same.map((n) => (n.kind === "phase" ? n.phase : `${n.plugin.prefix}:${n.goal}`)));
    return mavenGoalConfig(first.project, goals, model.maven, mavenRunOptions());
  }
  if (first.kind === "task" && model.gradle) {
    const same = nodes.filter(
      (n): n is Extract<BuildNode, { kind: "task" }> => n.kind === "task" && n.project.path === first.project.path,
    );
    return gradleTaskConfig(
      model.gradle,
      first.project,
      same.map((n) => n.task.name),
      settings.gradle,
    );
  }
  return null;
}

/** Selected goal nodes of one project (IDEA's `MAVEN_GOALS`: null when they span projects). */
function selectedGoals(selection: readonly BuildNode[]) {
  const goals = selection.filter(
    (n): n is Extract<BuildNode, { kind: "phase" | "goal" }> => n.kind === "phase" || n.kind === "goal",
  );
  if (!goals.length || goals.length !== selection.length) return null;
  return goals.every((g) => g.project.pom === goals[0]!.project.pom) ? goals : null;
}

/** Memoised children lookup (node objects stay stable while the model is unchanged). */
function childrenOf(
  tool: BuildTool,
  ctx: MavenTreeContext | null,
  gradle: GradleModel | null,
  configs: readonly RunConfig[],
) {
  const cache = new Map<string, BuildNode[] | undefined>();
  return (n: BuildNode) => {
    if (cache.has(n.key)) return cache.get(n.key);
    const kids =
      tool === "maven"
        ? ctx
          ? mavenChildren(n, ctx)
          : undefined
        : gradle
          ? gradleChildren(n, gradle, configs)
          : undefined;
    cache.set(n.key, kids);
    return kids;
  };
}

/** Maven `pom` / Gradle project path of the project a node belongs to. */
function nodeProject(n: BuildNode): string | undefined {
  if ("project" in n) return "pom" in n.project ? n.project.pom : n.project.path;
  return undefined;
}

function menuAt(e: MouseEvent<HTMLElement>, items: MenuItem[]) {
  const r = e.currentTarget.getBoundingClientRect();
  showContextMenu({ x: r.left, y: r.bottom + 2 }, items);
}

// ---------------------------------------------------------------------------
// Toolbar

type ToolbarEntry = { kind: "sep" } | { kind: "item"; key: string; node: ReactNode; menu: MenuItem };

/**
 * A toolbar that hides what does not fit behind a » button (IDEA's `ActionToolbar`
 * overflow), so a narrow tool window keeps every action reachable.
 */
function OverflowToolbar({ entries, label }: { entries: ToolbarEntry[]; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(entries.length);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // Widths in flow: the toolbar's 6px padding each side, 2px gaps, 4px margins around separators.
      const width = el.clientWidth - 12;
      if (width <= 0) return;
      const sizes = [...el.querySelectorAll<HTMLElement>("[data-entry]")].map(
        (k) => k.offsetWidth + 2 + (k.dataset.entry === "sep" ? 8 : 0),
      );
      if (sizes.reduce((a, b) => a + b, 0) <= width) {
        setFit(sizes.length);
        return;
      }
      // Room for the » button.
      let x = 0;
      let n = 0;
      for (const size of sizes) {
        if (x + size > width - 26) break;
        x += size;
        n++;
      }
      setFit(n);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [entries.length]);
  const hidden = entries.slice(fit);
  const menu: MenuItem[] = [];
  for (const e of hidden) {
    if (e.kind === "sep") {
      if (menu.length && menu.at(-1)!.kind !== "separator") menu.push({ kind: "separator" });
    } else menu.push(e.menu);
  }
  return (
    <div ref={ref} className={styles.toolbar} role="toolbar" aria-label={tx(label)}>
      {entries.map((e, i) =>
        e.kind === "sep" ? (
          <span key={`sep${i}`} data-entry="sep" className={clsx(styles.sep, i >= fit && styles.overflowed)} />
        ) : (
          <span key={e.key} data-entry="item" className={clsx(styles.entry, i >= fit && styles.overflowed)}>
            {e.node}
          </span>
        ),
      )}
      {hidden.some((e) => e.kind === "item") && (
        <IconButton
          icon="chevron-right"
          size="small"
          iconSize={14}
          className={styles.more}
          title="Show More"
          onClick={(ev) => menuAt(ev, menu)}
        />
      )}
    </div>
  );
}

function MavenToolbar({ selection, onRun }: { selection: BuildNode[]; onRun: () => void }) {
  const maven = useBuild((s) => s.maven);
  const task = useBuild((s) => s.mavenTask);
  const syncAction = useBuild((s) => s.syncAction);
  const selectedPoms = useBuild((s) => s.selectedPoms);
  const goals = selectedGoals(selection);
  const syncMenu: MenuItem[] = [
    { kind: "action", action: "maven.syncAll" },
    { kind: "action", action: "maven.reload" },
  ];
  const downloadMenu: MenuItem[] = [
    { kind: "action", action: "maven.downloadSources", disabled: !!task },
    { kind: "action", action: "maven.downloadDocs", disabled: !!task },
    { kind: "action", action: "maven.downloadSourcesAndDocs", disabled: !!task },
  ];
  const settingsMenu: MenuItem[] = [
    { kind: "action", action: "maven.autoSyncSettings", label: "Auto-Sync Settings…" },
    { kind: "action", action: "maven.settings" },
  ];
  const action = (key: string, icon: string, extra: { pressed?: boolean; disabled?: boolean } = {}): ToolbarEntry => ({
    kind: "item",
    key,
    node: <IconButton icon={icon} size="small" iconSize={16} action={key} {...extra} />,
    menu: { kind: "action", action: key, disabled: extra.disabled },
  });
  const entries: ToolbarEntry[] = [
    {
      kind: "item",
      key: "sync",
      node: (
        <span className={styles.split}>
          <IconButton
            icon={syncAction === "maven.reload" ? "force-refresh" : "refresh"}
            size="small"
            iconSize={16}
            action={syncAction}
          />
          <IconButton
            icon="chevron-down"
            size="small"
            iconSize={10}
            className={styles.splitArrow}
            title="Sync Options"
            onClick={(e) => menuAt(e, syncMenu)}
          />
        </span>
      ),
      menu: { label: "Sync All Maven Projects", icon: "refresh", submenu: syncMenu },
    },
    action("maven.updateFolders", "maven-update-folders", { disabled: !!task }),
    {
      kind: "item",
      key: "download",
      node: (
        <IconButton
          icon="download"
          size="small"
          iconSize={16}
          title="Download Sources and/or Documentation"
          disabled={!!task}
          className={styles.popupButton}
          onClick={(e) => menuAt(e, downloadMenu)}
        />
      ),
      menu: { label: "Download Sources and/or Documentation", icon: "download", submenu: downloadMenu },
    },
    { kind: "sep" },
    action("maven.addProjects", "plus"),
    action("maven.unlinkProjects", "minus", { disabled: !unlinkable(selectedPoms).length }),
    { kind: "sep" },
    {
      kind: "item",
      key: "run",
      node: (
        <IconButton icon="run" size="small" iconSize={16} title="Run Maven Build" disabled={!goals} onClick={onRun} />
      ),
      menu: { label: "Run Maven Build", icon: "run", disabled: !goals, run: onRun },
    },
    action("maven.executeGoal", "run-anything"),
    action("maven.toggleOffline", "build-offline", { pressed: maven.workOffline }),
    action("maven.toggleSkipTests", "skip-tests", { pressed: maven.skipTests }),
    { kind: "sep" },
    action("maven.analyzeDependencies", "build-dependencies"),
    { kind: "sep" },
    action("maven.expandAll", "expand-all"),
    action("maven.collapseAll", "collapse-all"),
    { kind: "sep" },
    {
      kind: "item",
      key: "settings",
      node: (
        <IconButton
          icon="settings"
          size="small"
          iconSize={16}
          title="Build Tools Settings"
          className={styles.popupButton}
          onClick={(e) => menuAt(e, settingsMenu)}
        />
      ),
      menu: { label: "Build Tools Settings", icon: "settings", submenu: settingsMenu },
    },
  ];
  return <OverflowToolbar entries={entries} label="Maven actions" />;
}

function GradleToolbar({ selection }: { selection: BuildNode[] }) {
  const syncing = useBuild((s) => !!s.syncing.gradle);
  const settings = useBuild((s) => s.settings);
  const model = useBuild((s) => s.model);
  const runnable = selection.filter(isRunnable);
  const runSelected = () => {
    const config = model && nodeConfig(runnable, model);
    if (config) runConfig(config, "run");
  };
  return (
    <div className={styles.toolbar} role="toolbar" aria-label={tx("Gradle actions")}>
      {syncing ? (
        <IconButton icon="stop" size="small" iconSize={16} action="gradle.cancelReload" />
      ) : (
        <IconButton icon="refresh" size="small" iconSize={16} action="gradle.reload" />
      )}
      <span className={styles.sep} />
      <IconButton
        icon="run"
        size="small"
        iconSize={16}
        title="Run Gradle Task"
        disabled={!runnable.length}
        onClick={runSelected}
      />
      <IconButton icon="run-anything" size="small" iconSize={16} action="gradle.executeTask" />
      <IconButton
        icon="build-offline"
        size="small"
        iconSize={16}
        action="gradle.toggleOffline"
        pressed={settings.gradle.offline}
      />
      <span className={styles.sep} />
      <IconButton icon="expand-all" size="small" iconSize={16} action="gradle.expandAll" />
      <IconButton icon="collapse-all" size="small" iconSize={16} action="gradle.collapseAll" />
    </div>
  );
}

function Banner({ tool }: { tool: BuildTool }) {
  const sync = useBuild((s) => s.syncing[tool]);
  const info = useBuild((s) => (tool === "maven" ? s.model?.maven : s.model?.gradle));
  // IDEA's navigator shows no sync progress for Maven (the Build window's Sync tab and the status bar do).
  if (sync && tool === "gradle")
    return (
      <div className={styles.banner} role="status">
        <Spinner size={12} />
        <span className={styles.bannerText}>{sync.message}</span>
        {sync.fraction != null && <span className={styles.bannerPct}>{Math.round(sync.fraction * 100)}%</span>}
      </div>
    );
  if (!info || sync) return null;
  if (info.stale)
    return (
      <div className={styles.banner}>
        <Icon name={tool === "maven" ? "maven-load-changes" : "gradle-load-changes"} size={16} />
        <span className={styles.bannerText}>
          <T>Build files changed since the last sync</T>
        </span>
        <Button size="small" variant="ghost" onClick={() => void syncTool(tool)}>
          {tool === "maven" ? "Sync Maven Changes" : "Load Gradle Changes"}
        </Button>
      </div>
    );
  if (info.syncError) {
    const [jdkFix] = downloadJdkActions(info.syncError);
    return (
      <div className={clsx(styles.banner, styles.bannerWarning)} title={info.syncError}>
        <Icon name="warning" size={16} />
        <span className={styles.bannerText}>{info.syncError.split("\n")[0]}</span>
        {jdkFix && (
          <Button size="small" variant="ghost" onClick={jdkFix.run}>
            {jdkFix.label}
          </Button>
        )}
      </div>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rows

/** Tooltip of a project node (IDEA's `ProjectNode.getTooltip`). */
function projectTooltip(p: MavenProject): string {
  const lines = [`${tx("Project:")} ${p.groupId}:${p.artifactId}:${p.version}`, `${tx("Location:")} ${p.pom}`];
  const problems = p.problems ?? [];
  if (problems.length) lines.push(`${tx("Problems:")}`, ...problems.map((x) => `  ${x}`));
  return lines.join("\n");
}

function NodeRow({ node, selected }: { node: BuildNode; selected: boolean }) {
  const choices = useBuild((s) => s.settings.maven.profiles);
  const view = useBuild((s) => s.view);
  const skipTests = useBuild((s) => s.maven.skipTests);
  if (node.kind === "profile") {
    const state = profileState(node.profile, choices);
    return (
      <span className={styles.row} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={state !== "none"}
          onChange={() => setProfile(node.profile.id, nextProfileChoice(node.profile, choices))}
          // A profile id is shown as written, never looked up as UI text.
          label={<span>{node.profile.id}</span>}
          className={clsx(styles.profile, state === "implicit" && styles.implicit)}
        />
      </span>
    );
  }
  const label = nodeLabel(node);
  const project = node.kind === "mavenProject" ? node.project : null;
  const error = mavenNodeError(node);
  const greyed =
    (project?.ignored ?? false) ||
    (node.kind === "dependency" && (node.dependency.omitted === "conflict" || node.dependency.omitted === "duplicate"));
  const defaultGoal = node.kind === "phase" && !!node.project.defaultGoal?.split(/\s+/).includes(node.phase);
  const skipped = node.kind === "phase" && node.phase === "test" && skipTests;
  const hint = node.hint ?? (node.kind === "task" ? node.task.description : null);
  return (
    <span
      className={styles.row}
      title={
        project ? projectTooltip(project) : node.kind === "task" ? (node.task.description ?? undefined) : undefined
      }
    >
      {node.kind === "runConfig" && node.config.kind === "maven" ? (
        <Icon name="file-maven" size={16} className={styles.icon} />
      ) : (
        <Icon name={nodeIcon(node)} size={16} className={styles.icon} />
      )}
      <span
        className={clsx(
          styles.label,
          selected && styles.selectedLabel,
          greyed && styles.greyed,
          error && styles.error,
          defaultGoal && styles.bold,
          skipped && styles.skipped,
        )}
      >
        {label}
      </span>
      {project && view.showVersions && project.version && <span className={styles.detail}>:{project.version}</span>}
      {hint && <span className={styles.detail}>({hint})</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Context menus

const TASKS: Array<[TaskPhase, string]> = [
  ["beforeBuild", "Execute Before Build"],
  ["afterBuild", "Execute After Build"],
  ["beforeRebuild", "Execute Before Rebuild"],
  ["afterRebuild", "Execute After Rebuild"],
];

function goalName(n: Extract<BuildNode, { kind: "phase" | "goal" }>) {
  return n.kind === "phase" ? n.phase : `${n.plugin.prefix}:${n.goal}`;
}

/** Jump to Source of a node (IDEA's `getNavigatable`), or null when it has none. */
function navigatable(node: BuildNode, root: string): (() => void) | null {
  switch (node.kind) {
    case "mavenProject":
      return () => void openPomAt(`${root}/${node.project.pom}`, (text) => artifactIdOffset(text));
    case "dependency": {
      const d = node.dependency;
      const pom = node.project.pom;
      return () =>
        void call(commands.mavenDependencyDeclaration(pom, { groupId: d.groupId, artifactId: d.artifactId }))
          .then((loc) => editorService().openFile(loc.path, { selection: loc.range.start, focus: true }))
          .catch(() => openPomAt(`${root}/${pom}`, () => null));
    }
    case "profile": {
      const projects = useBuild.getState().model?.maven?.projects ?? [];
      const owner = projects.find((p) => p.profiles.includes(node.profile.id));
      if (!owner) return null;
      const id = node.profile.id;
      return () => void openPomAt(`${root}/${owner.pom}`, (text) => profileOffset(text, id));
    }
    case "runConfig":
      return () => void executeAction("run.editConfigs", node.config.id);
    default:
      return null;
  }
}

/** Offset of the project's own `<artifactId>` (after `<parent>`). */
function artifactIdOffset(text: string): number | null {
  const withoutParent = text.replace(/<parent>[\s\S]*?<\/parent>/, (m) => " ".repeat(m.length));
  const i = withoutParent.indexOf("<artifactId>");
  return i < 0 ? null : i + "<artifactId>".length;
}

function profileOffset(text: string, id: string): number | null {
  const re = new RegExp(
    `<profile>\\s*(?:<!--[\\s\\S]*?-->\\s*)*<id>\\s*${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*</id>`,
  );
  const m = re.exec(text);
  return m ? m.index + m[0].indexOf(id) : null;
}

async function openPomAt(path: string, find: (text: string) => number | null) {
  let selection: { line: number; col: number } | undefined;
  try {
    const text = await call(commands.fsReadText(path));
    const offset = find(text);
    if (offset != null) {
      const before = text.slice(0, offset).split("\n");
      selection = { line: before.length - 1, col: before[before.length - 1]!.length };
    }
  } catch {
    /* open without a position */
  }
  await editorService().openFile(path, { selection, focus: true });
}

function projectMenu(nodes: Array<Extract<BuildNode, { kind: "mavenProject" }>>, root: string): MenuItem[] {
  const poms = nodes.map((n) => n.project.pom);
  const projects = nodes.map((n) => n.project);
  const files = useUserFiles.getState();
  const items: MenuItem[] = [];
  if (!projects.some((p) => p.ignored))
    items.push({ label: "Sync Project", icon: "refresh", run: () => void syncTool("maven") });
  items.push(
    {
      kind: "action",
      action: "maven.updateFoldersForProject",
      arg: { poms },
      label: "Generate Sources and Update Folders",
    },
    { kind: "separator" },
  );
  // Ignore / Unignore Projects / Edit Ignored Files… (IDEA's `ToggleIgnoredProjectsAction`).
  const byPattern = projects.some((p) => p.ignored && ignoredByPattern(p.pom));
  const ignored = projects.filter((p) => p.ignored).length;
  if (byPattern)
    items.push({
      label: "Edit Ignored Files…",
      run: () => void executeAction("file.settings", "build.tools.maven.ignored"),
    });
  else
    items.push({
      label: ignored ? "Unignore Projects" : "Ignore Projects",
      disabled: ignored > 0 && ignored < projects.length,
      run: () => void setIgnored(poms, !ignored),
    });
  const canUnlink = poms.length > 0 && unlinkable(poms).length === poms.length;
  items.push({ kind: "action", action: "maven.unlinkProjects", arg: { pom: poms[0] }, disabled: !canUnlink });
  items.push(
    { kind: "separator" },
    {
      kind: "action",
      action: "maven.openSettingsXml",
      label: files.settings ? "Open 'settings.xml'" : "Create 'settings.xml'",
    },
    {
      kind: "action",
      action: "maven.openToolchainsXml",
      label: files.toolchains ? "Open 'toolchains.xml'" : "Create 'toolchains.xml'",
    },
    { kind: "separator" },
    { kind: "action", action: "maven.downloadSources" },
    { kind: "action", action: "maven.downloadDocs" },
    { kind: "action", action: "maven.downloadSourcesAndDocs" },
    { kind: "separator" },
    {
      kind: "action",
      action: "maven.showEffectivePom",
      arg: { pom: poms[0] },
      label: "Show Effective POM",
      disabled: poms.length !== 1,
    },
    { kind: "separator" },
    { kind: "action", action: "maven.analyzeDependencies", arg: { pom: poms[0] } },
    { kind: "separator" },
  );
  // Run Maven Build runs the project's <defaultGoal>.
  const project = projects[0]!;
  const model = useBuild.getState().model;
  const goals = project.defaultGoal?.split(/\s+/).filter(Boolean) ?? [];
  const config = goals.length && model?.maven ? mavenGoalConfig(project, goals, model.maven, mavenRunOptions()) : null;
  items.push({
    label: "Run Maven Build",
    icon: "run",
    disabled: !config || projects.length !== 1,
    run: () => config && runConfig(config, "run"),
  });
  if (config)
    items.push(
      { label: tx`Run '${config.name}'`, icon: "run", run: () => runConfig(config, "run") },
      { label: tx`Debug '${config.name}'`, icon: "debug", run: () => runConfig(config, "debug") },
    );
  items.push(
    { kind: "separator" },
    {
      label: "Jump to Source",
      icon: "edit-source",
      shortcut: "F4",
      disabled: projects.length !== 1,
      run: () => navigatable(nodes[0]!, root)?.(),
    },
  );
  return items;
}

function goalMenu(goals: Array<Extract<BuildNode, { kind: "phase" | "goal" }>>, model: MavenModel): MenuItem[] {
  const project = goals[0]!.project;
  const names = sortGoals(goals.map(goalName));
  const config = mavenGoalConfig(project, names, model, mavenRunOptions());
  const items: MenuItem[] = [
    { label: "Run Maven Build", icon: "run", run: () => runConfig(config, "run") },
    { label: tx`Run '${config.name}'`, icon: "run", run: () => runConfig(config, "run") },
    { label: tx`Debug '${config.name}'`, icon: "debug", run: () => runConfig(config, "debug") },
    { label: "Modify Run Configuration…", icon: "edit", run: () => void createRunConfig(config) },
    { kind: "separator" },
  ];
  for (const [phase, label] of TASKS) {
    const on = names.every((g) => taskActive(phase, project.pom, g));
    items.push({ label, checked: on, run: () => void toggleTask(phase, project.pom, names, !on) });
  }
  return items;
}

function dependencyMenu(nodes: BuildNode[]): MenuItem[] {
  const artifacts = nodes.flatMap((n) => {
    if (n.kind === "dependency") return [{ groupId: n.dependency.groupId, artifactId: n.dependency.artifactId }];
    if (n.kind === "dependencies") return n.dependencies.map((d) => ({ groupId: d.groupId, artifactId: d.artifactId }));
    return [];
  });
  const first = nodes[0]!;
  const pom = first.kind === "dependency" || first.kind === "dependencies" ? first.project.pom : null;
  const focus = first.kind === "dependency" ? `${first.dependency.groupId}:${first.dependency.artifactId}` : null;
  return [
    { kind: "action", action: "maven.downloadSources", arg: { artifacts } },
    { kind: "action", action: "maven.downloadDocs", arg: { artifacts } },
    { kind: "action", action: "maven.downloadSourcesAndDocs", arg: { artifacts } },
    { kind: "separator" },
    { kind: "action", action: "maven.analyzeDependencies", arg: { pom, focus } },
  ];
}

async function removeRunConfig(config: RunConfig) {
  if (
    !(await confirm({
      title: "Remove Run Configuration",
      message: tx`Delete "${config.name}"?`,
      ok: "Delete",
      icon: "warning",
    }))
  )
    return;
  await deleteConfig(config.id);
  await refreshConfigs();
}

function runConfigMenu(config: RunConfig): MenuItem[] {
  return [
    { label: "Run", icon: "run", run: () => runConfig(config, "run") },
    { label: "Debug", icon: "debug", run: () => runConfig(config, "debug") },
    { kind: "separator" },
    {
      label: "Edit Run Configuration…",
      icon: "edit",
      shortcut: "F4",
      run: () => void executeAction("run.editConfigs", config.id),
    },
    { label: "Remove Run Configuration", icon: "minus", run: () => void removeRunConfig(config) },
  ];
}

function profileMenu(nodes: Array<Extract<BuildNode, { kind: "profile" }>>): MenuItem[] {
  const choices = useBuild.getState().settings.maven.profiles;
  const next = nodes.map((n) => nextProfileChoice(n.profile, choices));
  const same = next.every((x) => x === next[0]);
  return [
    {
      label: toggleProfileText(next[0]),
      disabled: !same,
      run: () => nodes.forEach((n) => setProfile(n.profile.id, next[0])),
    },
  ];
}

// ---------------------------------------------------------------------------
// The view

function EmptyMaven() {
  return (
    <div className={styles.empty}>
      <p className={styles.emptyLead}>
        <T>There are no Maven projects to display.</T>
      </p>
      <p>
        <T>You may use</T> <Icon name="plus" size={14} className={styles.inlineIcon} /> <T>to add a project or</T>{" "}
        <Icon name="refresh" size={14} className={styles.inlineIcon} />{" "}
        <T>to let the plugin find all pom.xml files under the project roots and reload them</T>
      </p>
    </div>
  );
}

function BuildToolView({ tool }: { tool: BuildTool }) {
  const model = useBuild((s) => s.model);
  const configs = useBuild((s) => s.configs);
  const loading = useBuild((s) => s.loading);
  const error = useBuild((s) => s.error);
  const expanded = useBuild((s) => s.expanded[tool]);
  const view = useBuild((s) => s.view);
  const tasks = useBuild((s) => s.maven.tasks);
  const reveal = useBuild((s) => s.reveal);
  const root = useProject((s) => s.project?.root ?? "");
  const [selection, setSelection] = useState<BuildNode[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const handle = useRef<TreeHandle>(null);
  const maven = model?.maven ?? null;
  const gradle = model?.gradle ?? null;

  const ctx = useMemo<MavenTreeContext | null>(
    () => (maven ? { model: maven, configs, view, tasks } : null),
    [maven, configs, view, tasks],
  );
  const roots = useMemo(
    () => (tool === "maven" ? (ctx ? mavenRoots(ctx) : []) : gradle ? gradleRoots(gradle) : []),
    [tool, ctx, gradle],
  );
  const getChildren = useMemo(() => childrenOf(tool, ctx, gradle, configs), [tool, ctx, gradle, configs]);

  const hasModel = tool === "maven" ? !!maven : !!gradle;
  useEffect(() => {
    if (model && hasModel && useBuild.getState().expanded[tool].size === 0)
      setExpanded(tool, initialExpanded(tool, model));
  }, [model, hasModel, tool]);

  const nodesByKey = useCallback(
    (keys: Set<string>) => {
      const out: BuildNode[] = [];
      const walk = (nodes: readonly BuildNode[]) => {
        for (const n of nodes) {
          if (keys.has(n.key)) out.push(n);
          if (expanded.has(n.key)) walk(getChildren(n) ?? []);
        }
      };
      walk(roots);
      return out;
    },
    [roots, expanded, getChildren],
  );

  // Select In › Maven: select and show the project node.
  const [revealed, setRevealed] = useState(reveal?.seq ?? 0);
  if (tool === "maven" && reveal && reveal.seq !== revealed) {
    setRevealed(reveal.seq);
    const keys = new Set([reveal.key]);
    setSelectedKeys(keys);
    setSelection(nodesByKey(keys));
  }
  useEffect(() => {
    if (tool === "maven" && reveal) requestAnimationFrame(() => handle.current?.reveal(reveal.key));
  }, [tool, reveal]);

  const run = (nodes: BuildNode[], mode: "run" | "debug") => {
    const config = model && nodeConfig(nodes, model);
    if (config) runConfig(config, mode);
  };

  const select = (keys: Set<string>, lead: BuildNode | null) => {
    setSelectedKeys(keys);
    const nodes = nodesByKey(keys);
    setSelection(nodes);
    if (lead) setCurrentProject(tool, nodeProject(lead));
    if (tool === "maven")
      useBuild.setState({
        selectedPoms: nodes.flatMap((n) => (n.kind === "mavenProject" ? [n.project.pom] : [])),
      });
  };

  const contextMenu = (node: BuildNode | null, keys: Set<string>, e: MouseEvent) => {
    if (!node) return;
    e.preventDefault();
    const nodes = keys.has(node.key) ? nodesByKey(keys) : [node];
    // IDEA shows a menu only when every selected node has the same one.
    const kinds = new Set(
      nodes.map((n) => (n.kind === "goal" ? "phase" : n.kind === "dependencies" ? "dependency" : n.kind)),
    );
    if (kinds.size !== 1) return;
    let items: MenuItem[] = [];
    if (node.kind === "mavenProject")
      items = projectMenu(nodes as Array<Extract<BuildNode, { kind: "mavenProject" }>>, root);
    else if ((node.kind === "phase" || node.kind === "goal") && maven) {
      const goals = selectedGoals(nodes);
      if (goals) items = goalMenu(goals, maven);
    } else if (node.kind === "dependency" || node.kind === "dependencies") items = dependencyMenu(nodes);
    else if (node.kind === "profiles")
      items = [
        {
          kind: "action",
          action: "maven.resetProfiles",
          disabled: !Object.keys(useBuild.getState().settings.maven.profiles).length,
        },
      ];
    else if (node.kind === "profile") items = profileMenu(nodes as Array<Extract<BuildNode, { kind: "profile" }>>);
    else if (node.kind === "runConfig") items = runConfigMenu(node.config);
    else if (node.kind === "task" && model) {
      const config = nodeConfig(nodes.filter(isRunnable), model);
      if (config)
        items = [
          { label: tx`Run '${config.name}'`, icon: "run", run: () => runConfig(config, "run") },
          { label: tx`Debug '${config.name}'`, icon: "debug", run: () => runConfig(config, "debug") },
          { kind: "separator" },
          { label: "Create Run Configuration…", icon: "edit", run: () => void createRunConfig(config) },
        ];
    } else if (node.kind === "gradleProject") {
      const file = node.project.buildFile;
      if (file)
        items.push({
          label: tx`Open ${file.split("/").pop()}`,
          icon: "file-gradle",
          run: () => void editorService().openFile(`${root}/${file}`),
        });
      items.push(
        { kind: "action", action: "gradle.reload", label: "Reload All Gradle Projects" },
        { kind: "action", action: "gradle.executeTask" },
      );
    }
    if (items.length) showContextMenu({ x: e.clientX, y: e.clientY }, items);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const lead = selection[selection.length - 1];
    if (!lead || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key === "F4") {
      const go = navigatable(lead, root);
      if (!go) return;
      e.preventDefault();
      e.stopPropagation();
      go();
    } else if (e.key === " " && selection.every((n) => n.kind === "profile")) {
      // Space toggles the selected profiles (IDEA's checkbox tree).
      e.preventDefault();
      const choices = useBuild.getState().settings.maven.profiles;
      for (const n of selection)
        if (n.kind === "profile") setProfile(n.profile.id, nextProfileChoice(n.profile, choices));
    } else if ((e.key === "Delete" || e.key === "Backspace") && lead.kind === "runConfig") {
      e.preventDefault();
      void removeRunConfig(lead.config);
    }
  };

  if (!model) {
    return (
      <div className={styles.view}>
        <div className={styles.loading}>
          {error ? (
            error
          ) : loading ? (
            <>
              <Spinner size={14} /> <T>Loading…</T>
            </>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.view}>
      {tool === "maven" ? (
        <MavenToolbar selection={selection} onRun={() => run(selection, "run")} />
      ) : (
        <GradleToolbar selection={selection} />
      )}
      <Banner tool={tool} />
      <div className={styles.body} onKeyDown={onKeyDown}>
        <Tree<BuildNode>
          handleRef={handle}
          roots={roots}
          getKey={(n) => n.key}
          getLabel={nodeLabel}
          getChildren={getChildren}
          isExpandable={(n) => !!getChildren(n)?.length}
          expanded={expanded}
          onExpandedChange={(next) => setExpanded(tool, next)}
          selected={selectedKeys}
          onSelectionChange={select}
          renderNode={(n, state) => <NodeRow node={n} selected={state.selected} />}
          onActivate={(n) => {
            if (n.kind === "profile") {
              setProfile(n.profile.id, nextProfileChoice(n.profile, useBuild.getState().settings.maven.profiles));
              return;
            }
            if (isRunnable(n)) run([n], "run");
          }}
          onContextMenu={contextMenu}
          aria-label={tool === "maven" ? "Maven projects" : "Gradle projects"}
          horizontalScroll
          empty={tool === "maven" ? <EmptyMaven /> : <span className={styles.loading}>{tx("No Gradle projects")}</span>}
        />
      </div>
    </div>
  );
}
