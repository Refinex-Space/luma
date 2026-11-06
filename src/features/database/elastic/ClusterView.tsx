/**
 * Elasticsearch › Cluster Overview (an editor tab per data source): health, version and
 * totals; shard allocation as one bar; the nodes with their heap, CPU and disk; the
 * indices, sortable and filterable, each opening Discover.
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import clsx from "clsx";
import type { EsIndex } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { EmptyState, IconButton, Input, Spinner, T, showContextMenu } from "@/ui";
import type { EditorInput } from "@/workbench/contributions";
import { sourceById } from "../store";
import { sizeLabel } from "../redis/model";
import { elasticNodeMenu } from "./actions";
import { compactCount, healthColor, type EsClusterRef } from "./model";
import { esJson, loadCluster, loadIndices, openDiscover, showsHidden, useElastic } from "./store";
import info from "../redis/ServerInfo.module.css";
import css from "./ClusterView.module.css";
import es from "./Elastic.module.css";

/** A node of `_cat/nodes` (the columns asked for). */
export interface EsNodeRow {
  name: string;
  ip: string;
  "node.role": string;
  master: string;
  "heap.percent": string;
  cpu: string;
  "disk.used_percent": string;
  version: string;
}

const NODE_COLUMNS = "name,ip,node.role,master,heap.percent,cpu,disk.used_percent,version";

/** A percentage's level: quiet below 70, warning below 90, else danger (Kibana's thresholds). */
export function level(percent: number): "ok" | "warn" | "bad" {
  return percent >= 90 ? "bad" : percent >= 70 ? "warn" : "ok";
}

type SortKey = "name" | "health" | "docs" | "size" | "shards";

const HEALTH_RANK: Record<string, number> = { red: 0, yellow: 1, green: 2, "": 3 };

export function sortIndices(rows: readonly EsIndex[], key: SortKey, desc: boolean): EsIndex[] {
  const by = (a: EsIndex, b: EsIndex): number => {
    switch (key) {
      case "name":
        return a.name.localeCompare(b.name);
      case "health":
        return (HEALTH_RANK[a.health] ?? 3) - (HEALTH_RANK[b.health] ?? 3);
      case "docs":
        return (a.docs ?? 0) - (b.docs ?? 0);
      case "size":
        return (a.storeBytes ?? 0) - (b.storeBytes ?? 0);
      case "shards":
        return a.primaries * (1 + a.replicas) - b.primaries * (1 + b.replicas);
    }
  };
  return [...rows].sort((a, b) => (desc ? by(b, a) : by(a, b)) || a.name.localeCompare(b.name));
}

function Meter({ value }: { value: number }) {
  const v = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  return (
    <span className={clsx(css.meter, css[level(v)])} title={`${v}%`}>
      <i style={{ width: `${v}%` }} />
      <b>{Number.isFinite(value) ? `${v}%` : "—"}</b>
    </span>
  );
}

