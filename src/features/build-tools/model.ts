/**
 * Tree model and run configurations of the Maven and Gradle tool windows (pure).
 *
 * Maven (IDEA's `MavenProjectsStructure`): Profiles, then the root projects sorted by
 * name (modules nested under their aggregator with Group Modules, else flat). Each
 * project has Lifecycle, Plugins, Run Configurations, Dependencies, Repositories (root
 * projects) and its modules. Gradle: the root project with Tasks (grouped), Run
 * Configurations and its subprojects.
 */
import type {
  GradleModel,
  GradleProject,
  GradleTask,
  MavenDependency,
  MavenModel,
  MavenPlugin,
  MavenProfile,
  MavenProject,
  MavenRepository,
  MavenTaskSettings,
  RunConfig,
} from "@/platform/ipc";

/** IDEA's `MavenConstants.PHASES`: the Lifecycle node with "Show Basic Phases Only" off. */
export const PHASES = [
  "clean",
  "validate",
  "generate-sources",
  "process-sources",
  "generate-resources",
  "process-resources",
  "compile",
  "process-classes",
  "generate-test-sources",
  "process-test-sources",
  "generate-test-resources",
  "process-test-resources",
  "test-compile",
  "process-test-classes",
  "test",
  "prepare-package",
  "package",
  "pre-integration-test",
  "integration-test",
  "post-integration-test",
  "verify",
  "install",
  "site",
  "deploy",
];

const BASIC_PHASES = new Set([
  "clean",
  "validate",
  "compile",
  "test",
  "package",
  "verify",
  "install",
  "deploy",
  "site",
]);

/** The basic phases in lifecycle order (IDEA filters `PHASES` with `BASIC_PHASES`). */
export const LIFECYCLE = PHASES.filter((p) => BASIC_PHASES.has(p));

/** Every phase of the clean, default and site lifecycles (Execute Maven Goal completion). */
export const ALL_PHASES = [
  "pre-clean",
  "clean",
  "post-clean",
  "validate",
  "initialize",
  "generate-sources",
  "process-sources",
  "generate-resources",
  "process-resources",
  "compile",
  "process-classes",
  "generate-test-sources",
  "process-test-sources",
  "generate-test-resources",
  "process-test-resources",
  "test-compile",
  "process-test-classes",
  "test",
  "prepare-package",
  "package",
  "pre-integration-test",
  "integration-test",
  "post-integration-test",
  "verify",
  "install",
  "deploy",
  "pre-site",
  "site",
  "post-site",
  "site-deploy",
];

/** Maven nodes carry their text (`label`) and grey hint, computed with the view options. */
interface Text {
  label: string;
  hint?: string | null;
}

export type BuildNode =
  | ({ kind: "profiles"; key: string } & Text)
  | ({ kind: "profile"; key: string; profile: MavenProfile } & Text)
  | ({ kind: "mavenProject"; key: string; project: MavenProject } & Text)
  | ({ kind: "lifecycle"; key: string; project: MavenProject } & Text)
  | ({ kind: "phase"; key: string; project: MavenProject; phase: string } & Text)
  | ({ kind: "plugins"; key: string; project: MavenProject } & Text)
  | ({ kind: "plugin"; key: string; project: MavenProject; plugin: MavenPlugin } & Text)
  | ({ kind: "goal"; key: string; project: MavenProject; plugin: MavenPlugin; goal: string } & Text)
  | ({ kind: "dependencies"; key: string; project: MavenProject; dependencies: MavenDependency[] } & Text)
  | ({ kind: "dependency"; key: string; project: MavenProject; dependency: MavenDependency } & Text)
  | ({ kind: "repositories"; key: string; project: MavenProject } & Text)
  | ({ kind: "repository"; key: string; repository: MavenRepository; local: boolean } & Text)
  | { kind: "runConfigs"; key: string; configs: RunConfig[]; label?: string; hint?: string | null }
  | { kind: "runConfig"; key: string; config: RunConfig; label?: string; hint?: string | null }
  | { kind: "gradleProject"; key: string; project: GradleProject; label?: string; hint?: string | null }
  | { kind: "tasks"; key: string; project: GradleProject; label?: string; hint?: string | null }
  | {
      kind: "taskGroup";
      key: string;
      project: GradleProject;
      group: string;
      tasks: GradleTask[];
      label?: string;
      hint?: string | null;
    }
  | { kind: "task"; key: string; project: GradleProject; task: GradleTask; label?: string; hint?: string | null };

