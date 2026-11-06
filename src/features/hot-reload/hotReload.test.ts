import { describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { DEFAULT_HOT_RELOAD, validateHotReload } from "@/platform/hotReloadSettings";
import { chipPaths } from "./EditorChip";
import { reloadSummary, reloadTitle } from "./format";
import {
  gradleHotReload,
  gradleInitScript,
  javaHomeOf,
  mavenHotReload,
  supportsHotReload,
  tomcatHotReload,
  wantsHotReload,
  withHotReload,
} from "./inject";
import { agentEvent, parseAgentLine } from "./parser";
import { nextJob, type InstallJob } from "./store";
import { BURST_GAP_MS, durationOf, statusOf, Timeline } from "./timeline";

/** HotswapAgent 2.0.4 on Spring Boot 3.5 (SPEC.md, verified). */
const SPEC_LOG = [
  "HOTSWAP AGENT: 17:08:56.824 INFO (org.hotswap.agent.HotswapAgent) - Loading Hotswap agent 2.0.4-SNAPSHOT - unlimited runtime class redefinition.",
  "HOTSWAP AGENT: 17:08:57.123 INFO (org.hotswap.agent.plugin.spring.boot.SpringBootPlugin) - Spring Boot plugin initialized - Spring Boot core version '3.5.16'",
  "HOTSWAP AGENT: 17:08:57.501 INFO (org.hotswap.agent.plugin.spring.SpringPlugin) - Spring plugin initialized - Spring core version '6.2.19'",
  "HOTSWAP AGENT: 17:09:21.281 RELOAD (org.hotswap.agent.config.PluginManager) - Reloading classes [demo.HelloController, demo.App] (autoHotswap)",
  "HOTSWAP AGENT: 17:09:21.709 INFO (org.hotswap.agent.plugin.spring.reload.SpringBeanReload) - add new spring bean 'greetService' into org.springframework.beans.factory.support.DefaultListableBeanFactory@7aead3af",
  "HOTSWAP AGENT: 17:09:22.763 INFO (org.hotswap.agent.plugin.spring.reload.SpringBeanReload) - no change, ignore reloading '…DefaultListableBeanFactory@7aead3af'",
  "HOTSWAP AGENT: 17:09:25.240 INFO (org.hotswap.agent.plugin.spring.reload.SpringBeanReload) - try to add changed property 'file:/Users/me/demo/target/classes/application.properties'",
  "HOTSWAP AGENT: 17:09:26.802 RELOAD (org.hotswap.agent.plugin.spring.reload.SpringBeanReload) - the properties of '…DefaultListableBeanFactory@7aead3af' is changed",
];

const at = (time: string) => new Date(`2026-11-05T${time}`).getTime();

describe("agent log", () => {
  it("parses the agent's line format", () => {
    expect(parseAgentLine(SPEC_LOG[3]!)).toEqual({
      time: "17:09:21.281",
      ms: ((17 * 60 + 9) * 60 + 21) * 1000 + 281,
      level: "RELOAD",
      logger: "org.hotswap.agent.config.PluginManager",
      message: "Reloading classes [demo.HelloController, demo.App] (autoHotswap)",
    });
    expect(parseAgentLine("2026-11-05 INFO demo.App - Started App in 1.2 seconds")).toBeNull();
    expect(parseAgentLine("  HOTSWAP AGENT: 9:01:02.003 WARNING (x.Y) - careful ")?.message).toBe("careful");
  });

  it("reads what each line says", () => {
    const events = SPEC_LOG.map((l) => agentEvent(parseAgentLine(l)!));
    expect(events).toEqual([
      { kind: "started", version: "2.0.4-SNAPSHOT" },
      { kind: "plugin", name: "Spring Boot", version: "3.5.16" },
      { kind: "plugin", name: "Spring", version: "6.2.19" },
      { kind: "classes", classes: ["demo.HelloController", "demo.App"] },
      { kind: "beanAdded", bean: "greetService" },
      { kind: "noChange" },
      { kind: "properties", file: "application.properties" },
      { kind: "properties", file: null },
    ]);
    const line = (level: string, logger: string, message: string) =>
      agentEvent(parseAgentLine(`HOTSWAP AGENT: 10:00:00.000 ${level} (${logger}) - ${message}`)!);
    expect(line("ERROR", "org.hotswap.agent.X", "Failed to reload")).toEqual({
      kind: "error",
      message: "Failed to reload",
    });
    expect(line("WARNING", "org.hotswap.agent.X", "slow")).toEqual({ kind: "warning", message: "slow" });
    expect(
      line(
        "RELOAD",
        "org.hotswap.agent.plugin.mybatis.MyBatisRefreshCommands",
        "reload mapper file /a/b/UserMapper.xml",
      ),
    ).toEqual({ kind: "mapper", name: "UserMapper.xml" });
    expect(line("RELOAD", "org.hotswap.agent.plugin.spring.SpringPlugin", "Reloading bean 'userService'")).toEqual({
      kind: "beanRefreshed",
      bean: "userService",
    });
  });
});

describe("reload timeline", () => {
  it("groups a burst into one reload and keeps the start-up apart", () => {
    const t = new Timeline();
    const changed = SPEC_LOG.map((l) => t.feedText(l, at(l.slice(15, 27))));
    expect(changed.slice(0, 3)).toEqual([null, null, null]);
    expect(t.startup).toEqual({
      agent: "2.0.4-SNAPSHOT",
      plugins: [
        { name: "Spring Boot", version: "3.5.16" },
        { name: "Spring", version: "6.2.19" },
      ],
      warnings: [],
    });
    expect(t.springBootVersion).toBe("3.5.16");
    expect(t.entries).toHaveLength(2);
    const [classes, properties] = t.entries;
    expect(classes).toMatchObject({
      time: "17:09:21",
      classes: ["demo.HelloController", "demo.App"],
      beansAdded: ["greetService"],
      properties: [],
    });
    // "no change" joins the reload without stretching it.
    expect(durationOf(classes!)).toBe(428);
    expect(properties).toMatchObject({ properties: ["application.properties"], classes: [] });
    expect(durationOf(properties!)).toBe(1562);
    expect(statusOf(classes!)).toBe("ok");
    expect(reloadSummary(classes!)).toBe("2 classes reloaded · 1 bean · 428 ms");
    expect(reloadSummary(properties!)).toBe("Properties reloaded · 1.6 s");
  });

  it("starts a new reload after a quiet gap and records problems", () => {
    const t = new Timeline();
    t.feedText("HOTSWAP AGENT: 10:00:00.000 WARNING (a.B) - plugin not loaded");
    expect(t.startup.warnings).toEqual(["plugin not loaded"]);
    t.feedText("HOTSWAP AGENT: 10:00:01.000 RELOAD (a.PluginManager) - Reloading classes [a.B] (autoHotswap)");
    const late = 1000 + BURST_GAP_MS + 1;
    const s = String(Math.floor(late / 1000)).padStart(2, "0");
    const e = t.feedText(`HOTSWAP AGENT: 10:00:${s}.001 ERROR (a.B) - Cannot redefine a.C: schema change`)!;
    expect(t.entries).toHaveLength(2);
    expect(statusOf(e)).toBe("error");
    expect(reloadTitle(e)).toBe("Reload failed");
    expect(reloadSummary(e)).toBe("Reload failed");
  });

  it("merges a debugger HotSwap into the agent's reload under way and tells restart-only changes", () => {
    const t = new Timeline();
    const now = Date.now();
    const d = new Date(now - 100);
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    t.feedText(`HOTSWAP AGENT: ${time} RELOAD (a.PluginManager) - Reloading classes [demo.A] (autoHotswap)`, now - 100);
    const e = t.hotSwap(["demo.A", "demo.B"], [], 40, now);
    expect(t.entries).toHaveLength(1);
    expect(e).toMatchObject({ classes: ["demo.A", "demo.B"], hotSwap: true });
    const restart = t.restartNeeded(
      "/p/src/main/resources/application.yml",
      "Spring Boot 4 applies configuration changes on restart",
      now,
    );
    expect(restart).toBe(e);
    expect(statusOf(e)).toBe("warning");
    const t2 = new Timeline();
    const only = t2.restartNeeded("/p/application.yml", "on restart", now);
    expect(reloadTitle(only)).toBe("Restart to apply");
  });
});

describe("editor chip", () => {
  it("shows in the editors of the changed files, else in the active one", () => {
    const t = new Timeline();
    t.feedText(SPEC_LOG[3]!);
    const entry = t.entries[0]!;
    const open = ["/p/src/main/java/demo/HelloController.java", "/p/src/main/java/demo/Other.java", "/p/pom.xml"];
    expect([...chipPaths(entry, open, open[2]!)]).toEqual([open[0]]);
    expect([...chipPaths(entry, open.slice(1), open[2]!)]).toEqual([open[2]]);
    expect([...chipPaths(entry, [], null)]).toEqual([]);
    const props = new Timeline();
    props.feedText(SPEC_LOG[6]!);
    expect([...chipPaths(props.entries[0]!, ["/p/src/main/resources/application.properties"], null)]).toEqual([
      "/p/src/main/resources/application.properties",
    ]);
  });
});

const config = (patch: Partial<RunConfig>): RunConfig => ({
  id: "c",
  name: "App",
  kind: "spring-boot",
  command: "java",
  args: ["-cp", "${classpath}", "demo.App"],
  cwd: null,
  env: {},
  detected: false,
  isTest: false,
  debugAdapter: "java-debug",
  ...patch,
});

describe("injection", () => {
  const on = { ...DEFAULT_HOT_RELOAD, enabled: true };

  it("decides which launches hot-reload", () => {
    const boot = config({});
    expect(wantsHotReload(boot, on)).toBe(false);
    expect(wantsHotReload(withHotReload(boot), on)).toBe(true);
    expect(wantsHotReload(withHotReload(boot), DEFAULT_HOT_RELOAD)).toBe(false);
    expect(wantsHotReload(boot, { ...on, springBootDefault: true })).toBe(true);
    expect(wantsHotReload(config({ kind: "application" }), { ...on, springBootDefault: true })).toBe(false);
    expect(wantsHotReload(withHotReload(config({ target: "ssh" })), on)).toBe(false);
    expect(supportsHotReload(config({ kind: "maven", command: "mvn", args: ["spring-boot:run"] }))).toBe(true);
    expect(supportsHotReload(config({ kind: "maven", command: "mvn", args: ["package"] }))).toBe(false);
    expect(supportsHotReload(config({ kind: "gradle", command: "./gradlew", args: [":app:bootRun"] }))).toBe(true);
    expect(supportsHotReload(config({ kind: "tomcat" }))).toBe(true);
    expect(supportsHotReload(config({ isTest: true }))).toBe(false);
  });

  const vm = {
    javaExec: "/tools/jdks/jbr-21.0.11/Contents/Home/bin/java",
    vmArgs: [
      "-XX:+AllowEnhancedClassRedefinition",
      "-javaagent:/Application Support/hotswap-agent.jar=autoHotswap=true",
    ],
  };

  it("passes Maven spring-boot:run the options and the runtime", () => {
    const maven = config({ kind: "maven", command: "mvn", args: ["-q", "spring-boot:run"] });
    const out = mavenHotReload(maven, vm);
    expect(out.args).toEqual([
      "-q",
      '-Dspring-boot.run.jvmArguments=-XX:+AllowEnhancedClassRedefinition "-javaagent:/Application Support/hotswap-agent.jar=autoHotswap=true"',
      "spring-boot:run",
    ]);
    expect(out.env.JAVA_HOME).toBe("/tools/jdks/jbr-21.0.11/Contents/Home");
    // The JDWP agent of Debug stays after them.
    const debug = mavenHotReload(
      { ...maven, args: ["spring-boot:run", "-Dspring-boot.run.jvmArguments=-agentlib:jdwp=x"] },
      vm,
    );
    expect(debug.args[1]).toMatch(/^-Dspring-boot\.run\.jvmArguments=-XX:\+AllowEnhanced.* -agentlib:jdwp=x$/);
    // JRebel keeps the project JDK.
    expect(mavenHotReload(maven, { ...vm, javaExec: null }).env.JAVA_HOME).toBeUndefined();
  });

  it("writes a Gradle init script that runs bootRun on the runtime", () => {
    const jbr = { ...vm, major: 21 };
    const script = gradleInitScript(jbr);
    expect(script).toContain("gradle.projectsEvaluated");
    expect(script).toContain("matching { it.name == 'bootRun' }");
    // Spring Boot's bootRun reads its launcher: it becomes the JetBrains Runtime toolchain.
    expect(script).toContain("spec.languageVersion = JavaLanguageVersion.of(21)");
    expect(script).toContain("spec.vendor = JvmVendorSpec.JETBRAINS");
    expect(script).not.toContain("executable");
    expect(script).toContain(
      "t.jvmArgs(['-XX:+AllowEnhancedClassRedefinition', '-javaagent:/Application Support/hotswap-agent.jar=autoHotswap=true'])",
    );
    expect(gradleInitScript({ ...vm, javaExec: null, major: null })).not.toContain("javaLauncher");
    const out = gradleHotReload(config({ kind: "gradle", args: ["bootRun"] }), "/p/init.gradle", jbr);
    expect(out.args).toEqual([
      "--init-script",
      "/p/init.gradle",
      "-Porg.gradle.java.installations.paths=/tools/jdks/jbr-21.0.11/Contents/Home",
      "bootRun",
    ]);
  });

  it("gives Tomcat the runtime as its JRE and the options in CATALINA_OPTS", () => {
    const out = tomcatHotReload(config({ kind: "tomcat", env: { CATALINA_OPTS: "-Xmx1g" }, params: { jre: "" } }), vm);
    expect(out.params?.jre).toBe("/tools/jdks/jbr-21.0.11/Contents/Home");
    expect(out.env.CATALINA_OPTS).toBe(
      '-XX:+AllowEnhancedClassRedefinition "-javaagent:/Application Support/hotswap-agent.jar=autoHotswap=true" -Xmx1g',
    );
    expect(javaHomeOf("C:\\jbr\\bin\\java.exe")).toBe("C:\\jbr");
  });

  it("validates the settings", () => {
    expect(validateHotReload({ engine: "nope", disabledPlugins: ["Hibernate", 3] })).toMatchObject({
      enabled: false,
      engine: "hotswapAgent",
      disabledPlugins: ["Hibernate"],
      disableDevtoolsRestart: true,
      editorFeedback: true,
      logLevel: "info",
    });
  });
});

describe("downloads", () => {
  it("follows the installer's steps", () => {
    let job: InstallJob = { request: 1, phase: "prepare", major: null, fraction: null, detail: null };
    job = nextJob(job, { type: "line", text: "Downloading HotswapAgent 2.0.4-SNAPSHOT (https://…)" });
    expect(job.phase).toBe("agent");
    job = nextJob(job, { type: "line", text: "Downloading jbrsdk-21.0.11-osx-aarch64-b1163.125.tar.gz (https://…)" });
    expect(job).toMatchObject({ phase: "runtime", major: 21 });
    job = nextJob(job, { type: "progress", fraction: 0.5, message: "115.0 of 230.0 MB" });
    expect(job).toMatchObject({ fraction: 0.5, detail: "115.0 / 230.0 MB" });
    expect(nextJob(job, { type: "line", text: "Checksum verified (SHA-512)" }).phase).toBe("verify");
    expect(nextJob(job, { type: "line", text: "Extracting…" }).phase).toBe("unpack");
  });

  it("keeps agent set-up errors out of the reloads, even late ones", () => {
    const t = new Timeline();
    t.feedText(
      "HOTSWAP AGENT: 17:09:21.281 RELOAD (org.hotswap.agent.config.PluginManager) - Reloading classes [demo.HelloController] (autoHotswap)",
      1000,
    );
    const late = t.feedText(
      "HOTSWAP AGENT: 17:09:40.600 ERROR (org.hotswap.agent.annotation.handler.InitHandler) - InvocationTargetException in init method on plugin class org.hotswap.agent.plugin.watchResources.WatchResourcesPlugin.",
      20_000,
    );
    expect(late).toBeNull();
    expect(t.entries).toHaveLength(1);
    expect(t.entries[0]!.errors).toEqual([]);
    expect(t.startup.warnings[0]).toMatch(/WatchResourcesPlugin/);
  });
});
