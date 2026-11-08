//! A module's metadata index from its class path: dependency jars (parsed once per jar
//! version and shared across modules and projects), the annotation processor's output in
//! output folders, hand-written additional metadata in resource folders, and metadata worked
//! out from sources ([`crate::source`]).

use crate::metadata::{self, Builder, MetadataIndex, Origin, OriginKind, RawMetadata};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::SystemTime;

type Stamp = (u64, Option<SystemTime>);

fn stamp(path: &Path) -> Option<Stamp> {
    let m = std::fs::metadata(path).ok()?;
    Some((m.len(), m.modified().ok()))
}

type JarCache = HashMap<PathBuf, (Stamp, Arc<Vec<RawMetadata>>)>;

/// Parsed metadata of jars by path, with the file stamp they were read at.
static JARS: LazyLock<Mutex<JarCache>> = LazyLock::new(Default::default);

/// The metadata files of a jar, from the cache while the jar is unchanged.
pub fn jar_metadata(path: &Path) -> Option<Arc<Vec<RawMetadata>>> {
    let s = stamp(path)?;
    if let Some((st, raw)) = JARS.lock().get(path)
        && *st == s
    {
        return Some(raw.clone());
    }
    let raw = Arc::new(metadata::read_jar(path)?);
    let mut jars = JARS.lock();
    if jars.len() > 20_000 {
        jars.clear();
    }
    jars.insert(path.to_owned(), (s, raw.clone()));
    Some(raw)
}

/// What a module's index is built from.
#[derive(Clone, Debug, Default)]
pub struct Inputs {
    /// Class path entries in order: jars and output folders.
    pub classpath: Vec<PathBuf>,
    /// The module's resource folders (`src/main/resources`).
    pub resources: Vec<PathBuf>,
    /// Open editors' text of metadata files, by path (wins over the disk).
    pub unsaved: HashMap<PathBuf, String>,
}

/// Fingerprint of the inputs that change the index (jar and metadata file stamps).
pub fn fingerprint(inputs: &Inputs) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for p in metadata_files(inputs) {
        p.hash(&mut h);
        stamp(&p).hash(&mut h);
    }
    for (p, t) in &inputs.unsaved {
        p.hash(&mut h);
        t.hash(&mut h);
    }
    h.finish()
}

const OUTPUT_FILE: &str = "META-INF/spring-configuration-metadata.json";
const ADDITIONAL_FILE: &str = "META-INF/additional-spring-configuration-metadata.json";

/// Every file read for the index: jars, and the metadata files of folders.
fn metadata_files(inputs: &Inputs) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for e in &inputs.classpath {
        if e.is_dir() {
            out.push(e.join(OUTPUT_FILE));
            out.push(e.join(ADDITIONAL_FILE));
        } else {
            out.push(e.clone());
        }
    }
    for r in &inputs.resources {
        out.push(r.join(ADDITIONAL_FILE));
    }
    out
}

fn read(path: &Path, unsaved: &HashMap<PathBuf, String>) -> Option<Result<RawMetadata, ()>> {
    if let Some(text) = unsaved.get(path) {
        return Some(metadata::parse(text.as_bytes()).ok_or(()));
    }
    let m = std::fs::metadata(path).ok()?;
    if m.len() > metadata::MAX_FILE {
        return Some(Err(()));
    }
    let bytes = std::fs::read(path).ok()?;
    Some(metadata::parse(&bytes).ok_or(()))
}

/// Builds the index of a module: jars, output folders, additional metadata of resource
/// folders, then `sources` (metadata worked out from Java, replacing older processor output).
pub fn build(inputs: &Inputs, sources: &[(PathBuf, RawMetadata)]) -> MetadataIndex {
    let mut b = Builder::new();
    for e in &inputs.classpath {
        if e.is_dir() {
            // The processor's output (which already merges the module's additional metadata).
            for (file, kind) in [(OUTPUT_FILE, OriginKind::Output), (ADDITIONAL_FILE, OriginKind::Additional)] {
                let path = e.join(file);
                match read(&path, &inputs.unsaved) {
                    Some(Ok(raw)) => b.add(&raw, Arc::new(Origin { kind, path }), false),
                    Some(Err(())) => b.mark_incomplete(),
                    None => {}
                }
            }
        } else if e.extension().is_some_and(|x| x.eq_ignore_ascii_case("jar")) {
            match jar_metadata(e) {
                Some(raws) => {
                    let origin = Arc::new(Origin { kind: OriginKind::Jar, path: e.clone() });
                    for raw in raws.iter() {
                        b.add(raw, origin.clone(), false);
                    }
                }
                None => {
                    if e.exists() {
                        b.mark_incomplete();
                    }
                }
            }
        }
    }
    for r in &inputs.resources {
        let path = r.join(ADDITIONAL_FILE);
        match read(&path, &inputs.unsaved) {
            Some(Ok(raw)) => b.add(&raw, Arc::new(Origin { kind: OriginKind::Additional, path }), false),
            Some(Err(())) => b.mark_incomplete(),
            None => {}
        }
    }
    for (path, raw) in sources {
        b.add(raw, Arc::new(Origin { kind: OriginKind::Source, path: path.clone() }), true);
    }
    b.build()
}