/** Options applied to every Maven run besides Settings › Maven (the Profiles checkboxes). */
export interface MavenRunOptions {
  /** Explicit profile choices: id → enabled. Unlisted profiles keep their default. */
  profiles: Record<string, boolean>;
  /** Settings › Maven › Runner › Skip Tests (already among the project's options). */
  skipTests?: boolean;
}

export interface GradleRunOptions {
  offline: boolean;
}

/** The tool window's options menu (IDEA's `MavenProjectsNavigatorState`). */
export interface MavenViewOptions {
  groupModules: boolean;
  showIgnored: boolean;
  basicPhasesOnly: boolean;
  alwaysShowArtifactId: boolean;
  showVersions: boolean;
}

/** Group Modules is on as after IDEA's import; the other defaults are IDEA's. */
export const DEFAULT_MAVEN_VIEW: MavenViewOptions = {
  groupModules: true,
  showIgnored: true,
  basicPhasesOnly: true,
  alwaysShowArtifactId: false,
  showVersions: false,
};

export interface MavenTreeContext {
  model: MavenModel;
  configs: readonly RunConfig[];
  view: MavenViewOptions;
  /** Goal task activation (the "Before Build" … hints). */
  tasks?: MavenTaskSettings;
}

// ---------------------------------------------------------------------------
// Maven tree

const projectKey = (p: MavenProject) => `mvn:${p.pom}`;
const byName = (a: { label: string }, b: { label: string }) =>
  a.label.localeCompare(b.label, undefined, { sensitivity: "base" });

/** `group:artifact[:type][:classifier]:version` (IDEA's `MavenArtifact.getDisplayStringWithType…`). */
export function dependencyLabel(d: MavenDependency): string {
  const parts = [d.groupId, d.artifactId];
  if (d.type && d.type !== "jar") parts.push(d.type);
  if (d.classifier) parts.push(d.classifier);
  if (d.version) parts.push(d.version);
  return parts.join(":");
}

/** `[scope ]omitted for conflict with 1.2` / `omitted for duplicate` (IDEA's `DependencyNode` hint). */
export function dependencyHint(d: MavenDependency): string | null {
  const parts: string[] = [];
  if (d.scope && d.scope !== "compile") parts.push(d.scope);
  if (d.optional) parts.push("optional");
  if (d.omitted === "conflict")
    parts.push(d.conflictWith ? `omitted for conflict with ${d.conflictWith}` : "omitted for conflict");
  else if (d.omitted === "duplicate") parts.push("omitted for duplicate");
  return parts.length ? parts.join(" ") : null;
}

/** Plugin text: the goal prefix, with `group:artifact:version` as hint; unresolved ones show their coordinates. */
export function pluginLabel(p: MavenPlugin): string {
  return pluginResolved(p) ? p.prefix : `${p.groupId}:${p.artifactId}${p.version ? `:${p.version}` : ""}`;
}

export function pluginResolved(p: MavenPlugin): boolean {
  return p.goals.length > 0;
}

/** IDEA's profile states: explicitly enabled, implicitly active (greyed), or not. */
export type ProfileState = "explicit" | "implicit" | "none";

export function profileState(profile: MavenProfile, choices: Record<string, boolean>): ProfileState {
  const choice = choices[profile.id];
  if (choice === true) return "explicit";
  if (choice === false) return "none";
  return profile.activeByDefault ? "implicit" : "none";
}

/** Whether a profile is active for runs: the explicit choice, else `activeByDefault`. */
export function profileChecked(profile: MavenProfile, choices: Record<string, boolean>): boolean {
  return profileState(profile, choices) !== "none";
}

/**
 * Toggle Profile (IDEA's `ToggleProfileAction`): explicitly disabled → enabled, enabled →
 * default, default-inactive → enabled, default-active → disabled. `undefined` = default.
 */
export function nextProfileChoice(profile: MavenProfile, choices: Record<string, boolean>): boolean | undefined {
  const choice = choices[profile.id];
  if (choice === false) return true;
  if (choice === true) return undefined;
  return profile.activeByDefault ? false : true;
}

