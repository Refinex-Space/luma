//! Problems of closed files, kept to show again at once when they are reopened unchanged — what
//! IDEA's `HighlightingNecromancer` does with a closed editor's highlighting (it "buries" the
//! markup with a fingerprint of the text and "resurrects" it on reopen, before the daemon has
//! run). Language servers (SonarQube for IDE's analysis takes seconds, jdtls waits for its
//! import) then publish fresh problems, which replace the restored ones source by source; an
//! edit before that withdraws whatever was not replaced yet, since its ranges no longer hold.

use ide_core::{Diagnostic, IdeEvent, SharedSink};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

const VERSION: u32 = 1;
/// Files kept at most (the most recently buried win).
const MAX_FILES: usize = 400;

pub fn fingerprint(text: &str) -> u64 {
    let h = blake3::hash(text.as_bytes());
    u64::from_le_bytes(h.as_bytes()[..8].try_into().unwrap_or_default())
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Buried {
    fingerprint: u64,
    /// Problems by producer (`sonarlint`, `jdtls`…).
    sources: BTreeMap<String, Vec<Diagnostic>>,
    /// Burial order, for eviction.
    seq: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct Stored {
    version: u32,
    files: HashMap<PathBuf, Buried>,
    seq: u64,
}

pub struct DiagnosticsGrave {
    file: PathBuf,
    /// What the servers published last, per file and producer.
    live: Mutex<HashMap<PathBuf, BTreeMap<String, Vec<Diagnostic>>>>,
    stored: Mutex<Stored>,
    /// Producers whose restored problems a file still shows (not replaced yet).
    zombies: Mutex<HashMap<PathBuf, HashSet<String>>>,
}

impl DiagnosticsGrave {
    pub fn new(cache_dir: &Path) -> Self {
        let file = cache_dir.join("diagnostics-grave.json");
        let stored = std::fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice::<Stored>(&b).ok())
            .filter(|s| s.version == VERSION)
            .unwrap_or_default();
        Self { file, live: Mutex::default(), stored: Mutex::new(stored), zombies: Mutex::default() }
    }

    /// Notes what a server published (the language servers' event stream passes through here).
    pub fn record(&self, event: &IdeEvent) {
        let IdeEvent::Diagnostics { path, source, items } = event else { return };
        let path = path.0.clone();
        {
            let mut live = self.live.lock();
            let sources = live.entry(path.clone()).or_default();
            if items.is_empty() {
                sources.remove(source);
            } else {
                sources.insert(source.clone(), items.clone());
            }
        }
        // Fresh problems of that producer replace its restored ones.
        let mut zombies = self.zombies.lock();
        if let Some(z) = zombies.get_mut(&path) {
            z.remove(source);
            if z.is_empty() {
                zombies.remove(&path);
            }
        }
    }

    /// Keeps the problems `path` shows now, for the text of fingerprint `fp` (a file closed, a
    /// project closed).
    pub fn bury(&self, path: &Path, fp: u64) {
        let sources = self.live.lock().get(path).cloned().unwrap_or_default();
        let mut stored = self.stored.lock();
        if sources.is_empty() {
            stored.files.remove(path);
            return;
        }
        stored.seq += 1;
        let seq = stored.seq;
        stored.files.insert(path.to_owned(), Buried { fingerprint: fp, sources, seq });
        if stored.files.len() > MAX_FILES {
            let mut order: Vec<(u64, PathBuf)> = stored.files.iter().map(|(p, b)| (b.seq, p.clone())).collect();
            order.sort();
            for (_, p) in order.into_iter().take(stored.files.len() - MAX_FILES) {
                stored.files.remove(&p);
            }
        }
    }

    /// Shows again the problems kept for `path` when its text is the one they were found in.
    /// Returns the producers restored.
    pub fn resurrect(&self, path: &Path, text: &str, sink: &SharedSink) -> Vec<String> {
        let buried = {
            let stored = self.stored.lock();
            match stored.files.get(path) {
                Some(b) if b.fingerprint == fingerprint(text) => b.sources.clone(),
                _ => return Vec::new(),
            }
        };
        // Producers that already published for the open file keep their fresh problems.
        let live: HashSet<String> = self.live.lock().get(path).map(|s| s.keys().cloned().collect()).unwrap_or_default();
        let mut restored = Vec::new();
        for (source, items) in buried {
            if live.contains(&source) {
                continue;
            }
            sink.emit(IdeEvent::Diagnostics { path: path.to_owned().into(), source: source.clone(), items });
            restored.push(source);
        }
        if !restored.is_empty() {
            self.zombies.lock().entry(path.to_owned()).or_default().extend(restored.iter().cloned());
        }
        restored
    }

    /// An edit to `path`: restored problems not replaced yet no longer match the text.
    pub fn edited(&self, path: &Path, sink: &SharedSink) {
        let Some(sources) = self.zombies.lock().remove(path) else { return };
        for source in sources {
            sink.emit(IdeEvent::Diagnostics { path: path.to_owned().into(), source, items: Vec::new() });
        }
    }

    /// Writes the kept problems to the cache (closing a file, closing the project).
    pub fn save(&self) {
        let bytes = {
            let mut stored = self.stored.lock();
            stored.version = VERSION;
            serde_json::to_vec(&*stored)
        };
        let Ok(bytes) = bytes else { return };
        let tmp = self.file.with_extension("json.tmp");
        let result = self
            .file
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|_| std::fs::write(&tmp, bytes))
            .and_then(|_| std::fs::rename(&tmp, &self.file));
        if let Err(e) = result {
            tracing::debug!("diagnostics grave: {e}");
        }
    }
}

