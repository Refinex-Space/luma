/**
 * Project Structure, derived from what the build tools and the backend already know: Maven /
 * Gradle projects are the modules, their dependencies the libraries, frameworks found in them
 * the facets, their packaging the artifacts. Pure functions (tested); the dialog renders them.
 */
import type {
  BuildModel,
  GradleModel,
  GradleProject,
  LibraryGroup,
  MavenDependency,
  MavenModel,
  MavenProject,
  Sdk,
} from "@/platform/ipc";
import type { RootFolder } from "@/platform/languageSettings";
import { tx } from "@/platform/i18n";

// ---------------------------------------------------------------------------
// Modules

export type ModuleKind = "maven" | "gradle" | "plain";

export interface ModuleInfo {
  id: string;
  name: string;
  /** Project-relative directory; `""` = the project folder. */
  dir: string;
  kind: ModuleKind;
  /** Parent module (Maven aggregator, Gradle parent project). */
  parent: string | null;
  depth: number;
  /** Project-relative build file. */
  buildFile: string | null;
  /** Java feature version it compiles for, when the build says. */
  javaVersion: number | null;
  maven?: MavenProject;
  gradle?: GradleProject;
}

const parentDir = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

function mavenModules(model: MavenModel): ModuleInfo[] {
  const byPom = new Map(model.projects.map((p) => [p.pom, p]));
  const parentOf = new Map<string, string>();
  for (const p of model.projects) for (const child of p.modules) if (byPom.has(child)) parentOf.set(child, p.pom);
  const depth = (pom: string): number => {
    let d = 0;
    for (let at = parentOf.get(pom); at && d < 32; at = parentOf.get(at)) d++;
    return d;
  };
  return model.projects.map((p) => ({
    id: `maven:${p.pom}`,
    name: p.artifactId || p.displayName,
    dir: p.dir,
    kind: "maven" as const,
    parent: parentOf.has(p.pom) ? `maven:${parentOf.get(p.pom)}` : null,
    depth: depth(p.pom),
    buildFile: p.pom,
    javaVersion: p.javaVersion,
    maven: p,
  }));
}

function gradleModules(model: GradleModel): ModuleInfo[] {
  const paths = new Set(model.projects.map((p) => p.path));
  const parentPath = (path: string): string | null => {
    if (path === ":") return null;
    const up = path.slice(0, path.lastIndexOf(":")) || ":";
    return paths.has(up) ? up : paths.has(":") ? ":" : null;
  };
  return model.projects.map((p) => {
    const parent = parentPath(p.path);
    return {
      id: `gradle:${p.path}`,
      name: p.name,
      dir: p.dir,
      kind: "gradle" as const,
      parent: parent ? `gradle:${parent}` : null,
      depth: p.path === ":" ? 0 : p.path.split(":").length - 2 + (paths.has(":") ? 1 : 0),
      buildFile: p.buildFile,
      javaVersion: model.javaVersion,
      gradle: p,
    };
  });
}

/**
 * Modules of the project: its Maven projects, else its Gradle projects (aggregators before
 * their modules), else one per folder roots were detected from (`detectedFrom`), the project
 * folder first.
 */
export function projectModules(
  build: BuildModel | null,
  detected: readonly RootFolder[],
  projectName: string,
): ModuleInfo[] {
  const out: ModuleInfo[] = [];
  if (build?.maven?.projects.length) out.push(...mavenModules(build.maven));
  if (build?.gradle?.projects.length) out.push(...gradleModules(build.gradle));
  if (out.length) return out;
  const dirs = new Set([""]);
  for (const r of detected) if (r.detectedFrom) dirs.add(parentDir(r.detectedFrom));
  return [...dirs]
    .sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map((dir) => ({
      id: `dir:${dir}`,
      name: dir ? dir.slice(dir.lastIndexOf("/") + 1) : projectName,
      dir,
      kind: "plain" as const,
      parent: null,
      depth: dir ? 1 : 0,
      buildFile: detected.find((r) => r.detectedFrom && parentDir(r.detectedFrom) === dir)?.detectedFrom ?? null,
      javaVersion: null,
    }));
}

