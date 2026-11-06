/**
 * Elasticsearch state of the Database feature: per data source its cluster, its indices
 * (with data streams and aliases) and the fields of the index patterns looked at; index
 * operations (refresh, open / close, delete, create) and the tabs and console that open
 * on them. Requests go through `es_request`; non-2xx answers carry ES's own error.
 */
import { create } from "zustand";
import {
  call,
  commands,
  isCancelled,
  nextRequestId,
  type EsCluster,
  type EsField,
  type EsIndices,
  type EsResponse,
} from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { editorsFor } from "@/editor/api";
import { editorService, notifications } from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";
import { bindConsole, sourceById, useDatabase, withConnection, type Loaded } from "../store";
import { esClusterInput, esDiscoverInput } from "./model";

export type EsDialog = { kind: "createIndex"; id: string };

interface ElasticState {
  /** Data source id → its cluster. */
  cluster: Record<string, Loaded<EsCluster>>;
  /** Data source id → its indices, data streams and aliases. */
  indices: Record<string, Loaded<EsIndices>>;
  /** `<id>\0<index pattern>` → its fields. */
  fields: Record<string, Loaded<EsField[]>>;
  dialog: EsDialog | null;
}

export const useElastic = create<ElasticState>(() => ({ cluster: {}, indices: {}, fields: {}, dialog: null }));

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fieldsKey = (id: string, index: string) => `${id}\u0000${index}`;

export function isElasticSource(id: string | null | undefined): boolean {
  return sourceById(id)?.driver === "elasticsearch";
}

/** Hidden and system indices (`.kibana…`) are listed only when the data source says so. */
export function showsHidden(id: string): boolean {
  return !!sourceById(id)?.introspection?.showSystem;
}

export async function loadIndices(id: string): Promise<void> {
  useElastic.setState((s) => ({
    indices: { ...s.indices, [id]: s.indices[id]?.status === "ok" ? s.indices[id] : { status: "loading" } },
  }));
  try {
    const value = await withConnection(id, () => call(commands.esIndices(id)));
    useElastic.setState((s) => ({ indices: { ...s.indices, [id]: { status: "ok", value } } }));
  } catch (e) {
    useElastic.setState((s) => ({ indices: { ...s.indices, [id]: { status: "error", message: message(e) } } }));
  }
}

export async function loadCluster(id: string): Promise<void> {
  useElastic.setState((s) => ({
    cluster: { ...s.cluster, [id]: s.cluster[id]?.status === "ok" ? s.cluster[id] : { status: "loading" } },
  }));
  try {
    const value = await withConnection(id, () => call(commands.esCluster(id)));
    useElastic.setState((s) => ({ cluster: { ...s.cluster, [id]: { status: "ok", value } } }));
  } catch (e) {
    useElastic.setState((s) => ({ cluster: { ...s.cluster, [id]: { status: "error", message: message(e) } } }));
  }
}

/** The fields of `index` (a name, alias, data stream or pattern), loaded once (`reload` to read again). */
export async function fieldsOf(id: string, index: string, reload = false): Promise<EsField[]> {
  const key = fieldsKey(id, index);
  const known = useElastic.getState().fields[key];
  if (known?.status === "ok" && !reload) return known.value;
  try {
    const value = await withConnection(id, () => call(commands.esFields(id, index)));
    useElastic.setState((s) => ({ fields: { ...s.fields, [key]: { status: "ok", value } } }));
    return value;
  } catch (e) {
    useElastic.setState((s) => ({ fields: { ...s.fields, [key]: { status: "error", message: message(e) } } }));
    throw e;
  }
}

/** The fields of `index` if they were loaded (the tree shows them, completion reads them). */
export function loadedFields(id: string, index: string): Loaded<EsField[]> | undefined {
  return useElastic.getState().fields[fieldsKey(id, index)];
}

export function useFields(id: string, index: string): Loaded<EsField[]> | undefined {
  return useElastic((s) => s.fields[fieldsKey(id, index)]);
}

/** Forgets what was loaded of a data source (disconnect, removal). */
export function forgetElastic(id: string) {
  const prefix = `${id}\u0000`;
  useElastic.setState((s) => ({
    cluster: Object.fromEntries(Object.entries(s.cluster).filter(([k]) => k !== id)),
    indices: Object.fromEntries(Object.entries(s.indices).filter(([k]) => k !== id)),
    fields: Object.fromEntries(Object.entries(s.fields).filter(([k]) => !k.startsWith(prefix))),
  }));
}

/** Re-reads a data source: its indices, its cluster if shown, the fields looked at. */
export async function refreshElastic(id: string): Promise<void> {
  const s = useElastic.getState();
  const prefix = `${id}\u0000`;
  const patterns = Object.keys(s.fields)
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));
  await Promise.all([
    loadIndices(id),
    s.cluster[id] ? loadCluster(id) : null,
    ...patterns.map((p) => fieldsOf(id, p, true).catch(() => null)),
  ]);
}

// Disconnecting a data source forgets it.
useDatabase.subscribe((s, prev) => {
  if (s.connected === prev.connected) return;
  for (const id of Object.keys(useElastic.getState().indices)) if (!s.connected.has(id)) forgetElastic(id);
});

