/**
 * IDEA's build view (`BuildTreeConsoleView`): the event tree of a build on the left,
 * a console on the right. Selecting the root shows the whole console; a step shows its
 * own output and a message its full text. Enter / double-click / F4 opens a message's
 * source. The tree hides successful steps unless "Show Successful Steps" is on (IDEA's
 * filters, in the context menu and the window's Filters button, kept across sessions).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import clsx from "clsx";
import { create } from "zustand";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Icon,
  IconButton,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Spinner,
  Tree,
  fileIconName,
  showContextMenu,
  type MenuItem,
  type TreeHandle,
} from "@/ui";
import { copySelectionOnKeyDown } from "@/ui/selectableText";
import { tx } from "@/platform/i18n";
import {
  DEFAULT_FILTERS,
  isFailed,
  nodeDuration,
  nodeHint,
  visibleChildren,
  type ExecFilters,
  type ExecNode,
  type ExecTree,
  type FilePosition,
} from "./tree";
import styles from "./ExecTreeView.module.css";

// ---------------------------------------------------------------------------
// Filters (IDEA keeps them in PropertiesComponent: one choice for every build view)

const FILTERS_KEY = "luma.buildView.filters";

function readFilters(): ExecFilters {
  try {
    const raw = JSON.parse(localStorage.getItem(FILTERS_KEY) ?? "null") as Partial<ExecFilters> | null;
    return { ...DEFAULT_FILTERS, ...raw };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export const useExecFilters = create<ExecFilters>(() => readFilters());

export function setExecFilter(key: keyof ExecFilters, value: boolean) {
  useExecFilters.setState({ [key]: value });
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(useExecFilters.getState()));
  } catch {
    /* storage unavailable */
  }
}

/** The Filters items (IDEA's `createFilteringActionsGroup`). */
export function filterMenuItems(): MenuItem[] {
  const f = useExecFilters.getState();
  return [
    { label: "Show Warnings", checked: f.showWarnings, run: () => setExecFilter("showWarnings", !f.showWarnings) },
    {
      label: "Show Successful Steps",
      checked: f.showSuccessful,
      run: () => setExecFilter("showSuccessful", !f.showSuccessful),
    },
  ];
}

/** The eye button of a build view's toolbar opening the filters. */
export function ExecFiltersButton({ iconSize = 14 }: { iconSize?: number }) {
  const f = useExecFilters();
  const changed =
    f.showWarnings !== DEFAULT_FILTERS.showWarnings || f.showSuccessful !== DEFAULT_FILTERS.showSuccessful;
  return (
    <IconButton
      icon="eye"
      iconSize={iconSize}
      title="Filters"
      pressed={changed}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        showContextMenu({ x: r.left, y: r.bottom + 2 }, filterMenuItems());
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Tree

/** Re-renders on tree changes, at most once per frame. */
export function useExecTree(tree: ExecTree | null): number {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!tree) return () => {};
      let frame = 0;
      const unsubscribe = tree.subscribe(() => {
        if (!frame) frame = requestAnimationFrame(() => ((frame = 0), notify()));
      });
      return () => {
        cancelAnimationFrame(frame);
        unsubscribe();
      };
    },
    [tree],
  );
  return useSyncExternalStore(subscribe, () => tree?.version ?? 0);
}

/** Ticks every second while the build runs (running durations). */
function useClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  return now;
}

function NodeIcon({ node }: { node: ExecNode }) {
  if (node.kind === "file") return <Icon name={fileIconName(node.name)} size={16} className={styles.icon} />;
  if (node.kind === "message") {
    const name = node.severity === "error" ? "ci-failed" : node.severity === "warning" ? "warning" : "info";
    return <Icon name={name} size={16} className={styles.icon} />;
  }
  if (node.running) return <Spinner size={14} label={tx("Running")} />;
  // IDEA's `ExecutionNode.getCurrentIcon`.
  const name =
    node.result === "failed"
      ? "ci-failed"
      : node.result === "skipped"
        ? "ci-skipped"
        : node.errors > 0
          ? "ci-failed"
          : node.warnings > 0
            ? "warning"
            : "test-passed";
  return <Icon name={name} size={16} className={styles.icon} />;
}

