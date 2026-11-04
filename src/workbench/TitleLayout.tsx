/**
 * Title bar layout controls: the side panel toggles, the agent panel's toggle, the layout menu and the find-in-files field centred on the window. They
 * replace the tool window stripes as the way to open and close areas.
 */
import { useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands, isTauri } from "@/platform/ipc";
import { shortcutLabel } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { Icon, IconButton, Menu, type MenuItem } from "@/ui";
import type { ToolWindowAnchor } from "./contributions";
import { useToolWindows } from "./toolwindows/ToolWindows";
import { hideToolWindow, showToolWindow, useToolWindowLayout } from "./toolwindows/store";
import styles from "./TitleBar.module.css";

const SIDE_ACTION: Record<ToolWindowAnchor, string> = {
  left: "toolwindow.toggleLeftSide",
  bottom: "toolwindow.toggleBottomSide",
  right: "toolwindow.toggleRightSide",
};

/**
 * Opens or closes a side's tool windows. The drawing tells the state, so the button keeps no
 * selected background (that shows on hover alone): open, the panel's own edge is drawn solid;
 * closed, the far edge is (the left toggle's matches the agent panel's docked drawing).
 * `tool` sizes it like the title bar's other tool buttons; otherwise it matches the layout group.
 */
export function PanelToggle({ side, tool = false }: { side: ToolWindowAnchor; tool?: boolean }) {
  const shown = useToolWindowLayout((s) => !!(s.visible[side] || s.visible[`${side}-split`]));
  const compact = useProject((s) => s.settings?.appearance?.compactMode === true);
  return (
    <IconButton
      icon={shown ? `panel-${side}` : `panel-${side}-off`}
      action={SIDE_ACTION[side]}
      pressed={shown}
      iconSize={tool && !compact ? 18 : 16}
      className={clsx(styles.panelToggle, tool ? styles.tool : styles.panelToggleGroup)}
    />
  );
}

/**
 * The agent panel (the window asking for a panel control) on and off: one click opens it beside
 * the editor, the next closes it. Drawn like the side toggles. (Growing it is the window's own
 * Maximize, in its ⋮ menu and on its shortcut.)
 */
export function AgentPanelToggle() {
  const tw = useToolWindows().find((w) => w.panelControl);
  const shown = useToolWindowLayout((s) => {
    if (!tw) return false;
    const slot = tw.secondary ? (`${tw.anchor}-split` as const) : tw.anchor;
    return s.visible[slot] === tw.id;
  });
  if (!tw) return null;
  return (
    <IconButton
      icon={shown ? `panel-${tw.anchor}` : `panel-${tw.anchor}-off`}
      title={tw.title}
      shortcut={shortcutLabel(`toolwindow.${tw.id}`)}
      pressed={shown}
      iconSize={16}
      className={clsx(styles.panelToggle, styles.panelToggleGroup)}
      onClick={() => (shown ? hideToolWindow(tw.id) : showToolWindow(tw.id, true))}
    />
  );
}

async function toggleWidescreen() {
  const on = useProject.getState().settings?.appearance?.widescreenToolWindows === true;
  if (!isTauri()) return;
  const settings = await call(commands.settingsSet("global", "appearance.widescreenToolWindows", JSON.stringify(!on)));
  useProject.setState({ settings });
}

/** Panels, saved layouts, widescreen: everything about the window's arrangement in one menu. */
export function LayoutMenuButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const widescreen = useProject((s) => s.settings?.appearance?.widescreenToolWindows === true);
  const items: MenuItem[] = [
    { kind: "action", action: SIDE_ACTION.left },
    { kind: "action", action: SIDE_ACTION.bottom },
    { kind: "action", action: SIDE_ACTION.right },
    { kind: "separator" },
    { kind: "action", action: "toolwindow.hideAll" },
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
        icon="more"
        title="Layout"
        size="small"
        iconSize={16}
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
