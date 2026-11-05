//! Redis data sources against a real server, skipped unless
//! `LUMA_TEST_REDIS=host:port[:password]` names a throwaway one. The test works in
//! database 15 and empties it.

use ide_core::{CancellationToken, IdeResult};
use ide_db::{DataSource, DbDriver, DbManager, RedisBytes, RedisCommandInput, RedisPageRequest, RedisReply};

const DB: &str = "r:15";

fn server() -> Option<(String, u16, String)> {
    let v = std::env::var("LUMA_TEST_REDIS").ok()?;
    let mut it = v.splitn(3, ':');
    Some((it.next()?.into(), it.next()?.parse().ok()?, it.next().unwrap_or("").into()))
}

async fn manager(tmp: &tempfile::TempDir, read_only: bool) -> Option<DbManager> {
    let (host, port, password) = server()?;
    let root = tmp.path().to_path_buf();
    let ssh = std::sync::Arc::new(ide_ssh::SshManager::new(root.join("ssh-passwords.json")));
    let db = DbManager::new(root.clone(), root.join("passwords.json"), root.join("history.json"), ssh);
    db.save_sources(vec![DataSource {
        id: "r".into(),
        name: "redis".into(),
        driver: DbDriver::Redis,
        host,
        port: Some(port),
        read_only,
        ..Default::default()
    }])
    .await
    .unwrap();
    db.set_password("r", Some(password), false).await.unwrap();
    Some(db)
}

fn args(line: &str) -> Vec<RedisBytes> {
    line.split(' ').map(RedisBytes::text).collect()
}

async fn run(db: &DbManager, line: &str) -> IdeResult<RedisReply> {
    db.redis_command(DB, &args(line)).await
}

#[tokio::test]
async fn browses_reads_and_writes_every_type() -> IdeResult<()> {
    let tmp = tempfile::tempdir().unwrap();
    let Some(db) = manager(&tmp, false).await else { return Ok(()) };
    run(&db, "FLUSHDB").await?;

    let info = db.test(&db.source("r")?, None, None).await?;
    assert!(info.starts_with("Redis ") || info.starts_with("Valkey "), "{info}");

    // One key of each type, written atomically like the key editor's Submit.
    let tx = [
        "SET app:greeting hello",
        "HSET app:user:1 name Ada email ada@example.com",
        "RPUSH app:queue a b c d e",
        "SADD app:tags red green blue",
        "ZADD app:scores 10 ada 30 linus 20 grace",
        "EXPIRE app:greeting 600",
    ];
    db.redis_transaction(DB, &tx.iter().map(|l| args(l)).collect::<Vec<_>>()).await?;
    db.redis_command(
        DB,
        &[
            RedisBytes::text("XADD"),
            RedisBytes::text("app:events"),
            RedisBytes::text("*"),
            RedisBytes::text("type"),
            RedisBytes::text("login"),
        ],
    )
    .await?;
    db.redis_command(
        DB,
        &[RedisBytes::text("SET"), RedisBytes { text: "ff00".into(), binary: true }, RedisBytes::text("x")],
    )
    .await?;

    let keyspace = db.redis_keyspace("r").await?;
    assert!(keyspace.databases.len() >= 16);
    assert_eq!(keyspace.databases[15].keys, 7.0);

    let page = db.redis_scan(DB, "app:*", None, "0", 100).await?;
    assert!(page.done);
    let mut keys: Vec<_> = page.keys.iter().map(|k| (k.key.text.as_str(), k.kind.as_str())).collect();
    keys.sort();
    assert_eq!(
        keys,
        vec![
            ("app:events", "stream"),
            ("app:greeting", "string"),
            ("app:queue", "list"),
            ("app:scores", "zset"),
            ("app:tags", "set"),
            ("app:user:1", "hash"),
        ]
    );
    let hashes = db.redis_scan(DB, "*", Some("hash"), "0", 100).await?;
    assert_eq!(hashes.keys.len(), 1);
    // A binary key comes back as hex.
    let all = db.redis_scan(DB, "*", None, "0", 100).await?;
    assert!(all.keys.iter().any(|k| k.key.binary && k.key.text == "ff00"));
    // Each key comes with its time to live and memory.
    let greeting = all.keys.iter().find(|k| k.key.text == "app:greeting").unwrap();
    assert!(greeting.ttl_ms > 0.0 && greeting.ttl_ms <= 600_000.0, "{}", greeting.ttl_ms);
    assert!(greeting.memory.is_some_and(|m| m > 0.0));
    let queue = all.keys.iter().find(|k| k.key.text == "app:queue").unwrap();
    assert_eq!(queue.ttl_ms, -1.0);

    let info = db.redis_key_info(DB, &RedisBytes::text("app:greeting")).await?;
    assert_eq!((info.kind.as_str(), info.length), ("string", Some(5.0)));
    assert!(info.ttl_ms > 0.0 && info.ttl_ms <= 600_000.0);

    let page = |count| RedisPageRequest { count, ..Default::default() };
    let s = db.redis_value(DB, &RedisBytes::text("app:greeting"), "string", &page(10)).await?;
    assert_eq!(s.value.unwrap().text, "hello");
    let h = db.redis_value(DB, &RedisBytes::text("app:user:1"), "hash", &page(100)).await?;
    assert_eq!(h.columns, vec!["field", "value"]);
    assert_eq!(h.rows.len(), 2);
    let l = db.redis_value(DB, &RedisBytes::text("app:queue"), "list", &page(2)).await?;
    assert_eq!(l.rows[1], vec![Some(RedisBytes::text("1")), Some(RedisBytes::text("b"))]);
    assert_eq!(l.cursor.as_deref(), Some("2"));
    let next = RedisPageRequest { offset: 4, count: 2, ..Default::default() };
    let l2 = db.redis_value(DB, &RedisBytes::text("app:queue"), "list", &next).await?;
    assert_eq!((l2.rows.len(), l2.cursor), (1, None));
    let z = RedisPageRequest { count: 10, descending: true, ..Default::default() };
    let z = db.redis_value(DB, &RedisBytes::text("app:scores"), "zset", &z).await?;
    assert_eq!(z.rows[0], vec![Some(RedisBytes::text("linus")), Some(RedisBytes::text("30"))]);
    let x = db.redis_value(DB, &RedisBytes::text("app:events"), "stream", &page(10)).await?;
    assert_eq!(x.columns, vec!["id", "type"]);
    assert_eq!(x.rows[0][1].as_ref().unwrap().text, "login");

    // The console: lines in order, SELECT moves it, an error stops it.
    let cancel = CancellationToken::new();
    let lines = ["INCR app:counter", "HGETALL app:user:1", "SELECT 14", "NOPE", "PING"];
    let input: Vec<_> = lines
        .iter()
        .enumerate()
        .map(|(i, l)| RedisCommandInput { from: i as u32, to: i as u32 + 1, args: args(l) })
        .collect();
    let out = db.redis_execute(DB, &input, &cancel).await?;
    assert_eq!(out.len(), 4);
    assert_eq!(out[0].reply, Some(RedisReply::Int { text: "1".into() }));
    assert!(out[0].writes && !out[1].writes);
    assert!(matches!(&out[1].reply, Some(RedisReply::Array { items }) if items.len() == 4));
    assert_eq!(out[2].select, Some(14));
    assert!(out[3].error.as_deref().unwrap().starts_with("ERR"), "{:?}", out[3].error);
    let history = db.history("r").await?;
    assert!(history.iter().any(|h| h.text == "HGETALL app:user:1"));

    // Delete by pattern.
    assert_eq!(db.redis_delete_matching(DB, "app:*", &cancel).await?, 7.0);
    run(&db, "FLUSHDB").await?;
    Ok(())
}

