/**
 * The Bean dependency graph (IDEA's Spring Beans Dependencies diagram): beans as nodes,
 * injections as edges labelled @Autowired / @Resource / @Inject / @Bean / creates, cycles in
 * the error colour. Shown in the tool window (one step around the selected bean) and as an
 * editor tab with its toolbar: Show Neighbours of Selected Nodes, Show beans from libraries,
 * Fit, Layout.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { tx as txStatic, useTx } from "@/platform/i18n";
import { call, commands, isTauri, onIdeEvent, type SpringGraph } from "@/platform/ipc";
import { EmptyState, IconButton, ProgressBar, showContextMenu } from "@/ui";
import { GraphView, type GraphEdge, type GraphNode, type GraphViewHandle } from "@/ui/graph/GraphView";
import type { EditorInput } from "@/workbench/contributions";
import { BEAN_ICON, EDGE_LABELS, beanTone } from "./model";
import { openBean, openGraph, type GraphInput } from "./open";
import { revealBean } from "./store";
import styles from "./SpringExplorer.module.css";

export interface BeanGraphProps {
  context: string | null;
  /** Beans to centre on; the whole context when empty. */
  roots: string[];
  depth: number;
  /** Inside the tool window: no toolbar, libraries hidden. */
  compact?: boolean;
}

export function toGraph(g: SpringGraph): { nodes: GraphNode[]; edges: GraphEdge[] } {
  return {
    nodes: g.nodes.map((n) => ({
      id: n.id,
      label: n.name,
      detail: n.typeName !== n.name ? n.typeName : undefined,
      icon: BEAN_ICON,
      tone: beanTone(n),
      uncertain: n.presence !== "certain",
      title: `${n.name} · ${n.typeFqn}\n${n.declaration}`,
    })),
    edges: g.edges.map((e) => ({
      id: `${e.from}>${e.to}:${e.kind}`,
      from: e.from,
      to: e.to,
      label: txStatic(EDGE_LABELS[e.kind]),
      tone: e.cycle ? "cycle" : "default",
      dashed: e.uncertain || e.kind === "creates",
    })),
  };
}

export function BeanGraph({ context, roots, depth, compact = false }: BeanGraphProps) {
  const tx = useTx();
  const [libraries, setLibraries] = useState(false);
  const [extra, setExtra] = useState<{ roots: string[]; depth: number } | null>(null);
  const [graph, setGraph] = useState<SpringGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const view = useRef<GraphViewHandle>(null);
  const rootsKey = roots.join("\n");
  const shownRoots = extra?.roots ?? roots;
  const shownDepth = extra?.depth ?? depth;

  useEffect(() => setExtra(null), [rootsKey, context]);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    call(commands.springGraph(context, shownRoots, shownDepth, libraries))
      .then((g) => {
        if (!cancelled) {
          setGraph(g);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
    // `shownRoots` is keyed by its contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, shownRoots.join("\n"), shownDepth, libraries, revision]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setRevision((r) => r + 1), 500);
    };
    const offs = [
      onIdeEvent("springModelChanged", later),
      onIdeEvent("indexState", (e) => {
        if (!e.indexing) later();
      }),
    ];
    return () => {
      clearTimeout(timer);
      offs.forEach((off) => off());
    };
  }, []);

  const data = useMemo(() => (graph ? toGraph(graph) : null), [graph]);
  const byId = useMemo(() => new Map(graph?.nodes.map((n) => [n.id, n]) ?? []), [graph]);

  /** Show Neighbours of Selected Nodes: the selected bean joins the centres, one step further. */
  const neighbours = useCallback(() => {
    if (!selected) return;
    setExtra({ roots: [...new Set([...shownRoots, selected])], depth: Math.max(1, shownDepth) });
  }, [selected, shownRoots, shownDepth]);

  const activate = (id: string) => {
    const b = byId.get(id);
    if (b) void openBean(b);
  };

  const menu = (id: string, e: React.MouseEvent) => {
    const b = byId.get(id);
    if (!b) return;
    showContextMenu(e, [
      { label: "Jump to Source", icon: "external-link", run: () => void openBean(b) },
      { label: "Select in Spring Tool Window", icon: "spring", run: () => void revealBean(b.id, context) },
      {
        label: "Show Neighbours of Selected Nodes",
        run: () => setExtra({ roots: [...new Set([...shownRoots, id])], depth: Math.max(1, shownDepth) }),
      },
      ...(compact
        ? [
            {
              label: "Show Bean Dependencies Diagram",
              icon: "md-diagram",
              run: () => openGraph({ context, roots: [id], depth: 1, title: b.name }),
            },
          ]
        : []),
    ]);
  };

  return (
    <div className={clsx(styles.graph, compact && styles.compactGraph)}>
      {!compact && (
        <div className={styles.toolbar}>
          <IconButton
            icon="plus"
            size="small"
            title="Show Neighbours of Selected Nodes"
            disabled={!selected}
            onClick={neighbours}
          />
          <IconButton
            icon="library"
            size="small"
            title="Show beans from libraries"
            pressed={libraries}
            onClick={() => setLibraries((l) => !l)}
          />
          <span className={styles.sep} />
          <IconButton icon="zoom-in" size="small" title="Zoom In" onClick={() => view.current?.zoom(1)} />
          <IconButton icon="zoom-out" size="small" title="Zoom Out" onClick={() => view.current?.zoom(-1)} />
          <IconButton icon="maximize" size="small" title="Fit Content" onClick={() => view.current?.fit()} />
          <IconButton icon="refresh" size="small" title="Layout" onClick={() => view.current?.relayout()} />
          {graph?.truncated && <span className={styles.note}>{tx`Showing the first ${graph.nodes.length} beans`}</span>}
        </div>
      )}
      {!graph && !error && <ProgressBar className={styles.progress} aria-label={tx("Loading the graph")} />}
      {error ? (
        <EmptyState title={tx`Cannot build the graph: ${error}`} />
      ) : data && !data.nodes.length ? (
        <EmptyState title="No beans to show" />
      ) : data ? (
        <GraphView
          ref={view}
          aria-label={tx("Bean dependencies")}
          className={styles.canvas}
          nodes={data.nodes}
          edges={data.edges}
          selected={selected}
          onSelect={setSelected}
          onActivate={activate}
          onContextMenu={menu}
        />
      ) : null}
    </div>
  );
}

/** The editor tab of a dependency graph. */
export function SpringGraphEditor({ input }: { input: EditorInput }) {
  const data = input.data as GraphInput;
  return (
    <div className={styles.graphEditor}>
      <BeanGraph context={data.context} roots={data.roots} depth={data.depth} />
    </div>
  );
}
