//! Elasticsearch (and OpenSearch) data sources: the REST API over HTTP(S), basic or API
//! key authentication, TLS as the data source's SSL mode says, through its SSH tunnel.
//! One HTTP client per data source; requests are cancellable. Read-only data sources
//! only read: `GET` / `HEAD`, and `POST` to the search APIs (`_search`, `_count`, …).

use crate::redis::{expand_home, tls_provider};
use crate::{DataSource, DbDriver, DbManager, DbSslMode, through_tunnel};
use ide_core::error::ErrorKind;
use ide_core::{CancellationToken, IdeError, IdeResult};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Method, StatusCode};
use serde::Serialize;
use serde_json::Value;
use specta::Type;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::time::{Duration, Instant};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Requests of the tree and Discover (cluster, indices, fields) give up after this;
/// console requests (`es_request`) have no limit, they are cancelled instead.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
/// Response bodies of `es_request` are read up to this size; bigger ones are cut (`truncated`).
pub const MAX_BODY_BYTES: usize = 50 * 1024 * 1024;
/// Methods `es_request` sends.
const METHODS: &[&str] = &["GET", "POST", "PUT", "DELETE", "HEAD", "PATCH"];

/// One REST request's answer (`es_request`): status and the body as text (JSON mostly).
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EsResponse {
    pub status: u16,
    /// Round trip as measured by Luma (ES's own `took` is in the body).
    pub elapsed_ms: f64,
    pub content_type: String,
    pub body: String,
    /// The body was cut at the size limit (`MAX_BODY_BYTES`).
    pub truncated: bool,
}

/// The cluster of a data source (`GET /`, `_cluster/health`, `_cluster/stats`).
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EsCluster {
    pub name: String,
    pub uuid: String,
    /// `elasticsearch` or `opensearch`.
    pub distribution: String,
    pub version: String,
    /// `green`, `yellow` or `red`.
    pub status: String,
    pub nodes: u32,
    pub data_nodes: u32,
    pub active_shards: u32,
    pub active_primary_shards: u32,
    pub relocating_shards: u32,
    pub initializing_shards: u32,
    pub unassigned_shards: u32,
    pub indices: u32,
    pub docs: f64,
    pub store_bytes: f64,
}

/// An index (`_cat/indices`), hidden and system ones included.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EsIndex {
    pub name: String,
    /// `green`, `yellow`, `red`; empty for closed indices.
    pub health: String,
    /// `open` or `close`.
    pub status: String,
    pub uuid: String,
    pub primaries: u32,
    pub replicas: u32,
    pub docs: f64,
    pub store_bytes: f64,
    /// Hidden (`index.hidden`) or a system index (a leading `.`).
    pub hidden: bool,
    /// The data stream it backs, if any.
    pub data_stream: Option<String>,
    pub aliases: Vec<String>,
}

/// A data stream (`_data_stream`) and its backing indices, oldest first.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EsDataStream {
    pub name: String,
    pub timestamp_field: String,
    pub indices: Vec<String>,
    pub status: String,
    pub hidden: bool,
}

/// An alias and the indices it points to.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EsAlias {
    pub name: String,
    pub indices: Vec<String>,
}

/// Everything the tree lists of a cluster.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EsIndices {
    pub indices: Vec<EsIndex>,
    pub data_streams: Vec<EsDataStream>,
    pub aliases: Vec<EsAlias>,
}

/// A field of an index pattern (`_field_caps`): its type(s) and what it can do.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EsField {
    /// Dotted path (`user.name`, `message.keyword`).
    pub name: String,
    /// Mapping types; more than one when indices of the pattern disagree.
    pub types: Vec<String>,
    pub searchable: bool,
    pub aggregatable: bool,
    /// `_id`, `_index`, … (`_field_caps` metadata fields).
    pub metadata: bool,
}

// ---- the client ----------------------------------------------------------------------------

/// How requests authenticate.
#[derive(Clone)]
enum Auth {
    None,
    Basic {
        user: String,
        password: String,
    },
    /// `Authorization: ApiKey <key>` (the `encoded` value of `POST /_security/api_key`).
    ApiKey(String),
}

impl Auth {
    /// Basic with a user name, an API key without one, else none.
    fn of(user: &str, password: Option<&str>) -> Self {
        let (user, password) = (user.trim(), password.unwrap_or(""));
        if !user.is_empty() {
            Auth::Basic { user: user.to_owned(), password: password.to_owned() }
        } else if !password.trim().is_empty() {
            Auth::ApiKey(password.trim().to_owned())
        } else {
            Auth::None
        }
    }
}

/// The HTTP client of a connected data source and where it sends requests.
#[derive(Clone)]
pub(crate) struct EsClient {
    http: reqwest::Client,
    /// `http(s)://host:port`, without a trailing `/`.
    base: String,
    auth: Auth,
}

