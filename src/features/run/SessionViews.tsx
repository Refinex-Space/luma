/**
 * Views features add to a Run session beside its console (IDEA's session content tabs,
 * e.g. Spring Boot's Actuator; here Hot Reload's timeline), from the session's mark.
 */
import clsx from "clsx";
import { Icon } from "@/ui";
import { useTx } from "@/platform/i18n";
import {
  selectSessionView,
  useSessionMarks,
  type SessionMark,
  type SessionViewContribution,
} from "@/workbench/contributions";
import styles from "./Run.module.css";

const NO_VIEWS: readonly string[] = [];

/** The mark of session `key`, its views and the one shown (null: the console). */
export function useSessionViews(key: string): {
  mark: SessionMark | undefined;
  views: SessionViewContribution[];
  active: SessionViewContribution | null;
} {
  const mark = useSessionMarks((s) => s.marks[key]);
  const registered = useSessionMarks((s) => s.views);
  const selected = useSessionMarks((s) => s.selected[key]);
  const views = (mark?.views ?? NO_VIEWS).flatMap((id) => {
    const view = registered.get(id);
    return view ? [view] : [];
  });
  return { mark, views, active: views.find((v) => v.id === selected) ?? null };
}

/** Console | <views> above the session's content. */
export function SessionViewTabs({
  sessionKey,
  views,
  active,
}: {
  sessionKey: string;
  views: readonly SessionViewContribution[];
  active: string | null;
}) {
  const tx = useTx();
  const tabs = [{ id: null, title: "Console", icon: undefined as string | undefined }, ...views];
  return (
    <div className={styles.sessionViewTabs} role="tablist" aria-label={tx("Session views")}>
      {tabs.map((t) => (
        <button
          key={t.id ?? "console"}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          className={clsx(styles.sessionViewTab, active === t.id && styles.sessionViewTabActive)}
          onClick={() => selectSessionView(sessionKey, t.id)}
        >
          {t.icon && <Icon name={t.icon} size={14} />}
          {tx(t.title)}
        </button>
      ))}
    </div>
  );
}
