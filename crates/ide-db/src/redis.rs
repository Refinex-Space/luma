//! Redis data sources (and wire-compatible servers: Valkey, KeyDB, Dragonfly): a
//! key-value store browsed by database (`<id>:<index>` targets), keys found with
//! `SCAN`, values read a page at a time by type, written with plain commands, and a
//! console running `redis-cli`-style command lines on a connection of its own.
//!
//! Connections are multiplexed: one shared per target for browsing (with a response
//! timeout), one per target for its console (no timeout: blocking commands and
//! MULTI / EXEC stay there). SSH tunnels and passwords are the SQL data sources'.

use crate::{DataSource, DbDriver, DbManager, DbSslMode, split_target, through_tunnel};
use ide_core::error::ErrorKind;
use ide_core::{CancellationToken, IdeError, IdeResult};
use redis::aio::MultiplexedConnection;
use redis::{AsyncConnectionConfig, Client, ConnectionAddr, IntoConnectionInfo, RedisConnectionInfo, Value};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashSet;
use std::time::{Duration, Instant};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Browsing requests (scan, values, key info) give up after this.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
/// String values are read up to this size (`GETRANGE`); bigger ones are marked truncated.
pub const MAX_STRING_BYTES: usize = 1024 * 1024;
/// Keys one `redis_scan` call returns at most, and how long it keeps scanning for them.
const MAX_SCAN_KEYS: u32 = 10_000;
const SCAN_BUDGET: Duration = Duration::from_secs(2);

// ---- wire types -----------------------------------------------------------------------

/// A binary-safe string: UTF-8 text, else (`binary`) its bytes in hex.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RedisBytes {
    pub text: String,
    #[serde(default)]
    pub binary: bool,
}

impl RedisBytes {
    pub fn from_bytes(b: &[u8]) -> Self {
        match std::str::from_utf8(b) {
            Ok(s) => Self { text: s.to_owned(), binary: false },
            Err(_) => Self { text: hex(b), binary: true },
        }
    }

    pub fn text(s: impl Into<String>) -> Self {
        Self { text: s.into(), binary: false }
    }

