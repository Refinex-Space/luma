//! Introspection against a real MySQL / MariaDB server, skipped unless
//! `LUMA_TEST_MYSQL=host:port:user:password` names a throwaway server.

use ide_core::{CancellationToken, IdeResult};
use ide_db::{DataSource, DbDriver, DbManager, DbOptions};

const SCHEMAS: [&str; 2] = ["oi_bin_meta", "oi_数据"];

fn server() -> Option<(String, u16, String, String)> {
    let v = std::env::var("LUMA_TEST_MYSQL").ok()?;
    let mut it = v.splitn(4, ':');
    Some((it.next()?.into(), it.next()?.parse().ok()?, it.next()?.into(), it.next().unwrap_or("").into()))
}

async fn manager(tmp: &tempfile::TempDir, startup_script: &str) -> Option<DbManager> {
    let (host, port, user, password) = server()?;
    let root = tmp.path().to_path_buf();
    let ssh = std::sync::Arc::new(ide_ssh::SshManager::new(root.join("ssh-passwords.json")));
    let db = DbManager::new(root.clone(), root.join("passwords.json"), root.join("history.json"), ssh);
    db.save_sources(vec![DataSource {
        id: "m".into(),
        name: "mysql".into(),
        driver: DbDriver::Mysql,
        host,
        port: Some(port),
        user,
        options: DbOptions { startup_script: startup_script.into(), ..Default::default() },
        ..Default::default()
    }])
    .await
    .unwrap();
    db.set_password("m", Some(password), false).await.unwrap();
    Some(db)
}

async fn create_schemas(db: &DbManager) {
    let c = CancellationToken::new();
    for s in SCHEMAS {
        for stmt in [
            format!("DROP DATABASE IF EXISTS `{s}`"),
            format!("CREATE DATABASE `{s}` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"),
            format!(
                "CREATE TABLE `{s}`.`用户` (id INT PRIMARY KEY, name VARCHAR(20) COLLATE utf8mb4_bin, raw VARBINARY(4))"
            ),
            format!("CREATE INDEX `名字` ON `{s}`.`用户` (name)"),
            format!("INSERT INTO `{s}`.`用户` VALUES (1, 'ann', 0xCAFE)"),
        ] {
            db.execute("m", &stmt, 10, &c).await.unwrap();
        }
    }
}

async fn assert_metadata_is_text(db: &DbManager) -> IdeResult<()> {
    let schemas = db.schemas("m").await?;
    for s in SCHEMAS {
        assert!(schemas.iter().any(|n| n == s), "{s} missing from {schemas:?}");
        let tables = db.tables("m", s).await?;
        assert_eq!(tables.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["用户"], "tables of {s}");
        let d = db.table_details("m", s, "用户").await?;
        let cols: Vec<_> = d.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(cols, ["id", "name", "raw"]);
        assert!(d.indexes.iter().any(|i| i.name == "名字"), "{:?}", d.indexes);
        assert!(db.ddl("m", s, "用户").await?.contains("CREATE TABLE `用户`"));
    }
    let completion = db.completion("m").await?;
    let json = serde_json::to_string(&completion).unwrap();
    assert!(json.contains("oi_数据") && json.contains("用户"), "{json}");
    Ok(())
}

// One test: both phases share the schemas they create.
#[tokio::test]
async fn metadata_names_are_text_whatever_the_column_collation() -> IdeResult<()> {
    let tmp = tempfile::tempdir().unwrap();
    let Some(db) = manager(&tmp, "").await else { return Ok(()) };
    create_schemas(&db).await;
    // MySQL 8 sends `utf8mb3_bin` catalog names flagged BINARY (lower_case_table_names = 0).
    assert_metadata_is_text(&db).await?;
    // `_bin` text is text in the grid; true binary stays hex.
    let r = db.execute("m", "SELECT name, raw FROM `oi_数据`.`用户`", 10, &CancellationToken::new()).await?;
    assert_eq!(r.rows, vec![vec![Some("ann".to_owned()), Some("0xCAFE".to_owned())]]);

    // A console's database (`m:<database>`): unqualified names resolve in it.
    let c = CancellationToken::new();
    assert!(db.execute("m", "SELECT name FROM `用户`", 10, &c).await.is_err(), "no database selected");
    let r = db.execute("m:oi_数据", "SELECT name FROM `用户`", 10, &c).await?;
    assert_eq!(r.rows, vec![vec![Some("ann".to_owned())]]);
    assert_eq!(db.completion("m:oi_数据").await?.default_schema, "oi_数据");

    // Every text column arrives with the `binary` collation.
    let tmp = tempfile::tempdir().unwrap();
    let raw = manager(&tmp, "SET character_set_results = binary").await.unwrap();
    assert_metadata_is_text(&raw).await
}

