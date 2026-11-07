//! Every class of real JDKs and jars parsed into stubs, with no failure:
//!
//! ```sh
//! LUMA_JDK_HOMES=/path/jdk17:/path/jdk25 LUMA_JARS=~/.m2/repository/org/springframework \
//!   cargo test -p ide-java --release --test real_classpath -- --ignored --nocapture
//! ```

use ide_java::classfile::{TypeArgSig, TypeSig};
use ide_java::classpath::{ClassPath, ClassRoot, jdk_roots};
use ide_java::jimage::JImage;
use std::path::PathBuf;
use std::time::Instant;

fn env_paths(var: &str) -> Vec<PathBuf> {
    std::env::var(var).map(|v| std::env::split_paths(&v).collect()).unwrap_or_default()
}

fn check_root(root: &ClassRoot) -> (usize, Vec<(String, String)>) {
    let all = root.parse_all();
    let failures: Vec<(String, String)> =
        all.iter().filter_map(|(n, r)| r.as_ref().err().map(|e| (n.clone(), e.clone()))).collect();
    (all.len(), failures)
}

#[test]
#[ignore = "reads the JDKs in LUMA_JDK_HOMES"]
fn every_jdk_class_parses() {
    let homes = env_paths("LUMA_JDK_HOMES");
    assert!(!homes.is_empty(), "set LUMA_JDK_HOMES");
    for home in homes {
        let started = Instant::now();
        let roots = jdk_roots(&home);
        assert!(!roots.is_empty(), "no class path in {}", home.display());
        let root = ClassRoot::open(&roots[0]).unwrap();
        let listed = started.elapsed();
        let (count, failures) = check_root(&root);
        println!(
            "{}: {count} classes, listed in {listed:?}, all parsed in {:?}, {} failures",
            home.display(),
            started.elapsed(),
            failures.len()
        );
        for (name, e) in failures.iter().take(20) {
            println!("  {name}: {e}");
        }
        assert!(failures.is_empty());
        assert!(count > 10_000);

        // The class finder over the image: generic signatures as javap prints them.
        let cp = ClassPath::open(&roots);
        let entry = cp.find("java/util/Map$Entry").unwrap();
        assert_eq!(entry.simple_name, "Entry");
        assert_eq!(entry.outer.as_deref(), Some("java/util/Map"));
        let names: Vec<_> = entry.signature.as_ref().unwrap().type_params.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["K", "V"]);
        let stream = cp.find("java/util/stream/Stream").unwrap();
        let map = stream.methods.iter().find(|m| m.name == "map").unwrap();
        // <R> Stream<R> map(Function<? super T, ? extends R>)
        let TypeSig::Class(f) = &map.params[0] else { panic!() };
        assert_eq!(f.name, "java/util/function/Function");
        assert_eq!(f.own_args()[0], TypeArgSig::Super(TypeSig::TypeVar("T".into())));
        assert!(cp.find("java/util/NoSuchClassHere").is_none());
        assert!(cp.has_package("java/util/concurrent"));
        assert!(cp.top_level_classes("java/lang").iter().any(|c| c == "java/lang/String"));

        // Hash lookup agrees with the listing.
        if let Some(image) = JImage::of_jdk(&home) {
            let image = JImage::open(&image).unwrap();
            let r = image.find("/java.base/java/lang/Object.class").unwrap();
            assert!(r.is_class());
            assert!(image.find("/java.base/java/lang/NoSuch.class").is_none());
            let bytes = image.read(&r).unwrap();
            assert_eq!(&bytes[..4], b"\xCA\xFE\xBA\xBE");
        }
    }
}

#[test]
#[ignore = "reads the jars under LUMA_JARS"]
fn every_jar_class_parses() {
    let dirs = env_paths("LUMA_JARS");
    assert!(!dirs.is_empty(), "set LUMA_JARS");
    let mut jars = Vec::new();
    for dir in dirs {
        for e in ignore::WalkBuilder::new(&dir).standard_filters(false).build().flatten() {
            let p = e.path();
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            if name.ends_with(".jar") && !name.ends_with("-sources.jar") && !name.ends_with("-javadoc.jar") {
                jars.push(p.to_owned());
            }
        }
    }
    let started = Instant::now();
    let (mut classes, mut failures, mut unreadable) = (0, Vec::new(), Vec::new());
    for jar in &jars {
        match ClassRoot::open(jar) {
            Ok(root) => {
                let (n, f) = check_root(&root);
                classes += n;
                failures.extend(f.into_iter().map(|(c, e)| (format!("{}!{c}", jar.display()), e)));
            }
            Err(e) => unreadable.push((jar.clone(), e.to_string())),
        }
    }
    println!(
        "{} jars, {classes} classes in {:?}: {} failures, {} unreadable jars",
        jars.len(),
        started.elapsed(),
        failures.len(),
        unreadable.len()
    );
    for (c, e) in failures.iter().take(30) {
        println!("  {c}: {e}");
    }
    for (j, e) in unreadable.iter().take(30) {
        println!("  unreadable {}: {e}", j.display());
    }
    assert!(failures.is_empty());
}
