import { describe, expect, it } from "vitest";
import type { GradleModel, MavenModel, MavenProject, RunConfig } from "@/platform/ipc";
import {
  DEFAULT_MAVEN_VIEW,
  PHASES,
  dependencyHint,
  expandableKeys,
  goalCompletions,
  gradleChildren,
  gradleRoots,
  gradleTaskConfig,
  isRunnable,
  mavenChildren,
  mavenGoalConfig,
  mavenRoots,
  nextProfileChoice,
  nodeIcon,
  nodeLabel,
  parseGoalLine,
  parseTaskLine,
  profileState,
  profilesArg,
  sortGoals,
  splitArgs,
  taskCompletions,
  toggleProfileText,
  type BuildNode,
  type MavenTreeContext,
} from "./model";

function project(over: Partial<MavenProject>): MavenProject {
  return {
    pom: "pom.xml",
    dir: "",
    groupId: "demo",
    artifactId: "parent",
    version: "1.0",
    packaging: "pom",
    displayName: "parent",
    parent: null,
    modules: [],
    aggregated: false,
    plugins: [],
    dependencies: [],
    profiles: [],
    javaVersion: 21,
    command: "/p/mvnw",
    options: [],
    env: { JAVA_HOME: "/jdk21" },
    defaultGoal: null,
    repositories: [],
    ignored: false,
    problems: [],
    ...over,
  };
}

const surefire = {
  groupId: "org.apache.maven.plugins",
  artifactId: "maven-surefire-plugin",
  version: "3.2.5",
  prefix: "surefire",
  goals: ["help", "test"],
};

const maven: MavenModel = {
  projects: [
    project({ modules: ["core/pom.xml", "app/pom.xml"], displayName: "Multi Demo", profiles: ["dev", "ci"] }),
    project({
      pom: "core/pom.xml",
      dir: "core",
      artifactId: "core",
      displayName: "core",
      packaging: "jar",
      aggregated: true,
      plugins: [surefire],
      dependencies: [
        {
          groupId: "org.junit.jupiter",
          artifactId: "junit-jupiter",
          version: "5.10.2",
          type: "jar",
          classifier: null,
          scope: "test",
          optional: false,
          children: [
            {
              groupId: "org.junit.jupiter",
              artifactId: "junit-jupiter-api",
              version: "5.10.2",
              type: "jar",
              classifier: null,
              scope: "test",
              optional: false,
              children: [],
            },
          ],
        },
      ],
    }),
    project({
      pom: "app/pom.xml",
      dir: "app",
      artifactId: "app",
      displayName: "Demo App",
      packaging: "jar",
      aggregated: true,
    }),
  ],
  profiles: [
    { id: "dev", activeByDefault: true },
    { id: "ci", activeByDefault: false },
  ],
  syncedAt: null,
  stale: false,
  syncError: null,
  localRepository: null,
};

const runConfig = (over: Partial<RunConfig>): RunConfig => ({
  id: "x",
  name: "x",
  kind: "maven",
  command: "mvn",
  args: [],
  cwd: null,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: null,
  ...over,
});

const ctx = (over: Partial<MavenTreeContext> = {}): MavenTreeContext => ({
  model: maven,
  configs: [],
  view: DEFAULT_MAVEN_VIEW,
  ...over,
});
const children = (n: BuildNode, c = ctx()) => mavenChildren(n, c) ?? [];
const labels = (nodes: BuildNode[]) => nodes.map(nodeLabel);

