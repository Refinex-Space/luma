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

    // Before jdtls has imported anything: Luma's engine answers at once (JDK and sources only
    // in a first session; JDT counts the undecided rest in the background).
    let t = Instant::now();
    match java_usage_counts(&host, "main", ide_core::RequestId::next(), doc, positions.clone(), UsagePass::Full).await {
        Ok(early) => println!("before jdtls is ready (engine) {:?}: {}", t.elapsed(), tally(&early)),
        Err(e) => println!("before jdtls is ready: {e:?}"),
    }

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
    // JDT counts what the engine left undecided in the background: wait for it to settle.
    let t = Instant::now();
    let again = loop {
        let again = counts(&host, doc, &positions, UsagePass::Cached).await;
        let settled = again.iter().all(|c| matches!(c.state, UsageCountState::Fresh | UsageCountState::None));
        if settled || t.elapsed() > Duration::from_secs(300) {
            break again;
        }
        // Undecided files still stale: a cheap pass retries what JDT has not counted yet.
        let _ = counts(&host, doc, &positions, UsagePass::Full).await;
        tokio::time::sleep(Duration::from_millis(500)).await;
    };
    println!("settled (cached pass) after {:?}: {}", t.elapsed(), tally(&again));
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
    // The inlay counts a method's override family (IDEA's semantics), references the method alone.
    println!("{} declarations count differently from plain references:", mismatches.len());
    for m in mismatches.iter().take(20) {
        println!("  {m}");
    }
    // Where they differ: Find Usages (the engine's, as the inlay counts) against references.
    for (p, (o, n)) in positions.iter().zip(old.iter().zip(&again)) {
        if n.state == UsageCountState::None || o.is_none() || *o == n.count {
            continue;
        }
        let refs =
            lsp.references(doc, *p, false, false, Default::default()).await.map(|r| r.locations).unwrap_or_default();
        let found = ops::lsp::lsp_find_usages(
            &host,
            "main",
            ide_core::RequestId::next(),
            doc,
            *p,
            ide_lsp::types::UsageSearchScope::Project,
        )
        .await
        .map(|r| r.locations)
        .unwrap_or_default();
        let key = |l: &ide_core::Location| {
            format!(
                "{}:{}:{}",
                l.path.0.strip_prefix(&root).unwrap_or(&l.path.0).display(),
                l.range.start.line + 1,
                l.range.start.col + 1
            )
        };
        let theirs: std::collections::BTreeSet<String> =
            refs.iter().filter(|l| l.uri.is_none() && l.path.starts_with(&root)).map(key).collect();
        let ours: std::collections::BTreeSet<String> = found.iter().map(key).collect();
        let listed = refs.iter().filter(|l| l.uri.is_none() && l.path.starts_with(&root)).count();
        println!(
            "  {}:{} jdtls listed {listed} ({} distinct), engine {} (count {:?})",
            p.line,
            p.col,
            theirs.len(),
            ours.len(),
            n.count
        );
        println!("  {}:{} only jdtls: {:?}", p.line, p.col, theirs.difference(&ours).collect::<Vec<_>>());
        println!("  {}:{} only engine: {:?}", p.line, p.col, ours.difference(&theirs).collect::<Vec<_>>());
    }

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
    // The index loads its persisted records first (a fraction of a second).
    assert!(host.project("main").unwrap().index.wait_idle(Duration::from_secs(120)));
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

/// Go to Implementation, Type Hierarchy and Find Usages scopes against the server's answers:
/// `LUMA_JAVA_PROJECT=… LUMA_JAVA_NAV_FILE=path/of/AbstractType.java cargo test -p ide-host --release
///  --test java_usages_real navigation -- --ignored --nocapture`
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires jdtls, a JDK and LUMA_JAVA_PROJECT"]
async fn navigation_on_a_real_project() {
    use ide_lsp::types::{GotoKind, HierarchyDirection, UsageSearchScope};
    let (Ok(root), Ok(file)) = (std::env::var("LUMA_JAVA_PROJECT"), std::env::var("LUMA_JAVA_NAV_FILE")) else {
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
    // The type, and a method with implementations or overriders.
    let markers = project.index.java_markers(&path, &info.text);
    let class =
        project.index.with_java(&path, &info.text, |v| v.stub(v.overlay_file().unwrap()).unwrap().types[0].at).unwrap();
    let method = markers
        .markers
        .iter()
        .find(|m| {
            m.method
                && matches!(
                    m.kind,
                    ide_index::java::JavaMarkerKind::Implemented | ide_index::java::JavaMarkerKind::Overridden
                )
        })
        .map(|m| Pos::new(m.line, m.col));
    let started = Instant::now();
    loop {
        match project.lsp.goto(doc, class, GotoKind::Definition).await {
            Ok(_) => break,
            Err(e) if started.elapsed() < Duration::from_secs(900) => {
                let _ = e;
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            Err(e) => panic!("{e:?}"),
        }
    }
    ops::java::java_build_workspace(&host, "main", root.clone()).await.ok();
    println!("jdtls ready after {:?}", started.elapsed());
    let key = |l: &ide_core::Location| (l.path.0.clone(), l.range.start.line);
    for (what, pos) in std::iter::once(("type", class)).chain(method.map(|m| ("method", m))) {
        let t = Instant::now();
        let index = ops::lsp::lsp_goto(&host, "main", doc, pos, GotoKind::Implementation).await.unwrap_or_default();
        let index_time = t.elapsed();
        let t = Instant::now();
        let server = project.lsp.goto(doc, pos, GotoKind::Implementation).await.unwrap_or_default();
        let server_time = t.elapsed();
        let mut a: Vec<_> = index.iter().map(key).collect();
        let mut b: Vec<_> = server.iter().filter(|l| l.uri.is_none()).map(key).collect();
        a.sort();
        b.sort();
        b.dedup();
        let missing: Vec<_> = b.iter().filter(|x| !a.contains(x)).collect();
        let extra: Vec<_> = a.iter().filter(|x| !b.contains(x)).collect();
        println!(
            "⌥⌘B on the {what}: index {index_time:?} ({} targets), server {server_time:?} ({} in sources); missing {missing:?}, extra {extra:?}",
            a.len(),
            b.len()
        );
    }
    let t = Instant::now();
    let index = ops::lsp::lsp_type_hierarchy(&host, "main", doc, class, HierarchyDirection::Outgoing).await.unwrap();
    let index_time = t.elapsed();
    let t = Instant::now();
    let server = project.lsp.type_hierarchy(doc, class, HierarchyDirection::Outgoing).await.unwrap_or_default();
    let mut a: Vec<String> = index.iter().map(|i| i.name.clone()).collect();
    let mut b: Vec<String> = server.iter().filter(|i| i.uri.is_none()).map(|i| i.name.clone()).collect();
    a.sort();
    b.sort();
    println!("subtypes: index {index_time:?} {a:?}; server {:?} {b:?}", t.elapsed());
    // Alternating, so neither scope pays for a cold start alone.
    for (what, pos) in std::iter::once(("type", class)).chain(method.map(|m| ("method", m))) {
        for scope in
            [UsageSearchScope::All, UsageSearchScope::Project, UsageSearchScope::All, UsageSearchScope::Project]
        {
            let t = Instant::now();
            let refs = project.lsp.find_usages(doc, pos, scope, Default::default()).await.unwrap();
            let outside = refs.locations.iter().filter(|l| l.uri.is_some() || !l.path.starts_with(&root)).count();
            println!(
                "Find Usages of the {what} in {scope:?}: {:?}, {} usages, {outside} outside the project",
                t.elapsed(),
                refs.locations.len()
            );
        }
    }
}