impl EsClient {
    /// A request to `path` (starting with `/`, query string included).
    fn request(&self, method: Method, path: &str) -> IdeResult<reqwest::RequestBuilder> {
        let url = reqwest::Url::parse(&format!("{}{path}", self.base))
            .map_err(|e| IdeError::invalid(format!("not a request path: {path} ({e})")))?;
        let r = self.http.request(method, url);
        Ok(match &self.auth {
            Auth::None => r,
            Auth::Basic { user, password } => r.basic_auth(user, Some(password)),
            Auth::ApiKey(key) => r.header(AUTHORIZATION, format!("ApiKey {key}")),
        })
    }
}

/// How a connection attempt reaches the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Transport {
    Http,
    /// Encrypted, the certificate not checked.
    HttpsAnyCert,
    /// Encrypted, the certificate checked (against the CA file when there is one).
    HttpsVerified,
}

/// What to try, in order, for SSL mode `ssl`: Prefer falls back to plain HTTP when TLS fails.
fn transports(ssl: DbSslMode) -> &'static [Transport] {
    match ssl {
        DbSslMode::Disable => &[Transport::Http],
        DbSslMode::Prefer => &[Transport::HttpsAnyCert, Transport::Http],
        DbSslMode::Require => &[Transport::HttpsAnyCert],
        DbSslMode::VerifyCa | DbSslMode::VerifyFull => &[Transport::HttpsVerified],
    }
}

/// `http(s)://host:port` of `source` (already through its tunnel).
fn base_url(source: &DataSource, transport: Transport) -> String {
    let scheme = if transport == Transport::Http { "http" } else { "https" };
    let host = match source.host.trim() {
        "" => "localhost",
        h => h,
    };
    let host = if host.contains(':') && !host.starts_with('[') { format!("[{host}]") } else { host.to_owned() };
    let port = source.port.or(DbDriver::Elasticsearch.default_port()).unwrap_or(9200);
    format!("{scheme}://{host}:{port}")
}

/// An HTTP client for `source` over `transport`: direct (no HTTP proxy, like the other
/// drivers), the client certificate and CA file of the data source for HTTPS.
fn http_client(source: &DataSource, transport: Transport) -> IdeResult<reqwest::Client> {
    tls_provider();
    let mut b = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .tcp_keepalive(Duration::from_secs(60))
        .no_proxy()
        .user_agent(concat!("Luma/", env!("CARGO_PKG_VERSION")));
    if transport != Transport::Http {
        let read = |p: &str| std::fs::read(expand_home(p)).map_err(|e| IdeError::invalid(format!("{p}: {e}")));
        let bad = |p: &str, e: reqwest::Error| IdeError::invalid(format!("{p}: {e}"));
        let (cert, key) = (source.ssl_cert_file.trim(), source.ssl_key_file.trim());
        if !cert.is_empty() && !key.is_empty() {
            let mut pem = read(cert)?;
            pem.push(b'\n');
            pem.extend(read(key)?);
            b = b.identity(reqwest::Identity::from_pem(&pem).map_err(|e| bad(cert, e))?);
        }
        let ca = source.ssl_ca_file.trim();
        match transport {
            Transport::HttpsAnyCert => b = b.tls_danger_accept_invalid_certs(true),
            Transport::HttpsVerified if !ca.is_empty() => {
                let certs = reqwest::Certificate::from_pem_bundle(&read(ca)?).map_err(|e| bad(ca, e))?;
                b = b.tls_certs_only(certs);
                if source.ssl == DbSslMode::VerifyCa {
                    // The CA is checked; the certificate may name another host (a tunnel, an IP).
                    b = b.tls_danger_accept_invalid_hostnames(true);
                }
            }
            // Without a CA file: the system's certificates, host name included (reqwest
            // ignores host names only with an explicit CA).
            _ => {}
        }
    }
    b.build().map_err(|e| IdeError::internal(format!("HTTP client: {}", describe(&e))))
}

/// reqwest errors with their causes ("error sending request: … Connection refused").
fn describe(e: &reqwest::Error) -> String {
    use std::error::Error;
    let mut msg = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        let s_msg = s.to_string();
        if !msg.contains(&s_msg) {
            msg.push_str(": ");
            msg.push_str(&s_msg);
        }
        source = s.source();
    }
    msg
}

/// A request that got no answer (refused, TLS, timed out, dropped).
fn transport_err(e: reqwest::Error) -> IdeError {
    let kind = if e.is_timeout() && !e.is_connect() { ErrorKind::TimedOut } else { ErrorKind::Io };
    IdeError::new(kind, describe(&e))
}

