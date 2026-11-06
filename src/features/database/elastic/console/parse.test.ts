import { describe, expect, it } from "vitest";
import { formatBody, isNdjsonPath, parseRequests, requestAt, requestsIn, toCurl } from "./parse";

const CONSOLE = `# Cluster
GET _cluster/health

// search logs
get /logs-*/_search?size=5
{
  "query": {
    "match": { "message": "error" }
  }
}

/* bulk
   load */
POST _bulk
{"index": {"_index": "a", "_id": "1"}}
{"field": "x"}
{ "delete": { "_index": "a",
  "_id": "2" } }

PUT my-index
{
  "settings": { "number_of_replicas": 0 },
}
`;

describe("parseRequests", () => {
  const reqs = parseRequests(CONSOLE);

  it("finds each request with its method, path and offsets", () => {
    expect(reqs.map((r) => [r.method, r.path])).toEqual([
      ["GET", "_cluster/health"],
      ["GET", "/logs-*/_search?size=5"],
      ["POST", "_bulk"],
      ["PUT", "my-index"],
    ]);
    const [health, search] = reqs;
    expect(CONSOLE.slice(health!.from, health!.to)).toBe("GET _cluster/health");
    expect(health!.body).toBeNull();
    expect(health!.error).toBeNull();
    expect(CONSOLE.slice(search!.methodFrom, search!.pathFrom)).toBe("get ");
    expect(CONSOLE.slice(search!.pathFrom, search!.pathTo)).toBe("/logs-*/_search?size=5");
    expect(CONSOLE.slice(search!.bodyFrom!, search!.to)).toBe(
      '{\n  "query": {\n    "match": { "message": "error" }\n  }\n}',
    );
  });

  it("keeps a JSON body as written", () => {
    const search = reqs[1]!;
    expect(search.ndjson).toBe(false);
    expect(search.body).toBe('{\n  "query": {\n    "match": { "message": "error" }\n  }\n}');
    expect(JSON.parse(search.body!)).toEqual({ query: { match: { message: "error" } } });
  });

  it("sends NDJSON bodies one compact value per line", () => {
    const bulk = reqs[2]!;
    expect(bulk.ndjson).toBe(true);
    expect(bulk.error).toBeNull();
    expect(bulk.body).toBe('{"index":{"_index":"a","_id":"1"}}\n{"field":"x"}\n{"delete":{"_index":"a","_id":"2"}}\n');
    // Several values make NDJSON on any path; one value on `_bulk` too.
    expect(parseRequests('POST x/_msearch\n{}\n{"query":{}}')[0]!.ndjson).toBe(true);
    expect(parseRequests('POST _bulk\n{"delete":{"_index":"a","_id":"1"}}')[0]!.body).toBe(
      '{"delete":{"_index":"a","_id":"1"}}\n',
    );
    expect(parseRequests("POST x/_doc\n{}\n[]")[0]!.ndjson).toBe(true);
  });

  it("reports an invalid body with its position", () => {
    const put = reqs[3]!;
    expect(put.error).toBe('Unexpected "}" after "," at line 23, column 1');
    expect(CONSOLE.slice(put.errorFrom!, put.errorTo!)).toBe("}");
    // The request still spans its body.
    expect(CONSOLE.slice(put.from, put.to)).toBe('PUT my-index\n{\n  "settings": { "number_of_replicas": 0 },\n}');
    const bad = (body: string) => parseRequests(`GET x\n${body}`)[0]!;
    expect(bad('{"a" 1}').error).toBe('Expected ":" at line 2, column 6');
    expect(bad('{"a": 1').error).toBe('Missing closing "}" at line 2, column 1');
    expect(bad('{"a": tru}').error).toBe('Unexpected "tru" at line 2, column 7');
    expect(bad('{"a": "x}').error).toBe("Unterminated string at line 2, column 7");
    expect(bad("{a: 1}").error).toBe('Unexpected "a" at line 2, column 2');
    expect(bad('{"a": 1 "b": 2}').error).toBe('Expected "," or "}" at line 2, column 9');
    expect(bad('{"a": [1, 2}').error).toBe('Expected "," or "]" at line 2, column 12');
    expect(bad('{"a": "\\q"}').error).toBe("Invalid escape in string at line 2, column 8");
  });

  it("skips comments around and inside bodies", () => {
    const [r] = parseRequests('GET x/_search\n# first\n{\n  // the query\n  "size": 1 /* one */\n}\n# after\n');
    expect(r!.error).toBeNull();
    expect(JSON.parse(r!.body!)).toEqual({ size: 1 });
    expect(r!.body).not.toContain("//");
  });

  it("sends Kibana triple-quoted strings as JSON strings", () => {
    const [r] = parseRequests('POST _query\n{\n  "query": """\n    FROM logs | WHERE a == "x"\n  """\n}');
    expect(r!.error).toBeNull();
    expect(JSON.parse(r!.body!)).toEqual({ query: '\n    FROM logs | WHERE a == "x"\n  ' });
  });

  it("needs a method at column 0 followed by a path", () => {
    expect(parseRequests("  GET x\nGETX y\nGET\n").map((r) => [r.method, r.path, r.error])).toEqual([
      ["GET", "", "Missing request path"],
    ]);
    expect(parseRequests("delete /idx\r\nhead idx").map((r) => [r.method, r.path])).toEqual([
      ["DELETE", "/idx"],
      ["HEAD", "idx"],
    ]);
    expect(parseRequests("")).toEqual([]);
    expect(parseRequests("# only a comment")).toEqual([]);
  });

  it("knows NDJSON endpoints", () => {
    expect(isNdjsonPath("/_bulk?refresh")).toBe(true);
    expect(isNdjsonPath("logs/_msearch")).toBe(true);
    expect(isNdjsonPath("_msearch/template")).toBe(true);
    expect(isNdjsonPath("logs/_search")).toBe(false);
  });
});

