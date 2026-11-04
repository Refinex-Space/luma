/**
 * The tab strip heading each tool window area. The windows docked in an area are its tabs (what
 * the stripes used to list); the shown window's own title menu and content tabs sit inline after
 * its tab, so a window keeps every control it had. Tabs move between areas by dragging onto
 * another area's strip, or with "Move To" from the context menu; the strip's Tools button lists
 * windows that can be opened or moved here (the former stripe "…").
 */
import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import clsx from "clsx";
import { create } from "zustand";
import { shortcutLabel } from "@/platform/keymap";
import { tx } from "@/platform/i18n";
import { dragRequiresAlt, Icon, IconButton, Menu, showContextMenu, T, tooltipAttrs, type MenuItem } from "@/ui";
import type { ToolWindowContribution } from "../contributions";
import {
  hasStripeButton,
  hideToolWindow,
  moveToolWindow,
  removeFromStripe,
  resetToolWindowPlacements,
  showToolWindow,
  slotAnchor,
  slotOf,
  toggleMaximizeToolWindow,
  useToolWindowLayout,
  type ToolWindowSlot,
} from "./store";
import styles from "./ToolWindows.module.css";

/** IDEA's Move To anchors (New UI: no top). */
export const AREA_NAMES: Record<ToolWindowSlot, string> = {
  left: "Left Top",
  "left-split": "Left Bottom",
  bottom: "Bottom Left",
  "bottom-split": "Bottom Right",
  right: "Right Top",
  "right-split": "Right Bottom",
};
const MOVE_ORDER: ToolWindowSlot[] = ["left", "left-split", "bottom", "bottom-split", "right-split", "right"];

/** "Move to" submenu (tool window options › Move To, tab context menu). */
export function moveToMenu(tw: ToolWindowContribution): MenuItem {
  const current = slotOf(tw);
  return {
    label: "Move To",
    submenu: [
      ...MOVE_ORDER.map((slot): MenuItem => ({
        id: slot,
        label: AREA_NAMES[slot],
        checked: slot === current ? true : undefined,
        disabled: slot === current,
        run: () => moveToolWindow(tw.id, slot),
      })),
      { kind: "separator" },
      { label: "Restore Default Layout", run: resetToolWindowPlacements },
    ],
  };
}

/** The windows an area lists as tabs: those with a button (IDEA's stripe membership) and the shown one. */
export function areaTabs(
  windows: readonly ToolWindowContribution[],
  slot: ToolWindowSlot,
  shown: string | null,
  buttons: Readonly<Record<string, boolean>>,
): ToolWindowContribution[] {
  return windows.filter((w) => slotOf(w) === slot && (hasStripeButton(w, buttons) || w.id === shown));
}

/**
 * The Tools menu of an area: windows that belong here but aren't tabs yet (used for the first
 * time, or removed earlier), then every other window, which moves here.
 */
export function areaToolsMenu(
  windows: readonly ToolWindowContribution[],
  slot: ToolWindowSlot,
  tabs: readonly ToolWindowContribution[],
): MenuItem[] {
  const byTitle = (a: ToolWindowContribution, b: ToolWindowContribution) => tx(a.title).localeCompare(tx(b.title));
  const item = (w: ToolWindowContribution, move: boolean): MenuItem => ({
    id: w.id,
    label: w.title,
    icon: w.icon,
    shortcut: shortcutLabel(`toolwindow.${w.id}`),
    run: () => {
      if (move) moveToolWindow(w.id, slot);
      showToolWindow(w.id, true);
    },
  });
  const here = windows.filter((w) => slotOf(w) === slot && !tabs.includes(w)).sort(byTitle);
  const elsewhere = windows.filter((w) => slotOf(w) !== slot).sort(byTitle);
  return [
    ...(here.length
      ? [{ kind: "header", label: AREA_NAMES[slot] } as MenuItem, ...here.map((w) => item(w, false))]
      : []),
    ...(here.length && elsewhere.length ? [{ kind: "separator" } as MenuItem] : []),
    ...(elsewhere.length
      ? [{ kind: "header", label: "Move Here" } as MenuItem, ...elsewhere.map((w) => item(w, true))]
      : []),
  ];
}

