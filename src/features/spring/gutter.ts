/**
 * Spring gutter markers (IDEA's `SpringAutowiredAnnotator`, `SpringBeanAnnotator`,
 * `SpringEventListenerAnnotator`, `SpringScheduledTasksLineMarker`, `SpringCacheableAnnotator`
 * and `SpringTestConfigurationAnnotator`): injection points and their beans, beans and where
 * they are injected, event listeners and publishers, scheduled tasks, cache operations sharing
 * a cache name, test classes and their application context. Computed by the Spring model of
 * the structure index (`spring_markers`), shown in the line marker gutter.
 */
import type { EditorDocContext } from "@/editor/api";
import type { LineMarker, MarkerKind } from "@/editor/navigation/lineMarkers";
import { navigateTo, pinToFind } from "@/editor/lsp/navigation";
import { openPopup, type ListPopupItem } from "@/editor/lsp/popupStore";
import { executeAction } from "@/platform/actions";
import { call, commands, isTauri, type SpringMarker, type SpringTarget } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { toolWindowService } from "@/workbench/contributions";
import { openGraph } from "./explorer/open";
import { revealBean } from "./explorer/store";

/** Opens a target: a source location, or a library bean located by the language server first. */
export async function openTarget(t: SpringTarget, doc: number) {
  if (!t.handle) return navigateTo(t.location);
  const location = isTauri() ? await call(commands.springLocate(doc, t.handle)).catch(() => null) : null;
  if (location) return navigateTo(location);
  void executeAction("editor.showHint", {
    text: tx`Cannot open ${t.owner}: the Java language server does not know it`,
  });
}

/** At most this many names in a tooltip, then "…". */
const TOOLTIP_NAMES = 3;

function nameList(names: readonly string[]): string {
  const unique = [...new Set(names)];
  return unique.length > TOOLTIP_NAMES ? `${unique.slice(0, TOOLTIP_NAMES).join(", ")}, …` : unique.join(", ");
}

function relLine(t: SpringTarget): string {
  const file = t.location.path.slice(t.location.path.lastIndexOf("/") + 1);
  return `${file}:${t.location.range.start.line + 1}`;
}

/** A chooser row: the bean with its type (or the injection point), and its module when there are several. */
export function targetItem(t: SpringTarget, i: number, bean: boolean, doc = -1): ListPopupItem {
  const marks = [t.primary ? "★" : null, t.fallback ? "↓" : null, t.presence !== "certain" ? "◌" : null].filter(
    Boolean,
  );
  const detail = bean ? [t.owner, t.module].filter(Boolean).join(" · ") : (t.module ?? relLine(t));
  return {
    id: `${i}`,
    label: marks.length ? `${t.label} ${marks.join(" ")}` : t.label,
    detail,
    icon: bean ? "gutter-spring-bean" : "gutter-spring-injection",
    run: () => openTarget(t, doc),
  };
}

/** The injected one first: primary, then certain beans, then conditional ones; by name within. */
export function byRelevance(a: SpringTarget, b: SpringTarget): number {
  const rank = (t: SpringTarget) => (t.primary ? 0 : t.presence === "certain" ? (t.fallback ? 2 : 1) : 3);
  return rank(a) - rank(b) || a.label.localeCompare(b.label);
}

function open(m: SpringMarker, doc: number, title: string, anchor: { x: number; y: number }) {
  if (m.targets.length === 1) return openTarget(m.targets[0]!, doc);
  const bean = m.kind === "injection";
  const targets = bean ? [...m.targets].sort(byRelevance) : m.targets;
  // Library beans have no source location to list in the Find tool window.
  const sources = m.targets.filter((t) => !t.handle).map((t) => t.location);
  openPopup({
    kind: "list",
    anchor,
    title,
    items: targets.map((t, i) => targetItem(t, i, bean, doc)),
    pin: sources.length ? pinToFind(m.name, sources) : undefined,
  });
}

/**
 * IDEA's bean gutter menu: where the bean is injected, then Select in Spring Tool Window and
 * the Bean dependency graph.
 */
function beanMenu(m: SpringMarker, doc: number, title: string, anchor: { x: number; y: number }) {
  const bean = m.bean;
  const actions: ListPopupItem[] = bean
    ? [
        {
          id: "select",
          label: tx("Select in Spring Tool Window"),
          icon: "spring",
          run: () => {
            toolWindowService().show("spring", true);
            void revealBean(bean, m.context);
          },
        },
        {
          id: "graph",
          label: tx("Show Bean Dependencies Diagram"),
          icon: "md-diagram",
          run: () => openGraph({ context: m.context, roots: [bean], depth: 1, title: m.detail ?? m.name }),
        },
      ]
    : [];
  const sources = m.targets.filter((t) => !t.handle).map((t) => t.location);
  openPopup({
    kind: "list",
    anchor,
    title,
    items: [...m.targets.map((t, i) => targetItem(t, i, false, doc)), ...actions],
    pin: sources.length ? pinToFind(m.name, sources) : undefined,
  });
}

