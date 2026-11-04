/**
 * The fullscreen media viewer: an image or a Mermaid diagram over a dimmed window, zoomed,
 * panned and rotated without touching the document it came from. Keys: `+`/`-` zoom, `0`
 * fit, `W` fit width, `1` actual size, `R` rotate, arrows pan, Esc closes; ⌘/Ctrl+wheel or a
 * pinch zooms at the pointer, the wheel and dragging pan, a double click toggles fit ↔ 100%.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import clsx from "clsx";
import { registerKeyClaim } from "@/platform/keymap";
import { tx } from "@/platform/i18n";
import { IconButton } from "@/ui";
import { openLayer, trapTab } from "@/ui/popupState";
import { clampZoom, fitZoom, stepZoom, zoomAt, zoomLabel, type View } from "../../imageZoom";
import { cleanSvg } from "./cleanSvg";
import type { MediaItem } from "./mediaViewer";
import styles from "./MediaViewerDialog.module.css";

/** Room kept around the content when fitting. */
const MARGIN = 32;
/** Padding of a diagram's card, in content pixels (scales with it). */
const CARD_PAD = 24;
/** A fitted diagram may grow up to this; a raster image never beyond its own size. */
const SVG_FIT_CAP = 2;
/** Pixels the arrow keys pan by. */
const PAN_STEP = 48;
/** A pointer that moves less than this between down and up clicked, not dragged. */
const CLICK_SLOP = 4;
const CLOSE_MS = 140;

type Fit = "window" | "width" | null;

let svgSeq = 0;

