/**
 * A directed graph view (IDEA's diagrams, read-only): nodes with an icon, a label and a
 * muted detail, edges with optional labels, laid out by ELK's layered algorithm. Wheel or
 * trackpad scroll pans, ⌘/Ctrl + wheel (and pinch) zooms at the pointer, dragging the
 * background pans. A new layout moves the nodes there (≈200 ms) instead of jumping.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import clsx from "clsx";
import { iconMarkup } from "../icons";
import {
  fitTransform,
  layoutGraph,
  lerpPoints,
  roundedPath,
  type Direction,
  type GraphLayout,
  type LaidOutEdge,
  type LaidOutNode,
} from "./layout";
import styles from "./GraphView.module.css";

export type GraphTone = "default" | "library" | "test" | "muted";

export interface GraphNode {
  id: string;
  label: string;
  detail?: string;
  icon?: string;
  tone?: GraphTone;
  /** What it stands for may not exist (a conditional bean): drawn dashed and dimmed. */
  uncertain?: boolean;
  /** Spoken and shown on hover. */
  title?: string;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  /** `cycle` is drawn in the error colour. */
  tone?: "default" | "cycle";
  dashed?: boolean;
}

export interface GraphViewHandle {
  /** Zooms to show the whole graph (never enlarged past 100 %). */
  fit(): void;
  /** Lays the graph out again. */
  relayout(): void;
  /** Zooms in (1) or out (-1) around the centre. */
  zoom(direction: 1 | -1): void;
}

export interface GraphViewProps {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  /** Double-click / Enter on a node. */
  onActivate?: (id: string) => void;
  onContextMenu?: (id: string, e: React.MouseEvent) => void;
  direction?: Direction;
  className?: string;
  "aria-label": string;
}

const NODE_HEIGHT = 28;
const PAD_X = 10;
const ICON = 16;
const GAP = 6;
const MAX_LABEL = 220;
const DURATION = 200;

let canvas: CanvasRenderingContext2D | null | undefined;
function textWidth(text: string): number {
  if (canvas === undefined) {
    try {
      const ctx = document.createElement("canvas").getContext("2d");
      if (ctx) {
        const family = getComputedStyle(document.documentElement).getPropertyValue("--font-ui").trim() || "sans-serif";
        ctx.font = `12px ${family}`;
      }
      canvas = ctx;
    } catch {
      canvas = null;
    }
  }
  return canvas ? canvas.measureText(text).width : text.length * 6.6;
}

function nodeWidth(n: GraphNode): number {
  const label = Math.min(MAX_LABEL, textWidth(n.label));
  const detail = n.detail ? Math.min(MAX_LABEL, textWidth(n.detail)) + GAP : 0;
  return Math.ceil(PAD_X * 2 + (n.icon ? ICON + GAP : 0) + label + detail);
}

const ease = (t: number) => 1 - Math.pow(1 - t, 3);

interface Shown {
  nodes: Map<string, LaidOutNode & { opacity: number }>;
  edges: Map<string, LaidOutEdge & { opacity: number }>;
}

