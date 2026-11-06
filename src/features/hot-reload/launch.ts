/**
 * Hot Reload's part in starting JVMs (`setJvmLaunchHook`): asks the backend for the runtime
 * and agent options of the module (`hotReloadLaunch`), downloads what is missing with visible
 * progress, applies them per configuration kind and marks the session hot-reloading.
 * Without what it needs (an old Java version, no runtime for this OS) the application
 * launches as usual, with one line in its console and one notification.
 */
import {
  call,
  commands,
  isTauri,
  nextRequestId,
  type HotReloadLaunch,
  type JavaLaunchInfo,
  type RunConfig,
} from "@/platform/ipc";
import type { JvmLaunchContext, JvmLaunchHook } from "@/platform/javaLaunch";
import { hotReloadPrefs } from "@/platform/hotReloadSettings";
import { useProject } from "@/platform/project";
import { tx } from "@/platform/i18n";
import { executeAction } from "@/platform/actions";
import { notifications } from "@/workbench/contributions";
import { useRun } from "@/features/run/store";
import {
  contentHash,
  gradleHotReload,
  gradleInitScript,
  isGradleBootRun,
  isMavenBootRun,
  mavenHotReload,
  tomcatHotReload,
  wantsHotReload,
  type HotReloadVm,
} from "./inject";
import { attachSession, expectDebugSession, expectDebugTarget } from "./sessions";
import { installComponents, SETTINGS_PAGE } from "./store";

type Ready = Extract<HotReloadLaunch, { status: "ready" }>;
type Say = (text: string, kind?: "system" | "stderr") => void;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const engineName = (engine: string) => (engine === "jrebel" ? "JRebel" : "HotswapAgent");

/** Output directories among classpath entries (jars are libraries). */
export const classDirs = (info: Pick<JavaLaunchInfo, "classPaths">) =>
  info.classPaths.filter((p) => !/\.(jar|zip)$/i.test(p));

/**
 * The backend's launch plan, downloading HotswapAgent or a JetBrains Runtime first when it
 * asks for one; null when the application launches without hot reload.
 */
export async function resolveLaunch(
  config: RunConfig,
  mode: "run" | "debug",
  javaHome: string | null,
  dirs: readonly string[],
  module: string,
  say: Say,
  signal?: AbortSignal,
): Promise<Ready | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    let plan: HotReloadLaunch;
    try {
      plan = await call(commands.hotReloadLaunch(javaHome, mode, [...dirs], module));
    } catch (e) {
      off(config, say, errorText(e));
      return null;
    }
    if (plan.status === "ready") return plan;
    if (plan.status === "unsupported") {
      off(config, say, plan.reason);
      return null;
    }
    const what = plan.status === "needsAgent" ? "HotswapAgent" : plan.name;
    say(tx`Downloading ${what} for hot reload…` + "\n");
    const ok = await installComponents(plan.status === "needsRuntime" ? [plan.major] : []);
    signal?.throwIfAborted();
    if (!ok) {
      off(config, say, tx`${what} could not be downloaded`);
      return null;
    }
    say(tx`${what} is ready` + "\n");
  }
  return null;
}

/** Hot reload can't run: the console says why, a notification too (once per reason). */
function off(config: RunConfig, say: Say, reason: string) {
  say(tx`Hot reload is off for this launch: ${reason}` + "\n", "stderr");
  notifications().notify({
    group: "hotReload",
    level: "warning",
    key: `hotReload.off.${reason}`,
    title: tx`'${config.name}' runs without hot reload`,
    body: reason,
    actions: [{ label: "Settings…", run: () => void executeAction("file.settings", SETTINGS_PAGE) }],
  });
}

function announce(say: Say, plan: Ready) {
  const engine = engineName(plan.engine);
  say(tx`Hot reload: ${plan.runtime} with ${engine}` + "\n");
}

/** Marks the session hot-reloading and feeds its console to the timeline. */
function attach(ctx: JvmLaunchContext, plan: Ready, module: string) {
  const info = {
    name: ctx.config.name,
    configId: ctx.config.id,
    mode: ctx.mode,
    engine: plan.engine,
    runtime: plan.runtime,
    module,
    startedAt: Date.now(),
  };
  if (!ctx.session) {
    // java-debug starts the JVM: its debug session appears once it runs.
    expectDebugSession(ctx.config.id, info);
    return;
  }
  const id = ctx.session.key.slice("run:".length);
  const startedAt = useRun.getState().sessions.find((s) => s.id === id)?.startedAt ?? info.startedAt;
  ctx.session.onLine(attachSession(ctx.session.key, { ...info, startedAt }));
  // Maven / Gradle / Tomcat started for Debug: the attached debugger's HotSwap reports here.
  if (ctx.mode === "debug") expectDebugTarget(ctx.config.id, ctx.session.key);
}

