/**
 * The status bar's bottom area launcher: the bottom areas' tabs as icons at the bar's start,
 * each with the window's state at a glance (Problems' count, a run in progress, a
 * debuggee paused). While the bottom area is open its own tab strip takes over, so the
 * launcher folds away.
 */
import { useMemo } from "react";
import clsx from "clsx";
import { shortcutLabel } from "@/platform/keymap";
import { tx } from "@/platform/i18n";
import { Icon, showContextMenu, tooltipAttrs } from "@/ui";
import type { ToolWindowBadge, ToolWindowContribution } from "../contributions";
import { areaTabs, moveToMenu } from "./AreaTabs";
import { useToolWindows } from "./ToolWindows";
import { removeFromStripe, showToolWindow, useToolWindowLayout } from "./store";
import styles from "./ToolWindows.module.css";

export const LAUNCHER_ID = "toolwindow.launcher";

const noBadge = (): ToolWindowBadge | null => null;

function LauncherButton({ tw }: { tw: ToolWindowContribution }) {
  const useBadge = tw.useBadge ?? noBadge;
  const badge = useBadge();
  const title = tx(tw.title);
  const label = badge?.label ?? (badge?.count ? `${title} ${badge.count}` : title);
  return (
    <button
      type="button"
      className={styles.launcherButton}
      aria-label={label}
      {...tooltipAttrs(tw.title, shortcutLabel(`toolwindow.${tw.id}`))}
      onClick={() => showToolWindow(tw.id, true)}
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
    </button>
  );
}

export function ToolWindowLauncher() {
  const windows = useToolWindows();
  const buttons = useToolWindowLayout((s) => s.stripeButtons);
  // Maximizing another side only grows that side: an open bottom area stays on screen.
  const open = useToolWindowLayout((s) => !!(s.visible.bottom || s.visible["bottom-split"]));
  const tools = useMemo(
    () => [...areaTabs(windows, "bottom", null, buttons), ...areaTabs(windows, "bottom-split", null, buttons)],
    [windows, buttons],
  );
  if (!tools.length) return null;
  return (
    <div
      className={styles.launcher}
      data-hidden={open ? "" : undefined}
      inert={open}
      role="toolbar"
      aria-label={tx("Bottom tool windows")}
    >
      {tools.map((tw) => (
        <LauncherButton key={tw.id} tw={tw} />
      ))}
    </div>
  );
}