export const GraphView = forwardRef<GraphViewHandle, GraphViewProps>(function GraphView(props, ref) {
  const { nodes, edges, selected = null, onSelect, onActivate, onContextMenu, direction = "DOWN" } = props;
  const host = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<GraphLayout | null>(null);
  const [shown, setShown] = useState<Shown>({ nodes: new Map(), edges: new Map() });
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const [generation, setGeneration] = useState(0);
  const fitted = useRef(false);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  // The structure laid out: node sizes and edges (not selection or tones).
  const signature = useMemo(
    () =>
      JSON.stringify([
        nodes.map((n) => [n.id, n.label, n.detail ?? "", !!n.icon]),
        edges.map((e) => [e.id, e.from, e.to, e.label ?? ""]),
        direction,
      ]),
    [nodes, edges, direction],
  );

  useEffect(() => {
    let cancelled = false;
    const specs = nodes.map((n) => ({ id: n.id, width: nodeWidth(n), height: NODE_HEIGHT }));
    const edgeSpecs = edges.map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      label: e.label ? { width: Math.ceil(textWidth(e.label) * 0.92) + 8, height: 14 } : undefined,
    }));
    void layoutGraph(specs, edgeSpecs, direction).then((l) => {
      if (!cancelled) setLayout(l);
    });
    return () => {
      cancelled = true;
    };
    // `signature` stands for nodes / edges / direction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, generation]);

  // Moves what is shown to the new layout.
  useEffect(() => {
    if (!layout) return;
    const from = shownRef.current;
    const start = performance.now();
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    const step = (now: number) => {
      const t = reduced || !from.nodes.size ? 1 : ease(Math.min(1, (now - start) / DURATION));
      const nodesNow = new Map<string, LaidOutNode & { opacity: number }>();
      for (const [id, n] of layout.nodes) {
        const was = from.nodes.get(id);
        nodesNow.set(id, {
          ...n,
          x: was ? was.x + (n.x - was.x) * t : n.x,
          y: was ? was.y + (n.y - was.y) * t : n.y,
          opacity: was ? 1 : t,
        });
      }
      const edgesNow = new Map<string, LaidOutEdge & { opacity: number }>();
      for (const [id, e] of layout.edges) {
        const was = from.edges.get(id);
        edgesNow.set(id, {
          ...e,
          points: was ? lerpPoints(was.points, e.points, t) : e.points,
          label:
            e.label && was?.label
              ? { x: was.label.x + (e.label.x - was.label.x) * t, y: was.label.y + (e.label.y - was.label.y) * t }
              : e.label,
          opacity: was ? 1 : t,
        });
      }
      setShown({ nodes: nodesNow, edges: edgesNow });
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [layout]);

  const fit = useCallback(() => {
    const el = host.current;
    if (!el || !layout) return;
    setView(fitTransform(layout, { width: el.clientWidth, height: el.clientHeight }));
  }, [layout]);

  // The first layout is shown whole.
  useLayoutEffect(() => {
    if (layout && !fitted.current) {
      fitted.current = true;
      fit();
    }
  }, [layout, fit]);

  const zoomAt = useCallback((factor: number, px: number, py: number) => {
    setView((v) => {
      const k = Math.max(0.1, Math.min(3, v.k * factor));
      const f = k / v.k;
      return { k, x: px - (px - v.x) * f, y: py - (py - v.y) * f };
    });
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      fit,
      relayout: () => setGeneration((g) => g + 1),
      zoom: (dir) => {
        const el = host.current;
        if (el) zoomAt(dir > 0 ? 1.25 : 0.8, el.clientWidth / 2, el.clientHeight / 2);
      },
    }),
    [fit, zoomAt],
  );

  // Wheel: pan; ⌘/Ctrl (and pinch, which arrives as ctrl + wheel): zoom at the pointer.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest("[data-node]")) return;
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) onSelect?.(null);
  };

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const edgeById = useMemo(() => new Map(edges.map((e) => [e.id, e])), [edges]);
  // Edges of the selected node stand out.
  const related = useMemo(
    () => new Set(selected ? edges.filter((e) => e.from === selected || e.to === selected).map((e) => e.id) : []),
    [edges, selected],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && selected) onActivate?.(selected);
    else if (e.key === "Escape") onSelect?.(null);
    else if ((e.key === "=" || e.key === "+") && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const el = host.current;
      if (el) zoomAt(1.25, el.clientWidth / 2, el.clientHeight / 2);
    } else if (e.key === "-" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const el = host.current;
      if (el) zoomAt(0.8, el.clientWidth / 2, el.clientHeight / 2);
    }
  };

  return (
    <div
      ref={host}
      className={clsx(styles.host, props.className)}
      tabIndex={0}
      role="application"
      aria-label={props["aria-label"]}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <svg className={styles.svg} width="100%" height="100%">
        <defs>
          <marker
            id="luma-graph-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,1 L9,5 L0,9 z" className={styles.arrow} />
          </marker>
          <marker
            id="luma-graph-arrow-strong"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,1 L9,5 L0,9 z" className={styles.arrowStrong} />
          </marker>
          <marker
            id="luma-graph-arrow-cycle"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,1 L9,5 L0,9 z" className={styles.arrowCycle} />
          </marker>
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {[...shown.edges.values()].map((e) => {
            const spec = edgeById.get(e.id);
            if (!spec) return null;
            const strong = related.has(e.id);
            const cycle = spec.tone === "cycle";
            return (
              <g
                key={e.id}
                className={clsx(styles.edge, strong && styles.strong, cycle && styles.cycle)}
                style={{ opacity: e.opacity }}
              >
                <path
                  d={roundedPath(e.points)}
                  strokeDasharray={spec.dashed ? "4 3" : undefined}
                  markerEnd={`url(#luma-graph-arrow${cycle ? "-cycle" : strong ? "-strong" : ""})`}
                />
                {spec.label && e.label && (
                  <text
                    x={e.label.x}
                    y={e.label.y}
                    className={styles.edgeLabel}
                    textAnchor="middle"
                    dominantBaseline="central"
                  >
                    {spec.label}
                  </text>
                )}
              </g>
            );
          })}
          {[...shown.nodes.values()].map((n) => {
            const spec = byId.get(n.id);
            if (!spec) return null;
            const label = truncate(spec.label);
            const detail = spec.detail ? truncate(spec.detail) : null;
            let x = PAD_X;
            const iconX = x;
            if (spec.icon) x += ICON + GAP;
            const labelX = x;
            const detailX = labelX + Math.min(MAX_LABEL, textWidth(spec.label)) + GAP;
            return (
              <g
                key={n.id}
                data-node={n.id}
                role="button"
                aria-label={spec.title ?? spec.label}
                aria-pressed={selected === n.id}
                className={clsx(
                  styles.node,
                  spec.tone && spec.tone !== "default" && styles[spec.tone],
                  spec.uncertain && styles.uncertain,
                  selected === n.id && styles.selected,
                )}
                transform={`translate(${n.x},${n.y})`}
                style={{ opacity: n.opacity * (spec.uncertain ? 0.7 : 1) }}
                onPointerDown={(e) => {
                  if (e.button === 0) onSelect?.(n.id);
                }}
                onDoubleClick={() => onActivate?.(n.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onSelect?.(n.id);
                  onContextMenu?.(n.id, e);
                }}
              >
                <title>{spec.title ?? (spec.detail ? `${spec.label} · ${spec.detail}` : spec.label)}</title>
                <rect width={n.width} height={n.height} rx={6} />
                {spec.icon && (
                  <g
                    transform={`translate(${iconX},${(n.height - ICON) / 2})`}
                    dangerouslySetInnerHTML={{ __html: iconMarkup(spec.icon, ICON) ?? "" }}
                  />
                )}
                <text x={labelX} y={n.height / 2} dominantBaseline="central" className={styles.label}>
                  {label}
                </text>
                {detail && (
                  <text x={detailX} y={n.height / 2} dominantBaseline="central" className={styles.detail}>
                    {detail}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
});

function truncate(text: string): string {
  if (textWidth(text) <= MAX_LABEL) return text;
  let s = text;
  while (s.length > 1 && textWidth(`${s}…`) > MAX_LABEL) s = s.slice(0, -1);
  return `${s}…`;
}