/** Directories of the other modules inside `module`: their folders belong to them. */
export function nestedDirs(module: ModuleInfo, modules: readonly ModuleInfo[]): string[] {
  return modules
    .filter((m) => m.id !== module.id && m.dir !== module.dir)
    .filter((m) => !module.dir || m.dir.startsWith(`${module.dir}/`))
    .map((m) => m.dir);
}

/** Compiler output folders (project-relative) the build writes the module's classes to. */
export function outputPaths(module: ModuleInfo): { production: string; test: string } | null {
  const at = (p: string) => (module.dir ? `${module.dir}/${p}` : p);
  if (module.kind === "maven") {
    if (module.maven?.packaging === "pom") return null;
    return { production: at("target/classes"), test: at("target/test-classes") };
  }
  if (module.kind === "gradle")
    return { production: at("build/classes/java/main"), test: at("build/classes/java/test") };
  return null;
}

// ---------------------------------------------------------------------------
// Dependencies

export type DependencyKind = "sdk" | "source" | "module" | "library";

export interface ModuleDependency {
  kind: DependencyKind;
  name: string;
  /** Maven scope, title-cased like IDEA (`Compile`, `Test`, `Provided`, `Runtime`, `Import`). */
  scope: string | null;
  /** The module a `module` dependency points at. */
  module?: string;
  dependency?: MavenDependency;
  children?: ModuleDependency[];
}

const SCOPE: Record<string, string> = {
  compile: "Compile",
  test: "Test",
  provided: "Provided",
  runtime: "Runtime",
  system: "System",
  import: "Import",
};

export const coordinates = (d: Pick<MavenDependency, "groupId" | "artifactId" | "version">) =>
  `${d.groupId}:${d.artifactId}${d.version ? `:${d.version}` : ""}`;

/** IDEA's Dependencies tab: the SDK, the module's own sources, then modules and libraries. */
export function moduleDependencies(
  module: ModuleInfo,
  modules: readonly ModuleInfo[],
  sdkName: string,
): ModuleDependency[] {
  const out: ModuleDependency[] = [
    { kind: "sdk", name: sdkName, scope: null },
    { kind: "source", name: "<Module source>", scope: null },
  ];
  const deps = module.maven?.dependencies ?? [];
  const convert = (d: MavenDependency): ModuleDependency => {
    const target = modules.find(
      (m) => m.maven && m.maven.groupId === d.groupId && m.maven.artifactId === d.artifactId && m.id !== module.id,
    );
    return target
      ? { kind: "module", name: target.name, scope: SCOPE[d.scope] ?? d.scope, module: target.id, dependency: d }
      : {
          kind: "library",
          name: `Maven: ${coordinates(d)}`,
          scope: SCOPE[d.scope] ?? (d.scope || "Compile"),
          dependency: d,
          children: d.children.filter((c) => !c.omitted).map(convert),
        };
  };
  out.push(...deps.map(convert));
  return out;
}

// ---------------------------------------------------------------------------
// Libraries

export interface LibraryInfo {
  id: string;
  /** IDEA's library name: `Maven: g:a:v`, or the package / archive name. */
  name: string;
  /** Where it comes from: `maven`, `gradle`, `nodeModules`, `cargo`, `goModules`, `gems`. */
  kind: string;
  /** The list section: the build tool or package manager. */
  section: string;
  /** Archives / folders (classes, sources). */
  paths: string[];
  /** `g:a:v` of a Maven / Gradle library. */
  coordinates: string | null;
  /** Modules declaring it (directly). */
  usedBy: string[];
}