/** The text of Toggle Profile: Activate / Deactivate / Use Default. */
export function toggleProfileText(next: boolean | undefined): string {
  return next === true ? "Activate" : next === false ? "Deactivate" : "Use Default";
}

/** `-P` value for the choices that differ from the defaults (`a,!b`), or null. */
export function profilesArg(profiles: readonly MavenProfile[], choices: Record<string, boolean>): string | null {
  const ids: string[] = [];
  for (const p of profiles) {
    const checked = profileChecked(p, choices);
    if (checked && !p.activeByDefault) ids.push(p.id);
    else if (!checked && p.activeByDefault) ids.push(`!${p.id}`);
  }
  return ids.length ? ids.join(",") : null;
}

/** Profile list for a sync (`-P` entries). */
export function profilesList(profiles: readonly MavenProfile[], choices: Record<string, boolean>): string[] {
  return profilesArg(profiles, choices)?.split(",") ?? [];
}

const visibleProject = (p: MavenProject, view: MavenViewOptions) => !p.ignored || view.showIgnored;

/** The project aggregating `p` (whose `<modules>` list it), if any. */
export function aggregatorOf(model: MavenModel, p: MavenProject): MavenProject | undefined {
  return model.projects.find((q) => q.modules.includes(p.pom));
}

function projectNode(p: MavenProject, ctx: MavenTreeContext, rootHint: boolean): BuildNode {
  const { view } = ctx;
  const name = view.alwaysShowArtifactId ? p.artifactId : p.displayName;
  return {
    kind: "mavenProject",
    key: projectKey(p),
    project: p,
    label: name,
    hint: rootHint ? "root" : null,
  };
}

/** Root projects: with Group Modules those without a visible aggregator, else every project. */
export function mavenRoots(ctx: MavenTreeContext): BuildNode[] {
  const { model, view } = ctx;
  const out: BuildNode[] = [];
  if (model.profiles.length) out.push({ kind: "profiles", key: "mvn:profiles", label: "Profiles" });
  const visible = model.projects.filter((p) => visibleProject(p, view));
  const rootCount = model.projects.filter((p) => !aggregatorOf(model, p)).length;
  const roots = view.groupModules
    ? visible.filter((p) => {
        const agg = aggregatorOf(model, p);
        return !agg || !visibleProject(agg, view);
      })
    : visible;
  // IDEA: "(root)" marks a project without an aggregator when modules are shown flat beside it.
  const nodes = roots.map((p) =>
    projectNode(p, ctx, !view.groupModules && !aggregatorOf(model, p) && model.projects.length > rootCount),
  );
  out.push(...nodes.sort((a, b) => byName(a as Text, b as Text)));
  return out;
}

