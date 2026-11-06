/**
 * Hot Reload, a bundled plugin (off by default): JRebel-class hot reload of JVM applications
 * on a JetBrains Runtime (enhanced class redefinition) with HotswapAgent (Spring, MyBatis,
 * Hibernate… reload), or the user's JRebel agent. Here: the plugin entry, Settings › Debugger ›
 * HotSwap, Run / Debug with Hot Reload, the launch hook, the session timelines with their
 * view, the editor chip and the status bar item.
 *
 * Settings: `hotReload.*` (platform/hotReloadSettings), `debugger.reloadClasses`.
 */
import { executeAction, registerActions } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { setJvmLaunchHook } from "@/platform/javaLaunch";
import { hotReloadPrefs, useHotReloadPrefs } from "@/platform/hotReloadSettings";
import { onIdeEvent, type RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { tx } from "@/platform/i18n";
import { lazyComponent } from "@/ui";
import { registerEditorContribution } from "@/editor/api";
import {
  registerBundledPlugin,
  registerRunConfigOption,
  registerRunExecutor,
  registerSessionView,
  registerSettingsPage,
  registerStatusItem,
  type BundledPluginProgress,
  type RunExecutorContribution,
} from "@/workbench/contributions";
import { setHotSwapObserver } from "@/features/debugger/hotswap";
import { startRun } from "@/features/run/store";
import { editorChip } from "./EditorChip";
import { HOT_RELOAD_PARAM, supportsHotReload, withHotReload } from "./inject";
import { hotReloadHook } from "./launch";
import { fileName } from "./parser";
import { recordHotSwap, recordRestartNeeded, timelineKeyOf, trackSessions, useHotSessions, VIEW_ID } from "./sessions";
import { HotReloadStatus } from "./StatusItem";
import { cancelInstall, phaseTitle, retryInstall, setEnabled, SETTINGS_PAGE, useHotReload } from "./store";

const KEYWORDS = ["hot reload", "hotswap", "hot swap", "jrebel", "hotswapagent", "jetbrains runtime", "jbr", "dcevm"];

function useProgress(): BundledPluginProgress | null {
  const job = useHotReload((s) => s.job);
  const failed = useHotReload((s) => s.installError);
  if (job) return { title: phaseTitle(job), fraction: job.fraction, detail: job.detail, cancel: cancelInstall };
  if (failed)
    return {
      title: tx("Download failed"),
      fraction: null,
      detail: failed,
      failed: true,
      retry: () => void retryInstall(),
    };
  return null;
}

function registerPlugin(): () => void {
  return registerBundledPlugin({
    id: "hotReload",
    name: "Hot Reload",
    description:
      "Reloads changed code, Spring beans and configuration into running JVM applications without a restart, like JRebel.",
    icon: "hot-reload",
    features: [
      "New methods, fields, classes and superclasses",
      "Spring beans, mappings and properties; MyBatis mappers",
      "Spring Boot, Maven, Gradle and Tomcat launches",
      "What was reloaded, in the editor and the Run tool window",
    ],
    source: "HotswapAgent (about 2 MB) and a JetBrains Runtime (about 230 MB) download when you enable it",
    settingsPage: SETTINGS_PAGE,
    useEnabled: () => useHotReloadPrefs().enabled,
    setEnabled,
    useProgress,
  });
}

function registerPage(): () => void {
  return registerSettingsPage({
    id: SETTINGS_PAGE,
    title: "HotSwap",
    order: 2,
    projectScope: true,
    keywords: [...KEYWORDS, "reload classes after compilation", "spring boot", "devtools"],
    component: lazyComponent(() => import("./HotSwapPage").then((m) => m.HotSwapPage)),
  });
}

/** The Settings window: the plugin entry and the HotSwap page. */
export function activateSettingsPages(): () => void {
  const disposers = [registerPlugin(), registerPage()];
  return () => disposers.reverse().forEach((d) => d());
}

/** Run / Debug with Hot Reload: they start the flagged configuration themselves. */
const runExecutor: RunExecutorContribution = {
  id: "hotReload",
  label: (name) => tx`Run '${name}' with Hot Reload`,
  icon: "run-hot-reload",
  action: "hotReload.run",
  order: 30,
  supports: supportsHotReload,
  async prepare(config) {
    // Before launch tasks already ran (runWithExecutor).
    await startRun(withHotReload(config), undefined, undefined, { prepared: true });
    return null;
  },
};

const debugExecutor: RunExecutorContribution = {
  id: "hotReloadDebug",
  label: (name) => tx`Debug '${name}' with Hot Reload`,
  icon: "debug-hot-reload",
  action: "hotReload.debug",
  order: 31,
  supports: supportsHotReload,
  async prepare(config) {
    await executeAction("run.debugConfig", { ...withHotReload(config), beforeLaunch: [] });
    return null;
  },
};

/** The executors exist only while the plugin is on. */
function registerExecutors(): () => void {
  let off: (() => void) | null = null;
  const sync = () => {
    const on = hotReloadPrefs().enabled;
    setContext("hotReloadEnabled", on);
    if (on && !off) {
      const a = registerRunExecutor(runExecutor);
      const b = registerRunExecutor(debugExecutor);
      off = () => {
        b();
        a();
      };
    } else if (!on && off) {
      off();
      off = null;
    }
  };
  sync();
  const unsubscribe = useProject.subscribe(sync);
  return () => {
    unsubscribe();
    off?.();
  };
}

const CONFIG_FILE = /^(?:application|bootstrap)(?:-[\w.-]+)?\.(?:properties|ya?ml)$/;
/** Build output and other copies of the configuration: not the source the user edits. */
const OUTPUT_DIR = /[\\/](?:target|build|out|bin|node_modules)[\\/]/;

/**
 * Spring Boot 4 applies configuration files only on a restart (HotswapAgent logs nothing for
 * them): saving one in a hot-reloading session's module says so, with Restart.
 */
function watchSpringBoot4Config(): () => void {
  return onIdeEvent("fsChanged", (e) => {
    const root = (useProject.getState().project?.root ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    const files = [...e.created, ...e.modified]
      .map((p) => p.replace(/\\/g, "/"))
      .filter((p) => CONFIG_FILE.test(fileName(p)) && !OUTPUT_DIR.test(p));
    if (!files.length) return;
    for (const session of Object.values(useHotSessions.getState().sessions)) {
      const version = session.timeline.springBootVersion;
      if (!session.live || !version || !/^4\./.test(version)) continue;
      const dir = session.module ? `${root}/${session.module}/` : `${root}/`;
      for (const file of files.filter((f) => f.startsWith(dir)))
        recordRestartNeeded(session.key, file, tx("Spring Boot 4 applies configuration changes on restart"));
    }
  });
}

export function activate(): () => void {
  const disposers = [
    activateSettingsPages(),
    setJvmLaunchHook(hotReloadHook),
    setHotSwapObserver({
      policy: (session) => (timelineKeyOf(session) ? "always" : null),
      report: ({ sessions, changed, errors, durationMs }) => {
        const keys = sessions.map(timelineKeyOf);
        new Set(keys.filter((k): k is string => !!k)).forEach((key) => recordHotSwap(key, changed, errors, durationMs));
        // The chip (or the timeline) tells; a notification only without them or on failure.
        return keys.every(Boolean) && hotReloadPrefs().editorFeedback && !errors.length;
      },
    }),
    trackSessions(),
    registerSessionView({
      id: VIEW_ID,
      title: "Hot Reload",
      icon: "hot-reload",
      component: lazyComponent(() => import("./TimelineView").then((m) => m.TimelineView)),
    }),
    registerStatusItem({
      id: "hotReload.status",
      align: "right",
      priority: 15,
      title: "Hot Reload",
      component: HotReloadStatus,
    }),
    registerEditorContribution({ id: "hotReload.chip", order: 90, extensions: editorChip }),
    registerExecutors(),
    registerRunConfigOption({
      id: "hotReload.use",
      label: "Use hot reload",
      group: "Java",
      param: HOT_RELOAD_PARAM,
      applies: (config: RunConfig) => hotReloadPrefs().enabled && supportsHotReload(config),
    }),
    watchSpringBoot4Config(),
    registerActions([
      {
        id: "hotReload.run",
        title: "Run with Hot Reload",
        description: "Run the selected configuration with hot reload",
        category: "Run",
        icon: "run-hot-reload",
        when: "projectOpen && hotReloadEnabled",
        menuSlot: "runExecutors",
        keywords: KEYWORDS,
        run: () => executeAction("run.withExecutor", { executor: "hotReload" }).then(() => undefined),
      },
      {
        id: "hotReload.debug",
        title: "Debug with Hot Reload",
        description: "Debug the selected configuration with hot reload",
        category: "Run",
        icon: "debug-hot-reload",
        when: "projectOpen && hotReloadEnabled",
        menuSlot: "runExecutors",
        keywords: KEYWORDS,
        run: () => executeAction("run.withExecutor", { executor: "hotReloadDebug" }).then(() => undefined),
      },
      {
        id: "hotReload.settings",
        title: "Hot Reload Settings…",
        category: "Run",
        icon: "hot-reload",
        keywords: KEYWORDS,
        run: () => void executeAction("file.settings", SETTINGS_PAGE),
      },
    ]),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
