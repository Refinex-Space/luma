/**
 * Database tools state: data sources, connection status, the introspection
 * cache of the tree, query consoles (file → data source) and their results.
 */
import { create } from "zustand";
import {
  IpcError,
  call,
  commands,
  isCancelled,
  nextRequestId,
  type DataSource,
  type DbCompletion,
  type DbDatabases,
  type DbDriver,
  type DbObjectKind,
  type DbPlanNode,
  type DbSchemaObjects,
  type DbServerObjectGroup,
  type DbStatementOutcome,
  type DbTableDetails,
  type DbTableInfo,
  type DbTableKind,
  type EsResponse,
  type RedisCommandOutcome,
  type RequestId,
  type SqlStatement,
} from "@/platform/ipc";
import { editorsFor } from "@/editor/api";
import { editorService, notifications, toolWindowService, type FileDecoration } from "@/workbench/contributions";
import { workflowSettings } from "@/platform/workflowSettings";
import { ask, confirm } from "@/workbench/messages";
import {
  buildRowEdits,
  colorVar,
  connectRemedy,
  databaseKey,
  effectiveSsh,
  idleTargets,
  newSourceId,
  splitTarget,
  type PendingEdits,
} from "./model";
import { tableFolder, type DbNode, type Group } from "./nodes";
import { catalogStale, dropCatalogs } from "./catalog";
import type { ExportData, ExportFormat } from "./export";
import type { SortKey } from "./resultView";
import { canReshape, countQuery, reshapeQuery } from "./sql/reshape";
import { quoteIdent } from "./sql/complete";
import { mapResultColumns, queryTableOf, type EditMapping } from "./sql/editable";
import { editCount } from "./rowEdits";
import type { DbObjectRef } from "./objects";
import { formatted } from "./sql/format";
import { currentSqlStyle } from "./sqlStyle";
import { bindParams, findParams } from "./sql/params";
import { splitRedisTarget } from "./redis/model";
import { isTrivialReply, replySummary } from "./redis/console/reply";
import { tx } from "@/platform/i18n";

export const DB_TOOL_WINDOW = "database";
/** The Database Console tool window: Output and the result tabs of the query consoles. */
export const RESULTS_WINDOW = "dbConsole";
const BINDINGS_KEY = "luma.database.consoles";
const MAX_TABS = 12;

export interface ResultTab {
  id: number;
  /** `Result N` (numbered per window, like IDEA). */
  title: string;
  /** Console file the statement came from. */
  path: string;
  sourceId: string;
  outcome: DbStatementOutcome;
  /** The Query Plan tab: the plan of `outcome.statement` (which was explained, not run). */
  plan?: DbPlanNode[];
  /** Being re-run. */
  busy?: boolean;
  /** Sort (ORDER BY) and page of the rows shown; re-queried when they change. */
  shape?: ResultShape;
  /** The table edits go to (`null`: read-only; absent: not resolved yet). */
  edit?: ResultEditTarget | null;
  /** Pending cell edits, added and deleted rows (Submit applies them). */
  edits?: PendingEdits;
  /** A Redis console reply (`outcome` then only names the command; `sourceId` is the Redis target). */
  redis?: { outcome: RedisCommandOutcome };
  /** An Elasticsearch console response (`outcome` then only names the request). */
  elastic?: { method: string; path: string; response: EsResponse };
}

/** An editable result's table and how its columns map to the table's. */
export interface ResultEditTarget extends EditMapping {
  schema: string;
  table: string;
}

/**
 * IDEA's paging and "Sort via ORDER BY" of a console result: the statement is
 * re-queried as a derived table (see `sql/reshape`) when it can be.
 */
export interface ResultShape {
  sort: SortKey[];
  /** First row of the page (0-based). */
  offset: number;
  pageSize: number;
  /** Rows of the whole query: exact once counted (or when one page holds all). */
  total: number | null;
  counting?: boolean;
  /** The statement cannot be re-queried: sorting is local, there is one page. */
  fixed: boolean;
}

/** One line of the consoles' Output log (IDEA's Database Console output). */
export interface OutputLine {
  id: number;
  time: number;
  kind: "info" | "statement" | "result" | "error";
  text: string;
  /** Prompt before a statement: the schema it ran in (`main>`). */
  prompt?: string;
}

/** `activeResult` value of the Output tab. */
export const OUTPUT_TAB = 0;
const MAX_OUTPUT = 2000;

/** Load state of a tree level. */
export type Loaded<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; value: T };

export type DialogState =
  /** Data source properties; `preset` seeds a new one (New › Data Source › PostgreSQL). */
  | { kind: "source"; source: DataSource | null; preset?: Partial<DataSource>; password?: string | null }
  /** Data Source from URL. */
  | { kind: "sourceUrl" }
  /** Rename a data source (`object` null) or a schema object of target `id`. */
  | { kind: "rename"; id: string; object: DbObjectRef | null }
  /** Confirm Drop / Truncate, with a preview of the statement. */
  | { kind: "drop"; id: string; object: DbObjectRef }
  | { kind: "truncate"; id: string; schema: string; table: string }
  /** Modify Table (`table` null: New › Table); `focusColumn` selects a column, `addColumn` starts a new one. */
  | { kind: "modifyTable"; id: string; schema: string; table: string | null; focusColumn?: string; addColumn?: boolean }
  /** Quick Documentation of a tree node, shown at `anchor` (client coordinates). */
  | { kind: "quickDoc"; node: DbNode; anchor: { x: number; y: number } }
  | { kind: "password"; source: DataSource; resolve: (ok: boolean) => void }
  /** SSH password or key passphrase (`prompt` is the backend's reason). */
  | { kind: "sshSecret"; source: DataSource; prompt: string; resolve: (ok: boolean) => void }
  /** Values of query parameters (`null`: cancelled). */
  | { kind: "params"; names: string[]; resolve: (values: Record<string, string> | null) => void }
  /** Export Data of a result or table page; `source` names it (`main.customers`). */
  | {
      kind: "export";
      data: ExportData;
      source: string;
      format?: ExportFormat;
      loadAll?: () => Promise<ExportData | null>;
    }
  /** Browse Query History of target `id`; Paste goes to console `path`. */
  | { kind: "history"; id: string; path: string | null }
  /** Import Data from File into a table. */
  | { kind: "import"; id: string; schema: string; table: string };

interface DatabaseState {
  sources: DataSource[];
  loaded: boolean;
  /** Connected targets (see `splitTarget`). */
  connected: Set<string>;
  /** Data source id → databases of its server (PostgreSQL). */
  databases: Record<string, Loaded<DbDatabases>>;
  /** Target → schemas. */
  schemas: Record<string, Loaded<string[]>>;
  /** `${id}\u0000${schema}` → tables. */
  tables: Record<string, Loaded<DbTableInfo[]>>;
  /** `${id}\u0000${schema}\u0000${table}` → columns / indexes. */
  details: Record<string, Loaded<DbTableDetails>>;
  /** `${id}\u0000${schema}` → routines and sequences (loaded with the tables). */
  objects: Record<string, DbSchemaObjects>;
  /** Data source id → its `Server Objects` (collations, users, roles…). */
  serverObjects: Record<string, Loaded<DbServerObjectGroup[]>>;
  /** Console / SQL file path → data source id. */
  consoles: Record<string, string>;
  completion: Record<string, DbCompletion>;
  results: ResultTab[];
  /** Result tab id, or `OUTPUT_TAB`. */
  activeResult: number | null;
  output: OutputLine[];
  /** Console path → running request. */
  running: Record<string, RequestId>;
  maxRows: number;
  dialog: DialogState | null;
  /** Target of the tree's lead node. */
  selectedSource: string | null;
  /** The tree's lead node: what the tree actions act on. */
  selectedNode: DbNode | null;
  /** The toolbar's New popup is open. */
  newMenuOpen: boolean;
  /** Expanded nodes of the Database tree. */
  treeExpanded: Set<string>;
  /** A tree node to select and scroll to (Go to Declaration from a console). */
  treeReveal: { key: string; seq: number } | null;
  /** Last value entered per query parameter name. */
  paramValues: Record<string, string>;
  /** Data sources in manual-commit mode. */
  manualCommit: Set<string>;
  /** Manual-commit data sources with statements not yet committed. */
  pendingTx: Set<string>;
}

