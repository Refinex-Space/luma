/**
 * Redis consoles (`.redis` files): a toolbar binding the file to a Redis data source and
 * database (Execute, Cancel, history, `db0…dbN` with key counts), the run's feedback on
 * the text (gutter check / error, timing, error banner) and command / key completion.
 * Commands run in order on the console's own connection (`redis_execute`); `SELECT n`
 * moves the console to database n.
 */
import { EditorState, RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, WidgetType, gutter, showPanel, type Panel } from "@codemirror/view";
import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import type { EditorDocContext } from "@/editor/api";
import { iconNode } from "@/editor/lsp/iconMarkup";
import {
  call,
  commands,
  isCancelled,
  nextRequestId,
  type DataSource,
  type RedisCommandInput,
  type RedisCommandOutcome,
  type RequestId,
} from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { shortcutLabel } from "@/platform/keymap";
import { IconButton, Select } from "@/ui";
import { editorService, notifications } from "@/workbench/contributions";
import { sourceLabel } from "../../model";
import {
  bindConsole,
  cancelConsole,
  loadSources,
  log,
  openHistory,
  showRedisResults,
  useDatabase,
  withConnection,
} from "../../store";
import { redisTarget, splitRedisTarget, type RedisTarget } from "../model";
import { loadKeyspace, useRedis } from "../store";
import { forgetKeys, redisCompletionSource } from "./completion";
import { commandsIn, type RedisCommandLine } from "./parse";
import dbStyles from "../../Database.module.css";

export const REDIS_LANGUAGE = "redis";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---- binding -------------------------------------------------------------------------

/** The database a Redis data source is configured with (its URL's `/n`). */
function configuredDb(source: DataSource): number {
  const n = Number(source.database?.trim() || 0);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

const isRedis = (s: DataSource) => s.driver === "redis";

/**
 * The target (`<id>:<db>`) Redis console `path` runs on: its binding to a Redis data
 * source, else the only Redis data source (on its configured database).
 */
export function redisConsoleTarget(path: string): RedisTarget | null {
  const s = useDatabase.getState();
  const bound = s.consoles[path];
  if (bound) {
    const { id, db } = splitRedisTarget(bound);
    const source = s.sources.find((x) => x.id === id && isRedis(x));
    if (source) return redisTarget(id, bound.includes(":") ? db : configuredDb(source));
  }
  const redis = s.sources.filter(isRedis);
  return redis.length === 1 && redis[0]!.id ? redisTarget(redis[0]!.id, configuredDb(redis[0]!)) : null;
}

/** Opens the Redis console of data source `target`'s, bound to `target`'s database. */
export async function openRedisConsole(target: RedisTarget): Promise<void> {
  try {
    const path = await call(commands.redisConsolePath(splitRedisTarget(target).id));
    bindConsole(path, target);
    await editorService().openFile(path, { focus: true });
  } catch (e) {
    notifications().notify({ level: "error", title: "Cannot open the Redis console", body: message(e) });
  }
}

// ---- databases and their key counts -------------------------------------------------------

// Databases and key counts: the Database tree's (`redis/store`), shared.

// ---- run feedback ----------------------------------------------------------------------

interface RunMark {
  from: number;
  to: number;
  error: string | null;
  ms: number | null;
}

interface RunState {
  marks: readonly RunMark[];
  banner: string | null;
}

const setRun = StateEffect.define<RunState>();

const runField = StateField.define<RunState>({
  create: () => ({ marks: [], banner: null }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setRun)) return e.value;
    if (!tr.docChanged) return value;
    // Editing a command drops its mark.
    const marks: RunMark[] = [];
    for (const m of value.marks) {
      let touched = false;
      tr.changes.iterChangedRanges((a, b) => {
        if (a <= m.to && b >= m.from) touched = true;
      });
      if (!touched) marks.push({ ...m, from: tr.changes.mapPos(m.from), to: tr.changes.mapPos(m.to) });
    }
    return { ...value, marks };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (st) => {
      const ranges = [];
      for (const m of st.marks) {
        if (m.error)
          ranges.push(
            Decoration.mark({ class: "cm-luma-db-error", attributes: { title: m.error } }).range(m.from, m.to),
          );
        if (m.ms !== null) ranges.push(Decoration.widget({ widget: new TimingWidget(m.ms), side: 1 }).range(m.to));
      }
      return Decoration.set(ranges, true);
    }),
    showPanel.from(f, (st) => (st.banner ? errorBanner(st.banner) : null)),
  ],
});

class TimingWidget extends WidgetType {
  constructor(readonly ms: number) {
    super();
  }
  eq(other: TimingWidget) {
    return other.ms === this.ms;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-luma-db-timing";
    span.textContent = this.ms < 1000 ? `${Math.round(this.ms)} ms` : `${(this.ms / 1000).toFixed(1)} s`;
    return span;
  }
}

