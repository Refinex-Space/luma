//! Elasticsearch data sources against a real server, skipped unless
//! `LUMA_TEST_ES=http://host:9200` names a throwaway one (`LUMA_TEST_ES_USER` and
//! `LUMA_TEST_ES_PASSWORD` for security-enabled clusters). The tests create indices,
//! templates, data streams and API keys named `luma-test-…` and delete them again.

use futures::FutureExt;
use ide_core::error::ErrorKind;
use ide_core::{CancellationToken, IdeResult};
use ide_db::{DataSource, DbDriver, DbManager, DbSslMode, EsResponse};
use serde_json::Value;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::time::{Duration, Instant};

const ID: &str = "es";

struct Server {
    host: String,
    port: u16,
    tls: bool,
    user: String,
    password: String,
}

fn server() -> Option<Server> {
    let url = std::env::var("LUMA_TEST_ES").ok()?;
    let (scheme, rest) = url.trim().trim_end_matches('/').split_once("://")?;
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) => (h.to_owned(), p.parse().ok()?),
        None => (rest.to_owned(), 9200),
    };
    Some(Server {
        host,
        port,
        tls: scheme.eq_ignore_ascii_case("https"),
        user: std::env::var("LUMA_TEST_ES_USER").unwrap_or_default(),
        password: std::env::var("LUMA_TEST_ES_PASSWORD").unwrap_or_default(),
    })
}

/// A manager with data source `es` on the test server, `edit` applied, and `password`
/// (the server's when `None`).
async fn manager(
    tmp: &tempfile::TempDir,
    edit: impl FnOnce(&mut DataSource),
    password: Option<String>,
) -> Option<DbManager> {
    let s = server()?;
    let root = tmp.path().to_path_buf();
    let ssh = std::sync::Arc::new(ide_ssh::SshManager::new(root.join("ssh-passwords.json")));
    let db = DbManager::new(root.clone(), root.join("passwords.json"), root.join("history.json"), ssh);
    let mut source = DataSource {
        id: ID.into(),
        name: "elasticsearch".into(),
        driver: DbDriver::Elasticsearch,
        host: s.host,
        port: Some(s.port),
        user: s.user,
        // Plain HTTP servers go through Prefer's fallback from HTTPS.
        ssl: if s.tls { DbSslMode::Require } else { DbSslMode::Prefer },
        ..Default::default()
    };
    edit(&mut source);
    db.save_sources(vec![source]).await.unwrap();
    db.set_password(ID, Some(password.unwrap_or(s.password)), false).await.unwrap();
    Some(db)
}

/// A name of this run: tests of other runs (and of this one) do not collide.
fn name(what: &str) -> String {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() % 1_000_000_000;
    format!("luma-test-{what}-{}-{n}", std::process::id())
}

async fn req(db: &DbManager, method: &str, path: &str, body: Option<&str>) -> IdeResult<EsResponse> {
    db.es_request(ID, method, path, body, &CancellationToken::new()).await
}

/// `req`, expecting a 2xx answer, as JSON.
async fn ok(db: &DbManager, method: &str, path: &str, body: Option<&str>) -> Value {
    let r = req(db, method, path, body).await.unwrap();
    assert!((200..300).contains(&r.status), "{method} {path}: {} {}", r.status, r.body);
    serde_json::from_str(&r.body).unwrap_or(Value::Null)
}

