//! Tools › Web Browsers and Preview (IDEA's `WebBrowserManager` and `BuiltInServerOptions`):
//! the browsers Open In › Browser and the editor's browser popup offer, the default browser,
//! when pages reload, and how the built-in server listens.

use serde::{Deserialize, Serialize};
use specta::Type;

/// IDEA's predefined browsers keep their ids, so a default browser chosen there reads the same.
pub const CHROME_ID: &str = "98CA6316-2F89-46D9-A9E5-FA9E2B0625B3";
pub const FIREFOX_ID: &str = "A7BB68E0-33C0-4D6F-A81A-AAC1FDB870C8";
pub const SAFARI_ID: &str = "E5120D43-2C3F-47EF-9F26-65E539E05186";
pub const OPERA_ID: &str = "53E2F627-B1A7-4DFA-BFA7-5B83CC034776";
pub const EDGE_ID: &str = "37cae5b9-e8b2-4949-9172-aafa37fbc09c";
pub const PREDEFINED_IDS: [&str; 5] = [CHROME_ID, FIREFOX_ID, SAFARI_ID, OPERA_ID, EDGE_ID];

/// IDEA's built-in server port.
pub const DEFAULT_SERVER_PORT: u16 = 63342;

/// What a browser understands (its command-line options and profiles).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BrowserFamily {
    Chrome,
    Firefox,
    Safari,
}

impl BrowserFamily {
    /// The path a browser of this family has by default: an application name on macOS
    /// (`open -a`), a command elsewhere.
    pub fn execution_path(self) -> Option<&'static str> {
        let (windows, unix, mac) = match self {
            Self::Chrome => ("chrome", Some("google-chrome"), Some("Google Chrome")),
            Self::Firefox => ("firefox", Some("firefox"), Some("Firefox")),
            Self::Safari => ("safari", None, Some("Safari")),
        };
        if cfg!(windows) {
            Some(windows)
        } else if cfg!(target_os = "macos") {
            mac
        } else {
            unix
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Chrome => "Chrome",
            Self::Firefox => "Firefox",
            Self::Safari => "Safari",
        }
    }
}

/// When a page served by the built-in server reloads (IDEA's `ReloadMode`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ReloadMode {
    Disabled,
    /// When a file the page loaded is saved.
    #[default]
    OnSave,
    /// As files the page loaded are edited: they are saved on every change.
    OnChange,
}

/// Family-specific launch options (IDEA's `ChromeSettings` / `FirefoxSettings`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct BrowserSpecificSettings {
    /// Chrome: extra command-line options, shell-quoted.
    pub command_line_options: String,
    /// Chrome: start with `--user-data-dir=<user_data_dir>`.
    pub use_custom_profile: bool,
    pub user_data_dir: String,
    /// Firefox: `profiles.ini`; empty: the platform's default location.
    pub profiles_ini_path: String,
    /// Firefox: the profile to start with (`-P`); empty: the default profile.
    pub profile: String,
}

/// A browser of the list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct ConfiguredBrowser {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub family: Option<BrowserFamily>,
    /// An executable, or on macOS an application name; empty: the browser cannot start.
    pub path: String,
    /// Listed in Open In › Browser and the editor's browser popup.
    pub active: bool,
    pub settings: BrowserSpecificSettings,
}

impl Default for ConfiguredBrowser {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            family: None,
            path: String::new(),
            active: true,
            settings: BrowserSpecificSettings::default(),
        }
    }
}

impl ConfiguredBrowser {
    fn predefined(id: &str, family: BrowserFamily, name: &str, path: Option<&str>, active: bool) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            family: Some(family),
            path: path.unwrap_or_default().into(),
            active,
            settings: BrowserSpecificSettings::default(),
        }
    }
}