function readBindings(): Record<string, string> {
  try {
    const raw = localStorage.getItem(BINDINGS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export const useDatabase = create<DatabaseState>(() => ({
  sources: [],
  loaded: false,
  connected: new Set(),
  databases: {},
  schemas: {},
  tables: {},
  details: {},
  objects: {},
  serverObjects: {},
  consoles: readBindings(),
  completion: {},
  results: [],
  activeResult: null,
  output: [],
  running: {},
  maxRows: 500,
  dialog: null,
  selectedSource: null,
  selectedNode: null,
  newMenuOpen: false,
  treeExpanded: new Set(),
  treeReveal: null,
  paramValues: {},
  manualCommit: new Set(),
  pendingTx: new Set(),
}));

export const tablesKey = (id: string, schema: string) => `${id}\u0000${schema}`;
export const detailsKey = (id: string, schema: string, table: string) => `${id}\u0000${schema}\u0000${table}`;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The data source of a target (`<id>` or `<id>:<database>`). */
export function sourceById(id: string | null | undefined): DataSource | undefined {
  if (!id) return undefined;
  const sourceId = splitTarget(id).id;
  return useDatabase.getState().sources.find((s) => s.id === sourceId);
}

/** `name` or `name: database` for messages and pickers. */
export function targetLabel(target: string): string {
  const name = sourceById(target)?.name ?? target;
  const db = splitTarget(target).database;
  return db ? `${name}: ${db}` : name;
}

/** Targets of data source `id` that are connected. */
export function connectedTargets(id: string): string[] {
  return [...useDatabase.getState().connected].filter((t) => splitTarget(t).id === id);
}

export async function loadSources(): Promise<void> {
  try {
    const [sources, connected] = await Promise.all([call(commands.dbSources()), call(commands.dbConnected())]);
    useDatabase.setState({ sources, connected: new Set(connected), loaded: true });
  } catch (e) {
    useDatabase.setState({ loaded: true });
    notifications().notify({ level: "error", title: "Cannot read data sources", body: message(e), key: "db-sources" });
  }
}

/** Drops cached metadata of target `id` (refresh, disconnect); a data source id drops all its databases. */
function forget(id: string) {
  const whole = !splitTarget(id).database;
  const ofTarget = (t: string) => t === id || (whole && splitTarget(t).id === id);
  const dropKeys = <T>(m: Record<string, T>) =>
    Object.fromEntries(Object.entries(m).filter(([k]) => !ofTarget(k.split("\u0000")[0]!)));
  useDatabase.setState((s) => {
    const databases = { ...s.databases };
    if (whole) delete databases[id];
    return {
      databases,
      schemas: dropKeys(s.schemas),
      completion: dropKeys(s.completion),
      tables: dropKeys(s.tables),
      details: dropKeys(s.details),
      objects: dropKeys(s.objects),
      serverObjects: whole ? dropKeys(s.serverObjects) : s.serverObjects,
    };
  });
}

export async function saveSource(
  source: DataSource,
  password: string | null | undefined,
  sshSecret: string | null | undefined = undefined,
): Promise<void> {
  const sources = useDatabase.getState().sources;
  const old = sources.find((s) => s.id === source.id);
  const at = (s: DataSource) => [s.driver, s.host, s.port, s.database, s.file].join("\u0000");
  // Another server or database: the saved objects no longer apply (the backend drops its files too).
  if (old && at(old) !== at(source)) dropCatalogs(old.id ?? "");
  const next = sources.some((s) => s.id === source.id)
    ? sources.map((s) => (s.id === source.id ? source : s))
    : [...sources, source];
  await call(commands.dbSaveSources(next));
  // `undefined`: keep; `null`: forget; string: store.
  const id = source.id ?? "";
  if (password !== undefined) await call(commands.dbSetPassword(id, password, !!source.savePassword));
  if (sshSecret !== undefined) await call(commands.dbSetSshSecret(id, sshSecret, !!source.ssh?.saveSecret));
  forget(id);
  await loadSources();
}

/** Copy/Paste › Duplicate: a copy of data source `id` named `<name> [2]` (its password is not copied). */
export async function duplicateSource(id: string): Promise<void> {
  const src = sourceById(id);
  if (!src) return;
  const names = new Set(useDatabase.getState().sources.map((s) => s.name));
  let n = 2;
  while (names.has(`${src.name} [${n}]`)) n++;
  try {
    await saveSource({ ...src, id: newSourceId(), name: `${src.name} [${n}]` }, undefined);
  } catch (e) {
    notifications().notify({ level: "error", title: "Cannot duplicate the data source", body: message(e) });
  }
}

export async function renameSource(id: string, name: string): Promise<void> {
  const src = sourceById(id);
  if (!src || !name.trim() || name.trim() === src.name) return;
  const sources = useDatabase.getState().sources.map((s) => (s.id === src.id ? { ...s, name: name.trim() } : s));
  await call(commands.dbSaveSources(sources));
  await loadSources();
}

/** Removes the data source after asking (Database tree › Drop on a source). */
export async function removeSource(source: DataSource): Promise<void> {
  const ok = await confirm({
    title: "Remove Data Source",
    message: tx`Remove data source '${source.name}'? Its query console file stays on disk.`,
    ok: "Remove",
  });
  if (!ok) return;
  const id = source.id ?? "";
  if (connectedTargets(id).length) await disconnect(id);
  await deleteSource(id);
}

export async function deleteSource(id: string): Promise<void> {
  await call(commands.dbSaveSources(useDatabase.getState().sources.filter((s) => s.id !== id)));
  forget(id);
  dropCatalogs(id);
  await loadSources();
}

export function openSourceDialog(source: DataSource | null, preset?: Partial<DataSource>, password?: string | null) {
  useDatabase.setState({ dialog: { kind: "source", source, preset, password } });
}

export function openDialog(dialog: DialogState) {
  useDatabase.setState({ dialog });
}

export function closeDialog() {
  useDatabase.setState({ dialog: null });
}

/** Asks for the password of `source` (ask-on-connect); resolves false when cancelled. */
function askPassword(source: DataSource): Promise<boolean> {
  return new Promise((resolve) => useDatabase.setState({ dialog: { kind: "password", source, resolve } }));
}

function askSshSecret(source: DataSource, prompt: string): Promise<boolean> {
  return new Promise((resolve) => useDatabase.setState({ dialog: { kind: "sshSecret", source, prompt, resolve } }));
}

/** First connection to an SSH host: trust its key (added to ~/.ssh/known_hosts)? */
function askTrustHost(prompt: string): Promise<boolean> {
  return confirm({
    title: "Unknown SSH Host",
    icon: "warning",
    message: `${prompt}. The authenticity of the host cannot be established. Trust it and add the key to ~/.ssh/known_hosts?`,
    ok: "Trust and Connect",
  });
}

/** Asks the user what a failed connection needs (password, SSH secret, host key trust); false = give up. */
export async function resolveConnectError(e: unknown, source: DataSource): Promise<boolean> {
  if (!(e instanceof IpcError)) return false;
  // Prompts show the SSH configuration's host and authentication when the tunnel uses one.
  const resolved = { ...source, ssh: effectiveSsh(source.ssh, workflowSettings().ssh.configs) };
  switch (connectRemedy(e.kind, e.message, resolved)) {
    case "password":
      return askPassword(source);
    case "sshSecret":
      return askSshSecret(resolved, e.message);
    case "trustHostKey":
      if (!(await askTrustHost(e.message))) return false;
      await call(commands.dbTrustSshHost(source.id ?? ""));
      return true;
    default:
      return false;
  }
}

/** Target → time of its last use (Options › Auto-disconnect). */
const lastUsed = new Map<string, number>();

/** Options › Transaction control: a manual data source's consoles start in manual commit. */
function applyConnectDefaults(id: string) {
  if (sourceById(id)?.options?.transaction === "manual" && !useDatabase.getState().manualCommit.has(id))
    void setManualCommit(id, true).catch(() => {});
}

/** Runs `op`, asking for passwords / host key trust and retrying when the connection needs them. */
export async function withConnection<T>(id: string, op: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      const r = await op();
      lastUsed.set(id, Date.now());
      if (!useDatabase.getState().connected.has(id)) {
        useDatabase.setState((s) => ({ connected: new Set(s.connected).add(id) }));
        applyConnectDefaults(id);
      }
      return r;
    } catch (e) {
      const source = sourceById(id);
      if (!source || !(await resolveConnectError(e, source))) throw e;
    }
  }
}

export async function connect(id: string): Promise<boolean> {
  try {
    await withConnection(id, () => call(commands.dbConnect(id)));
    return true;
  } catch (e) {
    if (!isCancelled(e))
      notifications().notify({ level: "error", title: `Cannot connect to ${targetLabel(id)}`, body: message(e) });
    return false;
  }
}

/** Disconnects target `id`; a data source id disconnects all its databases. */
export async function disconnect(id: string): Promise<void> {
  const targets = splitTarget(id).database ? [id] : connectedTargets(id);
  if (!targets.includes(id)) targets.push(id);
  await Promise.all(targets.map((t) => call(commands.dbDisconnect(t))));
  forget(id);
  useDatabase.setState((s) => {
    const connected = new Set(s.connected);
    for (const t of targets) connected.delete(t);
    return { connected };
  });
}

/** Disconnects targets idle past their data source's Auto-disconnect; returns the stopper. */
export function watchIdleConnections(everyMs = 5000): () => void {
  const timer = setInterval(() => {
    const s = useDatabase.getState();
    const running = new Set(Object.keys(s.running).map((path) => s.consoles[path]));
    const busy = (t: string) => running.has(t) || s.pendingTx.has(t);
    for (const t of idleTargets(s.connected, s.sources, lastUsed, busy, Date.now())) {
      lastUsed.delete(t);
      void disconnect(t).then(() => log("info", `${targetLabel(t)}: disconnected after being idle`));
    }
  }, everyMs);
  return () => clearInterval(timer);
}

/** Console files of coloured data sources, tinted like IDEA's (file decorations). */
export function consoleTints(s: Pick<DatabaseState, "consoles" | "sources">): Map<string, FileDecoration> {
  const out = new Map<string, FileDecoration>();
  for (const [path, target] of Object.entries(s.consoles)) {
    const id = splitTarget(target).id;
    const tint = colorVar(s.sources.find((x) => x.id === id)?.color);
    if (tint) out.set(path, { tint });
  }
  return out;
}

/** PostgreSQL data sources show their server's databases (IDEA's data source › database › schema). */
export function listsDatabases(source: DataSource | undefined): boolean {
  return source?.driver === "postgres" && !source.options?.singleDatabase;
}

/**
 * MySQL and MariaDB consoles pick the database unqualified names resolve in (a schema of the
 * tree): the console runs on target `<id>:<database>`, whose connections open in it.
 */
export function picksDatabase(source: DataSource | undefined): boolean {
  return source?.driver === "mysql";
}

/**
 * Re-reads the metadata of target `id` (a data source id: all its databases),
 * reloading the levels that were loaded so the tree keeps its expanded nodes.
 */
export async function refresh(id: string): Promise<void> {
  const whole = !splitTarget(id).database;
  const ofTarget = (k: string) => {
    const t = k.split("\u0000")[0]!;
    return t === id || (whole && splitTarget(t).id === id);
  };
  const st = useDatabase.getState();
  const loaded = (m: Record<string, Loaded<unknown>>) =>
    Object.keys(m).filter((k) => ofTarget(k) && m[k]!.status === "ok");
  const schemas = loaded(st.schemas);
  const tables = loaded(st.tables).map((k) => k.split("\u0000") as [string, string]);
  const details = loaded(st.details).map((k) => k.split("\u0000") as [string, string, string]);
  const server = whole && st.serverObjects[id]?.status === "ok";
  forget(id);
  catalogStale(id);
  if (server) void loadServerObjects(id);
  if (whole && listsDatabases(sourceById(id))) await loadDatabases(id);
  else if (!schemas.includes(id)) schemas.push(id);
  await Promise.all(schemas.map((t) => loadSchemas(t)));
  await Promise.all(tables.map(([t, schema]) => loadTables(t, schema)));
  const exists = (t: string, schema: string, table: string) => {
    const l = useDatabase.getState().tables[tablesKey(t, schema)];
    return l?.status === "ok" && l.value.some((x) => x.name === table);
  };
  await Promise.all(details.filter((d) => exists(...d)).map(([t, schema, table]) => loadDetails(t, schema, table)));
}

export async function loadDatabases(id: string): Promise<void> {
  useDatabase.setState((s) => ({ databases: { ...s.databases, [id]: { status: "loading" } } }));
  try {
    const value = await withConnection(id, () => call(commands.dbDatabases(id)));
    useDatabase.setState((s) => ({ databases: { ...s.databases, [id]: { status: "ok", value } } }));
  } catch (e) {
    useDatabase.setState((s) => ({ databases: { ...s.databases, [id]: { status: "error", message: message(e) } } }));
  }
}

export async function loadSchemas(id: string): Promise<void> {
  useDatabase.setState((s) => ({ schemas: { ...s.schemas, [id]: { status: "loading" } } }));
  try {
    const value = await withConnection(id, () => call(commands.dbSchemas(id)));
    useDatabase.setState((s) => ({ schemas: { ...s.schemas, [id]: { status: "ok", value } } }));
  } catch (e) {
    useDatabase.setState((s) => ({ schemas: { ...s.schemas, [id]: { status: "error", message: message(e) } } }));
  }
}

export async function loadTables(id: string, schema: string): Promise<void> {
  const key = tablesKey(id, schema);
  useDatabase.setState((s) => ({ tables: { ...s.tables, [key]: { status: "loading" } } }));
  try {
    const value = await withConnection(id, () => call(commands.dbTables(id, schema)));
    // Routines / sequences are extras: a server refusing their catalog still lists tables.
    const objects = await call(commands.dbSchemaObjects(id, schema)).catch(() => null);
    useDatabase.setState((s) => ({
      tables: { ...s.tables, [key]: { status: "ok", value } },
      objects: objects ? { ...s.objects, [key]: objects } : s.objects,
    }));
  } catch (e) {
    useDatabase.setState((s) => ({ tables: { ...s.tables, [key]: { status: "error", message: message(e) } } }));
  }
}

/** Whether the tree shows a `Server Objects` folder under the data source (IDEA's, for MySQL and PostgreSQL). */
export function hasServerObjects(source: DataSource | undefined): boolean {
  return source?.driver === "mysql" || source?.driver === "postgres";
}

export async function loadServerObjects(id: string): Promise<void> {
  useDatabase.setState((s) => ({ serverObjects: { ...s.serverObjects, [id]: { status: "loading" } } }));
  try {
    const value = await withConnection(id, () => call(commands.dbServerObjects(id)));
    useDatabase.setState((s) => ({ serverObjects: { ...s.serverObjects, [id]: { status: "ok", value } } }));
  } catch (e) {
    useDatabase.setState((s) => ({
      serverObjects: { ...s.serverObjects, [id]: { status: "error", message: message(e) } },
    }));
  }
}

export async function loadDetails(id: string, schema: string, table: string): Promise<void> {
  const key = detailsKey(id, schema, table);
  useDatabase.setState((s) => ({ details: { ...s.details, [key]: { status: "loading" } } }));
  try {
    const value = await withConnection(id, () => call(commands.dbTableDetails(id, schema, table)));
    useDatabase.setState((s) => ({ details: { ...s.details, [key]: { status: "ok", value } } }));
  } catch (e) {
    useDatabase.setState((s) => ({ details: { ...s.details, [key]: { status: "error", message: message(e) } } }));
  }
}

/** What `revealInTree` selects under a table: a column, or a row of another group (`null`: the table). */
export type TableChild = string | { group: Group; leaf: (d: DbTableDetails) => string | null };

/** What `revealInTree` selects under a schema: a table (and maybe a child), a routine or a sequence. */
export type SchemaChild =
  | { table: string; kind: DbTableKind; child?: TableChild }
  | { folder: "routines" | "sequences"; leaf: (o: DbSchemaObjects) => string | null };

/**
 * Selects a table (or one of its columns) in the Database tool window,
 * loading and expanding the nodes that lead to it.
 */
export async function revealInTree(
  id: string,
  schema: string,
  table: string,
  kind: DbTableKind,
  column?: TableChild,
): Promise<void> {
  return revealSchemaChild(id, schema, { table, kind, child: column });
}

/** Selects a schema's table, table child, routine or sequence in the Database tool window (loading the path). */
export async function revealSchemaChild(id: string, schema: string, what: SchemaChild): Promise<void> {
  const loaded = (l: Loaded<unknown> | undefined) => l?.status === "ok";
  const { id: sourceId, database } = splitTarget(id);
  let databaseNode: string[] = [];
  if (listsDatabases(sourceById(id))) {
    if (!loaded(useDatabase.getState().databases[sourceId])) {
      if (!(await connect(sourceId))) return;
      await loadDatabases(sourceId);
    }
    const dbs = useDatabase.getState().databases[sourceId];
    const name = database ?? (dbs?.status === "ok" ? dbs.value.current : null);
    if (name) databaseNode = [databaseKey(sourceId, name)];
  }
  if (!loaded(useDatabase.getState().schemas[id])) {
    if (!(await connect(id))) return;
    await loadSchemas(id);
  }
  if (!loaded(useDatabase.getState().tables[tablesKey(id, schema)])) await loadTables(id, schema);
  const schemaKey = `${id}/${schema}`;
  const open = [sourceId, ...databaseNode, schemaKey];
  let key: string;
  if ("folder" in what) {
    const folder = `${schemaKey}/${what.folder}`;
    const leaf = what.leaf(useDatabase.getState().objects[tablesKey(id, schema)] ?? { routines: [], sequences: [] });
    open.push(folder);
    key = leaf === null ? folder : `${folder}/${leaf}`;
  } else {
    const folder = `${schemaKey}/${tableFolder(what.kind)}`;
    const tableKey = `${folder}/${what.table}`;
    open.push(folder);
    key = tableKey;
    if (what.child) {
      if (!loaded(useDatabase.getState().details[detailsKey(id, schema, what.table)]))
        await loadDetails(id, schema, what.table);
      const d = useDatabase.getState().details[detailsKey(id, schema, what.table)];
      const child =
        typeof what.child === "string"
          ? { group: "columns" as const, leaf: what.child }
          : { group: what.child.group, leaf: d?.status === "ok" ? what.child.leaf(d.value) : null };
      if (child.leaf !== null) {
        open.push(tableKey, `${tableKey}/${child.group}`);
        key = `${tableKey}/${child.group}/${child.leaf}`;
      }
    }
  }
  useDatabase.setState((s) => ({
    treeExpanded: new Set([...s.treeExpanded, ...open]),
    treeReveal: { key, seq: (s.treeReveal?.seq ?? 0) + 1 },
  }));
  toolWindowService().show(DB_TOOL_WINDOW, true);
}

/** Selects node `key` in the Database tool window, expanding `open` (Redis keys, Elasticsearch indices). */
export function revealKey(open: readonly string[], key: string) {
  useDatabase.setState((s) => ({
    treeExpanded: new Set([...s.treeExpanded, ...open]),
    treeReveal: { key, seq: (s.treeReveal?.seq ?? 0) + 1 },
  }));
  toolWindowService().show(DB_TOOL_WINDOW, true);
}

const completionLoads = new Map<string, Promise<DbCompletion | null>>();

/** The schema model of `id` for completion (cached; one load at a time). */
export function loadCompletion(id: string): Promise<DbCompletion | null> {
  const cached = useDatabase.getState().completion[id];
  if (cached) return Promise.resolve(cached);
  let p = completionLoads.get(id);
  if (!p) {
    p = call(commands.dbCompletion(id))
      .then((model) => {
        useDatabase.setState((s) => ({ completion: { ...s.completion, [id]: model } }));
        return model;
      })
      .catch(() => null)
      .finally(() => completionLoads.delete(id));
    completionLoads.set(id, p);
  }
  return p;
}

// ---- consoles ----------------------------------------------------------------

export function bindConsole(path: string, id: string | null) {
  useDatabase.setState((s) => {
    const consoles = { ...s.consoles };
    if (id) consoles[path] = id;
    else delete consoles[path];
    try {
      localStorage.setItem(BINDINGS_KEY, JSON.stringify(consoles));
    } catch {
      // Per-viewer convenience only.
    }
    return { consoles };
  });
}

/** The data source a console / SQL file runs on: its binding, else the only data source. */
export function consoleSource(path: string): string | null {
  const s = useDatabase.getState();
  const bound = s.consoles[path];
  if (bound && s.sources.some((x) => x.id === splitTarget(bound).id)) return bound;
  return s.sources.length === 1 ? (s.sources[0]!.id ?? null) : null;
}

/** Opens (creating it on first use) the query console of data source `id`. */
export async function openConsole(id: string): Promise<void> {
  try {
    const path = await call(commands.dbConsolePath(id));
    bindConsole(path, id);
    await editorService().openFile(path, { focus: true });
  } catch (e) {
    notifications().notify({ level: "error", title: "Cannot open the query console", body: message(e) });
  }
}

let nextTab = 1;
let nextLine = 1;

export function log(kind: OutputLine["kind"], text: string, prompt?: string) {
  const line: OutputLine = { id: nextLine++, time: Date.now(), kind, text, prompt };
  useDatabase.setState((s) => ({ output: [...s.output, line].slice(-MAX_OUTPUT) }));
}

export function clearOutput() {
  useDatabase.setState({ output: [] });
}

function elapsed(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** IDEA's summary line of an executed statement. */
export function outcomeSummary(o: DbStatementOutcome): string {
  const r = o.result;
  if (!r) return o.error ?? "";
  const n = r.columns.length ? r.rows.length : (r.affected ?? 0);
  const rows = `${n} row${n === 1 ? "" : "s"}`;
  if (!r.columns.length) return `${rows} affected in ${elapsed(r.elapsedMs ?? 0)}`;
  const total = r.elapsedMs ?? 0;
  const execution = Math.min(total, r.executionMs ?? total);
  const split = ` (execution: ${elapsed(execution)}, fetching: ${elapsed(total - execution)})`;
  return `${rows} retrieved starting from 1 in ${elapsed(total)}${split}${r.hasMore ? " (limit reached)" : ""}`;
}

/** The schema shown as the Output prompt (`main>`). */
function promptOf(id: string): string {
  return useDatabase.getState().completion[id]?.defaultSchema || sourceById(id)?.name || id;
}

/** Runs `statements` on `id`, logging to Output; errors stop the batch (backend). */
async function run(
  id: string,
  statements: SqlStatement[],
  request: RequestId,
  maxRows = useDatabase.getState().maxRows,
): Promise<DbStatementOutcome[]> {
  const wasConnected = useDatabase.getState().connected.has(id);
  const outcomes = await withConnection(id, () => call(commands.dbExecute(request, id, statements, maxRows)));
  if (!wasConnected) log("info", "Connected");
  for (const o of outcomes) {
    log("statement", o.statement.text, `${promptOf(id)}>`);
    log(o.error ? "error" : "result", o.error ? `[${targetLabel(id)}] ${o.error}` : outcomeSummary(o));
  }
  if (useDatabase.getState().manualCommit.has(id) && outcomes.some((o) => !o.error && !READS.test(o.statement.text)))
    useDatabase.setState((s) => ({ pendingTx: new Set(s.pendingTx).add(id) }));
  if (outcomes.some((o) => /^\s*(create|drop|alter|rename)\b/i.test(o.statement.text) && !o.error)) {
    // Schema changed: the tree and completion re-read it.
    void refresh(id);
  }
  return outcomes;
}

/**
 * Runs statements the tree's object actions generated (Drop, Rename, Modify
 * Table…) on `id`, logging them to Output; false (and a notification) on error.
 */
export async function runSql(id: string, texts: string[]): Promise<boolean> {
  const statements = texts.map((t) => {
    const text = t.trim().replace(/;$/, "");
    return { from: 0, to: text.length, text };
  });
  try {
    const outcomes = await run(id, statements, nextRequestId());
    const failed = outcomes.find((o) => o.error);
    if (failed) {
      notifications().notify({
        level: "error",
        title: `[${targetLabel(id)}] ${failed.statement.text}`,
        body: failed.error ?? "",
      });
      return false;
    }
    return true;
  } catch (e) {
    if (!isCancelled(e))
      notifications().notify({ level: "error", title: `Cannot execute on ${targetLabel(id)}`, body: message(e) });
    return false;
  }
}

/** Opens the query console of `id` with `text` appended and selected (SQL Scripts › …). */
export async function openConsoleWith(id: string, text: string): Promise<void> {
  let path: string;
  try {
    path = await call(commands.dbConsolePath(id));
  } catch (e) {
    notifications().notify({ level: "error", title: "Cannot open the query console", body: message(e) });
    return;
  }
  await openConsole(id);
  // The editor mounts after `openFile` resolves.
  for (let i = 0; i < 40; i++) {
    const view = editorsFor(path)[0]?.view;
    if (view) {
      const doc = view.state.doc.toString();
      const sep = !doc || doc.endsWith("\n\n") ? "" : doc.endsWith("\n") ? "\n" : "\n\n";
      const from = doc.length + sep.length;
      view.dispatch({
        changes: { from: doc.length, insert: sep + text },
        selection: { anchor: from, head: from + text.trimEnd().length },
        scrollIntoView: true,
      });
      view.focus();
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** DDL laid out like IDEA's: SQLite returns the statements as they were typed. */
export function readableDdl(text: string, driver: DbDriver | undefined): string {
  return driver === "sqlite" ? formatted(text, driver, currentSqlStyle()) : text;
}

/** Go to DDL: the definition of a table / view, in a SQL file next to the data source's console. */
export async function openDdl(id: string, schema: string, name: string): Promise<void> {
  try {
    const [text, console] = await Promise.all([
      withConnection(id, () => call(commands.dbDdl(id, schema, name))),
      call(commands.dbConsolePath(id)),
    ]);
    const safe = (s: string) => s.replace(/[^\w.-]+/g, "_");
    const path = console.replace(/[^\\/]*$/, `${safe(schema)}.${safe(name)}.sql`);
    await call(commands.dbExportFile(path, readableDdl(text, sourceById(id)?.driver)));
    bindConsole(path, id);
    await editorService().openFile(path, { focus: true });
  } catch (e) {
    notifications().notify({ level: "error", title: `Cannot get the DDL of ${name}`, body: message(e) });
  }
}

/**
 * Runs the statement at `from` (or the selection `from..to`, UTF-16 offsets)
 * of console `path` on its data source. Result sets open as `Result N` tabs
 * of the Services view, everything is logged to its Output tab; returns the
 * outcomes (errors included) for the editor's marks.
 */
/** Asks for the values of the statements' query parameters and binds them; `[]` when cancelled. */
async function withParams(statements: SqlStatement[], driver: DbDriver): Promise<SqlStatement[]> {
  let numbered = 0;
  const found = statements.map((st) => {
    const params = findParams(st.text, driver, numbered);
    numbered += params.filter((p) => p.positional).length;
    return params;
  });
  const names = [...new Set(found.flat().map((p) => p.name))];
  if (!names.length) return statements;
  const values = await new Promise<Record<string, string> | null>((resolve) =>
    useDatabase.setState({ dialog: { kind: "params", names, resolve } }),
  );
  if (!values) return [];
  useDatabase.setState((s) => ({ paramValues: { ...s.paramValues, ...values } }));
  return statements.map((st, i) => ({ ...st, text: bindParams(st.text, found[i]!, values) }));
}

export async function executeConsole(
  path: string,
  text: string,
  from: number,
  to: number,
): Promise<DbStatementOutcome[]> {
  const id = consoleSource(path);
  if (!id) {
    notifications().notify({
      level: "info",
      title: useDatabase.getState().sources.length ? "Choose a data source for this console" : "No data sources",
      body: useDatabase.getState().sources.length
        ? "Pick one in the toolbar above the editor."
        : "Add one in the Database tool window.",
      key: "db-execute",
    });
    return [];
  }
  const statements = await consoleStatements(id, text, from, to);
  if (!statements.length) return [];
  const prev = useDatabase.getState().running[path];
  if (prev) void commands.cancelRequest(prev);
  const request = nextRequestId();
  useDatabase.setState((s) => ({ running: { ...s.running, [path]: request } }));
  try {
    const outcomes = await run(id, statements, request);
    const tabs: ResultTab[] = outcomes
      .filter((o) => o.result?.columns.length)
      .map((outcome) => {
        const n = nextTab++;
        return { id: n, title: tx`Result ${n}`, path, sourceId: id, outcome, shape: initialShape(id, outcome) };
      });
    const failed = outcomes.some((o) => o.error);
    useDatabase.setState((s) => ({
      results: [...s.results, ...tabs].slice(-MAX_TABS),
      activeResult: failed || !tabs.length ? OUTPUT_TAB : tabs.at(-1)!.id,
    }));
    toolWindowService().show(RESULTS_WINDOW, false);
    return outcomes;
  } catch (e) {
    if (!isCancelled(e)) {
      log("error", message(e));
      notifications().notify({ level: "error", title: "Cannot execute", body: message(e), key: "db-execute" });
    } else {
      log("info", "Cancelled");
      // The backend dropped the connection, and its transaction with it.
      if (useDatabase.getState().pendingTx.has(id)) {
        log("info", "Transaction rolled back");
        setPending(id, false);
      }
    }
    return [];
  } finally {
    useDatabase.setState((s) => {
      if (s.running[path] !== request) return s;
      const running = { ...s.running };
      delete running[path];
      return { running };
    });
  }
}

/**
 * Shows what Redis console `path` ran on `target` (`<id>:<db>`): every command and its
 * reply in Output (`redis-cli`'s text for simple replies), a `Result N` tab per
 * collection or long string reply.
 */
export function showRedisResults(path: string, target: string, outcomes: readonly RedisCommandOutcome[]) {
  const { id, db } = splitRedisTarget(target);
  const label = `${sourceById(id)?.name ?? id}: db${db}`;
  const tabs: ResultTab[] = [];
  for (const o of outcomes) {
    log("statement", o.text, `db${db}>`);
    if (o.error !== null || !o.reply) {
      log("error", `[${label}] ${o.error ?? ""}`);
      continue;
    }
    log("result", replySummary(o.reply, o.elapsedMs));
    if (isTrivialReply(o.reply)) continue;
    const n = nextTab++;
    tabs.push({
      id: n,
      title: tx`Result ${n}`,
      path,
      sourceId: target,
      outcome: { statement: { from: o.from, to: o.to, text: o.text }, result: null, error: null },
      redis: { outcome: o },
    });
  }
  const failed = outcomes.some((o) => o.error !== null);
  useDatabase.setState((s) => ({
    results: [...s.results, ...tabs].slice(-MAX_TABS),
    activeResult: failed || !tabs.length ? OUTPUT_TAB : tabs.at(-1)!.id,
  }));
  toolWindowService().show(RESULTS_WINDOW, false);
}

/** What an Elasticsearch response says in the Output log: status, time, hits. */
export function esSummary(r: EsResponse): string {
  const ms = r.elapsedMs ?? 0;
  const time = ms < 10 ? ms.toFixed(1) : String(Math.round(ms));
  let hits = "";
  try {
    const total = (JSON.parse(r.body) as { hits?: { total?: number | { value: number; relation: string } } }).hits
      ?.total;
    const n = typeof total === "number" ? total : total?.value;
    if (n !== undefined) {
      const count = n.toLocaleString("en");
      hits = typeof total === "object" && total.relation === "gte" ? tx`, ${count}+ hits` : tx`, ${count} hits`;
    }
  } catch {
    // Not JSON (`_cat` text): no hits to count.
  }
  const status = r.status;
  return tx`${status} in ${time} ms${hits}`;
}

/** Shows Elasticsearch console responses in the Database Console window (a tab each, errors too). */
export function showEsResults(
  path: string,
  id: string,
  ran: ReadonlyArray<{ method: string; path: string; from: number; to: number; response: EsResponse }>,
) {
  const name = sourceById(id)?.name ?? id;
  const tabs: ResultTab[] = [];
  for (const r of ran) {
    const text = `${r.method} ${r.path}`;
    log("statement", text, `${name}>`);
    const ok = r.response.status >= 200 && r.response.status < 300;
    log(ok ? "result" : "error", esSummary(r.response));
    const n = nextTab++;
    tabs.push({
      id: n,
      title: tx`Result ${n}`,
      path,
      sourceId: id,
      outcome: { statement: { from: r.from, to: r.to, text }, result: null, error: null },
      elastic: { method: r.method, path: r.path, response: r.response },
    });
  }
  useDatabase.setState((s) => ({
    results: [...s.results, ...tabs].slice(-MAX_TABS),
    activeResult: tabs.length ? tabs.at(-1)!.id : OUTPUT_TAB,
  }));
  toolWindowService().show(RESULTS_WINDOW, false);
}

/** The statements of console `path` to run or explain: the selection's, else the one at `from`, parameters bound. */
async function consoleStatements(id: string, text: string, from: number, to: number): Promise<SqlStatement[]> {
  const statements: SqlStatement[] = await call(commands.dbStatements(id, text, from, to));
  if (!statements.length) return [];
  return withParams(statements, sourceById(id)?.driver ?? "sqlite");
}

const PLAN_TITLE = "Query Plan";

/** Shows `plan` of `statement` in the window's Query Plan tab (one per window, like IDEA's). */
function showPlan(path: string, id: string, statement: SqlStatement, plan: DbPlanNode[]) {
  useDatabase.setState((s) => {
    const old = s.results.find((r) => r.plan);
    const tab: ResultTab = {
      id: old?.id ?? nextTab++,
      title: PLAN_TITLE,
      path,
      sourceId: id,
      outcome: { statement, result: null, error: null },
      plan,
    };
    const results = old ? s.results.map((r) => (r === old ? tab : r)) : [...s.results, tab].slice(-MAX_TABS);
    return { results, activeResult: tab.id };
  });
  toolWindowService().show(RESULTS_WINDOW, false);
}

async function explain(id: string, statement: SqlStatement): Promise<DbPlanNode[]> {
  const plan = await withConnection(id, () => call(commands.dbExplain(nextRequestId(), id, statement.text)));
  log("statement", `explain ${statement.text}`, `${promptOf(id)}>`);
  log("result", `${plan.length} plan node${plan.length === 1 ? "" : "s"}`);
  return plan;
}

/** Explain Plan: the plan of the statement at `from` (the first selected one) of console `path`. */
export async function explainConsole(path: string, text: string, from: number, to: number): Promise<void> {
  const id = consoleSource(path);
  if (!id) return;
  try {
    const [statement] = await consoleStatements(id, text, from, to);
    if (!statement) return;
    showPlan(path, id, statement, await explain(id, statement));
  } catch (e) {
    if (isCancelled(e)) return;
    log("error", `[${targetLabel(id)}] ${message(e)}`);
    notifications().notify({
      level: "error",
      title: "Cannot explain the statement",
      body: message(e),
      key: "db-explain",
    });
  }
}

/** Browse Query History of the data source of console `path` (or of target `id`). */
export function openHistory(path: string | null, id: string | null = path ? consoleSource(path) : null) {
  if (!id) {
    notifications().notify({ level: "info", title: "Choose a data source for this console", key: "db-history" });
    return;
  }
  openDialog({ kind: "history", id, path });
}

/** Go to DDL of a routine, trigger or sequence: its definition in a SQL file next to the console. */
export async function openObjectDdl(id: string, schema: string, kind: DbObjectKind, name: string): Promise<void> {
  try {
    const [text, console] = await Promise.all([
      withConnection(id, () => call(commands.dbObjectDdl(id, schema, kind, name))),
      call(commands.dbConsolePath(id)),
    ]);
    const safe = (s: string) => s.replace(/[^\w.-]+/g, "_");
    const path = console.replace(/[^\\/]*$/, `${safe(schema)}.${safe(name)}.sql`);
    await call(commands.dbExportFile(path, text));
    bindConsole(path, id);
    await editorService().openFile(path, { focus: true });
  } catch (e) {
    notifications().notify({ level: "error", title: `Cannot get the definition of ${name}`, body: message(e) });
  }
}

function initialShape(id: string, outcome: DbStatementOutcome): ResultShape {
  const r = outcome.result!;
  const driver = sourceById(id)?.driver ?? "sqlite";
  return {
    sort: [],
    offset: 0,
    pageSize: useDatabase.getState().maxRows,
    total: r.hasMore ? null : r.rows.length,
    fixed: !canReshape(
      outcome.statement.text,
      r.columns.map((c) => c.name),
      driver,
    ),
  };
}

function patchResult(tabId: number, p: Partial<ResultTab> | ((t: ResultTab) => Partial<ResultTab>)) {
  useDatabase.setState((s) => ({
    results: s.results.map((r) => (r.id === tabId ? { ...r, ...(typeof p === "function" ? p(r) : p) } : r)),
  }));
}

/** Fetches the page `shape` names of `tab`'s statement (its sort, from its offset). */
async function fetchShaped(tab: ResultTab, shape: ResultShape): Promise<DbStatementOutcome | undefined> {
  const statement = tab.outcome.statement;
  const columns = tab.outcome.result?.columns.map((c) => c.name) ?? [];
  const order = shape.sort
    .map((k) => ({ column: columns.indexOf(k.column), descending: k.descending }))
    .filter((k) => k.column >= 0);
  const plain = shape.fixed || (!order.length && !shape.offset);
  const driver = sourceById(tab.sourceId)?.driver ?? "sqlite";
  // One row past the page tells whether another follows.
  const text = plain ? statement.text : reshapeQuery(driver, statement.text, order, shape.offset, shape.pageSize + 1);
  const [outcome] = await run(tab.sourceId, [{ ...statement, text }], nextRequestId(), shape.pageSize);
  return outcome && { ...outcome, statement };
}

/** Re-queries result tab `tabId` with `shape` (a new sort or page), keeping its rows on failure. */
async function reshapeResult(tabId: number, shape: ResultShape): Promise<void> {
  const tab = useDatabase.getState().results.find((r) => r.id === tabId);
  if (!tab || tab.busy || !(await discardEdits(tab))) return;
  patchResult(tabId, { busy: true, edits: undefined });
  try {
    const outcome = await fetchShaped(tab, shape);
    if (outcome?.result) {
      const r = outcome.result;
      const total = shape.total ?? (r.hasMore ? null : shape.offset + r.rows.length);
      patchResult(tabId, { outcome, shape: { ...shape, total }, busy: false });
    } else {
      patchResult(tabId, { busy: false });
      if (outcome?.error) {
        notifications().notify({
          level: "error",
          title: "Cannot load the rows",
          body: outcome.error,
          key: "db-reshape",
        });
      }
    }
  } catch (e) {
    patchResult(tabId, { busy: false });
    if (!isCancelled(e)) log("error", message(e));
  }
}

/** Sorts result `tabId` with ORDER BY over all its rows (from the first page). */
export function sortResult(tabId: number, sort: SortKey[]): Promise<void> {
  const tab = useDatabase.getState().results.find((r) => r.id === tabId);
  if (!tab?.shape || tab.shape.fixed) return Promise.resolve();
  return reshapeResult(tabId, { ...tab.shape, sort, offset: 0 });
}

/** Moves result `tabId` to another page: first, previous, next or last (counting the rows first). */
export async function pageResult(tabId: number, to: "first" | "previous" | "next" | "last"): Promise<void> {
  let tab = useDatabase.getState().results.find((r) => r.id === tabId);
  if (!tab?.shape || tab.shape.fixed) return;
  if (to === "last" && tab.shape.total === null) {
    await countResult(tabId);
    tab = useDatabase.getState().results.find((r) => r.id === tabId);
    if (!tab?.shape || tab.shape.total === null) return;
  }
  const { offset, pageSize, total } = tab.shape;
  const next =
    to === "first"
      ? 0
      : to === "previous"
        ? Math.max(0, offset - pageSize)
        : to === "next"
          ? offset + pageSize
          : Math.max(0, Math.floor(((total ?? 1) - 1) / pageSize) * pageSize);
  if (next === offset) return;
  await reshapeResult(tabId, { ...tab.shape, offset: next });
}

/** Changes the page size of result `tabId` (`0`: all rows), from the first page. */
export function setResultPageSize(tabId: number, pageSize: number): Promise<void> {
  const tab = useDatabase.getState().results.find((r) => r.id === tabId);
  if (!tab?.shape) return Promise.resolve();
  const size = pageSize > 0 ? pageSize : Math.max(MAX_ALL_ROWS, tab.shape.total ?? 0);
  return reshapeResult(tabId, { ...tab.shape, pageSize: size, offset: 0 });
}

/** Rows "All" fetches at most. */
export const MAX_ALL_ROWS = 100_000;

/** IDEA's Count Rows: `SELECT COUNT(*)` over the statement of result `tabId`. */
export async function countResult(tabId: number): Promise<void> {
  const tab = useDatabase.getState().results.find((r) => r.id === tabId);
  if (!tab?.shape || tab.shape.fixed || tab.shape.counting) return;
  patchResult(tabId, (t) => ({ shape: t.shape && { ...t.shape, counting: true } }));
  try {
    const statement = tab.outcome.statement;
    const [outcome] = await run(tab.sourceId, [{ ...statement, text: countQuery(statement.text) }], nextRequestId(), 1);
    const n = Number(outcome?.result?.rows[0]?.[0]);
    patchResult(tabId, (t) => ({
      shape: t.shape && { ...t.shape, counting: false, total: Number.isFinite(n) ? n : t.shape.total },
    }));
    if (outcome?.error)
      notifications().notify({ level: "error", title: "Cannot count the rows", body: outcome.error, key: "db-count" });
  } catch (e) {
    patchResult(tabId, (t) => ({ shape: t.shape && { ...t.shape, counting: false } }));
    if (!isCancelled(e)) log("error", message(e));
  }
}

/**
 * All rows of result `tabId` (Export Data of the whole query, in its sort), at most
 * `MAX_ALL_ROWS`; `null` when it fails (notified).
 */
export async function fetchAllRows(tabId: number): Promise<DbStatementOutcome["result"] | null> {
  const tab = useDatabase.getState().results.find((r) => r.id === tabId);
  if (!tab?.shape) return null;
  try {
    const outcome = await fetchShaped(tab, { ...tab.shape, offset: 0, pageSize: MAX_ALL_ROWS });
    if (outcome?.error) throw new Error(outcome.error);
    return outcome?.result ?? null;
  } catch (e) {
    if (!isCancelled(e)) notifications().notify({ level: "error", title: "Cannot export the rows", body: message(e) });
    return null;
  }
}

/** Count Rows of the table editor: the rows of `schema.table` passing `filter` (a WHERE condition). */
export async function countTableRows(
  id: string,
  schema: string,
  table: string,
  filter: string,
): Promise<number | null> {
  const driver = sourceById(id)?.driver ?? "sqlite";
  const text = `SELECT COUNT(*) FROM ${quoteIdent(schema, driver)}.${quoteIdent(table, driver)}${filter ? ` WHERE ${filter}` : ""}`;
  try {
    const [outcome] = await withConnection(id, () =>
      call(commands.dbExecute(nextRequestId(), id, [{ from: 0, to: text.length, text }], 1)),
    );
    if (outcome?.error) throw new Error(outcome.error);
    const n = Number(outcome?.result?.rows[0]?.[0]);
    return Number.isFinite(n) ? n : null;
  } catch (e) {
    if (!isCancelled(e)) notifications().notify({ level: "error", title: "Cannot count the rows", body: message(e) });
    return null;
  }
}

/** IDEA asks before a reload drops unsubmitted changes. */
async function discardEdits(tab: ResultTab): Promise<boolean> {
  const n = tab.edits ? editCount(tab.edits) : 0;
  if (!n) return true;
  return confirm({
    title: "Discard Changes",
    message: tx`${n} unsubmitted change(s) of ${tab.title} will be lost.`,
    ok: "Discard",
  });
}

/**
 * Whether result `tabId` can be edited (DataGrip's editable results): a plain query
 * over one table of a writable data source, the table's primary key in the result.
 */
export async function resolveResultEdit(tabId: number): Promise<void> {
  const tab = useDatabase.getState().results.find((r) => r.id === tabId);
  if (!tab || tab.edit !== undefined || !tab.outcome.result) return;
  const source = sourceById(tab.sourceId);
  const driver = source?.driver ?? "sqlite";
  const ref = source?.readOnly ? null : queryTableOf(tab.outcome.statement.text, driver);
  let target: ResultEditTarget | null = null;
  if (ref) {
    const schema =
      ref.schema ?? (await loadCompletion(tab.sourceId))?.defaultSchema ?? (driver === "sqlite" ? "main" : "");
    if (schema) {
      const key = detailsKey(tab.sourceId, schema, ref.name);
      if (useDatabase.getState().details[key]?.status !== "ok") await loadDetails(tab.sourceId, schema, ref.name);
      const details = useDatabase.getState().details[key];
      const mapping =
        details?.status === "ok"
          ? mapResultColumns(
              tab.outcome.result.columns.map((c) => c.name),
              details.value.columns,
            )
          : null;
      if (mapping) target = { ...mapping, schema, table: ref.name };
    }
  }
  patchResult(tabId, { edit: target });
}

export function setResultEdits(tabId: number, edits: PendingEdits) {
  patchResult(tabId, { edits });
}

/** Applies the pending edits of result `tabId` in one transaction, then re-queries its page. */
export async function submitResultEdits(tabId: number): Promise<boolean> {
  const tab = useDatabase.getState().results.find((r) => r.id === tabId);
  const target = tab?.edit;
  if (!tab || !target || !tab.edits || !tab.outcome.result) return false;
  // Columns that are no table column never carry edits; their name only has to be unique.
  const names = target.columns.map((c, i) => c ?? `\u0000${i}`);
  try {
    const n = await call(
      commands.dbApplyEdits(
        tab.sourceId,
        target.schema,
        target.table,
        buildRowEdits(names, tab.outcome.result.rows, target.primaryKey, tab.edits),
      ),
    );
    log("info", `${target.table}: ${n} row(s) changed`);
    notifications().notify({ level: "info", title: `${target.table}: ${n} row(s) changed`, key: "db-submit" });
    patchResult(tabId, { edits: undefined });
    await rerunResult(tabId);
    return true;
  } catch (e) {
    notifications().notify({ level: "error", title: "Changes were not submitted", body: message(e), key: "db-submit" });
    return false;
  }
}

/** Re-runs the statement of result tab `tabId`, replacing its rows (a plan tab explains it again). */
export async function rerunResult(tabId: number): Promise<void> {
  const tab = useDatabase.getState().results.find((r) => r.id === tabId);
  if (!tab || tab.busy) return;
  if (tab.plan) {
    patchResult(tabId, { busy: true });
    try {
      patchResult(tabId, { plan: await explain(tab.sourceId, tab.outcome.statement), busy: false });
    } catch (e) {
      patchResult(tabId, { busy: false });
      if (!isCancelled(e)) log("error", `[${targetLabel(tab.sourceId)}] ${message(e)}`);
    }
    return;
  }
  // The same sort and page; the row count may have changed.
  if (tab.shape) return reshapeResult(tabId, { ...tab.shape, total: null });
  if (!(await discardEdits(tab))) return;
  patchResult(tabId, { busy: true, edits: undefined });
  try {
    const [outcome] = await run(tab.sourceId, [tab.outcome.statement], nextRequestId());
    patchResult(tabId, outcome?.result ? { outcome, busy: false } : { busy: false });
    if (outcome?.error) useDatabase.setState({ activeResult: OUTPUT_TAB });
  } catch (e) {
    patchResult(tabId, { busy: false });
    if (!isCancelled(e)) log("error", message(e));
  }
}

/** Statements that only read (they leave a manual transaction clean). */
const READS = /^\s*(select|show|pragma|explain|describe|desc|values|table)\b/i;

function setPending(id: string, pending: boolean) {
  useDatabase.setState((s) => {
    const pendingTx = new Set(s.pendingTx);
    if (pending) pendingTx.add(id);
    else pendingTx.delete(id);
    return { pendingTx };
  });
}

/** Commits or rolls back the open transaction of a manual-commit data source. */
export async function finishTransaction(id: string, commit: boolean): Promise<boolean> {
  try {
    await call(commands.dbFinishTransaction(id, commit));
    log("statement", commit ? "commit" : "rollback", `${promptOf(id)}>`);
    log("result", commit ? "Transaction committed" : "Transaction rolled back");
    setPending(id, false);
    return true;
  } catch (e) {
    log("error", `[${targetLabel(id)}] ${message(e)}`);
    notifications().notify({ level: "error", title: commit ? "Cannot commit" : "Cannot roll back", body: message(e) });
    return false;
  }
}

/** Leaving manual commit with changes pending (IDEA asks the same); null when cancelled. */
async function askEndTransaction(source: DataSource): Promise<boolean | null> {
  const { button } = await ask({
    title: "Switch to Auto-Commit",
    body: tx`${source.name} has uncommitted changes. Commit or roll them back before switching to auto-commit?`,
    buttons: [
      { id: "rollback", label: "Roll Back" },
      { id: "commit", label: "Commit", primary: true },
    ],
  });
  return button === "cancel" ? null : button === "commit";
}

/**
 * IDEA's Tx: Auto / Manual. Leaving manual mode with changes pending asks
 * whether to commit or roll them back.
 */
export async function setManualCommit(id: string, manual: boolean): Promise<void> {
  const st = useDatabase.getState();
  if (manual === st.manualCommit.has(id)) return;
  if (!manual && st.pendingTx.has(id)) {
    const source = sourceById(id);
    const commit = source ? await askEndTransaction(source) : false;
    if (commit === null || !(await finishTransaction(id, commit))) return;
  }
  await call(commands.dbSetManualCommit(id, manual));
  useDatabase.setState((s) => {
    const manualCommit = new Set(s.manualCommit);
    if (manual) manualCommit.add(id);
    else manualCommit.delete(id);
    return { manualCommit };
  });
  setPending(id, false);
}

export function cancelConsole(path: string) {
  const r = useDatabase.getState().running[path];
  if (r) void commands.cancelRequest(r);
}

export function closeResult(id: number) {
  useDatabase.setState((s) => {
    const results = s.results.filter((r) => r.id !== id);
    return { results, activeResult: s.activeResult === id ? (results.at(-1)?.id ?? OUTPUT_TAB) : s.activeResult };
  });
}