/// The documents' side: what each open file's text was when opened or saved, and whether it
/// was edited since — a file closed with unsaved edits does not get its problems kept, since
/// reopening reads the saved text they do not belong to.
pub struct GraveObserver {
    pub grave: std::sync::Arc<DiagnosticsGrave>,
    sink: SharedSink,
    open: Mutex<HashMap<ide_core::DocId, (PathBuf, u64, bool)>>,
}

impl GraveObserver {
    pub fn new(grave: std::sync::Arc<DiagnosticsGrave>, sink: SharedSink) -> Self {
        Self { grave, sink, open: Mutex::default() }
    }

    /// Keeps the problems of every open, unedited file (the project closes) and writes them.
    pub fn bury_open(&self) {
        for (path, fp, edited) in self.open.lock().values() {
            if !edited {
                self.grave.bury(path, *fp);
            }
        }
        self.grave.save();
    }
}

impl ide_workspace::documents::DocumentObserver for GraveObserver {
    fn opened(&self, info: &ide_workspace::DocumentInfo) {
        let path = info.path.0.clone();
        self.open.lock().insert(info.id, (path.clone(), fingerprint(&info.text), info.dirty));
        if !info.dirty {
            self.grave.resurrect(&path, &info.text, &self.sink);
        }
    }

    fn changed(
        &self,
        doc: ide_core::DocId,
        path: &Path,
        _version: u32,
        _changes: &[ide_text::AppliedChange],
        _full_text: &dyn Fn() -> String,
    ) {
        if let Some(e) = self.open.lock().get_mut(&doc) {
            e.2 = true;
        }
        self.grave.edited(path, &self.sink);
    }

    fn saved(&self, doc: ide_core::DocId, path: &Path, text: &str) {
        self.open.lock().insert(doc, (path.to_owned(), fingerprint(text), false));
    }

