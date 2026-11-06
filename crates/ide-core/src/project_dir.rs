//! The per-project config folder (`<root>/.luma/`, IDEA's `.idea`).
//!
//! What it holds is shared through version control (`settings.toml`, `run.toml`,
//! `data-sources.toml`, `plugins/`), except the per-user and rebuilt files of
//! [`IGNORED`], which its own `.gitignore` keeps out (IDEA's `.idea/.gitignore`).

use std::path::{Path, PathBuf};

/// Folder name under the project root.
pub const DIR: &str = ".luma";

/// Where `rel` (e.g. `settings.toml`) is read from and written to.
pub fn path(root: &Path, rel: impl AsRef<Path>) -> PathBuf {
    root.join(DIR).join(rel)
}

/// Entries of `.luma/.gitignore` under one comment (IDEA's ignored file groups).
pub struct IgnoreGroup {
    pub description: &'static str,
    /// Relative to `.luma`, `/`-rooted; a trailing `/` names a folder.
    pub entries: &'static [&'static str],
}

/// The per-user and rebuilt contents of `.luma`. IDEA ignores `/shelf/` and `/workspace.xml`,
/// where it also keeps change lists and the run configurations not stored as project files.
pub const IGNORED: &[IgnoreGroup] = &[
    IgnoreGroup { description: "Default ignored files", entries: &["/shelf/", "/changelists.json", "/run.local.toml"] },
    IgnoreGroup { description: "Go run output", entries: &["/bin/"] },
];

/// The text of a new `.luma/.gitignore`: every group of [`IGNORED`].
pub fn gitignore_text() -> String {
    let mut out = String::new();
    for g in IGNORED {
        out.push_str("# ");
        out.push_str(g.description);
        out.push('\n');
        for e in g.entries {
            out.push_str(e);
            out.push('\n');
        }
    }
    out
}

/// Before writing a private file: makes sure `.luma/.gitignore` lists `entries`. A missing
/// file is created with every group; an existing one gets the missing entries appended.
pub fn ensure_ignored(root: &Path, entries: &[&str]) -> std::io::Result<()> {
    let file = path(root, ".gitignore");
    let current = match std::fs::read_to_string(&file) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };
    let mut text = current.clone().unwrap_or_else(gitignore_text);
    let missing: Vec<&str> = entries.iter().copied().filter(|e| !text.lines().any(|l| l.trim() == *e)).collect();
    if current.is_some() && missing.is_empty() {
        return Ok(());
    }
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    for e in missing {
        text.push_str(e);
        text.push('\n');
    }
    std::fs::create_dir_all(path(root, ""))?;
    std::fs::write(file, text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gitignore_lists_every_group() {
        assert_eq!(
            gitignore_text(),
            "# Default ignored files\n/shelf/\n/changelists.json\n/run.local.toml\n# Go run output\n/bin/\n"
        );
    }

    #[test]
    fn ensure_creates_once_and_appends_what_is_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let file = path(root, ".gitignore");
        ensure_ignored(root, &["/shelf/"]).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), gitignore_text());
        ensure_ignored(root, &["/shelf/", "/changelists.json"]).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), gitignore_text());
        // A file the user wrote keeps its text; only what is missing is added.
        std::fs::write(&file, "# mine\n/tmp/").unwrap();
        ensure_ignored(root, &["/bin/", "/tmp/"]).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "# mine\n/tmp/\n/bin/\n");
    }
}