/// What an error answer says: `error.root_cause[0].reason` (or `error.reason`, or the text).
fn error_reason(body: &str) -> Option<String> {
    let v: Value = serde_json::from_str(body).ok()?;
    let e = v.get("error")?;
    if let Some(s) = e.as_str() {
        return Some(s.to_owned());
    }
    let first = e.get("root_cause").and_then(|r| r.get(0)).filter(|r| r.get("reason").is_some()).unwrap_or(e);
    let reason = first.get("reason").and_then(Value::as_str)?;
    Some(match first.get("type").and_then(Value::as_str) {
        Some(t) => format!("[{t}] {reason}"),
        None => reason.to_owned(),
    })
}

/// An error answer as an error: 401 / 403 deny (and ask for the password on connect).
fn status_err(status: StatusCode, body: &str) -> IdeError {
    let reason = error_reason(body).unwrap_or_else(|| body.trim().chars().take(300).collect());
    let status_text = format!("{} {}", status.as_u16(), status.canonical_reason().unwrap_or("")).trim_end().to_owned();
    let msg = if reason.is_empty() { status_text } else { format!("{reason} ({status_text})") };
    let kind = match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => ErrorKind::PermissionDenied,
        StatusCode::NOT_FOUND => ErrorKind::NotFound,
        StatusCode::REQUEST_TIMEOUT | StatusCode::GATEWAY_TIMEOUT => ErrorKind::TimedOut,
        s if s.is_server_error() => ErrorKind::Protocol,
        _ => ErrorKind::InvalidInput,
    };
    IdeError::new(kind, msg)
}

/// A successful JSON answer, else its error.
async fn json_of(resp: reqwest::Response) -> IdeResult<Value> {
    let status = resp.status();
    let text = resp.text().await.map_err(transport_err)?;
    if !status.is_success() {
        return Err(status_err(status, &text));
    }
    serde_json::from_str(&text)
        .map_err(|e| IdeError::new(ErrorKind::Protocol, format!("not an Elasticsearch answer: {e}")))
}

/// `GET path` of the tree and Discover: JSON, within [`RESPONSE_TIMEOUT`].
async fn get_json(client: &EsClient, path: &str) -> IdeResult<Value> {
    let resp = client.request(Method::GET, path)?.timeout(RESPONSE_TIMEOUT).send().await.map_err(transport_err)?;
    json_of(resp).await
}

/// Connects to `source` (already through its tunnel): the client that answered `GET /`, and that answer.
async fn open(source: &DataSource, password: Option<&str>) -> IdeResult<(EsClient, Value)> {
    let auth = Auth::of(&source.user, password);
    let tries = transports(source.ssl);
    for (i, &transport) in tries.iter().enumerate() {
        let client =
            EsClient { http: http_client(source, transport)?, base: base_url(source, transport), auth: auth.clone() };
        let sent = client.request(Method::GET, "/")?.timeout(RESPONSE_TIMEOUT).send().await;
        let resp = match sent {
            Ok(r) => r,
            // Prefer: the server does not speak TLS (or not on this port): plain HTTP.
            Err(e) if e.is_connect() && i + 1 < tries.len() => {
                tracing::debug!("Elasticsearch {}: {}; trying plain HTTP", client.base, describe(&e));
                continue;
            }
            Err(e) => return Err(transport_err(e)),
        };
        let root = json_of(resp).await?;
        if root.pointer("/version/number").and_then(Value::as_str).is_none() {
            return Err(IdeError::new(
                ErrorKind::Protocol,
                format!("{} is not an Elasticsearch or OpenSearch server", client.base),
            ));
        }
        return Ok((client, root));
    }
    unreachable!("every SSL mode tries at least one transport")
}

/// `Elasticsearch 8.15.0` / `OpenSearch 2.17.0` of a `GET /` answer.
fn product(root: &Value) -> (String, String) {
    let distribution =
        root.pointer("/version/distribution").and_then(Value::as_str).unwrap_or("elasticsearch").to_ascii_lowercase();
    let version = root.pointer("/version/number").and_then(Value::as_str).unwrap_or_default().to_owned();
    (distribution, version)
}

fn product_name(distribution: &str) -> &str {
    match distribution {
        "opensearch" => "OpenSearch",
        "elasticsearch" => "Elasticsearch",
        other => other,
    }
}

// ---- requests ------------------------------------------------------------------------------

/// `logs/_search?q=x` → `/logs/_search?q=x`; a pasted `http://host:9200/…` keeps its path.
fn normalize_path(path: &str) -> String {
    let mut p = path.trim();
    for scheme in ["http://", "https://"] {
        if p.len() >= scheme.len() && p[..scheme.len()].eq_ignore_ascii_case(scheme) {
            let rest = &p[scheme.len()..];
            p = rest.find('/').map_or("", |i| &rest[i..]);
        }
    }
    if p.starts_with('/') { p.to_owned() } else { format!("/{p}") }
}

/// Segments of the path of `path` (the query string left out).
fn segments(path: &str) -> Vec<&str> {
    let p = path.split(['?', '#']).next().unwrap_or("");
    p.split('/').filter(|s| !s.is_empty()).collect()
}

