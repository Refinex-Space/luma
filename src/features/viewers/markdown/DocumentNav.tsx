/**
 * Getting around a Markdown document: the outline beside it (its headings, the one being read
 * highlighted as it scrolls, a click scrolls there) and a back-to-top button once the reader
 * is down the page. Both follow whichever view scrolls: the preview in Preview Only, else the
 * editor (the preview follows it in the split layout).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import clsx from "clsx";
import { create } from "zustand";
import type { EditorView } from "@codemirror/view";
import { editorsFor } from "@/editor/api";
import { IconButton } from "@/ui";
import { useTx } from "@/platform/i18n";
import { useLiveMarkdown } from "./live";
import type { MarkdownMode } from "./modes";
import { activeHeading, markdownHeadings } from "./outline";
import styles from "./Markdown.module.css";

const OUTLINE_KEY = "luma.markdown.outline";
/** Narrower than this, the outline would squeeze the text: it waits behind its toggle. */
const MIN_WIDTH_FOR_OUTLINE = 900;

function storedOpen(): boolean {
  try {
    return localStorage.getItem(OUTLINE_KEY) !== "closed";
  } catch {
    return true;
  }
}

const WIDTH_KEY = "luma.markdown.outlineWidth";
export const OUTLINE_WIDTH = { min: 180, max: 480, initial: 248 };
/** The outline never takes more than this share of the editor. */
const MAX_SHARE = 0.4;

const clampWidth = (w: number) => Math.round(Math.min(OUTLINE_WIDTH.max, Math.max(OUTLINE_WIDTH.min, w)));

function storedWidth(): number {
  try {
    const w = Number(localStorage.getItem(WIDTH_KEY));
    return w ? clampWidth(w) : OUTLINE_WIDTH.initial;
  } catch {
    return OUTLINE_WIDTH.initial;
  }
}

export const useOutline = create<{ open: boolean; width: number }>(() => ({
  open: storedOpen(),
  width: storedWidth(),
}));

export function setOutlineWidth(width: number) {
  const w = clampWidth(width);
  useOutline.setState({ width: w });
  try {
    localStorage.setItem(WIDTH_KEY, String(w));
  } catch {
    // Per-viewer convenience only.
  }
}

/** The outline's left edge: drag (or arrow keys) to resize it, double-click for the initial width. */
function OutlineResizer({ rootRef }: { rootRef: RefObject<HTMLDivElement | null> }) {
  const tx = useTx();
  const width = useOutline((s) => s.width);
  const limit = (w: number) => {
    const room = rootRef.current?.clientWidth;
    return room ? Math.min(w, Math.max(OUTLINE_WIDTH.min, room * MAX_SHARE)) : w;
  };
  return (
    <div
      className={styles.outlineResize}
      role="separator"
      aria-orientation="vertical"
      aria-label={tx("Resize Outline")}
      aria-valuemin={OUTLINE_WIDTH.min}
      aria-valuemax={OUTLINE_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        el.dataset.dragging = "true";
        const startX = e.clientX;
        const startW = useOutline.getState().width;
        const move = (ev: PointerEvent) => setOutlineWidth(limit(startW + startX - ev.clientX));
        const up = () => {
          delete el.dataset.dragging;
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
      }}
      onDoubleClick={() => setOutlineWidth(OUTLINE_WIDTH.initial)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 10;
        if (e.key === "ArrowLeft") setOutlineWidth(limit(width + step));
        else if (e.key === "ArrowRight") setOutlineWidth(limit(width - step));
        else return;
        e.preventDefault();
      }}
    />
  );
}

export function toggleOutline(open = !useOutline.getState().open) {
  useOutline.setState({ open });
  try {
    localStorage.setItem(OUTLINE_KEY, open ? "open" : "closed");
  } catch {
    // Per-viewer convenience only.
  }
}

/** How far below the top the reader's eye is: a heading there is the one being read. */
const readingOffset = (el: HTMLElement) => Math.min(200, el.clientHeight * 0.3);

