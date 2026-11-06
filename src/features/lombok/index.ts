/**
 * Lombok, shipped as a bundled plugin that is on by default (IDEA's Lombok plugin): jdtls
 * runs with Luma's Lombok agent so generated members complete, navigate and compile;
 * `lombok.config` files get completion, documentation and checks; Java editors get the
 * Lombok inspections, Refactor › Lombok and Refactor › Delombok (Lombok's own delombok).
 *
 * Settings: `lombok.{enabled, agentPath}` (Languages & Frameworks › Lombok).
 */
import { lazyComponent } from "@/ui";
import { useProject } from "@/platform/project";
import { setContext } from "@/platform/context";
import { lombokPrefs, useLombokPrefs } from "@/platform/lombokSettings";
import { registerBundledPlugin, registerSettingsPage } from "@/workbench/contributions";
import { activateConfigSupport } from "./config";
import { activateJavaSupport } from "./java";
import { registerDelombok } from "./delombokActions";
import { registerLombokMenus } from "./menus";
import { LOMBOK_ENABLED, refreshStatus, restartJavaServer, setEnabled, SETTINGS_PAGE } from "./store";

const KEYWORDS = ["lombok", "delombok", "lombok.config", "getter", "setter", "builder", "data", "slf4j", "annotation"];

function registerPlugin(): () => void {
  return registerBundledPlugin({
    id: "lombok",
    name: "Lombok",
    description:
      "Understands Project Lombok: generated getters, builders and constructors complete and compile, with lombok.config support, inspections and Delombok.",
    icon: "lombok",
    features: [
      "Generated members in completion, navigation and errors",
      "lombok.config completion, documentation and checks",
      "Inspections with quick fixes: @Getter, @Setter, @Slf4j may be used",
      "Refactor › Lombok and Refactor › Delombok",
    ],
    source: "Bundled with Luma (Lombok 1.18.48 for the Java language server); nothing to download",
    settingsPage: SETTINGS_PAGE,
    useEnabled: () => useLombokPrefs().enabled,
    setEnabled,
  });
}

function registerPage(): () => void {
  return registerSettingsPage({
    id: SETTINGS_PAGE,
    title: "Lombok",
    group: "Languages & Frameworks",
    order: 396,
    keywords: KEYWORDS,
    component: lazyComponent(() => import("./LombokSettingsPage").then((m) => m.LombokSettingsPage)),
  });
}

/** The Settings window: the plugin entry and Languages & Frameworks › Lombok. */
export function activateSettingsPages(): () => void {
  const disposers = [registerPlugin(), registerPage()];
  return () => disposers.reverse().forEach((d) => d());
}

/**
 * The project's Lombok status follows the project and the plugin's settings; jdtls, which
 * attaches the agent at start, restarts when they change (the plugin switched, another jar).
 */
function watchSettings(): () => void {
  let root: string | null | undefined;
  let agent: string | undefined;
  const check = () => {
    const s = useProject.getState();
    const prefs = lombokPrefs();
    setContext(LOMBOK_ENABLED, prefs.enabled);
    const nextRoot = s.project?.root ?? null;
    const nextAgent = JSON.stringify([prefs.enabled, prefs.agentPath]);
    if (nextRoot === root && nextAgent === agent) return;
    const changed = nextRoot === root && agent !== undefined;
    root = nextRoot;
    agent = nextAgent;
    if (changed) void restartJavaServer();
    if (nextRoot) void refreshStatus();
  };
  check();
  return useProject.subscribe(check);
}

export function activate(): () => void {
  const disposers = [
    activateSettingsPages(),
    watchSettings(),
    activateConfigSupport(),
    activateJavaSupport(),
    registerDelombok(),
    registerLombokMenus(),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
