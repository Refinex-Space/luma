/**
 * What the Elasticsearch console knows about the REST API: the most used endpoints (path
 * templates with `{index}` / `{id}`… parameters, methods, a summary, whether they take a
 * body, a body snippet and their query parameters) and the request body grammar (Query
 * DSL, aggregations, mappings, settings…) as a schema tree for body completion.
 */

export type EsMethod = "GET" | "POST" | "PUT" | "DELETE" | "HEAD" | "PATCH";

export const ES_METHODS: readonly EsMethod[] = ["GET", "POST", "PUT", "DELETE", "HEAD", "PATCH"];

export interface EsApi {
  /** Path template without the leading `/` (`{index}/_doc/{id}`; `""` for the root). */
  path: string;
  methods: readonly EsMethod[];
  summary: string;
  body: "none" | "optional" | "required";
  /** Body snippet inserted for a new request (JSON, NDJSON for `_bulk` / `_msearch`). */
  template?: string;
  /** Key of the body's schema in `DSL_SCHEMAS`. */
  schema?: string;
  /** Schema of the even (header) lines of an NDJSON body (`_msearch`). */
  header?: string;
  ndjson?: boolean;
  /** Query parameters besides the common ones. */
  params?: readonly string[];
}

// ---- endpoints -----------------------------------------------------------------------

const SEARCH_PARAMS = [
  "q",
  "size",
  "from",
  "sort",
  "_source",
  "_source_includes",
  "_source_excludes",
  "track_total_hits",
  "timeout",
  "scroll",
  "routing",
  "preference",
  "search_type",
  "request_cache",
  "allow_partial_search_results",
  "ignore_unavailable",
  "allow_no_indices",
  "expand_wildcards",
  "df",
  "default_operator",
  "analyzer",
  "lenient",
  "explain",
  "version",
  "seq_no_primary_term",
  "terminate_after",
  "stored_fields",
  "docvalue_fields",
  "rest_total_hits_as_int",
  "typed_keys",
];
const WRITE_PARAMS = [
  "refresh",
  "routing",
  "timeout",
  "version",
  "version_type",
  "if_seq_no",
  "if_primary_term",
  "op_type",
  "pipeline",
  "wait_for_active_shards",
  "require_alias",
];
const BY_QUERY_PARAMS = [
  "conflicts",
  "refresh",
  "wait_for_completion",
  "slices",
  "scroll_size",
  "requests_per_second",
  "max_docs",
  "q",
  "routing",
  "pipeline",
  "timeout",
];
const CAT_PARAMS = [
  "v",
  "h",
  "s",
  "help",
  "format",
  "bytes",
  "time",
  "local",
  "master_timeout",
  "expand_wildcards",
  "health",
  "pri",
];
const INDEX_PARAMS = ["ignore_unavailable", "allow_no_indices", "expand_wildcards", "master_timeout", "timeout"];

/** Query parameters every endpoint accepts. */
export const COMMON_PARAMS: readonly string[] = ["pretty", "human", "error_trace", "filter_path", "format"];

/** Parameters written without a value (`?v`, `?pretty`). */
export const FLAG_PARAMS: ReadonlySet<string> = new Set(["pretty", "human", "error_trace", "v", "help"]);

/** Known values of query parameters. */
export const PARAM_VALUES: Readonly<Record<string, readonly string[]>> = {
  format: ["json", "yaml", "txt", "csv", "tsv", "cbor", "smile"],
  refresh: ["true", "false", "wait_for"],
  wait_for_status: ["green", "yellow", "red"],
  expand_wildcards: ["all", "open", "closed", "hidden", "none"],
  conflicts: ["abort", "proceed"],
  level: ["cluster", "indices", "shards"],
  op_type: ["index", "create"],
  bytes: ["b", "kb", "mb", "gb", "tb", "pb"],
  time: ["d", "h", "m", "s", "ms", "micros", "nanos"],
  search_type: ["query_then_fetch", "dfs_query_then_fetch"],
  default_operator: ["AND", "OR"],
  version_type: ["internal", "external", "external_gte"],
  wait_for_completion: ["true", "false"],
  track_total_hits: ["true", "false"],
  health: ["green", "yellow", "red"],
  type: ["cpu", "wait", "block", "mem"],
  group_by: ["nodes", "parents", "none"],
};

type Def = [
  methods: string,
  path: string,
  summary: string,
  extra?: Partial<Pick<EsApi, "body" | "template" | "schema" | "header" | "ndjson" | "params">>,
];

const MATCH_ALL = '{\n  "query": {\n    "match_all": {}\n  }\n}';
const SEARCH = { body: "optional", schema: "search", template: MATCH_ALL, params: SEARCH_PARAMS } as const;
const COUNT = {
  body: "optional",
  schema: "count",
  template: MATCH_ALL,
  params: [
    "q",
    "routing",
    "preference",
    "min_score",
    "terminate_after",
    "df",
    "default_operator",
    "analyzer",
    "lenient",
    ...INDEX_PARAMS,
  ],
} as const;
const DOC_WRITE = { body: "required", template: "{\n  \n}", params: WRITE_PARAMS } as const;
const CAT = { params: CAT_PARAMS } as const;

