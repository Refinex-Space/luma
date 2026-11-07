/**
 * The Spring tool window's model (IDEA's Spring tool window, Beans tab): the beans of the
 * selected application context grouped by stereotype, filtered by the view options and the
 * filter text. Pure.
 */
import type { BeanKind, SpringBeanInfo, SpringEdgeKind } from "@/platform/ipc";

export interface ExplorerOptions {
  /** IDEA's Show From Libraries (auto-configured beans, yellow). */
  libraries: boolean;
  /** Show From Tests (beans of test sources, green). */
  tests: boolean;
  /** Show Implicit Beans (the framework's own: `applicationContext`, `environment`…). */
  implicit: boolean;
}

export const DEFAULT_OPTIONS: ExplorerOptions = { libraries: false, tests: true, implicit: false };

export type GroupId = BeanKind;

export interface GroupNode {
  kind: "group";
  id: GroupId;
  label: string;
  icon: string;
  beans: BeanNode[];
}

export interface BeanNode {
  kind: "bean";
  bean: SpringBeanInfo;
}

export type ExplorerNode = GroupNode | BeanNode;

/** Groups in order, with their labels and icons. */
export const GROUPS: ReadonlyArray<{ id: GroupId; label: string; icon: string }> = [
  { id: "configuration", label: "Configurations", icon: "settings" },
  { id: "controller", label: "Controllers", icon: "web" },
  { id: "service", label: "Services", icon: "spring-bean" },
  { id: "repository", label: "Repositories", icon: "database" },
  { id: "component", label: "Components", icon: "spring-bean" },
  { id: "factory", label: "@Bean Methods", icon: "spring-bean" },
  { id: "provided", label: "Repositories and Clients", icon: "plugin" },
  { id: "library", label: "Auto-configuration", icon: "library" },
  { id: "framework", label: "Implicit Beans", icon: "spring" },
];

/** Beans show the Spring bean icon; the groups tell their stereotype. */
export const BEAN_ICON = "spring-bean";

export function visible(b: SpringBeanInfo, o: ExplorerOptions): boolean {
  if (b.source === "library" && !o.libraries) return false;
  if (b.source === "framework" && !o.implicit) return false;
  if (b.test && !o.tests) return false;
  return true;
}

/** Bean name, its aliases, its type and declaration contain every word of `filter`. */
export function matches(b: SpringBeanInfo, filter: string): boolean {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [b.name, ...b.aliases, b.typeName, b.typeFqn, b.declaration].join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** The groups of `beans` (empty groups left out), beans by name within. */
export function groupBeans(beans: readonly SpringBeanInfo[], o: ExplorerOptions, filter = ""): GroupNode[] {
  const by = new Map<GroupId, BeanNode[]>();
  for (const b of beans) {
    if (!visible(b, o) || !matches(b, filter)) continue;
    let list = by.get(b.kind);
    if (!list) by.set(b.kind, (list = []));
    list.push({ kind: "bean", bean: b });
  }
  return GROUPS.filter((g) => by.has(g.id)).map((g) => ({
    kind: "group",
    id: g.id,
    label: g.label,
    icon: g.icon,
    beans: by.get(g.id)!.sort((a, b) => a.bean.name.localeCompare(b.bean.name)),
  }));
}

export const nodeKey = (n: ExplorerNode): string => (n.kind === "group" ? `group:${n.id}` : `bean:${n.bean.id}`);

/** IDEA's diagram edge labels. */
export const EDGE_LABELS: Record<SpringEdgeKind, string> = {
  autowired: "@Autowired",
  resource: "@Resource",
  inject: "@Inject",
  beanParam: "@Bean",
  creates: "creates",
  dependsOn: "depends on",
};

/** The row's tone: library beans yellow, test beans green, conditional ones dimmed. */
export function beanTone(b: SpringBeanInfo): "library" | "test" | "default" {
  return b.source === "library" ? "library" : b.test ? "test" : "default";
}
