/**
 * Live data of running Spring Boot applications (IDEA's Actuator tab): per Run session, the
 * sidecar connection (`spring_boot_live_*`), the application's state and the Actuator
 * endpoints shown by the Beans / Health / Mappings / Environment views. Started by the launch
 * hook, refreshed while the session runs, dropped when it ends.
 */
import { create } from "zustand";
import { call, commands, IpcError } from "@/platform/ipc";
import { springBootPrefs } from "@/platform/springBootSettings";

export type Endpoint = "Beans" | "Health" | "Mappings" | "Env" | "Conditions";

export interface LiveStatus {
  ready: boolean;
  port: string | null;
  contextPath: string | null;
  endpoints: string[];
}

export type LiveErrorKind =
  | "attachFailed"
  | "jmxNotLoaded"
  | "actuatorMissing"
  | "endpointNotExposed"
  | "timeout"
  | "failed";

export interface LiveError {
  kind: LiveErrorKind;
  message: string;
}

export interface EndpointState {
  data: unknown;
  error: LiveError | null;
  loading: boolean;
  /** When the data arrived (rows that changed since flash once). */
  at: number;
}

export interface LiveSession {
  key: string;
  marker: string;
  /** The main class (finds the JVM faster). */
  hint: string | null;
  /** The configuration (Show values restarts it). */
  configId: string;
  phase: "starting" | "ready" | "failed" | "ended";
  handle: string | null;
  status: LiveStatus | null;
  error: LiveError | null;
  endpoints: Partial<Record<Endpoint, EndpointState>>;
}

export const useLive = create<{ sessions: Record<string, LiveSession> }>(() => ({ sessions: {} }));

const timers = new Map<string, ReturnType<typeof setTimeout>[]>();

function patch(key: string, change: Partial<LiveSession> | ((s: LiveSession) => Partial<LiveSession>)) {
  useLive.setState((st) => {
    const s = st.sessions[key];
    if (!s) return st;
    const next = typeof change === "function" ? change(s) : change;
    return { sessions: { ...st.sessions, [key]: { ...s, ...next } } };
  });
}

export function errorOf(e: unknown): LiveError {
  const message = e instanceof IpcError || e instanceof Error ? e.message : String(e);
  const m = /^(attachFailed|jmxNotLoaded|actuatorMissing|endpointNotExposed|timeout|failed): ?(.*)$/s.exec(message);
  return m ? { kind: m[1] as LiveErrorKind, message: m[2]! } : { kind: "failed", message };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const live = (key: string) => {
  const s = useLive.getState().sessions[key];
  return s && s.phase !== "ended" ? s : null;
};

/** Starts following the JVM launched with `-Dluma.run.session=<marker>`. */
export function startLive(key: string, marker: string, hint: string | null, configId: string) {
  stopLive(key);
  useLive.setState((st) => ({
    sessions: {
      ...st.sessions,
      [key]: { key, marker, hint, configId, phase: "starting", handle: null, status: null, error: null, endpoints: {} },
    },
  }));
  void connect(key);
}

async function connect(key: string) {
  const s = live(key);
  if (!s) return;
  // The JVM needs a moment before it can be attached; then the context before it is ready.
  const deadline = performance.now() + 180_000;
  let handle: string | null = null;
  while (!handle && live(key)?.marker === s.marker) {
    try {
      handle = await call(commands.springBootLiveAttach(s.marker, s.hint, null));
    } catch (e) {
      if (performance.now() > deadline) return patch(key, { phase: "failed", error: errorOf(e) });
      await sleep(800);
    }
  }
  if (!handle || !live(key)) return;
  patch(key, { handle });
  while (live(key)) {
    try {
      const status = JSON.parse(await call(commands.springBootLiveStatus(handle))) as LiveStatus;
      patch(key, { status });
      if (status.ready) break;
    } catch (e) {
      if (performance.now() > deadline) return patch(key, { phase: "failed", error: errorOf(e) });
    }
    if (performance.now() > deadline) return patch(key, { phase: "failed", error: { kind: "timeout", message: "" } });
    await sleep(500);
  }
  if (!live(key)) return;
  patch(key, { phase: "ready" });
  await Promise.all((["Beans", "Mappings", "Health", "Env", "Conditions"] as Endpoint[]).map((e) => refresh(key, e)));
  scheduleHealth(key);
}

function scheduleHealth(key: string) {
  const t = setTimeout(async () => {
    if (!live(key)) return;
    await refresh(key, "Health");
    scheduleHealth(key);
  }, springBootPrefs().healthRefresh * 1000);
  timers.set(key, [...(timers.get(key) ?? []), t]);
}

/** Reads an endpoint again (the views' Refresh). */
export async function refresh(key: string, endpoint: Endpoint) {
  const s = live(key);
  if (!s?.handle) return;
  const handle = s.handle;
  patch(key, (x) => ({
    endpoints: {
      ...x.endpoints,
      [endpoint]: { ...(x.endpoints[endpoint] ?? { data: null, error: null, at: 0 }), loading: true },
    },
  }));
  let state: EndpointState;
  try {
    const data = JSON.parse(await call(commands.springBootLiveEndpoint(handle, endpoint)));
    state = { data, error: null, loading: false, at: Date.now() };
  } catch (e) {
    state = { data: live(key)?.endpoints[endpoint]?.data ?? null, error: errorOf(e), loading: false, at: Date.now() };
  }
  if (live(key)?.handle === handle) patch(key, (x) => ({ endpoints: { ...x.endpoints, [endpoint]: state } }));
}

/** Refreshes everything (after Update application or a DevTools restart). */
export function refreshAll(key: string) {
  const s = live(key);
  if (!s) return;
  if (s.phase !== "ready") return;
  void Promise.all((["Beans", "Mappings", "Health", "Env", "Conditions"] as Endpoint[]).map((e) => refresh(key, e)));
}

/** Stops following a session (it ended, or restarts). */
export function stopLive(key: string) {
  for (const t of timers.get(key) ?? []) clearTimeout(t);
  timers.delete(key);
  const s = useLive.getState().sessions[key];
  if (!s) return;
  if (s.handle) void call(commands.springBootLiveDetach(s.handle)).catch(() => {});
  useLive.setState((st) => {
    const sessions = { ...st.sessions };
    delete sessions[key];
    return { sessions };
  });
}
