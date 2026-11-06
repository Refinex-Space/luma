/**
 * Elasticsearch consoles (`.es` files, Kibana Dev Tools syntax): a toolbar binding the file
 * to an Elasticsearch data source (Execute, Cancel, Auto-Indent, Copy as cURL), a gutter
 * with a ▶ on every request line and, once run, its status; completion of endpoints,
 * index names, Query DSL keys and field names. ⌘↩ runs the request at the caret (or the
 * selected ones) in order; responses open in the Database Console window.
 */
import { EditorState, RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, gutter, showPanel, type Panel } from "@codemirror/view";
import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import type { EditorDocContext } from "@/editor/api";
import { iconNode } from "@/editor/lsp/iconMarkup";
import { call, commands, isCancelled, nextRequestId, type EsResponse, type RequestId } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { shortcutLabel } from "@/platform/keymap";
import { IconButton, Select, copyText } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { sourceLabel } from "../model";
import { bindConsole, loadSources, log, showEsResults, useDatabase, withConnection } from "../store";
import { sourceUrl } from "../vendors";
import { esConsoleCompletion } from "./console/completion";
import { formatBody, parseRequests, requestsIn, toCurl, type EsConsoleRequest } from "./console/parse";
import { esErrorReason, fieldsOf, loadIndices, useElastic } from "./store";
import dbStyles from "../Database.module.css";

export const ES_LANGUAGE = "elasticsearch";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isElastic = (s: { driver?: string | null }) => s.driver === "elasticsearch";

/** The data source console `path` runs on: its binding, else the only Elasticsearch one. */
export function esConsoleTarget(path: string): string | null {
  const s = useDatabase.getState();
  const bound = s.consoles[path];
  if (bound && s.sources.some((x) => x.id === bound && isElastic(x))) return bound;
  const es = s.sources.filter(isElastic);
  return es.length === 1 ? (es[0]!.id ?? null) : null;
}

// ---- run feedback ----------------------------------------------------------------------

interface RunMark {
  /** Start of the request line. */
  from: number;
  status: number | null;
  error: string | null;
  ms: number | null;
}

const setMarks = StateEffect.define<RunMark[]>();

const marksField = StateField.define<RunMark[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMarks)) return e.value;
    if (!tr.docChanged) return value;
    // Editing a request drops its mark; the others follow the text.
    const out: RunMark[] = [];
    for (const m of value) {
      const line = tr.startState.doc.lineAt(m.from);
      let touched = false;
      tr.changes.iterChangedRanges((a, b) => {
        if (a <= line.to && b >= line.from) touched = true;
      });
      if (!touched) out.push({ ...m, from: tr.changes.mapPos(m.from) });
    }
    return out;
  },
});

class RequestMarker extends GutterMarker {
  constructor(
    readonly mark: RunMark | null,
    readonly at: number,
  ) {
    super();
  }
  eq(other: RequestMarker) {
    return (
      other.at === this.at &&
      other.mark?.status === this.mark?.status &&
      other.mark?.error === this.mark?.error &&
      other.mark?.ms === this.mark?.ms
    );
  }
  toDOM(view: EditorView) {
    const el = document.createElement("button");
    el.type = "button";
    const m = this.mark;
    const tone = !m ? "idle" : m.error || (m.status ?? 0) >= 400 ? "bad" : "ok";
    el.className = `cm-luma-es-run cm-luma-es-run-${tone}`;
    el.appendChild(iconNode(tone === "idle" ? "run" : tone === "ok" ? "check" : "error", 14));
    const ms = m?.ms ?? null;
    const time = ms === null ? "" : ms < 1000 ? ` · ${Math.round(ms)} ms` : ` · ${(ms / 1000).toFixed(1)} s`;
    el.title = !m ? tx("Run Request") : m.error ? m.error : `${m.status}${time}`;
    el.setAttribute("aria-label", tx("Run Request"));
    el.onmousedown = (e) => e.preventDefault();
    el.onclick = () => {
      const path = view.state.field(consolePathField, false);
      if (path) void executeEsRequests(view, path, this.at, this.at);
    };
    return el;
  }
}

/** The console's file (the gutter's ▶ runs its requests). */
const consolePathField = StateField.define<string>({
  create: () => "",
  update: (v) => v,
});

