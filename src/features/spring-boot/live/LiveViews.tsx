/**
 * The Actuator views of a running Spring Boot application (IDEA's Beans / Health / Mappings /
 * Environment tabs of the Run and Services tool windows), beside the session's console.
 */
import { useMemo, useState, type ReactNode } from "react";
import clsx from "clsx";
import { Button, IconButton, Input, T } from "@/ui";
import { useTx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { openExternalUrl } from "@/platform/openUrl";
import { navigateTo } from "@/editor/lsp/navigation";
import { notifications } from "@/workbench/contributions";
import { openRequest } from "@/features/http-client/spring/editor";
import { refresh, useLive, type Endpoint, type LiveError, type LiveSession } from "./store";
import { showValues } from "./restart";
import styles from "./Live.module.css";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));

const simple = (fqn: string) => fqn.split(/[.$]/).pop() ?? fqn;

async function openClass(fqn: string) {
  const loc = await call(commands.springBootLocateClass(fqn.split("$$")[0]!)).catch(() => null);
  if (loc) await navigateTo(loc);
  else
    notifications().notify({
      group: "spring-boot",
      level: "info",
      title: `${simple(fqn)}`,
      body: "The class is not a project source",
    });
}

function useSession(key: string): LiveSession | null {
  return useLive((s) => s.sessions[key] ?? null);
}

/** What a view shows while there is no data: starting, connection errors, the endpoint not exposed. */
function StateView({
  session,
  error,
  endpoint,
}: {
  session: LiveSession | null;
  error?: LiveError | null;
  endpoint: Endpoint;
}) {
  const tx = useTx();
  if (!session)
    return (
      <div className={styles.state}>
        <span className={styles.stateTitle}>
          <T>The application is not running</T>
        </span>
      </div>
    );
  const e = error ?? session.error;
  if (session.phase === "starting" && !e)
    return (
      <div className={styles.state}>
        <div className={styles.bar} />
        <span>
          <T>Waiting for the application to start…</T>
        </span>
      </div>
    );
  if (!e) return null;
  const title =
    e.kind === "actuatorMissing"
      ? tx("Spring Boot Actuator is not enabled.")
      : e.kind === "endpointNotExposed"
        ? tx`Endpoint not exposed via '${"management.endpoints.jmx.exposure.include"}' property`
        : e.kind === "jmxNotLoaded"
          ? tx("JMX agent not loaded")
          : e.kind === "timeout"
            ? tx("The application did not become ready")
            : tx`Cannot connect to the application: ${e.message}`;
  return (
    <div className={styles.state}>
      <span className={styles.stateTitle}>{title}</span>
      {e.kind === "actuatorMissing" && (
        <span>
          <T>Add dependency to the spring-boot-starter-actuator to enable it</T>
        </span>
      )}
      {(e.kind === "failed" || e.kind === "endpointNotExposed") && session.handle && (
        <Button size="small" onClick={() => void refresh(session.key, endpoint)}>
          <T>Retry</T>
        </Button>
      )}
    </div>
  );
}

function Toolbar({
  session,
  endpoint,
  filter,
  setFilter,
  children,
  count,
}: {
  session: LiveSession;
  endpoint: Endpoint;
  filter: string;
  setFilter: (v: string) => void;
  children?: ReactNode;
  count?: string;
}) {
  const tx = useTx();
  const loading = session.endpoints[endpoint]?.loading;
  return (
    <div className={styles.toolbar}>
      <IconButton
        icon="refresh"
        title={tx("Refresh")}
        disabled={loading || session.phase !== "ready"}
        onClick={() => void refresh(session.key, endpoint)}
      />
      {children}
      {count && <span className={styles.count}>{count}</span>}
      <Input
        className={styles.filter}
        value={filter}
        placeholder={tx("Filter")}
        aria-label={tx("Filter")}
        onChange={(e) => setFilter(e.currentTarget.value)}
      />
    </div>
  );
}

const matches = (filter: string, ...parts: string[]) => {
  const f = filter.trim().toLowerCase();
  return !f || parts.some((p) => p.toLowerCase().includes(f));
};

// ---------------------------------------------------------------------------
// Beans

interface BeanRow {
  context: string;
  name: string;
  type: string;
  scope: string;
  resource: string;
  dependencies: string[];
  library: boolean;
}

function beanRows(data: unknown, appPackage: string): BeanRow[] {
  const out: BeanRow[] = [];
  for (const [context, c] of Object.entries(obj(obj(data).contexts))) {
    for (const [name, b] of Object.entries(obj(obj(c).beans))) {
      const bean = obj(b);
      const type = str(bean.type);
      const resource = str(bean.resource);
      const project = resource.startsWith("file [") || (!!appPackage && type.startsWith(`${appPackage}.`));
      out.push({
        context,
        name,
        type,
        scope: str(bean.scope),
        resource,
        dependencies: arr(bean.dependencies).map(str),
        library: !project,
      });
    }
  }
  return out.sort((a, b) => Number(a.library) - Number(b.library) || a.name.localeCompare(b.name));
}

