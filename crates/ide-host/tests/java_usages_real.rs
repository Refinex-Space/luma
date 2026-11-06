//! Usage counts and line markers of a real Java project with the real jdtls (the app's path).
//!
//! `#[ignore]`d: needs jdtls on PATH, a JDK, and a project copy jdtls may write metadata into:
//! `LUMA_JAVA_PROJECT=/copy/of/project LUMA_JAVA_FILE=src/main/java/A.java LUMA_JAVA_EDIT=src/main/java/B.java \
//!  cargo test -p ide-host --release --test java_usages_real -- --ignored --nocapture`
use ide_core::{NullSink, Pos, error::ErrorKind};
use ide_host::ops::java::usages::{UsageCount, UsageCountState, UsagePass, java_usage_counts};
use ide_host::{Host, HostConfig, ops};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn host(base: &Path) -> Arc<Host> {
    Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: true,
    }))
}

async fn counts(host: &Host, doc: ide_core::DocId, positions: &[Pos], pass: UsagePass) -> Vec<UsageCount> {
    java_usage_counts(host, "main", ide_core::RequestId::next(), doc, positions.to_vec(), pass).await.unwrap()
}

fn tally(counts: &[UsageCount]) -> String {
    let n = |s| counts.iter().filter(|c| c.state == s).count();
    format!(
        "{} fresh, {} stale, {} costly, {} none",
        n(UsageCountState::Fresh),
        n(UsageCountState::Stale),
        n(UsageCountState::Costly),
        n(UsageCountState::None)
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires jdtls, a JDK and LUMA_JAVA_PROJECT"]
async fn counts_and_markers_on_a_real_project() {
    let (Ok(root), Ok(file)) = (std::env::var("LUMA_JAVA_PROJECT"), std::env::var("LUMA_JAVA_FILE")) else {
        return;
    };
    let root = dunce::canonicalize(PathBuf::from(root)).unwrap();
    let path = root.join(file);
    let base = tempfile::tempdir().unwrap();
    ide_host::trust::TrustStore::load(&base.path().join("config"), &base.path().join("data"))
        .decide(&root, true, false)
        .unwrap();
    let host = host(base.path());
    host.open_project("main", &root).unwrap();
    let project = host.project("main").unwrap();
    assert!(project.index.wait_idle(Duration::from_secs(600)));
    let info = ops::doc::open(&host, "main", path.clone()).await.unwrap();
    let doc = info.id;

    let started = Instant::now();
    let markers = ops::java::java_line_markers(&host, "main", doc).await.unwrap();
    println!(
        "line markers: {:?}: {} markers, {} left to the server",
        started.elapsed(),
        markers.markers.len(),
        markers.unresolved.len()
    );
    let positions: Vec<Pos> = project
        .index
        .with_java(&path, &info.text, |v| {
            let stub = v.stub(v.overlay_file().unwrap()).unwrap();
            stub.types
                .iter()
                .filter(|t| !t.name.is_empty())
                .flat_map(|t| std::iter::once(t.at).chain(t.members.iter().map(|m| m.at)))
                .collect()
        })
        .unwrap();

    // Wait for jdtls to import the project and answer.
    let started = Instant::now();
    loop {
        // Counting in this file only: answered as soon as the server has imported the project.
        let r =
            project.lsp.java_usage_counts(doc, &[(positions[0], Some(vec![path.clone()]))], Default::default()).await;
        match r {
            Ok(_) => break,
            Err(e)
                if matches!(e.kind, ErrorKind::Unavailable | ErrorKind::Protocol)
                    && started.elapsed() < Duration::from_secs(900) =>
            {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            Err(e) => panic!("{e:?}"),
        }
    }
    println!("jdtls ready after {:?}", started.elapsed());
    ops::java::java_build_workspace(&host, "main", root.clone()).await.ok();

    let t = Instant::now();
    let cached = counts(&host, doc, &positions, UsagePass::Cached).await;
    println!("{} declarations; cached pass {:?}: {}", positions.len(), t.elapsed(), tally(&cached));
    let t = Instant::now();
    let cheap = counts(&host, doc, &positions, UsagePass::Cheap).await;
    println!("cheap pass {:?}: {}", t.elapsed(), tally(&cheap));
    let t = Instant::now();
    let mut full = cheap.clone();
    for (i, c) in cheap.iter().enumerate() {
        if c.state == UsageCountState::Costly {
            full[i] = counts(&host, doc, &positions[i..=i], UsagePass::Full).await.remove(0);
        }
    }
    println!("costly ones one by one {:?}: {}", t.elapsed(), tally(&full));
    let t = Instant::now();
    let again = counts(&host, doc, &positions, UsagePass::Cached).await;
    println!("reopened (cached pass) {:?}: {}", t.elapsed(), tally(&again));
    assert!(again.iter().all(|c| matches!(c.state, UsageCountState::Fresh | UsageCountState::None)));

    // The counts the lens showed before: one reference request per declaration, 4 at a time.
    let t = Instant::now();
    let lsp = project.lsp.clone();
    let mut old = Vec::new();
    for chunk in positions.chunks(4) {
        let rs =
            futures::future::join_all(chunk.iter().map(|&p| lsp.references(doc, p, false, false, Default::default())))
                .await;
        // The lens counts usages in the project (IDEA's code vision scope), not inside libraries.
        old.extend(rs.into_iter().map(|r| {
            r.ok().map(|r| r.locations.iter().filter(|l| l.uri.is_none() && l.path.starts_with(&root)).count() as u32)
        }));
    }
    let failed = old.iter().filter(|o| o.is_none()).count();
    println!("reference requests (before) {:?}, {failed} failed or timed out", t.elapsed());
    let mismatches: Vec<String> = positions
        .iter()
        .zip(old.iter().zip(&again))
        .filter(|(_, (o, n))| n.state != UsageCountState::None && o.is_some() && **o != n.count)
        .map(|(p, (o, n))| format!("{}:{} before {o:?} now {:?}", p.line, p.col, n.count))
        .collect();
    assert!(mismatches.is_empty(), "{mismatches:#?}");

    // Another file gains a usage: only it is counted again.
    if let Ok(edit) = std::env::var("LUMA_JAVA_EDIT") {
        let other = root.join(edit);
        let before = std::fs::read_to_string(&other).unwrap();
        let class = path.file_stem().unwrap().to_string_lossy().into_owned();
        let last = before.rfind('}').unwrap();
        std::fs::write(&other, format!("{}  private {class} lumaProbe;\n{}", &before[..last], &before[last..]))
            .unwrap();
        let class_pos = positions[0];
        let t = Instant::now();
        let old_hash = project.index.file_hash(&other);
        while project.index.file_hash(&other) == old_hash && t.elapsed() < Duration::from_secs(30) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        println!("index saw the edit after {:?}", t.elapsed());
        let fresh = loop {
            let c = counts(&host, doc, &[class_pos], UsagePass::Cheap).await.remove(0);
            if c.count != again[0].count || t.elapsed() > Duration::from_secs(30) {
                break c;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        };
        println!("after editing {}: {:?} → {:?} in {:?}", other.display(), again[0].count, fresh.count, t.elapsed());
        std::fs::write(&other, before).unwrap();
        assert_eq!(fresh.count, again[0].count.map(|n| n + 1));
    }

    // A new session answers from the persisted counts.
    host.close_project("main");
    drop(project);
    let host = self::host(base.path());
    host.open_project("main", &root).unwrap();
    let info = ops::doc::open(&host, "main", path.clone()).await.unwrap();
    let t = Instant::now();
    let next =
        java_usage_counts(&host, "main", ide_core::RequestId::next(), info.id, positions.clone(), UsagePass::Cached)
            .await;
    match next {
        Ok(next) => println!("next session (cached pass) {:?}: {}", t.elapsed(), tally(&next)),
        Err(e) => println!("next session: {e:?}"),
    }
}
