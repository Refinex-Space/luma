/**
 * The tool window bars on the window's left and right edges (IDEA New UI stripes). Each bar's
 * buttons sit next to the area they open: the left bar's top group opens Left Top, the group
 * under its divider Left Bottom, and its foot Bottom Left; the right bar mirrors that with Right
 * Top, Right Bottom and Bottom Right. A button toggles its window and shows its state at a glance
 * (Problems' count, a run in progress, unread notifications). Buttons move between groups by
 * dragging, or with "Move To" in their context menu; windows without a button are under the left
 * bar's "⋯".
 */
import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import clsx from "clsx";
import { create } from "zustand";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { shortcutLabel } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { dragRequiresAlt, Icon, Menu, showContextMenu, T, tooltipAttrs, type MenuItem } from "@/ui";
import type { ToolWindowBadge, ToolWindowContribution } from "../contributions";
import {
  hasStripeButton,
  moveToolWindow,
  removeFromStripe,
  resetToolWindowPlacements,
  showToolWindow,
  slotOf,
  toggleToolWindow,
  useToolWindowLayout,
  type SlotRecord,
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
const MOVE_ORDER: ToolWindowSlot[] = ["left", "left-split", "bottom", "bottom-split", "right", "right-split"];

/** "Move To" submenu (bar button context menu, tool window options). */
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

async function setAppearance(key: "showToolWindowBars" | "showToolWindowNames", on: boolean) {
  const settings = await call(commands.settingsSet("global", `appearance.${key}`, JSON.stringify(on)));
  useProject.setState({ settings });
}

export const setShowToolWindowBars = (on: boolean) => setAppearance("showToolWindowBars", on);

/** Bar button context menu: show / hide, take the button off the bar, move the window, names. */
export function stripeButtonMenu(tw: ToolWindowContribution, shown: boolean, showNames: boolean): MenuItem[] {
  return [
    {
      label: shown ? "Hide" : "Show",
      shortcut: shortcutLabel(`toolwindow.${tw.id}`),
      run: () => toggleToolWindow(tw.id),
    },
    { label: "Hide from Bar", run: () => removeFromStripe(tw.id) },
    { kind: "separator" },
    moveToMenu(tw),
    { kind: "separator" },
    {
      label: "Show Tool Window Names",
      checked: showNames,
      run: () => void setAppearance("showToolWindowNames", !showNames),
    },
  ];
}

export type StripeSide = "left" | "right";

/** Each bar's foot: the bottom area beside it. */
export function lowerSlot(side: StripeSide): ToolWindowSlot {
  return side === "left" ? "bottom" : "bottom-split";
}

/** The areas a bar's buttons open, top to bottom. */
export function stripeSlots(side: StripeSide): [ToolWindowSlot, ToolWindowSlot, ToolWindowSlot] {
  return [side, `${side}-split`, lowerSlot(side)];
}

/** Windows with a button on the bars: the user's choice, else the default, and any shown window. */
export function stripeWindows(
  windows: readonly ToolWindowContribution[],
  visible: SlotRecord,
  buttons: Readonly<Record<string, boolean>>,
): ToolWindowContribution[] {
  return windows.filter((w) => hasStripeButton(w, buttons) || visible[slotOf(w)] === w.id);
}

/**
 * The "⋯" menu: windows without a button, under the area they open in. Opening one puts its
 * button on the bar.
 */
export function moreToolWindowsMenu(windows: readonly ToolWindowContribution[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const slot of MOVE_ORDER) {
    const here = windows.filter((w) => slotOf(w) === slot).sort((a, b) => tx(a.title).localeCompare(tx(b.title)));
    if (!here.length) continue;
    if (out.length) out.push({ kind: "separator" });
    out.push({ kind: "header", label: AREA_NAMES[slot] });
    for (const w of here)
      out.push({
        id: w.id,
        label: w.title,
        icon: w.icon,
        shortcut: shortcutLabel(`toolwindow.${w.id}`),
        run: () => showToolWindow(w.id, true),
      });
  }
  return out;
}

/** The 20px drawings on a normal bar; compact mode uses the 16px ones. */
function useBarIcon(): number {
  return useProject((s) => (s.settings?.appearance?.compactMode === true ? 16 : 20));
}

// ---------------------------------------------------------------------------
// Dragging a button to another group. Pointer events rather than HTML5 drag and drop: with the
// window's native file drop enabled, the webview never sees dragover / drop for drags that start
// inside it.

type StripeDrop = { slot: ToolWindowSlot; before: string | null };

export const useStripeDrag = create<{ id: string | null; drop: StripeDrop | null }>(() => ({ id: null, drop: null }));

/** Movement before a press on a button becomes a drag, px. */
const DRAG_THRESHOLD = 4;
/** Set when a drag ends on its own button, so the click that follows doesn't toggle the window. */
let dragEnded = false;

const middle = (r: DOMRect) => r.top + r.height / 2;

/** Drop position under the pointer: an area and the button to insert before (null: at the end). */
function stripeDropAt(x: number, y: number): StripeDrop | null {
  const nav = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-stripe-side]");
  const side = nav?.dataset.stripeSide;
  if (!nav || (side !== "left" && side !== "right")) return null;
  const [top, split, lower] = stripeSlots(side);
  const spacer = nav.querySelector<HTMLElement>("[data-stripe-spacer]")?.getBoundingClientRect();
  const separator = nav.querySelector<HTMLElement>("[data-stripe-separator]")?.getBoundingClientRect();
  const slot = spacer && y > middle(spacer) ? lower : separator && y > middle(separator) ? split : top;
  let before: string | null = null;
  for (const b of nav.querySelectorAll<HTMLElement>(`[data-stripe-slot="${slot}"] [data-stripe-button]`)) {
    if (y < middle(b.getBoundingClientRect())) {
      before = b.dataset.stripeButton!;
      break;
    }
  }
  return { slot, before };
}

