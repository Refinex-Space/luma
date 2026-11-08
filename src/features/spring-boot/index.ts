/**
 * Spring Boot, shipped as a bundled plugin that is on by default (IDEA's Spring Boot plugin):
 * completion, documentation, navigation and inspections of `application.properties` /
 * `application.yml` against the configuration metadata of each Boot module (dependency jars,
 * the annotation processor's output, and `@ConfigurationProperties` sources — no processor
 * needed). Active for files of modules whose class path has Spring Boot.
 *
 * Settings: `springBoot.*` (Languages & Frameworks › Spring › Spring Boot).
 */
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { springBootPrefs, useSpringBootPrefs } from "@/platform/springBootSettings";
import { lazyComponent } from "@/ui";
import { registerEditorContribution } from "@/editor/api";
import { registerLineMarkerSource } from "@/editor/navigation/implementationGutter";
import {
  registerBundledPlugin,
  registerRunConfigOption,
  registerSessionView,
  registerSettingsPage,
} from "@/workbench/contributions";
import { addJvmLaunchHook } from "@/platform/javaLaunch";
import { liveHook, trackLiveSessions } from "./live/launch";
import { SPRING_BOOT_OPTIONS } from "@/features/run/jvmTypes";
import type { RunConfig } from "@/platform/ipc";
import { configEditorExtension } from "./config/editor";
import { additionalMetadataExtension, registrationEditorExtension } from "./imports";
import { bootMarkers, javaEditorExtension } from "./java";
import { forgetBootStatus } from "./status";

export const SETTINGS_PAGE = "languages.spring.boot";

const KEYWORDS = [
  "spring boot",
  "application.properties",
  "application.yml",
  "configuration properties",
  "metadata",
  "actuator",
  "profile",
  "spring.config.name",
];