/** A chooser row of an event, cache or test configuration marker. */
export function featureItem(t: SpringTarget, i: number, icon: string, doc = -1): ListPopupItem {
  return {
    id: `${i}`,
    label: t.label,
    detail: [t.owner || null, t.module ?? relLine(t)].filter(Boolean).join(" · "),
    icon,
    run: () => openTarget(t, doc),
  };
}

const FEATURES: Partial<
  Record<
    SpringMarker["kind"],
    { kind: MarkerKind; icon: string; tooltip: () => string; empty?: () => string; title: (n: number) => string }
  >
> = {
  eventListener: {
    kind: "springListener",
    icon: "gutter-spring-event-publisher",
    tooltip: () => tx("Go to event publisher"),
    empty: () => tx("No event publishers found"),
    title: (n) => tx`Choose Event Publisher (${n} found)`,
  },
  eventPublisher: {
    kind: "springPublisher",
    icon: "gutter-spring-event-listener",
    tooltip: () => tx("Go to event listener"),
    empty: () => tx("No event listeners found"),
    title: (n) => tx`Choose Event Listener (${n} found)`,
  },
  cacheable: {
    kind: "springCache",
    icon: "gutter-spring-cacheable",
    tooltip: () => tx("Go to cacheable operation with the same name"),
    title: (n) => tx`Choose Cacheable Operation (${n} found)`,
  },
  testContext: {
    kind: "springTest",
    icon: "gutter-spring-test-context",
    tooltip: () => tx("Navigate to Application Context"),
    title: (n) => tx`Choose Application Context (${n} found)`,
  },
};

function featureMarker(m: SpringMarker, doc: number): LineMarker | null {
  const base = { line: m.line, name: m.name, targets: m.targets.filter((t) => !t.handle).map((t) => t.location) };
  if (m.kind === "scheduled") {
    const tooltip = m.detail ? tx`Scheduled: ${m.detail}` : tx("Scheduled task");
    const scheduler = m.targets[0];
    return {
      ...base,
      kind: "springScheduled",
      tooltip,
      chooserTitle: tooltip,
      passive: !scheduler,
      open: scheduler ? () => openTarget(scheduler, doc) : undefined,
    };
  }
  const f = FEATURES[m.kind];
  if (!f) return null;
  const n = m.targets.length;
  const title = f.title(n);
  const empty = n === 0 && f.empty ? f.empty() : null;
  return {
    ...base,
    kind: f.kind,
    tooltip: empty ?? f.tooltip(),
    chooserTitle: title,
    uncertain: n === 0,
    open: (anchor) => {
      if (empty) return void executeAction("editor.showHint", { text: empty });
      if (n === 1) return openTarget(m.targets[0]!, doc);
      const sources = m.targets.filter((t) => !t.handle).map((t) => t.location);
      openPopup({
        kind: "list",
        anchor,
        title,
        items: m.targets.map((t, i) => featureItem(t, i, f.icon, doc)),
        pin: sources.length ? pinToFind(m.name, sources) : undefined,
      });
    },
  };
}

/** The gutter marker of a Spring model marker. */
export function springLineMarker(m: SpringMarker, doc = -1): LineMarker {
  if (m.kind !== "bean" && m.kind !== "injection") {
    const marker = featureMarker(m, doc);
    if (marker) return marker;
  }
  const n = m.targets.length;
  const base = { line: m.line, name: m.name, targets: m.targets.filter((t) => !t.handle).map((t) => t.location) };
  if (m.kind === "bean") {
    const title = n ? tx`Choose Injection Point of ${m.name} (${n} found)` : tx`Spring bean '${m.detail ?? m.name}'`;
    return {
      ...base,
      kind: "bean",
      tooltip: n
        ? tx`Spring bean injected into ${nameList(m.targets.map((t) => t.owner))}`
        : tx`Spring bean '${m.detail ?? m.name}'`,
      chooserTitle: title,
      open: (anchor) => beanMenu(m, doc, title, anchor),
    };
  }
  const names = nameList(m.targets.map((t) => t.label));
  const title = tx`Choose Autowired Candidate (${n} found)`;
  return {
    ...base,
    kind: "injection",
    tooltip: m.resolution === "unique" ? tx`Autowired: ${names}` : tx`Autowired candidates: ${names}`,
    chooserTitle: title,
    uncertain: m.targets.every((t) => t.presence !== "certain"),
    open: (anchor) => open(m, doc, title, anchor),
  };
}

export async function springMarkers(ctx: EditorDocContext): Promise<LineMarker[]> {
  if (!isTauri()) return [];
  const { markers } = await call(commands.springMarkers(ctx.doc));
  return markers.map((m) => springLineMarker(m, ctx.doc));
}
