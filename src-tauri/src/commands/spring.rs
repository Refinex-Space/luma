//! IPC commands of `ide_host::ops::spring` (the shared implementation).

use crate::state::AppState;
use ide_core::{DocId, IdeResult, Pos};
use ide_host::ops::spring::SpringStatus;
use ide_index::java::spring::{
    SpringBeanDetail, SpringBeanInfo, SpringCandidates, SpringContextInfo, SpringGraph, SpringMarkers, SpringProblem,
};
use tauri::{State, Window};

/// Whether the project uses Spring, from its build model (else its sources).
#[tauri::command]
#[specta::specta]
pub async fn spring_status(window: Window, state: State<'_, AppState>) -> IdeResult<SpringStatus> {
    ide_host::ops::spring::spring_status(&state.host, window.label()).await
}

/// Spring gutter markers of an open Java file (structure index; no language server).
#[tauri::command]
#[specta::specta]
pub async fn spring_markers(window: Window, state: State<'_, AppState>, doc: DocId) -> IdeResult<SpringMarkers> {
    ide_host::ops::spring::spring_markers(&state.host, window.label(), doc).await
}

/// Spring inspection problems of an open Java file, with their quick fixes as text edits.
#[tauri::command]
#[specta::specta]
pub async fn spring_problems(window: Window, state: State<'_, AppState>, doc: DocId) -> IdeResult<Vec<SpringProblem>> {
    ide_host::ops::spring::spring_problems(&state.host, window.label(), doc).await
}

/// The injection point at `pos` of an open Java file and the beans it can receive.
#[tauri::command]
#[specta::specta]
pub async fn spring_candidates(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    pos: Pos,
) -> IdeResult<Option<SpringCandidates>> {
    ide_host::ops::spring::spring_candidates(&state.host, window.label(), doc, pos).await
}

/// Opens a library bean (a JDT handle from a gutter target): its class file location.
#[tauri::command]
#[specta::specta]
pub async fn spring_locate(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    handle: String,
) -> IdeResult<Option<ide_core::Location>> {
    ide_host::ops::spring::spring_locate(&state.host, window.label(), doc, handle).await
}

/// The project's Spring application contexts (the Spring tool window).
#[tauri::command]
#[specta::specta]
pub async fn spring_contexts(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<SpringContextInfo>> {
    ide_host::ops::spring::spring_contexts(&state.host, window.label()).await
}

/// The beans of an application context (all beans without one).
#[tauri::command]
#[specta::specta]
pub async fn spring_beans(
    window: Window,
    state: State<'_, AppState>,
    context: Option<String>,
) -> IdeResult<Vec<SpringBeanInfo>> {
    ide_host::ops::spring::spring_beans(&state.host, window.label(), context).await
}

/// A bean with its dependencies and dependents.
#[tauri::command]
#[specta::specta]
pub async fn spring_bean_detail(
    window: Window,
    state: State<'_, AppState>,
    context: Option<String>,
    bean: String,
) -> IdeResult<Option<SpringBeanDetail>> {
    ide_host::ops::spring::spring_bean_detail(&state.host, window.label(), context, bean).await
}

/// The Bean dependency graph of a context, around `roots` up to `depth` steps (whole when empty).
#[tauri::command]
#[specta::specta]
pub async fn spring_graph(
    window: Window,
    state: State<'_, AppState>,
    context: Option<String>,
    roots: Vec<String>,
    depth: u32,
    libraries: bool,
) -> IdeResult<SpringGraph> {
    ide_host::ops::spring::spring_graph(&state.host, window.label(), context, roots, depth, libraries).await
}

/// Opens a library bean (its JDT handle) from the tool window or the graph; `path` is a Java
/// file of the project choosing the language server.
#[tauri::command]
#[specta::specta]
pub async fn spring_locate_at(
    window: Window,
    state: State<'_, AppState>,
    path: ide_core::IpcPath,
    handle: String,
) -> IdeResult<Option<ide_core::Location>> {
    ide_host::ops::spring::spring_locate_at(&state.host, window.label(), path, handle).await
}

/// The public members of a type (SpEL completion and navigation), from an open file's project.
#[tauri::command]
#[specta::specta]
pub async fn spring_members(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    fqn: String,
) -> IdeResult<Option<ide_host::ops::spring::SpringTypeMembers>> {
    ide_host::ops::spring::spring_members(&state.host, window.label(), doc, fqn).await
}
