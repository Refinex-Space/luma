//! Redis data sources: keyspace, key scan, values by page, writes, the console.
//! Targets are `<data source id>:<database index>` (see `ide_db::redis`).

use crate::state::AppState;
use ide_core::{IdeResult, RequestId};
use ide_db::{
    RedisBytes, RedisCommandInput, RedisCommandOutcome, RedisKeyInfo, RedisKeyspace, RedisPageRequest, RedisReply,
    RedisScanPage, RedisValuePage,
};
use tauri::{State, Window};

/// Databases of the server of data source `id` with their key counts, its version and mode.
#[tauri::command]
#[specta::specta]
pub async fn redis_keyspace(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<RedisKeyspace> {
    let db = state.project(window.label())?.db.clone();
    db.redis_keyspace(&id).await
}

/// Keys of `target` matching `pattern` (of type `kind`), continuing from `cursor` (`0`: the start).
#[tauri::command]
#[specta::specta]
pub async fn redis_scan(
    window: Window,
    state: State<'_, AppState>,
    target: String,
    pattern: String,
    kind: Option<String>,
    cursor: String,
    limit: u32,
) -> IdeResult<RedisScanPage> {
    let db = state.project(window.label())?.db.clone();
    db.redis_scan(&target, &pattern, kind.as_deref(), &cursor, limit).await
}

#[tauri::command]
#[specta::specta]
pub async fn redis_key_info(
    window: Window,
    state: State<'_, AppState>,
    target: String,
    key: RedisBytes,
) -> IdeResult<RedisKeyInfo> {
    let db = state.project(window.label())?.db.clone();
    db.redis_key_info(&target, &key).await
}

#[tauri::command]
#[specta::specta]
pub async fn redis_value(
    window: Window,
    state: State<'_, AppState>,
    target: String,
    key: RedisBytes,
    kind: String,
    page: RedisPageRequest,
) -> IdeResult<RedisValuePage> {
    let db = state.project(window.label())?.db.clone();
    db.redis_value(&target, &key, &kind, &page).await
}

/// One command on `target` (the key editor's and the tree's writes; read-only sources refuse writes).
#[tauri::command]
#[specta::specta]
pub async fn redis_command(
    window: Window,
    state: State<'_, AppState>,
    target: String,
    args: Vec<RedisBytes>,
) -> IdeResult<RedisReply> {
    let db = state.project(window.label())?.db.clone();
    db.redis_command(&target, &args).await
}

/// `commands` in one MULTI / EXEC.
#[tauri::command]
#[specta::specta]
pub async fn redis_transaction(
    window: Window,
    state: State<'_, AppState>,
    target: String,
    commands: Vec<Vec<RedisBytes>>,
) -> IdeResult<Vec<RedisReply>> {
    let db = state.project(window.label())?.db.clone();
    db.redis_transaction(&target, &commands).await
}

/// Console command lines, in order, stopping at the first error. Cancel with `cancel_request(request)`.
#[tauri::command]
#[specta::specta]
pub async fn redis_execute(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    target: String,
    commands: Vec<RedisCommandInput>,
) -> IdeResult<Vec<RedisCommandOutcome>> {
    let db = state.project(window.label())?.db.clone();
    let cancel = state.begin_request(request);
    let r = db.redis_execute(&target, &commands, &cancel).await;
    state.end_request(request);
    r
}

/// Deletes the keys of `target` matching `pattern`; how many. Cancel with `cancel_request(request)`.
#[tauri::command]
#[specta::specta]
pub async fn redis_delete_matching(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    target: String,
    pattern: String,
) -> IdeResult<f64> {
    let db = state.project(window.label())?.db.clone();
    let cancel = state.begin_request(request);
    let r = db.redis_delete_matching(&target, &pattern, &cancel).await;
    state.end_request(request);
    r
}

/// `INFO` of the server of `id` (every section, or `section`).
#[tauri::command]
#[specta::specta]
pub async fn redis_info(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    section: Option<String>,
) -> IdeResult<String> {
    let db = state.project(window.label())?.db.clone();
    db.redis_info(&id, section.as_deref()).await
}

/// The console file of Redis data source `id` (`<appData>/consoles/db/<id>/console.redis`),
/// one per data source: the console's toolbar picks the database.
#[tauri::command]
#[specta::specta]
pub fn redis_console_path(state: State<'_, AppState>, id: String) -> IdeResult<ide_core::IpcPath> {
    let source = ide_db::split_target(&id).0;
    if source.is_empty() || !source.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(ide_core::IdeError::invalid("invalid data source id"));
    }
    let dir = state.data_dir.join("consoles").join("db").join(source);
    std::fs::create_dir_all(&dir)?;
    let file = dir.join("console.redis");
    if !file.exists() {
        std::fs::write(&file, "")?;
    }
    Ok(file.into())
}

/// Subscribes to `channels` and `patterns` of `target`'s server; messages stream through
/// `on_message` until `cancel_request(request)`.
#[tauri::command]
#[specta::specta]
pub async fn redis_subscribe(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    target: String,
    channels: Vec<String>,
    patterns: Vec<String>,
    on_message: tauri::ipc::Channel<ide_db::RedisMessage>,
) -> IdeResult<()> {
    let db = state.project(window.label())?.db.clone();
    let cancel = state.begin_request(request);
    let r = db
        .redis_subscribe(
            &target,
            &channels,
            &patterns,
            move |m| {
                let _ = on_message.send(m);
            },
            &cancel,
        )
        .await;
    state.end_request(request);
    r
}