export function EsClusterView({ input }: { input: EditorInput }) {
  const { id } = input.data as EsClusterRef;
  const cluster = useElastic((s) => s.cluster[id]);
  const indices = useElastic((s) => s.indices[id]);
  const [nodes, setNodes] = useState<{ rows: EsNodeRow[] | null; error: string | null }>({ rows: null, error: null });
  const [version, setVersion] = useState(0);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "docs", desc: true });

  useEffect(() => {
    void loadCluster(id);
    void loadIndices(id);
    let live = true;
    esJson<EsNodeRow[]>(id, "GET", `/_cat/nodes?format=json&h=${NODE_COLUMNS}`).then(
      (rows) => live && setNodes({ rows, error: null }),
      (e: unknown) => live && setNodes({ rows: null, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [id, version]);

  const shown = useMemo(() => {
    if (indices?.status !== "ok") return [];
    const hidden = showsHidden(id);
    const q = filter.trim().toLowerCase();
    const rows = indices.value.indices.filter(
      (i) => (hidden || (!i.hidden && !i.dataStream)) && (!q || i.name.toLowerCase().includes(q)),
    );
    return sortIndices(rows, sort.key, sort.desc);
  }, [indices, filter, sort, id]);

  const source = sourceById(id);
  if (!cluster || (cluster.status === "loading" && !indices)) return <EmptyState title="Loading…" />;
  if (cluster.status === "error") return <pre className={clsx(info.body, info.error)}>{cluster.message}</pre>;
  if (cluster.status !== "ok") return <EmptyState title="Loading…" />;
  const c = cluster.value;
  const shards = c.activeShards + c.relocatingShards + c.initializingShards + c.unassignedShards;
  const pct = (n: number) => (shards ? `${(n / shards) * 100}%` : "0%");
  const product = c.distribution === "opensearch" ? "OpenSearch" : "Elasticsearch";

  const header = (key: SortKey, label: string, num = false) => {
    const on = sort.key === key;
    return (
      <th className={clsx(num && info.num)} aria-sort={on ? (sort.desc ? "descending" : "ascending") : undefined}>
        <button
          type="button"
          className={css.sortButton}
          onClick={() => setSort({ key, desc: on ? !sort.desc : key !== "name" })}
        >
          <T>{label}</T>
          {on && <span className={css.sortMark}>{sort.desc ? "↓" : "↑"}</span>}
        </button>
      </th>
    );
  };

  const docs = (c.docs ?? 0).toLocaleString("en");
  const totalShards = shards.toLocaleString("en");
  return (
    <div className={info.page}>
      <div className={info.header}>
        <span className={css.health} style={{ "--dot": healthColor(c.status) } as CSSProperties}>
          {c.status}
        </span>
        <div className={info.title}>
          <span className={info.name}>{c.name}</span>
          <span className={info.meta}>
            {product} {c.version} · {source?.name ?? id}
          </span>
        </div>
        <span className={info.spacer} />
        {(cluster.status !== "ok" || indices?.status === "loading") && <Spinner size={12} />}
        <IconButton icon="refresh" title="Refresh" onClick={() => setVersion((v) => v + 1)} />
      </div>
      <div className={info.body}>
        <div className={info.overview}>
          <div className={info.metrics}>
            <div className={info.metric}>
              <span className={info.metricLabel}>
                <T>Nodes</T>
              </span>
              <span className={info.metricValue}>{c.nodes}</span>
              <span className={info.metricSub}>{tx`${c.dataNodes} data`}</span>
            </div>
            <div className={info.metric}>
              <span className={info.metricLabel}>
                <T>Indices</T>
              </span>
              <span className={info.metricValue}>{c.indices.toLocaleString("en")}</span>
            </div>
            <div className={info.metric}>
              <span className={info.metricLabel}>
                <T>Documents</T>
              </span>
              <span className={info.metricValue} title={docs}>
                {compactCount(c.docs ?? 0)}
              </span>
            </div>
            <div className={info.metric}>
              <span className={info.metricLabel}>
                <T>Store size</T>
              </span>
              <span className={info.metricValue}>{sizeLabel(c.storeBytes ?? 0)}</span>
            </div>
            <div className={clsx(info.metric, c.unassignedShards > 0 && (c.status === "red" ? info.bad : info.warn))}>
              <span className={info.metricLabel}>
                <T>Shards</T>
              </span>
              <span className={info.metricValue}>{c.activeShards.toLocaleString("en")}</span>
              <span className={info.metricSub}>
                {c.unassignedShards
                  ? tx`${c.unassignedShards} unassigned of ${totalShards}`
                  : tx`${c.activePrimaryShards} primary`}
              </span>
            </div>
          </div>

          <section className={info.panel} aria-label={tx("Shard Allocation")}>
            <h3>
              <T>Shard Allocation</T>
            </h3>
            <div className={css.shardBar} role="img" aria-label={tx`${totalShards} shards`}>
              <i className={css.active} style={{ width: pct(c.activeShards) }} />
              <i className={css.relocating} style={{ width: pct(c.relocatingShards) }} />
              <i className={css.initializing} style={{ width: pct(c.initializingShards) }} />
              <i className={css.unassigned} style={{ width: pct(c.unassignedShards) }} />
            </div>
            <div className={css.legend}>
              <span>
                <i className={css.active} />
                <T>Active</T> <b>{c.activeShards}</b>
              </span>
              <span>
                <i className={css.relocating} />
                <T>Relocating</T> <b>{c.relocatingShards}</b>
              </span>
              <span>
                <i className={css.initializing} />
                <T>Initializing</T> <b>{c.initializingShards}</b>
              </span>
              <span>
                <i className={css.unassigned} />
                <T>Unassigned</T> <b>{c.unassignedShards}</b>
              </span>
            </div>
          </section>

          <section className={info.panel} aria-label={tx("Nodes")}>
            <h3>
              <T>Nodes</T>
            </h3>
            {nodes.error ? (
              <div className={info.error}>{nodes.error}</div>
            ) : !nodes.rows ? (
              <Spinner size={12} />
            ) : (
              <table className={info.table}>
                <thead>
                  <tr>
                    <th>
                      <T>Name</T>
                    </th>
                    <th>IP</th>
                    <th>
                      <T>Roles</T>
                    </th>
                    <th>
                      <T>Heap</T>
                    </th>
                    <th>CPU</th>
                    <th>
                      <T>Disk</T>
                    </th>
                    <th>
                      <T>Version</T>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {nodes.rows.map((n) => (
                    <tr key={n.name}>
                      <td>
                        <span className={css.nodeName}>
                          {n.master === "*" && (
                            <span className={css.masterMark} title={tx("Elected master")}>
                              ★
                            </span>
                          )}
                          {n.name}
                        </span>
                      </td>
                      <td className={info.code}>{n.ip}</td>
                      <td className={info.code}>{n["node.role"]}</td>
                      <td>
                        <Meter value={Number(n["heap.percent"])} />
                      </td>
                      <td>
                        <Meter value={Number(n.cpu)} />
                      </td>
                      <td>
                        <Meter value={Number(n["disk.used_percent"])} />
                      </td>
                      <td className={info.code}>{n.version}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className={info.panel} aria-label={tx("Indices")}>
            <div className={css.panelHead}>
              <h3>
                <T>Indices</T>
              </h3>
              <span className={info.spacer} />
              <Input
                className={css.filter}
                aria-label="Filter indices"
                placeholder={tx("Filter")}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            {indices?.status === "error" ? (
              <div className={info.error}>{indices.message}</div>
            ) : (
              <table className={info.table}>
                <thead>
                  <tr>
                    {header("health", "Health")}
                    {header("name", "Name")}
                    {header("docs", "Documents", true)}
                    {header("size", "Size", true)}
                    {header("shards", "Shards", true)}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((i) => (
                    <tr
                      key={i.name}
                      className={css.indexRow}
                      onDoubleClick={() => i.status !== "close" && void openDiscover(id, i.name)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        showContextMenu(
                          e,
                          elasticNodeMenu(
                            { kind: "esIndex", key: `${id}/i:${i.name}`, id, index: i },
                            !!source?.readOnly,
                          ),
                        );
                      }}
                    >
                      <td>
                        <span
                          className={es.healthDot}
                          style={{ "--dot": healthColor(i.health) } as CSSProperties}
                          title={i.health}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className={css.indexName}
                          disabled={i.status === "close"}
                          onClick={() => void openDiscover(id, i.name)}
                        >
                          {i.name}
                        </button>
                        {i.status === "close" && (
                          <span className={css.closed}>
                            <T>closed</T>
                          </span>
                        )}
                      </td>
                      <td className={info.num}>{(i.docs ?? 0).toLocaleString("en")}</td>
                      <td className={info.num}>{sizeLabel(i.storeBytes ?? 0)}</td>
                      <td className={info.num}>{`${i.primaries} × ${1 + i.replicas}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