    /// The bytes to send.
    pub fn bytes(&self) -> IdeResult<Vec<u8>> {
        if !self.binary {
            return Ok(self.text.as_bytes().to_vec());
        }
        let t = self.text.strip_prefix("0x").unwrap_or(&self.text);
        if !t.len().is_multiple_of(2) {
            return Err(IdeError::invalid("odd number of hex digits"));
        }
        (0..t.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&t[i..i + 2], 16).map_err(|_| IdeError::invalid("not hex")))
            .collect()
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// A server reply, as `redis-cli` shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RedisReply {
    Nil,
    /// `+OK`, `+PONG`.
    Status {
        text: String,
    },
    /// `-ERR …` inside an array (EXEC); a failed command is an outcome error instead.
    Error {
        text: String,
    },
    /// Integers as text: they may not fit a JavaScript number.
    Int {
        text: String,
    },
    Double {
        text: String,
    },
    Bool {
        value: bool,
    },
    Bulk {
        value: RedisBytes,
    },
    Array {
        items: Vec<RedisReply>,
    },
    Set {
        items: Vec<RedisReply>,
    },
    Map {
        entries: Vec<RedisEntry>,
    },
    /// RESP3 verbatim text (`txt`, `mkd`).
    Verbatim {
        format: String,
        text: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct RedisEntry {
    pub key: RedisReply,
    pub value: RedisReply,
}

impl From<Value> for RedisReply {
    fn from(v: Value) -> Self {
        match v {
            Value::Nil => RedisReply::Nil,
            Value::Okay => RedisReply::Status { text: "OK".into() },
            Value::SimpleString(text) => RedisReply::Status { text },
            Value::Int(i) => RedisReply::Int { text: i.to_string() },
            Value::Double(d) => RedisReply::Double { text: d.to_string() },
            Value::Boolean(value) => RedisReply::Bool { value },
            Value::BulkString(b) => RedisReply::Bulk { value: RedisBytes::from_bytes(&b) },
            Value::Array(items) => RedisReply::Array { items: items.into_iter().map(Into::into).collect() },
            Value::Set(items) => RedisReply::Set { items: items.into_iter().map(Into::into).collect() },
            Value::Map(pairs) => RedisReply::Map {
                entries: pairs.into_iter().map(|(k, v)| RedisEntry { key: k.into(), value: v.into() }).collect(),
            },
            Value::Attribute { data, .. } => (*data).into(),
            Value::VerbatimString { format, text } => RedisReply::Verbatim { format: format.to_string(), text },
            Value::BigNumber(n) => RedisReply::Int { text: String::from_utf8_lossy(&n).into_owned() },
            Value::Push { data, .. } => RedisReply::Array { items: data.into_iter().map(Into::into).collect() },
            Value::ServerError(e) => RedisReply::Error {
                text: match e.details() {
                    Some(d) => format!("{} {d}", e.code()),
                    None => e.code().to_owned(),
                },
            },
            _ => RedisReply::Nil,
        }
    }
}

/// A database of the server and its key counts (`INFO keyspace`).
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RedisDatabase {
    pub index: u32,
    pub keys: f64,
    pub expires: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyspace {
    /// Every database, empty ones included (`CONFIG GET databases`, else 16).
    pub databases: Vec<RedisDatabase>,
    /// `redis_version` (or the compatible server's).
    pub version: String,
    /// `standalone`, `cluster` or `sentinel`.
    pub mode: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyEntry {
    pub key: RedisBytes,
    /// `string`, `hash`, `list`, `set`, `zset`, `stream`, `ReJSON-RL`, … (`none`: gone meanwhile).
    pub kind: String,
    /// `PTTL` when scanned: milliseconds left, `-1` without expiry.
    pub ttl_ms: f64,
    /// `MEMORY USAGE` in bytes; `None` where the server refuses the command.
    pub memory: Option<f64>,
}

/// One `redis_scan` call: keys found, and the cursor to continue from (`0`: the end).
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RedisScanPage {
    pub cursor: String,
    pub keys: Vec<RedisKeyEntry>,
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyInfo {
    pub key: RedisBytes,
    pub kind: String,
    /// Milliseconds to live; -1 without expiry, -2 when the key is gone.
    pub ttl_ms: f64,
    /// Bytes of a string, entries of a collection.
    pub length: Option<f64>,
    /// `MEMORY USAGE` (may be refused by ACLs).
    pub memory: Option<f64>,
    /// `OBJECT ENCODING`: `listpack`, `hashtable`, `embstr`…
    pub encoding: Option<String>,
}

/// Which part of a value to read.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct RedisPageRequest {
    /// `SCAN`-style cursor (hash, set, zset with a pattern) or stream id to continue after.
    pub cursor: Option<String>,
    /// List / sorted set position.
    pub offset: u32,
    pub count: u32,
    /// `MATCH` pattern of hash fields, set or sorted set members.
    pub pattern: Option<String>,
    /// Sorted sets by descending score, streams newest first.
    pub descending: bool,
}

/// A page of a value as a table (hash: field, value; list: index, value; set: member;
/// zset: member, score; stream: id and the fields), or a whole string / JSON value.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RedisValuePage {
    pub kind: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<RedisBytes>>>,
    /// Where the next page starts (`None`: this was the last).
    pub cursor: Option<String>,
    pub offset: f64,
    /// Entries of the whole value, when cheap to know.
    pub total: Option<f64>,
    /// String and JSON values.
    pub value: Option<RedisBytes>,
    /// The string is longer than [`MAX_STRING_BYTES`]: `value` is its beginning.
    pub truncated: bool,
}

/// A Pub/Sub message (`SUBSCRIBE` / `PSUBSCRIBE`).
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RedisMessage {
    pub channel: RedisBytes,
    /// The pattern that matched, for pattern subscriptions.
    pub pattern: Option<String>,
    pub payload: RedisBytes,
    /// Received at (milliseconds since the epoch).
    pub time: f64,
}

/// A command line of a console, with its place in the text.
#[derive(Debug, Clone, PartialEq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RedisCommandInput {
    pub from: u32,
    pub to: u32,
    pub args: Vec<RedisBytes>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RedisCommandOutcome {
    pub from: u32,
    pub to: u32,
    /// The command as `redis-cli` would echo it.
    pub text: String,
    pub reply: Option<RedisReply>,
    pub error: Option<String>,
    pub elapsed_ms: f64,
    /// `SELECT n` ran: the console now works on database `n`.
    pub select: Option<u32>,
    /// The command may change data (not on the read-only list): views of keys reload.
    pub writes: bool,
}

// ---- errors ------------------------------------------------------------------------------

/// `ERR unknown command…`, `WRONGTYPE …`; failed authentication asks for the password.
pub(crate) fn redis_err(e: redis::RedisError) -> IdeError {
    let code = e.code().map(str::to_owned);
    let auth = matches!(e.kind(), redis::ErrorKind::AuthenticationFailed)
        || matches!(code.as_deref(), Some("NOAUTH" | "WRONGPASS" | "NOPERM" | "AUTH"));
    if auth {
        let msg = match (code.as_deref(), e.detail()) {
            (Some(c), Some(d)) => format!("{c} {d}"),
            _ => e.to_string(),
        };
        return IdeError::new(ErrorKind::PermissionDenied, msg);
    }
    if e.is_io_error() || e.is_timeout() || e.is_connection_dropped() || e.is_connection_refusal() {
        return IdeError::new(ErrorKind::Io, e.to_string());
    }
    match (code, e.detail()) {
        (Some(c), Some(d)) => IdeError::invalid(format!("{c} {d}")),
        (Some(c), None) => IdeError::invalid(c),
        _ => IdeError::new(ErrorKind::Protocol, e.to_string()),
    }
}

// ---- commands ------------------------------------------------------------------------------

/// Commands that only read: all a read-only data source runs.
const READ_COMMANDS: &[&str] = &[
    "APPEND_",
    "BITCOUNT",
    "BITFIELD_RO",
    "BITPOS",
    "CLIENT",
    "COMMAND",
    "CONFIG",
    "DBSIZE",
    "DUMP",
    "ECHO",
    "EXISTS",
    "EXPIRETIME",
    "FCALL_RO",
    "GEODIST",
    "GEOHASH",
    "GEOPOS",
    "GEORADIUS_RO",
    "GEORADIUSBYMEMBER_RO",
    "GEOSEARCH",
    "GET",
    "GETBIT",
    "GETRANGE",
    "HELLO",
    "HEXISTS",
    "HGET",
    "HGETALL",
    "HKEYS",
    "HLEN",
    "HMGET",
    "HRANDFIELD",
    "HSCAN",
    "HSTRLEN",
    "HVALS",
    "HTTL",
    "HPTTL",
    "INFO",
    "JSON.ARRLEN",
    "JSON.GET",
    "JSON.MGET",
    "JSON.OBJKEYS",
    "JSON.OBJLEN",
    "JSON.STRLEN",
    "JSON.TYPE",
    "KEYS",
    "LASTSAVE",
    "LATENCY",
    "LCS",
    "LINDEX",
    "LLEN",
    "LOLWUT",
    "LPOS",
    "LRANGE",
    "MEMORY",
    "MGET",
    "MODULE",
    "OBJECT",
    "PEXPIRETIME",
    "PFCOUNT",
    "PING",
    "PTTL",
    "PUBSUB",
    "RANDOMKEY",
    "ROLE",
    "SCAN",
    "SCARD",
    "SDIFF",
    "SINTER",
    "SINTERCARD",
    "SISMEMBER",
    "SLOWLOG",
    "SMEMBERS",
    "SMISMEMBER",
    "SRANDMEMBER",
    "SSCAN",
    "STRLEN",
    "SUBSTR",
    "SUNION",
    "TIME",
    "TOUCH",
    "TTL",
    "TYPE",
    "XINFO",
    "XLEN",
    "XPENDING",
    "XRANGE",
    "XREVRANGE",
    "ZCARD",
    "ZCOUNT",
    "ZDIFF",
    "ZINTER",
    "ZINTERCARD",
    "ZLEXCOUNT",
    "ZMSCORE",
    "ZRANDMEMBER",
    "ZRANGE",
    "ZRANGEBYLEX",
    "ZRANGEBYSCORE",
    "ZRANK",
    "ZREVRANGE",
    "ZREVRANGEBYLEX",
    "ZREVRANGEBYSCORE",
    "ZREVRANK",
    "ZSCAN",
    "ZSCORE",
    "ZUNION",
    "SELECT",
    "AUTH",
    "QUIT",
    "RESET",
];

/// Subcommands of read commands above that write (`CONFIG SET`, `CLIENT KILL`…).
const WRITING_SUBCOMMANDS: &[(&str, &str)] = &[
    ("CONFIG", "SET"),
    ("CONFIG", "RESETSTAT"),
    ("CONFIG", "REWRITE"),
    ("CLIENT", "KILL"),
    ("CLIENT", "PAUSE"),
    ("CLIENT", "NO-EVICT"),
    ("MEMORY", "PURGE"),
    ("MODULE", "LOAD"),
    ("MODULE", "LOADEX"),
    ("MODULE", "UNLOAD"),
    ("SLOWLOG", "RESET"),
    ("LATENCY", "RESET"),
    ("OBJECT", "FREQ_"),
];

/// Whether a read-only data source may run `args` (only reading commands).
pub fn is_read_only_command(args: &[RedisBytes]) -> bool {
    let Some(name) = args.first().map(|a| a.text.to_ascii_uppercase()) else { return true };
    if !READ_COMMANDS.contains(&name.as_str()) {
        return false;
    }
    let sub = args.get(1).map(|a| a.text.to_ascii_uppercase()).unwrap_or_default();
    !WRITING_SUBCOMMANDS.iter().any(|(c, s)| *c == name && *s == sub)
}

/// Commands that hold the connection: the console runs them, the browser never does.
const SUBSCRIBING: &[&str] = &["SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE", "MONITOR", "SYNC", "PSYNC"];

/// `redis-cli`'s echo of a command line: words as typed, quoted when needed.
pub fn command_text(args: &[RedisBytes]) -> String {
    args.iter()
        .map(|a| {
            if a.binary {
                let bytes = a.bytes().unwrap_or_default();
                return format!("\"{}\"", bytes.iter().map(|b| format!("\\x{b:02x}")).collect::<String>());
            }
            let t = &a.text;
            if !t.is_empty() && !t.chars().any(|c| c.is_whitespace() || matches!(c, '"' | '\'' | '\\')) {
                return t.clone();
            }
            let mut q = String::from("\"");
            for c in t.chars() {
                match c {
                    '"' => q.push_str("\\\""),
                    '\\' => q.push_str("\\\\"),
                    '\n' => q.push_str("\\n"),
                    '\r' => q.push_str("\\r"),
                    '\t' => q.push_str("\\t"),
                    c => q.push(c),
                }
            }
            q.push('"');
            q
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn cmd_of(args: &[RedisBytes]) -> IdeResult<redis::Cmd> {
    let (first, rest) = args.split_first().ok_or_else(|| IdeError::invalid("empty command"))?;
    let mut c = redis::cmd(&first.text);
    for a in rest {
        c.arg(a.bytes()?);
    }
    Ok(c)
}

/// The database index of a Redis target (`<id>:<index>`), else the data source's (`database`).
fn database_of(target: &str, source: &DataSource) -> IdeResult<i64> {
    let text = split_target(target).1.unwrap_or(source.database.trim());
    if text.is_empty() {
        return Ok(0);
    }
    text.parse::<i64>().map_err(|_| IdeError::invalid(format!("not a Redis database index: {text}")))
}

/// Installs rustls' ring provider once: the workspace builds rustls with two providers.
pub(crate) fn tls_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

pub(crate) fn expand_home(path: &str) -> std::path::PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => dirs_home().join(rest),
        None => std::path::PathBuf::from(path),
    }
}

fn dirs_home() -> std::path::PathBuf {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(Into::into).unwrap_or_default()
}

/// A client for `source` (already through its tunnel) on database `db`.
fn client(source: &DataSource, db: i64, password: Option<&str>) -> IdeResult<Client> {
    let host = source.host.trim().to_owned();
    let port = source.port.unwrap_or(6379);
    let tls = !matches!(source.ssl, DbSslMode::Disable | DbSslMode::Prefer);
    let addr = if tls {
        tls_provider();
        // Require: encrypted, certificate not checked; Verify CA: no host name check; Verify Full: both.
        ConnectionAddr::TcpTls { host, port, insecure: source.ssl == DbSslMode::Require, tls_params: None }
    } else {
        ConnectionAddr::Tcp(host, port)
    };
    let mut redis_info = RedisConnectionInfo::default().set_db(db);
    if !source.user.trim().is_empty() {
        redis_info = redis_info.set_username(source.user.trim());
    }
    if let Some(p) = password.filter(|p| !p.is_empty()) {
        redis_info = redis_info.set_password(p);
    }
    let info = addr.into_connection_info().map_err(redis_err)?.set_redis_settings(redis_info);
    let ca = source.ssl_ca_file.trim();
    let (cert, key) = (source.ssl_cert_file.trim(), source.ssl_key_file.trim());
    if tls && (!ca.is_empty() || (!cert.is_empty() && !key.is_empty())) {
        let read = |p: &str| std::fs::read(expand_home(p)).map_err(IdeError::from);
        let certs = redis::TlsCertificates {
            client_tls: if cert.is_empty() || key.is_empty() {
                None
            } else {
                Some(redis::ClientTlsConfig { client_cert: read(cert)?, client_key: read(key)? })
            },
            root_cert: if ca.is_empty() { None } else { Some(read(ca)?) },
        };
        let mut client = Client::build_with_tls(info, certs).map_err(redis_err)?;
        if source.ssl == DbSslMode::VerifyCa {
            // The CA is checked; the certificate may name another host (a tunnel, an IP).
            client = Client::open(client.get_connection_info().clone().set_addr(
                match client.get_connection_info().addr().clone() {
                    ConnectionAddr::TcpTls { host, port, tls_params, .. } => {
                        let mut a = ConnectionAddr::TcpTls { host, port, insecure: false, tls_params };
                        a.set_danger_accept_invalid_hostnames(true);
                        a
                    }
                    other => other,
                },
            ))
            .map_err(redis_err)?;
        }
        return Ok(client);
    }
    Client::open(info).map_err(redis_err)
}

async fn open(client: &Client, response_timeout: Option<Duration>) -> IdeResult<MultiplexedConnection> {
    let config = AsyncConnectionConfig::new()
        .set_connection_timeout(Some(CONNECT_TIMEOUT))
        .set_response_timeout(response_timeout);
    client.get_multiplexed_async_connection_with_config(&config).await.map_err(redis_err)
}

async fn query(conn: &mut MultiplexedConnection, c: &redis::Cmd) -> IdeResult<Value> {
    c.query_async::<Value>(conn).await.map_err(redis_err)
}

/// Runs `c` unless `cancel` fires first.
async fn query_cancellable(
    conn: &mut MultiplexedConnection,
    c: &redis::Cmd,
    cancel: &CancellationToken,
) -> IdeResult<Value> {
    tokio::select! {
        r = query(conn, c) => r,
        _ = cancel.cancelled() => Err(IdeError::cancelled()),
    }
}

fn as_string(v: &Value) -> Option<String> {
    match v {
        Value::BulkString(b) => Some(String::from_utf8_lossy(b).into_owned()),
        Value::SimpleString(s) => Some(s.clone()),
        Value::Okay => Some("OK".into()),
        Value::Int(i) => Some(i.to_string()),
        Value::Double(d) => Some(d.to_string()),
        Value::VerbatimString { text, .. } => Some(text.clone()),
        _ => None,
    }
}

fn as_bytes(v: &Value) -> Option<RedisBytes> {
    match v {
        Value::BulkString(b) => Some(RedisBytes::from_bytes(b)),
        Value::Nil => None,
        other => as_string(other).map(RedisBytes::text),
    }
}

fn as_i64(v: &Value) -> Option<i64> {
    match v {
        Value::Int(i) => Some(*i),
        other => as_string(other)?.parse().ok(),
    }
}

fn items(v: Value) -> Vec<Value> {
    match v {
        Value::Array(a) | Value::Set(a) => a,
        Value::Map(m) => m.into_iter().flat_map(|(k, v)| [k, v]).collect(),
        _ => Vec::new(),
    }
}

/// `SCAN`-family reply: the next cursor and the items.
fn scan_reply(v: Value) -> (String, Vec<Value>) {
    let mut it = items(v).into_iter();
    let cursor = it.next().as_ref().and_then(as_string).unwrap_or_else(|| "0".into());
    let found = it.next().map(items).unwrap_or_default();
    (cursor, found)
}

/// `key:value` lines of an `INFO` section.
pub fn info_fields(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter(|l| !l.starts_with('#'))
        .filter_map(|l| l.trim().split_once(':').map(|(k, v)| (k.to_owned(), v.to_owned())))
        .collect()
}

/// `db0:keys=12,expires=1,avg_ttl=0` → (0, 12, 1).
fn keyspace_line(k: &str, v: &str) -> Option<RedisDatabase> {
    let index = k.strip_prefix("db")?.parse().ok()?;
    let field = |name: &str| {
        v.split(',').find_map(|p| p.split_once('=').filter(|(k, _)| *k == name).and_then(|(_, n)| n.parse().ok()))
    };
    Some(RedisDatabase { index, keys: field("keys").unwrap_or(0.0), expires: field("expires").unwrap_or(0.0) })
}

/// A stream entry: its id and its fields in order.
type StreamEntry = (String, Vec<(String, Option<RedisBytes>)>);

/// The next stream id after `id` (`1700000000000-3` → `1700000000000-4`), for exclusive ranges before 6.2.
fn next_stream_id(id: &str, descending: bool) -> Option<String> {
    let (ms, seq) = id.split_once('-')?;
    let (ms, seq): (u64, u64) = (ms.parse().ok()?, seq.parse().ok()?);
    if descending {
        if seq > 0 {
            Some(format!("{ms}-{}", seq - 1))
        } else if ms > 0 {
            Some(format!("{}-{}", ms - 1, u64::MAX))
        } else {
            None
        }
    } else {
        Some(match seq.checked_add(1) {
            Some(s) => format!("{ms}-{s}"),
            None => format!("{}-0", ms + 1),
        })
    }
}

// ---- the manager ---------------------------------------------------------------------------

impl DbManager {
    /// Connects to Redis target `target` (`<id>` or `<id>:<db>`) through the data source's tunnel.
    async fn redis_open(&self, target: &str, response_timeout: Option<Duration>) -> IdeResult<MultiplexedConnection> {
        let source = self.source(target)?;
        if source.driver != DbDriver::Redis {
            return Err(IdeError::invalid(format!("{} is not a Redis data source", source.name)));
        }
        let db = database_of(target, &source)?;
        let password = self.password(&source).await;
        let (endpoint, tunnel) = self.endpoint(&source, None, true).await?;
        let label = tunnel.is_some().then(|| self.ssh_label(source.ssh.as_ref().expect("tunneled")));
        let c = client(&endpoint, db, password.as_deref())?;
        match open(&c, response_timeout).await {
            Ok(conn) => Ok(conn),
            Err(e) => {
                self.drop_unused_tunnel(split_target(target).0);
                Err(through_tunnel(e, &source, label.as_deref()))
            }
        }
    }

    /// Subscribes to `channels` and `patterns` on a connection of its own and hands each
    /// message to `on_message` until `cancel` fires (Pub/Sub view). Errors before the
    /// first subscription are returned; a dropped connection ends the subscription.
    pub async fn redis_subscribe(
        &self,
        target: &str,
        channels: &[String],
        patterns: &[String],
        on_message: impl Fn(RedisMessage) + Send,
        cancel: &CancellationToken,
    ) -> IdeResult<()> {
        use futures::StreamExt;
        if channels.is_empty() && patterns.is_empty() {
            return Err(IdeError::invalid("no channel or pattern to subscribe to"));
        }
        let source = self.source(target)?;
        let db = database_of(target, &source)?;
        let password = self.password(&source).await;
        let (endpoint, _tunnel) = self.endpoint(&source, None, true).await?;
        let c = client(&endpoint, db, password.as_deref())?;
        let mut pubsub = tokio::time::timeout(CONNECT_TIMEOUT, c.get_async_pubsub())
            .await
            .map_err(|_| IdeError::new(ErrorKind::Io, "timed out connecting to Redis"))?
            .map_err(redis_err)?;
        for ch in channels {
            pubsub.subscribe(ch).await.map_err(redis_err)?;
        }
        for p in patterns {
            pubsub.psubscribe(p).await.map_err(redis_err)?;
        }
        let mut stream = pubsub.on_message();
        loop {
            tokio::select! {
                m = stream.next() => match m {
                    Some(msg) => {
                        let time = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
                        let channel = match msg.get_channel::<Vec<u8>>() {
                            Ok(b) => RedisBytes::from_bytes(&b),
                            Err(_) => RedisBytes::text(msg.get_channel_name()),
                        };
                        on_message(RedisMessage {
                            channel,
                            pattern: msg.get_pattern::<Option<String>>().ok().flatten(),
                            payload: RedisBytes::from_bytes(msg.get_payload_bytes()),
                            time,
                        });
                    }
                    None => break,
                },
                _ = cancel.cancelled() => break,
            }
        }
        Ok(())
    }

    /// The shared browsing connection of `target`, connecting first if needed.
    pub async fn redis(&self, target: &str) -> IdeResult<MultiplexedConnection> {
        if let Some(c) = self.redis_conns.lock().get(target) {
            return Ok(c.clone());
        }
        let conn = self.redis_open(target, Some(RESPONSE_TIMEOUT)).await?;
        Ok(self.redis_conns.lock().entry(target.to_owned()).or_insert(conn).clone())
    }

    /// Test Connection of a Redis data source: the server and its version.
    pub(crate) async fn redis_test(
        &self,
        source: &DataSource,
        password: Option<String>,
        ssh_secret: Option<String>,
    ) -> IdeResult<String> {
        let (endpoint, tunnel) = self.endpoint(source, ssh_secret, false).await?;
        let label = tunnel.is_some().then(|| self.ssh_label(source.ssh.as_ref().expect("tunneled")));
        let db = database_of(&source.id, source)?;
        let c = client(&endpoint, db, password.as_deref())?;
        let mut conn =
            open(&c, Some(RESPONSE_TIMEOUT)).await.map_err(|e| through_tunnel(e, source, label.as_deref()))?;
        let info = query(&mut conn, redis::cmd("INFO").arg("server")).await?;
        let fields = info_fields(&as_string(&info).unwrap_or_default());
        let get = |k: &str| fields.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        let product = if get("valkey_version").is_some() { "Valkey" } else { "Redis" };
        let version = get("valkey_version").or_else(|| get("redis_version")).unwrap_or_default();
        let mode = get("redis_mode").unwrap_or_else(|| "standalone".into());
        Ok(format!("{product} {version} ({mode})"))
    }

    /// Databases of the server of `id` with their key counts, the server's version and mode.
    pub async fn redis_keyspace(&self, id: &str) -> IdeResult<RedisKeyspace> {
        let source_id = split_target(id).0;
        let mut conn = self.redis(source_id).await?;
        let server = as_string(&query(&mut conn, redis::cmd("INFO").arg("server")).await?).unwrap_or_default();
        let keyspace = as_string(&query(&mut conn, redis::cmd("INFO").arg("keyspace")).await?).unwrap_or_default();
        let server = info_fields(&server);
        let get = |k: &str| server.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        let mode = get("redis_mode").unwrap_or_else(|| "standalone".into());
        let version = get("valkey_version").or_else(|| get("redis_version")).unwrap_or_default();
        let used: Vec<RedisDatabase> = info_fields(&keyspace).iter().filter_map(|(k, v)| keyspace_line(k, v)).collect();
        // Managed servers may refuse CONFIG; a cluster has only database 0.
        let count = if mode == "cluster" {
            1
        } else {
            match query(&mut conn, redis::cmd("CONFIG").arg("GET").arg("databases")).await {
                Ok(v) => items(v).get(1).and_then(as_i64).unwrap_or(16) as u32,
                Err(_) => 16,
            }
        };
        let count = count.max(used.iter().map(|d| d.index + 1).max().unwrap_or(0));
        let databases = (0..count)
            .map(|i| {
                used.iter().find(|d| d.index == i).cloned().unwrap_or(RedisDatabase {
                    index: i,
                    keys: 0.0,
                    expires: 0.0,
                })
            })
            .collect();
        Ok(RedisKeyspace { databases, version, mode })
    }

    /// Keys of `target` matching `pattern` (and of type `kind`), from `cursor`, at most `limit`.
    pub async fn redis_scan(
        &self,
        target: &str,
        pattern: &str,
        kind: Option<&str>,
        cursor: &str,
        limit: u32,
    ) -> IdeResult<RedisScanPage> {
        let mut conn = self.redis(target).await?;
        let limit = limit.clamp(1, MAX_SCAN_KEYS) as usize;
        let pattern = if pattern.is_empty() { "*" } else { pattern };
        let started = Instant::now();
        let mut cursor = cursor.to_owned();
        let mut keys: Vec<Vec<u8>> = Vec::new();
        let mut typed = kind.is_some();
        loop {
            let mut c = redis::cmd("SCAN");
            c.arg(&cursor).arg("MATCH").arg(pattern).arg("COUNT").arg(1000);
            if typed && let Some(k) = kind {
                c.arg("TYPE").arg(k);
            }
            let reply = match query(&mut conn, &c).await {
                Ok(r) => r,
                // SCAN … TYPE needs Redis 6: filter by hand on older servers.
                Err(_) if typed => {
                    typed = false;
                    continue;
                }
                Err(e) => return Err(e),
            };
            let (next, found) = scan_reply(reply);
            keys.extend(found.into_iter().filter_map(|v| match v {
                Value::BulkString(b) => Some(b),
                other => as_string(&other).map(String::into_bytes),
            }));
            cursor = next;
            if cursor == "0" || keys.len() >= limit || started.elapsed() > SCAN_BUDGET {
                break;
            }
        }
        // Type and time to live of each key in one round trip, their memory in another:
        // managed servers may refuse `MEMORY`, which leaves sizes unknown, not the page.
        let mut kinds = Vec::with_capacity(keys.len());
        let mut ttls = Vec::with_capacity(keys.len());
        let mut memory = vec![None; keys.len()];
        if !keys.is_empty() {
            let mut pipe = redis::pipe();
            for k in &keys {
                pipe.cmd("TYPE").arg(k.as_slice()).cmd("PTTL").arg(k.as_slice());
            }
            let replies: Vec<Value> = pipe.query_async(&mut conn).await.map_err(redis_err)?;
            for pair in replies.chunks(2) {
                kinds.push(pair.first().and_then(as_string).unwrap_or_else(|| "none".into()));
                ttls.push(pair.get(1).and_then(as_i64).unwrap_or(-1) as f64);
            }
            let mut pipe = redis::pipe();
            pipe.ignore_errors();
            for k in &keys {
                pipe.cmd("MEMORY").arg("USAGE").arg(k.as_slice());
            }
            if let Ok(replies) = pipe.query_async::<Vec<Value>>(&mut conn).await {
                memory = replies.iter().map(|v| as_i64(v).map(|n| n as f64)).collect();
                memory.resize(keys.len(), None);
            }
        }
        let mut entries: Vec<RedisKeyEntry> = keys
            .iter()
            .zip(kinds)
            .zip(ttls.into_iter().zip(memory))
            .filter(|((_, t), _)| t != "none" && kind.is_none_or(|k| k.eq_ignore_ascii_case(t)))
            .map(|((k, t), (ttl_ms, memory))| RedisKeyEntry { key: RedisBytes::from_bytes(k), kind: t, ttl_ms, memory })
            .collect();
        // SCAN may return a key twice across calls (rehashing); one call lists it once.
        let mut seen = HashSet::new();
        entries.retain(|e| seen.insert(e.key.clone()));
        Ok(RedisScanPage { done: cursor == "0", cursor, keys: entries })
    }

    /// Type, time to live, length, memory and encoding of `key`.
    pub async fn redis_key_info(&self, target: &str, key: &RedisBytes) -> IdeResult<RedisKeyInfo> {
        let mut conn = self.redis(target).await?;
        let k = key.bytes()?;
        let kind = as_string(&query(&mut conn, redis::cmd("TYPE").arg(&k)).await?).unwrap_or_else(|| "none".into());
        let ttl_ms = as_i64(&query(&mut conn, redis::cmd("PTTL").arg(&k)).await?).unwrap_or(-2) as f64;
        let len_cmd = match kind.as_str() {
            "string" => Some("STRLEN"),
            "hash" => Some("HLEN"),
            "list" => Some("LLEN"),
            "set" => Some("SCARD"),
            "zset" => Some("ZCARD"),
            "stream" => Some("XLEN"),
            _ => None,
        };
        let length = match len_cmd {
            Some(c) => query(&mut conn, redis::cmd(c).arg(&k)).await.ok().as_ref().and_then(as_i64).map(|n| n as f64),
            None => None,
        };
        let memory = query(&mut conn, redis::cmd("MEMORY").arg("USAGE").arg(&k).arg("SAMPLES").arg(0))
            .await
            .ok()
            .as_ref()
            .and_then(as_i64)
            .map(|n| n as f64);
        let encoding =
            query(&mut conn, redis::cmd("OBJECT").arg("ENCODING").arg(&k)).await.ok().as_ref().and_then(as_string);
        Ok(RedisKeyInfo { key: key.clone(), kind, ttl_ms, length, memory, encoding })
    }

    /// A page of the value of `key` (of type `kind`).
    pub async fn redis_value(
        &self,
        target: &str,
        key: &RedisBytes,
        kind: &str,
        page: &RedisPageRequest,
    ) -> IdeResult<RedisValuePage> {
        let mut conn = self.redis(target).await?;
        let k = key.bytes()?;
        let count = page.count.clamp(1, 10_000);
        let mut out = RedisValuePage {
            kind: kind.to_owned(),
            columns: Vec::new(),
            rows: Vec::new(),
            cursor: None,
            offset: page.offset as f64,
            total: None,
            value: None,
            truncated: false,
        };
        let pattern = page.pattern.as_deref().filter(|p| !p.is_empty() && *p != "*");
        // HSCAN / SSCAN / ZSCAN pages: the items of up to `count`, from the cursor.
        let scan = |conn: &mut MultiplexedConnection, cmd: &'static str| {
            let k = k.clone();
            let mut cursor = page.cursor.clone().unwrap_or_else(|| "0".into());
            let pattern = pattern.map(str::to_owned);
            let mut conn = conn.clone();
            async move {
                let mut found = Vec::new();
                let started = Instant::now();
                loop {
                    let mut c = redis::cmd(cmd);
                    c.arg(&k).arg(&cursor).arg("COUNT").arg(count);
                    if let Some(p) = &pattern {
                        c.arg("MATCH").arg(p);
                    }
                    let (next, items) = scan_reply(query(&mut conn, &c).await?);
                    found.extend(items);
                    cursor = next;
                    if cursor == "0" || found.len() >= count as usize || started.elapsed() > SCAN_BUDGET {
                        break;
                    }
                }
                IdeResult::Ok((found, (cursor != "0").then_some(cursor)))
            }
        };
        match kind {
            "string" => {
                let len = as_i64(&query(&mut conn, redis::cmd("STRLEN").arg(&k)).await?).unwrap_or(0);
                let v =
                    query(&mut conn, redis::cmd("GETRANGE").arg(&k).arg(0).arg(MAX_STRING_BYTES as i64 - 1)).await?;
                out.value = as_bytes(&v);
                out.truncated = len as usize > MAX_STRING_BYTES;
                out.total = Some(len as f64);
            }
            "ReJSON-RL" => {
                let v = query(&mut conn, redis::cmd("JSON.GET").arg(&k)).await?;
                out.value = as_bytes(&v);
            }
            "hash" => {
                out.columns = vec!["field".into(), "value".into()];
                out.total =
                    query(&mut conn, redis::cmd("HLEN").arg(&k)).await.ok().as_ref().and_then(as_i64).map(|n| n as f64);
                let (found, next) = scan(&mut conn, "HSCAN").await?;
                out.rows =
                    found.chunks(2).map(|p| vec![p.first().and_then(as_bytes), p.get(1).and_then(as_bytes)]).collect();
                out.cursor = next;
            }
            "set" => {
                out.columns = vec!["member".into()];
                out.total = query(&mut conn, redis::cmd("SCARD").arg(&k))
                    .await
                    .ok()
                    .as_ref()
                    .and_then(as_i64)
                    .map(|n| n as f64);
                let (found, next) = scan(&mut conn, "SSCAN").await?;
                out.rows = found.iter().map(|m| vec![as_bytes(m)]).collect();
                out.cursor = next;
            }
            "list" => {
                out.columns = vec!["index".into(), "value".into()];
                let total = as_i64(&query(&mut conn, redis::cmd("LLEN").arg(&k)).await?).unwrap_or(0);
                out.total = Some(total as f64);
                let start = page.offset as i64;
                let end = start + count as i64 - 1;
                let values = items(query(&mut conn, redis::cmd("LRANGE").arg(&k).arg(start).arg(end)).await?);
                out.rows = values
                    .iter()
                    .enumerate()
                    .map(|(i, v)| vec![Some(RedisBytes::text((start + i as i64).to_string())), as_bytes(v)])
                    .collect();
                if end + 1 < total {
                    out.cursor = Some((end + 1).to_string());
                }
            }
            "zset" => {
                out.columns = vec!["member".into(), "score".into()];
                let total = as_i64(&query(&mut conn, redis::cmd("ZCARD").arg(&k)).await?).unwrap_or(0);
                out.total = Some(total as f64);
                if pattern.is_some() {
                    let (found, next) = scan(&mut conn, "ZSCAN").await?;
                    out.rows = found
                        .chunks(2)
                        .map(|p| vec![p.first().and_then(as_bytes), p.get(1).and_then(as_bytes)])
                        .collect();
                    out.cursor = next;
                } else {
                    let start = page.offset as i64;
                    let end = start + count as i64 - 1;
                    let cmd = if page.descending { "ZREVRANGE" } else { "ZRANGE" };
                    let values =
                        items(query(&mut conn, redis::cmd(cmd).arg(&k).arg(start).arg(end).arg("WITHSCORES")).await?);
                    out.rows = values
                        .chunks(2)
                        .map(|p| vec![p.first().and_then(as_bytes), p.get(1).and_then(as_bytes)])
                        .collect();
                    if end + 1 < total {
                        out.cursor = Some((end + 1).to_string());
                    }
                }
            }
            "stream" => {
                out.total =
                    query(&mut conn, redis::cmd("XLEN").arg(&k)).await.ok().as_ref().and_then(as_i64).map(|n| n as f64);
                let (cmd, from, to) = match (page.descending, page.cursor.as_deref()) {
                    (false, Some(c)) => ("XRANGE", c.to_owned(), "+".to_owned()),
                    (false, None) => ("XRANGE", "-".to_owned(), "+".to_owned()),
                    (true, Some(c)) => ("XREVRANGE", c.to_owned(), "-".to_owned()),
                    (true, None) => ("XREVRANGE", "+".to_owned(), "-".to_owned()),
                };
                // One more than a page tells whether another follows.
                let entries = items(
                    query(&mut conn, redis::cmd(cmd).arg(&k).arg(&from).arg(&to).arg("COUNT").arg(count + 1)).await?,
                );
                let mut columns: Vec<String> = vec!["id".into()];
                let mut parsed: Vec<StreamEntry> = Vec::new();
                for e in entries.into_iter().take(count as usize + 1) {
                    let mut parts = items(e).into_iter();
                    let id = parts.next().as_ref().and_then(as_string).unwrap_or_default();
                    let fields = parts.next().map(items).unwrap_or_default();
                    let pairs: Vec<(String, Option<RedisBytes>)> = fields
                        .chunks(2)
                        .map(|p| (p.first().and_then(as_string).unwrap_or_default(), p.get(1).and_then(as_bytes)))
                        .collect();
                    for (f, _) in &pairs {
                        if !columns.contains(f) {
                            columns.push(f.clone());
                        }
                    }
                    parsed.push((id, pairs));
                }
                if parsed.len() > count as usize {
                    let last = parsed[count as usize - 1].0.clone();
                    parsed.truncate(count as usize);
                    out.cursor = next_stream_id(&last, page.descending);
                }
                out.rows = parsed
                    .into_iter()
                    .map(|(id, pairs)| {
                        let mut row = vec![Some(RedisBytes::text(id))];
                        for c in &columns[1..] {
                            row.push(pairs.iter().find(|(f, _)| f == c).and_then(|(_, v)| v.clone()));
                        }
                        row
                    })
                    .collect();
                out.columns = columns;
            }
            _ => {}
        }
        Ok(out)
    }

    fn redis_guard(&self, target: &str, args: &[RedisBytes]) -> IdeResult<()> {
        if self.source(target)?.read_only && !is_read_only_command(args) {
            return Err(IdeError::new(
                ErrorKind::PermissionDenied,
                format!(
                    "the data source is read-only: {} is not allowed",
                    args.first().map(|a| a.text.as_str()).unwrap_or("")
                ),
            ));
        }
        Ok(())
    }

    /// Runs one command on the browsing connection of `target` (the key editor's writes).
    pub async fn redis_command(&self, target: &str, args: &[RedisBytes]) -> IdeResult<RedisReply> {
        self.redis_guard(target, args)?;
        let mut conn = self.redis(target).await?;
        Ok(query(&mut conn, &cmd_of(args)?).await?.into())
    }

    /// Runs `commands` atomically (MULTI / EXEC): a key editor's Submit.
    pub async fn redis_transaction(&self, target: &str, commands: &[Vec<RedisBytes>]) -> IdeResult<Vec<RedisReply>> {
        for c in commands {
            self.redis_guard(target, c)?;
        }
        if commands.is_empty() {
            return Ok(Vec::new());
        }
        let mut conn = self.redis(target).await?;
        let mut pipe = redis::pipe();
        pipe.atomic();
        for c in commands {
            pipe.add_command(cmd_of(c)?);
        }
        let replies: Vec<Value> = pipe.query_async(&mut conn).await.map_err(redis_err)?;
        Ok(replies.into_iter().map(Into::into).collect())
    }

    /// The console connection of `target`: its own, without a response timeout.
    async fn redis_console(&self, target: &str) -> IdeResult<MultiplexedConnection> {
        if let Some(c) = self.redis_consoles.lock().get(target) {
            return Ok(c.clone());
        }
        let conn = self.redis_open(target, None).await?;
        Ok(self.redis_consoles.lock().entry(target.to_owned()).or_insert(conn).clone())
    }

    /// Runs console command lines on `target` in order, stopping at the first error,
    /// recording them in the query history.
    pub async fn redis_execute(
        &self,
        target: &str,
        commands: &[RedisCommandInput],
        cancel: &CancellationToken,
    ) -> IdeResult<Vec<RedisCommandOutcome>> {
        let mut out = Vec::new();
        for c in commands {
            let text = command_text(&c.args);
            let name = c.args.first().map(|a| a.text.to_ascii_uppercase()).unwrap_or_default();
            let started = Instant::now();
            let mut outcome = RedisCommandOutcome {
                from: c.from,
                to: c.to,
                text: text.clone(),
                reply: None,
                error: None,
                elapsed_ms: 0.0,
                select: None,
                writes: !is_read_only_command(&c.args),
            };
            let result: IdeResult<RedisReply> = async {
                self.redis_guard(target, &c.args)?;
                if SUBSCRIBING.contains(&name.as_str()) {
                    return Err(IdeError::invalid(format!(
                        "{name} keeps the connection listening: use Pub/Sub in the Redis tool window"
                    )));
                }
                // SELECT moves the console to another database (its own connection there).
                if name == "SELECT" {
                    let n: u32 = c
                        .args
                        .get(1)
                        .and_then(|a| a.text.parse().ok())
                        .ok_or_else(|| IdeError::invalid("ERR value is not an integer or out of range"))?;
                    let other = format!("{}:{n}", split_target(target).0);
                    let mut conn = self.redis_console(&other).await?;
                    query(&mut conn, &redis::cmd("PING")).await?;
                    outcome.select = Some(n);
                    return Ok(RedisReply::Status { text: "OK".into() });
                }
                let mut conn = self.redis_console(target).await?;
                let r = query_cancellable(&mut conn, &cmd_of(&c.args)?, cancel).await;
                if name == "QUIT" || name == "RESET" || r.as_ref().is_err_and(|e| e.kind == ErrorKind::Cancelled) {
                    // A cancelled (maybe blocking) command leaves the connection busy: start over.
                    self.redis_consoles.lock().remove(target);
                }
                Ok(r?.into())
            }
            .await;
            outcome.elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
            match result {
                Ok(reply) => outcome.reply = Some(reply),
                Err(e) if e.kind == ErrorKind::Cancelled => return Err(e),
                Err(e) if e.kind == ErrorKind::PermissionDenied && out.is_empty() && e.message.contains("NOAUTH") => {
                    return Err(e);
                }
                Err(e) => outcome.error = Some(e.message),
            }
            self.remember_redis(target, &text);
            let failed = outcome.error.is_some();
            out.push(outcome);
            if failed {
                break;
            }
        }
        Ok(out)
    }

    fn remember_redis(&self, target: &str, text: &str) {
        let time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
        let _ = self.recorder.send((split_target(target).0.to_owned(), text.to_owned(), time));
    }

    /// Deletes every key of `target` matching `pattern` (`UNLINK` in batches); the count.
    pub async fn redis_delete_matching(
        &self,
        target: &str,
        pattern: &str,
        cancel: &CancellationToken,
    ) -> IdeResult<f64> {
        self.redis_guard(target, &[RedisBytes::text("UNLINK")])?;
        if pattern.trim().is_empty() {
            return Err(IdeError::invalid("a pattern is required"));
        }
        let mut conn = self.redis(target).await?;
        let mut cursor = "0".to_owned();
        let mut deleted = 0i64;
        loop {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            let c = redis::cmd("SCAN").arg(&cursor).arg("MATCH").arg(pattern).arg("COUNT").arg(1000).clone();
            let (next, found) = scan_reply(query(&mut conn, &c).await?);
            if !found.is_empty() {
                let mut del = redis::cmd("UNLINK");
                for k in &found {
                    if let Value::BulkString(b) = k {
                        del.arg(b.as_slice());
                    }
                }
                deleted += as_i64(&query(&mut conn, &del).await?).unwrap_or(0);
            }
            cursor = next;
            if cursor == "0" {
                break;
            }
        }
        Ok(deleted as f64)
    }

    /// `INFO` (all sections, or `section`) of the server of `id`.
    pub async fn redis_info(&self, id: &str, section: Option<&str>) -> IdeResult<String> {
        let mut conn = self.redis(split_target(id).0).await?;
        let mut c = redis::cmd("INFO");
        if let Some(s) = section {
            c.arg(s);
        } else {
            c.arg("everything");
        }
        let v = match query(&mut conn, &c).await {
            Ok(v) => v,
            // `INFO everything` is Redis 7; older servers know `INFO all`.
            Err(_) if section.is_none() => query(&mut conn, redis::cmd("INFO").arg("all")).await?,
            Err(e) => return Err(e),
        };
        Ok(as_string(&v).unwrap_or_default())
    }

    /// Drops the Redis connections of `target` (all databases for a data source id).
    pub(crate) fn redis_disconnect(&self, target: &str) {
        let whole = split_target(target).1.is_none();
        let of_target = |k: &String| k == target || (whole && split_target(k).0 == target);
        self.redis_conns.lock().retain(|k, _| !of_target(k));
        self.redis_consoles.lock().retain(|k, _| !of_target(k));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_round_trip_and_binary() {
        assert_eq!(RedisBytes::from_bytes(b"user:1"), RedisBytes::text("user:1"));
        let bin = RedisBytes::from_bytes(&[0xff, 0x00, 0x10]);
        assert_eq!(bin, RedisBytes { text: "ff0010".into(), binary: true });
        assert_eq!(bin.bytes().unwrap(), vec![0xff, 0x00, 0x10]);
    }

    #[test]
    fn read_only_commands() {
        let a = |s: &str| s.split(' ').map(RedisBytes::text).collect::<Vec<_>>();
        assert!(is_read_only_command(&a("GET k")));
        assert!(is_read_only_command(&a("hgetall k")));
        assert!(is_read_only_command(&a("CONFIG GET maxmemory")));
        assert!(!is_read_only_command(&a("CONFIG SET maxmemory 1")));
        assert!(!is_read_only_command(&a("SET k v")));
        assert!(!is_read_only_command(&a("FLUSHALL")));
        assert!(!is_read_only_command(&a("CLIENT KILL ID 3")));
    }

    #[test]
    fn echoes_commands_like_redis_cli() {
        let args = vec![RedisBytes::text("SET"), RedisBytes::text("greeting"), RedisBytes::text("hello world\n")];
        assert_eq!(command_text(&args), r#"SET greeting "hello world\n""#);
        let bin = vec![RedisBytes::text("GET"), RedisBytes { text: "ff01".into(), binary: true }];
        assert_eq!(command_text(&bin), r#"GET "\xff\x01""#);
    }

    #[test]
    fn parses_info_and_keyspace() {
        let text = "# Keyspace\r\ndb0:keys=12,expires=1,avg_ttl=0\r\ndb3:keys=5,expires=0,avg_ttl=0\r\n";
        let dbs: Vec<_> = info_fields(text).iter().filter_map(|(k, v)| keyspace_line(k, v)).collect();
        assert_eq!(
            dbs,
            vec![
                RedisDatabase { index: 0, keys: 12.0, expires: 1.0 },
                RedisDatabase { index: 3, keys: 5.0, expires: 0.0 },
            ]
        );
    }

    #[test]
    fn stream_ids_step() {
        assert_eq!(next_stream_id("1700-3", false).as_deref(), Some("1700-4"));
        assert_eq!(next_stream_id("1700-0", true).as_deref(), Some("1699-18446744073709551615"));
        assert_eq!(next_stream_id("1700-3", true).as_deref(), Some("1700-2"));
    }

    #[test]
    fn replies_keep_binary_and_errors() {
        let v = Value::Array(vec![Value::Int(3), Value::BulkString(vec![0xff]), Value::Nil]);
        assert_eq!(
            RedisReply::from(v),
            RedisReply::Array {
                items: vec![
                    RedisReply::Int { text: "3".into() },
                    RedisReply::Bulk { value: RedisBytes { text: "ff".into(), binary: true } },
                    RedisReply::Nil,
                ]
            }
        );
    }
}