#[tokio::test]
async fn read_only_data_sources_only_read() -> IdeResult<()> {
    let tmp = tempfile::tempdir().unwrap();
    let Some(db) = manager(&tmp, true).await else { return Ok(()) };
    assert!(run(&db, "DBSIZE").await.is_ok());
    let e = run(&db, "SET k v").await.unwrap_err();
    assert!(e.message.contains("read-only"), "{}", e.message);
    let e = db.redis_delete_matching(DB, "*", &CancellationToken::new()).await.unwrap_err();
    assert!(e.message.contains("read-only"));
    Ok(())
}

#[tokio::test]
async fn a_wrong_password_asks_for_one() {
    let tmp = tempfile::tempdir().unwrap();
    let Some(db) = manager(&tmp, false).await else { return };
    if server().is_some_and(|s| s.2.is_empty()) {
        return;
    }
    db.set_password("r", Some("wrong".into()), false).await.unwrap();
    let e = db.redis_keyspace("r").await.unwrap_err();
    assert_eq!(e.kind, ide_core::error::ErrorKind::PermissionDenied, "{}", e.message);
}

#[tokio::test]
async fn subscribes_and_receives_messages() -> IdeResult<()> {
    let tmp = tempfile::tempdir().unwrap();
    let Some(db) = manager(&tmp, false).await else { return Ok(()) };
    let db = std::sync::Arc::new(db);
    let cancel = CancellationToken::new();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let task = {
        let (db, cancel) = (db.clone(), cancel.clone());
        tokio::spawn(async move {
            db.redis_subscribe(
                DB,
                &["luma.test".into()],
                &["luma.p.*".into()],
                move |m| {
                    let _ = tx.send(m);
                },
                &cancel,
            )
            .await
        })
    };
    // Publish until the subscription is in place.
    let mut got = Vec::new();
    for _ in 0..50 {
        run(&db, "PUBLISH luma.test hello").await?;
        run(&db, "PUBLISH luma.p.x patterned").await?;
        while let Ok(m) = rx.try_recv() {
            got.push(m);
        }
        if got.iter().any(|m| m.pattern.is_some()) && got.iter().any(|m| m.pattern.is_none()) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let plain = got.iter().find(|m| m.pattern.is_none()).expect("a channel message");
    assert_eq!((plain.channel.text.as_str(), plain.payload.text.as_str()), ("luma.test", "hello"));
    let pat = got.iter().find(|m| m.pattern.is_some()).expect("a pattern message");
    assert_eq!(pat.pattern.as_deref(), Some("luma.p.*"));
    cancel.cancel();
    task.await.unwrap()?;
    Ok(())
}
