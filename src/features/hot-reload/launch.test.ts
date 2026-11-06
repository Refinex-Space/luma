import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  hotReloadLaunch: vi.fn(),
  hotReloadInstall: vi.fn(),
  javaResolveLaunch: vi.fn(),
  fsCreateFileBytes: vi.fn(),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

import type { HotReloadStatus, JavaLaunchInfo, RunConfig, Settings } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useSessionMarks } from "@/workbench/contributions";
import { reloadPolicy, setHotSwapObserver } from "@/features/debugger/hotswap";
import type { DebugSession } from "@/features/debugger/state";
import { hotReloadHook } from "./launch";
import { expectDebugTarget, timelineKeyOf, trackSessions, useHotSessions } from "./sessions";
import { withHotReload } from "./inject";

const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });
const READY = {
  status: "ready" as const,
  engine: "hotswapAgent",
  javaExec: "/jbr/Contents/Home/bin/java",
  vmArgs: ["-XX:+AllowEnhancedClassRedefinition", "-XX:HotswapAgent=external", "-javaagent:/a.jar=autoHotswap=true"],
  runtime: "JetBrains Runtime 21.0.11",
  major: 21,
};
const STATUS: HotReloadStatus = {
  engine: "hotswapAgent",
  agent: { version: "2.0.4-SNAPSHOT", path: "/a.jar", custom: false },
  runtimes: [{ major: 21, version: "21.0.11", build: "b1163.125", experimental: false, home: "/jbr" }],
  platformSupported: true,
  jrebel: null,
};

const info: JavaLaunchInfo = {
  build: null,
  projectRoot: "/p",
  classPaths: ["/p/target/classes", "/m2/spring-core.jar"],
  modulePaths: [],
  pathListSeparator: ":",
  javaHome: "/jdk21",
  javaExec: "/jdk21/bin/java",
  shortenCommandLine: null,
  errors: [],
  errorCount: 0,
  hints: [],
};

