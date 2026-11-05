/**
 * Server Information of a Redis data source (an editor tab): the health at a glance
 * (memory, clients, throughput, hit rate, keys), the keyspace, persistence and
 * replication, the slow log, connected clients and every `INFO` field, refreshed on
 * demand or every few seconds.
 */
import { Fragment, useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import clsx from "clsx";
import { Button, EmptyState, IconButton, Input, Spinner, Tabs, T } from "@/ui";
import { call, commands, type RedisReply } from "@/platform/ipc";
import type { EditorInput } from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";
import { tx } from "@/platform/i18n";
import { sourceById, withConnection } from "../store";
import { redisTarget, sizeLabel, textBytes, ttlLabel, type RedisInfoRef } from "./model";
import styles from "./ServerInfo.module.css";

export interface InfoSection {
  name: string;
  fields: Array<[string, string]>;
}

/** `INFO` text → sections of `key:value` fields. */
export function parseInfo(text: string): InfoSection[] {
  const out: InfoSection[] = [];
  let current: InfoSection | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      current = { name: line.slice(1).trim(), fields: [] };
      out.push(current);
      continue;
    }
    const i = line.indexOf(":");
    if (i < 0) continue;
    if (!current) out.push((current = { name: "Info", fields: [] }));
    current.fields.push([line.slice(0, i), line.slice(i + 1)]);
  }
  return out;
}

export interface SlowEntry {
  id: string;
  time: number;
  micros: number;
  command: string;
  client: string;
}

/** `SLOWLOG GET` reply → entries. */
export function parseSlowlog(reply: RedisReply): SlowEntry[] {
  if (reply.kind !== "array") return [];
  const scalar = (r: RedisReply | undefined) =>
    !r ? "" : r.kind === "int" || r.kind === "status" ? r.text : r.kind === "bulk" ? r.value.text : "";
  return reply.items.flatMap((e) => {
    if (e.kind !== "array") return [];
    const [id, time, micros, args, client] = e.items;
    const words = args?.kind === "array" ? args.items.map(scalar) : [];
    return [
      {
        id: scalar(id),
        time: Number(scalar(time)) * 1000,
        micros: Number(scalar(micros)),
        command: words.join(" "),
        client: scalar(client),
      },
    ];
  });
}

/** `CLIENT LIST` text → one record per client (`id=3 addr=… cmd=…`). */
export function parseClients(text: string): Array<Record<string, string>> {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) =>
      Object.fromEntries(
        l
          .trim()
          .split(" ")
          .map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]),
      ),
    );
}