const DEFS: Def[] = [
  ["GET", "", "Cluster name, version and tagline"],
  // search
  ["GET POST", "_search", "Search all indices", SEARCH],
  ["GET POST", "{index}/_search", "Search documents", SEARCH],
  ["GET POST", "_count", "Count matching documents in all indices", COUNT],
  ["GET POST", "{index}/_count", "Count matching documents", COUNT],
  [
    "GET POST",
    "_msearch",
    "Run several searches (NDJSON header / body lines)",
    {
      body: "required",
      ndjson: true,
      schema: "search",
      header: "msearchHeader",
      template: '{"index": "my-index"}\n{"query": {"match_all": {}}}',
    },
  ],
  [
    "GET POST",
    "{index}/_msearch",
    "Run several searches (NDJSON header / body lines)",
    {
      body: "required",
      ndjson: true,
      schema: "search",
      header: "msearchHeader",
      template: '{}\n{"query": {"match_all": {}}}',
    },
  ],
  [
    "GET POST",
    "{index}/_explain/{id}",
    "Explain why a document matches a query",
    { body: "required", schema: "queryOnly", template: MATCH_ALL },
  ],
  [
    "GET POST",
    "_validate/query",
    "Validate a query without running it",
    { body: "optional", schema: "queryOnly", template: MATCH_ALL, params: ["explain", "rewrite", "all_shards", "q"] },
  ],
  [
    "GET POST",
    "{index}/_validate/query",
    "Validate a query without running it",
    { body: "optional", schema: "queryOnly", template: MATCH_ALL, params: ["explain", "rewrite", "all_shards", "q"] },
  ],
  [
    "GET POST",
    "_search/scroll",
    "Next page of a scroll search",
    { body: "required", schema: "scroll", template: '{\n  "scroll": "1m",\n  "scroll_id": ""\n}' },
  ],
  [
    "DELETE",
    "_search/scroll",
    "Clear scroll contexts",
    { body: "optional", schema: "clearScroll", template: '{\n  "scroll_id": ""\n}' },
  ],
  [
    "POST",
    "{index}/_pit",
    "Open a point in time",
    { params: ["keep_alive", "routing", "preference", "ignore_unavailable", "expand_wildcards"] },
  ],
  ["DELETE", "_pit", "Close a point in time", { body: "required", schema: "pit", template: '{\n  "id": ""\n}' }],
  [
    "GET POST",
    "_field_caps",
    "Capabilities of fields across indices",
    {
      body: "optional",
      schema: "fieldCaps",
      params: ["fields", "include_unmapped", "filters", "types", ...INDEX_PARAMS],
    },
  ],
  [
    "GET POST",
    "{index}/_field_caps",
    "Capabilities of fields",
    {
      body: "optional",
      schema: "fieldCaps",
      params: ["fields", "include_unmapped", "filters", "types", ...INDEX_PARAMS],
    },
  ],
  [
    "GET POST",
    "{index}/_search/template",
    "Search with a search template",
    { body: "required", schema: "searchTemplate", template: '{\n  "id": "",\n  "params": {}\n}' },
  ],
  [
    "GET POST",
    "{index}/_terms_enum",
    "Terms of a field starting with a string",
    { body: "required", schema: "termsEnum", template: '{\n  "field": "",\n  "string": ""\n}' },
  ],
  [
    "GET POST",
    "{index}/_termvectors/{id}",
    "Term vectors of a document",
    { body: "optional", params: ["fields", "field_statistics", "offsets", "payloads", "positions", "term_statistics"] },
  ],
  ["GET POST", "{index}/_search_shards", "Shards a search would run on"],
  [
    "POST",
    "{index}/_async_search",
    "Start an async search",
    { ...SEARCH, params: [...SEARCH_PARAMS, "wait_for_completion_timeout", "keep_on_completion", "keep_alive"] },
  ],
  ["GET DELETE", "_async_search/{id}", "Result of / delete an async search"],
  [
    "POST",
    "{index}/_eql/search",
    "Event query language search",
    { body: "required", schema: "eql", template: '{\n  "query": "any where true"\n}' },
  ],
  // documents
  [
    "GET HEAD",
    "{index}/_doc/{id}",
    "Get a document",
    {
      params: [
        "_source",
        "_source_includes",
        "_source_excludes",
        "stored_fields",
        "routing",
        "preference",
        "realtime",
        "refresh",
        "version",
      ],
    },
  ],
  ["PUT POST", "{index}/_doc/{id}", "Index a document with an id", DOC_WRITE],
  ["DELETE", "{index}/_doc/{id}", "Delete a document", { params: WRITE_PARAMS }],
  ["POST", "{index}/_doc", "Index a document (generated id)", DOC_WRITE],
  ["PUT POST", "{index}/_create/{id}", "Index a document only if it is new", DOC_WRITE],
  [
    "POST",
    "{index}/_update/{id}",
    "Update a document (partial doc or script)",
    {
      body: "required",
      schema: "update",
      template: '{\n  "doc": {\n    \n  }\n}',
      params: [...WRITE_PARAMS, "retry_on_conflict", "_source"],
    },
  ],
  [
    "GET HEAD",
    "{index}/_source/{id}",
    "Source of a document",
    { params: ["_source_includes", "_source_excludes", "routing", "preference"] },
  ],
  [
    "POST PUT",
    "_bulk",
    "Index, create, update or delete many documents (NDJSON)",
    {
      body: "required",
      ndjson: true,
      template: '{"index": {"_index": "my-index", "_id": "1"}}\n{"field": "value"}',
      params: ["refresh", "routing", "pipeline", "timeout", "wait_for_active_shards", "require_alias", "_source"],
    },
  ],
  [
    "POST PUT",
    "{index}/_bulk",
    "Index, create, update or delete many documents (NDJSON)",
    {
      body: "required",
      ndjson: true,
      template: '{"index": {"_id": "1"}}\n{"field": "value"}',
      params: ["refresh", "routing", "pipeline", "timeout", "wait_for_active_shards", "require_alias", "_source"],
    },
  ],
  [
    "GET POST",
    "_mget",
    "Get several documents",
    { body: "required", schema: "mget", template: '{\n  "docs": [\n    { "_index": "my-index", "_id": "1" }\n  ]\n}' },
  ],
  [
    "GET POST",
    "{index}/_mget",
    "Get several documents by id",
    { body: "required", schema: "mget", template: '{\n  "ids": ["1"]\n}' },
  ],
  [
    "POST",
    "{index}/_delete_by_query",
    "Delete the documents matching a query",
    { body: "required", schema: "byQuery", template: MATCH_ALL, params: BY_QUERY_PARAMS },
  ],
  [
    "POST",
    "{index}/_update_by_query",
    "Update the documents matching a query",
    {
      body: "optional",
      schema: "byQuery",
      template: '{\n  "query": {\n    "match_all": {}\n  },\n  "script": {\n    "source": ""\n  }\n}',
      params: BY_QUERY_PARAMS,
    },
  ],
  [
    "POST",
    "_reindex",
    "Copy documents from one index to another",
    {
      body: "required",
      schema: "reindex",
      template: '{\n  "source": {\n    "index": ""\n  },\n  "dest": {\n    "index": ""\n  }\n}',
      params: ["refresh", "wait_for_completion", "slices", "requests_per_second", "max_docs", "timeout"],
    },
  ],
  // indices
  [
    "PUT",
    "{index}",
    "Create an index",
    {
      body: "optional",
      schema: "createIndex",
      template:
        '{\n  "settings": {\n    "number_of_shards": 1,\n    "number_of_replicas": 1\n  },\n  "mappings": {\n    "properties": {\n      \n    }\n  }\n}',
      params: ["wait_for_active_shards", "timeout", "master_timeout"],
    },
  ],
  [
    "GET HEAD",
    "{index}",
    "Index settings, mappings and aliases",
    { params: ["include_defaults", "flat_settings", ...INDEX_PARAMS] },
  ],
  ["DELETE", "{index}", "Delete an index", { params: INDEX_PARAMS }],
  ["GET", "_mapping", "Mappings of all indices"],
  ["GET", "{index}/_mapping", "Mappings of an index", { params: INDEX_PARAMS }],
  [
    "PUT",
    "{index}/_mapping",
    "Add fields to a mapping",
    {
      body: "required",
      schema: "mappings",
      template: '{\n  "properties": {\n    \n  }\n}',
      params: ["write_index_only", ...INDEX_PARAMS],
    },
  ],
  ["GET", "{index}/_mapping/field/{field}", "Mapping of fields", { params: ["include_defaults", ...INDEX_PARAMS] }],
  ["GET", "_settings", "Settings of all indices", { params: ["flat_settings", "include_defaults"] }],
  [
    "GET",
    "{index}/_settings",
    "Settings of an index",
    { params: ["flat_settings", "include_defaults", ...INDEX_PARAMS] },
  ],
  ["GET", "{index}/_settings/{name}", "One setting of an index", { params: ["flat_settings", "include_defaults"] }],
  [
    "PUT",
    "{index}/_settings",
    "Update dynamic index settings",
    {
      body: "required",
      schema: "indexSettings",
      template: '{\n  "index": {\n    "number_of_replicas": 1\n  }\n}',
      params: ["preserve_existing", "reopen", ...INDEX_PARAMS],
    },
  ],
  [
    "PUT",
    "_settings",
    "Update settings of all indices",
    { body: "required", schema: "indexSettings", template: '{\n  "index": {\n    \n  }\n}' },
  ],
  ["GET", "_alias", "All aliases"],
  ["GET HEAD", "_alias/{alias}", "Indices of an alias"],
  ["GET", "{index}/_alias", "Aliases of an index"],
  ["GET HEAD", "{index}/_alias/{alias}", "An alias of an index"],
  [
    "PUT POST",
    "{index}/_alias/{alias}",
    "Add an alias",
    { body: "optional", schema: "alias", template: '{\n  "filter": {\n    "match_all": {}\n  }\n}' },
  ],
  ["DELETE", "{index}/_alias/{alias}", "Remove an alias"],
  [
    "POST",
    "_aliases",
    "Add / remove aliases atomically",
    {
      body: "required",
      schema: "aliases",
      template: '{\n  "actions": [\n    { "add": { "index": "", "alias": "" } }\n  ]\n}',
    },
  ],
  ["GET POST", "_refresh", "Refresh all indices"],
  ["GET POST", "{index}/_refresh", "Make recent writes searchable", { params: INDEX_PARAMS }],
  ["GET POST", "_flush", "Flush all indices"],
  ["GET POST", "{index}/_flush", "Flush an index to disk", { params: ["force", "wait_if_ongoing", ...INDEX_PARAMS] }],
  [
    "POST",
    "_forcemerge",
    "Force merge all indices",
    { params: ["max_num_segments", "only_expunge_deletes", "flush", "wait_for_completion"] },
  ],
  [
    "POST",
    "{index}/_forcemerge",
    "Merge segments of an index",
    { params: ["max_num_segments", "only_expunge_deletes", "flush", "wait_for_completion", ...INDEX_PARAMS] },
  ],
  ["POST", "{index}/_open", "Open a closed index", { params: ["wait_for_active_shards", ...INDEX_PARAMS] }],
  ["POST", "{index}/_close", "Close an index", { params: ["wait_for_active_shards", ...INDEX_PARAMS] }],
  [
    "PUT POST",
    "{index}/_clone/{target}",
    "Clone an index",
    { body: "optional", schema: "resize", template: '{\n  "settings": {}\n}' },
  ],
  [
    "PUT POST",
    "{index}/_shrink/{target}",
    "Shrink an index to fewer primary shards",
    { body: "optional", schema: "resize", template: '{\n  "settings": {\n    "index.number_of_shards": 1\n  }\n}' },
  ],
  [
    "PUT POST",
    "{index}/_split/{target}",
    "Split an index into more primary shards",
    { body: "optional", schema: "resize", template: '{\n  "settings": {\n    "index.number_of_shards": 2\n  }\n}' },
  ],
  [
    "POST",
    "{alias}/_rollover",
    "Roll an alias or data stream over to a new index",
    {
      body: "optional",
      schema: "rollover",
      template: '{\n  "conditions": {\n    "max_age": "7d",\n    "max_primary_shard_size": "50gb"\n  }\n}',
      params: ["dry_run", "lazy", "wait_for_active_shards"],
    },
  ],
  [
    "POST",
    "{alias}/_rollover/{new_index}",
    "Roll an alias over to a named index",
    {
      body: "optional",
      schema: "rollover",
      template: '{\n  "conditions": {\n    "max_docs": 1000000\n  }\n}',
      params: ["dry_run", "wait_for_active_shards"],
    },
  ],
  ["GET", "_stats", "Statistics of all indices", { params: ["level", "fields", "groups"] }],
  ["GET", "{index}/_stats", "Index statistics", { params: ["level", "fields", "groups", ...INDEX_PARAMS] }],
  ["GET", "{index}/_stats/{metric}", "One index statistic (docs, store, indexing…)", { params: ["level"] }],
  ["GET", "_segments", "Segments of all indices"],
  ["GET", "{index}/_segments", "Lucene segments of an index"],
  ["GET", "_recovery", "Shard recoveries of all indices", { params: ["active_only", "detailed"] }],
  ["GET", "{index}/_recovery", "Shard recoveries of an index", { params: ["active_only", "detailed"] }],
  ["GET", "{index}/_shard_stores", "Store information of shard copies", { params: ["status"] }],
  ["POST", "_cache/clear", "Clear caches of all indices"],
  [
    "POST",
    "{index}/_cache/clear",
    "Clear the caches of an index",
    { params: ["fielddata", "query", "request", "fields"] },
  ],
  [
    "GET POST",
    "_analyze",
    "Analyze text",
    { body: "required", schema: "analyze", template: '{\n  "analyzer": "standard",\n  "text": ""\n}' },
  ],
  [
    "GET POST",
    "{index}/_analyze",
    "Analyze text with an index's analyzers",
    { body: "required", schema: "analyze", template: '{\n  "field": "",\n  "text": ""\n}' },
  ],
  ["PUT", "{index}/_block/{block}", "Add a block (read_only, write, metadata…)"],
  [
    "GET",
    "_resolve/index/{index}",
    "Resolve names and patterns to indices, aliases and data streams",
    { params: ["expand_wildcards"] },
  ],
  // _cat
  ["GET", "_cat", "The _cat APIs"],
  ["GET", "_cat/indices", "Indices: health, docs, size", { params: [...CAT_PARAMS, "include_unloaded_segments"] }],
  ["GET", "_cat/indices/{index}", "Indices matching a pattern", CAT],
  ["GET", "_cat/aliases", "Aliases", CAT],
  ["GET", "_cat/aliases/{alias}", "Aliases matching a name", CAT],
  ["GET", "_cat/nodes", "Nodes: roles, heap, load", { params: [...CAT_PARAMS, "full_id"] }],
  ["GET", "_cat/shards", "Shards and where they are", CAT],
  ["GET", "_cat/shards/{index}", "Shards of indices", CAT],
  ["GET", "_cat/health", "Cluster health in one line", { params: [...CAT_PARAMS, "ts"] }],
  ["GET", "_cat/count", "Document count of the cluster", CAT],
  ["GET", "_cat/count/{index}", "Document count of indices", CAT],
  ["GET", "_cat/allocation", "Disk and shards per node", CAT],
  ["GET", "_cat/thread_pool", "Thread pools per node", CAT],
  ["GET", "_cat/thread_pool/{name}", "One thread pool per node", CAT],
  ["GET", "_cat/templates", "Index templates", CAT],
  ["GET", "_cat/component_templates", "Component templates", CAT],
  ["GET", "_cat/segments", "Lucene segments", CAT],
  ["GET", "_cat/segments/{index}", "Lucene segments of indices", CAT],
  ["GET", "_cat/recovery", "Shard recoveries", { params: [...CAT_PARAMS, "active_only", "detailed"] }],
  ["GET", "_cat/plugins", "Installed plugins", CAT],
  ["GET", "_cat/master", "The elected master node", CAT],
  ["GET", "_cat/nodeattrs", "Custom node attributes", CAT],
  ["GET", "_cat/pending_tasks", "Pending cluster tasks", CAT],
  ["GET", "_cat/tasks", "Running tasks", { params: [...CAT_PARAMS, "actions", "detailed"] }],
  ["GET", "_cat/fielddata", "Fielddata memory per node", CAT],
  ["GET", "_cat/repositories", "Snapshot repositories", CAT],
  ["GET", "_cat/snapshots/{repository}", "Snapshots of a repository", CAT],
  // cluster
  [
    "GET",
    "_cluster/health",
    "Cluster health",
    {
      params: [
        "level",
        "wait_for_status",
        "wait_for_nodes",
        "wait_for_active_shards",
        "wait_for_no_relocating_shards",
        "timeout",
        "local",
      ],
    },
  ],
  ["GET", "_cluster/health/{index}", "Health of indices", { params: ["level", "wait_for_status", "timeout"] }],
  ["GET", "_cluster/state", "Cluster state", { params: ["local", "flat_settings", "wait_for_metadata_version"] }],
  ["GET", "_cluster/state/{metric}", "Part of the cluster state (metadata, routing_table…)"],
  ["GET", "_cluster/stats", "Cluster statistics"],
  ["GET", "_cluster/settings", "Cluster settings", { params: ["include_defaults", "flat_settings"] }],
  [
    "PUT",
    "_cluster/settings",
    "Update cluster settings",
    {
      body: "required",
      schema: "clusterSettings",
      template: '{\n  "persistent": {\n    \n  }\n}',
      params: ["flat_settings"],
    },
  ],
  [
    "GET POST",
    "_cluster/allocation/explain",
    "Why a shard is (un)assigned",
    {
      body: "optional",
      schema: "allocationExplain",
      template: '{\n  "index": "",\n  "shard": 0,\n  "primary": true\n}',
      params: ["include_disk_info", "include_yes_decisions"],
    },
  ],
  [
    "POST",
    "_cluster/reroute",
    "Move, cancel or allocate shards",
    {
      body: "optional",
      schema: "reroute",
      template: '{\n  "commands": []\n}',
      params: ["dry_run", "explain", "retry_failed", "metric"],
    },
  ],
  ["GET", "_cluster/pending_tasks", "Pending cluster-level changes"],
  ["GET", "_remote/info", "Remote clusters"],
  // nodes
  ["GET", "_nodes", "Information about nodes"],
  ["GET", "_nodes/{node_id}", "Information about a node"],
  ["GET", "_nodes/stats", "Node statistics", { params: ["level", "fields", "groups", "types"] }],
  ["GET", "_nodes/{node_id}/stats", "Statistics of a node", { params: ["level", "fields"] }],
  ["GET", "_nodes/stats/{metric}", "One statistic of all nodes (jvm, os, fs…)"],
  [
    "GET",
    "_nodes/hot_threads",
    "Hot threads of each node",
    { params: ["threads", "interval", "snapshots", "type", "ignore_idle_threads"] },
  ],
  ["GET", "_nodes/{node_id}/hot_threads", "Hot threads of a node", { params: ["threads", "interval", "type"] }],
  ["GET", "_nodes/usage", "REST API usage per node"],
  ["POST", "_nodes/reload_secure_settings", "Reload keystore settings"],
  // templates
  ["GET", "_index_template", "Index templates"],
  ["GET HEAD", "_index_template/{name}", "An index template"],
  [
    "PUT POST",
    "_index_template/{name}",
    "Create or update an index template",
    {
      body: "required",
      schema: "indexTemplate",
      template:
        '{\n  "index_patterns": ["logs-*"],\n  "template": {\n    "settings": {},\n    "mappings": {\n      "properties": {}\n    }\n  }\n}',
      params: ["create", "master_timeout"],
    },
  ],
  ["DELETE", "_index_template/{name}", "Delete an index template"],
  ["POST", "_index_template/_simulate_index/{index}", "Settings an index would get from templates"],
  ["GET", "_component_template", "Component templates"],
  ["GET HEAD", "_component_template/{name}", "A component template"],
  [
    "PUT POST",
    "_component_template/{name}",
    "Create or update a component template",
    {
      body: "required",
      schema: "componentTemplate",
      template: '{\n  "template": {\n    "mappings": {\n      "properties": {}\n    }\n  }\n}',
    },
  ],
  ["DELETE", "_component_template/{name}", "Delete a component template"],
  ["GET", "_template", "Legacy index templates"],
  ["GET HEAD", "_template/{name}", "A legacy index template"],
  [
    "PUT",
    "_template/{name}",
    "Create a legacy index template",
    {
      body: "required",
      schema: "legacyTemplate",
      template: '{\n  "index_patterns": [""],\n  "settings": {},\n  "mappings": {}\n}',
    },
  ],
  ["DELETE", "_template/{name}", "Delete a legacy index template"],
  // ILM
  ["GET", "_ilm/policy", "Lifecycle policies"],
  ["GET", "_ilm/policy/{policy}", "A lifecycle policy"],
  [
    "PUT",
    "_ilm/policy/{policy}",
    "Create or update a lifecycle policy",
    {
      body: "required",
      schema: "ilmPolicy",
      template:
        '{\n  "policy": {\n    "phases": {\n      "hot": {\n        "actions": {\n          "rollover": {\n            "max_age": "30d"\n          }\n        }\n      },\n      "delete": {\n        "min_age": "90d",\n        "actions": {\n          "delete": {}\n        }\n      }\n    }\n  }\n}',
    },
  ],
  ["DELETE", "_ilm/policy/{policy}", "Delete a lifecycle policy"],
  ["GET", "{index}/_ilm/explain", "Lifecycle state of indices", { params: ["only_errors", "only_managed"] }],
  ["GET", "_ilm/status", "ILM status"],
  ["POST", "_ilm/start", "Start ILM"],
  ["POST", "_ilm/stop", "Stop ILM"],
  ["POST", "{index}/_ilm/retry", "Retry a failed lifecycle step"],
  ["POST", "{index}/_ilm/remove", "Remove the lifecycle policy of indices"],
  // ingest
  ["GET", "_ingest/pipeline", "Ingest pipelines"],
  ["GET", "_ingest/pipeline/{pipeline}", "An ingest pipeline"],
  [
    "PUT",
    "_ingest/pipeline/{pipeline}",
    "Create or update an ingest pipeline",
    {
      body: "required",
      schema: "pipeline",
      template:
        '{\n  "description": "",\n  "processors": [\n    {\n      "set": {\n        "field": "",\n        "value": ""\n      }\n    }\n  ]\n}',
    },
  ],
  ["DELETE", "_ingest/pipeline/{pipeline}", "Delete an ingest pipeline"],
  [
    "GET POST",
    "_ingest/pipeline/{pipeline}/_simulate",
    "Run a pipeline on sample documents",
    {
      body: "required",
      schema: "simulate",
      template: '{\n  "docs": [\n    { "_source": {} }\n  ]\n}',
      params: ["verbose"],
    },
  ],
  [
    "GET POST",
    "_ingest/pipeline/_simulate",
    "Run an inline pipeline on sample documents",
    {
      body: "required",
      schema: "simulate",
      template: '{\n  "pipeline": {\n    "processors": []\n  },\n  "docs": [\n    { "_source": {} }\n  ]\n}',
      params: ["verbose"],
    },
  ],
  // snapshots
  ["GET", "_snapshot", "Snapshot repositories"],
  ["GET", "_snapshot/{repository}", "A snapshot repository"],
  [
    "PUT POST",
    "_snapshot/{repository}",
    "Register a snapshot repository",
    {
      body: "required",
      schema: "repository",
      template: '{\n  "type": "fs",\n  "settings": {\n    "location": ""\n  }\n}',
      params: ["verify"],
    },
  ],
  ["DELETE", "_snapshot/{repository}", "Unregister a snapshot repository"],
  ["POST", "_snapshot/{repository}/_verify", "Verify a repository"],
  ["GET", "_snapshot/{repository}/_all", "Snapshots of a repository", { params: ["verbose", "sort", "size", "order"] }],
  ["GET", "_snapshot/{repository}/{snapshot}", "A snapshot"],
  [
    "PUT POST",
    "_snapshot/{repository}/{snapshot}",
    "Create a snapshot",
    {
      body: "optional",
      schema: "snapshot",
      template: '{\n  "indices": "*",\n  "include_global_state": false\n}',
      params: ["wait_for_completion"],
    },
  ],
  ["DELETE", "_snapshot/{repository}/{snapshot}", "Delete a snapshot"],
  [
    "POST",
    "_snapshot/{repository}/{snapshot}/_restore",
    "Restore a snapshot",
    {
      body: "optional",
      schema: "restore",
      template: '{\n  "indices": "*",\n  "rename_pattern": "(.+)",\n  "rename_replacement": "restored-$1"\n}',
      params: ["wait_for_completion"],
    },
  ],
  ["GET", "_snapshot/{repository}/{snapshot}/_status", "Shard-level status of a snapshot"],
  ["GET", "_snapshot/_status", "Running snapshots"],
  // tasks
  [
    "GET",
    "_tasks",
    "Running tasks",
    { params: ["actions", "detailed", "nodes", "parent_task_id", "group_by", "wait_for_completion", "timeout"] },
  ],
  ["GET", "_tasks/{task_id}", "A task", { params: ["wait_for_completion", "timeout"] }],
  ["POST", "_tasks/{task_id}/_cancel", "Cancel a task"],
  ["POST", "_tasks/_cancel", "Cancel tasks", { params: ["actions", "nodes", "parent_task_id"] }],
  // security
  ["GET", "_security/_authenticate", "The authenticated user"],
  ["GET", "_security/user", "Users"],
  ["GET", "_security/user/{username}", "A user"],
  [
    "PUT POST",
    "_security/user/{username}",
    "Create or update a user",
    { body: "required", schema: "user", template: '{\n  "password": "",\n  "roles": [],\n  "full_name": ""\n}' },
  ],
  ["DELETE", "_security/user/{username}", "Delete a user"],
  [
    "POST",
    "_security/user/{username}/_password",
    "Change a user's password",
    { body: "required", schema: "password", template: '{\n  "password": ""\n}' },
  ],
  [
    "GET POST",
    "_security/user/_has_privileges",
    "Check the user's privileges",
    {
      body: "required",
      schema: "hasPrivileges",
      template: '{\n  "cluster": [],\n  "index": [\n    { "names": [""], "privileges": ["read"] }\n  ]\n}',
    },
  ],
  ["GET", "_security/role", "Roles"],
  ["GET", "_security/role/{name}", "A role"],
  [
    "PUT POST",
    "_security/role/{name}",
    "Create or update a role",
    {
      body: "required",
      schema: "role",
      template:
        '{\n  "cluster": [],\n  "indices": [\n    {\n      "names": [""],\n      "privileges": ["read"]\n    }\n  ]\n}',
    },
  ],
  ["DELETE", "_security/role/{name}", "Delete a role"],
  ["GET", "_security/api_key", "API keys", { params: ["id", "name", "username", "owner"] }],
  [
    "PUT POST",
    "_security/api_key",
    "Create an API key",
    { body: "required", schema: "apiKey", template: '{\n  "name": "",\n  "expiration": "30d"\n}' },
  ],
  [
    "DELETE",
    "_security/api_key",
    "Invalidate API keys",
    { body: "required", schema: "invalidateApiKey", template: '{\n  "ids": [""]\n}' },
  ],
  // SQL, ES|QL
  [
    "GET POST",
    "_sql",
    "Run an SQL query (?format=txt for a table)",
    {
      body: "required",
      schema: "sql",
      template: '{\n  "query": "SELECT * FROM \\"my-index\\" LIMIT 10"\n}',
      params: ["format", "delimiter"],
    },
  ],
  [
    "GET POST",
    "_sql/translate",
    "Translate SQL to Query DSL",
    { body: "required", schema: "sql", template: '{\n  "query": ""\n}' },
  ],
  [
    "POST",
    "_sql/close",
    "Close an SQL cursor",
    { body: "required", schema: "sqlClose", template: '{\n  "cursor": ""\n}' },
  ],
  [
    "POST",
    "_query",
    "Run an ES|QL query",
    {
      body: "required",
      schema: "esql",
      template: '{\n  "query": "FROM my-index | LIMIT 10"\n}',
      params: ["format", "delimiter", "drop_null_columns"],
    },
  ],
  [
    "POST",
    "_query/async",
    "Start an async ES|QL query",
    {
      body: "required",
      schema: "esql",
      template: '{\n  "query": "FROM my-index | LIMIT 10"\n}',
      params: ["format", "wait_for_completion_timeout", "keep_on_completion", "keep_alive"],
    },
  ],
  // data streams
  ["GET", "_data_stream", "Data streams"],
  ["GET", "_data_stream/{data_stream}", "A data stream"],
  ["PUT", "_data_stream/{data_stream}", "Create a data stream (needs a matching template)"],
  ["DELETE", "_data_stream/{data_stream}", "Delete a data stream and its backing indices"],
  ["GET", "_data_stream/_stats", "Data stream statistics"],
  ["GET", "_data_stream/{data_stream}/_stats", "Statistics of a data stream"],
  [
    "POST",
    "_data_stream/_modify",
    "Add / remove backing indices",
    { body: "required", schema: "modifyDataStream", template: '{\n  "actions": []\n}' },
  ],
  ["POST", "_data_stream/_migrate/{alias}", "Convert an alias to a data stream"],
  // misc
  ["GET", "_license", "License information"],
  ["GET", "_xpack", "Installed features"],
  ["GET", "_scripts/{id}", "A stored script"],
  [
    "PUT POST",
    "_scripts/{id}",
    "Store a script",
    {
      body: "required",
      schema: "storedScript",
      template: '{\n  "script": {\n    "lang": "painless",\n    "source": ""\n  }\n}',
    },
  ],
  ["DELETE", "_scripts/{id}", "Delete a stored script"],
];

