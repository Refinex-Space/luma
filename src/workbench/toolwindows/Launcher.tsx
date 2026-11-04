/**
 * The status bar's bottom area launcher: the bottom areas' windows as icons at the bar's start,
 * each with the window's state at a glance (Problems' count, a run in progress, a debuggee
 * paused). It is the bottom area's switcher: an icon opens its window alone (the area shows no
 * sibling tabs), the open one stays pressed, and clicking it again closes the area.
 */
import { useMemo } from "react";
import clsx from "clsx";
import { shortcutLabel } from "@/platform/keymap";
import { tx } from "@/platform/i18n";
import { BarButton, Icon, showContextMenu } from "@/ui";
import type { ToolWindowBadge, ToolWindowContribution } from "../contributions";
import { areaTabs, moveToMenu } from "./AreaTabs";
import { useToolWindows } from "./ToolWindows";
import { hideToolWindow, removeFromStripe, showToolWindow, useToolWindowLayout } from "./store";
import styles from "./ToolWindows.module.css";

export const LAUNCHER_ID = "toolwindow.launcher";

const noBadge = (): ToolWindowBadge | null => null;

function LauncherButton({ tw }: { tw: ToolWindowContribution }) {
  const useBadge = tw.useBadge ?? noBadge;
  const badge = useBadge();
  const shown = useToolWindowLayout((s) => s.visible.bottom === tw.id || s.visible["bottom-split"] === tw.id);
  const title = tx(tw.title);
  const label = badge?.label ?? (badge?.count ? `${title} ${badge.count}` : title);
  return (
    <BarButton
      className={styles.launcherButton}
      aria-label={label}
      aria-pressed={shown}
      tooltip={tw.title}
      shortcut={shortcutLabel(`toolwindow.${tw.id}`)}
      onClick={() => (shown ? hideToolWindow(tw.id) : showToolWindow(tw.id, true))}
      onContextMenu={(e) => {
        e.preventDefault();
        showContextMenu(e, [{ label: "Remove from Panel", run: () => removeFromStripe(tw.id) }, moveToMenu(tw)]);
      }}
    >
      <Icon name={tw.icon} size={16} />
      {badge?.count != null && (
        <span className={clsx(styles.launcherCount, badge.tone === "error" && styles.launcherError)}>
          {badge.count}
        </span>
      )}
      {badge?.count == null && badge?.tone && (
        <span
          className={clsx(styles.launcherDot, badge.tone === "paused" ? styles.launcherPaused : styles.launcherRunning)}
        />
      )}
    </BarButton>
  );
}

export function ToolWindowLauncher() {
  const windows = useToolWindows();
  const buttons = useToolWindowLayout((s) => s.stripeButtons);
  const tools = useMemo(
    () => [...areaTabs(windows, "bottom", null, buttons), ...areaTabs(windows, "bottom-split", null, buttons)],
    [windows, buttons],
  );
  if (!tools.length) return null;
  return (
    <div className={styles.launcher} role="toolbar" aria-label={tx("Bottom tool windows")}>
      {tools.map((tw) => (
        <LauncherButton key={tw.id} tw={tw} />
      ))}
    </div>
  );
}