describe("requestAt / requestsIn", () => {
  const at = (marker: string, delta = 0) => {
    const r = requestAt(CONSOLE, CONSOLE.indexOf(marker) + delta);
    return r ? r.path : null;
  };

  it("finds the request at the caret", () => {
    expect(at("GET _cluster")).toBe("_cluster/health");
    expect(at("health")).toBe("_cluster/health");
    expect(at('"match"')).toBe("/logs-*/_search?size=5");
    expect(at('"_id": "2"')).toBe("_bulk");
    // The end of a request's last line.
    expect(at("\n\n// search")).toBe("_cluster/health");
  });

  it("takes blank lines after a request, not comments or text before the first one", () => {
    expect(at("\n// search", 1)).toBe("_cluster/health");
    expect(at("// search", 3)).toBeNull();
    expect(at("# Cluster", 2)).toBeNull();
    expect(at("/* bulk", 1)).toBeNull();
    expect(requestAt(CONSOLE, CONSOLE.length)).not.toBeNull();
  });

  it("lists the requests a selection touches", () => {
    const from = CONSOLE.indexOf("health");
    const to = CONSOLE.indexOf('"field"');
    expect(requestsIn(CONSOLE, from, to).map((r) => r.method)).toEqual(["GET", "GET", "POST"]);
    // Ending at a request line's start doesn't take it.
    const put = CONSOLE.indexOf("PUT my-index");
    expect(requestsIn(CONSOLE, CONSOLE.indexOf('{"field"'), put).map((r) => r.method)).toEqual(["POST"]);
    expect(requestsIn(CONSOLE, put + 2, put + 2).map((r) => r.method)).toEqual(["PUT"]);
    expect(requestsIn(CONSOLE, 0, 3)).toEqual([]);
  });
});

describe("formatBody", () => {
  it("pretty-prints JSON with 2 spaces", () => {
    expect(formatBody('{"query":{"match_all":{}},"size":10,"sort":[{"a":"desc"}],"x":[]}')).toBe(
      '{\n  "query": {\n    "match_all": {}\n  },\n  "size": 10,\n  "sort": [\n    {\n      "a": "desc"\n    }\n  ],\n  "x": []\n}',
    );
  });

  it("keeps big numbers, escapes and triple-quoted strings exact", () => {
    expect(formatBody('{"id":12345678901234567890,"s":"a\\"b"}')).toBe(
      '{\n  "id": 12345678901234567890,\n  "s": "a\\"b"\n}',
    );
    expect(formatBody('{"query":"""FROM x"""}')).toBe('{\n  "query": """FROM x"""\n}');
  });

  it("compacts NDJSON one value per line", () => {
    expect(formatBody('{ "index": { "_id": 1 } }\n{\n  "a": 1\n}')).toBe('{"index":{"_id":1}}\n{"a":1}');
  });

  it("leaves invalid JSON alone", () => {
    expect(formatBody('{"a": }')).toBe('{"a": }');
  });
});

describe("toCurl", () => {
  it("writes the request as a curl command", () => {
    const [search, bulk, head] = parseRequests(
      'GET /logs/_search\n{"size": 1}\nPOST _bulk\n{"index":{}}\n{"a":"it\'s"}\nHEAD idx',
    );
    expect(toCurl(search!, "http://localhost:9200/")).toBe(
      "curl -X GET 'http://localhost:9200/logs/_search' \\\n  -H 'Content-Type: application/json' \\\n  -d '{\"size\": 1}'",
    );
    expect(toCurl(bulk!, "https://es:9200")).toBe(
      "curl -X POST 'https://es:9200/_bulk' \\\n  -H 'Content-Type: application/x-ndjson' \\\n  --data-binary '{\"index\":{}}\n{\"a\":\"it'\\''s\"}\n'",
    );
    expect(toCurl(head!, "http://h:9200")).toBe("curl -I 'http://h:9200/idx'");
  });
});