/** Run configurations of a Maven project: `maven` configs whose directory is the project's. */
export function mavenRunConfigs(project: MavenProject, configs: readonly RunConfig[]): RunConfig[] {
  return configs
    .filter((c) => c.kind === "maven" && normalizeDir(c.cwd) === project.dir)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** Run configurations of a Gradle build: every `gradle` config. */
export function gradleRunConfigs(configs: readonly RunConfig[]): RunConfig[] {
  return configs.filter((c) => c.kind === "gradle");
}

function normalizeDir(cwd: string | null | undefined): string {
  return (cwd ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\/?/, "")
    .replace(/\/+$/, "");
}

/** The goals of a run configuration, its grey hint in the tree. */
export function configGoals(config: RunConfig): string {
  return config.args
    .filter((a, i) => !a.startsWith("-") && !/^-[sfT]$|^-pl$|^-rf$/.test(config.args[i - 1] ?? ""))
    .join(" ");
}

const TASK_LABELS: Array<[keyof MavenTaskSettings, string]> = [
  ["beforeBuild", "Before Build"],
  ["afterBuild", "After Build"],
  ["beforeRebuild", "Before Rebuild"],
  ["afterRebuild", "After Rebuild"],
];

/** "Before Build, After Rebuild" for a goal of a project (IDEA's `MavenTasksManager.getDescription`). */
export function goalTaskHint(tasks: MavenTaskSettings | undefined, pom: string, goal: string): string | null {
  if (!tasks) return null;
  const labels = TASK_LABELS.filter(([k]) => tasks[k]?.some((t) => t.pom === pom && t.goal === goal)).map(([, l]) => l);
  return labels.length ? labels.join(", ") : null;
}

export function mavenChildren(node: BuildNode, ctx: MavenTreeContext): BuildNode[] | undefined {
  const { model, configs, view, tasks } = ctx;
  switch (node.kind) {
    case "profiles":
      return [...model.profiles]
        .sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: "base" }))
        .map((profile) => ({ kind: "profile", key: `mvn:profile:${profile.id}`, profile, label: profile.id }));
    case "mavenProject": {
      const p = node.project;
      const k = projectKey(p);
      const out: BuildNode[] = [
        { kind: "lifecycle", key: `${k}:lifecycle`, project: p, label: "Lifecycle" },
        { kind: "plugins", key: `${k}:plugins`, project: p, label: "Plugins" },
      ];
      const runs = mavenRunConfigs(p, configs);
      if (runs.length) out.push({ kind: "runConfigs", key: `${k}:runs`, configs: runs, label: "Run Configurations" });
      if (p.dependencies.length)
        out.push({
          kind: "dependencies",
          key: `${k}:deps`,
          project: p,
          dependencies: p.dependencies,
          label: "Dependencies",
        });
      if (!aggregatorOf(model, p) && ((p.repositories ?? []).length || model.localRepository))
        out.push({ kind: "repositories", key: `${k}:repos`, project: p, label: "Repositories" });
      if (view.groupModules) {
        const modules = p.modules
          .map((pom) => model.projects.find((x) => x.pom === pom))
          .filter((m): m is MavenProject => !!m && visibleProject(m, view))
          .map((m) => projectNode(m, ctx, false));
        out.push(...modules.sort((a, b) => byName(a as Text, b as Text)));
      }
      return out;
    }
    case "lifecycle":
      return (view.basicPhasesOnly ? LIFECYCLE : PHASES).map((phase) => ({
        kind: "phase",
        key: `${node.key}:${phase}`,
        project: node.project,
        phase,
        label: phase,
        hint: goalTaskHint(tasks, node.project.pom, phase),
      }));
    case "plugins":
      return node.project.plugins
        .map((plugin): BuildNode => ({
          kind: "plugin",
          key: `${node.key}:${plugin.groupId}:${plugin.artifactId}`,
          project: node.project,
          plugin,
          label: pluginLabel(plugin),
          hint: pluginResolved(plugin)
            ? `${plugin.groupId}:${plugin.artifactId}${plugin.version ? `:${plugin.version}` : ""}`
            : null,
        }))
        .sort((a, b) => byName(a as Text, b as Text));
    case "plugin":
      return node.plugin.goals
        .map((goal): BuildNode => {
          const name = `${node.plugin.prefix}:${goal}`;
          return {
            kind: "goal",
            key: `${node.key}:${goal}`,
            project: node.project,
            plugin: node.plugin,
            goal,
            label: name,
            hint: goalTaskHint(tasks, node.project.pom, name),
          };
        })
        .sort((a, b) => byName(a as Text, b as Text));
    case "dependencies":
      return dependencyNodes(node.key, node.project, node.dependencies);
    case "dependency": {
      if (node.dependency.omitted) return undefined;
      const kids = dependencyNodes(node.key, node.project, node.dependency.children);
      return kids.length ? kids : undefined;
    }
    case "repositories": {
      const out: BuildNode[] = [];
      if (model.localRepository)
        out.push({
          kind: "repository",
          key: `${node.key}:local`,
          repository: { id: "local", url: model.localRepository },
          local: true,
          label: "local",
          hint: model.localRepository,
        });
      for (const r of node.project.repositories ?? [])
        out.push({
          kind: "repository",
          key: `${node.key}:${r.id}`,
          repository: r,
          local: false,
          label: r.id,
          hint: r.url,
        });
      return out;
    }
    case "runConfigs":
      return node.configs.map((config) => ({
        kind: "runConfig",
        key: `${node.key}:${config.id}`,
        config,
        label: config.name,
        hint: configGoals(config) || null,
      }));
    default:
      return undefined;
  }
}