/** Library groups of the project itself; SDK contents (JDK, interpreters) belong to the SDKs. */
export const LIBRARY_KINDS: Record<string, string> = {
  maven: "Maven",
  gradle: "Gradle",
  nodeModules: "npm",
  cargo: "Cargo",
  goModules: "Go modules",
  gems: "RubyGems",
};

/** `Maven: g:a:v` / `Gradle: g:a:v`: one group per dependency (`ide-sdk::libraries`). */
const COORDINATE_GROUP = /^(?:Maven|Gradle): ([^\s:]+):([^\s:]+):(\S+)$/;

/** Project libraries, by build tool, with the modules that declare them. */
export function projectLibraries(groups: readonly LibraryGroup[], modules: readonly ModuleInfo[]): LibraryInfo[] {
  const declared = modules.flatMap((m) => (m.maven ? m.maven.dependencies.map((d) => ({ module: m.name, d })) : []));
  const usedBy = (groupId: string, artifactId: string) => [
    ...new Set(declared.filter((x) => x.d.groupId === groupId && x.d.artifactId === artifactId).map((x) => x.module)),
  ];
  const out: LibraryInfo[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    const section = LIBRARY_KINDS[g.kind];
    if (!section) continue;
    const coords = COORDINATE_GROUP.exec(g.name);
    if (coords) {
      const id = `${g.kind}:${g.name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        name: g.name,
        kind: g.kind,
        section,
        paths: g.roots.map((r) => r.path),
        coordinates: `${coords[1]}:${coords[2]}:${coords[3]}`,
        usedBy: usedBy(coords[1]!, coords[2]!),
      });
      continue;
    }
    // Package managers list one root per package.
    for (const r of g.roots) {
      const id = `${g.kind}:${r.path}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        name: r.name.replace(/!$/, ""),
        kind: g.kind,
        section,
        paths: [r.path],
        coordinates: null,
        usedBy: [],
      });
    }
  }
  const order = Object.keys(LIBRARY_KINDS);
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Facets: frameworks a module uses, found in its build

export interface FacetType {
  id: string;
  name: string;
  icon: string;
}

export const FACET_TYPES: readonly FacetType[] = [
  { id: "spring", name: "Spring", icon: "spring-config" },
  { id: "springBoot", name: "Spring Boot", icon: "spring-boot" },
  { id: "web", name: "Web", icon: "web" },
  { id: "jpa", name: "JPA", icon: "database" },
  { id: "kotlin", name: "Kotlin", icon: "file-kotlin" },
  { id: "lombok", name: "Lombok", icon: "annotation" },
  { id: "mybatis", name: "MyBatis", icon: "database" },
  { id: "quarkus", name: "Quarkus", icon: "package" },
  { id: "micronaut", name: "Micronaut", icon: "package" },
];

const FACET_RULES: ReadonlyArray<{ facet: string; dep?: RegExp; plugin?: RegExp; packaging?: RegExp }> = [
  {
    facet: "springBoot",
    dep: /^org\.springframework\.boot:/,
    plugin: /^org\.springframework\.boot:spring-boot-maven-plugin$/,
  },
  { facet: "spring", dep: /^org\.springframework(\.[a-z]+)*:spring-/ },
  {
    facet: "web",
    dep: /:(spring-boot-starter-web(flux)?|spring-webmvc|jakarta\.servlet-api|javax\.servlet-api)$/,
    packaging: /^war$/,
  },
  { facet: "jpa", dep: /:(spring-boot-starter-data-jpa|jakarta\.persistence-api|persistence-api|hibernate-core)$/ },
  {
    facet: "kotlin",
    dep: /^org\.jetbrains\.kotlin:kotlin-stdlib/,
    plugin: /^org\.jetbrains\.kotlin:kotlin-maven-plugin$/,
  },
  { facet: "lombok", dep: /^org\.projectlombok:lombok$/ },
  { facet: "mybatis", dep: /^(org\.mybatis|com\.baomidou)[^:]*:/ },
  { facet: "quarkus", dep: /^io\.quarkus:/ },
  { facet: "micronaut", dep: /^io\.micronaut/ },
];