/// The Spring Boot version of a class path, from the `spring-boot-<version>.jar` on it.
pub fn boot_version(classpath: &[PathBuf]) -> Option<String> {
    classpath.iter().find_map(|p| {
        let name = p.file_name()?.to_str()?;
        let v = name.strip_prefix("spring-boot-")?.strip_suffix(".jar")?;
        v.chars().next().filter(char::is_ascii_digit).map(|_| v.to_owned())
    })
}

/// Whether a class path has a jar of `artifact` (`spring-boot-actuator`).
pub fn has_artifact(classpath: &[PathBuf], artifact: &str) -> bool {
    classpath.iter().any(|p| {
        p.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
            n.strip_prefix(artifact)
                .and_then(|rest| rest.strip_prefix('-'))
                .is_some_and(|rest| rest.chars().next().is_some_and(|c| c.is_ascii_digit()))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_and_artifacts() {
        let cp: Vec<PathBuf> =
            ["/r/spring-boot-autoconfigure-4.1.2.jar", "/r/spring-boot-4.1.2.jar", "/r/spring-boot-actuator-4.1.2.jar"]
                .iter()
                .map(PathBuf::from)
                .collect();
        assert_eq!(boot_version(&cp).as_deref(), Some("4.1.2"));
        assert!(has_artifact(&cp, "spring-boot-actuator"));
        assert!(!has_artifact(&cp, "spring-boot-devtools"));
        assert!(has_artifact(&cp, "spring-boot"));
    }

    #[test]
    fn folders_and_unsaved_text() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("target/classes/META-INF");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(
            out.join("spring-configuration-metadata.json"),
            r#"{"properties":[{"name":"app.a","type":"java.lang.String"}]}"#,
        )
        .unwrap();
        let res = dir.path().join("src/main/resources");
        let additional = res.join(ADDITIONAL_FILE);
        let mut inputs =
            Inputs { classpath: vec![dir.path().join("target/classes")], resources: vec![res], ..Default::default() };
        inputs.unsaved.insert(additional, r#"{"properties":[{"name":"app.b"}]}"#.into());
        let ix = build(&inputs, &[]);
        assert!(ix.property("app.a").is_some());
        assert!(ix.property("app.b").is_some());
        assert!(!ix.incomplete);
        inputs.unsaved.values_mut().for_each(|t| *t = "{broken".into());
        assert!(build(&inputs, &[]).incomplete);
    }

    /// The Boot 4.1.2 jars of the local Maven repository (when present): the counts the
    /// task document measured, and the time a module's first index takes.
    #[test]
    fn boot_4_1_2_jars() {
        let Some(home) = std::env::var_os("HOME") else { return };
        let repo = PathBuf::from(home).join(".m2/repository/org/springframework/boot");
        let Ok(dirs) = std::fs::read_dir(&repo) else { return };
        let jars: Vec<PathBuf> = dirs
            .flatten()
            .filter_map(|d| {
                let name = d.file_name().to_string_lossy().into_owned();
                if !name.starts_with("spring-boot") {
                    return None;
                }
                let jar = d.path().join("4.1.2").join(format!("{name}-4.1.2.jar"));
                jar.is_file().then_some(jar)
            })
            .collect();
        if jars.len() < 80 {
            return;
        }
        let started = std::time::Instant::now();
        let ix = build(&Inputs { classpath: jars.clone(), ..Default::default() }, &[]);
        let cold = started.elapsed();
        let started = std::time::Instant::now();
        let again = build(&Inputs { classpath: jars, ..Default::default() }, &[]);
        let warm = started.elapsed();
        eprintln!(
            "boot 4.1.2: {} properties, {} groups, {} hints; cold {cold:?}, cached jars {warm:?}",
            ix.properties().len(),
            ix.groups().len(),
            ix.hint_count()
        );
        assert!(ix.properties().len() >= 1500, "{}", ix.properties().len());
        assert!(ix.groups().len() >= 200);
        assert_eq!(ix.properties().len(), again.properties().len());
        assert!(ix.property("spring.datasource.url").is_some());
        assert!(ix.property("server.port").is_some());
    }
}