/** Resolved occurrences plus those Maven omitted for a conflict or a duplicate (greyed, no children). */
function dependencyNodes(parent: string, project: MavenProject, deps: readonly MavenDependency[]): BuildNode[] {
  return deps.flatMap((dependency, i) =>
    dependency.omitted === "cycle"
      ? []
      : [
          {
            kind: "dependency" as const,
            key: `${parent}/${dependency.groupId}:${dependency.artifactId}:${i}`,
            project,
            dependency,
            label: dependencyLabel(dependency),
            hint: dependencyHint(dependency),
          },
        ],
  );
}

/** Red wavy underline: the node or a descendant has an error (IDEA's `MavenSimpleNode.getTotalErrorLevel`). */
export function mavenNodeError(node: BuildNode): boolean {
  switch (node.kind) {
    case "mavenProject":
      return (node.project.problems ?? []).length > 0 || node.project.plugins.some((p) => !pluginResolved(p));
    case "plugins":
      return node.project.plugins.some((p) => !pluginResolved(p));
    case "plugin":
      return !pluginResolved(node.plugin);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Gradle tree

export function gradleTaskGroups(project: GradleProject): Array<{ group: string; tasks: GradleTask[] }> {
  const groups = new Map<string, GradleTask[]>();
  for (const t of project.tasks) {
    const g = t.group || "other";
    groups.set(g, [...(groups.get(g) ?? []), t]);
  }
  // IDEA: alphabetical groups, "other" last; tasks alphabetical.
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "other" ? 1 : b === "other" ? -1 : a.localeCompare(b)))
    .map(([group, tasks]) => ({ group, tasks: [...tasks].sort((a, b) => a.name.localeCompare(b.name)) }));
}

export function gradleRoots(model: GradleModel): BuildNode[] {
  const root = model.projects.find((p) => p.path === ":") ?? model.projects[0];
  return root ? [{ kind: "gradleProject", key: `gradle:${root.path}`, project: root }] : [];
}

/** Direct subprojects of `path` (`:a` and `:b` under `:`, `:a:x` under `:a`). */
export function gradleSubprojects(model: GradleModel, path: string): GradleProject[] {
  return model.projects.filter((p) => {
    if (p.path === path || p.path === ":") return false;
    const parent = p.path.slice(0, p.path.lastIndexOf(":")) || ":";
    if (parent === path) return true;
    // `include(":a:b")` without `:a`: shown under the root.
    return path === ":" && !model.projects.some((q) => q.path === parent);
  });
}