function tabMenu(tw: ToolWindowContribution, maximized: boolean): MenuItem[] {
  return [
    { label: "Remove from Panel", run: () => removeFromStripe(tw.id) },
    { kind: "separator" },
    moveToMenu(tw),
    {
      label: maximized ? "Restore Size" : "Maximize",
      icon: maximized ? "minimize" : "maximize",
      run: () => toggleMaximizeToolWindow(tw.id),
    },
    { kind: "separator" },
    { label: "Hide", icon: "hide", shortcut: shortcutLabel("toolwindow.hideActive"), run: () => hideToolWindow(tw.id) },
  ];
}

// ---------------------------------------------------------------------------
// Dragging a tab to another area. Pointer events, not HTML5 drag and drop: with the window's
// native file drop enabled, the webview never sees dragover / drop for drags starting inside it.

type TabDrop = { slot: ToolWindowSlot; before: string | null };
export const useTabDrag = create<{ id: string | null; drop: TabDrop | null }>(() => ({ id: null, drop: null }));
const DRAG_THRESHOLD = 4;
/** Set when a drag ends, so the click that follows doesn't activate the tab. */
let dragEnded = false;
const centre = (r: DOMRect) => r.left + r.width / 2;

function tabDropAt(x: number, y: number): TabDrop | null {
  const strip = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-area-slot]");
  if (!strip) return null;
  const slot = strip.dataset.areaSlot as ToolWindowSlot;
  let before: string | null = null;
  for (const t of strip.querySelectorAll<HTMLElement>("[data-area-tab]")) {
    if (x < centre(t.getBoundingClientRect())) {
      before = t.dataset.areaTab!;
      break;
    }
  }
  return { slot, before };
}

function startTabDrag(e: PointerEvent<HTMLElement>, id: string) {
  if (e.button !== 0 || (dragRequiresAlt() && !e.altKey)) return;
  const tab = e.currentTarget;
  const start = { x: e.clientX, y: e.clientY };
  let ghost: HTMLElement | null = null;
  const onMove = (ev: globalThis.PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
      const r = tab.getBoundingClientRect();
      ghost = tab.cloneNode(true) as HTMLElement;
      ghost.removeAttribute("data-area-tab");
      ghost.className = clsx(tab.className, styles.tabGhost);
      Object.assign(ghost.style, {
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
      document.body.appendChild(ghost);
      useTabDrag.setState({ id, drop: null });
    }
    ghost.style.transform = `translate(${ev.clientX - start.x}px, ${ev.clientY - start.y}px)`;
    const drop = tabDropAt(ev.clientX, ev.clientY);
    const cur = useTabDrag.getState().drop;
    if (drop?.slot !== cur?.slot || drop?.before !== cur?.before) useTabDrag.setState({ drop });
  };
  const finish = (commit: boolean) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
    if (!ghost) return;
    ghost.remove();
    const { drop } = useTabDrag.getState();
    useTabDrag.setState({ id: null, drop: null });
    dragEnded = true;
    setTimeout(() => (dragEnded = false));
    if (commit && drop && drop.before !== id) {
      moveToolWindow(id, drop.slot, drop.before);
      showToolWindow(id, true);
    }
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);
  const onKey = (ev: globalThis.KeyboardEvent) => {
    if (ev.key !== "Escape" || !ghost) return;
    ev.preventDefault();
    ev.stopPropagation();
    finish(false);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey, true);
}

// ---------------------------------------------------------------------------

/**
 * The strip: `active` is the shown window, whose own header (`activeContent`: its title button
 * and content tabs) replaces its plain tab. When the tabs don't fit, the other tabs drop their
 * names (the icon and the tooltip stay). The bottom areas show the open window alone: the
 * status bar launcher is their switcher.
 */
