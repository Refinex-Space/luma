/**
 * SonarQube for IDE, shipped as a bundled plugin: SonarSource's analysis engine
 * (downloaded on demand) runs next to the language servers of Java, JavaScript /
 * TypeScript, Python, PHP, Go, HTML, CSS, XML and IaC files while it is on. Its
 * issues are ordinary diagnostics (editor, Problems, inspection profiles); its
 * quick fixes are code actions. Here: the plugin entry, Settings › Tools ›
 * SonarQube for IDE, "Deactivate rule", the rule description dialog and
 * notices when the engine can't start.
 *
 * Settings: `sonarlint.{enabled, rules, testFilePattern, analysisExcludes, nodePath, vmArgs}`.
 */
import { createElement } from "react";
import { lazyComponent } from "@/ui";
import { executeAction, registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { registerCodeActionCommand, registerProblemActions } from "@/editor/api";
import { call, commands, onIdeEvent } from "@/platform/ipc";
import { notifications, registerBundledPlugin, registerOverlay, registerSettingsPage } from "@/workbench/contributions";
import { useRuleDialog, showRule } from "./ruleStore";
import {
  cancelInstall,
  deactivateRule,
  installEngine,
  phaseTitle,
  refreshStatus,
  retryInstall,
  SETTINGS_PAGE,
  setEnabled,
  TOOL,
  useSonar,
} from "./store";
import type { BundledPluginProgress } from "@/workbench/contributions";
import { tx } from "@/platform/i18n";

const KEYWORDS = ["sonar", "sonarlint", "sonarqube", "static analysis", "code quality", "security", "rules", "lint"];

/** The engine's download as the plugin's progress; a failed one stays with Retry. */
function useProgress(): BundledPluginProgress | null {
  const job = useSonar((s) => s.job);
  const failed = useSonar((s) => s.installError);
  if (job) return { title: phaseTitle(job.phase), fraction: job.fraction, detail: job.detail, cancel: cancelInstall };
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
    id: "sonarlint",
    name: "SonarQube for IDE",
    description:
      "Finds bugs, vulnerabilities, secrets and code smells as you type with SonarSource's analyzers, with quick fixes and a description for every rule.",
    icon: "toolwindow-inspection",
    features: [
      "Java, JavaScript, TypeScript, Python, PHP, Go, HTML, CSS and XML",
      "Secrets and infrastructure as code (Docker, Kubernetes, Terraform)",
      "Issues in the editor and the Problems view, with quick fixes",
      "Turn rules on or off and set their parameters",
    ],
    source: "Integration bundled with Luma; SonarSource's analysis engine (about 180 MB) downloads when you enable it",
    settingsPage: SETTINGS_PAGE,
    useEnabled: () => useProject((s) => s.settings?.sonarlint?.enabled ?? false),
    setEnabled,
    useProgress,
  });
}

function registerPage(): () => void {
  return registerSettingsPage({
    id: SETTINGS_PAGE,
    title: "SonarQube for IDE",
    group: "Tools",
    order: 450,
    keywords: KEYWORDS,
    component: lazyComponent(() => import("./SonarSettingsPage").then((m) => m.SonarSettingsPage)),
  });
}

/** The Settings window: the plugin entry and the settings page. */
export function activateSettingsPages(): () => void {
  const disposers = [registerPlugin(), registerPage()];
  return () => disposers.reverse().forEach((d) => d());
}

const Dialog = lazyComponent(() => import("./RuleDialog").then((m) => m.RuleDialog));

function RuleOverlay() {
  return useRuleDialog((s) => s.rule) ? createElement(Dialog) : null;
}

async function showRuleByKey(key: string) {
  try {
    showRule(await call(commands.sonarRuleDescription(key)));
  } catch (e) {
    notifications().notify({
      group: "sonarlint",
      level: "warning",
      title: tx`No description for rule ${key}`,
      body: e instanceof Error ? e.message : String(e),
    });
  }
}

/** The engine is on but can't run (not downloaded, no Java 21): one notice, with the fix. */
function watchEngine(): () => void {
  let shown = false;
  return onIdeEvent("languageServer", (e) => {
    if (e.name !== TOOL) return;
    if (e.status === "ready") shown = false;
    if (shown || (e.status !== "missing" && e.status !== "misconfigured")) return;
    shown = true;
    notifications().notify({
      group: "sonarlint",
      level: "warning",
      title: "SonarQube for IDE can't analyze code",
      body: e.message ?? undefined,
      key: "sonarlint.engine",
      actions: [
        { label: "Download Engine", run: () => void installEngine().then(() => refreshStatus()) },
        { label: "Settings…", run: () => void executeAction("file.settings", SETTINGS_PAGE) },
      ],
    });
  });
}

export function activate(): () => void {
  const disposers = [
    activateSettingsPages(),
    registerOverlay({ id: "sonarlint.rule", component: RuleOverlay }),
    registerCodeActionCommand("SonarLint.DeactivateRule", ([key]) => {
      if (typeof key === "string") return deactivateRule(key);
    }),
    onIdeEvent("sonarRuleDescription", (e) => showRule(e.rule)),
    // A Sonar issue's ⋮ menu: its rule's description (IDEA's inspection description).
    registerProblemActions((problem) =>
      problem.server === TOOL && problem.code
        ? [
            {
              id: "sonarlint.ruleDescription",
              label: "Show Rule Description",
              icon: "info",
              run: () => showRuleByKey(problem.code!),
            },
          ]
        : [],
    ),
    watchEngine(),
    registerActions([
      {
        id: "sonarlint.settings",
        title: "SonarQube for IDE Settings…",
        category: "Tools",
        icon: "toolwindow-inspection",
        keywords: KEYWORDS,
        run: () => void executeAction("file.settings", SETTINGS_PAGE),
      },
    ]),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
