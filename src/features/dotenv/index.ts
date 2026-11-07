/**
 * .env files support, shipped as a bundled plugin that is on by default (JetBrains'
 * ".env files" plugin): `.env` highlighting and inspections, and environment variables
 * from `.env` files, docker-compose files and Dockerfiles completed, navigated and found
 * where code reads them (PHP, JavaScript / TypeScript, Python, Ruby, Go, Rust, JVM
 * languages, C#, Elixir, Swift, Dart, Lua).
 *
 * Settings: `dotenv.{enabled, completion, showValues, hideValues}` (Languages &
 * Frameworks › .env files).
 */
import { registerEditorContribution, registerLanguageMode } from "@/editor/api";
import { dotenvPrefs, useDotEnvPrefs } from "@/platform/dotenvSettings";
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { lazyComponent } from "@/ui";
import { registerBundledPlugin, registerSettingsPage } from "@/workbench/contributions";
import { dotenvEditorExtension } from "./editor";
import { dotenvLanguageDescription } from "./language";
import { sourceKind } from "./providers";
import { invalidateSources } from "./store";

export const SETTINGS_PAGE = "languages.dotenv";

const KEYWORDS = ["env", "dotenv", ".env", "environment variables", "getenv", "process.env", "docker-compose"];

async function setEnabled(on: boolean) {
  if (dotenvPrefs().enabled === on) return;
  if (!isTauri()) {
    const settings = useProject.getState().settings;
    if (settings) useProject.setState({ settings: { ...settings, dotenv: { ...settings.dotenv, enabled: on } } });
    return;
  }
  useProject.setState({ settings: await call(commands.settingsSet("global", "dotenv.enabled", JSON.stringify(on))) });
}

function registerPlugin(): () => void {
  return registerBundledPlugin({
    id: "dotenv",
    name: ".env files",
    description:
      "Supports .env files and the environment variables they, docker-compose.yml and Dockerfiles declare: completion, navigation and usages in code.",
    icon: "file-dotenv",
    features: [
      "Environment variables completed with their values: getenv('…'), process.env.…, os.environ[…]",
      "Go to Declaration in .env, docker-compose.yml and Dockerfiles; Find Usages in code",
      ".env highlighting, ${NESTED} variables and inspections with quick fixes",
      "Values hidden in .env files on request",
    ],
    settingsPage: SETTINGS_PAGE,
    useEnabled: () => useDotEnvPrefs().enabled,
    setEnabled,
  });
}

function registerPage(): () => void {
  return registerSettingsPage({
    id: SETTINGS_PAGE,
    title: ".env files",
    group: "Languages & Frameworks",
    order: 392,
    keywords: KEYWORDS,
    component: lazyComponent(() => import("./DotEnvSettingsPage").then((m) => m.DotEnvSettingsPage)),
  });
}

/** The Settings window: the plugin entry and Languages & Frameworks › .env files. */
export function activateSettingsPages(): () => void {
  const disposers = [registerPlugin(), registerPage()];
  return () => disposers.reverse().forEach((d) => d());
}

/** The language mode and editor support, registered while the plugin is on. */
function register(): () => void {
  const disposers = [
    registerLanguageMode(dotenvLanguageDescription),
    registerEditorContribution({ id: "dotenv", order: 58, extensions: dotenvEditorExtension }),
    // Declaring files changed on disk (the watcher skips git-ignored `.env` files; their
    // modification time is checked when the variables are next needed).
    onIdeEvent("fsChanged", (e) => {
      if ([...e.created, ...e.modified, ...e.removed].some((p) => sourceKind(p))) invalidateSources();
    }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}

export function activate(): () => void {
  let off: (() => void) | null = null;
  const sync = () => {
    const on = dotenvPrefs().enabled;
    if (on && !off) off = register();
    else if (!on && off) {
      off();
      off = null;
    }
  };
  sync();
  const unsubscribe = useProject.subscribe((s, prev) => {
    if (s.settings?.dotenv !== prev.settings?.dotenv) sync();
  });
  const disposers = [registerPlugin(), registerPage()];
  return () => {
    unsubscribe();
    off?.();
    off = null;
    disposers.reverse().forEach((d) => d());
  };
}
