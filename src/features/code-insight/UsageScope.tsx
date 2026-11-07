/** Where Find Usages looks: Project Files or All Places (IDEA's usages scope), remembered. */
import { create } from "zustand";
import type { UsageSearchScope } from "@/bindings";
import { Icon, showContextMenu } from "@/ui";
import { tx } from "@/platform/i18n";
import styles from "./UsageScope.module.css";

const STORAGE_KEY = "luma.usages.scope.v1";

function load(): UsageSearchScope {
  try {
    return localStorage.getItem(STORAGE_KEY) === "all" ? "all" : "project";
  } catch {
    return "project";
  }
}

export const useUsageScope = create<{ scope: UsageSearchScope }>(() => ({ scope: load() }));

export function setUsageScope(scope: UsageSearchScope) {
  useUsageScope.setState({ scope });
  try {
    localStorage.setItem(STORAGE_KEY, scope);
  } catch {
    // storage unavailable: the choice lasts for the session
  }
}

export const scopeLabel = (scope: UsageSearchScope) => (scope === "project" ? tx("Project Files") : tx("All Places"));

/** The scope as a link-like button opening the choice, e.g. "in Project Files ▾". */
export function UsageScopeSwitch({
  scope,
  onChange,
}: {
  scope: UsageSearchScope;
  onChange: (scope: UsageSearchScope) => void;
}) {
  return (
    <button
      type="button"
      className={styles.switch}
      aria-haspopup="menu"
      aria-label={tx`Scope: ${scopeLabel(scope)}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        showContextMenu(
          { x: r.left, y: r.bottom + 2 },
          (["project", "all"] as const).map((s) => ({
            label: scopeLabel(s),
            checked: s === scope,
            run: () => {
              setUsageScope(s);
              if (s !== scope) onChange(s);
            },
          })),
        );
      }}
    >
      {scopeLabel(scope)}
      <Icon name="chevron-down" size={12} />
    </button>
  );
}
