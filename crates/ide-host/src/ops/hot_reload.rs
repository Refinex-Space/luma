//! Hot Reload (bundled plugin): what is installed, downloading JetBrains Runtime and
//! HotswapAgent, and the JVM options of a hot-reloading launch.
use crate::Host;
use crate::ops::Channel;
use crate::ops::project::settings;
use crate::ops::tools::join_err;
use crate::rpc::Dispatcher;
use ide_core::hot_reload::{ENGINE_JREBEL, HotReloadSettings};
use ide_core::{IdeError, IdeResult, RequestId};
use ide_tools::hot_reload::{
    HotReloadAgent, HotReloadLaunch, HotReloadStatus, JbrRelease, JrebelAgent, LaunchInput, java_major, jrebel_flag,
    plan_launch,
};
use ide_tools::platform::Platform;
use ide_tools::{InstallEvent, Tools};
use std::path::{Path, PathBuf};

/// The agent a launch uses: the one chosen in settings, else the downloaded one.
fn agent(tools: &Tools, s: &HotReloadSettings) -> Result<Option<HotReloadAgent>, String> {
    match s.agent_path.trim() {
        "" => Ok(tools.hotswap_agent()),
        own => {
            let path = Path::new(own);
            if path.is_file() {
                Ok(Some(HotReloadAgent { version: "custom".into(), path: path.to_path_buf().into(), custom: true }))
            } else {
                Err(format!("HotswapAgent jar {own} does not exist; choose another in Settings or clear the path."))
            }
        }
    }
}

fn status_of(tools: &Tools, s: &HotReloadSettings) -> HotReloadStatus {
    let jrebel = match s.jrebel_agent_path.trim() {
        "" => None,
        p => Some(JrebelAgent { path: PathBuf::from(p).into(), valid: jrebel_flag(Path::new(p)).is_some() }),
    };
    HotReloadStatus {
        engine: s.engine.clone(),
        agent: agent(tools, s).ok().flatten(),
        runtimes: tools.hot_reload_runtimes(),
        // JetBrains builds every runtime line for macOS, Linux and Windows on x64 and arm64.
        platform_supported: true,
        jrebel,
    }
}

/// HotswapAgent, the JetBrains Runtimes and JRebel's agent as they are now.
pub async fn hot_reload_status(host: &Host, window: &str) -> IdeResult<HotReloadStatus> {
    let s = settings(host, window).hot_reload;
    let tools = Tools::new(&host.local_data_dir);
    tokio::task::spawn_blocking(move || status_of(&tools, &s)).await.map_err(join_err)
}

/// Downloads HotswapAgent (unless an own jar is set, or the engine is JRebel) and the
/// JetBrains Runtimes of Java `majors`, streaming progress; cancel with `cancel_request(request)`.
pub async fn hot_reload_install(
    host: &Host,
    window: &str,
    majors: Vec<u32>,
    request: RequestId,
    on_event: Channel<InstallEvent>,
) -> IdeResult<HotReloadStatus> {
    let s = settings(host, window).hot_reload;
    let tools = Tools::new(&host.local_data_dir);
    let cancel = host.begin_request(request);
    let result = tokio::task::spawn_blocking(move || {
        let emit = |e| {
            let _ = on_event.send(e);
        };
        if s.engine != ENGINE_JREBEL && s.agent_path.trim().is_empty() {
            tools.install_hotswap_agent(&cancel, &emit)?;
        }
        let mut installed = false;
        for major in majors {
            if tools
                .jbr_home(
                    ide_tools::hot_reload::jbr_release(major)
                        .ok_or_else(|| IdeError::invalid(format!("no JetBrains Runtime for Java {major}")))?,
                )
                .is_none()
            {
                installed = true;
            }
            tools.install_jbr(major, &cancel, &emit)?;
        }
        if installed {
            ide_sdk::java::rescan_jdks();
        }
        IdeResult::Ok(status_of(&tools, &s))
    })
    .await
    .map_err(join_err);
    host.end_request(request);
    result?
}

/// One file per module: launches of a module share their agent configuration.
fn properties_name(root: &Path, module: &str) -> String {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut h = DefaultHasher::new();
    (root, module).hash(&mut h);
    format!("{:016x}.properties", h.finish())
}

/// The JVM options of a hot-reloading launch of `module` (project-relative), built with the
/// JDK at `java_home`; `mode` is `run` or `debug`; `class_dirs` are compiler output
/// directories the JVM doesn't load from itself (jdtls' `bin/main` under Gradle `bootRun`).
pub async fn hot_reload_launch(
    host: &Host,
    window: &str,
    java_home: Option<PathBuf>,
    mode: String,
    class_dirs: Vec<PathBuf>,
    module: String,
) -> IdeResult<HotReloadLaunch> {
    host.require_trust(window)?;
    let s = settings(host, window).hot_reload;
    let root = host.project(window).map(|p| p.root.clone()).unwrap_or_default();
    let tools = Tools::new(&host.local_data_dir);
    tokio::task::spawn_blocking(move || {
        let agent = match agent(&tools, &s) {
            Ok(a) => a,
            Err(reason) => return Ok(HotReloadLaunch::Unsupported { reason }),
        };
        let properties = tools.hot_reload_dir().join(properties_name(&root, &module));
        let project_major = java_home.as_deref().and_then(java_major);
        let runtime_home = |r: &JbrRelease| tools.jbr_home(r);
        let (plan, text) = plan_launch(&LaunchInput {
            settings: &s,
            project_major,
            debug: mode == "debug",
            agent,
            runtime_home: &runtime_home,
            properties_file: &properties,
            class_dirs: &class_dirs,
            platform: Platform::current(),
        });
        if let Some(text) = text {
            if let Some(dir) = properties.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::write(&properties, text)?;
        }
        IdeResult::Ok(plan)
    })
    .await
    .map_err(join_err)?
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("hot_reload_status", |c| async move { hot_reload_status(&c.host, &c.window).await });
    d.add("hot_reload_install", |c| async move {
        hot_reload_install(&c.host, &c.window, c.arg("majors")?, c.arg("request")?, c.sender("onEvent")?).await
    });
    d.add("hot_reload_launch", |c| async move {
        hot_reload_launch(&c.host, &c.window, c.arg("javaHome")?, c.arg("mode")?, c.arg("classDirs")?, c.arg("module")?)
            .await
    });
}
