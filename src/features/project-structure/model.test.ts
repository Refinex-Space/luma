import { describe, expect, it } from "vitest";
import type { BuildModel, MavenDependency, MavenProject, Sdk } from "@/platform/ipc";
import {
  autoJdk,
  detectFacets,
  javaFeature,
  moduleDependencies,
  nestedDirs,
  outputPaths,
  projectArtifacts,
  projectLibraries,
  projectModules,
  projectProblems,
} from "./model";

const dep = (
  g: string,
  a: string,
  v: string,
  scope = "compile",
  children: MavenDependency[] = [],
): MavenDependency => ({
  groupId: g,
  artifactId: a,
  version: v,
  type: "jar",
  classifier: null,
  scope,
  optional: false,
  children,
});

const project = (o: Partial<MavenProject> & Pick<MavenProject, "pom" | "dir" | "artifactId">): MavenProject => ({
  groupId: "cn.refinex",
  version: "1.0.0",
  packaging: "jar",
  displayName: o.artifactId,
  parent: null,
  modules: [],
  aggregated: false,
  plugins: [],
  dependencies: [],
  profiles: [],
  javaVersion: 21,
  command: "mvn",
  options: [],
  env: {},
  ...o,
});

const boot = {
  groupId: "org.springframework.boot",
  artifactId: "spring-boot-maven-plugin",
  version: "4.1.2",
  prefix: "spring-boot",
  goals: [],
};

const BUILD: BuildModel = {
  gradle: null,
  maven: {
    profiles: [],
    syncedAt: 1,
    stale: false,
    syncError: null,
    projects: [
      project({
        pom: "pom.xml",
        dir: "",
        artifactId: "lab",
        packaging: "pom",
        modules: ["support/pom.xml", "app/pom.xml"],
      }),
      project({ pom: "support/pom.xml", dir: "support", artifactId: "support", aggregated: true }),
      project({
        pom: "app/pom.xml",
        dir: "app",
        artifactId: "app",
        aggregated: true,
        javaVersion: 25,
        plugins: [boot],
        dependencies: [
          dep("org.springframework.boot", "spring-boot-starter-web", "4.1.2", "compile", [
            dep("org.springframework", "spring-webmvc", "7.0.3"),
          ]),
          dep("org.projectlombok", "lombok", "1.18.34", "provided"),
          dep("cn.refinex", "support", "1.0.0", "test"),
        ],
      }),
    ],
  },
};

const jdk = (name: string, version: string): Sdk => ({
  path: `/jdk/${name}`,
  name,
  version,
  source: "system",
  home: `/jdk/${name}`,
  extra: null,
});

