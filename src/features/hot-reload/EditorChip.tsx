/**
 * The reload chip at the top-right of the editor (IDEA 2024.3's HotSwap floating button
 * area): the editors of the changed files (else the active one) show "⚡ 3 classes reloaded ·
 * 1 bean · 180 ms" for a moment; a reload with problems stays, with Restart and Details.
 */
import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ViewPlugin, type EditorView } from "@codemirror/view";
import clsx from "clsx";
import { editorCorner, useEditorRegistry, type EditorDocContext } from "@/editor/api";
import { useHotReloadPrefs } from "@/platform/hotReloadSettings";
import { useTx } from "@/platform/i18n";
import { Icon, IconButton, tooltipAttrs } from "@/ui";
import { classSourcePath, fileName } from "./parser";
import { reloadProblem, reloadSummary, reloadTitle } from "./format";
import { statusOf, type ReloadEntry } from "./timeline";
import { dismissLatest, restartSession, showTimeline, useHotSessions } from "./sessions";
import styles from "./HotReload.module.css";

/** How long a successful reload's chip stays. */
export const CHIP_MS = 2500;
const SOURCE_EXT = /\.(java|kt|groovy|scala)$/;

const norm = (p: string) => p.replace(/\\/g, "/");

/** Whether editor `path` shows a file the reload changed. */
export function changedIn(entry: ReloadEntry, path: string): boolean {
  const p = norm(path);
  if (SOURCE_EXT.test(p) && entry.classes.some((c) => p.replace(SOURCE_EXT, "").endsWith(`/${classSourcePath(c)}`)))
    return true;
  const name = fileName(p);
  return (
    entry.properties.some((f) => f && f === name) ||
    entry.mappers.some((m) => m === name) ||
    entry.restartFiles.some((f) => norm(f) === p)
  );
}

/** Editors (by path) the chip shows in: those of changed files, else the active one. */
export function chipPaths(entry: ReloadEntry, open: readonly string[], active: string | null): Set<string> {
  const changed = open.filter((p) => changedIn(entry, p));
  return new Set(changed.length ? changed : active ? [active] : []);
}

function useShownHere(path: string): boolean {
  const latest = useHotSessions((s) => s.latest);
  const editors = useEditorRegistry((s) => s.editors);
  const active = useEditorRegistry((s) => s.active?.ctx.path ?? null);
  if (!latest) return false;
  return chipPaths(
    latest.entry,
    [...editors].map((e) => e.ctx.path),
    active,
  ).has(path);
}

function Chip({ path }: { path: string }) {
  const tx = useTx();
  const enabled = useHotReloadPrefs().editorFeedback;
  const latest = useHotSessions((s) => s.latest);
  const here = useShownHere(path);
  const [faded, setFaded] = useState<number | null>(null);
  const status = latest ? statusOf(latest.entry) : "ok";
  const seq = latest?.seq ?? 0;
  useEffect(() => {
    if (status !== "ok" || !seq) return;
    const timer = setTimeout(() => setFaded(seq), CHIP_MS);
    return () => clearTimeout(timer);
  }, [seq, status]);
  if (!enabled || !latest || !here) return null;
  const { entry, key } = latest;
  const leaving = status === "ok" && faded === seq;
  if (status === "ok")
    return (
      <button
        type="button"
        key={seq}
        className={clsx(styles.chip, leaving && styles.chipLeaving)}
        data-hot-reload-chip=""
        {...tooltipAttrs(tx("Show the Hot Reload view"))}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => showTimeline(key)}
        onAnimationEnd={(e) => {
          if (leaving && e.animationName.includes("chipOut")) dismissLatest();
        }}
      >
        <Icon name="hot-reload" size={14} className={styles.bolt} />
        <span>{reloadSummary(entry)}</span>
      </button>
    );
  const problem = reloadProblem(entry);
  return (
    <div
      key={seq}
      className={clsx(styles.chip, styles.chipProblem, styles[status])}
      role="status"
      data-hot-reload-chip=""
      onMouseDown={(e) => e.preventDefault()}
    >
      <Icon name={status === "error" ? "error" : "warning"} size={14} />
      <span className={styles.chipTitle}>{reloadTitle(entry)}</span>
      {problem && (
        <span className={styles.chipProblemText} {...tooltipAttrs(problem)}>
          {problem}
        </span>
      )}
      <button type="button" className={styles.chipAction} onClick={() => restartSession(key)}>
        {tx("Restart")}
      </button>
      <button type="button" className={styles.chipAction} onClick={() => showTimeline(key)}>
        {tx("Details")}
      </button>
      <IconButton icon="close" size="small" iconSize={10} title="Dismiss" onClick={dismissLatest} />
    </div>
  );
}

/** One chip host per text editor, in its top-right corner. */
export function editorChip(ctx: EditorDocContext) {
  if (ctx.virtual || ctx.doc < 0) return [];
  return ViewPlugin.define((view: EditorView) => {
    const el = document.createElement("div");
    el.className = styles.chipHost!;
    // Before Review Mode and the inspection widget.
    el.style.order = "-2";
    editorCorner(view).appendChild(el);
    const root: Root = createRoot(el);
    root.render(<Chip path={ctx.path} />);
    return {
      destroy() {
        el.remove();
        queueMicrotask(() => root.unmount());
      },
    };
  });
}
