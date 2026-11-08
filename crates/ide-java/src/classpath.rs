//! Class path roots (jars, class directories, the JDK's runtime image) and the class finder over
//! them. A root lists its packages and class files from its directory (no class is read); a
//! class is parsed into a [`ClassStub`] the first time resolution needs it and cached, as IDEA's
//! class-file stubs are built lazily. Roots are shared between projects: the same jar (same
//! path, size and modification time) is listed once per process.

use crate::archive::Archive;
use crate::classfile::{self, ClassStub};
use crate::jimage::{JImage, Resource};
use crate::model::ClassData;
use parking_lot::{Mutex, RwLock};
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Weak};
use std::time::SystemTime;

enum Source {
    Jar(Archive),
    Dir,
    Image { image: JImage, resources: Vec<Resource> },
}

/// One class path entry.
pub struct ClassRoot {
    path: PathBuf,
    source: Source,
    /// Every package and every prefix of one (`java`, `java/util` for `java/util/concurrent`).
    prefixes: std::collections::HashSet<Box<str>>,
    /// Classes parsed so far, shared by every class path holding this root (IDEA keeps one
    /// stub tree per library, whatever the number of modules depending on it).
    stubs: RwLock<HashMap<Box<str>, Option<Arc<ClassStub>>>>,
    /// Their semantic view.
    data: RwLock<HashMap<Box<str>, Option<Arc<ClassData>>>>,
    /// Package (`java/util`, `""` for the default package) → class files in it: the file name
    /// without `.class` (`Map$Entry`) and where it is (an entry or resource index).
    packages: HashMap<Box<str>, Vec<(Box<str>, u32)>>,
}

/// Sorts each package's files by name (lookups binary-search them); a name listed twice (a jar
/// with duplicate entries) keeps its first entry, as the JVM's class loader would.
fn prefixes(packages: &HashMap<Box<str>, Vec<(Box<str>, u32)>>) -> std::collections::HashSet<Box<str>> {
    let mut out = std::collections::HashSet::new();
    for p in packages.keys() {
        let mut end = p.len();
        loop {
            if !out.insert(p[..end].into()) {
                break;
            }
            match p[..end].rfind('/') {
                Some(i) => end = i,
                None => break,
            }
        }
    }
    out
}

fn sorted(mut packages: HashMap<Box<str>, Vec<(Box<str>, u32)>>) -> HashMap<Box<str>, Vec<(Box<str>, u32)>> {
    for files in packages.values_mut() {
        files.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
        files.dedup_by(|b, a| a.0 == b.0);
    }
    packages
}

impl ClassRoot {
    /// Lists `path`: a jar / zip, a directory of class files, or a JDK `lib/modules` image.
    pub fn open(path: &Path) -> io::Result<Self> {
        let meta = std::fs::metadata(path)?;
        if meta.is_dir() {
            return Ok(Self::dir(path));
        }
        if path.file_name().is_some_and(|n| n == "modules") {
            return Self::image(path);
        }
        let archive = Archive::open(path)?;
        let mut packages: HashMap<Box<str>, Vec<(Box<str>, u32)>> = HashMap::new();
        for (i, e) in archive.entries.iter().enumerate() {
            let Some(stem) = e.name.strip_suffix(".class") else { continue };
            // Multi-release overlays and metadata: the base classes are what compiles against.
            if stem.starts_with("META-INF/") {
                continue;
            }
            let (pkg, name) = stem.rsplit_once('/').unwrap_or(("", stem));
            if name == "module-info" || name == "package-info" {
                continue;
            }
            packages.entry(pkg.into()).or_default().push((name.into(), i as u32));
        }
        Ok(Self {
            path: path.to_owned(),
            source: Source::Jar(archive),
            prefixes: prefixes(&packages),
            stubs: RwLock::default(),
            data: RwLock::default(),
            packages: sorted(packages),
        })
    }

    fn dir(root: &Path) -> Self {
        let mut packages: HashMap<Box<str>, Vec<(Box<str>, u32)>> = HashMap::new();
        for entry in ignore::WalkBuilder::new(root).standard_filters(false).build().flatten() {
            let p = entry.path();
            if p.extension().is_none_or(|e| e != "class") {
                continue;
            }
            let Ok(rel) = p.strip_prefix(root) else { continue };
            let rel = rel.to_string_lossy().replace('\\', "/");
            let Some(stem) = rel.strip_suffix(".class") else { continue };
            let (pkg, name) = stem.rsplit_once('/').unwrap_or(("", stem));
            if name == "module-info" || name == "package-info" || pkg.starts_with("META-INF") {
                continue;
            }
            packages.entry(pkg.into()).or_default().push((name.into(), 0));
        }
        Self {
            path: root.to_owned(),
            source: Source::Dir,
            prefixes: prefixes(&packages),
            stubs: RwLock::default(),
            data: RwLock::default(),
            packages: sorted(packages),
        }
    }