describe("Maven tree", () => {
  it("shows profiles, then the aggregator with lifecycle, plugins and its modules sorted by name", () => {
    const roots = mavenRoots(ctx());
    expect(labels(roots)).toEqual(["Profiles", "Multi Demo"]);
    // Profiles are sorted; modules nest under their aggregator, sorted by name.
    expect(labels(children(roots[0]!))).toEqual(["ci", "dev"]);
    const top = children(roots[1]!);
    expect(labels(top)).toEqual(["Lifecycle", "Plugins", "core", "Demo App"]);
    expect(labels(children(top[0]!))).toEqual([
      "clean",
      "validate",
      "compile",
      "test",
      "package",
      "verify",
      "install",
      "site",
      "deploy",
    ]);
    expect(nodeIcon(top[0]!)).toBe("build-task-group");
    expect(nodeIcon(children(top[0]!)[0]!)).toBe("build-task");
    // IDEA draws every project with the project icon.
    expect(nodeIcon(top[2]!)).toBe("maven-project");
    expect(nodeIcon(roots[1]!)).toBe("maven-project");
  });

  it("shows every phase without Show Basic Phases Only and modules flat without Group Modules", () => {
    const flat = ctx({ view: { ...DEFAULT_MAVEN_VIEW, groupModules: false, basicPhasesOnly: false } });
    const roots = mavenRoots(flat);
    expect(labels(roots)).toEqual(["Profiles", "core", "Demo App", "Multi Demo"]);
    // "(root)" marks the project without an aggregator beside the flat modules.
    expect(roots.find((n) => n.label === "Multi Demo")!.hint).toBe("root");
    const lifecycle = children(roots[3]!, flat)[0]!;
    expect(labels(children(lifecycle, flat))).toEqual(PHASES);
    expect(PHASES).toHaveLength(24);
    expect(children(roots[3]!, flat).some((n) => n.kind === "mavenProject")).toBe(false);
    const artifactIds = ctx({ view: { ...DEFAULT_MAVEN_VIEW, alwaysShowArtifactId: true } });
    expect(labels(mavenRoots(artifactIds))).toEqual(["Profiles", "parent"]);
  });

  it("hides ignored projects only when asked", () => {
    const ignoredModel = {
      ...maven,
      projects: maven.projects.map((p) => (p.artifactId === "app" ? { ...p, ignored: true } : p)),
    };
    const shown = children(mavenRoots(ctx({ model: ignoredModel }))[1]!, ctx({ model: ignoredModel }));
    expect(labels(shown)).toContain("Demo App");
    const hiddenCtx = ctx({ model: ignoredModel, view: { ...DEFAULT_MAVEN_VIEW, showIgnored: false } });
    expect(labels(children(mavenRoots(hiddenCtx)[1]!, hiddenCtx))).not.toContain("Demo App");
  });

  it("expands plugins to goals and dependencies to their transitive ones", () => {
    const core = children(mavenRoots(ctx())[1]!).find((n) => n.label === "core")!;
    const kids = children(core);
    expect(labels(kids)).toEqual(["Lifecycle", "Plugins", "Dependencies"]);
    const plugin = children(kids[1]!)[0]!;
    expect(nodeLabel(plugin)).toBe("surefire");
    expect(plugin.hint).toBe("org.apache.maven.plugins:maven-surefire-plugin:3.2.5");
    const goals = children(plugin);
    expect(labels(goals)).toEqual(["surefire:help", "surefire:test"]);
    expect(isRunnable(goals[1]!)).toBe(true);
    const deps = children(kids[2]!);
    expect(labels(deps)).toEqual(["org.junit.jupiter:junit-jupiter:5.10.2"]);
    expect(deps[0]!.hint).toBe("test");
    expect(labels(children(deps[0]!))).toEqual(["org.junit.jupiter:junit-jupiter-api:5.10.2"]);
    expect(isRunnable(deps[0]!)).toBe(false);
  });

  it("shows conflicting and duplicate occurrences greyed, without children", () => {
    const d = (omitted: "conflict" | "duplicate" | "cycle") => ({
      groupId: "g",
      artifactId: "a",
      version: "1",
      type: "jar",
      classifier: null,
      scope: "compile",
      optional: false,
      children: [],
      omitted,
      conflictWith: omitted === "conflict" ? "2" : null,
    });
    expect(dependencyHint(d("conflict"))).toBe("omitted for conflict with 2");
    expect(dependencyHint(d("duplicate"))).toBe("omitted for duplicate");
    const p = { ...maven.projects[1]!, dependencies: [d("conflict"), d("duplicate"), d("cycle")] };
    const node: BuildNode = {
      kind: "dependencies",
      key: "k",
      project: p,
      dependencies: p.dependencies,
      label: "Dependencies",
    };
    expect(children(node).map((n) => n.hint)).toEqual(["omitted for conflict with 2", "omitted for duplicate"]);
    expect(mavenChildren(children(node)[0]!, ctx())).toBeUndefined();
  });

  it("toggles profiles through IDEA's states", () => {
    const dev = maven.profiles[0]!;
    const ci = maven.profiles[1]!;
    expect(profileState(dev, {})).toBe("implicit");
    expect(profileState(ci, {})).toBe("none");
    expect(nextProfileChoice(dev, {})).toBe(false);
    expect(nextProfileChoice(ci, {})).toBe(true);
    expect(nextProfileChoice(ci, { ci: true })).toBeUndefined();
    expect(nextProfileChoice(dev, { dev: false })).toBe(true);
    expect(toggleProfileText(true)).toBe("Activate");
    expect(toggleProfileText(false)).toBe("Deactivate");
    expect(toggleProfileText(undefined)).toBe("Use Default");
  });

  it("lists the project's maven run configurations and goal task activation", () => {
    const configs = [
      runConfig({ id: "a", name: "core [test]", cwd: "core", detected: false, args: ["-B", "test"] }),
      runConfig({ id: "b", name: "root", cwd: null }),
      runConfig({ id: "c", kind: "npm", cwd: "core" }),
    ];
    const c = ctx({
      configs,
      tasks: { beforeBuild: [{ pom: "pom.xml", goal: "clean" }], afterRebuild: [{ pom: "pom.xml", goal: "clean" }] },
    });
    const top = mavenChildren(mavenRoots(c)[1]!, c)!;
    expect(labels(top)).toEqual(["Lifecycle", "Plugins", "Run Configurations", "core", "Demo App"]);
    expect(labels(mavenChildren(top[2]!, c)!)).toEqual(["root"]);
    const core = top.find((n) => n.label === "core")!;
    const runs = mavenChildren(core, c)!.find((n) => n.kind === "runConfigs")!;
    const run = mavenChildren(runs, c)!;
    expect(labels(run)).toEqual(["core [test]"]);
    expect(run[0]!.hint).toBe("test");
    const clean = mavenChildren(top[0]!, c)![0]!;
    expect(clean.hint).toBe("Before Build, After Rebuild");
  });

  it("lists the local repository first, then the remote ones", () => {
    const model = {
      ...maven,
      localRepository: "/m2/repository",
      projects: maven.projects.map((p, i) =>
        i === 0 ? { ...p, repositories: [{ id: "central", url: "https://repo.maven.apache.org/maven2" }] } : p,
      ),
    };
    const c = ctx({ model });
    const repos = mavenChildren(mavenRoots(c)[1]!, c)!.find((n) => n.kind === "repositories")!;
    const list = mavenChildren(repos, c)!;
    expect(labels(list)).toEqual(["local", "central"]);
    expect(list.map((n) => n.hint)).toEqual(["/m2/repository", "https://repo.maven.apache.org/maven2"]);
    expect(nodeIcon(list[0]!)).toBe("maven-repo-local");
  });

  it("expand all opens folders but not dependency subtrees", () => {
    const keys = expandableKeys(mavenRoots(ctx()), (n) => mavenChildren(n, ctx()));
    expect(keys.has("mvn:pom.xml")).toBe(true);
    expect(keys.has("mvn:core/pom.xml:deps")).toBe(true);
    expect([...keys].some((k) => k.includes("deps/"))).toBe(false);
  });
});

