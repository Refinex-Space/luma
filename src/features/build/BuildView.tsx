/**
 * Build tool window (IDEA's `BuildContentManager`): a "Sync" tab with the last Maven /
 * Gradle reload and a "Build Output" tab with the last Build Project, each IDEA's build
 * view — the event tree (Maven projects and goals, files, messages) beside the console.
 * Selecting a message shows its full text; Enter / double-click / F4 opens its source.
 */
import { copySelectionOnKeyDown } from "@/ui/selectableText";
import { useEffect, useRef } from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import { EmptyState, IconButton, Tabs, T } from "@/ui";
import { tx } from "@/platform/i18n";
import { maybeEditorService } from "@/workbench/contributions";
import { ExecFiltersButton, ExecTreeView } from "./exec/ExecTreeView";
import type { FilePosition } from "./exec/tree";
import type { ConsoleLine } from "./model";
import { rerunBuild, selectBuildNode, useBuildRun } from "./store";
import { selectBuildTab, useBuildTabs, useSyncView } from "./syncView";
import styles from "./Build.module.css";

const LINE_HEIGHT = 20;

function openSource(file: FilePosition, focus: boolean) {
  void maybeEditorService()
    ?.openFile(file.path, {
      selection: file.line != null ? { line: file.line, col: file.col ?? 0 } : undefined,
      focus,
      preview: !focus,
    })
    .catch(() => undefined);
}

/** The shown tab: the chosen one while it has content, else whichever has. */
function useActiveTab(): "sync" | "build" | null {
  const hasBuild = useBuildRun((s) => s.tree !== null);
  const hasSync = useSyncView((s) => s.tree !== null);
  const active = useBuildTabs((s) => s.active);
  if (active === "sync" && hasSync) return "sync";
  if (hasBuild) return "build";
  return hasSync ? "sync" : null;
}

/** Sync | Build Output, in the tool window header. */
export function BuildTabs() {
  const hasBuild = useBuildRun((s) => s.tree !== null);
  const hasSync = useSyncView((s) => s.tree !== null);
  const active = useActiveTab();
  if (!active) return null;
  const items = [
    ...(hasSync ? [{ id: "sync", label: "Sync", text: "Sync" }] : []),
    ...(hasBuild ? [{ id: "build", label: "Build Output", text: "Build Output" }] : []),
  ];
  return (
    <Tabs
      variant="compact"
      aria-label="Build contents"
      items={items}
      activeId={active}
      onSelect={(id) => selectBuildTab(id as "sync" | "build")}
      panelIdPrefix="luma-build"
    />
  );
}

export function BuildHeaderActions() {
  const active = useActiveTab();
  const building = useBuildRun((s) => s.status === "running");
  const sync = useSyncView();
  if (active === "sync") {
    return (
      <>
        <IconButton
          icon="rerun"
          size="small"
          title="Rerun"
          onClick={() => sync.rerun?.()}
          disabled={sync.running || !sync.rerun}
        />
        <IconButton icon="stop" size="small" title="Stop" onClick={() => sync.stop?.()} disabled={!sync.running} />
        <ExecFiltersButton />
      </>
    );
  }
  return (
    <>
      <IconButton
        icon="rerun"
        size="small"
        title="Rebuild Last"
        onClick={() => void rerunBuild()}
        disabled={building || active === null}
      />
      <IconButton icon="stop" size="small" action="build.stop" disabled={!building} />
      {active && <ExecFiltersButton />}
    </>
  );
}

function Console({ lines, label }: { lines: readonly ConsoleLine[]; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => ref.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 20,
  });
  useEffect(() => {
    if (stick.current && lines.length) virtualizer.scrollToIndex(lines.length - 1, { align: "end" });
  }, [lines.length, virtualizer]);
  return (
    <div
      ref={ref}
      className={styles.console}
      tabIndex={0}
      role="log"
      onKeyDown={copySelectionOnKeyDown}
      aria-label={tx(label)}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < LINE_HEIGHT * 2;
      }}
    >
      <div className={styles.consoleInner} style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((v) => {
          const line = lines[v.index]!;
          return (
            <div
              key={v.key}
              className={clsx(styles.line, styles[line.kind])}
              style={{ transform: `translateY(${v.start}px)` }}
            >
              {line.text || " "}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BuildOutput() {
  const tree = useBuildRun((s) => s.tree)!;
  const lines = useBuildRun((s) => s.lines);
  const selected = useBuildRun((s) => s.selected);
  return (
    <ExecTreeView
      tree={tree}
      console={<Console lines={lines} label="Build output" />}
      onNavigate={openSource}
      selected={selected}
      onSelect={selectBuildNode}
      // The store selects (and opens) the first error of a failed build.
      selectFirstError={false}
      splitId="build-view-split"
      aria-label={tx("Build")}
      contextItems={() => [
        {
          label: "Rebuild Last",
          icon: "rerun",
          disabled: useBuildRun.getState().status === "running",
          run: () => void rerunBuild(),
        },
      ]}
    />
  );
}

function SyncOutput() {
  const tree = useSyncView((s) => s.tree)!;
  const lines = useSyncView((s) => s.lines);
  return (
    <ExecTreeView
      tree={tree}
      console={<Console lines={lines} label="Sync output" />}
      onNavigate={openSource}
      splitId="build-sync-split"
      aria-label={tx("Sync")}
      contextItems={() => {
        const s = useSyncView.getState();
        return [{ label: "Rerun", icon: "rerun", disabled: s.running || !s.rerun, run: () => s.rerun?.() }];
      }}
    />
  );
}

export function BuildView() {
  const active = useActiveTab();
  if (!active) {
    return (
      <div className={styles.view}>
        <EmptyState title="No build output">
          <T>Build the project to see compiler messages here</T>
        </EmptyState>
      </div>
    );
  }
  return (
    <div
      className={styles.view}
      role="tabpanel"
      id={`luma-build-panel-${active}`}
      aria-labelledby={`luma-build-tab-${active}`}
    >
      {active === "sync" ? <SyncOutput /> : <BuildOutput />}
    </div>
  );
}