const requestGutter = gutter({
  class: "cm-luma-es-gutter",
  markers: (view) => {
    const marks = view.state.field(marksField);
    const ranges = parseRequests(view.state.doc.toString()).map((r) => {
      const line = view.state.doc.lineAt(r.from);
      const mark = marks.find((m) => m.from === line.from) ?? null;
      return new RequestMarker(mark, r.from).range(line.from);
    });
    return RangeSet.of(ranges, true);
  },
});

// ---- execution -------------------------------------------------------------------------

function setRunning(path: string, request: RequestId | null) {
  useDatabase.setState((s) => {
    const running = { ...s.running };
    if (request) running[path] = request;
    else delete running[path];
    return { running };
  });
}

/** The request body as sent: NDJSON as is (one value per line, newline-terminated), JSON compact. */
function bodyOf(r: EsConsoleRequest): string | null {
  if (r.body === null || !r.body.trim()) return null;
  if (r.ndjson) return r.body.endsWith("\n") ? r.body : `${r.body}\n`;
  return r.body;
}

/** Runs the requests of console `view` (file `path`) between `from` and `to` (the caret: the one there). */
export async function executeEsRequests(view: EditorView, path: string, from?: number, to?: number): Promise<void> {
  if (!useDatabase.getState().loaded) await loadSources();
  const id = esConsoleTarget(path);
  if (!id) {
    const any = useDatabase.getState().sources.some(isElastic);
    notifications().notify({
      level: "info",
      title: any ? "Choose a data source for this console" : "No data sources",
      body: any ? "Pick one in the toolbar above the editor." : "Add one in the Database tool window.",
      key: "db-execute",
    });
    return;
  }
  const sel = view.state.selection.main;
  const requests = requestsIn(view.state.doc.toString(), from ?? sel.from, to ?? sel.to);
  if (!requests.length) return;
  const prev = useDatabase.getState().running[path];
  if (prev) void commands.cancelRequest(prev);
  const doc = view.state.doc;
  const marks = new Map(view.state.field(marksField).map((m) => [m.from, m]));
  const ran: Array<{ method: string; path: string; from: number; to: number; response: EsResponse }> = [];
  let request: RequestId | null = null;
  try {
    for (const r of requests) {
      const line = doc.lineAt(r.from).from;
      if (r.error) {
        marks.set(line, { from: line, status: null, error: r.error, ms: null });
        log("error", `${r.method} ${r.path}: ${r.error}`);
        break;
      }
      request = nextRequestId();
      setRunning(path, request);
      const req = request;
      const response = await withConnection(id, () => call(commands.esRequest(req, id, r.method, r.path, bodyOf(r))));
      const failed = response.status >= 400;
      marks.set(line, {
        from: line,
        status: response.status,
        error: failed ? esErrorReason(response) : null,
        ms: response.elapsedMs ?? null,
      });
      ran.push({ method: r.method, path: r.path, from: r.from, to: r.to, response });
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
  if (ran.length) showEsResults(path, id, ran);
  view.dispatch({ effects: setMarks.of([...marks.values()].filter((m) => m.from <= view.state.doc.length)) });
  // Writes change what the tree lists.
  if (ran.some((r) => r.method !== "GET" && r.method !== "HEAD")) void loadIndices(id);
}

/** Pretty-prints the bodies of the requests at the caret / in the selection (Kibana's Auto Indent). */
export function autoIndent(view: EditorView) {
  const sel = view.state.selection.main;
  const requests = requestsIn(view.state.doc.toString(), sel.from, sel.to);
  const changes = requests
    .filter((r) => r.body !== null && r.bodyFrom !== undefined && !r.error)
    .map((r) => {
      const formatted = formatBody(r.body!);
      return { from: r.bodyFrom!, to: r.bodyFrom! + r.body!.length, insert: formatted };
    })
    .filter((c) => view.state.sliceDoc(c.from, c.to) !== c.insert);
  if (changes.length) view.dispatch({ changes });
}

// ---- toolbar ---------------------------------------------------------------------------

function EsConsoleBar({ path, view }: { path: string; view: EditorView }) {
  const sources = useDatabase((s) => s.sources);
  const loaded = useDatabase((s) => s.loaded);
  const bound = useDatabase(() => esConsoleTarget(path));
  const running = useDatabase((s) => !!s.running[path]);
  useEffect(() => {
    if (!loaded) void loadSources();
  }, [loaded]);
  useEffect(() => {
    if (bound && !useElastic.getState().indices[bound]) void loadIndices(bound);
  }, [bound]);
  const es = useMemo(() => sources.filter(isElastic), [sources]);
  const options = useMemo(
    () =>
      es.map((s) => ({
        value: s.id ?? "",
        label: s.name ?? "",
        detail: sourceLabel(s).slice((s.name ?? "").length + 1),
        icon: "db-elasticsearch",
      })),
    [es],
  );
  const copyCurl = () => {
    const source = es.find((s) => s.id === bound);
    const sel = view.state.selection.main;
    const r = requestsIn(view.state.doc.toString(), sel.from, sel.to)[0];
    if (source && r) void copyText(toCurl(r, sourceUrl(source)));
  };
  return (
    <div className={dbStyles.consoleBar}>
      <IconButton
        icon="run"
        title="Execute"
        shortcut={shortcutLabel("db.execute")}
        disabled={!bound || running}
        onClick={() => void executeEsRequests(view, path)}
      />
      <IconButton
        icon="stop"
        title="Cancel Running Request"
        disabled={!running}
        onClick={() => {
          const r = useDatabase.getState().running[path];
          if (r) void commands.cancelRequest(r);
        }}
      />
      <span className={dbStyles.toolbarSeparator} />
      <IconButton icon="md-code-block" title="Auto-Indent Request" onClick={() => autoIndent(view)} />
      <IconButton icon="copy" title="Copy as cURL" disabled={!bound} onClick={copyCurl} />
      <span className={dbStyles.spacer} />
      <Select
        aria-label="Data source"
        value={bound}
        placeholder={es.length ? "<data source>" : "None configured"}
        options={options}
        onChange={(next) => bindConsole(path, next)}
        disabled={!es.length}
      />
    </div>
  );
}

function consolePanel(path: string) {
  return (view: EditorView): Panel => {
    const dom = document.createElement("div");
    const root = createRoot(dom);
    root.render(<EsConsoleBar path={path} view={view} />);
    return { dom, top: true, destroy: () => queueMicrotask(() => root.unmount()) };
  };
}

const consoleTheme = EditorView.baseTheme({
  ".cm-luma-es-gutter .cm-gutterElement": { display: "flex", alignItems: "center", justifyContent: "center" },
  ".cm-luma-es-run": {
    display: "grid",
    placeItems: "center",
    width: "18px",
    height: "18px",
    padding: "0",
    border: "0",
    borderRadius: "4px",
    background: "none",
    cursor: "pointer",
    opacity: "0.55",
    transition: "opacity var(--dur-fast) var(--ease), background-color var(--dur-fast) var(--ease)",
  },
  ".cm-luma-es-run:hover": { opacity: "1", backgroundColor: "var(--bg-toolbar-hover)" },
  ".cm-luma-es-run-idle": { color: "var(--es-green)" },
  ".cm-luma-es-run-ok": { opacity: "1", color: "var(--es-green)" },
  ".cm-luma-es-run-bad": { opacity: "1", color: "var(--es-red)" },
});

/** The Elasticsearch console of `.es` files: toolbar, request gutter and completion. */
export function esConsoleExtension(ctx: EditorDocContext): Extension {
  if (ctx.language !== ES_LANGUAGE || ctx.virtual || ctx.readOnly) return [];
  const indicesOf = () => {
    const id = esConsoleTarget(ctx.path);
    const l = id ? useElastic.getState().indices[id] : undefined;
    if (l?.status !== "ok") return [];
    return [
      ...l.value.indices.filter((i) => !i.hidden).map((i) => i.name),
      ...l.value.aliases.map((a) => a.name),
      ...l.value.dataStreams.map((d) => d.name),
    ];
  };
  const completion = esConsoleCompletion({
    indices: indicesOf,
    fields: async (index) => {
      const id = esConsoleTarget(ctx.path);
      return id ? await fieldsOf(id, index).catch(() => []) : [];
    },
  });
  return [
    marksField,
    consolePathField.init(() => ctx.path),
    requestGutter,
    consoleTheme,
    showPanel.of(consolePanel(ctx.path)),
    EditorState.languageData.of(() => [{ lumaCompletion: completion }]),
  ];
}
