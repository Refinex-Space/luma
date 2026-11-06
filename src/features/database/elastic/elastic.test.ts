import { describe, expect, it } from "vitest";
import type { EsIndex } from "@/platform/ipc";
import { parseSourceUrl } from "../model";
import { sourceUrl, vendorById, vendorOf, vendorPreset } from "../vendors";
import { patternOf, searchRequest } from "./actions";
import { level, sortIndices } from "./ClusterView";
import { createIndexBody, indexNameError } from "./EsDialogs";
import { compactCount, fieldGroup, healthColor } from "./model";
import { esErrorReason } from "./store";

const index = (name: string, p: Partial<EsIndex> = {}): EsIndex => ({
  name,
  health: "green",
  status: "open",
  uuid: name,
  primaries: 1,
  replicas: 1,
  docs: 0,
  storeBytes: 0,
  hidden: false,
  dataStream: null,
  aliases: [],
  ...p,
});

describe("Elasticsearch data sources", () => {
  it("is a type of its own with HTTPS-first defaults", () => {
    const es = vendorById("elasticsearch")!;
    expect(vendorPreset(es)).toEqual({ driver: "elasticsearch", vendor: "", port: 9200, ssl: "prefer" });
    expect(vendorOf({ driver: "elasticsearch" }).label).toBe("Elasticsearch");
    expect(sourceUrl({ driver: "elasticsearch", host: "search.local", port: 9200, ssl: "disable" } as never)).toBe(
      "http://search.local:9200",
    );
    expect(sourceUrl({ driver: "elasticsearch", host: "search.local", port: 9243, ssl: "require" } as never)).toBe(
      "https://search.local:9243",
    );
  });

  it("reads REST endpoints and its own schemes as Elasticsearch", () => {
    expect(parseSourceUrl("https://elastic:s3cret@my-deployment.es.io")).toMatchObject({
      source: { driver: "elasticsearch", host: "my-deployment.es.io", port: 443, ssl: "require", user: "elastic" },
      password: "s3cret",
    });
    expect(parseSourceUrl("http://localhost:9200")?.source).toMatchObject({ port: 9200, ssl: "disable" });
    expect(parseSourceUrl("elasticsearch://search.local")?.source).toMatchObject({
      driver: "elasticsearch",
      port: 9200,
      ssl: "disable",
    });
    expect(parseSourceUrl("opensearchs://os.local:9201")?.source).toMatchObject({
      driver: "elasticsearch",
      port: 9201,
      ssl: "require",
    });
  });

  it("names health, counts and field types", () => {
    expect(healthColor("yellow")).toBe("var(--es-yellow)");
    expect(healthColor("")).toBe("var(--fg-muted)");
    expect(compactCount(9_999)).toBe("9,999");
    expect(compactCount(12_345)).toBe("12K");
    expect(compactCount(1_234_567)).toBe("1.2M");
    expect(fieldGroup("keyword")).toBe("string");
    expect(fieldGroup("scaled_float")).toBe("number");
    expect(fieldGroup("date_nanos")).toBe("date");
    expect(fieldGroup("nested")).toBe("object");
    expect(fieldGroup("dense_vector")).toBe("other");
  });

  it("checks index names as Elasticsearch does", () => {
    expect(indexNameError("logs-2026.11")).toBeNull();
    expect(indexNameError("Logs")).toMatch(/lower case/);
    expect(indexNameError("a b")).toMatch(/cannot contain/);
    expect(indexNameError("_hidden")).toMatch(/cannot start/);
    expect(indexNameError("..")).toMatch(/Not a valid/);
    expect(indexNameError("")).toMatch(/Enter a name/);
  });

  it("builds the New Index body, mappings as typed or pasted whole", () => {
    expect(createIndexBody(1, 0, "")).toEqual({ settings: { number_of_shards: 1, number_of_replicas: 0 } });
    const props = { properties: { message: { type: "text" } } };
    expect(createIndexBody(3, 1, JSON.stringify(props)).mappings).toEqual(props);
    expect(createIndexBody(1, 1, JSON.stringify({ mappings: props })).mappings).toEqual(props);
  });

  it("reads Elasticsearch's own errors", () => {
    const body = JSON.stringify({
      error: {
        type: "search_phase_execution_exception",
        reason: "all shards failed",
        root_cause: [{ type: "query_shard_exception", reason: 'failed to create query: For input string: "x"' }],
      },
      status: 400,
    });
    expect(esErrorReason({ status: 400, body })).toBe(
      'query_shard_exception: failed to create query: For input string: "x"',
    );
    expect(esErrorReason({ status: 404, body: JSON.stringify({ error: "Incorrect HTTP method" }) })).toBe(
      "Incorrect HTTP method",
    );
    expect(esErrorReason({ status: 502, body: "" })).toBe("HTTP 502");
  });

  it("sorts the cluster's indices by health, size and name", () => {
    const rows = [
      index("b", { health: "green", docs: 5, storeBytes: 10 }),
      index("a", { health: "red", docs: 50, storeBytes: 5 }),
      index("c", { health: "yellow", docs: 5, storeBytes: 99 }),
    ];
    expect(sortIndices(rows, "health", false).map((i) => i.name)).toEqual(["a", "c", "b"]);
    expect(sortIndices(rows, "docs", true).map((i) => i.name)).toEqual(["a", "b", "c"]);
    expect(sortIndices(rows, "size", true).map((i) => i.name)).toEqual(["c", "b", "a"]);
    expect(level(65)).toBe("ok");
    expect(level(75)).toBe("warn");
    expect(level(95)).toBe("bad");
  });

  it("searches what a tree node is", () => {
    const n = { kind: "esIndex", key: "s/i:logs", id: "s", index: index("logs") } as const;
    expect(patternOf(n)).toBe("logs");
    expect(patternOf(null)).toBe("*");
    expect(searchRequest("logs")).toMatch(/^GET \/logs\/_search\n\{/);
  });
});