export function AreaTabs({
  slot,
  windows,
  active,
  activeContent,
}: {
  slot: ToolWindowSlot;
  windows: readonly ToolWindowContribution[];
  active: ToolWindowContribution;
  activeContent: ReactNode;
}) {
  const buttons = useToolWindowLayout((s) => s.stripeButtons);
  const maximized = useToolWindowLayout((s) => s.maximized);
  const focused = useToolWindowLayout((s) => s.focused);
  // The bottom areas switch from the status bar launcher: their strip shows the open window
  // alone, rather than repeating the launcher's icons as tabs.
  const solo = slotAnchor(slot) === "bottom";
  const tabs = useMemo(
    () => (solo ? [active] : areaTabs(windows, slot, active.id, buttons)),
    [solo, windows, slot, active, buttons],
  );
  const drop = useTabDrag((s) => (s.drop?.slot === slot ? s.drop : null));
  const dragged = useTabDrag((s) => s.id);
  const ref = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);

  // Measured, not guessed: only when the full tabs overflow do the other tabs drop their names.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      // Measure at full size: the shown tab may shrink, but only after the others dropped their names.
      el.classList.remove(styles.areaTabsCompact!);
      el.dataset.measure = "";
      const over = el.scrollWidth > el.clientWidth + 1;
      delete el.dataset.measure;
      el.classList.toggle(styles.areaTabsCompact!, over);
      setCompact(over);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs]);

  const marker = (before: string | null) =>
    drop && drop.before === before ? <span className={styles.tabDrop} aria-hidden="true" /> : null;

  return (
    <div
      ref={ref}
      className={clsx(styles.areaTabs, compact && styles.areaTabsCompact)}
      role="tablist"
      aria-label={tx(AREA_NAMES[slot])}
      data-area-slot={slot}
    >
      {tabs.map((w) => {
        const shortcut = shortcutLabel(`toolwindow.${w.id}`);
        return (
          <span key={w.id} className={styles.tabSlot}>
            {marker(w.id)}
            {w.id === active.id ? (
              <span
                className={clsx(
                  styles.tab,
                  styles.tabActive,
                  focused === w.id && styles.tabFocused,
                  dragged === w.id && styles.tabDragged,
                )}
                role="tab"
                aria-selected="true"
                data-area-tab={w.id}
                onPointerDown={(e) => {
                  // Drag from the icon only: the title may be a menu button.
                  if ((e.target as HTMLElement).closest("[data-tab-grip]")) startTabDrag(e, w.id);
                }}
                onContextMenu={(e) => {
                  if ((e.target as HTMLElement).closest("[data-tab-own]")) return;
                  e.preventDefault();
                  showContextMenu(e, tabMenu(w, maximized === w.anchor));
                }}
              >
                <span className={styles.tabIcon} data-tab-grip="" {...tooltipAttrs(w.title, shortcut)}>
                  <Icon name={w.icon} size={14} />
                </span>
                {activeContent}
              </span>
            ) : (
              <button
                type="button"
                role="tab"
                aria-selected="false"
                className={clsx(styles.tab, dragged === w.id && styles.tabDragged)}
                aria-label={tx(w.title)}
                aria-keyshortcuts={shortcut}
                data-area-tab={w.id}
                onPointerDown={(e) => startTabDrag(e, w.id)}
                onClick={() => {
                  if (!dragEnded) showToolWindow(w.id, true);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  showContextMenu(e, tabMenu(w, maximized === w.anchor));
                }}
                {...tooltipAttrs(w.title, shortcut)}
              >
                <Icon name={w.icon} size={14} />
                <span className={styles.tabLabel}>
                  <T>{w.title}</T>
                </span>
              </button>
            )}
          </span>
        );
      })}
      {marker(null)}
    </div>
  );
}

/** The area's Tools button: windows to open here, or to move here. */
export function AreaToolsButton({
  slot,
  windows,
  active,
}: {
  slot: ToolWindowSlot;
  windows: readonly ToolWindowContribution[];
  active: ToolWindowContribution;
}) {
  const buttons = useToolWindowLayout((s) => s.stripeButtons);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const items = useMemo(
    () => (open ? areaToolsMenu(windows, slot, areaTabs(windows, slot, active.id, buttons)) : []),
    [open, windows, slot, active.id, buttons],
  );
  return (
    <>
      <IconButton
        ref={ref}
        icon="layout"
        title="Tool Windows"
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
        aria-label={tx("Tool Windows")}
      />
    </>
  );
}