describe("Maven runs", () => {
  const core = maven.projects[1]!;

  it("passes goals and changed profiles; offline and Skip Tests come with the project's options", () => {
    expect(profilesArg(maven.profiles, {})).toBeNull();
    expect(profilesArg(maven.profiles, { ci: true, dev: false })).toBe("!dev,ci");
    const config = mavenGoalConfig(core, ["clean", "test"], maven, { profiles: { ci: true } });
    expect(config).toMatchObject({
      name: "core [clean,test]",
      kind: "maven",
      command: "/p/mvnw",
      args: ["clean", "test", "-Pci"],
      cwd: "core",
      env: { JAVA_HOME: "/jdk21" },
      isTest: true,
      detected: false,
    });
    const skipped = mavenGoalConfig({ ...core, options: ["--offline", "-DskipTests=true"] }, ["test"], maven, {
      profiles: {},
      skipTests: true,
    });
    expect(skipped.args).toEqual(["--offline", "-DskipTests=true", "test"]);
    expect(skipped.isTest).toBe(false);
    const root = mavenGoalConfig(maven.projects[0]!, ["clean"], maven, { profiles: {} });
    expect(root.cwd).toBeNull();
    expect(root.isTest).toBe(false);
    // Selected goals run in lifecycle order, plugin goals last.
    expect(sortGoals(["surefire:test", "install", "clean"])).toEqual(["clean", "install", "surefire:test"]);
  });

  it("parses typed command lines", () => {
    expect(parseGoalLine("mvn clean install -Dmsg='a b'")).toEqual(["clean", "install", "-Dmsg=a b"]);
    expect(parseGoalLine("./mvnw -q verify")).toEqual(["-q", "verify"]);
    expect(parseTaskLine('./gradlew :app:run --args "x y"')).toEqual([":app:run", "--args", "x y"]);
    expect(splitArgs(`a "" 'b c'`)).toEqual(["a", "", "b c"]);
  });

  it("completes phases and plugin goals for the last word, history for the whole line", () => {
    const c = goalCompletions("clean te", [surefire], ["clean test -DskipTests"]);
    expect(c.map((x) => x.label)).toEqual(["test", "test-compile"]);
    expect(c[0]!.line).toBe("clean test");
    expect(goalCompletions("sure", [surefire]).map((x) => x.label)).toEqual(["surefire:help", "surefire:test"]);
    expect(goalCompletions("cl", [], ["clean install"]).map((x) => x.label)[0]).toBe("clean install");
    expect(goalCompletions("-D", [surefire])).toEqual([]);
  });
});