    fn closed(&self, doc: ide_core::DocId, path: &Path) {
        let Some((_, fp, edited)) = self.open.lock().remove(&doc) else { return };
        if edited {
            return;
        }
        self.grave.bury(path, fp);
        let grave = self.grave.clone();
        std::thread::spawn(move || grave.save());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::{Pos, Range, Severity};
    use std::sync::Arc;

    fn diag(message: &str) -> Diagnostic {
        Diagnostic {
            range: Range::new(Pos::new(1, 0), Pos::new(1, 4)),
            severity: Severity::Warning,
            message: message.into(),
            source: Some("sonarqube".into()),
            code: Some("java:S1135".into()),
            unnecessary: false,
            deprecated: false,
            server: Some("sonarlint".into()),
        }
    }

    fn event(path: &Path, source: &str, items: Vec<Diagnostic>) -> IdeEvent {
        IdeEvent::Diagnostics { path: path.to_owned().into(), source: source.into(), items }
    }

    #[test]
    fn closed_files_show_their_problems_again_until_fresh_ones_arrive() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("A.java");
        let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
        let sink: SharedSink = {
            let events = events.clone();
            Arc::new(move |e: IdeEvent| events.lock().push(e))
        };
        {
            let grave = DiagnosticsGrave::new(dir.path());
            grave.record(&event(&path, "sonarlint", vec![diag("TODO")]));
            grave.record(&event(&path, "jdtls", vec![diag("unused")]));
            grave.bury(&path, fingerprint("class A {}"));
            grave.save();
        }
        // Next session: the file reopens unchanged.
        let grave = DiagnosticsGrave::new(dir.path());
        assert!(grave.resurrect(&path, "class A { }", &sink).is_empty(), "another text: nothing");
        let mut restored = grave.resurrect(&path, "class A {}", &sink);
        restored.sort();
        assert_eq!(restored, ["jdtls", "sonarlint"]);
        assert_eq!(events.lock().len(), 2);
        // SonarQube for IDE publishes fresh problems: its zombies are replaced; an edit then
        // withdraws jdtls's, which were not.
        grave.record(&event(&path, "sonarlint", vec![]));
        events.lock().clear();
        grave.edited(&path, &sink);
        let withdrawn: Vec<String> = events
            .lock()
            .iter()
            .map(|e| match e {
                IdeEvent::Diagnostics { source, items, .. } if items.is_empty() => source.clone(),
                _ => String::new(),
            })
            .collect();
        assert_eq!(withdrawn, ["jdtls"]);
        grave.edited(&path, &sink);
        assert_eq!(events.lock().len(), 1, "withdrawn once");
    }
}

#[cfg(test)]
mod host_tests {
    use super::*;
    use crate::{Host, HostConfig};
    use std::sync::Arc;

    fn host(base: &Path, events: Arc<Mutex<Vec<IdeEvent>>>) -> Host {
        Host::new(HostConfig {
            config_dir: base.join("config"),
            data_dir: base.join("data"),
            local_data_dir: base.join("data"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(move |_| {
                let events = events.clone();
                Arc::new(move |e: IdeEvent| events.lock().push(e))
            }),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        })
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_reopened_file_shows_its_problems_before_any_server_answers() {
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let root = base.join("project");
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("notes.txt");
        std::fs::write(&file, "TODO: something\n").unwrap();
        let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
        let restored = |events: &Arc<Mutex<Vec<IdeEvent>>>| {
            events.lock().iter().filter(|e| matches!(e, IdeEvent::Diagnostics { source, items, .. } if source == "sonarlint" && !items.is_empty())).count()
        };
        {
            let host = host(&base, events.clone());
            let project = host.open_project("main", &root).unwrap();
            let info = crate::ops::doc::open(&host, "main", file.clone()).await.unwrap();
            // A server publishes a problem for the open file.
            let item = Diagnostic {
                range: ide_core::Range::new(ide_core::Pos::new(0, 0), ide_core::Pos::new(0, 4)),
                severity: ide_core::Severity::Warning,
                message: "Complete the task associated to this TODO comment.".into(),
                source: Some("sonarqube".into()),
                code: Some("text:S1135".into()),
                unnecessary: false,
                deprecated: false,
                server: Some("sonarlint".into()),
            };
            project.diagnostics.grave.record(&IdeEvent::Diagnostics {
                path: file.clone().into(),
                source: "sonarlint".into(),
                items: vec![item],
            });
            crate::ops::doc::close(&host, "main", info.id).unwrap();
            host.close_project("main");
        }
        events.lock().clear();
        // Next session: reopening the unchanged file shows the problem at once.
        let host = host(&base, events.clone());
        host.open_project("main", &root).unwrap();
        let info = crate::ops::doc::open(&host, "main", file.clone()).await.unwrap();
        assert_eq!(restored(&events), 1, "restored on open");
        // An edit withdraws it (the server republishes for the new text).
        events.lock().clear();
        crate::ops::doc::edit(
            &host,
            "main",
            info.id,
            info.version,
            ide_core::ChangeSet { changes: vec![ide_core::TextChange { from: 0, to: 0, insert: "x".into() }] },
        )
        .unwrap();
        let withdrawn = events.lock().iter().any(
            |e| matches!(e, IdeEvent::Diagnostics { source, items, .. } if source == "sonarlint" && items.is_empty()),
        );
        assert!(withdrawn);
    }
}
