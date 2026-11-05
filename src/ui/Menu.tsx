/**
 * Menus and context menus. Items are either ad-hoc (`{label, run}`) or bound
 * to registered actions (`{kind: "action", action: "editor.closeTab"}`), which
 * supplies title, shortcut and enablement from the action registry. A pointer on its
 * way to an open submenu may cross other items without closing it (submenu aiming).
 */
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
} from "react";
import clsx from "clsx";
import { create } from "zustand";
import { getAction, isActionEnabled, executeAction } from "@/platform/actions";
import { useContextKeys } from "@/platform/context";
import { shortcutLabel } from "@/platform/keymap";
import { Icon, type IconName } from "./icons";
import { Popup, type PopupAnchor } from "./Popup";
import type { Placement } from "@floating-ui/react-dom";
import styles from "./Menu.module.css";
import { tx } from "@/platform/i18n";

export type MenuItem =
  | { kind: "separator" }
  | { kind: "header"; label: string }
  | {
      kind: "action";
      action: string;
      arg?: unknown;
      label?: string;
      icon?: IconName | (string & {});
      disabled?: boolean;
    }
  | {
      kind?: "item";
      id?: string;
      label: string;
      /** User text (e.g. a past query): shown as is, never looked up in the catalog. */
      verbatim?: boolean;
      icon?: IconName | (string & {});
      shortcut?: string;
      disabled?: boolean;
      checked?: boolean;
      danger?: boolean;
      run?: () => void;
      submenu?: MenuItem[];
    };

interface Resolved {
  kind: "item" | "separator" | "header";
  key: string;
  label: string;
  icon?: string;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  danger?: boolean;
  run?: () => void;
  submenu?: MenuItem[];
}

export function resolveMenuItems(items: MenuItem[]): Resolved[] {
  const out: Resolved[] = [];
  items.forEach((item, i) => {
    if (item.kind === "separator") {
      if (out.length && out[out.length - 1]!.kind !== "separator")
        out.push({ kind: "separator", key: `sep${i}`, label: "" });
      return;
    }
    if (item.kind === "header") {
      out.push({ kind: "header", key: `h${i}`, label: tx(item.label) });
      return;
    }
    if (item.kind === "action") {
      const a = getAction(item.action);
      if (!a) return;
      out.push({
        kind: "item",
        key: item.action,
        label: tx(item.label) ?? a.title,
        icon: item.icon ?? a.icon,
        shortcut: shortcutLabel(item.action),
        disabled: !!item.disabled || !isActionEnabled(a),
        run: () => void executeAction(item.action, item.arg),
      });
      return;
    }
    out.push({
      ...item,
      label: item.verbatim ? item.label : tx(item.label),
      kind: "item",
      key: item.id ?? `${i}:${item.label}`,
    });
  });
  while (out.length && out[out.length - 1]!.kind === "separator") out.pop();
  return out;
}

const selectable = (r: Resolved | undefined) => !!r && r.kind === "item" && !r.disabled;

interface MenuListProps {
  items: MenuItem[];
  /** Called after an item ran (closes the whole menu chain). */
  onDone: () => void;
  /** Close just this level (submenus). */
  onCloseLevel?: () => void;
  "aria-label"?: string;
  /** Focus the first item on mount. */
  autoFocusFirst?: boolean;
  /** The list's element (a parent level aims at its submenu with it). */
  listRef?: Ref<HTMLDivElement>;
}

type Point = { x: number; y: number };

/** How long a pointer heading for an open submenu may cross other items without switching. */
const AIM_DELAY = 300;
/** Slack around the submenu's near edge, so a slightly off course still counts. */
const AIM_TOLERANCE = 40;