function NodeRow({ node, now }: { node: ExecNode; now: number }) {
  const hint = nodeHint(node);
  const duration = nodeDuration(node, now);
  return (
    <span className={styles.row} title={node.kind === "message" ? (node.detail ?? undefined) : undefined}>
      <NodeIcon node={node} />
      <span className={styles.text}>
        {node.title && <span className={styles.title}>{node.title}: </span>}
        {node.name && (
          <span className={clsx(styles.name, node.kind === "file" && isFailed(node) && styles.fileError)}>
            {node.name}
          </span>
        )}
        {hint && <span className={styles.hint}> {hint}</span>}
      </span>
      {duration && <span className={styles.duration}>{duration}</span>}
    </span>
  );
}

/** Nodes opened automatically: the root, running, failed and warning nodes (IDEA expands to problems). */
function autoExpanded(n: ExecNode): boolean {
  return !n.parent || n.running || isFailed(n) || n.warnings > 0 || n.kind === "file";
}

function locate(n: ExecNode): FilePosition | null {
  if (n.kind === "message") return n.file;
  if (n.kind === "file") return n.children.find((c) => c.file)?.file ?? n.file;
  return null;
}

// ---------------------------------------------------------------------------
// Right pane

const LINE_HEIGHT = 20;

/** Read-only console of a step's own output. */
function NodeConsole({ lines }: { lines: readonly string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => ref.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 20,
  });
  return (
    <div
      ref={ref}
      className={styles.console}
      tabIndex={0}
      role="log"
      aria-label={tx("Output")}
      onKeyDown={copySelectionOnKeyDown}
    >
      <div className={styles.consoleInner} style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((v) => (
          <div key={v.key} className={styles.line} style={{ transform: `translateY(${v.start}px)` }}>
            {lines[v.index] || " "}
          </div>
        ))}
      </div>
    </div>
  );
}

