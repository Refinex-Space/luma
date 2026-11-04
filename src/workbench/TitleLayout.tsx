/**
 * Title bar layout controls: the side panel toggles, the agent panel's hidden / docked /
 * maximized control, the layout menu and the find-in-files field centred on the window. They
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
import {
  anchorOf,
  hideToolWindow,
  showToolWindow,
  toggleMaximizeToolWindow,
  useToolWindowLayout,
} from "./toolwindows/store";
import styles from "./TitleBar.module.css";

const SIDE_ACTION: Record<ToolWindowAnchor, string> = {
  left: "toolwindow.toggleLeftSide",
  bottom: "toolwindow.toggleBottomSide",
  right: "toolwindow.toggleRightSide",
};

/** Opens or closes a side's tool windows; pressed while the side shows something. */
export function PanelToggle({ side }: { side: ToolWindowAnchor }) {
  const shown = useToolWindowLayout((s) => !!(s.visible[side] || s.visible[`${side}-split`]));
  return (
    <IconButton
      icon={`panel-${side}`}
      action={SIDE_ACTION[side]}
      pressed={shown}
      size="small"
      iconSize={16}
      className={styles.panelToggle}
    />
  );
}

type PanelState = "hidden" | "docked" | "focus";

/** The window asking for a panel control (the agent panel): shown, maximized, or neither. */
function usePanelWindow() {
  const tw = useToolWindows().find((w) => w.panelControl);
  const state = useToolWindowLayout((s): PanelState => {
    if (!tw) return "hidden";
    const slot = tw.secondary ? (`${tw.anchor}-split` as const) : tw.anchor;
    if (s.visible[slot] !== tw.id) return "hidden";
    return s.maximized === tw.anchor ? "focus" : "docked";
  });
  return { tw, state };
}

function setPanelState(id: string, from: PanelState, to: PanelState) {
  if (to === from) return;
  if (to === "hidden") return hideToolWindow(id);
  if (from === "hidden") showToolWindow(id, true);
  // Maximized or not: the side's maximize toggle, so the other areas come back as they were.
  const maximized = useToolWindowLayout.getState().maximized === anchorOf(id);
  if ((to === "focus") !== maximized) toggleMaximizeToolWindow(id);
}

/** Three drawings of the window share the panel takes: none, a side, most of the window. */
export function AgentPanelControl() {
  const { tw, state } = usePanelWindow();
  if (!tw) return null;
  const title = tx(tw.title);
  const option = (value: PanelState, icon: string, label: string, action?: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={state === value}
      className={styles.segButton}
      aria-label={label}
      data-tooltip={label + (action && shortcutLabel(action) ? ` ${shortcutLabel(action)}` : "")}
      onClick={() => setPanelState(tw.id, state, value)}
    >
      <Icon name={icon} size={16} />
    </button>
  );
  return (
    <div className={styles.seg} role="radiogroup" aria-label={tx`${title} panel`}>
      {option("hidden", "agent-panel-hidden", tx("Editor Only"))}
      {option("docked", "agent-panel-docked", tx`Editor and ${title}`)}
      {option("focus", "agent-panel-focus", tx`${title} First`, "toolwindow.maximize")}
    </div>
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