    fn image(path: &Path) -> io::Result<Self> {
        let image = JImage::open(path)?;
        let resources: Vec<Resource> = image.resources().filter(Resource::is_class).collect();
        let mut packages: HashMap<Box<str>, Vec<(Box<str>, u32)>> = HashMap::new();
        for (i, r) in resources.iter().enumerate() {
            packages.entry(r.parent.clone()).or_default().push((r.base.clone(), i as u32));
        }
        Ok(Self {
            path: path.to_owned(),
            source: Source::Image { image, resources },
            prefixes: prefixes(&packages),
            stubs: RwLock::default(),
            data: RwLock::default(),
            packages: sorted(packages),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn packages(&self) -> impl Iterator<Item = &str> {
        self.packages.keys().map(|k| &**k)
    }

    pub fn class_count(&self) -> usize {
        self.packages.values().map(Vec::len).sum()
    }

    /// Class file names (`Map$Entry`) of `package`.
    pub fn class_files(&self, package: &str) -> impl Iterator<Item = &str> {
        self.packages.get(package).into_iter().flatten().map(|(n, _)| &**n)
    }

    fn locate(&self, package: &str, name: &str) -> Option<u32> {
        let files = self.packages.get(package)?;
        files.binary_search_by(|(n, _)| (**n).cmp(name)).ok().map(|i| files[i].1)
    }

    pub fn contains(&self, package: &str, name: &str) -> bool {
        self.locate(package, name).is_some()
    }

    /// The bytes of class file `package/name.class`.
    pub fn read(&self, package: &str, name: &str) -> Option<io::Result<Vec<u8>>> {
        let at = self.locate(package, name)?;
        Some(match &self.source {
            Source::Jar(a) => a.read(&a.entries[at as usize]),
            Source::Image { image, resources } => image.read(&resources[at as usize]),
            Source::Dir => {
                let mut p = self.path.clone();
                p.extend(package.split('/').filter(|s| !s.is_empty()));
                p.push(format!("{name}.class"));
                std::fs::read(p)
            }
        })
    }

    /// The bytes of a non-class resource (`META-INF/services/java.sql.Driver`) of a jar or
    /// directory root; `None` when it has none.
    pub fn read_resource(&self, name: &str) -> Option<io::Result<Vec<u8>>> {
        match &self.source {
            Source::Jar(a) => {
                let e = a.entries.iter().find(|e| &*e.name == name)?;
                Some(a.read(e))
            }
            Source::Dir => {
                let mut p = self.path.clone();
                p.extend(name.split('/').filter(|s| !s.is_empty()));
                p.is_file().then(|| std::fs::read(p))
            }
            Source::Image { .. } => None,
        }
    }

    /// The class `binary` of this root, parsed once.
    fn stub(&self, binary: &str) -> Option<Arc<ClassStub>> {
        if let Some(found) = self.stubs.read().get(binary) {
            return found.clone();
        }
        let (pkg, name) = binary.rsplit_once('/').unwrap_or(("", binary));
        let found = self.read(pkg, name).and_then(|bytes| match bytes {
            Ok(b) => classfile::parse(&b).map_err(|e| tracing::debug!("class {binary}: {e}")).ok().map(Arc::new),
            Err(e) => {
                tracing::debug!("class {binary}: {e}");
                None
            }
        });
        self.stubs.write().insert(binary.into(), found.clone());
        found
    }

    /// Every class file of the root, read and parsed (tests and benchmarks).
    pub fn parse_all(&self) -> Vec<(String, Result<ClassStub, String>)> {
        use rayon::prelude::*;
        let files: Vec<(&str, &str)> =
            self.packages.iter().flat_map(|(p, v)| v.iter().map(move |(n, _)| (&**p, &**n))).collect();
        files
            .par_iter()
            .map(|(p, n)| {
                let name = if p.is_empty() { n.to_string() } else { format!("{p}/{n}") };
                let parsed = match self.read(p, n) {
                    Some(Ok(bytes)) => classfile::parse(&bytes).map_err(|e| e.to_string()),
                    Some(Err(e)) => Err(e.to_string()),
                    None => Err("missing".into()),
                };
                (name, parsed)
            })
            .collect()
    }
}

struct SharedRoot {
    len: u64,
    modified: Option<SystemTime>,
    root: Weak<ClassRoot>,
}

static SHARED: LazyLock<Mutex<HashMap<PathBuf, SharedRoot>>> = LazyLock::new(Default::default);

/// The listing of `path`, shared with every other user of the same unchanged file. Directories
/// (build outputs) change all the time and are listed afresh.
pub fn shared_root(path: &Path) -> io::Result<Arc<ClassRoot>> {
    let meta = std::fs::metadata(path)?;
    if meta.is_dir() {
        return ClassRoot::open(path).map(Arc::new);
    }
    let (len, modified) = (meta.len(), meta.modified().ok());
    if let Some(s) = SHARED.lock().get(path)
        && s.len == len
        && s.modified == modified
        && let Some(root) = s.root.upgrade()
    {
        return Ok(root);
    }
    let root = Arc::new(ClassRoot::open(path)?);
    let mut shared = SHARED.lock();
    shared.retain(|_, s| s.root.strong_count() > 0);
    shared.insert(path.to_owned(), SharedRoot { len, modified, root: Arc::downgrade(&root) });
    Ok(root)
}

/// The class path entries of a JDK: its runtime image (9+), or the jars of `jre/lib` (8).
pub fn jdk_roots(home: &Path) -> Vec<PathBuf> {
    if let Some(image) = JImage::of_jdk(home) {
        return vec![image];
    }
    let lib = home.join("jre").join("lib");
    let lib = if lib.is_dir() { lib } else { home.join("lib") };
    let mut jars: Vec<PathBuf> = std::fs::read_dir(&lib)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "jar"))
        .collect();
    // rt.jar first: it defines java.*.
    jars.sort_by_key(|p| (p.file_name().is_none_or(|n| n != "rt.jar"), p.clone()));
    jars
}

/// A class path: roots in order (the first defining a class wins, as for `javac`), with the
/// classes parsed so far.
pub struct ClassPath {
    roots: Vec<Arc<ClassRoot>>,
}

impl ClassPath {
    pub fn new(roots: Vec<Arc<ClassRoot>>) -> Self {
        Self { roots }
    }

