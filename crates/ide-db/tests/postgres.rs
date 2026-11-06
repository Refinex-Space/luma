//! Introspection against a real PostgreSQL server, skipped unless
//! `LUMA_TEST_POSTGRES=host:port:user:password` names a throwaway one (the test
//! creates and drops the schema `oi_catalog` in the user's default database).

use ide_core::{CancellationToken, IdeResult};
use ide_db::{DataSource, DbCatalogKind as K, DbDriver, DbManager, DbServerObjectKind};

#[tokio::test]
async fn catalog_and_server_objects() -> IdeResult<()> {
    let Ok(v) = std::env::var("LUMA_TEST_POSTGRES") else { return Ok(()) };
    let mut it = v.splitn(4, ':');
    let (host, port, user, password) = (
        it.next().unwrap_or_default().to_owned(),
        it.next().and_then(|p| p.parse().ok()),
        it.next().unwrap_or_default().to_owned(),
        it.next().unwrap_or_default().to_owned(),
    );
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().to_path_buf();
    let ssh = std::sync::Arc::new(ide_ssh::SshManager::new(root.join("ssh-passwords.json")));
    let db = DbManager::new(root.clone(), root.join("passwords.json"), root.join("history.json"), ssh)
        .with_catalog_dir(root.join("catalog"));
    db.save_sources(vec![DataSource {
        id: "pg".into(),
        name: "pg".into(),
        driver: DbDriver::Postgres,
        host,
        port,
        user: user.clone(),
        ..Default::default()
    }])
    .await?;
    db.set_password("pg", Some(password), false).await?;
    let c = CancellationToken::new();
    for stmt in [
        "DROP SCHEMA IF EXISTS oi_catalog CASCADE",
        "CREATE SCHEMA oi_catalog",
        "CREATE TABLE oi_catalog.customer (id int PRIMARY KEY, email text UNIQUE)",
        "CREATE TABLE oi_catalog.orders (id int PRIMARY KEY, customer_id int, status text, \
         CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES oi_catalog.customer (id))",
        "CREATE INDEX idx_orders_status ON oi_catalog.orders (status)",
        "CREATE VIEW oi_catalog.order_summary AS SELECT id, status FROM oi_catalog.orders",
        "CREATE MATERIALIZED VIEW oi_catalog.order_totals AS SELECT count(*) AS n FROM oi_catalog.orders",
        "CREATE SEQUENCE oi_catalog.order_numbers",
        "CREATE FUNCTION oi_catalog.order_total(o int) RETURNS int LANGUAGE sql AS 'SELECT o'",
        "CREATE PROCEDURE oi_catalog.close_order(o int) LANGUAGE sql AS 'SELECT 1'",
        "CREATE FUNCTION oi_catalog.touch() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'",
        "CREATE TRIGGER orders_touch BEFORE UPDATE ON oi_catalog.orders FOR EACH ROW EXECUTE FUNCTION oi_catalog.touch()",
    ] {
        db.execute("pg", stmt, 10, &c).await?;
    }
    let schemas = db.schemas("pg").await?;
    for s in ["information_schema", "pg_catalog", "oi_catalog"] {
        assert!(schemas.iter().any(|x| x == s), "{s} in {schemas:?}");
    }
    assert!(schemas.iter().all(|s| !s.starts_with("pg_toast")), "{schemas:?}");

    let catalog = db.catalog("pg").await?;
    let has = |kind: K, table: &str, name: &str| {
        catalog.objects.iter().any(|o| o.kind == kind && o.schema == "oi_catalog" && o.table == table && o.name == name)
    };
    assert!(has(K::Table, "", "orders") && has(K::View, "", "order_summary"));
    assert!(has(K::MaterializedView, "", "order_totals") && has(K::Sequence, "", "order_numbers"));
    assert!(has(K::Column, "orders", "customer_id") && has(K::Column, "order_summary", "status"));
    assert!(has(K::PrimaryKey, "orders", "orders_pkey") && has(K::ForeignKey, "orders", "fk_orders_customer"));
    assert!(has(K::Index, "orders", "idx_orders_status") && has(K::UniqueIndex, "customer", "customer_email_key"));
    assert!(has(K::Function, "", "order_total") && has(K::Procedure, "", "close_order"));
    assert!(has(K::Trigger, "orders", "orders_touch"));
    assert!(catalog.objects.iter().any(|o| o.schema == "pg_catalog" && o.kind == K::Table && o.name == "pg_class"));
    let f = catalog.objects.iter().find(|o| o.name == "order_total").unwrap();
    assert_eq!(f.detail, "o integer");
    assert_eq!(db.table_details("pg", "oi_catalog", "orders").await?.foreign_keys[0].name, "fk_orders_customer");

    let groups = db.server_objects("pg").await?;
    let roles = groups.iter().find(|g| g.kind == DbServerObjectKind::Roles).unwrap();
    assert!(roles.objects.iter().any(|o| o.name == user && o.detail == "login"), "{roles:?}");
    let spaces = groups.iter().find(|g| g.kind == DbServerObjectKind::Tablespaces).unwrap();
    assert!(spaces.objects.iter().any(|o| o.name == "pg_default"));

    db.execute("pg", "DROP SCHEMA oi_catalog CASCADE", 10, &c).await?;
    Ok(())
}
