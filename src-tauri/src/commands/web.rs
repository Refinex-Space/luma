//! Web browsers (Settings › Tools › Web Browsers and Preview): the built-in server's URLs,
//! live reload and launching browsers of the list.

use super::coverage::blocking;
use crate::state::AppState;
use ide_core::settings::ReloadMode;
use ide_core::{IdeError, IdeResult, IpcPath};
use ide_web::FirefoxProfiles;
use tauri::{State, Window};

/// The built-in server's URL for `path` (started on first use, with the current Built-in
/// Server settings). A reload mode asks for the live reload script.
#[tauri::command]
#[specta::specta]
pub async fn web_url(
    window: Window,
    state: State<'_, AppState>,
    path: IpcPath,
    reload: Option<ReloadMode>,
) -> IdeResult<String> {
    let root = state.project(window.label()).ok().map(|p| p.root.clone());
    state.web.configure(&state.global_settings.effective().built_in_server).await;
    state.web.url_for(root.as_deref(), &path, reload.unwrap_or(ReloadMode::Disabled)).await
}

/// Opens `url` in browser `browser` (an id of the list), or in the default browser: the one
/// chosen in the settings, else the system default.
#[tauri::command]
#[specta::specta]
pub async fn web_open(state: State<'_, AppState>, url: String, browser: Option<String>) -> IdeResult<()> {
    let settings = state.global_settings.effective().web_browsers;
    let chosen = match &browser {
        Some(id) => Some(
            settings
                .browsers
                .iter()
                .find(|b| &b.id == id)
                .cloned()
                .ok_or_else(|| IdeError::invalid(format!("unknown browser: {id}")))?,
        ),
        None => settings.default_browser().cloned(),
    };
    blocking(move || match chosen {
        Some(b) => ide_web::launch(&url, &b),
        None => ide_web::open_default(&url),
    })
    .await
}

/// Whether a page reloading on change loaded `path` (its editor saves as it is edited).
#[tauri::command]
#[specta::specta]
pub fn web_tracked_on_change(state: State<'_, AppState>, path: IpcPath) -> bool {
    state.web.tracked_on_change(&path)
}

/// The Firefox profiles of `profiles_ini` (or of the default `profiles.ini`).
#[tauri::command]
#[specta::specta]
pub async fn web_firefox_profiles(profiles_ini: Option<String>) -> IdeResult<FirefoxProfiles> {
    blocking(move || {
        let ini = profiles_ini.filter(|p| !p.trim().is_empty()).map(std::path::PathBuf::from);
        Ok(ide_web::firefox_profiles(ini.as_deref()))
    })
    .await
}

/// Chrome's user data directory when "Use custom user data directory" has none (IDEA keeps
/// it in its configuration directory).
#[tauri::command]
#[specta::specta]
pub fn web_chrome_user_data_dir(state: State<'_, AppState>) -> String {
    ide_core::ipc_path::to_ipc(&state.config_dir.join("chrome-user-data"))
}