/// `_bulk` and `_msearch` take newline-delimited JSON.
fn is_ndjson(path: &str) -> bool {
    segments(path).iter().any(|s| matches!(*s, "_bulk" | "_msearch"))
}

/// Whether a read-only data source may send `method` (upper case) to `path`: `GET` and
/// `HEAD`; `POST` to the search and analysis APIs; `DELETE` of a scroll or point in time.
fn is_read_only_request(method: &str, path: &str) -> bool {
    match method {
        "GET" | "HEAD" => return true,
        "POST" | "DELETE" => {}
        _ => return false,
    }
    let segs = segments(path);
    // The API is the first `_` segment (index names never start with `_`).
    let Some(i) = segs.iter().position(|s| s.starts_with('_')) else { return false };
    let (api, rest) = (segs[i], &segs[i + 1..]);
    if method == "DELETE" {
        // Clear scroll, close point in time.
        return matches!((api, rest), ("_pit", []) | ("_search", ["scroll", ..]));
    }
    match api {
        "_search" => matches!(rest, [] | ["scroll", ..] | ["template"]),
        "_msearch" => matches!(rest, [] | ["template"]),
        "_count" | "_field_caps" | "_mget" | "_analyze" | "_mtermvectors" | "_search_shards" | "_async_search"
        | "_pit" | "_terms_enum" => rest.is_empty(),
        "_validate" => rest == ["query"],
        "_explain" => rest.len() == 1,
        "_termvectors" => rest.len() <= 1,
        "_render" => matches!(rest, ["template"] | ["template", _]),
        "_sql" => matches!(rest, [] | ["translate"] | ["close"]),
        "_eql" => rest == ["search"],
        "_query" => matches!(rest, [] | ["async"]),
        _ => false,
    }
}

/// An index name or pattern as a path segment (`logs-*`, `a,b`, `remote:logs` stay readable).
fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'*' | b',' | b':' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The text of `bytes` cut at the size limit: an incomplete last character is dropped.
fn body_text(mut bytes: Vec<u8>) -> String {
    if let Err(e) = std::str::from_utf8(&bytes)
        && e.error_len().is_none()
    {
        bytes.truncate(e.valid_up_to());
    }
    match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    }
}

// ---- JSON helpers --------------------------------------------------------------------------

/// A number of an answer (`_cat` APIs give them as strings); 0 when missing.
fn num(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn count(v: Option<&Value>) -> u32 {
    num(v).clamp(0.0, u32::MAX as f64) as u32
}

fn text(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

/// The cluster of `GET /`, `_cluster/health` and (optional) `_cluster/stats` answers.
fn cluster_of(root: &Value, health: &Value, stats: &Value) -> EsCluster {
    let (distribution, version) = product(root);
    let h = |k: &str| health.get(k);
    EsCluster {
        name: text(root.get("cluster_name").or_else(|| h("cluster_name"))),
        uuid: text(root.get("cluster_uuid")),
        distribution,
        version,
        status: text(h("status")).to_ascii_lowercase(),
        nodes: count(h("number_of_nodes")),
        data_nodes: count(h("number_of_data_nodes")),
        active_shards: count(h("active_shards")),
        active_primary_shards: count(h("active_primary_shards")),
        relocating_shards: count(h("relocating_shards")),
        initializing_shards: count(h("initializing_shards")),
        unassigned_shards: count(h("unassigned_shards")),
        indices: count(stats.pointer("/indices/count")),
        docs: num(stats.pointer("/indices/docs/count")),
        store_bytes: num(stats.pointer("/indices/store/size_in_bytes")),
    }
}

/// Indices, data streams and aliases of `_cat/indices`, `_settings/index.hidden`,
/// `_cat/aliases` and `_data_stream` answers (the last three optional: `Null`).
fn indices_of(cat: &Value, hidden: &Value, aliases: &Value, streams: &Value) -> EsIndices {
    let mut by_alias: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut of_index: HashMap<String, BTreeSet<String>> = HashMap::new();
    for a in aliases.as_array().into_iter().flatten() {
        let (alias, index) = (text(a.get("alias")), text(a.get("index")));
        if alias.is_empty() || index.is_empty() {
            continue;
        }
        by_alias.entry(alias.clone()).or_default().insert(index.clone());
        of_index.entry(index).or_default().insert(alias);
    }
    let mut data_streams: Vec<EsDataStream> = streams
        .get("data_streams")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|d| EsDataStream {
            name: text(d.get("name")),
            timestamp_field: text(d.pointer("/timestamp_field/name")),
            indices: d
                .get("indices")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|i| text(i.get("index_name")))
                .collect(),
            status: text(d.get("status")).to_ascii_lowercase(),
            hidden: truthy(d.get("hidden")),
        })
        .collect();
    data_streams.sort_by(|a, b| a.name.cmp(&b.name));
    let stream_of: HashMap<&str, &str> =
        data_streams.iter().flat_map(|d| d.indices.iter().map(move |i| (i.as_str(), d.name.as_str()))).collect();
    let hidden_set: HashSet<&str> = hidden
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, v)| truthy(v.pointer("/settings/index.hidden")) || truthy(v.pointer("/settings/index/hidden")))
        .map(|(k, _)| k.as_str())
        .collect();
    let mut indices: Vec<EsIndex> = cat
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| {
            let name = text(r.get("index"));
            let status = text(r.get("status"));
            EsIndex {
                health: if status == "close" { String::new() } else { text(r.get("health")) },
                uuid: text(r.get("uuid")),
                primaries: count(r.get("pri")),
                replicas: count(r.get("rep")),
                docs: num(r.get("docs.count")),
                store_bytes: num(r.get("store.size")),
                hidden: name.starts_with('.') || hidden_set.contains(name.as_str()),
                data_stream: stream_of.get(name.as_str()).map(|s| (*s).to_owned()),
                aliases: of_index.remove(&name).map(|a| a.into_iter().collect()).unwrap_or_default(),
                status,
                name,
            }
        })
        .collect();
    indices.sort_by(|a, b| a.name.cmp(&b.name));
    let aliases =
        by_alias.into_iter().map(|(name, indices)| EsAlias { name, indices: indices.into_iter().collect() }).collect();
    EsIndices { indices, data_streams, aliases }
}