function MessageDetail({ node, onNavigate }: { node: ExecNode; onNavigate?: (file: FilePosition) => void }) {
  const file = node.file;
  return (
    <div
      className={styles.detail}
      tabIndex={0}
      role="document"
      aria-label={tx("Build message")}
      onKeyDown={copySelectionOnKeyDown}
    >
      {file && (
        <button type="button" className={styles.detailLocation} onClick={() => onNavigate?.(file)}>
          {file.path}
          {file.line != null ? `:${file.line + 1}${file.col != null ? `:${file.col + 1}` : ""}` : ""}
        </button>
      )}
      <div className={clsx(styles.detailText, node.severity === "error" && styles.err)}>{node.detail}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export interface ExecTreeViewProps {
  tree: ExecTree;
  /** The whole console (shown for the root). */
  console: ReactNode;
  /** Opens a message's source; `focus` moves focus to the editor (else a preview). */
  onNavigate?: (file: FilePosition, focus: boolean) => void;
  /** Extra context menu items (Rerun…), shown first. */
  contextItems?: () => MenuItem[];
  /** Persisted split id. */
  splitId: string;
  /** Selects (and reveals) the first error when the build fails (IDEA's `showErrorIfFirst`). */
  selectFirstError?: boolean;
  /** Controlled selection (a node id), e.g. the first error a failed build selects. */
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  "aria-label"?: string;
}

export function ExecTreeView({
  tree,
  console,
  onNavigate,
  contextItems,
  splitId,
  selectFirstError = true,
  selected: controlled,
  onSelect,
  "aria-label": ariaLabel,
}: ExecTreeViewProps) {
  const version = useExecTree(tree);
  const filters = useExecFilters();
  const now = useClock(tree.root.running);
  const handle = useRef<TreeHandle>(null);
  const [own, setOwn] = useState<string | null>(null);
  const selected = controlled !== undefined ? controlled : own;
  const setSelected = useCallback(
    (id: string | null) => {
      setOwn(id);
      onSelect?.(id);
    },
    [onSelect],
  );
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const picked = useRef(false);

  // A new tree (rerun) starts with nothing selected.
  const [shownTree, setShownTree] = useState(tree);
  if (shownTree !== tree) {
    setShownTree(tree);
    setOwn(null);
    setToggled(new Map());
  }
  useEffect(() => {
    picked.current = false;
  }, [tree]);

  const roots = useMemo(() => [tree.root], [tree]);
  const children = useCallback((n: ExecNode) => visibleChildren(n, filters), [filters, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const expanded = useMemo(() => {
    const keys = new Set<string>();
    const walk = (n: ExecNode) => {
      const kids = visibleChildren(n, filters);
      if (!kids.length) return;
      if (toggled.get(n.id) ?? autoExpanded(n)) {
        keys.add(n.id);
        kids.forEach(walk);
      }
    };
    walk(tree.root);
    return keys;
  }, [tree, filters, toggled, version]); // eslint-disable-line react-hooks/exhaustive-deps

  // The first error is selected once, unless the user picked a node already.
  const firstError = !tree.root.running && selectFirstError ? tree.firstError() : undefined;
  useEffect(() => {
    if (!firstError || picked.current || selected) return;
    setSelected(firstError.id);
  }, [firstError, selected, setSelected]);
  // A selection made elsewhere (the store's first error) is scrolled into view.
  useEffect(() => {
    if (selected && handle.current?.leadKey() !== selected)
      requestAnimationFrame(() => handle.current?.reveal(selected));
  }, [selected, expanded]);

  const node = selected ? tree.get(selected) : undefined;
  const navigate = (n: ExecNode, focus = true) => {
    const file = locate(n);
    if (file) onNavigate?.(file, focus);
  };

  const menu = (n: ExecNode | null, e: React.MouseEvent) => {
    e.preventDefault();
    const items: MenuItem[] = [...(contextItems?.() ?? [])];
    if (items.length) items.push({ kind: "separator" });
    const file = n && locate(n);
    items.push({
      label: "Jump to Source",
      icon: "edit-source",
      shortcut: "F4",
      disabled: !file,
      run: () => n && navigate(n),
    });
    if (n?.kind === "message" && n.detail) {
      const text = n.detail;
      items.push({ label: "Copy", icon: "copy", run: () => void navigator.clipboard?.writeText(text) });
    }
    items.push({ kind: "separator" }, ...filterMenuItems(), { kind: "separator" });
    items.push(
      { label: "Previous Occurrence", icon: "arrow-up", run: () => handle.current?.selectOccurrence(-1) },
      { label: "Next Occurrence", icon: "arrow-down", run: () => handle.current?.selectOccurrence(1) },
    );
    showContextMenu({ x: e.clientX, y: e.clientY }, items);
  };

  const right =
    !node || !node.parent ? (
      console
    ) : node.kind === "message" ? (
      <MessageDetail node={node} onNavigate={(f) => onNavigate?.(f, true)} />
    ) : node.kind === "file" && node.children[0] ? (
      <MessageDetail node={node.children[0]} onNavigate={(f) => onNavigate?.(f, true)} />
    ) : (
      <NodeConsole lines={node.output} />
    );

  return (
    <SplitGroup orientation="horizontal" className={styles.split} id={splitId}>
      <SplitPanel id="exec-tree" defaultSize="36%" minSize="140px" className={styles.pane}>
        <div
          className={styles.treeHost}
          onKeyDown={(e) => {
            if (e.key !== "F4" || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !node) return;
            e.preventDefault();
            e.stopPropagation();
            navigate(node);
          }}
        >
          <Tree<ExecNode>
            handleRef={handle}
            aria-label={ariaLabel ?? tx("Build")}
            roots={roots}
            getKey={(n) => n.id}
            getLabel={(n) => (n.title ? `${n.title}: ${n.name}` : n.name)}
            getChildren={children}
            isExpandable={(n) => children(n).length > 0}
            expanded={expanded}
            onExpandedChange={(_next, n, open) => setToggled((prev) => new Map(prev).set(n.id, open))}
            selected={selected ? new Set([selected]) : new Set()}
            onSelectionChange={(_keys, lead) => {
              picked.current = true;
              setSelected(lead?.id ?? null);
            }}
            multiSelect={false}
            isOccurrence={(n) => n.kind === "message"}
            onActivate={(n) => navigate(n)}
            activateExpandable={(n) => n.kind === "file"}
            onContextMenu={(n, _sel, e) => menu(n, e)}
            renderNode={(n) => <NodeRow node={n} now={now} />}
            horizontalScroll
          />
        </div>
      </SplitPanel>
      <SplitHandle />
      <SplitPanel id="exec-console" minSize="160px" className={styles.pane}>
        {right}
      </SplitPanel>
    </SplitGroup>
  );
}