export const ES_APIS: readonly EsApi[] = DEFS.map(([methods, path, summary, extra]) => ({
  path,
  methods: methods.split(" ") as EsMethod[],
  summary,
  body: extra?.body ?? "none",
  ...extra,
}));

/** Segments of a path template / request path (no leading `/`, no query string). */
export const pathSegments = (path: string) => {
  const p = path
    .replace(/[?#].*$/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return p ? p.split("/") : [];
};

const isParam = (segment: string) => segment.startsWith("{") && segment.endsWith("}");

/** Parameters naming indices / aliases / data streams (completed with index names). */
export const INDEX_PARAMS_NAMES: ReadonlySet<string> = new Set(["{index}", "{alias}", "{target}", "{data_stream}"]);

/** A request segment `actual` fits template segment `tpl`. */
export function segmentFits(tpl: string, actual: string): boolean {
  if (!isParam(tpl)) return tpl === actual;
  if (!actual) return false;
  // Index-like parameters take `_all` but no other `_api` word.
  // Index-like parameters take `_all` but no `_api` word; ids, node ids (`_local`)… take anything.
  if (actual.startsWith("_")) return INDEX_PARAMS_NAMES.has(tpl) ? actual === "_all" : true;
  return true;
}

/** The endpoint a request goes to (most literal template first), null when unknown. */
export function matchApi(method: string, path: string): EsApi | null {
  const segs = pathSegments(path);
  const m = method.toUpperCase();
  let best: EsApi | null = null;
  let bestScore = -1;
  for (const api of ES_APIS) {
    if (!api.methods.includes(m as EsMethod)) continue;
    const tpl = pathSegments(api.path);
    if (tpl.length !== segs.length || !tpl.every((t, i) => segmentFits(t, segs[i]!))) continue;
    const score = tpl.filter((t) => !isParam(t)).length;
    if (score > bestScore) {
      best = api;
      bestScore = score;
    }
  }
  return best;
}

/** Literal path words that are not `_api` names (`indices` of `_cat/indices`): highlighted as API. */
export const API_PATH_WORDS: ReadonlySet<string> = new Set(
  ES_APIS.flatMap((a) => pathSegments(a.path)).filter((s) => !isParam(s) && !s.startsWith("_")),
);

/** Template segments that can follow the request segments `before` (with the APIs they lead to). */
export function nextSegments(method: string | null, before: readonly string[]): Map<string, EsApi[]> {
  const out = new Map<string, EsApi[]>();
  for (const api of ES_APIS) {
    if (method && !api.methods.includes(method.toUpperCase() as EsMethod)) continue;
    const tpl = pathSegments(api.path);
    if (tpl.length <= before.length || !before.every((s, i) => segmentFits(tpl[i]!, s))) continue;
    const next = tpl[before.length]!;
    const list = out.get(next);
    if (list) list.push(api);
    else out.set(next, [api]);
  }
  return out;
}

// ---- body schemas --------------------------------------------------------------------

/** Which fields complete a field-valued place: any, aggregatable ones first, nested paths. */
export type FieldFilter = "any" | "agg" | "nested";

export type DslSchema =
  /** An object of known keys, also keyed by field names when `fieldKeys` (geo_distance). */
  | { kind: "object"; keys: Readonly<Record<string, DslRef>>; fieldKeys?: DslRef }
  /** An object keyed by field names (`match`, `range`, `highlight.fields`). */
  | { kind: "fields"; value: DslRef; filter?: FieldFilter }
  /** An object keyed by names the user picks (`aggs`, `runtime_mappings`). */
  | { kind: "named"; value: DslRef }
  | { kind: "array"; items: DslRef }
  | { kind: "oneOf"; options: readonly DslRef[] }
  | {
      kind: "value";
      type: "string" | "number" | "boolean" | "any";
      values?: readonly string[];
      field?: FieldFilter;
    };

/** A schema, or a function returning one (recursive grammar). */
export type DslRef = DslSchema | (() => DslSchema);

export const resolveRef = (ref: DslRef): DslSchema => (typeof ref === "function" ? ref() : ref);

const str: DslSchema = { kind: "value", type: "string" };
const num: DslSchema = { kind: "value", type: "number" };
const bool: DslSchema = { kind: "value", type: "boolean" };
const any: DslSchema = { kind: "value", type: "any" };
const field: DslSchema = { kind: "value", type: "string", field: "any" };
const aggField: DslSchema = { kind: "value", type: "string", field: "agg" };
const nestedPath: DslSchema = { kind: "value", type: "string", field: "nested" };
const en = (...values: string[]): DslSchema => ({ kind: "value", type: "string", values });
const obj = (keys: Record<string, DslRef>, fieldKeys?: DslRef): DslSchema => ({ kind: "object", keys, fieldKeys });
const arr = (items: DslRef): DslSchema => ({ kind: "array", items });
const one = (...options: DslRef[]): DslSchema => ({ kind: "oneOf", options });
const fieldsOf = (value: DslRef, filter?: FieldFilter): DslSchema => ({ kind: "fields", value, filter });
const named = (value: DslRef): DslSchema => ({ kind: "named", value });
const anyObj: DslSchema = { kind: "named", value: any };

const query = (): DslSchema => QUERY;
const queries = one(arr(query), query);
const fieldList = one(arr(field), field);
const script = one(str, obj({ source: str, id: str, lang: en("painless", "expression", "mustache"), params: anyObj }));
const boost = num;
const fuzziness = en("AUTO", "0", "1", "2");
const rewrite = en("constant_score", "constant_score_boolean", "scoring_boolean", "top_terms_N", "top_terms_boost_N");
const operator = en("or", "and");
const zeroTerms = en("none", "all");
const sortOrder = en("asc", "desc");
const intervals = en("minute", "hour", "day", "week", "month", "quarter", "year");

const matchParams = obj({
  query: any,
  operator,
  minimum_should_match: any,
  fuzziness,
  prefix_length: num,
  max_expansions: num,
  fuzzy_transpositions: bool,
  lenient: bool,
  analyzer: str,
  zero_terms_query: zeroTerms,
  auto_generate_synonyms_phrase_query: bool,
  boost,
});

const innerHits = obj({
  name: str,
  size: num,
  from: num,
  sort: () => SORT,
  _source: () => SOURCE,
  highlight: () => HIGHLIGHT,
});

const geoPoint = one(obj({ lat: num, lon: num }), str, arr(num));

const QUERY: DslSchema = obj({
  match_all: obj({ boost }),
  match_none: obj({}),
  match: fieldsOf(one(str, matchParams)),
  match_phrase: fieldsOf(one(str, obj({ query: any, slop: num, analyzer: str, zero_terms_query: zeroTerms, boost }))),
  match_phrase_prefix: fieldsOf(
    one(str, obj({ query: any, slop: num, max_expansions: num, analyzer: str, zero_terms_query: zeroTerms, boost })),
  ),
  match_bool_prefix: fieldsOf(
    one(str, obj({ query: any, operator, minimum_should_match: any, fuzziness, analyzer: str, boost })),
  ),
  multi_match: obj({
    query: any,
    fields: arr(field),
    type: en("best_fields", "most_fields", "cross_fields", "phrase", "phrase_prefix", "bool_prefix"),
    operator,
    minimum_should_match: any,
    tie_breaker: num,
    fuzziness,
    prefix_length: num,
    max_expansions: num,
    lenient: bool,
    analyzer: str,
    slop: num,
    zero_terms_query: zeroTerms,
    boost,
  }),
  combined_fields: obj({
    query: any,
    fields: arr(field),
    operator,
    minimum_should_match: any,
    zero_terms_query: zeroTerms,
    boost,
  }),
  query_string: obj({
    query: str,
    default_field: field,
    fields: arr(field),
    default_operator: en("OR", "AND"),
    analyzer: str,
    analyze_wildcard: bool,
    allow_leading_wildcard: bool,
    lenient: bool,
    fuzziness,
    minimum_should_match: any,
    phrase_slop: num,
    time_zone: str,
    quote_field_suffix: str,
    boost,
  }),
  simple_query_string: obj({
    query: str,
    fields: arr(field),
    default_operator: en("OR", "AND"),
    flags: str,
    analyzer: str,
    analyze_wildcard: bool,
    lenient: bool,
    minimum_should_match: any,
    quote_field_suffix: str,
    boost,
  }),
  term: fieldsOf(one(any, obj({ value: any, case_insensitive: bool, boost }))),
  terms: obj({ boost }, arr(any)),
  terms_set: fieldsOf(
    obj({
      terms: arr(any),
      minimum_should_match_field: field,
      minimum_should_match_script: script,
      minimum_should_match: any,
      boost,
    }),
  ),
  range: fieldsOf(
    obj({
      gt: any,
      gte: any,
      lt: any,
      lte: any,
      format: str,
      time_zone: str,
      relation: en("INTERSECTS", "CONTAINS", "WITHIN"),
      boost,
    }),
  ),
  exists: obj({ field, boost }),
  prefix: fieldsOf(one(str, obj({ value: str, case_insensitive: bool, rewrite, boost }))),
  wildcard: fieldsOf(one(str, obj({ value: str, wildcard: str, case_insensitive: bool, rewrite, boost }))),
  regexp: fieldsOf(
    one(str, obj({ value: str, flags: str, case_insensitive: bool, max_determinized_states: num, rewrite, boost })),
  ),
  fuzzy: fieldsOf(
    one(
      str,
      obj({ value: any, fuzziness, max_expansions: num, prefix_length: num, transpositions: bool, rewrite, boost }),
    ),
  ),
  ids: obj({ values: arr(str), boost }),
  bool: obj({ must: queries, should: queries, filter: queries, must_not: queries, minimum_should_match: any, boost }),
  constant_score: obj({ filter: query, boost }),
  dis_max: obj({ queries: arr(query), tie_breaker: num, boost }),
  boosting: obj({ positive: query, negative: query, negative_boost: num }),
  function_score: obj({
    query,
    functions: arr(() => SCORE_FUNCTION),
    boost_mode: en("multiply", "replace", "sum", "avg", "max", "min"),
    score_mode: en("multiply", "sum", "avg", "first", "max", "min"),
    max_boost: num,
    min_score: num,
    boost,
    random_score: obj({ seed: any, field }),
    field_value_factor: obj({
      field,
      factor: num,
      modifier: en("none", "log", "log1p", "log2p", "ln", "ln1p", "ln2p", "square", "sqrt", "reciprocal"),
      missing: num,
    }),
    script_score: obj({ script }),
    weight: num,
  }),
  script_score: obj({ query, script, min_score: num, boost }),
  script: obj({ script, boost }),
  nested: obj({
    path: nestedPath,
    query,
    score_mode: en("avg", "max", "min", "none", "sum"),
    ignore_unmapped: bool,
    inner_hits: innerHits,
  }),
  has_child: obj({
    type: str,
    query,
    score_mode: en("none", "avg", "sum", "max", "min"),
    min_children: num,
    max_children: num,
    ignore_unmapped: bool,
    inner_hits: innerHits,
  }),
  has_parent: obj({ parent_type: str, query, score: bool, ignore_unmapped: bool, inner_hits: innerHits }),
  parent_id: obj({ type: str, id: str, ignore_unmapped: bool }),
  geo_distance: obj(
    {
      distance: str,
      distance_type: en("arc", "plane"),
      validation_method: en("STRICT", "IGNORE_MALFORMED", "COERCE"),
      boost,
    },
    geoPoint,
  ),
  geo_bounding_box: obj(
    { validation_method: en("STRICT", "IGNORE_MALFORMED", "COERCE"), boost },
    obj({ top_left: geoPoint, bottom_right: geoPoint, wkt: str }),
  ),
  geo_shape: fieldsOf(
    obj({
      shape: obj({
        type: en("point", "envelope", "polygon", "linestring", "multipolygon", "circle"),
        coordinates: arr(any),
      }),
      relation: en("intersects", "disjoint", "within", "contains"),
      indexed_shape: obj({ index: str, id: str, path: str }),
    }),
  ),
  geo_grid: fieldsOf(obj({ geohash: str, geotile: str, geohex: str })),
  knn: obj({ field, query_vector: arr(num), k: num, num_candidates: num, filter: queries, similarity: num, boost }),
  more_like_this: obj({
    fields: arr(field),
    like: any,
    unlike: any,
    min_term_freq: num,
    max_query_terms: num,
    min_doc_freq: num,
    minimum_should_match: any,
    boost,
  }),
  distance_feature: obj({ field, origin: any, pivot: str, boost }),
  rank_feature: obj({
    field,
    boost,
    saturation: obj({ pivot: num }),
    log: obj({ scaling_factor: num }),
    sigmoid: obj({ pivot: num, exponent: num }),
  }),
  pinned: obj({ ids: arr(str), docs: arr(obj({ _index: str, _id: str })), organic: query }),
  intervals: fieldsOf(
    obj({
      match: obj({ query: str, max_gaps: num, ordered: bool }),
      any_of: anyObj,
      all_of: anyObj,
      prefix: anyObj,
      wildcard: anyObj,
      fuzzy: anyObj,
    }),
  ),
  semantic: obj({ field, query: str }),
  sparse_vector: obj({ field, query_vector: anyObj, inference_id: str, query: str }),
});

const SCORE_FUNCTION: DslSchema = obj({
  filter: query,
  weight: num,
  script_score: obj({ script }),
  random_score: obj({ seed: any, field }),
  field_value_factor: obj({ field, factor: num, modifier: str, missing: num }),
  gauss: fieldsOf(obj({ origin: any, scale: any, offset: any, decay: num })),
  linear: fieldsOf(obj({ origin: any, scale: any, offset: any, decay: num })),
  exp: fieldsOf(obj({ origin: any, scale: any, offset: any, decay: num })),
});

const SORT_PARAMS = obj({
  order: sortOrder,
  mode: en("min", "max", "sum", "avg", "median"),
  missing: any,
  unmapped_type: str,
  format: str,
  numeric_type: en("double", "long", "date", "date_nanos"),
  nested: obj({ path: nestedPath, filter: query }),
});
const SORT: DslSchema = one(
  arr(one(aggField, fieldsOf(one(sortOrder, SORT_PARAMS), "agg"))),
  aggField,
  fieldsOf(one(sortOrder, SORT_PARAMS), "agg"),
);
const SOURCE: DslSchema = one(bool, arr(field), field, obj({ includes: arr(field), excludes: arr(field) }));
const HIGHLIGHT_PARAMS = {
  type: en("unified", "plain", "fvh"),
  pre_tags: arr(str),
  post_tags: arr(str),
  fragment_size: num,
  number_of_fragments: num,
  no_match_size: num,
  order: en("score", "none"),
  require_field_match: bool,
  highlight_query: query,
  boundary_scanner: en("chars", "sentence", "word"),
  encoder: en("default", "html"),
  fragmenter: en("simple", "span"),
};
const HIGHLIGHT: DslSchema = obj({
  fields: one(fieldsOf(obj(HIGHLIGHT_PARAMS)), arr(fieldsOf(obj(HIGHLIGHT_PARAMS)))),
  ...HIGHLIGHT_PARAMS,
});
const RUNTIME_FIELD = obj({
  type: en("keyword", "long", "double", "date", "boolean", "ip", "geo_point", "composite", "lookup"),
  script,
  format: str,
  fields: anyObj,
});

// Aggregations

const aggs = (): DslSchema => AGGS;
const bucketsPath = one(str, anyObj);
const gapPolicy = en("skip", "insert_zeros", "keep_values");
const metric = (extra: Record<string, DslRef> = {}) =>
  obj({ field: aggField, missing: any, script, format: str, ...extra });
const rangesOf = arr(obj({ key: str, from: any, to: any }));
const bucketOrder = one(
  obj({ _count: sortOrder, _key: sortOrder }, sortOrder),
  arr(obj({ _count: sortOrder, _key: sortOrder }, sortOrder)),
);
const bounds = obj({ min: any, max: any });

const TERMS_AGG = obj({
  field: aggField,
  size: num,
  shard_size: num,
  min_doc_count: num,
  shard_min_doc_count: num,
  order: bucketOrder,
  missing: any,
  include: any,
  exclude: any,
  execution_hint: en("map", "global_ordinals"),
  collect_mode: en("depth_first", "breadth_first"),
  show_term_doc_count_error: bool,
  value_type: str,
  script,
});
const HISTOGRAM_AGG = obj({
  field: aggField,
  interval: num,
  min_doc_count: num,
  offset: num,
  extended_bounds: bounds,
  hard_bounds: bounds,
  order: bucketOrder,
  keyed: bool,
  missing: any,
  script,
});
const DATE_HISTOGRAM_AGG = obj({
  field: aggField,
  calendar_interval: intervals,
  fixed_interval: str,
  format: str,
  time_zone: str,
  offset: str,
  min_doc_count: num,
  extended_bounds: bounds,
  hard_bounds: bounds,
  order: bucketOrder,
  keyed: bool,
  missing: any,
  script,
});

const AGG_TYPES: Record<string, DslRef> = {
  terms: TERMS_AGG,
  multi_terms: obj({
    terms: arr(obj({ field: aggField, missing: any })),
    size: num,
    order: bucketOrder,
    min_doc_count: num,
  }),
  rare_terms: obj({ field: aggField, max_doc_count: num, precision: num, include: any, exclude: any, missing: any }),
  significant_terms: obj({
    field: aggField,
    size: num,
    min_doc_count: num,
    background_filter: query,
    include: any,
    exclude: any,
  }),
  significant_text: obj({
    field,
    size: num,
    min_doc_count: num,
    filter_duplicate_text: bool,
    background_filter: query,
  }),
  date_histogram: DATE_HISTOGRAM_AGG,
  auto_date_histogram: obj({
    field: aggField,
    buckets: num,
    format: str,
    time_zone: str,
    minimum_interval: intervals,
    missing: any,
  }),
  histogram: HISTOGRAM_AGG,
  variable_width_histogram: obj({ field: aggField, buckets: num, shard_size: num }),
  range: obj({ field: aggField, ranges: rangesOf, keyed: bool, script }),
  date_range: obj({ field: aggField, ranges: rangesOf, format: str, time_zone: str, keyed: bool, missing: any }),
  ip_range: obj({ field: aggField, ranges: arr(obj({ key: str, from: str, to: str, mask: str })), keyed: bool }),
  filter: query,
  filters: obj({ filters: one(named(query), arr(query)), other_bucket: bool, other_bucket_key: str, keyed: bool }),
  adjacency_matrix: obj({ filters: named(query), separator: str }),
  missing: obj({ field: aggField }),
  global: obj({}),
  nested: obj({ path: nestedPath }),
  reverse_nested: obj({ path: nestedPath }),
  children: obj({ type: str }),
  parent: obj({ type: str }),
  sampler: obj({ shard_size: num }),
  diversified_sampler: obj({ field: aggField, shard_size: num, max_docs_per_value: num }),
  random_sampler: obj({ probability: num, seed: num }),
  composite: obj({
    sources: arr(
      named(
        obj({
          terms: TERMS_AGG,
          histogram: HISTOGRAM_AGG,
          date_histogram: DATE_HISTOGRAM_AGG,
          geotile_grid: obj({ field: aggField, precision: num }),
        }),
      ),
    ),
    size: num,
    after: anyObj,
  }),
  geohash_grid: obj({ field: aggField, precision: any, size: num, bounds: anyObj }),
  geotile_grid: obj({ field: aggField, precision: num, size: num, bounds: anyObj }),
  geo_distance: obj({
    field: aggField,
    origin: geoPoint,
    unit: en("m", "km", "mi", "yd", "ft", "in", "cm", "mm", "nmi"),
    ranges: rangesOf,
    keyed: bool,
  }),
  // metrics
  avg: metric(),
  sum: metric(),
  min: metric(),
  max: metric(),
  value_count: metric(),
  cardinality: metric({ precision_threshold: num }),
  stats: metric(),
  extended_stats: metric({ sigma: num }),
  percentiles: metric({
    percents: arr(num),
    keyed: bool,
    tdigest: obj({ compression: num }),
    hdr: obj({ number_of_significant_value_digits: num }),
  }),
  percentile_ranks: metric({ values: arr(num), keyed: bool }),
  median_absolute_deviation: metric({ compression: num }),
  weighted_avg: obj({
    value: obj({ field: aggField, missing: any }),
    weight: obj({ field: aggField, missing: any }),
    format: str,
  }),
  top_hits: obj({
    size: num,
    from: num,
    sort: () => SORT,
    _source: () => SOURCE,
    highlight: () => HIGHLIGHT,
    fields: arr(field),
    docvalue_fields: arr(field),
  }),
  top_metrics: obj({
    metrics: one(obj({ field: aggField }), arr(obj({ field: aggField }))),
    sort: () => SORT,
    size: num,
  }),
  string_stats: metric({ show_distribution: bool }),
  geo_bounds: obj({ field: aggField, wrap_longitude: bool }),
  geo_centroid: obj({ field: aggField }),
  scripted_metric: obj({
    init_script: script,
    map_script: script,
    combine_script: script,
    reduce_script: script,
    params: anyObj,
  }),
  // pipeline
  avg_bucket: obj({ buckets_path: bucketsPath, gap_policy: gapPolicy, format: str }),
  sum_bucket: obj({ buckets_path: bucketsPath, gap_policy: gapPolicy, format: str }),
  min_bucket: obj({ buckets_path: bucketsPath, gap_policy: gapPolicy, format: str }),
  max_bucket: obj({ buckets_path: bucketsPath, gap_policy: gapPolicy, format: str }),
  stats_bucket: obj({ buckets_path: bucketsPath, gap_policy: gapPolicy, format: str }),
  percentiles_bucket: obj({ buckets_path: bucketsPath, percents: arr(num), gap_policy: gapPolicy }),
  cumulative_sum: obj({ buckets_path: bucketsPath, format: str }),
  derivative: obj({ buckets_path: bucketsPath, gap_policy: gapPolicy, unit: str, format: str }),
  moving_fn: obj({ buckets_path: bucketsPath, window: num, script: str, shift: num, gap_policy: gapPolicy }),
  serial_diff: obj({ buckets_path: bucketsPath, lag: num, gap_policy: gapPolicy }),
  bucket_script: obj({ buckets_path: bucketsPath, script, gap_policy: gapPolicy, format: str }),
  bucket_selector: obj({ buckets_path: bucketsPath, script, gap_policy: gapPolicy }),
  bucket_sort: obj({ sort: () => SORT, from: num, size: num, gap_policy: gapPolicy }),
};

/** Aggregation types (bucket, metric, pipeline). */
export const AGG_TYPE_NAMES: readonly string[] = Object.keys(AGG_TYPES);

const AGG_BODY: DslSchema = obj({ ...AGG_TYPES, aggs, aggregations: aggs, meta: anyObj });
const AGGS: DslSchema = named(AGG_BODY);

/** Top-level keys of a search request body. */
const SEARCH_BODY: DslSchema = obj({
  query,
  size: num,
  from: num,
  sort: SORT,
  _source: SOURCE,
  aggs,
  aggregations: aggs,
  track_total_hits: one(bool, num),
  highlight: HIGHLIGHT,
  search_after: arr(any),
  pit: obj({ id: str, keep_alive: str }),
  fields: arr(one(field, obj({ field, format: str, include_unmapped: bool }))),
  docvalue_fields: arr(one(field, obj({ field, format: str }))),
  stored_fields: fieldList,
  script_fields: named(obj({ script, ignore_failure: bool })),
  runtime_mappings: named(RUNTIME_FIELD),
  timeout: str,
  post_filter: query,
  collapse: obj({ field: aggField, inner_hits: one(innerHits, arr(innerHits)), max_concurrent_group_searches: num }),
  knn: one(
    obj({ field, query_vector: arr(num), k: num, num_candidates: num, filter: queries, similarity: num, boost }),
    arr(obj({ field, query_vector: arr(num), k: num, num_candidates: num, filter: queries, boost })),
  ),
  rescore: one(
    obj({
      window_size: num,
      query: obj({
        rescore_query: query,
        query_weight: num,
        rescore_query_weight: num,
        score_mode: en("total", "multiply", "avg", "max", "min"),
      }),
    }),
    arr(anyObj),
  ),
  min_score: num,
  terminate_after: num,
  explain: bool,
  version: bool,
  seq_no_primary_term: bool,
  track_scores: bool,
  profile: bool,
  indices_boost: arr(anyObj),
  stats: arr(str),
  suggest: named(
    obj({
      text: str,
      prefix: str,
      term: obj({ field, size: num, suggest_mode: en("missing", "popular", "always") }),
      phrase: obj({ field, size: num }),
      completion: obj({ field, size: num, skip_duplicates: bool, fuzzy: anyObj }),
    }),
  ),
  retriever: anyObj,
});

const MAPPING_FIELD: DslSchema = obj({
  type: en(
    "text",
    "keyword",
    "long",
    "integer",
    "short",
    "byte",
    "double",
    "float",
    "half_float",
    "scaled_float",
    "unsigned_long",
    "date",
    "date_nanos",
    "boolean",
    "ip",
    "object",
    "nested",
    "flattened",
    "geo_point",
    "geo_shape",
    "binary",
    "match_only_text",
    "wildcard",
    "constant_keyword",
    "search_as_you_type",
    "dense_vector",
    "sparse_vector",
    "semantic_text",
    "alias",
    "completion",
    "version",
  ),
  analyzer: str,
  search_analyzer: str,
  normalizer: str,
  index: bool,
  doc_values: bool,
  store: bool,
  format: str,
  ignore_above: num,
  ignore_malformed: bool,
  null_value: any,
  coerce: bool,
  copy_to: fieldList,
  enabled: bool,
  dynamic: en("true", "false", "strict", "runtime"),
  fields: named(() => MAPPING_FIELD),
  properties: named(() => MAPPING_FIELD),
  scaling_factor: num,
  dims: num,
  similarity: str,
  path: field,
  meta: anyObj,
});

const MAPPINGS: DslSchema = obj({
  properties: named(MAPPING_FIELD),
  dynamic: en("true", "false", "strict", "runtime"),
  dynamic_templates: arr(
    named(obj({ match: str, unmatch: str, path_match: str, match_mapping_type: str, mapping: MAPPING_FIELD })),
  ),
  runtime: named(RUNTIME_FIELD),
  _source: obj({ enabled: bool, includes: arr(str), excludes: arr(str), mode: en("stored", "synthetic", "disabled") }),
  _routing: obj({ required: bool }),
  _meta: anyObj,
  date_detection: bool,
  numeric_detection: bool,
});

const INDEX_SETTING_KEYS: Record<string, DslRef> = {
  number_of_shards: num,
  number_of_replicas: num,
  refresh_interval: str,
  max_result_window: num,
  "index.number_of_shards": num,
  "index.number_of_replicas": num,
  "index.refresh_interval": str,
  "index.max_result_window": num,
  "index.lifecycle.name": str,
  "index.lifecycle.rollover_alias": str,
  "index.blocks.write": bool,
  "index.blocks.read_only": bool,
  "index.blocks.read_only_allow_delete": bool,
  "index.routing.allocation.require._name": str,
  "index.mapping.total_fields.limit": num,
  "index.codec": en("default", "best_compression"),
  auto_expand_replicas: str,
  codec: en("default", "best_compression"),
  hidden: bool,
  lifecycle: obj({ name: str, rollover_alias: str }),
  blocks: obj({ write: bool, read: bool, read_only: bool, read_only_allow_delete: bool, metadata: bool }),
  routing: anyObj,
  mapping: anyObj,
  analysis: obj({
    analyzer: named(obj({ type: str, tokenizer: str, filter: arr(str), char_filter: arr(str) })),
    tokenizer: anyObj,
    filter: anyObj,
    char_filter: anyObj,
    normalizer: anyObj,
  }),
  sort: obj({ field: fieldList, order: one(sortOrder, arr(sortOrder)) }),
};
const SETTINGS: DslSchema = obj({ ...INDEX_SETTING_KEYS, index: obj(INDEX_SETTING_KEYS) });
const ALIAS_BODY: DslSchema = obj({
  filter: query,
  routing: str,
  index_routing: str,
  search_routing: str,
  is_write_index: bool,
  is_hidden: bool,
});
const ALIAS_ACTION = obj({
  index: str,
  indices: arr(str),
  alias: str,
  aliases: arr(str),
  filter: query,
  routing: str,
  is_write_index: bool,
  is_hidden: bool,
  must_exist: bool,
});
const TEMPLATE_PART = obj({
  settings: SETTINGS,
  mappings: MAPPINGS,
  aliases: named(ALIAS_BODY),
  lifecycle: obj({ data_retention: str }),
});
const ILM_ACTIONS = obj({
  rollover: obj({
    max_age: str,
    max_docs: num,
    max_size: str,
    max_primary_shard_size: str,
    max_primary_shard_docs: num,
    min_age: str,
  }),
  set_priority: obj({ priority: num }),
  shrink: obj({ number_of_shards: num, max_primary_shard_size: str }),
  forcemerge: obj({ max_num_segments: num }),
  readonly: obj({}),
  allocate: obj({ number_of_replicas: num, include: anyObj, exclude: anyObj, require: anyObj }),
  migrate: obj({ enabled: bool }),
  searchable_snapshot: obj({ snapshot_repository: str }),
  freeze: obj({}),
  downsample: obj({ fixed_interval: str }),
  wait_for_snapshot: obj({ policy: str }),
  delete: obj({ delete_searchable_snapshot: bool }),
});
const ILM_PHASE = obj({ min_age: str, actions: ILM_ACTIONS });
const PROCESSOR_COMMON = { if: str, tag: str, description: str, ignore_failure: bool, on_failure: arr(anyObj) };
const PROCESSOR: DslSchema = obj({
  set: obj({ field, value: any, copy_from: field, override: bool, ...PROCESSOR_COMMON }),
  remove: obj({ field: fieldList, ignore_missing: bool, ...PROCESSOR_COMMON }),
  rename: obj({ field, target_field: str, ignore_missing: bool, ...PROCESSOR_COMMON }),
  convert: obj({
    field,
    type: en("integer", "long", "float", "double", "string", "boolean", "ip", "auto"),
    target_field: str,
    ...PROCESSOR_COMMON,
  }),
  date: obj({ field, formats: arr(str), target_field: str, timezone: str, ...PROCESSOR_COMMON }),
  grok: obj({ field, patterns: arr(str), pattern_definitions: anyObj, ...PROCESSOR_COMMON }),
  dissect: obj({ field, pattern: str, append_separator: str, ...PROCESSOR_COMMON }),
  json: obj({ field, target_field: str, add_to_root: bool, ...PROCESSOR_COMMON }),
  lowercase: obj({ field, target_field: str, ...PROCESSOR_COMMON }),
  uppercase: obj({ field, target_field: str, ...PROCESSOR_COMMON }),
  trim: obj({ field, target_field: str, ...PROCESSOR_COMMON }),
  split: obj({ field, separator: str, target_field: str, ...PROCESSOR_COMMON }),
  gsub: obj({ field, pattern: str, replacement: str, ...PROCESSOR_COMMON }),
  script: obj({ source: str, lang: str, params: anyObj, ...PROCESSOR_COMMON }),
  pipeline: obj({ name: str, ...PROCESSOR_COMMON }),
  geoip: obj({ field, target_field: str, ...PROCESSOR_COMMON }),
  user_agent: obj({ field, target_field: str, ...PROCESSOR_COMMON }),
  append: obj({ field, value: any, allow_duplicates: bool, ...PROCESSOR_COMMON }),
  drop: obj(PROCESSOR_COMMON),
  fail: obj({ message: str, ...PROCESSOR_COMMON }),
  foreach: obj({ field, processor: () => PROCESSOR, ...PROCESSOR_COMMON }),
  kv: obj({ field, field_split: str, value_split: str, target_field: str, ...PROCESSOR_COMMON }),
  csv: obj({ field, target_fields: arr(str), separator: str, ...PROCESSOR_COMMON }),
  enrich: obj({ policy_name: str, field, target_field: str, ...PROCESSOR_COMMON }),
  inference: obj({ model_id: str, target_field: str, field_map: anyObj, ...PROCESSOR_COMMON }),
});
const PIPELINE: DslSchema = obj({
  description: str,
  processors: arr(PROCESSOR),
  on_failure: arr(PROCESSOR),
  version: num,
  _meta: anyObj,
});
const INDEX_PRIVILEGES = obj({
  names: arr(str),
  privileges: arr(
    en(
      "all",
      "read",
      "write",
      "index",
      "create",
      "create_doc",
      "delete",
      "manage",
      "monitor",
      "view_index_metadata",
      "read_cross_cluster",
    ),
  ),
  field_security: obj({ grant: arr(str), except: arr(str) }),
  query: any,
  allow_restricted_indices: bool,
});

/** Request body schemas, by `EsApi.schema`. */
export const DSL_SCHEMAS: Readonly<Record<string, DslSchema>> = {
  search: SEARCH_BODY,
  count: obj({ query }),
  queryOnly: obj({ query }),
  msearchHeader: obj({
    index: one(str, arr(str)),
    preference: str,
    routing: str,
    search_type: en("query_then_fetch", "dfs_query_then_fetch"),
    request_cache: bool,
    ignore_unavailable: bool,
    expand_wildcards: str,
    allow_no_indices: bool,
  }),
  scroll: obj({ scroll: str, scroll_id: str }),
  clearScroll: obj({ scroll_id: one(str, arr(str)) }),
  pit: obj({ id: str }),
  fieldCaps: obj({ fields: fieldList, index_filter: query, runtime_mappings: named(RUNTIME_FIELD) }),
  searchTemplate: obj({ id: str, source: any, params: anyObj, explain: bool, profile: bool }),
  termsEnum: obj({
    field: aggField,
    string: str,
    size: num,
    timeout: str,
    case_insensitive: bool,
    index_filter: query,
    search_after: str,
  }),
  eql: obj({
    query: str,
    filter: queries,
    size: num,
    fields: arr(field),
    timestamp_field: field,
    event_category_field: field,
    tiebreaker_field: field,
    wait_for_completion_timeout: str,
    keep_alive: str,
  }),
  update: obj({
    doc: anyObj,
    doc_as_upsert: bool,
    upsert: anyObj,
    script,
    scripted_upsert: bool,
    detect_noop: bool,
    _source: SOURCE,
  }),
  mget: obj({
    docs: arr(obj({ _index: str, _id: str, routing: str, _source: SOURCE, stored_fields: arr(str) })),
    ids: arr(str),
  }),
  byQuery: obj({ query, script, max_docs: num, conflicts: en("abort", "proceed"), slice: obj({ id: num, max: num }) }),
  reindex: obj({
    source: obj({
      index: one(str, arr(str)),
      query,
      size: num,
      _source: SOURCE,
      sort: SORT,
      remote: obj({ host: str, username: str, password: str, headers: anyObj }),
      slice: obj({ id: num, max: num }),
      runtime_mappings: named(RUNTIME_FIELD),
    }),
    dest: obj({
      index: str,
      op_type: en("index", "create"),
      pipeline: str,
      version_type: en("internal", "external", "external_gt", "external_gte"),
      routing: str,
    }),
    script,
    conflicts: en("abort", "proceed"),
    max_docs: num,
  }),
  createIndex: obj({ settings: SETTINGS, mappings: MAPPINGS, aliases: named(ALIAS_BODY) }),
  mappings: MAPPINGS,
  indexSettings: SETTINGS,
  alias: ALIAS_BODY,
  aliases: obj({
    actions: arr(
      obj({
        add: ALIAS_ACTION,
        remove: ALIAS_ACTION,
        remove_index: obj({ index: str, indices: arr(str), must_exist: bool }),
      }),
    ),
  }),
  resize: obj({ settings: SETTINGS, aliases: named(ALIAS_BODY) }),
  rollover: obj({
    conditions: obj({
      max_age: str,
      max_docs: num,
      max_size: str,
      max_primary_shard_size: str,
      max_primary_shard_docs: num,
      min_age: str,
      min_docs: num,
      min_size: str,
      min_primary_shard_size: str,
    }),
    settings: SETTINGS,
    mappings: MAPPINGS,
    aliases: named(ALIAS_BODY),
  }),
  analyze: obj({
    analyzer: str,
    text: one(str, arr(str)),
    tokenizer: any,
    filter: arr(any),
    char_filter: arr(any),
    field,
    normalizer: str,
    explain: bool,
    attributes: arr(str),
  }),
  clusterSettings: obj({ persistent: anyObj, transient: anyObj }),
  allocationExplain: obj({ index: str, shard: num, primary: bool, current_node: str }),
  reroute: obj({
    commands: arr(
      obj({
        move: obj({ index: str, shard: num, from_node: str, to_node: str }),
        cancel: obj({ index: str, shard: num, node: str, allow_primary: bool }),
        allocate_replica: obj({ index: str, shard: num, node: str }),
        allocate_stale_primary: obj({ index: str, shard: num, node: str, accept_data_loss: bool }),
        allocate_empty_primary: obj({ index: str, shard: num, node: str, accept_data_loss: bool }),
      }),
    ),
  }),
  indexTemplate: obj({
    index_patterns: one(arr(str), str),
    template: TEMPLATE_PART,
    composed_of: arr(str),
    priority: num,
    version: num,
    _meta: anyObj,
    data_stream: obj({ hidden: bool, allow_custom_routing: bool }),
    allow_auto_create: bool,
    ignore_missing_component_templates: arr(str),
    deprecated: bool,
  }),
  componentTemplate: obj({ template: TEMPLATE_PART, version: num, _meta: anyObj, deprecated: bool }),
  legacyTemplate: obj({
    index_patterns: one(arr(str), str),
    settings: SETTINGS,
    mappings: MAPPINGS,
    aliases: named(ALIAS_BODY),
    order: num,
    version: num,
  }),
  ilmPolicy: obj({
    policy: obj({
      phases: obj({ hot: ILM_PHASE, warm: ILM_PHASE, cold: ILM_PHASE, frozen: ILM_PHASE, delete: ILM_PHASE }),
      _meta: anyObj,
    }),
  }),
  pipeline: PIPELINE,
  simulate: obj({ pipeline: PIPELINE, docs: arr(obj({ _index: str, _id: str, _source: anyObj })) }),
  repository: obj({
    type: en("fs", "url", "s3", "gcs", "azure", "source"),
    settings: obj({
      location: str,
      bucket: str,
      base_path: str,
      client: str,
      compress: bool,
      chunk_size: str,
      readonly: bool,
      max_snapshot_bytes_per_sec: str,
      max_restore_bytes_per_sec: str,
    }),
  }),
  snapshot: obj({
    indices: one(str, arr(str)),
    include_global_state: bool,
    ignore_unavailable: bool,
    partial: bool,
    metadata: anyObj,
    feature_states: arr(str),
  }),
  restore: obj({
    indices: one(str, arr(str)),
    include_global_state: bool,
    ignore_unavailable: bool,
    partial: bool,
    rename_pattern: str,
    rename_replacement: str,
    include_aliases: bool,
    index_settings: SETTINGS,
    ignore_index_settings: arr(str),
    feature_states: arr(str),
  }),
  user: obj({
    password: str,
    password_hash: str,
    roles: arr(str),
    full_name: str,
    email: str,
    metadata: anyObj,
    enabled: bool,
  }),
  password: obj({ password: str, password_hash: str }),
  hasPrivileges: obj({
    cluster: arr(str),
    index: arr(obj({ names: arr(str), privileges: arr(str), allow_restricted_indices: bool })),
    application: arr(anyObj),
  }),
  role: obj({
    cluster: arr(
      en(
        "all",
        "monitor",
        "manage",
        "manage_index_templates",
        "manage_ilm",
        "manage_pipeline",
        "manage_security",
        "manage_api_key",
        "read_ilm",
        "transport_client",
      ),
    ),
    indices: arr(INDEX_PRIVILEGES),
    applications: arr(anyObj),
    run_as: arr(str),
    metadata: anyObj,
    description: str,
  }),
  apiKey: obj({
    name: str,
    expiration: str,
    role_descriptors: named(obj({ cluster: arr(str), indices: arr(INDEX_PRIVILEGES) })),
    metadata: anyObj,
  }),
  invalidateApiKey: obj({ ids: arr(str), name: str, username: str, realm_name: str, owner: bool }),
  sql: obj({
    query: str,
    fetch_size: num,
    filter: query,
    params: arr(any),
    time_zone: str,
    columnar: bool,
    cursor: str,
    page_timeout: str,
    request_timeout: str,
    field_multi_value_leniency: bool,
    runtime_mappings: named(RUNTIME_FIELD),
    wait_for_completion_timeout: str,
    keep_alive: str,
    keep_on_completion: bool,
  }),
  sqlClose: obj({ cursor: str }),
  esql: obj({
    query: str,
    params: arr(any),
    filter: query,
    columnar: bool,
    locale: str,
    profile: bool,
    include_ccs_metadata: bool,
  }),
  modifyDataStream: obj({
    actions: arr(
      obj({
        add_backing_index: obj({ data_stream: str, index: str }),
        remove_backing_index: obj({ data_stream: str, index: str }),
      }),
    ),
  }),
  storedScript: obj({ script: obj({ lang: en("painless", "mustache", "expression"), source: any, params: anyObj }) }),
};

/** The schema at `path` (keys, `[]` for array items) under `root`, null where unknown. */
export function schemaAt(root: DslSchema, path: readonly string[]): DslSchema | null {
  let s: DslSchema | null = root;
  for (const seg of path) {
    if (!s) return null;
    s = step(s, seg);
  }
  return s;
}

function step(s: DslSchema, seg: string): DslSchema | null {
  switch (s.kind) {
    case "object": {
      const key = s.keys[seg];
      if (key) return resolveRef(key);
      return s.fieldKeys && seg !== "[]" ? resolveRef(s.fieldKeys) : null;
    }
    case "fields":
    case "named":
      return seg === "[]" ? null : resolveRef(s.value);
    case "array":
      return seg === "[]" ? resolveRef(s.items) : null;
    case "oneOf": {
      const hits = s.options.map((o) => step(resolveRef(o), seg)).filter((x): x is DslSchema => !!x);
      if (hits.length <= 1) return hits[0] ?? null;
      return { kind: "oneOf", options: hits };
    }
    case "value":
      return null;
  }
}

/** Keys an object at `schema` takes: known ones, and whether field names fit (with their value schema). */
export function schemaKeys(schema: DslSchema): {
  keys: Array<[string, DslSchema]>;
  fields: { value: DslSchema; filter: FieldFilter } | null;
} {
  const keys = new Map<string, DslSchema>();
  let fields: { value: DslSchema; filter: FieldFilter } | null = null;
  const visit = (s: DslSchema) => {
    switch (s.kind) {
      case "object":
        for (const [k, v] of Object.entries(s.keys)) if (!keys.has(k)) keys.set(k, resolveRef(v));
        if (s.fieldKeys && !fields) fields = { value: resolveRef(s.fieldKeys), filter: "any" };
        break;
      case "fields":
        if (!fields) fields = { value: resolveRef(s.value), filter: s.filter ?? "any" };
        break;
      case "oneOf":
        for (const o of s.options) visit(resolveRef(o));
        break;
      default:
    }
  };
  visit(schema);
  return { keys: [...keys], fields };
}

/** The value schemas a place can hold (a `oneOf` flattened). */
export function schemaValues(schema: DslSchema): DslSchema[] {
  return schema.kind === "oneOf" ? schema.options.flatMap((o) => schemaValues(resolveRef(o))) : [schema];
}

/** Query clause names (`match`, `bool`…). */
export const QUERY_CLAUSE_NAMES: readonly string[] = Object.keys((QUERY as { keys: object }).keys);