/// IDEA's predefined browsers, in its order: Chrome and Firefox on, Safari on macOS, Opera off,
/// Edge on Windows.
pub fn predefined_browsers() -> Vec<ConfiguredBrowser> {
    use BrowserFamily::*;
    let edge = if cfg!(windows) {
        "msedge"
    } else if cfg!(target_os = "macos") {
        "Microsoft Edge"
    } else {
        "microsoft-edge"
    };
    vec![
        ConfiguredBrowser::predefined(CHROME_ID, Chrome, "Chrome", Chrome.execution_path(), true),
        ConfiguredBrowser::predefined(FIREFOX_ID, Firefox, "Firefox", Firefox.execution_path(), true),
        ConfiguredBrowser::predefined(SAFARI_ID, Safari, "Safari", Safari.execution_path(), cfg!(target_os = "macos")),
        ConfiguredBrowser::predefined(
            OPERA_ID,
            Chrome,
            "Opera",
            Some(if cfg!(target_os = "macos") { "Opera" } else { "opera" }),
            false,
        ),
        ConfiguredBrowser::predefined(EDGE_ID, Chrome, "Edge", Some(edge), cfg!(windows)),
    ]
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct WebBrowserSettings {
    pub browsers: Vec<ConfiguredBrowser>,
    /// The id of an active browser with a path; empty: the system default browser.
    pub default_browser: String,
    /// The editor's browser popup on HTML files.
    pub show_hover: bool,
    /// The editor's browser popup on XML files.
    pub show_hover_xml: bool,
    /// Pages opened in a browser.
    pub server_reload_mode: ReloadMode,
    /// The built-in preview.
    pub preview_reload_mode: ReloadMode,
}

impl Default for WebBrowserSettings {
    fn default() -> Self {
        Self {
            browsers: predefined_browsers(),
            default_browser: String::new(),
            show_hover: true,
            show_hover_xml: false,
            server_reload_mode: ReloadMode::OnSave,
            preview_reload_mode: ReloadMode::OnSave,
        }
    }
}

impl WebBrowserSettings {
    /// The default browser: the chosen one when it is active and has a path, else `None` (the
    /// system default).
    pub fn default_browser(&self) -> Option<&ConfiguredBrowser> {
        self.browsers
            .iter()
            .find(|b| !self.default_browser.is_empty() && b.id == self.default_browser)
            .filter(|b| b.active && !b.path.trim().is_empty())
    }
}

/// The built-in server (IDEA's `BuiltInServerOptions`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct BuiltInServerSettings {
    pub port: u16,
    /// Listen on every interface. Only for a port below the default one, as in IDEA.
    pub available_externally: bool,
    /// Serve `/<project>/<path>` without the per-run token.
    pub allow_unsigned_requests: bool,
}

impl Default for BuiltInServerSettings {
    fn default() -> Self {
        Self { port: DEFAULT_SERVER_PORT, available_externally: false, allow_unsigned_requests: false }
    }
}

impl BuiltInServerSettings {
    /// The port to bind, clamped to the range the settings accept.
    pub fn effective_port(&self) -> u16 {
        if self.port < 1024 { DEFAULT_SERVER_PORT } else { self.port }
    }

    /// External connections are honoured only with a port below the default one.
    pub fn effective_external(&self) -> bool {
        self.available_externally && self.effective_port() < DEFAULT_SERVER_PORT
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_browser_must_be_active_with_a_path() {
        let mut s = WebBrowserSettings::default();
        assert!(s.default_browser().is_none());
        s.default_browser = FIREFOX_ID.into();
        assert_eq!(s.default_browser().map(|b| b.name.as_str()), Some("Firefox"));
        s.browsers[1].active = false;
        assert!(s.default_browser().is_none());
        s.browsers[1].active = true;
        s.browsers[1].path.clear();
        assert!(s.default_browser().is_none());
    }

    #[test]
    fn external_connections_need_a_custom_low_port() {
        let mut s = BuiltInServerSettings { available_externally: true, ..Default::default() };
        assert!(!s.effective_external());
        s.port = 8080;
        assert!(s.effective_external());
        s.port = 70;
        assert_eq!(s.effective_port(), DEFAULT_SERVER_PORT);
    }

    #[test]
    fn reads_partial_values() {
        let s: WebBrowserSettings =
            serde_json::from_str(r#"{"serverReloadMode":"onChange","browsers":[{"id":"x","name":"Arc"}]}"#).unwrap();
        assert_eq!(s.server_reload_mode, ReloadMode::OnChange);
        assert_eq!(s.preview_reload_mode, ReloadMode::OnSave);
        assert!(s.show_hover && !s.show_hover_xml);
        assert_eq!(s.browsers.len(), 1);
        assert!(s.browsers[0].active && s.browsers[0].family.is_none());
    }
}
