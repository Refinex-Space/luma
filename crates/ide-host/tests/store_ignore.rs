//! `.luma/.gitignore` is written for a git project when it opens with a `.luma` folder, or when
//! the folder appears later, and only once (IDEA's `.idea/.gitignore`).
use ide_core::NullSink;
use ide_host::{Host, HostConfig};
use std::{path::Path, process::Command, sync::Arc, time::Duration};

fn git(root: &Path, args: &[&str]) {
    let output = Command::new("git").current_dir(root).args(args).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}

fn host(base: &Path) -> Host {
    Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    })
}

async fn wait_for(path: &Path) -> bool {
    for _ in 0..500 {
        if path.is_file() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    false
}

#[tokio::test(flavor = "multi_thread")]
async fn written_when_the_project_opens_or_the_folder_appears() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let (opened, later, plain) = (base.join("opened"), base.join("later"), base.join("plain"));
    for root in [&opened, &later, &plain] {
        std::fs::create_dir_all(root).unwrap();
    }
    git(&opened, &["init", "-q"]);
    git(&later, &["init", "-q"]);
    std::fs::create_dir(opened.join(".luma")).unwrap();
    std::fs::write(opened.join(".luma/settings.toml"), "").unwrap();
    let host = host(&base);

    // Opened with a `.luma` folder.
    host.open_project("a", &opened).unwrap();
    let file = opened.join(".luma/.gitignore");
    assert!(wait_for(&file).await);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), ide_core::project_dir::gitignore_text());

    // The folder appears while the project is open.
    host.open_project("b", &later).unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!later.join(".luma").exists());
    std::fs::create_dir(later.join(".luma")).unwrap();
    std::fs::write(later.join(".luma/run.toml"), "").unwrap();
    assert!(wait_for(&later.join(".luma/.gitignore")).await);

    // Only once: a deleted file is not written again on the next open.
    host.close_project("a");
    std::fs::remove_file(&file).unwrap();
    host.open_project("a", &opened).unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!file.exists());

    // Not a git project: nothing to keep out.
    std::fs::create_dir(plain.join(".luma")).unwrap();
    host.open_project("c", &plain).unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!plain.join(".luma/.gitignore").exists());
}