    /// The root defining class `binary` (the first, as for `javac`).
    fn root_of(&self, binary: &str) -> Option<&Arc<ClassRoot>> {
        let (pkg, name) = binary.rsplit_once('/').unwrap_or(("", binary));
        self.roots.iter().find(|r| r.contains(pkg, name))
    }

    /// An empty class path (nothing outside the sources is known).
    pub fn empty() -> Self {
        Self::new(Vec::new())
    }

    /// The semantic view of class `binary`, converted once.
    pub(crate) fn data(&self, binary: &str, build: impl FnOnce(&ClassStub) -> ClassData) -> Option<Arc<ClassData>> {
        let root = self.root_of(binary)?;
        if let Some(found) = root.data.read().get(binary) {
            return found.clone();
        }
        let built = root.stub(binary).map(|stub| Arc::new(build(&stub)));
        root.data.write().insert(binary.into(), built.clone());
        built
    }

    /// Opens the shared listings of `paths`, skipping (and logging) unreadable ones.
    pub fn open(paths: &[PathBuf]) -> Self {
        use rayon::prelude::*;
        let roots: Vec<Arc<ClassRoot>> = paths
            .par_iter()
            .filter_map(|p| match shared_root(p) {
                Ok(r) => Some(r),
                Err(e) => {
                    tracing::debug!("class path entry {}: {e}", p.display());
                    None
                }
            })
            .collect();
        Self::new(roots)
    }

    pub fn roots(&self) -> &[Arc<ClassRoot>] {
        &self.roots
    }

    /// Whether some root has class file `binary` (`java/util/Map$Entry`), without reading it.
    pub fn has_class_file(&self, binary: &str) -> bool {
        let (pkg, name) = binary.rsplit_once('/').unwrap_or(("", binary));
        self.roots.iter().any(|r| r.contains(pkg, name))
    }

    /// Whether `package` exists, as a package with classes or the prefix of one (`java`).
    pub fn has_package(&self, package: &str) -> bool {
        self.roots.iter().any(|r| r.prefixes.contains(package))
    }

    /// The class `binary` (`java/util/Map$Entry`), parsed on first use.
    pub fn find(&self, binary: &str) -> Option<Arc<ClassStub>> {
        self.root_of(binary)?.stub(binary)
    }

    /// The top-level classes of `package` (binary names), unread.
    pub fn top_level_classes(&self, package: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for r in &self.roots {
            for n in r.class_files(package) {
                if n.contains('$') {
                    continue;
                }
                let binary = if package.is_empty() { n.to_owned() } else { format!("{package}/{n}") };
                if !out.contains(&binary) {
                    out.push(binary);
                }
            }
        }
        out
    }

    /// Classes parsed so far in this class path's roots.
    pub fn cached_classes(&self) -> usize {
        self.roots.iter().map(|r| r.stubs.read().len()).sum()
    }
}
