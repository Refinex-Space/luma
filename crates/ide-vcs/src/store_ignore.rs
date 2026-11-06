//! `.luma/.gitignore`, written once when a git project's `.luma` folder exists (IDEA's
//! `GitIgnoreInStoreDirGenerator`, which writes `.idea/.gitignore` after a project opens).

use crate::Repo;
use crate::repo::gx;
use gix::bstr::{BStr, ByteSlice};
use ide_core::IdeResult;
use ide_core::project_dir;
use std::io::Write;
use std::path::Path;

/// What [`Repo::generate_store_ignore`] found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreIgnore {
    /// No `.luma` yet: generated when it appears.
    Missing,
    Generated,
    /// The folder already has a `.gitignore`.
    Exists,
    /// Files of the folder are in version control: the team manages it.
    Shared,
    /// The whole folder is ignored: nothing to keep out.
    Ignored,
}

impl StoreIgnore {
    /// Whether the decision is final for this project (IDEA's "generated" mark).
    pub fn is_settled(self) -> bool {
        self != Self::Missing
    }
}

impl Repo {
    /// Writes `.luma/.gitignore` with Luma's per-user entries, unless the folder has one, is
    /// tracked, or is ignored. Reads the index and ignore rules in process: no git command runs.
    pub fn generate_store_ignore(&self, project_root: &Path) -> IdeResult<StoreIgnore> {
        let dir = project_dir::path(project_root, "");
        if !dir.is_dir() {
            return Ok(StoreIgnore::Missing);
        }
        let file = dir.join(".gitignore");
        if file.exists() {
            return Ok(StoreIgnore::Exists);
        }
        let rel = self.rel_path(&dir)?;
        let repo = self.gix()?;
        let index = repo.index_or_empty().map_err(gx)?;
        let prefix = format!("{rel}/");
        if index.prefixed_entries(BStr::new(prefix.as_bytes())).is_some_and(|e| !e.is_empty()) {
            return Ok(StoreIgnore::Shared);
        }
        if dir_ignored(&repo, &index, &rel)? {
            return Ok(StoreIgnore::Ignored);
        }
        // `create_new`: a file written meanwhile (by the user, or a private file's writer) wins.
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&file) {
            Ok(mut f) => f.write_all(project_dir::gitignore_text().as_bytes())?,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Ok(StoreIgnore::Exists),
            Err(e) => return Err(e.into()),
        }
        Ok(StoreIgnore::Generated)
    }
}

/// Whether the folder `rel` (or one above it) is ignored: every segment is a directory.
fn dir_ignored(repo: &gix::Repository, index: &gix::index::State, rel: &str) -> IdeResult<bool> {
    let mut excludes = repo
        .excludes(index, None, gix::worktree::stack::state::ignore::Source::WorktreeThenIdMappingIfNotSkipped)
        .map_err(gx)?;
    let parts: Vec<&str> = rel.split('/').collect();
    for i in 1..=parts.len() {
        let prefix = parts[..i].join("/");
        let platform =
            excludes.at_entry(prefix.as_bytes().as_bstr(), Some(gix::index::entry::Mode::DIR)).map_err(gx)?;
        if platform.is_excluded() {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git").current_dir(dir).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn repo() -> (tempfile::TempDir, Repo) {
        let tmp = tempfile::tempdir().unwrap();
        git(tmp.path(), &["init", "-q"]);
        let repo = Repo::discover(tmp.path()).unwrap().unwrap();
        (tmp, repo)
    }

    #[test]
    fn writes_the_ignore_file_once_the_folder_exists() {
        let (tmp, repo) = repo();
        let root = tmp.path();
        assert_eq!(repo.generate_store_ignore(root).unwrap(), StoreIgnore::Missing);
        std::fs::create_dir(root.join(".luma")).unwrap();
        std::fs::write(root.join(".luma/settings.toml"), "").unwrap();
        assert_eq!(repo.generate_store_ignore(root).unwrap(), StoreIgnore::Generated);
        let text = std::fs::read_to_string(root.join(".luma/.gitignore")).unwrap();
        assert_eq!(text, project_dir::gitignore_text());
        assert_eq!(repo.generate_store_ignore(root).unwrap(), StoreIgnore::Exists);
        // Git now ignores the per-user files and offers the shared ones.
        std::fs::write(root.join(".luma/changelists.json"), "{}").unwrap();
        std::fs::create_dir(root.join(".luma/shelf")).unwrap();
        std::fs::write(root.join(".luma/shelf/a.patch"), "").unwrap();
        let out = Command::new("git").current_dir(root).args(["status", "--porcelain", "-uall"]).output().unwrap();
        let status = String::from_utf8_lossy(&out.stdout);
        assert!(status.contains(".luma/settings.toml") && status.contains(".luma/.gitignore"), "{status}");
        assert!(!status.contains("changelists.json") && !status.contains("shelf"), "{status}");
    }

    #[test]
    fn leaves_a_tracked_or_ignored_folder_alone() {
        let (tmp, repo) = repo();
        let root = tmp.path();
        std::fs::create_dir(root.join(".luma")).unwrap();
        std::fs::write(root.join(".luma/run.toml"), "").unwrap();
        git(root, &["add", ".luma/run.toml"]);
        assert_eq!(repo.generate_store_ignore(root).unwrap(), StoreIgnore::Shared);
        assert!(!root.join(".luma/.gitignore").exists());

        let (tmp, repo) = self::repo();
        let root = tmp.path();
        std::fs::write(root.join(".gitignore"), ".luma/\n").unwrap();
        std::fs::create_dir(root.join(".luma")).unwrap();
        assert_eq!(repo.generate_store_ignore(root).unwrap(), StoreIgnore::Ignored);
        assert!(!root.join(".luma/.gitignore").exists());
    }

    #[test]
    fn a_project_inside_the_repository_gets_its_own() {
        let (tmp, repo) = repo();
        let root = tmp.path().join("apps/web");
        std::fs::create_dir_all(root.join(".luma")).unwrap();
        assert_eq!(repo.generate_store_ignore(&root).unwrap(), StoreIgnore::Generated);
        assert!(root.join(".luma/.gitignore").is_file());
    }
}