const BUILD_FILE = /(^|[\\/])(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$/;

async function setEnabled(on: boolean) {
  if (springBootPrefs().enabled === on) return;
  if (!isTauri()) {
    const settings = useProject.getState().settings;
    if (settings)
      useProject.setState({ settings: { ...settings, springBoot: { ...settings.springBoot, enabled: on } } });
    return;
  }
  useProject.setState({
    settings: await call(commands.settingsSet("global", "springBoot.enabled", JSON.stringify(on))),
  });
}

function registerPlugin(): () => void {
  return registerBundledPlugin({
    id: "springBoot",
    name: "Spring Boot",
    description:
      "Understands Spring Boot applications: configuration files with completion, documentation and checks from the configuration metadata, Boot run configurations and the Actuator views of running applications.",
    icon: "spring",
    features: [
      "Completion of keys and values in application.properties and application.yml, nested YAML keys merged into the mappings already there",
      "Configuration metadata of dependencies, the annotation processor's output and @ConfigurationProperties sources (no annotation processor needed)",
      "Quick Documentation of keys and values: type, default value, description, deprecation and replacement",
      "Navigation from values, profiles, imports and ${…} placeholders",
      "Inspections with quick fixes: unknown, deprecated and duplicate keys, values the binder cannot convert, profile-specific properties, spring.config.import locations",
      "Define configuration key: unknown keys added to additional-spring-configuration-metadata.json",
    ],
    settingsPage: SETTINGS_PAGE,
    useEnabled: () => useSpringBootPrefs().enabled,
    setEnabled,
  });
}

function registerPage(): () => void {
  return registerSettingsPage({
    id: SETTINGS_PAGE,
    title: "Spring Boot",
    group: "Languages & Frameworks",
    order: 395,
    keywords: KEYWORDS,
    component: lazyComponent(() => import("./SpringBootSettingsPage").then((m) => m.SpringBootSettingsPage)),
  });
}

/** The Settings window: the plugin entry and Languages & Frameworks › Spring › Spring Boot. */
export function activateSettingsPages(): () => void {
  const disposers = [registerPlugin(), registerPage()];
  return () => disposers.reverse().forEach((d) => d());
}

/** Spring Boot launches: the Spring Boot type, Maven `spring-boot:run`, Gradle `bootRun`. */
function launchesBoot(config: RunConfig): boolean {
  if (config.kind === "spring-boot") return true;
  const tasks = (config.params?.tasks ?? config.args.join(" ")).split(/\s+/);
  if (config.kind === "maven")
    return tasks.some((g) => g === "spring-boot:run" || /:spring-boot-maven-plugin:[^:]*:run$/.test(g));
  if (config.kind === "gradle") return tasks.some((t) => /(^|:)bootRun$/.test(t));
  return false;
}

/** Modify options › Spring Boot (IDEA's Spring section of the Spring Boot configuration). */
function registerRunOptions(): () => void {
  const disposers = [
    registerRunConfigOption({
      id: "springBoot.debugOutput",
      label: "Enable debug output",
      group: "Spring Boot",
      param: SPRING_BOOT_OPTIONS.debug,
      applies: launchesBoot,
    }),
    registerRunConfigOption({
      id: "springBoot.hideBanner",
      label: "Hide banner",
      group: "Spring Boot",
      param: SPRING_BOOT_OPTIONS.hideBanner,
      applies: launchesBoot,
    }),
    registerRunConfigOption({
      id: "springBoot.disableJmx",
      label: "Disable JMX endpoints",
      group: "Spring Boot",
      param: SPRING_BOOT_OPTIONS.noJmx,
      applies: (c) => c.kind === "spring-boot",
    }),
    registerRunConfigOption({
      id: "springBoot.disableLaunchOptimization",
      label: "Disable launch optimization",
      group: "Spring Boot",
      param: SPRING_BOOT_OPTIONS.noOptimization,
      applies: (c) => c.kind === "spring-boot",
    }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}

/** Editor support while the plugin is on. */
/** The Actuator views of running applications (and the launch hook that enables them). */
function registerLive(): () => void {
  const view = (id: string, title: string, name: "BeansView" | "HealthView" | "MappingsView" | "EnvironmentView") =>
    registerSessionView({
      id,
      title,
      component: lazyComponent(() => import("./live/LiveViews").then((m) => m[name])),
    });
  const disposers = [
    addJvmLaunchHook(liveHook),
    trackLiveSessions(),
    view("springBoot.beans", "Beans", "BeansView"),
    view("springBoot.health", "Health", "HealthView"),
    view("springBoot.mappings", "Mappings", "MappingsView"),
    view("springBoot.environment", "Environment", "EnvironmentView"),
  ];
  return () => disposers.reverse().forEach((d) => d());
}

function registerSupport(): () => void {
  const disposers = [
    registerRunOptions(),
    registerLive(),
    registerEditorContribution({ id: "spring-boot-config", extensions: configEditorExtension }),
    registerEditorContribution({ id: "spring-boot-java", extensions: javaEditorExtension }),
    registerEditorContribution({ id: "spring-boot-registrations", extensions: registrationEditorExtension }),
    registerEditorContribution({ id: "spring-boot-additional-metadata", extensions: additionalMetadataExtension }),
    registerLineMarkerSource({
      id: "spring-boot",
      groups: ["springBootConfig", "springBootRegistration"],
      applies: (ctx) => ctx.language === "java" && !ctx.virtual,
      markers: bootMarkers,
    }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}

export function activate(): () => void {
  let off: (() => void) | null = null;
  const sync = () => {
    const on = springBootPrefs().enabled;
    if (on && !off) off = registerSupport();
    else if (!on && off) {
      off();
      off = null;
    }
  };
  sync();
  const disposers = [
    registerPlugin(),
    registerPage(),
    useProject.subscribe((s, prev) => {
      if (s.settings?.springBoot !== prev.settings?.springBoot || s.project?.root !== prev.project?.root) {
        forgetBootStatus();
        sync();
      }
    }),
    onIdeEvent("fsChanged", (e) => {
      if ([...e.created, ...e.modified, ...e.removed].some((p) => BUILD_FILE.test(String(p)))) forgetBootStatus();
    }),
  ];
  return () => {
    off?.();
    off = null;
    disposers.reverse().forEach((d) => d());
  };
}