class RunMarker extends GutterMarker {
  constructor(readonly error: string | null) {
    super();
  }
  eq(other: RunMarker) {
    return other.error === this.error;
  }
  toDOM() {
    const el = iconNode(this.error ? "error" : "check", 14, this.error ? "cm-luma-db-run-error" : "cm-luma-db-run-ok");
    el.title = this.error ?? tx("Executed");
    return el;
  }
}

const runGutter = gutter({
  class: "cm-luma-db-gutter",
  markers: (view) => {
    const doc = view.state.doc;
    const ranges = view.state
      .field(runField)
      .marks.filter((m) => m.from <= doc.length)
      .map((m) => new RunMarker(m.error).range(doc.lineAt(m.from).from));
    return RangeSet.of(ranges, true);
  },
});

function errorBanner(text: string) {
  return (view: EditorView): Panel => {
    const dom = document.createElement("div");
    dom.className = "cm-luma-db-banner";
    dom.setAttribute("role", "alert");
    const span = document.createElement("span");
    span.className = "cm-luma-db-banner-text";
    span.textContent = text;
    span.title = text;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "cm-luma-db-banner-close";
    close.setAttribute("aria-label", tx("Close"));
    close.appendChild(iconNode("close", 14));
    close.onclick = () => view.dispatch({ effects: setRun.of({ ...view.state.field(runField), banner: null }) });
    dom.append(span, close);
    return { dom, top: false };
  };
}

function showMarks(view: EditorView, marks: RunMark[], banner: string | null) {
  const len = view.state.doc.length;
  view.dispatch({ effects: setRun.of({ marks: marks.filter((m) => m.to <= len && m.from < m.to), banner }) });
}

// ---- execution -------------------------------------------------------------------------

const label = (target: RedisTarget) => {
  const { id, db } = splitRedisTarget(target);
  return `${useDatabase.getState().sources.find((s) => s.id === id)?.name ?? id}: db${db}`;
};

const toInput = (c: RedisCommandLine): RedisCommandInput => ({
  from: c.from,
  to: c.to,
  args: c.words.map((w) => w.value),
});

/** Runs of commands each ending with a `SELECT` (the rest runs on the selected database). */
function segments(lines: readonly RedisCommandLine[]): RedisCommandLine[][] {
  const out: RedisCommandLine[][] = [[]];
  for (const c of lines) {
    out.at(-1)!.push(c);
    if (c.words[0]?.value.text.toUpperCase() === "SELECT") out.push([]);
  }
  return out.filter((s) => s.length);
}

function setRunning(path: string, request: RequestId | null) {
  useDatabase.setState((s) => {
    const running = { ...s.running };
    if (request) running[path] = request;
    else delete running[path];
    return { running };
  });
}

/** Runs the command at the caret (or the selected ones) of Redis console `view` (file `path`). */
export async function executeRedisInView(view: EditorView, path: string): Promise<void> {
  if (!useDatabase.getState().loaded) await loadSources();
  let target = redisConsoleTarget(path);
  if (!target) {
    const any = useDatabase.getState().sources.some(isRedis);
    notifications().notify({
      level: "info",
      title: any ? "Choose a data source for this console" : "No data sources",
      body: any ? "Pick one in the toolbar above the editor." : "Add one in the Database tool window.",
      key: "db-execute",
    });
    return;
  }
  const sel = view.state.selection.main;
  const lines = commandsIn(view.state.doc.toString(), sel.from, sel.to);
  if (!lines.length) return;
  const invalid = lines.find((c) => c.error);
  if (invalid) {
    const reason = invalid.error ?? "";
    const error = tx`Invalid argument(s): ${reason}`;
    showMarks(view, [{ from: invalid.from, to: invalid.to, error, ms: null }], `[${label(target)}] ${error}`);
    return;
  }
  const prev = useDatabase.getState().running[path];
  if (prev) void commands.cancelRequest(prev);
  const { id } = splitRedisTarget(target);
  const marks: RunMark[] = [];
  let banner: string | null = null;
  let request: RequestId | null = null;
  try {
    for (const segment of segments(lines)) {
      const req = nextRequestId();
      request = req;
      setRunning(path, req);
      const on = target;
      const wasConnected = useDatabase.getState().connected.has(on);
      const outcomes: RedisCommandOutcome[] = await withConnection(on, () =>
        call(commands.redisExecute(req, on, segment.map(toInput))),
      );
      if (!wasConnected) log("info", "Connected");
      showRedisResults(path, on, outcomes);
      forgetKeys(on);
      for (const o of outcomes) marks.push({ from: o.from, to: o.to, error: o.error, ms: o.elapsedMs });
      const failed = outcomes.find((o) => o.error !== null);
      if (failed) {
        banner = `[${label(on)}] ${failed.error}`;
        break;
      }
      const selected = outcomes.at(-1)?.select;
      if (selected !== null && selected !== undefined) {
        target = redisTarget(id, selected);
        bindConsole(path, target);
      }
      if (outcomes.length < segment.length) break;
    }
  } catch (e) {
    if (isCancelled(e)) log("info", "Cancelled");
    else {
      log("error", message(e));
      notifications().notify({ level: "error", title: "Cannot execute", body: message(e), key: "db-execute" });
    }
  } finally {
    if (useDatabase.getState().running[path] === request) setRunning(path, null);
  }
  if (marks.length) showMarks(view, marks, banner);
  if (useRedis.getState().keyspace[id]) void loadKeyspace(id);
}