const appPackageOf = (hint: string | null) => (hint ? hint.split(".").slice(0, -1).join(".") : "");

export function BeansView({ sessionKey }: { sessionKey: string }) {
  const tx = useTx();
  const session = useSession(sessionKey);
  const [filter, setFilter] = useState("");
  const [libraries, setLibraries] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const state = session?.endpoints.Beans;
  const rows = useMemo(() => beanRows(state?.data, appPackageOf(session?.hint ?? null)), [state?.data, session?.hint]);
  if (!session || !state?.data) return <StateView session={session} error={state?.error} endpoint="Beans" />;
  const shown = rows.filter((r) => (libraries || !r.library) && matches(filter, r.name, r.type));
  const contexts = [...new Set(shown.map((r) => r.context))];
  return (
    <div className={styles.view}>
      <Toolbar
        session={session}
        endpoint="Beans"
        filter={filter}
        setFilter={setFilter}
        count={`${shown.length} / ${rows.length}`}
      >
        <IconButton
          icon="folder-library"
          title={tx("Show Library Beans")}
          pressed={libraries}
          onClick={() => setLibraries(!libraries)}
        />
      </Toolbar>
      <div className={styles.body} role="tree" aria-label={tx("Beans")}>
        {contexts.map((ctx) => (
          <div key={ctx} role="group">
            <div className={styles.group}>{ctx}</div>
            {shown
              .filter((r) => r.context === ctx)
              .map((r) => {
                const id = `${ctx}/${r.name}`;
                return (
                  <div key={id}>
                    <div
                      className={styles.row}
                      role="treeitem"
                      aria-selected={open === id}
                      aria-expanded={r.dependencies.length ? open === id : undefined}
                      onClick={() => setOpen(open === id ? null : id)}
                      onDoubleClick={() => r.type && void openClass(r.type)}
                    >
                      <span className={styles.name}>{r.name}</span>
                      <span className={styles.secondary} title={r.type}>
                        {simple(r.type)}
                      </span>
                      {r.scope && r.scope !== "singleton" && <span className={styles.tag}>{r.scope}</span>}
                    </div>
                    {open === id && r.dependencies.length > 0 && (
                      <div className={styles.deps}>
                        {tx("Depends on")}: {r.dependencies.join(", ")}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Health

function statusClass(status: string) {
  return status === "UP"
    ? styles.up
    : status === "DOWN"
      ? styles.down
      : status === "OUT_OF_SERVICE"
        ? styles.out
        : undefined;
}

function HealthNode({ name, node, depth }: { name: string; node: Obj; depth: number }) {
  const [open, setOpen] = useState(depth === 0);
  const status = str(node.status);
  const details = Object.entries(obj(node.details));
  const children = Object.entries(obj(node.components));
  return (
    <div>
      <div
        className={styles.row}
        role="treeitem"
        aria-expanded={details.length || children.length ? open : undefined}
        style={{ paddingLeft: 12 + depth * 18 }}
        onClick={() => setOpen(!open)}
      >
        <span className={clsx(styles.dot, statusClass(status))} />
        <span className={styles.name}>{name}</span>
        <span className={styles.secondary}>{status || "UNKNOWN"}</span>
      </div>
      {open && details.length > 0 && (
        <div className={styles.details} style={{ paddingLeft: 40 + depth * 18 }}>
          {details.map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <span className={styles.detailKey}>{k}</span>
              <span className={styles.detailValue}>{typeof v === "object" ? JSON.stringify(v) : str(v)}</span>
            </div>
          ))}
        </div>
      )}
      {open && children.map(([k, v]) => <HealthNode key={k} name={k} node={obj(v)} depth={depth + 1} />)}
    </div>
  );
}

export function HealthView({ sessionKey }: { sessionKey: string }) {
  const tx = useTx();
  const session = useSession(sessionKey);
  const [filter, setFilter] = useState("");
  const state = session?.endpoints.Health;
  if (!session || !state?.data) return <StateView session={session} error={state?.error} endpoint="Health" />;
  const root = obj(state.data);
  const components = Object.entries(obj(root.components)).filter(([k]) => matches(filter, k));
  return (
    <div className={styles.view}>
      <Toolbar session={session} endpoint="Health" filter={filter} setFilter={setFilter} />
      <div className={styles.body} role="tree" aria-label={tx("Health")}>
        <HealthNode
          name="application"
          node={{ status: root.status, components: Object.fromEntries(components) }}
          depth={0}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mappings

interface MappingRow {
  methods: string[];
  patterns: string[];
  handler: string;
  className: string | null;
  library: boolean;
}

function mappingRows(data: unknown): MappingRow[] {
  const out: MappingRow[] = [];
  for (const c of Object.values(obj(obj(data).contexts))) {
    const mappings = obj(obj(c).mappings);
    for (const group of ["dispatcherServlets", "dispatcherHandlers"]) {
      for (const list of Object.values(obj(mappings[group]))) {
        for (const m of arr(list)) {
          const details = obj(obj(m).details);
          const method = obj(details.handlerMethod);
          const conditions = obj(details.requestMappingConditions);
          const className = str(method.className) || null;
          const patterns = arr(conditions.patterns).map(str);
          if (!patterns.length) continue;
          out.push({
            methods: arr(conditions.methods).map(str),
            patterns,
            handler: className ? `${simple(className)}#${str(method.name)}` : str(obj(m).handler),
            className,
            library: !className || /^org\.springframework\./.test(className),
          });
        }
      }
    }
  }
  return out.sort((a, b) => Number(a.library) - Number(b.library) || a.patterns[0]!.localeCompare(b.patterns[0]!));
}

export function MappingsView({ sessionKey }: { sessionKey: string }) {
  const tx = useTx();
  const session = useSession(sessionKey);
  const [filter, setFilter] = useState("");
  const [libraries, setLibraries] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const state = session?.endpoints.Mappings;
  const rows = useMemo(() => mappingRows(state?.data), [state?.data]);
  if (!session || !state?.data) return <StateView session={session} error={state?.error} endpoint="Mappings" />;
  const base = `http://localhost:${session.status?.port || "8080"}${session.status?.contextPath ?? ""}`;
  const shown = rows.filter(
    (r) => (libraries || !r.library) && matches(filter, ...r.patterns, r.handler, ...r.methods),
  );
  return (
    <div className={styles.view}>
      <Toolbar
        session={session}
        endpoint="Mappings"
        filter={filter}
        setFilter={setFilter}
        count={`${shown.length} / ${rows.length}`}
      >
        <IconButton
          icon="folder-library"
          title={tx("Show Library Mappings")}
          pressed={libraries}
          onClick={() => setLibraries(!libraries)}
        />
      </Toolbar>
      <div className={styles.body} role="list" aria-label={tx("Mappings")}>
        {shown.map((r, i) => {
          const method = r.methods[0] ?? "GET";
          const url = `${base}${r.patterns[0]}`;
          return (
            <div
              key={i}
              className={styles.row}
              style={{ paddingLeft: 10 }}
              role="listitem"
              aria-selected={selected === i}
              onClick={() => setSelected(i)}
              onDoubleClick={() => r.className && void openClass(r.className)}
            >
              <span className={styles.method}>{r.methods.join(", ") || "ALL"}</span>
              <span className={styles.name}>{r.patterns.join(", ")}</span>
              <span className={styles.secondary}>{r.handler}</span>
              <span className={styles.actions}>
                <IconButton
                  icon="file-http"
                  size="small"
                  title={tx("Open in HTTP Client")}
                  onClick={(e) => {
                    e.stopPropagation();
                    void openRequest(method, url);
                  }}
                />
                {(!r.methods.length || r.methods.includes("GET")) && (
                  <IconButton
                    icon="web"
                    size="small"
                    title={tx("Open in Browser")}
                    onClick={(e) => {
                      e.stopPropagation();
                      void openExternalUrl(url);
                    }}
                  />
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Environment

export function EnvironmentView({ sessionKey }: { sessionKey: string }) {
  const tx = useTx();
  const session = useSession(sessionKey);
  const [filter, setFilter] = useState("");
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const state = session?.endpoints.Env;
  if (!session || !state?.data) return <StateView session={session} error={state?.error} endpoint="Env" />;
  const env = obj(state.data);
  const sources = arr(env.propertySources).map(obj);
  const masked = sources.some((s) => Object.values(obj(s.properties)).some((p) => str(obj(p).value) === "******"));
  return (
    <div className={styles.view}>
      <Toolbar session={session} endpoint="Env" filter={filter} setFilter={setFilter}>
        <span className={styles.sep} />
        <Button size="small" variant="ghost" onClick={() => void showValues(session, masked)}>
          {masked ? tx("Show Values (Requires Restart)") : tx("Hide Values (Requires Restart)")}
        </Button>
      </Toolbar>
      {arr(env.activeProfiles).length > 0 && (
        <div className={styles.notice} style={{ color: "var(--fg-muted)" }}>
          {tx("Active profiles")}: {arr(env.activeProfiles).map(str).join(", ")}
        </div>
      )}
      <div className={styles.body} role="tree" aria-label={tx("Environment")}>
        {sources.map((s) => {
          const name = str(s.name);
          const props = Object.entries(obj(s.properties)).filter(([k, v]) => matches(filter, k, str(obj(v).value)));
          if (!props.length && filter) return null;
          const isOpen = !closed.has(name);
          return (
            <div key={name} role="group">
              <div
                className={styles.group}
                role="treeitem"
                aria-expanded={isOpen}
                onClick={() => {
                  const next = new Set(closed);
                  if (isOpen) next.add(name);
                  else next.delete(name);
                  setClosed(next);
                }}
              >
                {name}
                <span className={styles.count}>{props.length}</span>
              </div>
              {isOpen &&
                props.map(([k, v]) => (
                  <div key={k} className={styles.row} title={str(obj(v).origin)}>
                    <span className={styles.name}>{k}</span>
                    <span className={styles.secondary}>{str(obj(v).value)}</span>
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