function startStripeDrag(e: PointerEvent<HTMLButtonElement>, id: string) {
  if (e.button !== 0 || (dragRequiresAlt() && !e.altKey)) return;
  const button = e.currentTarget;
  const start = { x: e.clientX, y: e.clientY };
  let ghost: HTMLElement | null = null;
  const onMove = (ev: globalThis.PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
      const r = button.getBoundingClientRect();
      ghost = button.cloneNode(true) as HTMLElement;
      ghost.removeAttribute("data-stripe-button");
      ghost.className = clsx(button.className, styles.stripeGhost);
      Object.assign(ghost.style, {
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
      document.body.appendChild(ghost);
      useStripeDrag.setState({ id, drop: null });
    }
    ghost.style.transform = `translate(${ev.clientX - start.x}px, ${ev.clientY - start.y}px)`;
    const drop = stripeDropAt(ev.clientX, ev.clientY);
    const cur = useStripeDrag.getState().drop;
    if (drop?.slot !== cur?.slot || drop?.before !== cur?.before) useStripeDrag.setState({ drop });
  };
  const finish = (commit: boolean) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
    if (!ghost) return;
    ghost.remove();
    const { drop } = useStripeDrag.getState();
    useStripeDrag.setState({ id: null, drop: null });
    dragEnded = true;
    setTimeout(() => (dragEnded = false));
    if (commit && drop && drop.before !== id) moveToolWindow(id, drop.slot, drop.before);
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

const noBadge = (): ToolWindowBadge | null => null;

function Badge({ badge }: { badge: ToolWindowBadge }) {
  if (badge.count != null)
    return (
      <span className={clsx(styles.stripeCount, badge.tone === "error" && styles.stripeCountError)} aria-hidden="true">
        {badge.count > 99 ? "99+" : badge.count}
      </span>
    );
  if (!badge.tone) return null;
  const tone = { running: styles.dotRunning, paused: styles.dotPaused, error: styles.dotError, new: styles.dotNew }[
    badge.tone
  ];
  return <span className={clsx(styles.stripeDot, tone)} aria-hidden="true" />;
}

function StripeButton({
  tw,
  active,
  focused,
  showName,
}: {
  tw: ToolWindowContribution;
  active: boolean;
  focused: boolean;
  showName: boolean;
}) {
  const shortcut = shortcutLabel(`toolwindow.${tw.id}`);
  const dragged = useStripeDrag((s) => s.id === tw.id);
  const icon = useBarIcon();
  const useBadge = tw.useBadge ?? noBadge;
  const badge = useBadge();
  const title = tx(tw.title);
  const label = badge?.label ?? (badge?.count ? `${title} ${badge.count}` : title);
  return (
    <button
      type="button"
      className={clsx(
        styles.stripeButton,
        showName && styles.stripeNamed,
        active && styles.stripeActive,
        active && focused && styles.stripeFocused,
        dragged && styles.stripeDragged,
      )}
      aria-label={label}
      aria-pressed={active}
      aria-keyshortcuts={shortcut}
      data-stripe-button={tw.id}
      onPointerDown={(e) => startStripeDrag(e, tw.id)}
      onClick={() => {
        if (!dragEnded) toggleToolWindow(tw.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        showContextMenu(e, stripeButtonMenu(tw, active, showName));
      }}
      {...tooltipAttrs(tw.title, shortcut)}
    >
      <span className={styles.stripeIcon}>
        <Icon name={tw.icon} size={icon} />
        {badge && <Badge badge={badge} />}
      </span>
      {showName && (
        <span className={clsx(styles.stripeLabel, !/\s/.test(tw.title) && styles.stripeLabelWord)} aria-hidden="true">
          <T>{tw.title}</T>
        </span>
      )}
    </button>
  );
}

function StripeMore({ windows, side }: { windows: ToolWindowContribution[]; side: StripeSide }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const icon = useBarIcon();
  const items = useMemo(() => (open ? moreToolWindowsMenu(windows) : []), [open, windows]);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={clsx(styles.stripeButton, styles.stripeMore)}
        aria-label={tx("More Tool Windows")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        {...tooltipAttrs("More Tool Windows")}
      >
        <Icon name="more-horizontal" size={icon} />
      </button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={ref}
        items={items}
        placement={side === "left" ? "right-start" : "left-start"}
        aria-label={tx("More Tool Windows")}
      />
    </>
  );
}

function onStripeKeyDown(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
  const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
  const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : i + (e.key === "ArrowDown" ? 1 : -1);
  buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
  e.preventDefault();
}

export function ToolWindowStripe({
  side,
  windows,
  visible,
  showNames = false,
}: {
  side: StripeSide;
  windows: ToolWindowContribution[];
  visible: SlotRecord;
  /** Tool window names under the icons (IDEA "Show Tool Window Names"). */
  showNames?: boolean;
}) {
  const buttons = useToolWindowLayout((s) => s.stripeButtons);
  const focused = useToolWindowLayout((s) => s.focused);
  const onStripe = useMemo(() => stripeWindows(windows, visible, buttons), [windows, visible, buttons]);
  const [top, split, lower] = stripeSlots(side);
  const inSlot = (slot: ToolWindowSlot) => onStripe.filter((w) => slotOf(w) === slot);
  const groups = { top: inSlot(top), split: inSlot(split), lower: inSlot(lower) };
  const offStripe = useMemo(() => windows.filter((w) => !onStripe.includes(w)), [windows, onStripe]);
  const drop = useStripeDrag((s) => s.drop);
  // While a button is dragged, every group shows, the empty ones as a dashed drop target.
  const dragging = useStripeDrag((s) => !!s.id);

  const indicator = (slot: ToolWindowSlot, before: string | null) =>
    drop && drop.slot === slot && drop.before === before ? (
      <div className={styles.stripeDrop} aria-hidden="true" />
    ) : null;
  const renderGroup = (slot: ToolWindowSlot, list: ToolWindowContribution[]) =>
    list.length || dragging ? (
      <div
        className={clsx(styles.stripeGroup, !list.length && styles.stripeGroupEmpty)}
        data-stripe-slot={slot}
        role="group"
        aria-label={tx(AREA_NAMES[slot])}
      >
        {list.map((w) => (
          <div key={w.id} className={styles.stripeSlot}>
            {indicator(slot, w.id)}
            <StripeButton tw={w} active={visible[slot] === w.id} focused={focused === w.id} showName={showNames} />
          </div>
        ))}
        <div className={styles.stripeSlot}>{indicator(slot, null)}</div>
      </div>
    ) : null;

  return (
    <nav
      aria-label={tx(side === "left" ? "Left tool windows" : "Right tool windows")}
      role="toolbar"
      aria-orientation="vertical"
      data-stripe-side={side}
      className={clsx(
        styles.stripe,
        showNames && styles.stripeWithNames,
        side === "right" ? styles.stripeSideRight : styles.stripeSideLeft,
      )}
      onKeyDown={onStripeKeyDown}
    >
      {renderGroup(top, groups.top)}
      {((groups.top.length > 0 && groups.split.length > 0) || dragging) && (
        <div className={styles.stripeSeparator} data-stripe-separator="" role="separator" />
      )}
      {renderGroup(split, groups.split)}
      {side === "left" && offStripe.length > 0 && <StripeMore windows={offStripe} side={side} />}
      <div className={styles.stripeSpacer} data-stripe-spacer="" />
      {renderGroup(lower, groups.lower)}
    </nav>
  );
}
