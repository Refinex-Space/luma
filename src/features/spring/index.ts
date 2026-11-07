/**
 * Spring, shipped as a bundled plugin that is on by default (IDEA's Spring plugin): a model of
 * the project's beans, application contexts and autowiring, built from the structure index
 * (`ide_index::java::spring`), with gutter navigation between beans and injection points.
 * Active in projects whose build declares Spring (or whose sources import it).
 *
 * Settings: `spring.{enabled, activeProfiles}` (Languages & Frameworks › Spring).
 */
import { registerLineMarkerSource } from "@/editor/navigation/implementationGutter";
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { springPrefs, useSpringPrefs } from "@/platform/springSettings";
import { lazyComponent, type MenuItem } from "@/ui";
import { setExplorerOptions, useSpringExplorer } from "./explorer/store";
import {
  registerBeanSearch,
  registerBundledPlugin,
  registerEditorKind,
  registerSettingsPage,
  registerStatusItem,
  registerToolWindow,
} from "@/workbench/contributions";
import { springBeanSearch } from "./explorer/search";
import { GRAPH_KIND, type GraphInput } from "./explorer/open";
import { springMarkers } from "./gutter";
import { registerInspections } from "./inspections";
import { onSpringStatus, refreshSpringStatus, springStatus } from "./status";

export const SETTINGS_PAGE = "languages.spring";

/** The Spring tool window's view options, without loading the window's code first. */
function useHeaderMenu(): MenuItem[] {
  const options = useSpringExplorer((s) => s.options);
  return [
    {
      label: "Show From Libraries",
      checked: options.libraries,
      run: () => setExplorerOptions({ libraries: !options.libraries }),
    },
    { label: "Show From Tests", checked: options.tests, run: () => setExplorerOptions({ tests: !options.tests }) },
    {
      label: "Show Implicit Beans",
      checked: options.implicit,
      run: () => setExplorerOptions({ implicit: !options.implicit }),
    },
  ];
}

const KEYWORDS = [
  "spring",
  "bean",
  "autowired",
  "inject",
  "profile",
  "component",
  "configuration",
  "qualifier",
  "event",
  "scheduled",
  "cache",
];

const BUILD_FILE = /(^|[\\/])(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$/;

async function setEnabled(on: boolean) {
  if (springPrefs().enabled === on) return;
  if (!isTauri()) {
    const settings = useProject.getState().settings;
    if (settings) useProject.setState({ settings: { ...settings, spring: { ...settings.spring, enabled: on } } });
    return;
  }
  useProject.setState({ settings: await call(commands.settingsSet("global", "spring.enabled", JSON.stringify(on))) });
}

function registerPlugin(): () => void {
  return registerBundledPlugin({
    id: "spring",
    name: "Spring",
    description:
      "Understands the Spring Framework: beans, application contexts and autowiring, with navigation between beans and the places they are injected.",
    icon: "spring",
    features: [
      "Gutter navigation from injection points to their beans, and from beans to where they are injected",
      "Spring's autowiring rules: generics, qualifiers, @Primary, @Fallback, @Priority, profiles",
      "Boot applications and @ComponentScan configurations as application contexts",
      "Spring Data repositories, MyBatis mappers and OpenFeign clients as beans",
      "Auto-configured beans of the libraries, opened from their class files",
      "Navigation between event listeners and publishers, cache operations with the same names, test classes and their application context",
      "Spring Core inspections with quick fixes: autowiring, field injection, @Scheduled, @Async, @EventListener, caching, @Profile",
      "The Spring tool window: each application context's beans, their details and the Bean dependency graph",
      "Spring Expression Language in @Value, @Cacheable, @EventListener and other annotations: highlighting, completion, navigation and checks",
    ],
    settingsPage: SETTINGS_PAGE,
    useEnabled: () => useSpringPrefs().enabled,
    setEnabled,
  });
}

function registerPage(): () => void {
  return registerSettingsPage({
    id: SETTINGS_PAGE,
    title: "Spring",
    group: "Languages & Frameworks",
    order: 394,
    keywords: KEYWORDS,
    component: lazyComponent(() => import("./SpringSettingsPage").then((m) => m.SpringSettingsPage)),
  });
}

/** The Settings window: the plugin entry and Languages & Frameworks › Spring. */
export function activateSettingsPages(): () => void {
  const disposers = [registerPlugin(), registerPage()];
  return () => disposers.reverse().forEach((d) => d());
}

/** Editor support while the plugin is on and the project uses Spring. */
function registerSupport(): () => void {
  const changed = new Set<() => void>();
  const offSettings = useProject.subscribe((s, prev) => {
    if (s.settings?.spring !== prev.settings?.spring) changed.forEach((l) => l());
  });
  // Library beans arrived (or changed): ask the open editors again.
  const offModel = onIdeEvent("springModelChanged", () => changed.forEach((l) => l()));
  const offSource = registerLineMarkerSource({
    id: "spring",
    groups: ["spring", "springEvents", "springScheduled", "springCache", "springTest"],
    applies: (ctx) => ctx.language === "java" && !ctx.virtual,
    markers: springMarkers,
    onChange: (listener) => {
      changed.add(listener);
      return () => changed.delete(listener);
    },
  });
  const offInspections = registerInspections();
  const offWindow = registerToolWindow({
    id: "spring",
    title: "Spring",
    icon: "spring",
    anchor: "left",
    stripe: "onUse",
    order: 40,
    component: lazyComponent(() => import("./explorer/SpringExplorer").then((m) => m.SpringExplorer)),
    headerActions: lazyComponent(() => import("./explorer/SpringExplorer").then((m) => m.SpringHeaderActions)),
    headerMenu: useHeaderMenu,
    headerMenuInTitle: false,
  });
  const offGraph = registerEditorKind({
    kind: GRAPH_KIND,
    component: lazyComponent(() => import("./explorer/BeanGraph").then((m) => m.SpringGraphEditor)),
    title: (input) => (input.data as GraphInput).title,
    icon: () => "md-diagram",
    restorable: true,
  });
  const offSearch = registerBeanSearch(springBeanSearch);
  const offStatus = registerStatusItem({
    id: "spring.profiles",
    align: "right",
    priority: 8,
    title: "Spring Profiles",
    component: lazyComponent(() => import("./ProfilesStatus").then((m) => m.ProfilesStatus)),
  });
  return () => {
    offStatus();
    offSearch();
    offGraph();
    offWindow();
    offInspections();
    offSource();
    offSettings();
    offModel();
  };
}

export function activate(): () => void {
  let off: (() => void) | null = null;
  let root: string | null | undefined;
  const sync = () => {
    const on = springPrefs().enabled && springStatus()?.active === true;
    if (on && !off) off = registerSupport();
    else if (!on && off) {
      off();
      off = null;
    }
  };
  const check = () => {
    const next = useProject.getState().project?.root ?? null;
    if (next !== root) {
      root = next;
      void refreshSpringStatus().then(sync);
    }
    sync();
  };
  check();
  const disposers = [
    registerPlugin(),
    registerPage(),
    useProject.subscribe(check),
    onSpringStatus(sync),
    // The build declares Spring later (a new dependency, a first sync).
    onIdeEvent("fsChanged", (e) => {
      if ([...e.created, ...e.modified, ...e.removed].some((p) => BUILD_FILE.test(String(p))))
        void refreshSpringStatus();
    }),
  ];
  return () => {
    off?.();
    off = null;
    disposers.reverse().forEach((d) => d());
  };
}
