/**
 * Elasticsearch data sources, shared vocabulary of the Database feature's Elasticsearch
 * parts (tree, Discover, console, cluster overview): editor inputs, health colours, sizes,
 * field types. Backend: `ide_db::elastic` (`es_*` commands).
 */
import type { EditorInput } from "@/workbench/contributions";

/** Discover tab of an index pattern (`logs-*`, an index, alias or data stream) of a data source. */
export const ES_DISCOVER_KIND = "es-discover";

export interface EsDiscoverRef {
  /** Data source id. */
  id: string;
  /** Index pattern searched (`*` for all). */
  index: string;
}

export function esDiscoverInput(id: string, index: string): EditorInput {
  const data: EsDiscoverRef = { id, index };
  return { kind: ES_DISCOVER_KIND, key: `${ES_DISCOVER_KIND}:${id}:${index}`, data };
}

/** Cluster overview tab of a data source. */
export const ES_CLUSTER_KIND = "es-cluster";

export interface EsClusterRef {
  id: string;
}

export function esClusterInput(id: string): EditorInput {
  const data: EsClusterRef = { id };
  return { kind: ES_CLUSTER_KIND, key: `${ES_CLUSTER_KIND}:${id}`, data };
}

/** Cluster / index health → its colour token (Kibana's green / amber / red). */
export function healthColor(health: string): string {
  switch (health) {
    case "green":
      return "var(--es-green)";
    case "yellow":
      return "var(--es-yellow)";
    case "red":
      return "var(--es-red)";
    default:
      return "var(--fg-muted)";
  }
}

/** Mapping types grouped as Discover's field icons show them. */
export type FieldGroup = "string" | "number" | "date" | "boolean" | "geo" | "ip" | "object" | "binary" | "other";

export function fieldGroup(type: string): FieldGroup {
  switch (type) {
    case "text":
    case "keyword":
    case "constant_keyword":
    case "wildcard":
    case "match_only_text":
    case "search_as_you_type":
    case "version":
      return "string";
    case "long":
    case "integer":
    case "short":
    case "byte":
    case "double":
    case "float":
    case "half_float":
    case "scaled_float":
    case "unsigned_long":
    case "rank_feature":
      return "number";
    case "date":
    case "date_nanos":
      return "date";
    case "boolean":
      return "boolean";
    case "geo_point":
    case "geo_shape":
    case "point":
    case "shape":
      return "geo";
    case "ip":
      return "ip";
    case "object":
    case "nested":
    case "flattened":
      return "object";
    case "binary":
      return "binary";
    default:
      return "other";
  }
}

/** `1,234` / `1.2M`-style counts for tight places (tree badges). */
export function compactCount(n: number): string {
  if (n < 10_000) return n.toLocaleString("en");
  const units: Array<[number, string]> = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [v, u] of units) if (n >= v) return `${(n / v).toFixed(n / v < 10 ? 1 : 0)}${u}`;
  return String(n);
}
