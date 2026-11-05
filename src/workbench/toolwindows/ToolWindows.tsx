import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import clsx from "clsx";
import { shortcutLabel } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { Icon, IconButton, Menu, type MenuItem, T } from "@/ui";
import { FOCUSABLE } from "@/ui/popupState";
import { TabStripRegistry } from "@/ui/Tabs";
import { useContributions, type ToolWindowAnchor, type ToolWindowContribution } from "../contributions";
import {
  hideToolWindow,
  MAX_SPLIT,
  MIN_SPLIT,
  placed,
  setToolWindowSize,
  setToolWindowSplit,
  SLOTS,
  slotOf,
  toggleMaximizeToolWindow,
  useToolWindowLayout,
  type SlotRecord,
  type ToolWindowSlot,
} from "./store";
import { AreaTabs, AreaToolsButton, moveToMenu } from "./AreaTabs";
import { contentTabRegistry } from "./content";
import styles from "./ToolWindows.module.css";
import { tx } from "@/platform/i18n";

export { moveToMenu };

function byOrder(a: ToolWindowContribution, b: ToolWindowContribution) {
  return (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title);
}

/** Registered tool windows available in the current state (project open or not). */
export function useToolWindows(): ToolWindowContribution[] {
  const map = useContributions((s) => s.toolWindows);
  const placements = useToolWindowLayout((s) => s.placements);
  const hasProject = useProject((s) => !!s.project);
  return useMemo(
    () =>
      [...map.values()]
        .filter((t) => hasProject || t.requiresProject === false)
        .map((t) => placed(t, placements))
        .sort(byOrder),
    [map, hasProject, placements],
  );
}

/** Visible window per area, ignoring ids that aren't registered (yet) or don't dock there. */
export function useEffectiveVisible(windows: ToolWindowContribution[]): SlotRecord {
  const visible = useToolWindowLayout((s) => s.visible);
  return useMemo(() => {
    const out = {} as SlotRecord;
    for (const slot of SLOTS) {
      const id = visible[slot];
      out[slot] = id && windows.some((w) => w.id === id && slotOf(w) === slot) ? id : null;
    }
    return out;
  }, [visible, windows]);
}

// ---------------------------------------------------------------------------
// Panels

const NO_ITEMS: MenuItem[] = [];
const staticMenus = new WeakMap<MenuItem[], (id: string) => MenuItem[]>();
function staticHeaderMenu(items: MenuItem[] | undefined): (id: string) => MenuItem[] {
  if (!items) return () => NO_ITEMS;
  let f = staticMenus.get(items);
  if (!f) staticMenus.set(items, (f = () => items));
  return f;
}

const noTitleMenu = (): { label: string; items: MenuItem[] } | null => null;
const always = () => true;
const never = () => false;

