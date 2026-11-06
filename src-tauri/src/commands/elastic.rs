//! Elasticsearch data sources: cluster, indices, fields, REST requests, the console.
//! Targets are data source ids (see `ide_db::elastic`).

use crate::state::AppState;
use ide_core::{IdeResult, RequestId};
use ide_db::{EsCluster, EsField, EsIndices, EsResponse};
use tauri::{State, Window};

/// Name, version, health, nodes, shards and totals of data source `id`'s cluster.
#[tauri::command]
#[specta::specta]
pub async fn es_cluster(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<EsCluster> {
    let db = state.project(window.label())?.db.clone();
    db.es_cluster(&id).await
}

/// Indices (hidden ones included), data streams and aliases of data source `id`.
#[tauri::command]
#[specta::specta]
pub async fn es_indices(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<EsIndices> {
    let db = state.project(window.label())?.db.clone();
    db.es_indices(&id).await
}

/// Fields of `index` (a name, alias, data stream or pattern) with their types and abilities.
#[tauri::command]
#[specta::specta]
pub async fn es_fields(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    index: String,
) -> IdeResult<Vec<EsField>> {
    let db = state.project(window.label())?.db.clone();
    db.es_fields(&id, &index).await
}

/// One REST request (`GET /logs/_search` with a JSON body). Cancel with `cancel_request(request)`.
#[tauri::command]
#[specta::specta]
pub async fn es_request(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    id: String,
    method: String,
    path: String,
    body: Option<String>,
) -> IdeResult<EsResponse> {
    let db = state.project(window.label())?.db.clone();
    let cancel = state.begin_request(request);
    let r = db.es_request(&id, &method, &path, body.as_deref(), &cancel).await;
    state.end_request(request);
    r
}

/// The console file of data source `id` (`console.es`, Kibana Dev Tools syntax), created empty.
#[tauri::command]
#[specta::specta]
pub fn es_console_path(state: State<'_, AppState>, id: String) -> IdeResult<ide_core::IpcPath> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(ide_core::IdeError::invalid("invalid data source id"));
    }
    let dir = state.data_dir.join("consoles").join("db").join(&id);
    std::fs::create_dir_all(&dir)?;
    let file = dir.join("console.es");
    if !file.exists() {
        std::fs::write(&file, "")?;
    }
    Ok(file.into())
}
