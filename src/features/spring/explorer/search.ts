/**
 * Spring beans in Search Everywhere (Symbols and All): by bean name, alias or type. Enter
 * opens the bean's declaration; ⌥↵ also selects it in the Spring tool window.
 */
import { matchText } from "@/features/search/common/rank";
import { tx } from "@/platform/i18n";
import { call, commands, isTauri, type SpringBeanInfo } from "@/platform/ipc";
import { toolWindowService, type DatabaseSearchItem, type DatabaseSearchProvider } from "@/workbench/contributions";
import { BEAN_ICON } from "./model";
import { openBean, openGraph } from "./open";
import { revealBean } from "./store";

/** Beans are asked again after this long (a search session reuses them). */
const FRESH_MS = 5000;
let cache: { at: number; beans: Promise<SpringBeanInfo[]> } | null = null;

function allBeans(): Promise<SpringBeanInfo[]> {
  if (!cache || performance.now() - cache.at > FRESH_MS) {
    cache = { at: performance.now(), beans: call(commands.springBeans(null)).catch(() => []) };
  }
  return cache.beans;
}

/** The best match of `query` in the bean's name, aliases or type, with indices into the name. */
export function matchBean(b: SpringBeanInfo, query: string): { score: number; indices: number[] } | null {
  const q = query.replace(/^@/, "");
  const byName = matchText(b.name, q, { wordAligned: true });
  if (byName) return byName;
  for (const a of b.aliases) {
    const hit = matchText(a, q, { wordAligned: true });
    if (hit) return { score: hit.score - 50, indices: [] };
  }
  const byType = matchText(b.typeName, q, { wordAligned: true });
  return byType ? { score: byType.score - 100, indices: [] } : null;
}

export function beanItem(b: SpringBeanInfo, hit: { score: number; indices: number[] }): DatabaseSearchItem {
  return {
    key: `spring:${b.id}`,
    name: b.name,
    container: b.typeName,
    source: b.module ?? b.declaration,
    icon: BEAN_ICON,
    indices: hit.indices,
    score: hit.score,
    qualifiedName: b.typeFqn,
    open: () => void openBean(b),
    openLabel: "Jump to Source",
    hint: "⌥↵ for Select in Spring Tool Window and more",
    actions: [
      {
        label: tx("Select in Spring Tool Window"),
        run: () => {
          toolWindowService().show("spring", true);
          void revealBean(b.id, null);
        },
      },
      {
        label: tx("Show Bean Dependencies Diagram"),
        run: () => openGraph({ context: null, roots: [b.id], depth: 1, title: b.name }),
      },
    ],
  };
}

export const springBeanSearch: DatabaseSearchProvider = {
  async search(query, limit, emit) {
    if (!isTauri() || !query.trim()) return emit({ items: [], hasMore: false });
    const seen = new Set<string>();
    const items: DatabaseSearchItem[] = [];
    for (const b of await allBeans()) {
      // A bean of several contexts once.
      if (seen.has(b.id)) continue;
      const hit = matchBean(b, query);
      if (!hit) continue;
      seen.add(b.id);
      items.push(beanItem(b, hit));
    }
    items.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    emit({ items: items.slice(0, limit), hasMore: items.length > limit });
  },
};