/** Classpath and JDK of a build tool configuration's module, without building (best effort). */
async function moduleInfo(module: string): Promise<{ javaHome: string | null; dirs: string[] }> {
  try {
    const info = await call(commands.javaResolveLaunch(module, false, false, nextRequestId()));
    return { javaHome: info.javaHome, dirs: classDirs(info) };
  } catch {
    return { javaHome: null, dirs: [] };
  }
}

const moduleOf = (config: RunConfig) => (config.cwd ?? "").replace(/^\.\/?/, "").replace(/\/+$/, "");

/** Writes the Gradle init script next to the module's build output (named by its content). */
async function writeInitScript(module: string, vm: HotReloadVm): Promise<string> {
  const root = useProject.getState().project?.root ?? "";
  const text = gradleInitScript(vm);
  const dir = [root.replace(/[\\/]+$/, ""), module, "build", "tmp", "luma"].filter(Boolean).join("/");
  const path = `${dir}/hot-reload-${contentHash(text)}.init.gradle`;
  try {
    await call(commands.fsCreateFileBytes(path, [...new TextEncoder().encode(text)]));
  } catch (e) {
    // Same name, same content: written by an earlier launch.
    if (!/exist/i.test(errorText(e))) throw e;
  }
  return path;
}

async function processLaunch(launch: RunConfig, ctx: JvmLaunchContext): Promise<RunConfig> {
  const mark = ctx.session && takeMark(ctx.session.key);
  // Applications were resolved through `application`: the agent's lines must reach the console.
  if (mark) return launch.emulateTerminal ? { ...launch, emulateTerminal: false } : launch;
  const kind =
    launch.kind === "tomcat" ? "tomcat" : isMavenBootRun(launch) ? "maven" : isGradleBootRun(launch) ? "gradle" : null;
  if (!kind || !isTauri() || !wantsHotReload(ctx.config, hotReloadPrefs())) return launch;
  const say: Say = ctx.report ?? (() => undefined);
  const module = moduleOf(launch);
  const { javaHome, dirs } = await moduleInfo(module);
  // Gradle runs `build/classes`, jdtls compiles into `bin/main`: the agent loads and watches jdtls'
  // output. Maven and Tomcat run what jdtls (m2e) writes into `target/classes`.
  const extra = kind === "gradle" ? dirs : [];
  const plan = await resolveLaunch(ctx.config, ctx.mode, javaHome, extra, module, say, ctx.signal);
  if (!plan) return launch;
  announce(say, plan);
  const vm: HotReloadVm = { javaExec: plan.javaExec, vmArgs: plan.vmArgs, major: plan.major };
  let out: RunConfig;
  if (kind === "maven") out = mavenHotReload(launch, vm);
  else if (kind === "tomcat") out = tomcatHotReload(launch, vm);
  else out = gradleHotReload(launch, await writeInitScript(module, vm), vm);
  attach(ctx, plan, module);
  return { ...out, emulateTerminal: false };
}

/** Whether the launch hook already made `key` hot-reloading in this start. */
const marked = new Set<string>();
const takeMark = (key: string) => marked.delete(key);

export const hotReloadHook: JvmLaunchHook = {
  async application(ctx) {
    if (!isTauri() || !wantsHotReload(ctx.config, hotReloadPrefs())) return null;
    const say: Say = ctx.report ?? (() => undefined);
    const plan = await resolveLaunch(
      ctx.config,
      ctx.mode,
      ctx.info.javaHome,
      // The JVM loads straight from jdtls' output: nothing extra to watch.
      [],
      ctx.module,
      say,
      ctx.signal,
    );
    if (!plan) return null;
    announce(say, plan);
    attach(ctx, plan, ctx.module);
    if (ctx.session) marked.add(ctx.session.key);
    return { javaExec: plan.javaExec, vmArgs: plan.vmArgs, major: plan.major };
  },
  process: processLaunch,
};
