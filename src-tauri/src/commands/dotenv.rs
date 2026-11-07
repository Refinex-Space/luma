//! IPC commands of `ide_host::ops::dotenv` (the shared implementation).

use crate::state::AppState;
use ide_core::IdeResult;
use ide_host::ops::dotenv::DotEnvSource;
use tauri::{State, Window};

/// The project's files declaring environment variables: `.env` files (git-ignored ones
/// included), `docker-compose.yml` and Dockerfiles.
#[tauri::command]
#[specta::specta]
pub async fn dotenv_files(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<DotEnvSource>> {
    ide_host::ops::dotenv::dotenv_files(&state.host, window.label()).await
}