function sign(p: Point, a: Point, b: Point): number {
  return (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
}

/** Whether `p` lies inside the triangle `a`, `b`, `c` (edges included). */
export function inTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

/**
 * Submenu aiming (macOS, IDEA, Amazon's menu-aim): the pointer moved from `from` to `to`
 * and is heading for the submenu at `rect` when `to` lies in the triangle between
 * `from` and the submenu's near edge (widened by a tolerance).
 */
export function headingFor(
  from: Point,
  to: Point,
  rect: DOMRect | { left: number; right: number; top: number; bottom: number },
): boolean {
  if (from.x === to.x && from.y === to.y) return false;
  const right = rect.left >= from.x;
  const edge = right ? rect.left : rect.right;
  // Moving away from the submenu's side is never aiming at it.
  if (right ? to.x < from.x : to.x > from.x) return false;
  return inTriangle(to, from, { x: edge, y: rect.top - AIM_TOLERANCE }, { x: edge, y: rect.bottom + AIM_TOLERANCE });
}

export function MenuList({ items, onDone, onCloseLevel, autoFocusFirst = true, listRef, ...aria }: MenuListProps) {
  // Action enablement follows the context keys: opening the menu moves focus
  // (e.g. editorTextFocus → popupOpen) right after the first render.
  useContextKeys();
  const resolved = resolveMenuItems(items);
  const [active, setActive] = useState(() => (autoFocusFirst ? resolved.findIndex(selectable) : -1));
  const [openSub, setOpenSubIndex] = useState<number | null>(null);
  const [subAnchor, setSubAnchor] = useState<HTMLElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The last pointer positions over this level, and the item under the pointer.
  const trail = useRef<Point[]>([]);
  const hovered = useRef(-1);
  const subList = useRef<HTMLDivElement>(null);
  const setOpenSub = (i: number | null) => {
    setSubAnchor(i === null ? null : (itemRefs.current[i] ?? null));
    setOpenSubIndex(i);
  };

  useLayoutEffect(() => {
    if (active >= 0 && openSub === null) itemRefs.current[active]?.focus({ preventScroll: false });
  }, [active, openSub]);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  const move = (delta: number, from = active) => {
    const n = resolved.length;
    if (!n) return;
    let i = from;
    for (let step = 0; step < n; step++) {
      i = (i + delta + n) % n;
      if (selectable(resolved[i])) {
        setActive(i);
        return;
      }
    }
  };

  const activate = (i: number) => {
    const item = resolved[i];
    if (!selectable(item)) return;
    if (item!.submenu) {
      setActive(i);
      setOpenSub(i);
      return;
    }
    onDone();
    item!.run?.();
  };

  /** Pointer over item `i`: it becomes active (opening its submenu) unless the pointer is on its way to the open submenu. */
  const hover = (i: number) => {
    const r = resolved[i];
    if (!r || r.disabled || r.kind !== "item") return;
    clearTimeout(hoverTimer.current);
    const rect = openSub !== null && openSub !== i ? subList.current?.getBoundingClientRect() : undefined;
    const t = trail.current;
    if (rect && t.length > 1 && headingFor(t[0]!, t[t.length - 1]!, rect)) {
      // Check again later: still on its way (it moved on towards the submenu) waits again,
      // resting here switches (Amazon's menu-aim).
      const at = t[t.length - 1]!;
      hoverTimer.current = setTimeout(() => {
        if (hovered.current !== i) return;
        const now = trail.current[trail.current.length - 1]!;
        trail.current = now.x === at.x && now.y === at.y ? [now] : [at, now];
        hover(i);
      }, AIM_DELAY);
      return;
    }
    setActive(i);
    const hasSub = !!r.submenu;
    hoverTimer.current = setTimeout(() => setOpenSub(hasSub ? i : null), hasSub ? 120 : 200);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        move(1);
        break;
      case "ArrowUp":
        move(-1, active < 0 ? 0 : active);
        break;
      case "Home":
        move(1, -1);
        break;
      case "End":
        move(-1, 0);
        break;
      case "ArrowRight":
        if (resolved[active]?.submenu) setOpenSub(active);
        else return;
        break;
      case "ArrowLeft":
        if (onCloseLevel) onCloseLevel();
        else return;
        break;
      case "Enter":
      case " ":
        activate(active);
        break;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const ch = e.key.toLowerCase();
          const n = resolved.length;
          for (let s = 1; s <= n; s++) {
            const i = (active + s + n) % n;
            const r = resolved[i]!;
            if (selectable(r) && r.label.toLowerCase().startsWith(ch)) {
              setActive(i);
              break;
            }
          }
          break;
        }
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={listRef}
      role="menu"
      aria-label={aria["aria-label"]}
      className={styles.menu}
      onKeyDown={onKeyDown}
      onPointerMove={(e) => {
        // A submenu's moves bubble here through its portal: only this level's count.
        if (!e.currentTarget.contains(e.target as Node)) return;
        trail.current = [...trail.current, { x: e.clientX, y: e.clientY }].slice(-4);
      }}
      onPointerLeave={() => {
        hovered.current = -1;
      }}
    >
      {resolved.map((r, i) => {
        if (r.kind === "separator") return <div key={r.key} role="separator" className={styles.separator} />;
        if (r.kind === "header")
          return (
            <div key={r.key} role="presentation" className={styles.header}>
              {r.label}
            </div>
          );
        const hasSub = !!r.submenu;
        return (
          <Fragment key={r.key}>
            <button
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role={r.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
              aria-checked={r.checked}
              aria-disabled={r.disabled || undefined}
              aria-haspopup={hasSub ? "menu" : undefined}
              aria-expanded={hasSub ? openSub === i : undefined}
              tabIndex={i === active ? 0 : -1}
              className={clsx(
                styles.item,
                i === active && styles.active,
                r.disabled && styles.disabled,
                r.danger && styles.danger,
              )}
              onPointerEnter={(e) => {
                hovered.current = i;
                trail.current = [...trail.current, { x: e.clientX, y: e.clientY }].slice(-4);
                hover(i);
              }}
              onPointerLeave={() => {
                // Into the submenu too (a React child, so the list itself is never left).
                if (hovered.current === i) hovered.current = -1;
              }}
              onClick={() => activate(i)}
            >
              <span className={styles.icon} data-menu-icon={!r.checked && r.icon ? "" : undefined}>
                {r.checked ? <Icon name="check" size={13} /> : r.icon ? <Icon name={r.icon} size={14} /> : null}
              </span>
              <span className={styles.label}>{r.label}</span>
              {r.shortcut && <span className={styles.shortcut}>{r.shortcut}</span>}
              {hasSub && <Icon name="chevron-right" size={14} className={styles.subArrow} />}
            </button>
            {hasSub && openSub === i && subAnchor && (
              <Popup
                open
                anchor={subAnchor}
                placement="right-start"
                offset={2}
                role="presentation"
                autoFocus={false}
                onClose={() => setOpenSub(null)}
                className={styles.popup}
              >
                <MenuList
                  listRef={subList}
                  items={r.submenu!}
                  onDone={onDone}
                  onCloseLevel={() => {
                    setOpenSub(null);
                    itemRefs.current[i]?.focus();
                  }}
                />
              </Popup>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

export interface MenuProps {
  open: boolean;
  onClose: () => void;
  anchor: PopupAnchor;
  items: MenuItem[];
  placement?: Placement;
  "aria-label"?: string;
}

/** A dropdown menu anchored to an element or point. */
export function Menu({ open, onClose, anchor, items, placement = "bottom-start", ...aria }: MenuProps) {
  return (
    <Popup
      open={open}
      onClose={onClose}
      anchor={anchor}
      placement={placement}
      role="presentation"
      autoFocus={false}
      className={styles.popup}
    >
      <MenuList items={items} onDone={onClose} aria-label={aria["aria-label"]} />
    </Popup>
  );
}

// ---------------------------------------------------------------------------
// Context menus

interface ContextMenuState {
  menu: { x: number; y: number; items: MenuItem[]; id: number } | null;
}

export const useContextMenuStore = create<ContextMenuState>(() => ({ menu: null }));
let menuSeq = 0;

export function showContextMenu(
  at: { clientX: number; clientY: number } | { x: number; y: number },
  items: MenuItem[],
) {
  const x = "clientX" in at ? at.clientX : at.x;
  const y = "clientY" in at ? at.clientY : at.y;
  useContextMenuStore.setState({ menu: { x, y, items, id: ++menuSeq } });
}

export function hideContextMenu() {
  useContextMenuStore.setState({ menu: null });
}

/** Renders the active context menu; mount once (the workbench does). */
export function ContextMenuHost() {
  const menu = useContextMenuStore((s) => s.menu);
  if (!menu) return null;
  return (
    <Popup
      key={menu.id}
      open
      anchor={{ x: menu.x, y: menu.y }}
      placement="bottom-start"
      offset={2}
      role="presentation"
      autoFocus={false}
      onClose={hideContextMenu}
      className={styles.popup}
    >
      <MenuList items={menu.items} onDone={hideContextMenu} aria-label="Context menu" />
    </Popup>
  );
}