// Search Everywhere's catalog and the tree's Server Objects.
#[tokio::test]
async fn catalog_lists_every_object_and_the_server_objects() -> IdeResult<()> {
    use ide_db::{DbCatalogKind as K, DbServerObjectKind};
    let tmp = tempfile::tempdir().unwrap();
    let Some(db) = manager(&tmp, "").await else { return Ok(()) };
    let db = db.with_catalog_dir(tmp.path().join("catalog"));
    let c = CancellationToken::new();
    for stmt in [
        "DROP DATABASE IF EXISTS oi_catalog",
        "CREATE DATABASE oi_catalog",
        "CREATE TABLE oi_catalog.customer (id INT PRIMARY KEY, email VARCHAR(40) UNIQUE)",
        "CREATE TABLE oi_catalog.orders (id INT PRIMARY KEY, customer_id INT, status VARCHAR(10), \
         CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES oi_catalog.customer (id), \
         INDEX idx_orders_status (status))",
        "CREATE VIEW oi_catalog.order_summary AS SELECT id, status FROM oi_catalog.orders",
        "CREATE PROCEDURE oi_catalog.close_order(IN order_id INT) UPDATE oi_catalog.orders SET status = 'x' \
         WHERE id = order_id",
        "CREATE TRIGGER oi_catalog.orders_audit BEFORE INSERT ON oi_catalog.orders FOR EACH ROW SET NEW.status = 'NEW'",
    ] {
        db.execute("m", stmt, 10, &c).await.unwrap();
    }
    let schemas = db.schemas("m").await?;
    assert!(schemas.contains(&"information_schema".to_owned()), "{schemas:?}");
    assert!(schemas.contains(&"performance_schema".to_owned()), "{schemas:?}");
    assert!(!schemas.contains(&"mysql".to_owned()), "internal unless Show internal system schemas: {schemas:?}");

    assert!(db.saved_catalog("m").await?.is_none());
    let catalog = db.catalog("m").await?;
    let has = |kind: K, table: &str, name: &str| {
        catalog.objects.iter().any(|o| o.kind == kind && o.schema == "oi_catalog" && o.table == table && o.name == name)
    };
    assert!(has(K::Table, "", "orders") && has(K::View, "", "order_summary"));
    assert!(has(K::Column, "orders", "customer_id") && has(K::Column, "order_summary", "status"));
    assert!(has(K::PrimaryKey, "orders", "PRIMARY"));
    assert!(!has(K::UniqueIndex, "orders", "PRIMARY"), "the key, not its index too");
    assert!(has(K::ForeignKey, "orders", "fk_orders_customer"));
    assert!(has(K::Index, "orders", "idx_orders_status") && has(K::UniqueIndex, "customer", "email"));
    assert!(has(K::Procedure, "", "close_order") && has(K::Trigger, "orders", "orders_audit"));
    let fk = catalog.objects.iter().find(|o| o.kind == K::ForeignKey && o.name == "fk_orders_customer").unwrap();
    assert_eq!(fk.detail, "customer");
    // System schemas are searchable too (IDEA finds `ACTION_ORDER` of information_schema.TRIGGERS).
    assert!(catalog.objects.iter().any(|o| o.schema == "information_schema" && o.kind == K::View));
    assert!(catalog.objects.iter().all(|o| o.schema != "mysql"));
    assert_eq!(db.saved_catalog("m").await?, Some(catalog), "saved for the next session");

    let details = db.table_details("m", "oi_catalog", "orders").await?;
    assert_eq!(details.foreign_keys[0].name, "fk_orders_customer");

    let groups = db.server_objects("m").await?;
    let collations = groups.iter().find(|g| g.kind == DbServerObjectKind::Collations).unwrap();
    assert!(collations.objects.iter().any(|o| o.name == "utf8mb4_bin" && o.detail == "utf8mb4"));
    let users = groups.iter().find(|g| g.kind == DbServerObjectKind::Users).unwrap();
    let (_, _, user, _) = server().unwrap();
    assert!(users.objects.iter().any(|o| o.name == user && !o.detail.is_empty()), "{users:?}");

    db.execute("m", "DROP DATABASE oi_catalog", 10, &c).await.unwrap();
    Ok(())
}