/// Fields of a `_field_caps` answer, sorted by name.
fn fields_of(caps: &Value) -> Vec<EsField> {
    let mut out: Vec<EsField> = caps
        .get("fields")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(name, by_type)| {
            let by_type = by_type.as_object()?;
            let mut types: Vec<String> = by_type.keys().filter(|t| *t != "unmapped").cloned().collect();
            types.sort();
            types.dedup();
            if types.is_empty() {
                return None;
            }
            let any = |k: &str| by_type.values().any(|c| truthy(c.get(k)));
            // `metadata_field` is 7.13+; before, metadata fields are the `_` ones.
            let flagged = by_type.values().any(|c| c.get("metadata_field").is_some());
            Some(EsField {
                name: name.clone(),
                types,
                searchable: any("searchable"),
                aggregatable: any("aggregatable"),
                metadata: if flagged { any("metadata_field") } else { name.starts_with('_') },
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

// ---- the manager ---------------------------------------------------------------------------

impl DbManager {
    /// The client of data source `id`, connecting first if needed.
    async fn es_client(&self, id: &str) -> IdeResult<EsClient> {
        // A dropped SSH session leaves the client unusable: start over.
        let tunnel_closed = self.tunnels.lock().get(id).is_some_and(|t| t.is_closed());
        if tunnel_closed {
            self.es_clients.lock().remove(id);
        }
        if let Some(c) = self.es_clients.lock().get(id) {
            return Ok(c.clone());
        }
        let source = self.source(id)?;
        if source.driver != DbDriver::Elasticsearch {
            return Err(IdeError::invalid(format!("{} is not an Elasticsearch data source", source.name)));
        }
        let password = self.password(&source).await;
        let (endpoint, tunnel) = self.endpoint(&source, None, true).await?;
        let label = tunnel.is_some().then(|| self.ssh_label(source.ssh.as_ref().expect("tunneled")));
        match open(&endpoint, password.as_deref()).await {
            // Another caller may have connected meanwhile; keep theirs.
            Ok((client, _)) => Ok(self.es_clients.lock().entry(id.to_owned()).or_insert(client).clone()),
            Err(e) => {
                self.drop_unused_tunnel(id);
                Err(through_tunnel(e, &source, label.as_deref()))
            }
        }
    }

    /// Connects data source `id` (checks it answers `GET /` with the credentials).
    pub async fn elastic(&self, id: &str) -> IdeResult<()> {
        self.es_client(id).await.map(|_| ())
    }

    /// `Elasticsearch 8.15.0` / `OpenSearch 2.17.0` (Test Connection).
    pub(crate) async fn elastic_test(
        &self,
        source: &crate::DataSource,
        password: Option<String>,
        ssh_secret: Option<String>,
    ) -> IdeResult<String> {
        let (endpoint, tunnel) = self.endpoint(source, ssh_secret, false).await?;
        let label = tunnel.is_some().then(|| self.ssh_label(source.ssh.as_ref().expect("tunneled")));
        let (_, root) =
            open(&endpoint, password.as_deref()).await.map_err(|e| through_tunnel(e, source, label.as_deref()))?;
        let (distribution, version) = product(&root);
        Ok(format!("{} {version}", product_name(&distribution)))
    }

    /// Name, version, health, nodes, shards and totals of the cluster of `id`.
    pub async fn es_cluster(&self, id: &str) -> IdeResult<EsCluster> {
        let c = self.es_client(id).await?;
        let stats_path = "/_cluster/stats?filter_path=indices.count,indices.docs.count,indices.store.size_in_bytes";
        let (root, health, stats) =
            futures::join!(get_json(&c, "/"), get_json(&c, "/_cluster/health"), get_json(&c, stats_path));
        // Stats need more privileges than health: totals stay 0 without them.
        Ok(cluster_of(&root?, &health?, &stats.unwrap_or(Value::Null)))
    }

    /// Indices (hidden and closed ones included), data streams and aliases of `id`.
    pub async fn es_indices(&self, id: &str) -> IdeResult<EsIndices> {
        let c = self.es_client(id).await?;
        let cat = "/_cat/indices?format=json&bytes=b&expand_wildcards=all\
                   &h=health,status,index,uuid,pri,rep,docs.count,store.size";
        // Optional ones: older servers and OpenSearch may not know a parameter or API.
        let or_without = |with: &'static str, without: &'static str| {
            let c = c.clone();
            async move {
                match get_json(&c, with).await {
                    Ok(v) => v,
                    Err(_) => get_json(&c, without).await.unwrap_or(Value::Null),
                }
            }
        };
        let (cat, hidden, aliases, streams) = futures::join!(
            get_json(&c, cat),
            or_without(
                "/_settings/index.hidden?expand_wildcards=all&flat_settings=true",
                "/_settings/index.hidden?flat_settings=true"
            ),
            or_without("/_cat/aliases?format=json&expand_wildcards=all", "/_cat/aliases?format=json"),
            or_without("/_data_stream?expand_wildcards=all", "/_data_stream"),
        );
        Ok(indices_of(&cat?, &hidden, &aliases, &streams))
    }

    /// Fields of `index` (a name, alias, data stream or pattern like `logs-*`).
    pub async fn es_fields(&self, id: &str, index: &str) -> IdeResult<Vec<EsField>> {
        let c = self.es_client(id).await?;
        let index = index.trim();
        let path = if index.is_empty() {
            "/_field_caps?fields=*&include_unmapped=false".to_owned()
        } else {
            format!("/{}/_field_caps?fields=*&include_unmapped=false", encode_segment(index))
        };
        Ok(fields_of(&get_json(&c, &path).await?))
    }

    /// One REST request: `method` (`GET`, `POST`, `PUT`, `DELETE`, `HEAD`, `PATCH`), `path`
    /// (`/logs/_search?size=0`, leading `/` optional), JSON `body`. Non-2xx answers are
    /// responses too (their status and body), not errors.
    pub async fn es_request(
        &self,
        id: &str,
        method: &str,
        path: &str,
        body: Option<&str>,
        cancel: &CancellationToken,
    ) -> IdeResult<EsResponse> {
        let m = method.trim().to_ascii_uppercase();
        if !METHODS.contains(&m.as_str()) {
            return Err(IdeError::invalid(format!("unsupported HTTP method: {method}")));
        }
        let path = normalize_path(path);
        if self.source(id)?.read_only && !is_read_only_request(&m, &path) {
            return Err(IdeError::new(
                ErrorKind::PermissionDenied,
                format!("the data source is read-only: {m} {path} is not allowed"),
            ));
        }
        let body = body.filter(|b| !b.trim().is_empty());
        let run = async {
            let client = self.es_client(id).await?;
            let mut r = client.request(Method::from_bytes(m.as_bytes()).expect("a known method"), &path)?;
            if let Some(b) = body {
                r = if is_ndjson(&path) {
                    let mut b = b.to_owned();
                    if !b.ends_with('\n') {
                        b.push('\n');
                    }
                    r.header(CONTENT_TYPE, "application/x-ndjson").body(b)
                } else {
                    r.header(CONTENT_TYPE, "application/json").body(b.to_owned())
                };
            }
            let started = Instant::now();
            let mut resp = r.send().await.map_err(transport_err)?;
            let status = resp.status().as_u16();
            let content_type =
                resp.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
            let mut bytes = Vec::new();
            let mut truncated = false;
            while let Some(chunk) = resp.chunk().await.map_err(transport_err)? {
                let room = MAX_BODY_BYTES - bytes.len();
                if chunk.len() > room {
                    bytes.extend_from_slice(&chunk[..room]);
                    truncated = true;
                    break;
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(EsResponse {
                status,
                elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
                content_type,
                body: body_text(bytes),
                truncated,
            })
        };
        let r = tokio::select! {
            r = run => r,
            _ = cancel.cancelled() => Err(IdeError::cancelled()),
        };
        if !matches!(&r, Err(e) if matches!(e.kind, ErrorKind::Cancelled | ErrorKind::PermissionDenied)) {
            self.remember_es(id, &format!("{m} {path}"));
        }
        r
    }

    /// Records a request line in the query history of `id`.
    fn remember_es(&self, id: &str, text: &str) {
        let time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
        let _ = self.recorder.send((id.to_owned(), text.to_owned(), time));
    }

    /// Drops the client of data source `id` (its tunnel goes with the last connection).
    pub(crate) fn elastic_disconnect(&self, id: &str) {
        self.es_clients.lock().remove(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn read_only_requests() {
        let ok = |m: &str, p: &str| is_read_only_request(m, &normalize_path(p));
        for (m, p) in [
            ("GET", "/"),
            ("HEAD", "/logs"),
            ("GET", "/_cat/indices?v"),
            ("POST", "/logs/_search?size=0"),
            ("POST", "_search"),
            ("POST", "/logs-*,metrics/_count"),
            ("POST", "/_msearch"),
            ("POST", "/logs/_msearch/template"),
            ("POST", "/_search/scroll"),
            ("DELETE", "/_search/scroll"),
            ("POST", "/logs/_pit?keep_alive=1m"),
            ("DELETE", "/_pit"),
            ("POST", "/logs/_field_caps?fields=*"),
            ("POST", "/logs/_validate/query?explain"),
            ("POST", "/logs/_explain/1"),
            ("POST", "/_mget"),
            ("POST", "/_analyze"),
            ("POST", "/logs/_termvectors/1"),
            ("POST", "/_mtermvectors"),
            ("POST", "/logs/_search_shards"),
            ("POST", "/_render/template"),
            ("POST", "/_sql?format=txt"),
            ("POST", "/_sql/translate"),
            ("POST", "/logs/_eql/search"),
            ("POST", "/logs/_async_search"),
            ("POST", "/_query"),
            ("POST", "/_query/async"),
        ] {
            assert!(ok(m, p), "{m} {p} should be allowed");
        }
        for (m, p) in [
            ("PUT", "/logs"),
            ("DELETE", "/logs"),
            ("PATCH", "/logs"),
            ("POST", "/logs/_doc"),
            ("POST", "/logs/_doc/1"),
            ("POST", "/_bulk"),
            ("POST", "/logs/_update/1"),
            ("POST", "/logs/_delete_by_query"),
            ("POST", "/logs/_update_by_query"),
            ("POST", "/logs/_refresh"),
            ("POST", "/logs/_close"),
            ("POST", "/_reindex"),
            ("POST", "/logs/_search/oops"),
            ("POST", "/logs"),
            ("POST", "/_security/api_key"),
            ("DELETE", "/logs/_search"),
            ("DELETE", "/_async_search/abc"),
        ] {
            assert!(!ok(m, p), "{m} {p} should be refused");
        }
    }

    #[test]
    fn normalizes_paths() {
        assert_eq!(normalize_path("logs/_search"), "/logs/_search");
        assert_eq!(normalize_path("  /logs/_count?q=a "), "/logs/_count?q=a");
        assert_eq!(normalize_path(""), "/");
        assert_eq!(normalize_path("?pretty"), "/?pretty");
        assert_eq!(normalize_path("http://localhost:9200/_cat/indices"), "/_cat/indices");
        assert_eq!(normalize_path("HTTPS://es.local"), "/");
        assert!(is_ndjson("/logs/_bulk?refresh=true"));
        assert!(is_ndjson("/_msearch/template"));
        assert!(!is_ndjson("/logs/_search?q=_bulk"));
        assert_eq!(encode_segment("logs-*,a:b"), "logs-*,a:b");
        assert_eq!(encode_segment("a b/c+"), "a%20b%2Fc%2B");
    }

    #[test]
    fn transports_by_ssl_mode() {
        assert_eq!(transports(DbSslMode::Disable), [Transport::Http]);
        assert_eq!(transports(DbSslMode::Prefer), [Transport::HttpsAnyCert, Transport::Http]);
        assert_eq!(transports(DbSslMode::Require), [Transport::HttpsAnyCert]);
        assert_eq!(transports(DbSslMode::VerifyFull), [Transport::HttpsVerified]);
        let s = |host: &str, port| DataSource { host: host.into(), port, ..Default::default() };
        assert_eq!(base_url(&s("es.local", None), Transport::Http), "http://es.local:9200");
        assert_eq!(base_url(&s("::1", Some(9201)), Transport::HttpsAnyCert), "https://[::1]:9201");
        assert_eq!(base_url(&s(" ", None), Transport::Http), "http://localhost:9200");
    }

    #[test]
    fn authenticates_by_user_or_api_key() {
        assert!(
            matches!(Auth::of("elastic", Some("pw")), Auth::Basic { ref user, ref password } if user == "elastic" && password == "pw")
        );
        assert!(matches!(Auth::of("elastic", None), Auth::Basic { ref password, .. } if password.is_empty()));
        assert!(matches!(Auth::of(" ", Some(" a2V5 ")), Auth::ApiKey(ref k) if k == "a2V5"));
        assert!(matches!(Auth::of("", None), Auth::None));
    }

    #[test]
    fn error_reasons() {
        let body = r#"{"error":{"root_cause":[{"type":"security_exception","reason":"unable to authenticate"}],"type":"security_exception","reason":"x"},"status":401}"#;
        let e = status_err(StatusCode::UNAUTHORIZED, body);
        assert_eq!(e.kind, ErrorKind::PermissionDenied);
        assert_eq!(e.message, "[security_exception] unable to authenticate (401 Unauthorized)");
        assert_eq!(status_err(StatusCode::NOT_FOUND, "").kind, ErrorKind::NotFound);
        assert_eq!(
            error_reason(r#"{"error":"IndexMissingException[[x] missing]"}"#).unwrap(),
            "IndexMissingException[[x] missing]"
        );
        assert_eq!(body_text("aé".as_bytes()[..2].to_vec()), "a");
    }

    #[test]
    fn reads_indices_streams_and_aliases() {
        let cat = json!([
            {"health":"yellow","status":"open","index":"logs","uuid":"u1","pri":"1","rep":"1","docs.count":"4","store.size":"6553"},
            {"health":"green","status":"open","index":".ds-events-1","uuid":"u2","pri":"1","rep":"0","docs.count":"1","store.size":"100"},
            {"health":"red","status":"close","index":"old","uuid":"u3","pri":"2","rep":"0","docs.count":null,"store.size":null},
            {"health":"green","status":"open","index":"hid","uuid":"u4","pri":"1","rep":"0","docs.count":"0","store.size":"225"},
        ]);
        let hidden = json!({"hid": {"settings": {"index.hidden": "true"}}, "logs": {"settings": {}}});
        let aliases =
            json!([{"alias":"all","index":"old"},{"alias":"all","index":"logs"},{"alias":"cur","index":"logs"}]);
        let streams = json!({"data_streams": [{"name":"events","timestamp_field":{"name":"@timestamp"},
            "indices":[{"index_name":".ds-events-1"}],"status":"GREEN","hidden":false}]});
        let r = indices_of(&cat, &hidden, &aliases, &streams);
        let names: Vec<_> = r.indices.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, [".ds-events-1", "hid", "logs", "old"]);
        let logs = &r.indices[2];
        assert_eq!((logs.docs, logs.store_bytes, logs.primaries, logs.replicas), (4.0, 6553.0, 1, 1));
        assert_eq!(logs.aliases, ["all", "cur"]);
        assert!(!logs.hidden);
        assert!(r.indices[0].hidden && r.indices[1].hidden);
        assert_eq!(r.indices[0].data_stream.as_deref(), Some("events"));
        assert_eq!((r.indices[3].health.as_str(), r.indices[3].docs), ("", 0.0));
        assert_eq!(r.data_streams[0].status, "green");
        assert_eq!(r.aliases[0], EsAlias { name: "all".into(), indices: vec!["logs".into(), "old".into()] });
        // Optional answers missing.
        assert_eq!(indices_of(&cat, &Value::Null, &Value::Null, &Value::Null).indices.len(), 4);
    }

    #[test]
    fn flattens_field_caps() {
        let caps = json!({"indices": ["a", "b"], "fields": {
            "message": {"text": {"type":"text","metadata_field":false,"searchable":true,"aggregatable":false}},
            "message.keyword": {"keyword": {"type":"keyword","metadata_field":false,"searchable":true,"aggregatable":true}},
            "n": {"long": {"searchable":true,"aggregatable":true,"indices":["a"]},
                  "keyword": {"searchable":true,"aggregatable":true,"indices":["b"]},
                  "unmapped": {"searchable":false,"aggregatable":false}},
            "_id": {"_id": {"type":"_id","metadata_field":true,"searchable":true,"aggregatable":false}},
        }});
        let f = fields_of(&caps);
        let names: Vec<_> = f.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["_id", "message", "message.keyword", "n"]);
        assert!(f[0].metadata && !f[1].metadata);
        assert_eq!(f[3].types, ["keyword", "long"]);
        assert!(f[2].aggregatable && !f[1].aggregatable);
        // Before 7.13: no `metadata_field`, the `_` fields are metadata.
        assert!(fields_of(&json!({"fields": {"_index": {"_index": {"searchable": true}}}}))[0].metadata);
    }

    #[test]
    fn names_the_product() {
        let es = json!({"cluster_name":"c","version":{"number":"8.19.10","build_flavor":"default"}});
        assert_eq!(product(&es), ("elasticsearch".into(), "8.19.10".into()));
        let os = json!({"version":{"distribution":"opensearch","number":"2.17.0"}});
        assert_eq!(product_name(&product(&os).0), "OpenSearch");
        let c = cluster_of(&es, &json!({"status":"yellow","number_of_nodes":1,"unassigned_shards":1}), &Value::Null);
        assert_eq!((c.status.as_str(), c.nodes, c.unassigned_shards, c.indices), ("yellow", 1, 1, 0));
    }
}
