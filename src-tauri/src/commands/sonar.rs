//! IPC commands of `ide_host::ops::sonar` (the shared implementation).

use crate::state::AppState;
use ide_core::sonar::{SonarRule, SonarRuleDescription};
use ide_core::{IdeResult, RequestId};
#[allow(unused_imports)]
pub use ide_host::ops::sonar::*;
use ide_tools::InstallEvent;
use tauri::ipc::Channel;
use tauri::{State, Window};

/// Whether SonarQube for IDE's engine and the runtimes it needs are installed.
#[tauri::command]
#[specta::specta]
pub async fn sonar_status(window: Window, state: State<'_, AppState>) -> IdeResult<SonarStatus> {
    ide_host::ops::sonar::sonar_status(&state.host, window.label()).await
}

/// Installs (or updates) the engine and, when missing, a Java 21 runtime.
/// Cancel with `cancel_request(request)`.
#[tauri::command]
#[specta::specta]
pub async fn sonar_install(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    on_event: Channel<InstallEvent>,
) -> IdeResult<SonarStatus> {
    ide_host::ops::sonar::sonar_install(&state.host, window.label(), request, crate::commands::sender(on_event)).await
}

/// Every rule of the installed analyzers.
#[tauri::command]
#[specta::specta]
pub async fn sonar_rules(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<SonarRule>> {
    ide_host::ops::sonar::sonar_rules(&state.host, window.label()).await
}

/// The description of rule `key` (`java:S1135`).
#[tauri::command]
#[specta::specta]
pub async fn sonar_rule_description(
    window: Window,
    state: State<'_, AppState>,
    key: String,
) -> IdeResult<SonarRuleDescription> {
    ide_host::ops::sonar::sonar_rule_description(&state.host, window.label(), key).await
}