/// Runs `body`, then `cleanup` even when `body` failed or panicked.
async fn with_cleanup<C: Future<Output = ()>>(
    body: impl Future<Output = IdeResult<()>>,
    cleanup: impl FnOnce() -> C,
) -> IdeResult<()> {
    let r = AssertUnwindSafe(body).catch_unwind().await;
    cleanup().await;
    match r {
        Ok(r) => r,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

#[tokio::test]
async fn connects_browses_and_requests() -> IdeResult<()> {
    let tmp = tempfile::tempdir().unwrap();
    let Some(db) = manager(&tmp, |_| {}, None).await else { return Ok(()) };
    let (index, alias, stream, template) = (name("idx"), name("alias"), name("ds"), name("tpl"));
    let body = async {
        let version = db.test(&db.source(ID)?, None, None).await?;
        assert!(version.starts_with("Elasticsearch ") || version.starts_with("OpenSearch "), "{version}");

        db.elastic(ID).await?;
        assert!(db.is_connected(ID));
        assert!(db.connected().contains(&ID.to_owned()));

        let mapping = r#"{"settings":{"number_of_replicas":0},"mappings":{"properties":{
            "title":{"type":"text","fields":{"keyword":{"type":"keyword"}}},
            "published":{"type":"date"},"views":{"type":"long"},"tags":{"type":"keyword"}}}}"#;
        ok(&db, "PUT", &index, Some(mapping)).await;
        // NDJSON without the trailing newline `_bulk` insists on.
        let bulk = [
            r#"{"index":{"_id":"1"}}"#,
            r#"{"title":"The quick brown fox","published":"2026-01-01","views":10,"tags":["a"]}"#,
            r#"{"index":{"_id":"2"}}"#,
            r#"{"title":"A lazy dog","published":"2026-01-02","views":3,"tags":["b"]}"#,
            r#"{"index":{"_id":"3"}}"#,
            r#"{"title":"Quick thinking","published":"2026-01-03","views":7,"tags":["a","b"]}"#,
        ]
        .join("\n");
        let r = ok(&db, "POST", &format!("/{index}/_bulk?refresh=wait_for"), Some(&bulk)).await;
        assert_eq!(r["errors"], Value::Bool(false), "{r}");
        let actions = format!(r#"{{"actions":[{{"add":{{"index":"{index}","alias":"{alias}"}}}}]}}"#);
        ok(&db, "POST", "/_aliases", Some(&actions)).await;
        let tpl = format!(
            r#"{{"index_patterns":["{stream}*"],"data_stream":{{}},"priority":500,
                "template":{{"settings":{{"number_of_replicas":0}}}}}}"#
        );
        ok(&db, "PUT", &format!("/_index_template/{template}"), Some(&tpl)).await;
        ok(
            &db,
            "POST",
            &format!("/{stream}/_doc?refresh=wait_for"),
            Some(r#"{"@timestamp":"2026-01-01T00:00:00Z","msg":"hi"}"#),
        )
        .await;

        // The tree: the index with its docs, size and alias; the data stream and its backing index.
        let all = db.es_indices(ID).await?;
        let idx = all.indices.iter().find(|i| i.name == index).expect("index listed");
        assert_eq!((idx.status.as_str(), idx.health.as_str(), idx.docs), ("open", "green", 3.0));
        assert!(idx.store_bytes > 0.0 && !idx.hidden && idx.data_stream.is_none());
        assert_eq!((idx.primaries, idx.replicas), (1, 0));
        assert_eq!(idx.aliases, std::slice::from_ref(&alias));
        let a = all.aliases.iter().find(|a| a.name == alias).expect("alias listed");
        assert_eq!(a.indices, std::slice::from_ref(&index));
        let ds = all.data_streams.iter().find(|d| d.name == stream).expect("data stream listed");
        assert_eq!((ds.timestamp_field.as_str(), ds.indices.len(), ds.hidden), ("@timestamp", 1, false));
        let backing = all.indices.iter().find(|i| i.name == ds.indices[0]).expect("backing index listed");
        assert_eq!(backing.data_stream.as_deref(), Some(stream.as_str()));
        assert!(backing.hidden);
        assert!(all.indices.windows(2).all(|w| w[0].name <= w[1].name));

        // Discover's field list.
        let fields = db.es_fields(ID, &index).await?;
        let field = |n: &str| fields.iter().find(|f| f.name == n).unwrap_or_else(|| panic!("no field {n}"));
        assert_eq!(field("title").types, ["text"]);
        assert!(field("title").searchable && !field("title").aggregatable);
        assert_eq!(field("title.keyword").types, ["keyword"]);
        assert!(field("title.keyword").aggregatable);
        assert_eq!(field("published").types, ["date"]);
        assert_eq!(field("views").types, ["long"]);
        assert!(field("_id").metadata && !field("views").metadata);
        assert!(fields.windows(2).all(|w| w[0].name < w[1].name));
        assert!(db.es_fields(ID, &format!("{stream}*")).await?.iter().any(|f| f.name == "@timestamp"));

        // Requests: search, count, an error answer, HEAD.
        let r = ok(&db, "POST", &format!("{index}/_search"), Some(r#"{"query":{"match":{"title":"quick"}}}"#)).await;
        assert_eq!(r["hits"]["total"]["value"], 2);
        let r = req(&db, "get", &format!("/{alias}/_count"), None).await?;
        assert_eq!((r.status, r.truncated), (200, false));
        assert!(r.content_type.starts_with("application/json"), "{}", r.content_type);
        assert!(r.elapsed_ms > 0.0);
        assert_eq!(serde_json::from_str::<Value>(&r.body).unwrap()["count"], 3);
        let missing = req(&db, "GET", &format!("/{}/_search", name("missing")), None).await?;
        assert_eq!(missing.status, 404);
        assert!(missing.body.contains("index_not_found_exception"), "{}", missing.body);
        let head = req(&db, "HEAD", &index, None).await?;
        assert_eq!((head.status, head.body.as_str()), (200, ""));
        assert_eq!(req(&db, "TRACE", "/", None).await.unwrap_err().kind, ErrorKind::InvalidInput);

        let cluster = db.es_cluster(ID).await?;
        assert!(version.ends_with(&cluster.version), "{version} / {}", cluster.version);
        assert!(["green", "yellow", "red"].contains(&cluster.status.as_str()));
        assert!(cluster.nodes >= 1 && cluster.active_shards >= 1 && cluster.indices >= 2 && cluster.docs >= 4.0);
        assert!(!cluster.name.is_empty() && !cluster.uuid.is_empty());

        // Request lines go to the query history (written off the async threads).
        let line = format!("POST /{index}/_search");
        let mut found = false;
        for _ in 0..50 {
            if db.history(ID).await?.iter().any(|h| h.text == line) {
                found = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(found, "{line} not in the history");
        Ok(())
    };
    with_cleanup(body, || async {
        let _ = req(&db, "DELETE", &format!("/_data_stream/{stream}"), None).await;
        let _ = req(&db, "DELETE", &format!("/_index_template/{template}"), None).await;
        let _ = req(&db, "DELETE", &format!("/{index}"), None).await;
        db.disconnect(ID).await;
        assert!(!db.is_connected(ID));
    })
    .await
}

#[tokio::test]
async fn a_wrong_password_asks_for_one() {
    let tmp = tempfile::tempdir().unwrap();
    let Some(db) = manager(&tmp, |_| {}, Some("not-the-password".into())).await else { return };
    let e = db.elastic(ID).await.unwrap_err();
    assert_eq!(e.kind, ErrorKind::PermissionDenied, "{}", e.message);
    assert!(!db.is_connected(ID));
    let e = db.test(&db.source(ID).unwrap(), None, None).await.unwrap_err();
    assert_eq!(e.kind, ErrorKind::PermissionDenied, "{}", e.message);
}

#[tokio::test]
async fn connects_with_an_api_key() -> IdeResult<()> {
    let tmp = tempfile::tempdir().unwrap();
    let Some(admin) = manager(&tmp, |_| {}, None).await else { return Ok(()) };
    let key =
        ok(&admin, "POST", "/_security/api_key", Some(&format!(r#"{{"name":"{}","expiration":"1h"}}"#, name("key"))))
            .await;
    let (key_id, encoded) = (key["id"].as_str().unwrap().to_owned(), key["encoded"].as_str().unwrap().to_owned());
    let body = async {
        let tmp = tempfile::tempdir().unwrap();
        let db = manager(&tmp, |s| s.user.clear(), Some(encoded.clone())).await.expect("server");
        assert!(db.test(&db.source(ID)?, None, None).await?.contains(' '));
        db.elastic(ID).await?;
        let me = ok(&db, "GET", "/_security/_authenticate", None).await;
        assert_eq!(me["authentication_type"], "api_key", "{me}");
        Ok(())
    };
    with_cleanup(body, || async {
        let _ = req(&admin, "DELETE", "/_security/api_key", Some(&format!(r#"{{"ids":["{key_id}"]}}"#))).await;
    })
    .await
}

#[tokio::test]
async fn read_only_data_sources_only_read() -> IdeResult<()> {
    let tmp = tempfile::tempdir().unwrap();
    let Some(db) = manager(&tmp, |s| s.read_only = true, None).await else { return Ok(()) };
    let index = name("ro");
    for (method, path, body) in [
        ("PUT", format!("/{index}"), None),
        ("DELETE", format!("/{index}"), None),
        ("POST", format!("/{index}/_doc"), Some(r#"{"a":1}"#)),
        ("POST", "/_bulk".to_owned(), Some("{\"delete\":{\"_index\":\"x\",\"_id\":\"1\"}}")),
    ] {
        let e = req(&db, method, &path, body).await.unwrap_err();
        assert!(e.message.contains("read-only"), "{method} {path}: {}", e.message);
    }
    // Nothing was created.
    assert_eq!(req(&db, "HEAD", &index, None).await?.status, 404);
    let r = req(&db, "POST", "/luma-test-none-*/_search", Some(r#"{"size":0}"#)).await?;
    assert_eq!(r.status, 200, "{}", r.body);
    assert_eq!(req(&db, "GET", "/_cluster/health", None).await?.status, 200);
    Ok(())
}

#[tokio::test]
async fn cancels_requests() -> IdeResult<()> {
    let tmp = tempfile::tempdir().unwrap();
    let Some(db) = manager(&tmp, |_| {}, None).await else { return Ok(()) };
    db.elastic(ID).await?;
    // Waits for nodes that never come, up to 30 s.
    let cancel = CancellationToken::new();
    let canceller = {
        let cancel = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            cancel.cancel();
        })
    };
    let started = Instant::now();
    let e =
        db.es_request(ID, "GET", "/_cluster/health?wait_for_nodes=99&timeout=30s", None, &cancel).await.unwrap_err();
    assert_eq!(e.kind, ErrorKind::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    canceller.await.unwrap();
    // Already cancelled: nothing is sent.
    let e = db.es_request(ID, "GET", "/", None, &cancel).await.unwrap_err();
    assert_eq!(e.kind, ErrorKind::Cancelled);
    // The client still works afterwards.
    assert_eq!(req(&db, "GET", "/", None).await?.status, 200);
    Ok(())
}

#[tokio::test]
async fn ssl_modes() -> IdeResult<()> {
    let Some(s) = server() else { return Ok(()) };
    if s.tls {
        return Ok(());
    }
    let tmp = tempfile::tempdir().unwrap();
    // Plain HTTP as configured.
    let db = manager(&tmp, |s| s.ssl = DbSslMode::Disable, None).await.expect("server");
    assert_eq!(req(&db, "GET", "/", None).await?.status, 200);
    // TLS required of a plain HTTP server: no fallback.
    let tmp = tempfile::tempdir().unwrap();
    let db = manager(&tmp, |s| s.ssl = DbSslMode::Require, None).await.expect("server");
    let e = db.elastic(ID).await.unwrap_err();
    assert_eq!(e.kind, ErrorKind::Io, "{}", e.message);
    Ok(())
}
