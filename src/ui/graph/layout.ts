/**
 * Layered layout of a directed graph (ELK's `layered` algorithm, elkjs), in the graph's own
 * coordinates: node boxes, edge polylines and label positions. Pure apart from the layout
 * engine, which loads on first use.
 */
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";

export interface GraphNodeSpec {
  id: string;
  width: number;
  height: number;
}

export interface GraphEdgeSpec {
  id: string;
  from: string;
  to: string;
  /** Label size (none when absent). */
  label?: { width: number; height: number };
}

export interface Point {
  x: number;
  y: number;
}

export interface LaidOutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaidOutEdge {
  id: string;
  /** Start, bends, end. */
  points: Point[];
  label: Point | null;
}

export interface GraphLayout {
  nodes: Map<string, LaidOutNode>;
  edges: Map<string, LaidOutEdge>;
  width: number;
  height: number;
}

export type Direction = "DOWN" | "RIGHT";

type Elk = { layout(graph: ElkNode): Promise<ElkNode> };
let elk: Promise<Elk> | null = null;

function engine(): Promise<Elk> {
  elk ??= import("elkjs/lib/elk.bundled.js").then((m) => new m.default());
  return elk;
}

const OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.spacing.nodeNodeBetweenLayers": "72",
  "elk.spacing.nodeNode": "28",
  "elk.spacing.edgeNode": "18",
  "elk.spacing.edgeEdge": "12",
  "elk.spacing.edgeLabel": "4",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.edgeLabels.inline": "true",
  "elk.padding": "[top=24,left=24,bottom=24,right=24]",
  // Disconnected parts side by side, not one long row.
  "elk.separateConnectedComponents": "true",
  "elk.spacing.componentComponent": "48",
};

export async function layoutGraph(
  nodes: readonly GraphNodeSpec[],
  edges: readonly GraphEdgeSpec[],
  direction: Direction = "DOWN",
): Promise<GraphLayout> {
  const known = new Set(nodes.map((n) => n.id));
  const graph: ElkNode = {
    id: "root",
    layoutOptions: { ...OPTIONS, "elk.direction": direction },
    children: nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    edges: edges
      .filter((e) => known.has(e.from) && known.has(e.to))
      .map((e): ElkExtendedEdge => ({
        id: e.id,
        sources: [e.from],
        targets: [e.to],
        labels: e.label ? [{ id: `${e.id}:label`, width: e.label.width, height: e.label.height }] : [],
      })),
  };
  const out = await (await engine()).layout(graph);
  const laidNodes = new Map<string, LaidOutNode>();
  for (const c of out.children ?? [])
    laidNodes.set(c.id, { id: c.id, x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? 0, height: c.height ?? 0 });
  const laidEdges = new Map<string, LaidOutEdge>();
  for (const e of (out.edges ?? []) as ElkExtendedEdge[]) {
    const s = e.sections?.[0];
    if (!s) continue;
    const points = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => ({ x: p.x, y: p.y }));
    laidEdges.set(e.id, { id: e.id, points, label: labelPoint(points) });
  }
  return { nodes: laidNodes, edges: laidEdges, width: out.width ?? 0, height: out.height ?? 0 };
}

/**
 * Where an edge's label goes: the middle of its last segment (the one entering the target,
 * which edges leaving one node do not share).
 */
export function labelPoint(points: readonly Point[]): Point | null {
  if (points.length < 2) return null;
  const a = points[points.length - 2]!;
  const b = points[points.length - 1]!;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** An SVG path through `points` with rounded corners (radius `r`). */
export function roundedPath(points: readonly Point[], r = 6): string {
  if (points.length < 2) return "";
  let d = `M${points[0]!.x},${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i - 1]!;
    const c = points[i]!;
    const n = points[i + 1]!;
    const d1 = Math.hypot(c.x - p.x, c.y - p.y);
    const d2 = Math.hypot(n.x - c.x, n.y - c.y);
    const k = Math.min(r, d1 / 2, d2 / 2);
    const a = { x: c.x - ((c.x - p.x) / (d1 || 1)) * k, y: c.y - ((c.y - p.y) / (d1 || 1)) * k };
    const b = { x: c.x + ((n.x - c.x) / (d2 || 1)) * k, y: c.y + ((n.y - c.y) / (d2 || 1)) * k };
    d += ` L${a.x},${a.y} Q${c.x},${c.y} ${b.x},${b.y}`;
  }
  const last = points[points.length - 1]!;
  return `${d} L${last.x},${last.y}`;
}

/** `from` → `to` at `t` (0…1), points matched by index (the shorter one repeats its end). */
export function lerpPoints(from: readonly Point[], to: readonly Point[], t: number): Point[] {
  const n = Math.max(from.length, to.length);
  const at = (list: readonly Point[], i: number) => list[Math.min(i, list.length - 1)]!;
  return Array.from({ length: n }, (_, i) => {
    const a = at(from, i);
    const b = at(to, i);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  });
}

/** The zoom and offset showing `box` centred in a `viewport`, never enlarged past 1. */
export function fitTransform(
  box: { width: number; height: number },
  viewport: { width: number; height: number },
  max = 1,
): { k: number; x: number; y: number } {
  if (!box.width || !box.height || !viewport.width || !viewport.height) return { k: 1, x: 0, y: 0 };
  const k = Math.max(0.1, Math.min(max, viewport.width / box.width, viewport.height / box.height));
  return { k, x: (viewport.width - box.width * k) / 2, y: (viewport.height - box.height * k) / 2 };
}