describe("project structure model", () => {
  const modules = projectModules(BUILD, [], "lab");

  it("takes the modules from Maven, aggregators before their modules", () => {
    expect(modules.map((m) => [m.name, m.depth, m.parent])).toEqual([
      ["lab", 0, null],
      ["support", 1, "maven:pom.xml"],
      ["app", 1, "maven:pom.xml"],
    ]);
    expect(nestedDirs(modules[0]!, modules)).toEqual(["support", "app"]);
    expect(outputPaths(modules[2]!)).toEqual({ production: "app/target/classes", test: "app/target/test-classes" });
    // An aggregator compiles nothing.
    expect(outputPaths(modules[0]!)).toBeNull();
  });

  it("falls back to the folders roots were detected from", () => {
    const plain = projectModules(
      null,
      [
        { path: "web/src", kind: "source", detectedFrom: "web/package.json" },
        { path: "src", kind: "source", detectedFrom: "Cargo.toml" },
      ],
      "mono",
    );
    expect(plain.map((m) => [m.name, m.dir, m.buildFile])).toEqual([
      ["mono", "", "Cargo.toml"],
      ["web", "web", "web/package.json"],
    ]);
  });

  it("lists the SDK, sources, sibling modules and Maven libraries with their scopes", () => {
    const deps = moduleDependencies(modules[2]!, modules, "zulu-25");
    expect(deps.map((d) => [d.kind, d.name, d.scope])).toEqual([
      ["sdk", "zulu-25", null],
      ["source", "<Module source>", null],
      ["library", "Maven: org.springframework.boot:spring-boot-starter-web:4.1.2", "Compile"],
      ["library", "Maven: org.projectlombok:lombok:1.18.34", "Provided"],
      ["module", "support", "Test"],
    ]);
    expect(deps[2]!.children!.map((c) => c.name)).toEqual(["Maven: org.springframework:spring-webmvc:7.0.3"]);
  });

  it("lists one library per Maven dependency, with the modules declaring it", () => {
    const libs = projectLibraries(
      [
        {
          name: "Maven: org.springframework:spring-webmvc:7.0.3",
          kind: "maven",
          roots: [{ name: "spring-webmvc-7.0.3.jar", path: "/m2/spring-webmvc-7.0.3.jar!" }],
        },
        {
          name: "Maven: org.projectlombok:lombok:1.18.34",
          kind: "maven",
          roots: [
            { name: "lombok-1.18.34.jar", path: "/m2/lombok-1.18.34.jar!" },
            { name: "lombok-1.18.34-sources.jar", path: "/m2/lombok-1.18.34-sources.jar!" },
          ],
        },
        { name: "node_modules", kind: "nodeModules", roots: [{ name: "react", path: "/p/node_modules/react" }] },
        { name: "JDK 21", kind: "jdk", roots: [{ name: "src.zip", path: "/jdk/src.zip!" }] },
      ],
      modules,
    );
    expect(libs.map((l) => [l.section, l.name, l.coordinates, l.usedBy, l.paths.length])).toEqual([
      ["Maven", "Maven: org.projectlombok:lombok:1.18.34", "org.projectlombok:lombok:1.18.34", ["app"], 2],
      // Only a transitive dependency.
      ["Maven", "Maven: org.springframework:spring-webmvc:7.0.3", "org.springframework:spring-webmvc:7.0.3", [], 1],
      ["npm", "react", null, [], 1],
    ]);
  });

  it("finds frameworks in the build, grouped by framework", () => {
    expect(detectFacets(modules).map((f) => `${f.type.name}:${f.module}`)).toEqual([
      "Spring:app",
      "Spring Boot:app",
      "Web:app",
      "Lombok:app",
    ]);
  });

  it("lists the archives the build packages", () => {
    expect(projectArtifacts(modules).map((a) => [a.name, a.type, a.outputDir, a.file])).toEqual([
      ["support:jar", "JAR", "support/target", "support-1.0.0.jar"],
      ["app:jar", "Spring Boot executable JAR", "app/target", "app-1.0.0.jar"],
    ]);
  });

  it("reads Java feature versions and picks the JDK of a module's version", () => {
    expect([javaFeature("21.0.10"), javaFeature("1.8.0_412"), javaFeature(null)]).toEqual([21, 8, null]);
    const jdks = [jdk("zulu-21", "21.0.10"), jdk("temurin-17", "17.0.12"), jdk("zulu-25", "25.0.1")];
    expect(autoJdk(jdks, 21)?.name).toBe("zulu-21");
    expect(autoJdk(jdks, 22)?.name).toBe("zulu-25");
    expect(autoJdk(jdks, 26)).toBeNull();
    expect(autoJdk(jdks, null)?.name).toBe("zulu-25");
  });

  it("reports an SDK older than a module needs, sync failures, and a missing JDK", () => {
    const jdks = [jdk("temurin-17", "17.0.12")];
    const problems = projectProblems({ build: BUILD, modules, jdkSetting: "/jdk/temurin-17", jdks });
    // The aggregator compiles nothing: not reported.
    expect(problems.map((p) => p.id)).toEqual(["jdk:maven:support/pom.xml", "jdk:maven:app/pom.xml"]);
    expect(problems[1]!.fixes.map((f) => f.fix)).toEqual([
      { kind: "page", page: "project" },
      { kind: "downloadJdk", version: 25 },
    ]);
    // Auto picks a JDK per module: nothing to report.
    expect(projectProblems({ build: BUILD, modules, jdkSetting: "", jdks })).toEqual([]);

    const failed: BuildModel = { ...BUILD, maven: { ...BUILD.maven!, syncError: "pom.xml: bad tag" } };
    expect(projectProblems({ build: failed, modules, jdkSetting: "", jdks })[0]).toMatchObject({
      severity: "error",
      fixes: [{ fix: { kind: "reload", tool: "maven" } }],
    });
    expect(projectProblems({ build: BUILD, modules, jdkSetting: "", jdks: [] })[0]).toMatchObject({
      id: "jdk:none",
      fixes: [{ fix: { kind: "downloadJdk", version: 25 } }],
    });
  });
});