export function gradleChildren(
  node: BuildNode,
  model: GradleModel,
  configs: readonly RunConfig[],
): BuildNode[] | undefined {
  switch (node.kind) {
    case "gradleProject": {
      const p = node.project;
      const out: BuildNode[] = [{ kind: "tasks", key: `${node.key}:tasks`, project: p }];
      if (p.path === ":") {
        const runs = gradleRunConfigs(configs);
        if (runs.length) out.push({ kind: "runConfigs", key: `${node.key}:runs`, configs: runs });
      }
      for (const sub of gradleSubprojects(model, p.path))
        out.push({ kind: "gradleProject", key: `gradle:${sub.path}`, project: sub });
      return out;
    }
    case "tasks":
      return gradleTaskGroups(node.project).map(({ group, tasks }) => ({
        kind: "taskGroup",
        key: `${node.key}:${group}`,
        project: node.project,
        group,
        tasks,
      }));
    case "taskGroup":
      return node.tasks.map((task) => ({ kind: "task", key: `${node.key}:${task.name}`, project: node.project, task }));
    case "runConfigs":
      return node.configs.map((config) => ({ kind: "runConfig", key: `${node.key}:${config.id}`, config }));
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Labels, icons

export function nodeLabel(node: BuildNode): string {
  if (node.label) return node.label;
  switch (node.kind) {
    case "runConfigs":
      return "Run Configurations";
    case "runConfig":
      return node.config.name;
    case "gradleProject":
      return node.project.name;
    case "tasks":
      return "Tasks";
    case "taskGroup":
      return node.group;
    case "task":
      return node.task.name;
    default:
      return "";
  }
}

export function nodeIcon(node: BuildNode): string {
  switch (node.kind) {
    case "profiles":
      return "maven-profiles";
    case "profile":
      return "maven-profiles";
    case "mavenProject":
      return "maven-project";
    case "lifecycle":
    case "plugins":
      return "build-task-group";
    case "phase":
    case "runConfigs":
      return "build-task";
    case "plugin":
      return "maven-plugin";
    case "goal":
      return "maven-plugin-goal";
    case "dependencies":
      return "folder-library";
    case "dependency":
      return "library";
    case "repositories":
      return "maven-repo-folder";
    case "repository":
      return node.local ? "maven-repo-local" : "maven-repo-remote";
    case "runConfig":
      return node.config.kind === "gradle" ? "build-task" : "file-maven";
    case "gradleProject":
      return "file-gradle";
    case "tasks":
      return "folder";
    case "taskGroup":
      return "build-task-group";
    case "task":
      return "build-task";
  }
}

/** Nodes that run something on double-click / Enter. */
export function isRunnable(node: BuildNode): boolean {
  return node.kind === "phase" || node.kind === "goal" || node.kind === "task" || node.kind === "runConfig";
}

// ---------------------------------------------------------------------------
// Run configurations

const MAVEN_TEST_GOALS = /^(test|verify|integration-test|install|deploy|surefire:test|failsafe:integration-test)$/;

/** Splits a command line into arguments (double / single quotes group). */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (const c of line) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}

/** Goals typed in "Execute Maven Goal" (a leading `mvn` / `mvnw` is ignored). */
export function parseGoalLine(line: string): string[] {
  const args = splitArgs(line.trim());
  if (args[0] && /^(\.\/)?mvnw?(\.cmd)?$/.test(args[0])) args.shift();
  return args;
}

/** Tasks typed in "Execute Gradle Task" (a leading `gradle` / `gradlew` is ignored). */
export function parseTaskLine(line: string): string[] {
  const args = splitArgs(line.trim());
  if (args[0] && /^(\.\/)?gradlew?(\.bat)?$/.test(args[0])) args.shift();
  return args;
}

/** Goals plus the explicit profiles (`-P`); offline, Skip Tests and the other settings are the project's options. */
export function mavenArgs(
  goals: readonly string[],
  model: Pick<MavenModel, "profiles">,
  options: MavenRunOptions,
): string[] {
  const args = [...goals];
  const profiles = profilesArg(model.profiles, options.profiles);
  if (profiles && !args.some((a) => a.startsWith("-P"))) args.push(`-P${profiles}`);
  return args;
}

/** Selected goals in lifecycle order, plugin goals after the phases (IDEA's `MavenProjectsNavigatorPanel`). */
export function sortGoals(goals: readonly string[]): string[] {
  const rank = (g: string) => {
    const i = PHASES.indexOf(g);
    return i < 0 ? PHASES.length : i;
  };
  return goals
    .map((g, i) => ({ g, i }))
    .sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i)
    .map((x) => x.g);
}

/** IDEA names Maven configurations `<project> [goal1,goal2]`. */
export function mavenConfigName(project: MavenProject, goals: readonly string[]): string {
  return `${project.displayName} [${goals.filter((g) => !g.startsWith("-")).join(",")}]`;
}

export function mavenGoalConfig(
  project: MavenProject,
  goals: readonly string[],
  model: Pick<MavenModel, "profiles">,
  options: MavenRunOptions,
): RunConfig {
  const args = [...project.options, ...mavenArgs(goals, model, options)];
  return {
    id: `maven:goal:${project.pom}:${goals.join(" ")}`,
    name: mavenConfigName(project, goals),
    kind: "maven",
    command: project.command,
    args,
    cwd: project.dir || null,
    env: { ...project.env },
    detected: false,
    isTest:
      !options.skipTests &&
      !args.some((a) => a === "-DskipTests" || a === "-DskipTests=true") &&
      goals.some((g) => MAVEN_TEST_GOALS.test(g)),
    debugAdapter: null,
  };
}

/** `:app:test` for task `test` of `:app`, plain `test` in the root project. */
export function gradleTaskPath(project: GradleProject, task: string): string {
  return project.path === ":" ? task : `${project.path}:${task}`;
}

