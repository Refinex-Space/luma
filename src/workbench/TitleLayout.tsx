/**
 * Title bar layout controls: the layout menu and the Find in Files field centred on the window.
 * Tool windows open from the tool window bars on the window's edges; whole sides open and close
 * from the layout menu and their shortcuts.
 */
import { useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands, isTauri } from "@/platform/ipc";
import { shortcutLabel } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { Icon, IconButton, Menu, type MenuItem } from "@/ui";
import { setShowToolWindowBars } from "./toolwindows/Stripes";
import styles from "./TitleBar.module.css";

async function toggleWidescreen() {
  const on = useProject.getState().settings?.appearance?.widescreenToolWindows === true;
  if (!isTauri()) return;
  const settings = await call(commands.settingsSet("global", "appearance.widescreenToolWindows", JSON.stringify(!on)));
  useProject.setState({ settings });
}

/** Panels, bars, saved layouts, widescreen: everything about the window's arrangement in one menu. */
export function LayoutMenuButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const appearance = useProject((s) => s.settings?.appearance);
  const widescreen = appearance?.widescreenToolWindows === true;
  const bars = appearance?.showToolWindowBars !== false;
  const iconSize = appearance?.compactMode === true ? 16 : 18;
  const items: MenuItem[] = [
    { kind: "action", action: "toolwindow.toggleLeftSide" },
    { kind: "action", action: "toolwindow.toggleBottomSide" },
    { kind: "action", action: "toolwindow.toggleRightSide" },
    { kind: "separator" },
    { kind: "action", action: "toolwindow.hideAll" },
    {
      id: "layout.bars",
      label: "Show Tool Window Bars",
      checked: bars,
      run: () => void setShowToolWindowBars(!bars),
    },
    {
      id: "layout.widescreen",
      label: "Widescreen tool window layout",
      checked: widescreen,
      run: () => void toggleWidescreen(),
    },
    { kind: "separator" },
    { kind: "action", action: "layout.save" },
    { kind: "action", action: "layout.restore" },
    { kind: "action", action: "layout.restoreDefault" },
  ];
  return (
    <>
      <IconButton
        ref={ref}
        icon="layout"
        title="Layout"
        iconSize={iconSize}
        className={styles.tool}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={ref}
        items={items}
        placement="bottom-end"
        aria-label="Layout"
      />
    </>
  );
}

/**
 * Find in Files, centred on the window. It never overlaps the widgets beside it: when the
 * window's centre leaves it too little room (a wide run widget), it centres in the free gap
 * instead, and below a minimum it gives way to the icon alone.
 */
/** Below this the field leaves the window's centre for the free gap beside it. */
const CENTRED_MIN = 260;

export function FindInFilesField({ bar }: { bar: HTMLElement | null }) {
  const name = useProject((s) => s.project?.name);
  const ref = useRef<HTMLButtonElement>(null);
  const [fit, setFit] = useState<{ width: number; x: number } | null>(null);
  useLayoutEffect(() => {
    const header = bar;
    if (!header) return;
    const fit = () => {
      const box = header.getBoundingClientRect();
      const left = (header.querySelector("[data-title-left-end]")?.getBoundingClientRect().left ?? box.left) + 12;
      const right = (header.querySelector("[data-title-right-start]")?.getBoundingClientRect().right ?? box.right) - 12;
      const centre = box.left + box.width / 2;
      const centred = Math.min(440, 2 * Math.min(centre - left, right - centre));
      const next =
        centred >= CENTRED_MIN
          ? { width: centred, x: box.width / 2 }
          : { width: Math.max(0, Math.min(440, right - left)), x: (left + right) / 2 - box.left };
      setFit((prev) => (prev && prev.width === next.width && prev.x === next.x ? prev : next));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(header);
    header.querySelectorAll("[data-title-item]").forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [bar]);
  const shortcut = shortcutLabel("find.inPath");
  const narrow = fit !== null && fit.width < 180;
  return (
    <button
      ref={ref}
      type="button"
      className={clsx(styles.findField, narrow && styles.findFieldIcon)}
      style={{ width: narrow ? undefined : (fit?.width ?? 320), left: fit ? fit.x : undefined }}
      aria-label={tx("Find in Files")}
      data-tooltip={narrow ? tx("Find in Files") + (shortcut ? ` ${shortcut}` : "") : undefined}
      onClick={() => void executeAction("find.inPath")}
    >
      <Icon name="search" size={14} />
      {!narrow && (
        <>
          <span className={styles.findText}>{name ? tx`Find in ${name}` : tx("Find in Files")}</span>
          {shortcut && <kbd className={styles.findKey}>{shortcut}</kbd>}
        </>
      )}
    </button>
  );
}
