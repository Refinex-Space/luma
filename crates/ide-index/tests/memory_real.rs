//! Memory the index takes for a real project (resident set growth while it is open):
//! `LUMA_INDEX_PROJECT=/path cargo test -p ide-index --release --test memory_real -- --ignored --nocapture`

use ide_index::ProjectIndex;
use ide_language::{LanguageRegistry, Syntax};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::Arc;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::time::{Duration, Instant};

/// Live heap bytes (what the index keeps, unlike the resident set, which also holds memory the
/// allocator has not returned).
struct Counting;
static LIVE: AtomicIsize = AtomicIsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        LIVE.fetch_add(layout.size() as isize, Ordering::Relaxed);
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size() as isize, Ordering::Relaxed);
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        LIVE.fetch_add(new_size as isize - layout.size() as isize, Ordering::Relaxed);
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

fn live_mb() -> f64 {
    LIVE.load(Ordering::Relaxed) as f64 / 1024.0 / 1024.0
}

fn rss_mb() -> f64 {
    let out =
        std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse::<f64>().unwrap_or(0.0) / 1024.0
}

#[test]
#[ignore = "indexes the project in LUMA_INDEX_PROJECT"]
fn index_memory_of_a_real_project() {
    let Ok(root) = std::env::var("LUMA_INDEX_PROJECT") else { return };
    // `LUMA_INDEX_CACHE`: a cache folder kept between runs; a second run measures a warm start alone.
    let kept = std::env::var("LUMA_INDEX_CACHE").ok().map(std::path::PathBuf::from);
    let temp = tempfile::tempdir().unwrap();
    let cache_dir = kept.clone().unwrap_or_else(|| temp.path().to_owned());
    let warm_only = kept.as_ref().is_some_and(|k| k.join("index.redb").exists());
    if warm_only {
        let before = rss_mb();
        let live_before = live_mb();
        let started = Instant::now();
        let index = ProjectIndex::open(
            std::path::Path::new(&root),
            &cache_dir,
            Vec::new(),
            Vec::new(),
            Arc::new(LanguageRegistry::load(None).unwrap()),
            Arc::new(Syntax::new()),
            Arc::new(ide_core::NullSink),
        )
        .unwrap();
        assert!(index.wait_idle(Duration::from_secs(900)));
        let status = index.status();
        let live = live_mb() - live_before;
        println!(
            "warm start alone: {} files, {} symbols in {:?}; resident set +{:.0} MB, live heap +{live:.1} MB",
            status.files,
            status.symbols,
            started.elapsed(),
            rss_mb() - before
        );
        println!(
            "  graph [words, word bytes, postings, names, by-name]: {}",
            index.copy_part_for_measurement("stats").downcast::<String>().unwrap()
        );
        for part in [
            "java",
            "java-without-sig",
            "java-without-annotation-args",
            "java-without-param-details",
            "java-without-members",
            "symbols",
        ] {
            let at = live_mb();
            let copy = index.copy_part_for_measurement(part);
            println!("  {part}: about {:.1} MB", live_mb() - at);
            drop(copy);
        }
        drop(index);
        std::thread::sleep(Duration::from_millis(500));
        println!("after closing it: live heap {:+.1} MB", live_mb() - live_before);
        return;
    }
    let cache = &cache_dir;
    let languages = Arc::new(LanguageRegistry::load(None).unwrap());
    let before = rss_mb();
    let started = Instant::now();
    let index = ProjectIndex::open(
        std::path::Path::new(&root),
        cache,
        Vec::new(),
        Vec::new(),
        languages.clone(),
        Arc::new(Syntax::new()),
        Arc::new(ide_core::NullSink),
    )
    .unwrap();
    assert!(index.wait_idle(Duration::from_secs(900)));
    let cold = started.elapsed();
    let status = index.status();
    let after = rss_mb();
    drop(index);
    // Warm start: everything from the persisted records.
    let started = Instant::now();
    let warm = ProjectIndex::open(
        std::path::Path::new(&root),
        cache,
        Vec::new(),
        Vec::new(),
        languages,
        Arc::new(Syntax::new()),
        Arc::new(ide_core::NullSink),
    )
    .unwrap();
    assert!(warm.wait_idle(Duration::from_secs(900)));
    println!(
        "{} files, {} symbols: cold {cold:?}, warm {:?}; resident set +{:.0} MB ({before:.0} → {after:.0} MB)",
        status.files,
        status.symbols,
        started.elapsed(),
        after - before
    );
}