export function MediaViewerDialog({ item, onClose }: { item: MediaItem; onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [rasterSize, setRasterSize] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setViewState] = useState<View | null>(null);
  const [rot, setRot] = useState(0);
  const [fit, setFit] = useState<Fit>("window");
  const [animate, setAnimate] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [closing, setClosing] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; sx: number; sy: number; moved: boolean } | null>(null);

  const svg = useMemo(
    () => (item.kind === "svg" ? cleanSvg(item.svg, `mv${++svgSeq}`) : null),
    // The item never changes for one mount (a new item remounts).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const isSvg = item.kind === "svg";
  const natural = useMemo(
    () => (isSvg ? svg && { w: svg.width + CARD_PAD * 2, h: svg.height + CARD_PAD * 2 } : rasterSize),
    [isSvg, svg, rasterSize],
  );
  const broken = failed || (isSvg && !svg);

  /** The rotated content's bounding box at zoom 1. */
  const box = useCallback(
    (r = rot) => (natural ? (r % 2 ? { w: natural.h, h: natural.w } : { w: natural.w, h: natural.h }) : null),
    [natural, rot],
  );
  const canvasSize = () => {
    const el = canvasRef.current;
    return { w: el?.clientWidth ?? 0, h: el?.clientHeight ?? 0 };
  };

  /** Keeps some of the content in view: a smaller side stays inside, a larger one covers the canvas. */
  const constrain = useCallback(
    (v: View, r = rot): View => {
      const b = box(r);
      if (!b) return v;
      const c = canvasSize();
      const dw = b.w * v.z;
      const dh = b.h * v.z;
      const clampAxis = (pos: number, d: number, size: number) =>
        d <= size ? Math.min(Math.max(pos, 0), size - d) : Math.min(Math.max(pos, size - d - MARGIN), MARGIN);
      return { z: v.z, x: clampAxis(v.x, dw, c.w), y: clampAxis(v.y, dh, c.h) };
    },
    [box, rot],
  );

  /** The view for `kind` fit at rotation `r`: centred, a taller-than-window one from its top. */
  const fitted = useCallback(
    (kind: Exclude<Fit, null>, r = rot): View | null => {
      const b = box(r);
      if (!b) return null;
      const c = canvasSize();
      const aw = Math.max(1, c.w - MARGIN * 2);
      const ah = Math.max(1, c.h - MARGIN * 2);
      const z = kind === "width" ? clampZoom(aw / b.w) : Math.min(isSvg ? SVG_FIT_CAP : 1, fitZoom(b.w, b.h, aw, ah));
      const dh = b.h * z;
      return { z, x: (c.w - b.w * z) / 2, y: dh <= c.h ? (c.h - dh) / 2 : MARGIN };
    },
    [box, isSvg, rot],
  );

  const setView = useCallback((v: View | null, animated: boolean) => {
    setAnimate(animated);
    setViewState(v);
  }, []);

  const applyFit = useCallback(
    (kind: Exclude<Fit, null>, r = rot, animated = true) => {
      const v = fitted(kind, r);
      if (!v) return;
      setFit(kind);
      setView(v, animated);
    },
    [fitted, rot, setView],
  );

  // First view, once the size is known.
  useLayoutEffect(() => {
    if (natural && !view) applyFit("window", rot, false);
  }, [natural, view, applyFit, rot]);

  // A fitted view stays fitted when the window resizes.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (fit) applyFit(fit, rot, false);
      else setViewState((v) => v && constrain(v));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, rot, applyFit, constrain]);

  const zoomTo = useCallback(
    (z: number, px?: number, py?: number, animated = true) => {
      setViewState((v) => {
        if (!v) return v;
        const c = canvasSize();
        const next = constrain(zoomAt(v, clampZoom(z), px ?? c.w / 2, py ?? c.h / 2));
        setAnimate(animated);
        return next;
      });
      setFit(null);
    },
    [constrain],
  );
  const zoomStep = useCallback((dir: 1 | -1) => view && zoomTo(stepZoom(view.z, dir)), [view, zoomTo]);
  const actualSize = useCallback(() => {
    const b = box();
    if (!b) return;
    const c = canvasSize();
    setFit(null);
    setView(constrain({ z: 1, x: (c.w - b.w) / 2, y: b.h <= c.h ? (c.h - b.h) / 2 : MARGIN }), true);
  }, [box, constrain, setView]);
  const rotate = useCallback(
    (dir: 1 | -1) => {
      const r = (rot + dir + 4) % 4;
      setRot(r);
      const kind = fit ?? "window";
      if (fit || !view) applyFit(kind, r);
      else {
        // Keep the zoom, re-centred on the canvas.
        const b = box(r)!;
        const c = canvasSize();
        setView(constrain({ z: view.z, x: (c.w - b.w * view.z) / 2, y: (c.h - b.h * view.z) / 2 }, r), true);
      }
    },
    [rot, fit, view, applyFit, box, constrain, setView],
  );
  const reset = useCallback(() => {
    setRot(0);
    applyFit("window", 0);
  }, [applyFit]);

  const requestClose = useCallback(() => {
    if (closing) return;
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return onClose();
    setClosing(true);
    setTimeout(onClose, CLOSE_MS);
  }, [closing, onClose]);

  // Modal: a layer of its own, the IDE's shortcuts held off, focus kept inside and given back.
  const pan = useCallback(
    (dx: number, dy: number) => {
      setFit(null);
      setAnimate(true);
      setViewState((v) => v && constrain({ ...v, x: v.x + dx, y: v.y + dy }));
    },
    [constrain],
  );
  const handlers = useRef({ zoomStep, applyFit, actualSize, rotate, requestClose, pan });
  useLayoutEffect(() => {
    handlers.current = { zoomStep, applyFit, actualSize, rotate, requestClose, pan };
  });
  useEffect(() => {
    const layer = openLayer(() => rootRef.current);
    const releaseKeys = registerKeyClaim(() => layer.isTop());
    const previous = document.activeElement as HTMLElement | null;
    rootRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      const root = rootRef.current;
      if (!layer.isTop() || !root) return;
      const h = handlers.current;
      if (e.key === "Tab") {
        if (!trapTab(e, root)) e.preventDefault();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        h.requestClose();
        return;
      }
      if (e.altKey || e.isComposing) return;
      // Buttons keep Enter / Space.
      if ((e.key === "Enter" || e.key === " ") && e.target instanceof HTMLButtonElement) return;
      const mod = e.metaKey || e.ctrlKey;
      let handled = true;
      switch (e.key) {
        case "+":
        case "=":
          h.zoomStep(1);
          break;
        case "-":
        case "_":
          h.zoomStep(-1);
          break;
        case "0":
          h.applyFit("window");
          break;
        case "1":
          if (mod) handled = false;
          else h.actualSize();
          break;
        case "w":
        case "W":
          if (mod) handled = false;
          else h.applyFit("width");
          break;
        case "r":
        case "R":
          if (mod) handled = false;
          else h.rotate(e.shiftKey ? -1 : 1);
          break;
        case "ArrowLeft":
          h.pan(PAN_STEP, 0);
          break;
        case "ArrowRight":
          h.pan(-PAN_STEP, 0);
          break;
        case "ArrowUp":
          h.pan(0, PAN_STEP);
          break;
        case "ArrowDown":
          h.pan(0, -PAN_STEP);
          break;
        default:
          handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      releaseKeys();
      layer.release();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  // Wheel: pans; with ⌘/Ctrl (a trackpad pinch sets ctrlKey) zooms at the pointer. Native, so it can preventDefault.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      const rect = el.getBoundingClientRect();
      if (e.metaKey || e.ctrlKey) {
        const factor = Math.exp(-e.deltaY * unit * 0.01);
        setFit(null);
        setAnimate(false);
        setViewState(
          (v) => v && constrain(zoomAt(v, clampZoom(v.z * factor), e.clientX - rect.left, e.clientY - rect.top)),
        );
      } else {
        setAnimate(false);
        setViewState((v) => v && constrain({ ...v, x: v.x - e.deltaX * unit, y: v.y - e.deltaY * unit }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [constrain]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < CLICK_SLOP) return;
    if (!d.moved) {
      d.moved = true;
      setDragging(true);
    }
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    setFit(null);
    setAnimate(false);
    setViewState((v) => v && constrain({ ...v, x: v.x + dx, y: v.y + dy }));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    // A click on the dimmed area (not the content) closes.
    if (!d.moved && !stageRef.current?.contains(e.target as Node)) requestClose();
  };
  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!view || !stageRef.current?.contains(e.target as Node)) return;
    const fitView = fitted("window");
    const rect = canvasRef.current!.getBoundingClientRect();
    const atFit = fitView && Math.abs(view.z - fitView.z) < 0.01;
    if (!atFit) return applyFit("window");
    const target = Math.abs(fitView.z - 1) < 0.01 ? 2 : 1;
    zoomTo(target, e.clientX - rect.left, e.clientY - rect.top);
  };

  // Rotated content: the stage is laid out unrotated, then turned about its centre inside its box.
  const stageStyle = (() => {
    if (!natural || !view) return { visibility: "hidden" as const };
    const b = box()!;
    const w = natural.w * view.z;
    const h = natural.h * view.z;
    return {
      width: w,
      height: h,
      transform: `translate(${view.x + (b.w * view.z) / 2}px, ${view.y + (b.h * view.z) / 2}px) rotate(${rot * 90}deg) translate(${-w / 2}px, ${-h / 2}px)`,
      ...(isSvg ? { padding: CARD_PAD * view.z } : {}),
    };
  })();

  const label = isSvg ? tx("Diagram Preview") : tx("Image Preview");
  const zoom = view ? zoomLabel(view.z) : "";
  const size = !isSvg && rasterSize ? `${rasterSize.w} × ${rasterSize.h}` : null;

  return (
    <div
      ref={rootRef}
      className={clsx(styles.root, closing && styles.closing)}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
    >
      <div className={styles.header}>
        <div className={styles.toolbar} role="toolbar" aria-label={label}>
          <IconButton icon="zoom-out" size="small" title="Zoom Out" shortcut="-" onClick={() => zoomStep(-1)} />
          <span className={styles.zoom} aria-live="polite">
            {zoom}
          </span>
          <IconButton icon="zoom-in" size="small" title="Zoom In" shortcut="+" onClick={() => zoomStep(1)} />
          <span className={styles.separator} />
          <IconButton
            icon="maximize"
            size="small"
            title="Fit to Window"
            shortcut="0"
            pressed={fit === "window"}
            onClick={() => applyFit("window")}
          />
          <IconButton
            icon="fit-width"
            size="small"
            title="Fit to Width"
            shortcut="W"
            pressed={fit === "width"}
            onClick={() => applyFit("width")}
          />
          <IconButton icon="actual-size" size="small" title="Actual Size" shortcut="1" onClick={actualSize} />
          <span className={styles.separator} />
          <IconButton icon="rotate" size="small" title="Rotate" shortcut="R" onClick={() => rotate(1)} />
          <IconButton icon="refresh" size="small" title="Reset" onClick={reset} />
          <span className={styles.separator} />
          <IconButton icon="close" size="small" title="Close" shortcut="Esc" onClick={requestClose} />
        </div>
      </div>
      <div
        ref={canvasRef}
        className={clsx(styles.canvas, dragging && styles.dragging)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
      >
        {broken ? (
          <div className={styles.message}>{isSvg ? tx("Cannot show the diagram") : tx("Cannot load the image")}</div>
        ) : (
          <div
            ref={stageRef}
            className={clsx(
              styles.stage,
              isSvg && styles.card,
              animate && styles.animate,
              !isSvg && view && view.z >= 4 && styles.pixelated,
            )}
            style={stageStyle}
          >
            {item.kind === "image" ? (
              <img
                className={styles.media}
                src={item.src}
                alt={item.name}
                draggable={false}
                onLoad={(e) =>
                  setRasterSize({ w: e.currentTarget.naturalWidth || 300, h: e.currentTarget.naturalHeight || 150 })
                }
                onError={() => setFailed(true)}
              />
            ) : (
              svg && (
                <div
                  className={styles.media}
                  // Cleaned by `cleanSvg`: no scripts, handlers or external references.
                  dangerouslySetInnerHTML={{ __html: svg.markup }}
                />
              )
            )}
          </div>
        )}
      </div>
      {/* The name below the picture: the top-left corner belongs to the window's own buttons. */}
      <div className={styles.caption} title={item.name || label}>
        <span className={styles.name}>{item.name || label}</span>
        {size && <span className={styles.size}>{size}</span>}
      </div>
    </div>
  );
}
