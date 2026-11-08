import { describe, expect, it } from "vitest";
import { MavenOutputParser, artifactOfUrl } from "./maven";
import {
  DEFAULT_FILTERS,
  ExecTree,
  finishedAtHint,
  formatExecDuration,
  isVisible,
  nodeDuration,
  nodeHint,
  visibleChildren,
  type ExecNode,
} from "./tree";

import compileFailure from "./__fixtures__/compile-failure.log?raw";

/** `name [result]` lines of the tree, indented, with every node shown. */
function dump(n: ExecNode, depth = 0): string[] {
  const state = n.kind === "message" ? n.severity : n.kind === "file" ? "file" : n.running ? "running" : n.result;
  return [`${"  ".repeat(depth)}${n.name || n.title} [${state}]`, ...n.children.flatMap((c) => dump(c, depth + 1))];
}

function parse(log: string, exitCode: number, mode: "run" | "sync" = "run") {
  const tree = new ExecTree("parent [compile]", 0, "/project");
  const parser = new MavenOutputParser(tree, { mode, resolvePath: (p) => p.replace(/^\/w\//, "/project/") });
  log.split("\n").forEach((l, i) => parser.feed(l, i + 1));
  parser.finish(exitCode, false, 1000);
  return tree;
}

describe("Maven output → build tree", () => {
  it("shows projects, mojos and the compiler errors of a failed reactor build", () => {
    const tree = parse(compileFailure, 1);
    expect(dump(tree.root)).toEqual([
      "parent [compile] [failed]",
      "  demo:parent:pom:1.0 [success]",
      "  demo:core:jar:1.0 [success]",
      "    resources [success]",
      "    compile [success]",
      "  demo:app:jar:1.0 [failed]",
      "    resources [success]",
      "    compile [failed]",
      "      App.java [file]",
      "        cannot find symbol [error]",
    ]);
    const message = tree.firstError()!;
    expect(message.file).toEqual({ path: "/project/app/src/main/java/demo/App.java", line: 1, col: 48 });
    // javac's continuation lines are part of the message, the repeat after "Failed to execute goal" is not.
    expect(message.detail).toBe("cannot find symbol\n  symbol:   method missing()\n  location: class demo.App");
    expect(message.hint).toBe(":2");
    expect(tree.root.errors).toBe(1);
    expect(nodeHint(message.parent!)).toBe("app/src/main/java/demo 1 error");
    // Each mojo keeps its own console output.
    const compile = tree.get(message.parent!.parent!.id)!;
    expect(compile.output.some((l) => l.includes("Compiling 1 source file"))).toBe(true);
  });

  it("hides successful steps by default, keeps failures and warnings", () => {
    const tree = parse(compileFailure, 1);
    const shown = (n: ExecNode): string[] => [
      n.name || "root",
      ...visibleChildren(n, DEFAULT_FILTERS).flatMap((c) => shown(c).map((s) => `  ${s}`)),
    ];
    expect(shown(tree.root)).toEqual([
      "root",
      "  demo:app:jar:1.0",
      "    compile",
      "      App.java",
      "        cannot find symbol",
    ]);
    expect(isVisible(tree.get("p:demo:core:jar:1.0")!, { showWarnings: true, showSuccessful: true })).toBe(true);
  });

  it("reports a goal failure that is not a compiler error under its mojo", () => {
    const log = [
      "[INFO] -----------------------------< demo:core >------------------------------",
      "[INFO] Building core 1.0",
      "[INFO] --------------------------------[ jar ]---------------------------------",
      "[INFO] --- surefire:3.2.5:test (default-test) @ core ---",
      "[ERROR] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0",
      "[INFO] BUILD FAILURE",
      "[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:3.2.5:test (default-test) on project core: There are test failures. -> [Help 1]",
      "[ERROR] To see the full stack trace of the errors, re-run Maven with the -e switch.",
    ].join("\n");
    const tree = parse(log, 1);
    expect(dump(tree.root)).toEqual([
      "parent [compile] [failed]",
      "  demo:core:jar:1.0 [failed]",
      "    test [failed]",
      "      There are test failures. [error]",
    ]);
  });

  it("marks skipped reactor projects and file warnings", () => {
    const log = [
      "[INFO] -----------------------------< demo:core >------------------------------",
      "[INFO] Building core 1.0                                                  [1/2]",
      "[INFO] --------------------------------[ jar ]---------------------------------",
      "[INFO] --- compiler:3.13.0:compile (default-compile) @ core ---",
      "[WARNING] /w/core/src/main/java/demo/Core.java:[3,8] [deprecation] Date(int,int,int) in Date has been deprecated",
      "[INFO] core ............................................... SUCCESS [  0.548 s]",
      "[INFO] app ................................................ SKIPPED",
      "[INFO] BUILD SUCCESS",
    ].join("\n");
    const tree = parse(log, 0);
    expect(dump(tree.root)).toEqual([
      "parent [compile] [success]",
      "  demo:core:jar:1.0 [success]",
      "    compile [success]",
      "      Core.java [file]",
      "        [deprecation] Date(int,int,int) in Date has been deprecated [warning]",
      "  app [skipped]",
    ]);
    expect(nodeHint(tree.root)).toBe("1 warning");
    expect(visibleChildren(tree.root, DEFAULT_FILTERS).map((n) => n.name)).toEqual(["demo:core:jar:1.0"]);
  });

  it("groups downloads in sync mode, with POM problems under the root", () => {
    const log = [
      "[INFO] Scanning for projects...",
      "Downloading from central: https://repo.maven.apache.org/maven2/org/apache/maven/plugins/maven-help-plugin/3.5.1/maven-help-plugin-3.5.1.jar",
      "Downloaded from central: https://repo.maven.apache.org/maven2/org/apache/maven/plugins/maven-help-plugin/3.5.1/maven-help-plugin-3.5.1.jar (73 kB at 1.2 MB/s)",
      "Downloading from central: https://repo.maven.apache.org/maven2/com/google/guava/guava/33.0.0-jre/guava-33.0.0-jre.pom",
      "[WARNING] Some problems were encountered while building the effective model for demo:app:jar:1.0",
      "[WARNING] 'dependencies.dependency.version' for junit:junit:jar is missing. @ line 12, column 21",
      "[ERROR] Failed to execute goal on project app: Could not resolve dependencies for project demo:app:jar:1.0: Could not find artifact x:y:jar:1 in central",
    ].join("\n");
    const tree = new ExecTree("Sync", 0);
    const parser = new MavenOutputParser(tree, {
      mode: "sync",
      pomOf: (id) => (id === "junit:junit" ? undefined : `/p/${id}.xml`),
    });
    log.split("\n").forEach((l) => parser.feed(l, 1));
    parser.finish(1, false, 2);
    expect(dump(tree.root)).toEqual([
      "Sync [failed]",
      "  Downloading plugins [success]",
      "    org.apache.maven.plugins:maven-help-plugin:jar:3.5.1 [success]",
      "  Downloading dependencies [skipped]",
      "    com.google.guava:guava:pom:33.0.0-jre [skipped]",
      "  'dependencies.dependency.version' for junit:junit:jar is missing. @ line 12, column 21 [warning]",
      "  Could not resolve dependencies for project demo:app:jar:1.0: Could not find artifact x:y:jar:1 in central [error]",
    ]);
  });
});

describe("build tree presentation", () => {
  it("formats durations like IDEA", () => {
    expect(formatExecDuration(0)).toBe("0 ms");
    expect(formatExecDuration(450)).toBe("450 ms");
    expect(formatExecDuration(1000)).toBe("1 sec");
    expect(formatExecDuration(1234)).toBe("1 sec, 234 ms");
    expect(formatExecDuration(60_100)).toBe("1 min, 0 sec, 100 ms");
    expect(formatExecDuration(123_456)).toBe("2 min, 3 sec, 456 ms");
    expect(formatExecDuration(123_456, 2)).toBe("2 min, 3 sec");
    expect(formatExecDuration(125_600, 2)).toBe("2 min, 6 sec");
  });

  it("shows the root's finish time and issues", () => {
    const tree = new ExecTree("demo [compile]", 0);
    tree.start("a", null, "a", 0);
    tree.message("a", "error", "boom", null, 5);
    tree.root.hint = finishedAtHint(Date.UTC(2026, 10, 7, 14, 0), null, "en-US");
    tree.finishBuild("failed", 2500);
    expect(nodeHint(tree.root)).toMatch(/^At 11\/7\/26, .* with 1 error$/);
    expect(nodeDuration(tree.root)).toBe("2 sec, 500 ms");
    expect(tree.get("a")!.result).toBe("skipped");
    expect(nodeDuration(tree.get("a")!)).toBeNull();
  });

  it("parses artifact coordinates of downloaded files", () => {
    expect(
      artifactOfUrl("https://repo.maven.apache.org/maven2/org/springframework/spring-core/6.1.0/spring-core-6.1.0.jar"),
    ).toBe("org.springframework:spring-core:jar:6.1.0");
    expect(
      artifactOfUrl(
        "https://nexus.example.com/repository/maven-public/com/acme/lib/1.0-SNAPSHOT/lib-1.0-20240101.120000-3-sources.jar",
        "nexus",
      ),
    ).toBe("com.acme:lib:jar:1.0-SNAPSHOT");
    expect(artifactOfUrl("https://repo.maven.apache.org/maven2/org/x/y/maven-metadata.xml")).toBeNull();
    expect(artifactOfUrl("https://repo.maven.apache.org/maven2/org/x/y/1/y-1.jar.sha1")).toBeNull();
  });
});