/** What scrolls in `root` for `mode`, and how lines map to it. */
function target(root: HTMLElement, path: string, mode: MarkdownMode) {
  if (mode === "preview") {
    const preview = root.querySelector<HTMLElement>('[role="document"]');
    if (!preview) return null;
    const blocks = () => [...preview.querySelectorAll<HTMLElement>(":scope > div > [data-line]")];
    return {
      el: preview,
      topLine() {
        let line = 0;
        for (const b of blocks()) {
          if (b.offsetTop > preview.scrollTop + readingOffset(preview)) break;
          line = Number(b.dataset.line);
        }
        return line;
      },
      scrollToLine(n: number) {
        const block = blocks()
          .filter((b) => Number(b.dataset.line) <= n)
          .pop();
        if (block) preview.scrollTo({ top: Math.max(0, block.offsetTop - 12), behavior: "smooth" });
      },
    };
  }
  const view: EditorView | undefined = editorsFor(path).find((h) => root.contains(h.view.dom))?.view;
  if (!view) return null;
  const docTop = () => view.scrollDOM.scrollTop + view.documentTop - view.scrollDOM.getBoundingClientRect().top;
  const offsetOf = (n: number) => {
    const line = view.state.doc.line(Math.min(view.state.doc.lines, n + 1));
    return docTop() + view.lineBlockAt(line.from).top - 12;
  };
  return {
    el: view.scrollDOM,
    topLine() {
      const top = view.scrollDOM.getBoundingClientRect().top + readingOffset(view.scrollDOM) - view.documentTop;
      return view.state.doc.lineAt(view.lineBlockAtHeight(Math.max(0, top)).from).number - 1;
    },
    scrollToLine(n: number) {
      view.scrollDOM.scrollTo({ top: Math.max(0, offsetOf(n)), behavior: "smooth" });
      // Lines far away have estimated heights until drawn: settle on the measured place.
      window.setTimeout(() => {
        const at = Math.max(0, offsetOf(n));
        if (Math.abs(view.scrollDOM.scrollTop - at) > 4) view.scrollDOM.scrollTo({ top: at });
      }, 450);
    },
  };
}

/** Calls `f` (once per frame) when anything scrolls inside `root`. */
function useScroll(root: RefObject<HTMLElement | null>, f: () => void, deps: unknown[]) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let frame = 0;
    const on = () => {
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), f()));
    };
    el.addEventListener("scroll", on, { capture: true, passive: true });
    on();
    return () => {
      el.removeEventListener("scroll", on, { capture: true });
      cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function MarkdownOutline({
  path,
  mode,
  rootRef,
}: {
  path: string;
  mode: MarkdownMode;
  rootRef: RefObject<HTMLDivElement | null>;
}) {
  const tx = useTx();
  const open = useOutline((s) => s.open);
  const width = useOutline((s) => s.width);
  const text = useLiveMarkdown((s) => s[path]?.text ?? "");
  const headings = useMemo(() => markdownHeadings(text), [text]);
  const [active, setActive] = useState(-1);
  const [roomy, setRoomy] = useState(true);
  const list = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setRoomy(el.clientWidth >= MIN_WIDTH_FOR_OUTLINE));
    ro.observe(el);
    return () => ro.disconnect();
  }, [rootRef]);

  useScroll(rootRef, () => {
    const root = rootRef.current;
    const t = root && target(root, path, mode);
    if (!t) return;
    const { scrollTop, clientHeight, scrollHeight } = t.el;
    // At the very top the first heading is current, at the very bottom the last.
    const line = scrollTop <= 2 ? 0 : scrollTop + clientHeight >= scrollHeight - 2 ? Infinity : t.topLine();
    setActive(activeHeading(headings, line));
  }, [rootRef, path, mode, headings]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-current="location"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open || !roomy) return null;
  const min = Math.min(...headings.map((h) => h.level));
  return (
    <aside className={styles.outline} style={{ flexBasis: width }} aria-label={tx("Outline")}>
      <OutlineResizer rootRef={rootRef} />
      <header className={styles.outlineHead}>
        <span>{tx("Outline")}</span>
        <IconButton icon="close" size="small" iconSize={14} title="Hide Outline" onClick={() => toggleOutline(false)} />
      </header>
      {headings.length ? (
        <nav ref={list} className={styles.outlineList}>
          {headings.map((h, i) => (
            <button
              key={`${h.line}:${h.text}`}
              type="button"
              className={clsx(styles.outlineItem, h.level === min && styles.outlineTop)}
              style={{ paddingLeft: 12 + (h.level - min) * 14 }}
              aria-current={i === active ? "location" : undefined}
              title={h.text}
              onClick={() => {
                const root = rootRef.current;
                const t = root && target(root, path, mode);
                if (!t) return;
                setActive(i);
                t.scrollToLine(h.line);
              }}
            >
              {h.text}
            </button>
          ))}
        </nav>
      ) : (
        <div className={styles.outlineEmpty}>{tx("No headings")}</div>
      )}
    </aside>
  );
}

/** Back to the top of whatever scrolls in `rootRef`, shown once the reader is a screen down. */
export function BackToTop({
  path,
  mode,
  rootRef,
}: {
  path: string;
  mode: MarkdownMode;
  rootRef: RefObject<HTMLDivElement | null>;
}) {
  const [shown, setShown] = useState(false);
  useScroll(rootRef, () => {
    const root = rootRef.current;
    const t = root && target(root, path, mode);
    setShown(!!t && t.el.scrollTop > Math.max(400, t.el.clientHeight * 0.6));
  }, [rootRef, path, mode]);
  return (
    <div className={clsx(styles.backToTop, shown && styles.backToTopShown)}>
      <IconButton
        icon="arrow-up"
        title="Back to Top"
        tabIndex={shown ? 0 : -1}
        onClick={() => {
          const root = rootRef.current;
          const t = root && target(root, path, mode);
          t?.el.scrollTo({ top: 0, behavior: "smooth" });
        }}
      />
    </div>
  );
}
