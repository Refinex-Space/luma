//! IPC commands of `ide_host::ops::spring_boot` (the shared implementation).

use crate::state::AppState;
use ide_core::{IdeResult, IpcPath, Location};
use ide_host::ops::spring_boot::{BootFileStatus, BootMarker, DefinedKey};
use ide_spring_boot::analysis::PropertyDoc;
use ide_spring_boot::analysis::complete::BootCompletion;
use ide_spring_boot::analysis::hover::BootHover;
use ide_spring_boot::analysis::validate::BootProblem;
use tauri::{State, Window};

/// Whether a file belongs to a Spring Boot module (and is one of its configuration files).
#[tauri::command]
#[specta::specta]
pub async fn spring_boot_status(
    window: Window,
    state: State<'_, AppState>,
    path: IpcPath,
) -> IdeResult<Option<BootFileStatus>> {
    ide_host::ops::spring_boot::spring_boot_status(&state.host, window.label(), path).await
}

/// Completion in a Spring Boot configuration file (`text`: its current content).
#[tauri::command]
#[specta::specta]
pub async fn spring_boot_complete(
    window: Window,
    state: State<'_, AppState>,
    path: IpcPath,
    text: String,
    offset: u32,
    explicit: bool,
) -> IdeResult<Option<BootCompletion>> {
    ide_host::ops::spring_boot::spring_boot_complete(&state.host, window.label(), path, text, offset, explicit).await
}

/// Documentation of the key, value or placeholder at `offset`.
#[tauri::command]
#[specta::specta]
pub async fn spring_boot_hover(
    window: Window,
    state: State<'_, AppState>,
    path: IpcPath,
    text: String,
    offset: u32,
) -> IdeResult<Option<BootHover>> {
    ide_host::ops::spring_boot::spring_boot_hover(&state.host, window.label(), path, text, offset).await
}

/// Documentation of a configuration property (the completion side panel).
#[tauri::command]
#[specta::specta]
pub async fn spring_boot_describe(
    window: Window,
    state: State<'_, AppState>,
    path: IpcPath,
    key: String,
) -> IdeResult<Option<PropertyDoc>> {
    ide_host::ops::spring_boot::spring_boot_describe(&state.host, window.label(), path, key).await
}

/// Inspection problems of a configuration file, with their quick fixes.
#[tauri::command]
#[specta::specta]
pub async fn spring_boot_problems(
    window: Window,
    state: State<'_, AppState>,
    path: IpcPath,
    text: String,
    replacement_tokens: bool,
) -> IdeResult<Vec<BootProblem>> {
    ide_host::ops::spring_boot::spring_boot_problems(&state.host, window.label(), path, text, replacement_tokens).await
}

/// Navigation targets of the key, value or placeholder at `offset`.
#[tauri::command]
#[specta::specta]
pub async fn spring_boot_navigate(
    window: Window,
    state: State<'_, AppState>,
    path: IpcPath,
    text: String,
    offset: u32,
) -> IdeResult<Vec<Location>> {
    ide_host::ops::spring_boot::spring_boot_navigate(&state.host, window.label(), path, text, offset).await
}

/// The module's additional metadata file with configuration key `name` added.
#[tauri::command]
#[specta::specta]
pub async fn spring_boot_define_key(
    window: Window,
    state: State<'_, AppState>,
    path: IpcPath,
    name: String,
    ty: String,
    current: Option<String>,
) -> IdeResult<DefinedKey> {
    ide_host::ops::spring_boot::spring_boot_define_key(&state.host, window.label(), path, name, ty, current).await
}

/// Spring Boot gutter markers of a Java file (configuration properties, auto-configuration registrations).
#[tauri::command]
#[specta::specta]
pub async fn spring_boot_markers(
    window: Window,
    state: State<'_, AppState>,
    path: IpcPath,
    text: String,
) -> IdeResult<Vec<BootMarker>> {
    ide_host::ops::spring_boot::spring_boot_markers(&state.host, window.label(), path, text).await
}

/// Attaches to a running Spring Boot application (its `-Dluma.run.session` marker, or a PID).
#[tauri::command]
#[specta::specta]
pub async fn spring_boot_live_attach(
    window: Window,
    state: State<'_, AppState>,
    marker: Option<String>,
    hint: Option<String>,
    pid: Option<String>,
) -> IdeResult<String> {
    ide_host::ops::spring_boot_live::spring_boot_live_attach(&state.host, window.label(), marker, hint, pid).await
}

/// A running application's state, as JSON text.
#[tauri::command]
#[specta::specta]
pub async fn spring_boot_live_status(window: Window, state: State<'_, AppState>, handle: String) -> IdeResult<String> {
    ide_host::ops::spring_boot_live::spring_boot_live_status(&state.host, window.label(), handle).await
}

/// An Actuator endpoint of a running application, as JSON text.
#[tauri::command]
#[specta::specta]
pub async fn spring_boot_live_endpoint(
    window: Window,
    state: State<'_, AppState>,
    handle: String,
    name: String,
) -> IdeResult<String> {
    ide_host::ops::spring_boot_live::spring_boot_live_endpoint(&state.host, window.label(), handle, name).await
}

/// Detaches from a running application.
#[tauri::command]
#[specta::specta]
pub async fn spring_boot_live_detach(window: Window, state: State<'_, AppState>, handle: String) -> IdeResult<()> {
    ide_host::ops::spring_boot_live::spring_boot_live_detach(&state.host, window.label(), handle).await
}

/// The project source of a class (runtime beans, request mapping handlers).
#[tauri::command]
#[specta::specta]
pub async fn spring_boot_locate_class(
    window: Window,
    state: State<'_, AppState>,
    fqn: String,
) -> IdeResult<Option<Location>> {
    ide_host::ops::spring_boot::spring_boot_locate_class(&state.host, window.label(), fqn).await
}