const uptime = (seconds: number) => {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

type Tab = "overview" | "slowlog" | "clients" | "info";
const REFRESH_MS = 5000;

export function RedisServerInfo({ input }: { input: EditorInput }) {
  const { id } = input.data as RedisInfoRef;
  const source = sourceById(id);
  const [tab, setTab] = useState<Tab>("overview");
  const [sections, setSections] = useState<InfoSection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [live, setLive] = useState(false);
  const [at, setAt] = useState<number | null>(null);

  const fetchInfo = useCallback(
    () =>
      withConnection(id, () => call(commands.redisInfo(id, null)))
        .then(
          (text) => {
            setSections(parseInfo(text));
            setError(null);
            setAt(Date.now());
          },
          (e) => setError(e instanceof Error ? e.message : String(e)),
        )
        .finally(() => setBusy(false)),
    [id],
  );
  const load = () => {
    setBusy(true);
    void fetchInfo();
  };

  useEffect(() => {
    void fetchInfo();
  }, [fetchInfo]);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => void fetchInfo(), REFRESH_MS);
    return () => clearInterval(t);
  }, [live, fetchInfo]);

  const field = useMemo(() => {
    const all = new Map<string, string>();
    for (const s of sections ?? []) for (const [k, v] of s.fields) all.set(k, v);
    return (k: string) => all.get(k);
  }, [sections]);

  if (error && !sections)
    return (
      <EmptyState title="Cannot read the server information">
        <span className={styles.error}>{error}</span>
        <Button variant="ghost" onClick={() => void load()}>
          <T>Retry</T>
        </Button>
      </EmptyState>
    );
  if (!sections) return <EmptyState title="Loading…" />;

  const version = field("valkey_version") ?? field("redis_version") ?? "";
  const upFor = uptime(Number(field("uptime_in_seconds") ?? 0));
  const product = field("valkey_version") ? "Valkey" : "Redis";
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.title}>
          <span className={styles.name}>{source?.name ?? id}</span>
          <span className={styles.meta}>
            {product} {version} · {field("redis_mode") ?? "standalone"} · {field("role") ?? ""} · {tx`up ${upFor}`}
          </span>
        </div>
        <span className={styles.spacer} />
        {busy && <Spinner size={12} />}
        {at && (
          <span className={styles.meta} title={new Date(at).toLocaleString()}>
            {new Date(at).toLocaleTimeString()}
          </span>
        )}
        <Button size="small" aria-pressed={live} onClick={() => setLive(!live)}>
          {live ? <T>Stop Auto-Refresh</T> : <T>Auto-Refresh (5 s)</T>}
        </Button>
        <IconButton icon="refresh" title="Refresh" disabled={busy} onClick={() => void load()} />
      </header>
      <Tabs
        variant="compact"
        className={styles.tabs}
        aria-label="Server information"
        activeId={tab}
        onSelect={(t) => setTab(t as Tab)}
        items={[
          { id: "overview", label: "Overview" },
          { id: "slowlog", label: "Slow Log" },
          { id: "clients", label: "Clients" },
          { id: "info", label: "All Info" },
        ]}
      />
      <div className={styles.body}>
        {tab === "overview" ? (
          <Overview field={field} sections={sections} />
        ) : tab === "slowlog" ? (
          <SlowLog id={id} />
        ) : tab === "clients" ? (
          <Clients id={id} readOnly={!!source?.readOnly} />
        ) : (
          <AllInfo sections={sections} />
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "warn" | "bad" }) {
  return (
    <div className={clsx(styles.metric, tone === "warn" && styles.warn, tone === "bad" && styles.bad)}>
      <span className={styles.metricLabel}>
        <T>{label}</T>
      </span>
      <span className={styles.metricValue}>{value}</span>
      {sub && <span className={styles.metricSub}>{sub}</span>}
    </div>
  );
}

/** Label / value rows of a panel; rows without a value are left out. */
function Facts({ rows }: { rows: Array<[label: string, value: string | undefined]> }) {
  return (
    <dl className={styles.facts}>
      {rows
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([label, v]) => (
          <Fragment key={label}>
            <dt>
              <T>{label}</T>
            </dt>
            <dd title={v}>{v}</dd>
          </Fragment>
        ))}
    </dl>
  );
}

export interface CommandStat {
  name: string;
  calls: number;
  usecPerCall: number;
}

/** `cmdstat_get:calls=10,usec=52,usec_per_call=5.20,…` lines → the busiest commands. */
export function commandStats(sections: InfoSection[], top = 10): CommandStat[] {
  const s = sections.find((x) => x.name.toLowerCase() === "commandstats");
  return (s?.fields ?? [])
    .map(([k, v]) => {
      const get = (name: string) => Number(new RegExp(`(?:^|,)${name}=([\\d.]+)`).exec(v)?.[1] ?? 0);
      return {
        name: k
          .replace(/^cmdstat_/, "")
          .replace("|", " ")
          .toUpperCase(),
        calls: get("calls"),
        usecPerCall: get("usec_per_call"),
      };
    })
    .filter((c) => c.calls > 0)
    .sort((a, b) => b.calls - a.calls)
    .slice(0, top);
}

