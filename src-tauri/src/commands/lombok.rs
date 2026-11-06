//! IPC commands of `ide_host::ops::lombok` (the shared implementation).

use crate::state::AppState;
use ide_core::{IdeResult, RequestId};
use ide_host::ops::lombok::{DelombokInput, DelombokOutput, LombokStatus};
use tauri::{State, Window};

/// The agent jdtls runs with, whether the project uses Lombok and its `lombok.config` files.
#[tauri::command]
#[specta::specta]
pub async fn lombok_status(window: Window, state: State<'_, AppState>) -> IdeResult<LombokStatus> {
    ide_host::ops::lombok::lombok_status(&state.host, window.label()).await
}

/// Runs Lombok's `delombok` on `files` (editor text) with the module's `classpath`.
/// Cancel with `cancel_request(request)`.
#[tauri::command]
#[specta::specta]
pub async fn lombok_delombok(
    window: Window,
    state: State<'_, AppState>,
    files: Vec<DelombokInput>,
    classpath: Vec<String>,
    request: RequestId,
) -> IdeResult<Vec<DelombokOutput>> {
    ide_host::ops::lombok::lombok_delombok(&state.host, window.label(), files, classpath, request).await
}
