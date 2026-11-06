//! IPC commands of `ide_host::ops::java` (the shared implementation).

use crate::state::AppState;
use ide_core::{IdeResult, RequestId};
#[allow(unused_imports)]
pub use ide_host::ops::java::*;
use ide_lsp::jdtls::JavaLaunchInfo;
use std::path::PathBuf;
use tauri::{State, Window};

/// Cancellable with `cancel_request(request)`.
/// Builds the workspace (when `build`), then resolves the runtime (or test)
/// classpath and the JDK of the module at `module` (absolute, or relative to the project root).
/// A module with Kotlin / Groovy / Scala sources is built by its build system, whose class directories come first.
#[tauri::command]
#[specta::specta]
pub async fn java_resolve_launch(
    window: Window,
    state: State<'_, AppState>,
    module: PathBuf,
    test: bool,
    build: bool,
    request: RequestId,
) -> IdeResult<JavaLaunchInfo> {
    ide_host::ops::java::java_resolve_launch(&state.host, window.label(), module, test, build, request).await
}

/// Port of java-debug's DAP server inside the jdtls serving `module` (started on demand).
#[tauri::command]
#[specta::specta]
pub async fn java_debug_server(window: Window, state: State<'_, AppState>, module: PathBuf) -> IdeResult<u16> {
    ide_host::ops::java::java_debug_server(&state.host, window.label(), module).await
}

/// Incremental build of the jdtls workspace serving `module` (e.g. before HotSwap).
#[tauri::command]
#[specta::specta]
pub async fn java_build_workspace(
    window: Window,
    state: State<'_, AppState>,
    module: PathBuf,
) -> IdeResult<ide_lsp::jdtls::JavaBuildStatus> {
    ide_host::ops::java::java_build_workspace(&state.host, window.label(), module).await
}

/// Inheritance gutter markers of an open Java file (structure index; no language server).
#[tauri::command]
#[specta::specta]
pub async fn java_line_markers(
    window: Window,
    state: State<'_, AppState>,
    doc: ide_core::DocId,
) -> IdeResult<ide_index::java::JavaMarkers> {
    ide_host::ops::java::java_line_markers(&state.host, window.label(), doc).await
}

/// "N usages" of the Java declarations named at `positions`: known counts at once
/// (`cached`), then recounted where cheap, then everywhere (`full`). Cancellable with
/// `cancel_request(request)`.
#[tauri::command]
#[specta::specta]
pub async fn java_usage_counts(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    doc: ide_core::DocId,
    positions: Vec<ide_core::Pos>,
    pass: usages::UsagePass,
) -> IdeResult<Vec<usages::UsageCount>> {
    usages::java_usage_counts(&state.host, window.label(), request, doc, positions, pass).await
}