// ---- toolbar ---------------------------------------------------------------------------

function RedisConsoleBar({ path, view }: { path: string; view: EditorView }) {
  const sources = useDatabase((s) => s.sources);
  const loaded = useDatabase((s) => s.loaded);
  const bound = useDatabase(() => redisConsoleTarget(path));
  const running = useDatabase((s) => !!s.running[path]);
  const { id, db } = bound ? splitRedisTarget(bound) : { id: null, db: 0 };
  const keyspace = useRedis((s) => (id ? s.keyspace[id] : undefined));
  useEffect(() => {
    if (!loaded) void loadSources();
  }, [loaded]);
  useEffect(() => {
    if (id && !useRedis.getState().keyspace[id]) void loadKeyspace(id);
  }, [id]);
  const redis = useMemo(() => sources.filter(isRedis), [sources]);
  const sourceOptions = useMemo(
    () =>
      redis.map((s) => ({
        value: s.id ?? "",
        label: s.name ?? "",
        detail: sourceLabel(s).slice((s.name ?? "").length + 1),
        icon: "db-redis",
      })),
    [redis],
  );
  const databaseOptions = useMemo(() => {
    const dbs = keyspace?.status === "ok" ? keyspace.value.databases : [];
    const options = dbs.map((d) => {
      const keys = (d.keys ?? 0).toLocaleString("en");
      return {
        value: String(d.index),
        label: `db${d.index}`,
        detail: d.keys ? tx`${keys} keys` : undefined,
        icon: "database",
      };
    });
    if (!options.some((o) => o.value === String(db)))
      options.unshift({ value: String(db), label: `db${db}`, detail: undefined, icon: "database" });
    return options;
  }, [keyspace, db]);
  return (
    <div className={dbStyles.consoleBar}>
      <IconButton
        icon="run"
        title="Execute"
        shortcut={shortcutLabel("db.execute")}
        disabled={!bound || running}
        onClick={() => void executeRedisInView(view, path)}
      />
      <IconButton icon="stop" title="Cancel Running Command" disabled={!running} onClick={() => cancelConsole(path)} />
      <span className={dbStyles.toolbarSeparator} />
      <IconButton
        icon="history"
        title="Browse Query History"
        disabled={!id}
        onClick={() => id && openHistory(path, id)}
      />
      <span className={dbStyles.spacer} />
      <Select
        aria-label="Data source"
        value={id}
        placeholder={redis.length ? "<data source>" : "None configured"}
        options={sourceOptions}
        onChange={(next) => {
          const source = redis.find((s) => s.id === next);
          if (source) bindConsole(path, redisTarget(next, configuredDb(source)));
        }}
        disabled={!redis.length}
      />
      {id && (
        <Select
          aria-label="Database"
          value={String(db)}
          placeholder={keyspace?.status === "error" ? "Cannot list databases" : "<database>"}
          options={databaseOptions}
          searchable={databaseOptions.length > 16}
          onChange={(n) => bindConsole(path, redisTarget(id, Number(n)))}
        />
      )}
    </div>
  );
}

function consolePanel(path: string) {
  return (view: EditorView): Panel => {
    const dom = document.createElement("div");
    const root = createRoot(dom);
    root.render(<RedisConsoleBar path={path} view={view} />);
    return { dom, top: true, destroy: () => queueMicrotask(() => root.unmount()) };
  };
}

/** The Redis console of `.redis` files: toolbar, run marks and completion. */
export function redisConsoleExtension(ctx: EditorDocContext): Extension {
  if (ctx.language !== REDIS_LANGUAGE || ctx.virtual || ctx.readOnly) return [];
  const completion = redisCompletionSource(() => redisConsoleTarget(ctx.path));
  return [
    runField,
    runGutter,
    showPanel.of(consolePanel(ctx.path)),
    EditorState.languageData.of(() => [{ lumaCompletion: completion }]),
  ];
}