const config = (patch: Partial<RunConfig> = {}): RunConfig => ({
  id: "boot",
  name: "Demo",
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

function settings(hotReload: Record<string, unknown>) {
  useProject.setState({ settings: { hotReload } as unknown as Settings });
}

function session(key: string) {
  const listeners: Array<(line: string) => void> = [];
  return {
    key,
    onLine: (l: (line: string) => void) => listeners.push(l),
    emit: (l: string) => listeners.forEach((f) => f(l)),
  };
}

let untrack: () => void;
beforeEach(() => {
  untrack = trackSessions();
  settings({ enabled: true });
});
afterEach(() => {
  untrack();
  vi.clearAllMocks();
  useProject.setState({ settings: null });
});

describe("launch hook", () => {
  it("launches flagged applications on the runtime with the agent and follows the agent's log", async () => {
    ipc.hotReloadLaunch.mockReturnValue(ok(READY));
    const report = vi.fn();
    const s = session("run:run1");
    const out = await hotReloadHook.application!({
      config: withHotReload(config()),
      mode: "run",
      session: s,
      report,
      module: "",
      info,
    });
    expect(out).toEqual({ javaExec: READY.javaExec, vmArgs: READY.vmArgs, major: 21 });
    // Only output directories go to the backend.
    // The JVM loads from jdtls' output itself: nothing extra to watch.
    expect(ipc.hotReloadLaunch).toHaveBeenCalledWith("/jdk21", "run", [], "");
    expect(useSessionMarks.getState().marks["run:run1"]).toMatchObject({ icon: "hot-reload", views: ["hotReload"] });
    s.emit(
      "HOTSWAP AGENT: 17:09:21.281 RELOAD (org.hotswap.agent.config.PluginManager) - Reloading classes [demo.A] (autoHotswap)",
    );
    const hot = useHotSessions.getState();
    expect(hot.sessions["run:run1"]?.timeline.entries[0]?.classes).toEqual(["demo.A"]);
    expect(hot.latest?.key).toBe("run:run1");
    // The terminal is off: the agent's lines must reach the console.
    expect(
      (await hotReloadHook.process!(config({ emulateTerminal: true }), { config: config(), mode: "run", session: s }))
        .emulateTerminal,
    ).toBe(false);
  });

  it("leaves plain launches alone unless Spring Boot uses hot reload by default", async () => {
    ipc.hotReloadLaunch.mockReturnValue(ok(READY));
    const ctx = { mode: "run" as const, session: null, module: "", info };
    expect(await hotReloadHook.application!({ ...ctx, config: config() })).toBeNull();
    expect(await hotReloadHook.application!({ ...ctx, config: config({ kind: "application" }) })).toBeNull();
    settings({ enabled: false });
    expect(await hotReloadHook.application!({ ...ctx, config: withHotReload(config()) })).toBeNull();
    settings({ enabled: true, springBootDefault: true });
    expect(await hotReloadHook.application!({ ...ctx, config: config() })).not.toBeNull();
    expect(ipc.hotReloadLaunch).toHaveBeenCalledTimes(1);
  });

  it("downloads a missing runtime with progress, then launches", async () => {
    ipc.hotReloadLaunch
      .mockReturnValueOnce(ok({ status: "needsRuntime", major: 17, name: "JetBrains Runtime 17" }))
      .mockReturnValueOnce(ok(READY));
    ipc.hotReloadInstall.mockReturnValue(
      ok({ ...STATUS, runtimes: [{ major: 17, version: "17.0.14", build: "b", experimental: false, home: "/jbr17" }] }),
    );
    const report = vi.fn();
    const out = await hotReloadHook.application!({
      config: withHotReload(config()),
      mode: "debug",
      session: null,
      report,
      module: "",
      info,
    });
    expect(ipc.hotReloadInstall).toHaveBeenCalledWith([17], expect.any(Number), expect.anything());
    expect(out?.javaExec).toBe(READY.javaExec);
    expect(report.mock.calls.map(([t]) => t)).toEqual([
      "Downloading JetBrains Runtime 17 for hot reload…\n",
      "JetBrains Runtime 17 is ready\n",
      "Hot reload: JetBrains Runtime 21.0.11 with HotswapAgent\n",
    ]);
  });

  it("launches as usual when hot reload can't run, saying why", async () => {
    ipc.hotReloadLaunch.mockReturnValue(ok({ status: "unsupported", reason: "Java 11 is too old for hot reload" }));
    const report = vi.fn();
    const out = await hotReloadHook.application!({
      config: withHotReload(config()),
      mode: "run",
      session: session("run:run2"),
      report,
      module: "",
      info,
    });
    expect(out).toBeNull();
    expect(report).toHaveBeenCalledWith(
      "Hot reload is off for this launch: Java 11 is too old for hot reload\n",
      "stderr",
    );
    expect(useSessionMarks.getState().marks["run:run2"]).toBeUndefined();
  });

  it("injects into Maven spring-boot:run, Gradle bootRun and Tomcat", async () => {
    ipc.hotReloadLaunch.mockReturnValue(ok(READY));
    ipc.javaResolveLaunch.mockReturnValue(ok({ ...info, javaHome: "/jdk17" }));
    ipc.fsCreateFileBytes.mockReturnValue(ok(null));
    useProject.setState({ project: { root: "/p" } as never });
    const maven = withHotReload(config({ kind: "maven", command: "mvn", args: ["spring-boot:run"], cwd: "api" }));
    const m = await hotReloadHook.process!(maven, { config: maven, mode: "debug", session: session("run:m") });
    expect(ipc.hotReloadLaunch).toHaveBeenLastCalledWith("/jdk17", "debug", [], "api");
    expect(m.args[0]).toMatch(/^-Dspring-boot\.run\.jvmArguments=-XX:\+AllowEnhancedClassRedefinition /);
    expect(m.env.JAVA_HOME).toBe("/jbr/Contents/Home");
    // Debug: the attached debugger's HotSwap reports to this tab.
    expect(timelineKeyOf({ id: 4, runConfig: maven } as DebugSession)).toBe("run:m");

    const gradle = withHotReload(config({ kind: "gradle", command: "./gradlew", args: ["bootRun"] }));
    const g = await hotReloadHook.process!(gradle, { config: gradle, mode: "run", session: session("run:g") });
    // Gradle runs build/classes: jdtls' output is loaded and watched by the agent.
    expect(ipc.hotReloadLaunch).toHaveBeenLastCalledWith("/jdk17", "run", ["/p/target/classes"], "");
    expect(g.args[0]).toBe("--init-script");
    expect(g.args[1]).toMatch(/^\/p\/build\/tmp\/luma\/hot-reload-[0-9a-f]{8}\.init\.gradle$/);
    expect(g.args.slice(2)).toEqual(["-Porg.gradle.java.installations.paths=/jbr/Contents/Home", "bootRun"]);
    const written = new TextDecoder().decode(new Uint8Array(ipc.fsCreateFileBytes.mock.calls[0]![1] as number[]));
    expect(written).toContain("spec.languageVersion = JavaLanguageVersion.of(21)");

    const tomcat = withHotReload(config({ kind: "tomcat", command: "catalina", args: ["run"] }));
    const t = await hotReloadHook.process!(tomcat, { config: tomcat, mode: "run", session: session("run:t") });
    expect(t.params?.jre).toBe("/jbr/Contents/Home");
    expect(t.env.CATALINA_OPTS).toContain("-XX:HotswapAgent=external");
    useProject.setState({ project: null });
  });
});

describe("reload classes after compilation", () => {
  it("follows the setting, and always reloads in hot-reloading debug sessions", () => {
    const off = setHotSwapObserver({ policy: (s) => (timelineKeyOf(s) ? "always" : null), report: () => false });
    const plain = { id: 1, runConfig: config({ id: "other" }) } as DebugSession;
    expect(reloadPolicy(plain)).toBe("ask");
    useProject.setState({ settings: { debugger: { reloadClasses: "never" } } as unknown as Settings });
    expect(reloadPolicy(plain)).toBe("never");
    useHotSessions.setState({
      sessions: { "run:x": { live: true } as never },
    });
    expectDebugTarget("hot", "run:x");
    expect(reloadPolicy({ id: 2, runConfig: config({ id: "hot" }) } as DebugSession)).toBe("always");
    off();
    expect(reloadPolicy({ id: 2, runConfig: config({ id: "hot" }) } as DebugSession)).toBe("never");
  });
});