/** The busiest commands, with a bar of their share of the calls. */
function TopCommands({ sections }: { sections: InfoSection[] }) {
  const stats = commandStats(sections);
  const most = stats[0]?.calls ?? 1;
  return (
    <section className={styles.panel} aria-label={tx("Top Commands")}>
      <h3>
        <T>Top Commands</T>
      </h3>
      {stats.length ? (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>
                <T>Command</T>
              </th>
              <th className={styles.num}>
                <T>Calls</T>
              </th>
              <th className={styles.num}>
                <T>Average</T>
              </th>
            </tr>
          </thead>
          <tbody>
            {stats.map((c) => (
              <tr key={c.name}>
                <td
                  className={clsx(styles.code, styles.share)}
                  style={{ "--share": `${(c.calls / most) * 100}%` } as CSSProperties}
                >
                  {c.name}
                </td>
                <td className={styles.num}>{c.calls.toLocaleString("en")}</td>
                <td className={styles.num}>
                  {c.usecPerCall < 1000 ? `${c.usecPerCall.toFixed(1)} µs` : `${(c.usecPerCall / 1000).toFixed(1)} ms`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <span className={styles.meta}>
          <T>No commands yet</T>
        </span>
      )}
    </section>
  );
}

function Overview({ field, sections }: { field: (k: string) => string | undefined; sections: InfoSection[] }) {
  const n = (k: string) => Number(field(k) ?? 0);
  const used = n("used_memory");
  const max = n("maxmemory");
  const hits = n("keyspace_hits");
  const misses = n("keyspace_misses");
  const rate = hits + misses ? (hits / (hits + misses)) * 100 : null;
  const frag = Number(field("mem_fragmentation_ratio") ?? 0);
  const keyspace = sections.find((s) => s.name.toLowerCase() === "keyspace")?.fields ?? [];
  const dbs = keyspace.map(([db, v]) => {
    const get = (name: string) => Number(new RegExp(`(?:^|,)${name}=(\\d+)`).exec(v)?.[1] ?? 0);
    return { db, keys: get("keys"), expires: get("expires"), avgTtl: get("avg_ttl") };
  });
  const totalKeys = dbs.reduce((a, d) => a + d.keys, 0);
  const lastSave = n("rdb_last_save_time");
  const fmt = (x: number) => x.toLocaleString("en");
  const fragText = frag ? frag.toFixed(2) : "—";
  const upDays = field("uptime_in_days") ?? "0";
  const [maxText, percent, peak] = [
    sizeLabel(max),
    max ? Math.round((used / max) * 100) : 0,
    sizeLabel(n("used_memory_peak")),
  ];
  const [blocked, perSecond, commandsTotal] = [
    fmt(n("blocked_clients")),
    fmt(n("instantaneous_ops_per_sec")),
    fmt(n("total_commands_processed")),
  ];
  const [hitCount, missCount, expired, evicted] = [
    fmt(hits),
    fmt(misses),
    fmt(n("expired_keys")),
    fmt(n("evicted_keys")),
  ];
  const [savedAt, changes] = [new Date(lastSave * 1000).toLocaleString(), fmt(n("rdb_changes_since_last_save"))];
  return (
    <div className={styles.overview}>
      <div className={styles.metrics}>
        <Metric
          label="Memory"
          value={sizeLabel(used)}
          sub={
            max
              ? tx`of ${maxText} (${percent}%) · fragmentation ${fragText}`
              : tx`peak ${peak} · fragmentation ${fragText}`
          }
          tone={max && used / max > 0.9 ? "bad" : (max && used / max > 0.75) || frag > 1.5 ? "warn" : undefined}
        />
        <Metric label="Clients" value={String(n("connected_clients"))} sub={tx`${blocked} blocked`} />
        <Metric label="Operations" value={tx`${perSecond}/s`} sub={tx`${commandsTotal} total`} />
        <Metric
          label="Hit rate"
          value={rate === null ? "—" : `${rate.toFixed(1)}%`}
          sub={tx`${hitCount} hits · ${missCount} misses`}
          tone={rate !== null && rate < 80 && hits + misses > 1000 ? "warn" : undefined}
        />
        <Metric
          label="Keys"
          value={totalKeys.toLocaleString("en")}
          sub={tx`${expired} expired, ${evicted} evicted`}
          tone={n("evicted_keys") > 0 ? "warn" : undefined}
        />
        <Metric
          label="Network"
          value={`${field("instantaneous_input_kbps") ?? "0"} / ${field("instantaneous_output_kbps") ?? "0"}`}
          sub={tx("KB/s in / out")}
        />
      </div>
      <div className={styles.panels}>
        <section className={styles.panel} aria-label={tx("Keyspace")}>
          <h3>
            <T>Keyspace</T>
          </h3>
          {dbs.length ? (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>
                    <T>Database</T>
                  </th>
                  <th className={styles.num}>
                    <T>Keys</T>
                  </th>
                  <th className={styles.num}>
                    <T>With TTL</T>
                  </th>
                  <th className={styles.num}>
                    <T>Average TTL</T>
                  </th>
                </tr>
              </thead>
              <tbody>
                {dbs.map((d) => (
                  <tr key={d.db}>
                    <td>{d.db}</td>
                    <td className={styles.num}>{d.keys.toLocaleString("en")}</td>
                    <td className={styles.num}>{d.expires.toLocaleString("en")}</td>
                    <td className={styles.num}>{d.avgTtl ? ttlLabel(d.avgTtl) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <span className={styles.meta}>
              <T>No keys</T>
            </span>
          )}
        </section>
        <TopCommands sections={sections} />
        <section className={styles.panel} aria-label={tx("Memory")}>
          <h3>
            <T>Memory</T>
          </h3>
          <Facts
            rows={[
              ["Used", sizeLabel(used)],
              ["Resident (RSS)", sizeLabel(n("used_memory_rss"))],
              ["Peak", sizeLabel(n("used_memory_peak"))],
              [
                "Dataset",
                field("used_memory_dataset")
                  ? `${sizeLabel(n("used_memory_dataset"))} (${field("used_memory_dataset_perc") ?? ""})`
                  : undefined,
              ],
              ["Overhead", field("used_memory_overhead") ? sizeLabel(n("used_memory_overhead")) : undefined],
              ["Limit", max ? sizeLabel(max) : tx("No limit")],
              ["Eviction policy", field("maxmemory_policy")],
              ["Fragmentation", fragText],
              ["Allocator", field("mem_allocator")],
            ]}
          />
        </section>
        <section className={styles.panel} aria-label={tx("Connections and Traffic")}>
          <h3>
            <T>Connections and Traffic</T>
          </h3>
          <Facts
            rows={[
              ["Connections received", fmt(n("total_connections_received"))],
              ["Rejected connections", fmt(n("rejected_connections"))],
              ["Maximum clients", field("maxclients")],
              ["Bytes in", sizeLabel(n("total_net_input_bytes"))],
              ["Bytes out", sizeLabel(n("total_net_output_bytes"))],
              ["Pub/Sub channels", field("pubsub_channels")],
              ["Pub/Sub patterns", field("pubsub_patterns")],
              ["Expired keys", expired],
              ["Evicted keys", evicted],
            ]}
          />
        </section>
        <section className={styles.panel} aria-label={tx("Persistence and Replication")}>
          <h3>
            <T>Persistence</T>
          </h3>
          <Facts
            rows={[
              ["RDB", lastSave ? tx`saved ${savedAt}` : "—"],
              ["Changes since", changes],
              ["Last save", field("rdb_last_bgsave_status")],
              ["AOF", field("aof_enabled") === "1" ? tx("Enabled") : tx("Disabled")],
            ]}
          />
          <h3>
            <T>Replication</T>
          </h3>
          <Facts
            rows={[
              ["Role", field("role")],
              ["Replicas", field("connected_slaves") ?? "0"],
              [
                "Primary",
                field("master_host")
                  ? `${field("master_host")}:${field("master_port")} (${field("master_link_status") ?? ""})`
                  : undefined,
              ],
            ]}
          />
        </section>
        <section className={styles.panel} aria-label={tx("Server")}>
          <h3>
            <T>Server</T>
          </h3>
          <Facts
            rows={[
              ["Operating system", field("os")],
              ["Architecture", field("arch_bits") ? `${field("arch_bits")}-bit` : undefined],
              ["Port", field("tcp_port")],
              ["Process ID", field("process_id")],
              ["Executable", field("executable")],
              ["Configuration file", field("config_file") || undefined],
              ["Event loop", field("multiplexing_api")],
              ["Uptime", tx`${upDays} days`],
            ]}
          />
        </section>
      </div>
    </div>
  );
}

function SlowLog({ id }: { id: string }) {
  const [entries, setEntries] = useState<SlowEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const target = redisTarget(id, 0);
  const load = useCallback(
    () =>
      withConnection(target, () => call(commands.redisCommand(target, ["SLOWLOG", "GET", "128"].map(textBytes)))).then(
        (r) => {
          setEntries(parseSlowlog(r));
          setError(null);
        },
        (e) => setError(e instanceof Error ? e.message : String(e)),
      ),
    [target],
  );
  useEffect(() => {
    void load();
  }, [load]);
  if (error) return <span className={styles.error}>{error}</span>;
  if (!entries) return <Spinner size={14} />;
  if (!entries.length) return <EmptyState title="No slow commands" />;
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>#</th>
          <th>
            <T>Time</T>
          </th>
          <th className={styles.num}>
            <T>Duration</T>
          </th>
          <th>
            <T>Command</T>
          </th>
          <th>
            <T>Client</T>
          </th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.id}>
            <td>{e.id}</td>
            <td>{new Date(e.time).toLocaleString()}</td>
            <td className={styles.num}>{e.micros >= 1000 ? `${(e.micros / 1000).toFixed(1)} ms` : `${e.micros} µs`}</td>
            <td className={styles.code} title={e.command}>
              {e.command}
            </td>
            <td>{e.client}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Clients({ id, readOnly }: { id: string; readOnly: boolean }) {
  const [clients, setClients] = useState<Array<Record<string, string>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const target = redisTarget(id, 0);
  const load = useCallback(
    () =>
      withConnection(target, () => call(commands.redisCommand(target, ["CLIENT", "LIST"].map(textBytes)))).then(
        (r) => {
          const text = r.kind === "bulk" ? r.value.text : r.kind === "verbatim" ? r.text : "";
          setClients(parseClients(text));
          setError(null);
        },
        (e) => setError(e instanceof Error ? e.message : String(e)),
      ),
    [target],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const kill = async (c: Record<string, string>) => {
    const [clientId, address] = [c.id ?? "", c.addr ?? ""];
    const ok = await confirm({
      title: "Kill Client",
      message: tx`Close the connection of client ${clientId} (${address})?`,
      ok: "Kill",
    });
    if (!ok) return;
    try {
      await call(commands.redisCommand(target, ["CLIENT", "KILL", "ID", c.id ?? ""].map(textBytes)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    void load();
  };
  if (error && !clients) return <span className={styles.error}>{error}</span>;
  if (!clients) return <Spinner size={14} />;
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>ID</th>
          <th>
            <T>Address</T>
          </th>
          <th>
            <T>Name</T>
          </th>
          <th className={styles.num}>
            <T>Age</T>
          </th>
          <th className={styles.num}>
            <T>Idle</T>
          </th>
          <th className={styles.num}>DB</th>
          <th>
            <T>Last command</T>
          </th>
          {!readOnly && <th />}
        </tr>
      </thead>
      <tbody>
        {clients.map((c) => (
          <tr key={c.id}>
            <td>{c.id}</td>
            <td>{c.addr}</td>
            <td>{c.name}</td>
            <td className={styles.num}>{uptime(Number(c.age ?? 0))}</td>
            <td className={styles.num}>{c.idle ? `${c.idle} s` : ""}</td>
            <td className={styles.num}>{c.db}</td>
            <td className={styles.code}>{c.cmd}</td>
            {!readOnly && (
              <td>
                <IconButton icon="close" title="Kill Client" size="small" onClick={() => void kill(c)} />
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AllInfo({ sections }: { sections: InfoSection[] }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = sections
    .map((s) => ({
      ...s,
      fields: s.fields.filter(([k, v]) => !q || k.toLowerCase().includes(q) || v.toLowerCase().includes(q)),
    }))
    .filter((s) => s.fields.length);
  return (
    <div className={styles.allInfo}>
      <Input
        className={styles.filter}
        aria-label="Filter fields"
        placeholder={tx("Filter fields")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {shown.map((s) => (
        <section key={s.name} className={styles.panel} aria-label={s.name}>
          <h3>{s.name}</h3>
          <table className={styles.table}>
            <tbody>
              {s.fields.map(([k, v]) => (
                <tr key={k}>
                  <td className={styles.fieldName}>{k}</td>
                  <td className={styles.code}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