// ---- requests ----------------------------------------------------------------------------

/** ES's own error of a non-2xx answer: `type: reason` (the root cause's when there is one). */
export function esErrorReason(r: Pick<EsResponse, "status" | "body">): string {
  try {
    const body = JSON.parse(r.body) as { error?: unknown; status?: number };
    const e = body.error;
    if (typeof e === "string") return e;
    if (e && typeof e === "object") {
      const err = e as { type?: string; reason?: string; root_cause?: Array<{ type?: string; reason?: string }> };
      const root = err.root_cause?.[0];
      const pick = root?.reason && root.reason !== err.reason ? root : err;
      return [pick.type, pick.reason].filter(Boolean).join(": ") || `HTTP ${r.status}`;
    }
  } catch {
    // Not JSON: the text itself.
  }
  return r.body.trim().slice(0, 500) || `HTTP ${r.status}`;
}

/** One request; the parsed JSON body of a 2xx answer, else throws ES's error. */
export async function esJson<T = unknown>(
  id: string,
  method: string,
  path: string,
  body?: unknown,
  request = nextRequestId(),
): Promise<T> {
  const text = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
  const r = await withConnection(id, () => call(commands.esRequest(request, id, method, path, text)));
  if (r.status < 200 || r.status >= 300) throw new Error(esErrorReason(r));
  return (r.body ? JSON.parse(r.body) : null) as T;
}

/** Runs a request for an action; notifies and returns false when it fails. */
export async function esRun(id: string, method: string, path: string, title: string, body?: unknown) {
  try {
    await esJson(id, method, path, body);
    return true;
  } catch (e) {
    if (!isCancelled(e)) notifications().notify({ level: "error", title, body: message(e), key: "es-action" });
    return false;
  }
}

// ---- index operations --------------------------------------------------------------------

const enc = encodeURIComponent;

export async function refreshIndex(id: string, index: string): Promise<void> {
  if (await esRun(id, "POST", `/${enc(index)}/_refresh`, tx("Cannot refresh the index"))) void loadIndices(id);
}

export async function setIndexOpen(id: string, index: string, open: boolean): Promise<void> {
  if (!open) {
    const ok = await confirm({
      title: "Close Index",
      message: tx`Close index '${index}'? It stays on disk but cannot be searched or written until opened again.`,
      ok: "Close",
    });
    if (!ok) return;
  }
  const path = `/${enc(index)}/${open ? "_open" : "_close"}`;
  const title = open ? tx("Cannot open the index") : tx("Cannot close the index");
  if (await esRun(id, "POST", path, title)) void loadIndices(id);
}

export async function deleteIndex(id: string, index: string, docs: number | null): Promise<boolean> {
  const count = (docs ?? 0).toLocaleString("en");
  const ok = await confirm({
    title: "Delete Index",
    message:
      docs !== null
        ? tx`Delete index '${index}' and its ${count} documents? This cannot be undone.`
        : tx`Delete index '${index}'? This cannot be undone.`,
    ok: "Delete",
  });
  if (!ok) return false;
  const done = await esRun(id, "DELETE", `/${enc(index)}`, tx("Cannot delete the index"));
  if (done) void loadIndices(id);
  return done;
}

export const openEsDialog = (dialog: EsDialog) => useElastic.setState({ dialog });
export const closeEsDialog = () => useElastic.setState({ dialog: null });

// ---- tabs and console -----------------------------------------------------------------------

export async function openDiscover(id: string, index: string, keepState = false) {
  const input = esDiscoverInput(id, index);
  const editors = editorService();
  // A Discover tab keeps its state while open (tabs mount only while active); reopened, it starts fresh.
  if (!keepState && !editors.openTabs?.().some((t) => t.input.key === input.key)) {
    const { dropTab } = await import("./discover/state");
    dropTab(input.key);
  }
  await editors.openInput(input, { focus: true });
}

export function openCluster(id: string) {
  void editorService().openInput(esClusterInput(id), { focus: true });
}

/**
 * Opens the console of data source `id` (one per data source); `request` (a request block
 * like `GET /logs/_search {…}`) is appended at its end and selected, ready to run.
 */
export async function openEsConsole(id: string, request?: string): Promise<string | null> {
  try {
    const path = await call(commands.esConsolePath(id));
    bindConsole(path, id);
    await editorService().openFile(path, { focus: true });
    if (request) {
      // The editor mounts on the next frames.
      for (let i = 0; i < 20 && !editorsFor(path).length; i++) await new Promise((r) => setTimeout(r, 25));
      const view = editorsFor(path)[0]?.view;
      if (view) {
        const doc = view.state.doc;
        const gap =
          doc.length === 0 ? "" : doc.toString().endsWith("\n\n") ? "" : doc.toString().endsWith("\n") ? "\n" : "\n\n";
        const from = doc.length + gap.length;
        view.dispatch({
          changes: { from: doc.length, insert: gap + request },
          // The caret on the request line: ⌘↵ runs it.
          selection: { anchor: from },
          scrollIntoView: true,
        });
        view.focus();
      }
    }
    return path;
  } catch (e) {
    notifications().notify({ level: "error", title: tx("Cannot open the console"), body: message(e) });
    return null;
  }
}