describe("Gradle tree and runs", () => {
  const gradle: GradleModel = {
    dir: "",
    projects: [
      {
        path: ":",
        name: "gradle-demo",
        dir: "",
        buildFile: "build.gradle.kts",
        tasks: [
          { name: "wrapper", group: "build setup", description: null },
          { name: "init", group: "build setup", description: null },
        ],
      },
      {
        path: ":app",
        name: "app",
        dir: "app",
        buildFile: "app/build.gradle.kts",
        tasks: [
          { name: "run", group: "application", description: "Runs this project" },
          { name: "compileJava", group: "other", description: null },
          { name: "test", group: "verification", description: null },
          { name: "build", group: "build", description: null },
        ],
      },
      { path: ":libs:core", name: "core", dir: "libs/core", buildFile: null, tasks: [] },
    ],
    javaVersion: null,
    command: "/p/gradlew",
    env: {},
    syncedAt: 1,
    stale: false,
    syncError: null,
  };
  const kids = (n: BuildNode) =>
    gradleChildren(n, gradle, [runConfig({ id: "g", name: "app [run]", kind: "gradle" })]) ?? [];

  it("nests subprojects and groups tasks, other last", () => {
    const roots = gradleRoots(gradle);
    expect(labels(roots)).toEqual(["gradle-demo"]);
    expect(labels(kids(roots[0]!))).toEqual(["Tasks", "Run Configurations", "app", "core"]);
    const app = kids(roots[0]!)[2]!;
    const groups = kids(kids(app)[0]!);
    expect(labels(groups)).toEqual(["application", "build", "verification", "other"]);
    expect(labels(kids(kids(kids(roots[0]!)[0]!)[0]!))).toEqual(["init", "wrapper"]);
    expect(nodeIcon(groups[0]!)).toBe("build-task-group");
  });

  it("runs tasks by path from the build directory", () => {
    const app = gradle.projects[1]!;
    const config = gradleTaskConfig(gradle, app, ["test"], { offline: true });
    expect(config).toMatchObject({
      name: "app [test]",
      kind: "gradle",
      command: "/p/gradlew",
      args: [":app:test", "--offline"],
      cwd: null,
      isTest: true,
    });
    expect(gradleTaskConfig(gradle, gradle.projects[0]!, ["wrapper"], { offline: false }).args).toEqual(["wrapper"]);
    expect(gradleTaskConfig(gradle, app, [":lib:jar", "--info"], { offline: false }).args).toEqual([
      ":lib:jar",
      "--info",
    ]);
  });

  it("completes task names and paths", () => {
    const labelsOf = taskCompletions("ru", gradle).map((c) => c.label);
    expect(labelsOf).toEqual([":app:run"]);
    expect(taskCompletions("clean wr", gradle).map((c) => c.line)).toEqual(["clean wrapper"]);
  });
});
