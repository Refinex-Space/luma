//! The class path worked out from POMs against Maven's own (`dependency:build-classpath`):
//! `LUMA_MAVEN_ROOT=/build/root LUMA_MAVEN_POM=module/pom.xml LUMA_MAVEN_CP=classpath.txt \
//!  cargo test -p ide-build --test static_classpath_real -- --ignored --nocapture`

use ide_build::maven::{self, StaticClasspath};
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;

#[test]
#[ignore = "compares with a class path Maven wrote"]
fn agrees_with_maven() {
    let (Ok(root), Ok(pom), Ok(cp)) =
        (std::env::var("LUMA_MAVEN_ROOT"), std::env::var("LUMA_MAVEN_POM"), std::env::var("LUMA_MAVEN_CP"))
    else {
        return;
    };
    let root = PathBuf::from(root);
    let model = maven::load(&root);
    let reactor: HashMap<String, PathBuf> =
        model.projects.iter().map(|p| (format!("{}:{}", p.group_id, p.artifact_id), root.join(&p.dir))).collect();
    let started = std::time::Instant::now();
    let ours: BTreeSet<String> = StaticClasspath::new(None)
        .of(&root.join(pom), &reactor)
        .into_iter()
        .filter(|p| p.extension().is_some_and(|e| e == "jar"))
        .map(|p| p.display().to_string())
        .collect();
    let elapsed = started.elapsed();
    let theirs: BTreeSet<String> = std::fs::read_to_string(cp)
        .unwrap()
        .trim()
        .split(':')
        .filter(|p| p.ends_with(".jar"))
        .map(str::to_owned)
        .collect();
    let missing: Vec<&String> = theirs.difference(&ours).collect();
    let extra: Vec<&String> = ours.difference(&theirs).collect();
    println!(
        "maven {} jars, ours {} in {elapsed:?}: {} missing, {} extra",
        theirs.len(),
        ours.len(),
        missing.len(),
        extra.len()
    );
    for m in missing.iter().take(30) {
        println!("  missing {m}");
    }
    for e in extra.iter().take(30) {
        println!("  extra   {e}");
    }
}
