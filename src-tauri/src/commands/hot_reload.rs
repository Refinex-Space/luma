//! IPC commands of `ide_host::ops::hot_reload` (the shared implementation).

use crate::state::AppState;
use ide_core::{IdeResult, RequestId};
use ide_tools::InstallEvent;
use ide_tools::hot_reload::{HotReloadLaunch, HotReloadStatus};
use std::path::PathBuf;
use tauri::ipc::Channel;
use tauri::{State, Window};

/// HotswapAgent, the JetBrains Runtimes and JRebel's agent as they are now.
#[tauri::command]
#[specta::specta]
pub async fn hot_reload_status(window: Window, state: State<'_, AppState>) -> IdeResult<HotReloadStatus> {
    ide_host::ops::hot_reload::hot_reload_status(&state.host, window.label()).await
}

/// Downloads HotswapAgent and the JetBrains Runtimes of Java `majors` (17, 21, 25).
/// Cancel with `cancel_request(request)`.
#[tauri::command]
#[specta::specta]
pub async fn hot_reload_install(
    window: Window,
    state: State<'_, AppState>,
    majors: Vec<u32>,
    request: RequestId,
    on_event: Channel<InstallEvent>,
) -> IdeResult<HotReloadStatus> {
    ide_host::ops::hot_reload::hot_reload_install(
        &state.host,
        window.label(),
        majors,
        request,
        crate::commands::sender(on_event),
    )
    .await
}

/// The JVM options (and launcher) of a hot-reloading launch of `module`, built with the
/// JDK at `java_home`; `mode` is `run` or `debug`; `class_dirs` are compiler output
/// directories the JVM doesn't load from itself.
#[tauri::command]
#[specta::specta]
pub async fn hot_reload_launch(
    window: Window,
    state: State<'_, AppState>,
    java_home: Option<PathBuf>,
    mode: String,
    class_dirs: Vec<PathBuf>,
    module: String,
) -> IdeResult<HotReloadLaunch> {
    ide_host::ops::hot_reload::hot_reload_launch(&state.host, window.label(), java_home, mode, class_dirs, module).await
}