export function gradleTaskConfig(
  model: GradleModel,
  project: GradleProject,
  tasks: readonly string[],
  options: GradleRunOptions,
): RunConfig {
  const args = tasks.map((t) => (t.startsWith("-") || t.startsWith(":") ? t : gradleTaskPath(project, t)));
  if (options.offline && !args.includes("--offline")) args.push("--offline");
  const names = tasks.filter((t) => !t.startsWith("-"));
  return {
    id: `gradle:task:${project.path}:${tasks.join(" ")}`,
    name: `${project.name} [${names.join(",")}]`,
    kind: "gradle",
    command: model.command,
    args,
    cwd: model.dir || null,
    env: { ...model.env },
    detected: false,
    isTest: names.some((t) => /(^|:)(test|check|build|integrationTest)$/.test(t)),
    debugAdapter: null,
  };
}

/** Applies the current toggles to a saved configuration started from the tree. */
export function withGradleOptions(config: RunConfig, options: GradleRunOptions): RunConfig {
  if (!options.offline || config.args.includes("--offline")) return config;
  return { ...config, args: [...config.args, "--offline"] };
}

// ---------------------------------------------------------------------------
// Execute Goal completion

export interface Completion {
  /** The whole line after accepting. */
  line: string;
  /** The completed word. */
  label: string;
  detail?: string;
}

/** Completes the last word of `line` with phases and `prefix:goal`s of `plugins`. */
export function goalCompletions(
  line: string,
  plugins: readonly MavenPlugin[],
  history: readonly string[] = [],
): Completion[] {
  const at = /\S*$/.exec(line)!.index;
  const head = line.slice(0, at);
  const word = line.slice(at).toLowerCase();
  const out: Completion[] = [];
  const seen = new Set<string>();
  const push = (label: string, detail?: string) => {
    if (seen.has(label) || !label.toLowerCase().startsWith(word)) return;
    seen.add(label);
    out.push({ line: head + label, label, detail });
  };
  if (!head.trim())
    for (const h of history)
      if (h.toLowerCase().startsWith(line.toLowerCase()) && h !== line)
        out.push({ line: h, label: h, detail: "recent" });
  if (word.startsWith("-")) return out;
  for (const phase of [...LIFECYCLE, ...ALL_PHASES]) push(phase, "phase");
  const goals = plugins.flatMap((p) => p.goals.map((g) => ({ label: `${p.prefix}:${g}`, detail: p.artifactId })));
  goals.sort((a, b) => a.label.localeCompare(b.label));
  for (const g of goals) push(g.label, g.detail);
  return out;
}

/** Completes the last word of `line` with `tasks` (names and `:project:task` paths). */
export function taskCompletions(line: string, model: GradleModel, history: readonly string[] = []): Completion[] {
  const at = /\S*$/.exec(line)!.index;
  const head = line.slice(0, at);
  const word = line.slice(at).toLowerCase();
  const out: Completion[] = [];
  const seen = new Set<string>();
  if (!head.trim())
    for (const h of history)
      if (h.toLowerCase().startsWith(line.toLowerCase()) && h !== line)
        out.push({ line: h, label: h, detail: "recent" });
  for (const p of model.projects) {
    for (const t of p.tasks) {
      const label = p.path === ":" ? t.name : `${p.path}:${t.name}`;
      if (seen.has(label) || !(label.toLowerCase().startsWith(word) || t.name.toLowerCase().startsWith(word))) continue;
      seen.add(label);
      out.push({ line: head + label, label, detail: t.group });
    }
  }
  return out.sort((a, b) =>
    a.detail === "recent"
      ? -1
      : b.detail === "recent"
        ? 1
        : a.label.length - b.label.length || a.label.localeCompare(b.label),
  );
}

/**
 * Keys of every expandable node below `roots` (Expand All). Dependency nodes are
 * not opened (transitive trees can be huge); their "Dependencies" folder is.
 */
export function expandableKeys(
  roots: readonly BuildNode[],
  children: (n: BuildNode) => BuildNode[] | undefined,
): Set<string> {
  const out = new Set<string>();
  const walk = (nodes: readonly BuildNode[]) => {
    for (const n of nodes) {
      if (n.kind === "dependency") continue;
      const kids = children(n);
      if (!kids?.length) continue;
      out.add(n.key);
      walk(kids);
    }
  };
  walk(roots);
  return out;
}