function ToolWindowView({
  tw,
  hidden,
  windows,
}: {
  tw: ToolWindowContribution;
  hidden: boolean;
  /** Every placed window: the header lists this area's as tabs. */
  windows: ToolWindowContribution[];
}) {
  const ref = useRef<HTMLElement>(null);
  const focusRequest = useToolWindowLayout((s) => s.focusRequest);
  const maximized = useToolWindowLayout((s) => s.maximized === tw.anchor);
  const [moreOpen, setMoreOpen] = useState(false);
  const [titleOpen, setTitleOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLButtonElement>(null);
  const Content = tw.component;
  const Actions = tw.headerActions;
  const Tabs = tw.headerContent;

  useEffect(() => {
    if (!focusRequest || focusRequest.id !== tw.id || hidden) return;
    const raf = requestAnimationFrame(() => {
      const root = ref.current;
      if (!root) return;
      const body = root.querySelector<HTMLElement>("[data-toolwindow-body]");
      // Like IDEA, activation focuses the content (a field, list or tree), never a button or
      // link: a scripted focus on one draws its focus ring (an empty view's "New…" link).
      const content = [...(body?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].find(
        (el) => !el.matches('button, a[href], [role="button"], [role="link"]'),
      );
      if (body && !content && !body.hasAttribute("tabindex")) body.tabIndex = -1;
      const target = body?.querySelector<HTMLElement>("[data-autofocus]") ?? content ?? body ?? root;
      target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [focusRequest, tw.id, hidden]);

  const useHeaderMenu = typeof tw.headerMenu === "function" ? tw.headerMenu : staticHeaderMenu(tw.headerMenu);
  const own = useHeaderMenu(tw.id);
  const useTitleMenu = tw.titleMenu ?? noTitleMenu;
  const titleMenu = useTitleMenu(tw.id);
  const titleItems = titleMenu?.items ?? (tw.headerMenuInTitle === false ? [] : own);
  const useTabsReplaceTitle =
    typeof tw.tabsReplaceTitle === "function" ? tw.tabsReplaceTitle : tw.tabsReplaceTitle ? always : never;
  const tabsReplaceTitle = useTabsReplaceTitle();
  const more: MenuItem[] = [
    ...own,
    ...(own.length ? [{ kind: "separator" } as MenuItem] : []),
    moveToMenu(tw),
    {
      label: maximized ? "Restore Size" : "Maximize",
      icon: maximized ? "minimize" : "maximize",
      run: () => toggleMaximizeToolWindow(tw.id),
    },
    { kind: "separator" },
    { label: "Hide", icon: "hide", shortcut: shortcutLabel("toolwindow.hideActive"), run: () => hideToolWindow(tw.id) },
  ];

  return (
    <section
      ref={ref}
      className={styles.window}
      data-toolwindow={tw.id}
      aria-label={tx(tw.title)}
      hidden={hidden}
      tabIndex={-1}
    >
      <header
        className={clsx(styles.header, styles.headerTabbed)}
        onDoubleClick={(e) => e.target === e.currentTarget && toggleMaximizeToolWindow(tw.id)}
      >
        <AreaTabs
          slot={slotOf(tw)}
          windows={windows}
          active={tw}
          activeContent={
            <>
              {Tabs && tabsReplaceTitle ? null : titleItems.length > 0 ? (
                <>
                  <button
                    ref={titleRef}
                    type="button"
                    className={styles.titleButton}
                    data-tab-own=""
                    aria-haspopup="menu"
                    aria-expanded={titleOpen}
                    onClick={() => setTitleOpen((v) => !v)}
                  >
                    <span className={styles.title}>
                      <T>{titleMenu?.label ?? tw.title}</T>
                    </span>
                    <Icon name="chevron-down" size={12} className={styles.titleChevron} />
                  </button>
                  <Menu
                    open={titleOpen}
                    onClose={() => setTitleOpen(false)}
                    anchor={titleRef}
                    items={titleItems}
                    aria-label={titleMenu ? tx`${tw.title} views` : tx`${tw.title} view options`}
                  />
                </>
              ) : (
                <span className={clsx(styles.title, styles.titlePlain)}>
                  <T>{tw.title}</T>
                </span>
              )}
              {Tabs && (
                <span className={styles.headerContent} data-tab-own="">
                  <TabStripRegistry.Provider value={contentTabRegistry(tw.id)}>
                    <Tabs id={tw.id} />
                  </TabStripRegistry.Provider>
                </span>
              )}
            </>
          }
        />
        <div className={styles.headerActions}>
          {Actions && <Actions id={tw.id} />}
          <AreaToolsButton slot={slotOf(tw)} windows={windows} active={tw} />
          <IconButton
            ref={moreRef}
            icon="more"
            title="Options"
            size="small"
            iconSize={16}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
          />
          <IconButton
            icon="minus"
            title="Hide"
            shortcut={shortcutLabel("toolwindow.hideActive")}
            size="small"
            iconSize={16}
            onClick={() => hideToolWindow(tw.id)}
          />
        </div>
        <Menu
          open={moreOpen}
          onClose={() => setMoreOpen(false)}
          anchor={moreRef}
          items={more}
          placement="bottom-end"
          aria-label={tx`${tw.title} options`}
        />
      </header>
      <div className={styles.body} data-toolwindow-body="">
        <Content id={tw.id} />
      </div>
    </section>
  );
}

const MIN: Record<ToolWindowAnchor, number> = { left: 140, right: 160, bottom: 90 };
const MAXIMIZED: Record<ToolWindowAnchor, string> = { left: "82%", right: "82%", bottom: "88%" };
/** The editor keeps at least this much room when a tool window is resized (see the grid template). */
const EDITOR_MIN = { width: 200, height: 60 };
/** Smallest area when a side is split: stacked (left / right) and side by side (bottom). */
const SPLIT_MIN = { stacked: 60, sideBySide: 120 };
const KEY_STEP = 10;

/**
 * Splitter between the primary and split areas of a side: horizontal on the
 * left and right (areas stacked), vertical at the bottom (side by side).
 * Moves the areas' flex-grow while dragging; the ratio is stored on release.
 */
function SplitHandle({ anchor, hidden }: { anchor: ToolWindowAnchor; hidden: boolean }) {
  const stacked = anchor !== "bottom";
  const measure = (el: HTMLElement) => {
    const first = el.previousElementSibling as HTMLElement | null;
    const second = el.nextElementSibling as HTMLElement | null;
    if (!first || !second) return null;
    const size = (e: HTMLElement) => (stacked ? e.offsetHeight : e.offsetWidth);
    const total = size(first) + size(second);
    if (total <= 0) return null;
    const min = Math.min(stacked ? SPLIT_MIN.stacked : SPLIT_MIN.sideBySide, total / 2);
    return {
      areas: [first, second] as const,
      first: size(first),
      total,
      clamp: (px: number) => Math.min(total - min, Math.max(min, px)),
    };
  };
  const apply = ([first, second]: readonly [HTMLElement, HTMLElement], ratio: number) => {
    first.style.flexGrow = String(ratio);
    second.style.flexGrow = String(1 - ratio);
  };
  const ratioOf = (px: number, total: number) => Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, px / total));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const m = measure(el);
    if (e.button !== 0 || !m) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const origin = stacked ? e.clientY : e.clientX;
    const cursor = document.body.style.cursor;
    document.body.style.cursor = stacked ? "row-resize" : "col-resize";
    let ratio: number | null = null;
    const move = (ev: globalThis.PointerEvent) => {
      ratio = ratioOf(m.clamp(m.first + (stacked ? ev.clientY : ev.clientX) - origin), m.total);
      apply(m.areas, ratio);
    };
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      document.body.style.cursor = cursor;
      if (ratio !== null) setToolWindowSplit(anchor, ratio);
      // Back to the store's value (unchanged when the ratio was clamped to it).
      apply(m.areas, useToolWindowLayout.getState().splits[anchor]);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = (stacked ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"]).indexOf(e.key);
    const m = measure(e.currentTarget);
    if (dir < 0 || !m) return;
    e.preventDefault();
    setToolWindowSplit(anchor, ratioOf(m.clamp(m.first + (dir ? 1 : -1) * KEY_STEP), m.total));
  };

  return (
    <div
      role="separator"
      aria-orientation={stacked ? "horizontal" : "vertical"}
      aria-label={`Resize ${anchor} tool window split`}
      tabIndex={0}
      hidden={hidden}
      className={clsx(styles.gap, styles.splitGap)}
      data-split-handle={anchor}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}

/**
 * One side's tool windows: the primary area and the split area, each an
 * island; with both showing they share the side at the stored ratio.
 */
function SidePanel({
  anchor,
  windows,
  visible,
}: {
  anchor: ToolWindowAnchor;
  windows: ToolWindowContribution[];
  visible: SlotRecord;
}) {
  const mounted = useToolWindowLayout((s) => s.mounted);
  const split = !!visible[anchor] && !!visible[`${anchor}-split`];
  // A lone area takes the whole side: flex-grow below 1 would leave the rest empty.
  const ratio = useToolWindowLayout((s) => s.splits[anchor]);
  const area = (slot: ToolWindowSlot, grow: number) => {
    const visibleId = visible[slot];
    const list = windows.filter((w) => slotOf(w) === slot && (mounted.has(w.id) || w.id === visibleId));
    if (!list.length) return null;
    return (
      <div
        className={clsx(styles.island, styles.anchor)}
        // The stored ratio; SplitHandle moves it directly while dragging.
        style={{ flexGrow: grow }}
        data-slot={slot}
        hidden={!visibleId}
      >
        {list.map((w) => (
          <ToolWindowView key={w.id} tw={w} hidden={w.id !== visibleId} windows={windows} />
        ))}
      </div>
    );
  };
  return (
    <div className={clsx(styles.side, anchor === "bottom" && styles.sideRow)} data-anchor={anchor}>
      {area(anchor, split ? ratio : 1)}
      <SplitHandle anchor={anchor} hidden={!split} />
      {area(`${anchor}-split`, split ? 1 - ratio : 1)}
    </div>
  );
}

/** Windows shown on side `a`, primary area first. */
function visibleOn(visible: SlotRecord, a: ToolWindowAnchor): string[] {
  return [visible[a], visible[`${a}-split`]].filter((id): id is string => !!id);
}

const sideVisible = (visible: SlotRecord, a: ToolWindowAnchor) => !!(visible[a] || visible[`${a}-split`]);

/** Writes the grid's track variables from the store; the grid itself squeezes tracks when the window is small. */
function syncTracks(grid: HTMLElement, visible: SlotRecord) {
  const s = useToolWindowLayout.getState();
  for (const a of ["left", "right", "bottom"] as const) {
    const shown = sideVisible(visible, a);
    const size = !shown ? "0px" : s.maximized === a ? MAXIMIZED[a] : `${s.sizes[a]}px`;
    grid.style.setProperty(`--tw-${a}`, size);
    grid.style.setProperty(`--gap-${a}`, shown ? "var(--island-gap)" : "0px");
  }
}

/**
 * Resize handle in the gap next to a side's islands. Moves only a CSS variable
 * while dragging; the remembered size is stored on release.
 */
function GapHandle({
  anchor,
  visibleIds,
  gridRef,
  editorRef,
  sync,
}: {
  anchor: ToolWindowAnchor;
  /** Windows shown on this side (primary and split area). */
  visibleIds: string[];
  gridRef: RefObject<HTMLDivElement | null>;
  editorRef: RefObject<HTMLDivElement | null>;
  sync: () => void;
}) {
  const vertical = anchor !== "bottom";
  const sign = anchor === "left" ? 1 : -1;
  const measure = () => {
    const island = gridRef.current?.querySelector<HTMLElement>(`[data-anchor="${anchor}"]`);
    const editor = editorRef.current;
    if (!island || !editor) return null;
    const size = vertical ? island.offsetWidth : island.offsetHeight;
    const spare = vertical ? editor.offsetWidth - EDITOR_MIN.width : editor.offsetHeight - EDITOR_MIN.height;
    return { size, max: size + Math.max(0, spare) };
  };
  const clamp = (raw: number, max: number) => Math.min(max, Math.max(MIN[anchor], raw));
  const commit = (px: number) => {
    const s = useToolWindowLayout.getState();
    if (visibleIds[0] && s.maximized === anchor) toggleMaximizeToolWindow(visibleIds[0]);
    setToolWindowSize(anchor, px);
    sync();
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const grid = gridRef.current;
    const m = measure();
    if (e.button !== 0 || !grid || !m || !visibleIds.length) return;
    // No focus (and so no focus ring) or text selection from a mouse drag.
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const origin = vertical ? e.clientX : e.clientY;
    const cursor = document.body.style.cursor;
    document.body.style.cursor = vertical ? "col-resize" : "row-resize";
    let next = m.size;
    const move = (ev: globalThis.PointerEvent) => {
      const raw = m.size + sign * ((vertical ? ev.clientX : ev.clientY) - origin);
      // Dragged past half the minimum: collapse, as IDEA does.
      next = raw < MIN[anchor] / 2 ? 0 : clamp(raw, m.max);
      grid.style.setProperty(`--tw-${anchor}`, `${next}px`);
    };
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      document.body.style.cursor = cursor;
      if (next === 0) visibleIds.forEach(hideToolWindow);
      else if (next !== m.size) commit(next);
      else sync();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = vertical ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    const dir = keys.indexOf(e.key);
    const m = measure();
    if (dir < 0 || !m) return;
    e.preventDefault();
    commit(clamp(m.size + sign * (dir ? 1 : -1) * KEY_STEP, m.max));
  };

  return (
    <div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={`Resize ${anchor} tool window`}
      tabIndex={0}
      hidden={!visibleIds.length}
      className={styles.gap}
      data-gap={anchor}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}

/** Settings › Appearance › Tool Windows (raw settings: the workbench does not depend on the settings feature). */
function useWidescreen() {
  return useProject((s) => s.settings?.appearance?.widescreenToolWindows === true);
}

/**
 * The Islands frame below the title bar: side tool windows and the editor as rounded islands in
 * one row, bottom tool windows as a full-width island underneath (or, with "Widescreen tool
 * window layout", between the side windows). No stripes: each area's windows are the tabs of its
 * header, and closed areas open from the title bar, the status bar or their shortcuts. Resize
 * handles sit in the gaps between islands. A CSS grid does the layout, so a window resize costs
 * no script.
 */
export function ToolWindowLayout({ editor }: { editor: ReactNode }) {
  const windows = useToolWindows();
  const visible = useEffectiveVisible(windows);
  const widescreen = useWidescreen();
  const sizes = useToolWindowLayout((s) => s.sizes);
  const maximized = useToolWindowLayout((s) => s.maximized);
  const gridRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const sync = () => {
    if (gridRef.current) syncTracks(gridRef.current, visible);
  };
  useLayoutEffect(sync, [visible, sizes, maximized]);

  const gap = (anchor: ToolWindowAnchor) => (
    <GapHandle
      anchor={anchor}
      visibleIds={visibleOn(visible, anchor)}
      gridRef={gridRef}
      editorRef={editorRef}
      sync={sync}
    />
  );
  return (
    <div className={styles.frame}>
      <div ref={gridRef} className={clsx(styles.grid, widescreen && styles.widescreen)}>
        <SidePanel anchor="left" windows={windows} visible={visible} />
        {gap("left")}
        <div ref={editorRef} className={clsx(styles.island, styles.editorIsland)} data-editor-island="">
          {editor}
        </div>
        {gap("right")}
        <SidePanel anchor="right" windows={windows} visible={visible} />
        {gap("bottom")}
        <SidePanel anchor="bottom" windows={windows} visible={visible} />
      </div>
    </div>
  );
}