export interface FacetInfo {
  id: string;
  type: FacetType;
  module: string;
  /** What gave it away: a dependency, plugin or packaging. */
  evidence: string;
}

/** Frameworks each Maven module uses (its direct dependencies, plugins and packaging). */
export function detectFacets(modules: readonly ModuleInfo[]): FacetInfo[] {
  const out: FacetInfo[] = [];
  for (const m of modules) {
    const p = m.maven;
    if (!p) continue;
    for (const rule of FACET_RULES) {
      const dep = rule.dep && p.dependencies.find((d) => rule.dep!.test(`${d.groupId}:${d.artifactId}`));
      const plugin = rule.plugin && p.plugins.find((x) => rule.plugin!.test(`${x.groupId}:${x.artifactId}`));
      const packaging = rule.packaging?.test(p.packaging);
      const evidence = dep
        ? `${coordinates(dep)} (${dep.scope || "compile"})`
        : plugin
          ? `${plugin.groupId}:${plugin.artifactId}`
          : packaging
            ? `<packaging>${p.packaging}</packaging>`
            : null;
      if (!evidence) continue;
      const type = FACET_TYPES.find((t) => t.id === rule.facet)!;
      out.push({ id: `${m.id}:${type.id}`, type, module: m.name, evidence });
    }
  }
  // Grouped by framework, modules in project order within each.
  const rank = (f: FacetInfo) => FACET_TYPES.indexOf(f.type);
  return out
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i)
    .map((x) => x.f);
}

// ---------------------------------------------------------------------------
// Artifacts: what the build packages

export interface ArtifactInfo {
  id: string;
  /** IDEA's name: `<module>:<type>`. */
  name: string;
  type: string;
  module: ModuleInfo;
  /** Project-relative output directory and file name. */
  outputDir: string;
  file: string;
  /** Goals / tasks that build it. */
  build: string[];
}

const ARCHIVE_PACKAGING = new Set(["jar", "war", "ear", "rar", "maven-plugin", "ejb"]);

export function projectArtifacts(modules: readonly ModuleInfo[]): ArtifactInfo[] {
  const out: ArtifactInfo[] = [];
  const at = (m: ModuleInfo, p: string) => (m.dir ? `${m.dir}/${p}` : p);
  for (const m of modules) {
    if (m.maven && ARCHIVE_PACKAGING.has(m.maven.packaging)) {
      const p = m.maven;
      const ext = p.packaging === "maven-plugin" || p.packaging === "ejb" ? "jar" : p.packaging;
      const boot = p.plugins.some((x) => x.artifactId === "spring-boot-maven-plugin");
      out.push({
        id: `${m.id}:artifact`,
        name: `${p.artifactId}:${ext}`,
        type: boot ? "Spring Boot executable JAR" : ext.toUpperCase(),
        module: m,
        outputDir: at(m, "target"),
        file: `${p.artifactId}-${p.version}.${ext}`,
        build: ["package"],
      });
    } else if (m.gradle) {
      const tasks = new Set(m.gradle.tasks.map((t) => t.name));
      const task = tasks.has("bootJar") ? "bootJar" : tasks.has("war") ? "war" : tasks.has("jar") ? "jar" : null;
      if (!task) continue;
      out.push({
        id: `${m.id}:artifact`,
        name: `${m.name}:${task === "war" ? "war" : "jar"}`,
        type: task === "bootJar" ? "Spring Boot executable JAR" : task.toUpperCase(),
        module: m,
        outputDir: at(m, "build/libs"),
        file: `${m.name}.${task === "war" ? "war" : "jar"}`,
        build: [task],
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// SDKs

/** Java feature version of a JDK (`21.0.10` → 21, `1.8.0_412` → 8). */
export function javaFeature(version: string | null | undefined): number | null {
  const m = /^(\d+)(?:\.(\d+))?/.exec(version ?? "");
  if (!m) return null;
  const major = Number(m[1]);
  return major === 1 && m[2] ? Number(m[2]) : major;
}

/** The project JDK the setting picks: the configured path, else none (Auto). */
export function projectJdk(setting: string, jdks: readonly Sdk[]): Sdk | null {
  if (!setting) return null;
  return jdks.find((j) => j.path === setting || j.home === setting) ?? null;
}

/** Auto: the JDK a module of Java `version` runs on (that version, else the closest newer one). */
export function autoJdk(jdks: readonly Sdk[], version: number | null): Sdk | null {
  const ranked = jdks
    .map((j) => ({ j, v: javaFeature(j.version) }))
    .filter((x): x is { j: Sdk; v: number } => x.v !== null)
    .sort((a, b) => a.v - b.v);
  if (!ranked.length) return null;
  if (version === null) return ranked[ranked.length - 1]!.j;
  return (ranked.find((x) => x.v === version) ?? ranked.find((x) => x.v > version) ?? null)?.j ?? null;
}

// ---------------------------------------------------------------------------
// Problems

export type ProblemFix =
  | { kind: "reload"; tool: "maven" | "gradle" }
  | { kind: "downloadJdk"; version: number }
  | { kind: "page"; page: string };

export interface Problem {
  id: string;
  severity: "error" | "warning";
  message: string;
  /** Where the problem shows (a sidebar page). */
  page: string;
  fixes: Array<{ label: string; fix: ProblemFix }>;
}

export function projectProblems(o: {
  build: BuildModel | null;
  modules: readonly ModuleInfo[];
  jdkSetting: string;
  jdks: readonly Sdk[] | null;
}): Problem[] {
  const out: Problem[] = [];
  const { build } = o;
  for (const tool of ["maven", "gradle"] as const) {
    const m = build?.[tool];
    if (!m) continue;
    const name = tool === "maven" ? "Maven" : "Gradle";
    if (m.syncError)
      out.push({
        id: `${tool}:sync`,
        severity: "error",
        message: tx`${name} sync failed: ${m.syncError}`,
        page: "modules",
        fixes: [{ label: tx`Reload ${name} Project`, fix: { kind: "reload", tool } }],
      });
    else if (m.stale && m.syncedAt !== null)
      out.push({
        id: `${tool}:stale`,
        severity: "warning",
        message: tx`${name} build files changed since the last sync`,
        page: "modules",
        fixes: [{ label: tx`Reload ${name} Project`, fix: { kind: "reload", tool } }],
      });
  }
  // Aggregators (pom packaging) compile nothing.
  const java = o.modules.filter((m) => m.kind !== "plain" && m.maven?.packaging !== "pom");
  const needed = Math.max(0, ...java.map((m) => m.javaVersion ?? 0));
  if (java.length && o.jdks && o.jdks.length === 0)
    out.push({
      id: "jdk:none",
      severity: "error",
      message: tx("No JDK found on this machine"),
      page: "project",
      fixes: [
        {
          label: needed ? tx`Download JDK ${needed}` : tx("Download JDK…"),
          fix: { kind: "downloadJdk", version: needed || 21 },
        },
      ],
    });
  const chosen = o.jdks ? projectJdk(o.jdkSetting, o.jdks) : null;
  const have = javaFeature(chosen?.version);
  if (chosen && have !== null)
    for (const m of java)
      if (m.javaVersion && m.javaVersion > have)
        out.push({
          id: `jdk:${m.id}`,
          severity: "error",
          message: tx`Module '${m.name}' compiles for Java ${m.javaVersion}, but the project SDK is Java ${have}`,
          page: "project",
          fixes: [
            { label: tx("Change Project SDK"), fix: { kind: "page", page: "project" } },
            { label: tx`Download JDK ${m.javaVersion}`, fix: { kind: "downloadJdk", version: m.javaVersion } },
          ],
        });
  return out;
}
