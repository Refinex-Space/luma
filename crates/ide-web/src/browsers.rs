//! Launching browsers: a browser of the list (IDEA's `WebBrowser.browse` and
//! `BrowserUtil.getOpenBrowserCommand`) or the system default browser.

use ide_core::settings::{BrowserFamily, ConfiguredBrowser};
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn check_url(url: &str) -> IdeResult<()> {
    if url.starts_with("http://") || url.starts_with("https://") || url.starts_with("file://") {
        Ok(())
    } else {
        Err(IdeError::invalid(format!("not a web URL: {url}")))
    }
}

/// Opens `url` in the system default browser.
pub fn open_default(url: &str) -> IdeResult<()> {
    check_url(url)?;
    #[cfg(target_os = "linux")]
    let result = spawn_with_host_env(open::commands(url));
    #[cfg(not(target_os = "linux"))]
    let result = open::that_detached(url);
    result.map_err(|e| IdeError::unavailable(format!("cannot open the browser: {e}")))
}

/// Opens `url` in `browser`, with its family's options.
pub fn launch(url: &str, browser: &ConfiguredBrowser) -> IdeResult<()> {
    check_url(url)?;
    let path = browser.path.trim();
    if path.is_empty() {
        return Err(IdeError::invalid(format!(
            "{} has no path: set it in Settings › Tools › Web Browsers and Preview",
            browser.name
        )));
    }
    let argv = open_command(path, url, &additional_parameters(browser), Path::new(path).is_file());
    let (program, args) = argv.split_first().expect("a command");
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(target_os = "linux")]
    ide_core::process::prepare(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| IdeError::unavailable(format!("cannot start {}: {e}", browser.name)))?;
    // `open -a` and `start` return at once: their failure (an unknown application) is the
    // user's to see. A browser started directly keeps running, so its exit is not waited for.
    if is_launcher(&argv) {
        let out = child.wait_with_output().map_err(|e| IdeError::unavailable(e.to_string()))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_owned();
            return Err(IdeError::unavailable(if err.is_empty() {
                format!("cannot start {} ({})", browser.name, browser.path)
            } else {
                err
            }));
        }
    } else {
        std::thread::spawn(move || child.wait());
    }
    Ok(())
}

fn is_launcher(argv: &[String]) -> bool {
    argv.first().is_some_and(|p| p == "open" || p.eq_ignore_ascii_case("cmd"))
}

/// IDEA's `BrowserUtil.getOpenBrowserCommand`: a file runs with the parameters and the URL; a
/// name goes through `open -a` on macOS and `start` on Windows, and runs as a command elsewhere.
pub fn open_command(path: &str, url: &str, parameters: &[String], is_file: bool) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if !is_file {
        if cfg!(target_os = "macos") {
            out.extend(["open".into(), "-a".into(), path.into(), url.into()]);
            if !parameters.is_empty() {
                out.push("--args".into());
                out.extend(parameters.iter().cloned());
            }
            return out;
        }
        if cfg!(windows) {
            // An empty title: `start` takes a first quoted argument for one.
            out.extend(["cmd".into(), "/c".into(), "start".into(), String::new(), path.into()]);
            out.extend(parameters.iter().cloned());
            out.push(url.into());
            return out;
        }
    }
    out.push(path.into());
    out.extend(parameters.iter().cloned());
    out.push(url.into());
    out
}

/// The options a browser of the list starts with (IDEA's `getAdditionalParameters`).
pub fn additional_parameters(browser: &ConfiguredBrowser) -> Vec<String> {
    let s = &browser.settings;
    match browser.family {
        Some(BrowserFamily::Chrome) => {
            let mut out = split_options(&s.command_line_options);
            if s.use_custom_profile && !s.user_data_dir.trim().is_empty() {
                out.push(format!("--user-data-dir={}", s.user_data_dir.trim()));
            }
            out
        }
        Some(BrowserFamily::Firefox) => {
            let ini = if s.profiles_ini_path.trim().is_empty() {
                default_profiles_ini()
            } else {
                Some(PathBuf::from(s.profiles_ini_path.trim()))
            };
            let profiles = ini.as_deref().map(read_profiles).unwrap_or_default();
            // With one profile there is nothing to choose; the default needs no option.
            if profiles.len() >= 2
                && let Some(p) = find_profile(&profiles, &s.profile)
                && !p.default
            {
                return vec!["-P".into(), p.name.clone()];
            }
            Vec::new()
        }
        _ => Vec::new(),
    }
}

/// `--a "b c" 'd e'` → its options, quotes removed.
fn split_options(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for c in line.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (None, '"' | '\'') => {
                quote = Some(c);
                started = true;
            }
            (None, c) if c.is_whitespace() => {
                if started {
                    out.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            (_, c) => {
                current.push(c);
                started = true;
            }
        }
    }
    if started {
        out.push(current);
    }
    out
}

/// A Firefox profile of `profiles.ini`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FirefoxProfile {
    pub name: String,
    pub default: bool,
}

/// The default `profiles.ini` and the profiles of `ini` (or of the default one).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FirefoxProfiles {
    pub default_ini_path: Option<String>,
    pub profiles: Vec<FirefoxProfile>,
}

pub fn firefox_profiles(ini: Option<&Path>) -> FirefoxProfiles {
    let default = default_profiles_ini();
    let ini = ini.map(Path::to_path_buf).or_else(|| default.clone());
    FirefoxProfiles {
        default_ini_path: default.map(|p| p.to_string_lossy().into_owned()),
        profiles: ini.as_deref().map(read_profiles).unwrap_or_default(),
    }
}

fn find_profile<'a>(profiles: &'a [FirefoxProfile], name: &str) -> Option<&'a FirefoxProfile> {
    profiles.iter().find(|p| p.name == name).or_else(|| profiles.iter().find(|p| p.default)).or(profiles.first())
}

fn read_profiles(ini: &Path) -> Vec<FirefoxProfile> {
    std::fs::read_to_string(ini).map(|t| parse_profiles(&t)).unwrap_or_default()
}

/// IDEA's `FirefoxUtil.computeProfiles`: `[Profile*]` sections with a name and a path.
fn parse_profiles(text: &str) -> Vec<FirefoxProfile> {
    let mut out = Vec::new();
    let (mut inside, mut name, mut path, mut default) = (false, String::new(), String::new(), false);
    for line in text.lines().map(str::trim).chain(std::iter::once("[]")) {
        if line.starts_with('[') && line.ends_with(']') {
            if inside && !name.is_empty() && !path.is_empty() {
                out.push(FirefoxProfile { name: std::mem::take(&mut name), default });
            }
            name.clear();
            path.clear();
            default = false;
            inside = line.to_ascii_lowercase().starts_with("[profile");
            continue;
        }
        if let Some((k, v)) = line.split_once('=')
            && inside
        {
            let (k, v) = (k.trim(), v.trim());
            if k.eq_ignore_ascii_case("path") {
                path = v.into();
            } else if k.eq_ignore_ascii_case("name") {
                name = v.into();
            } else if k.eq_ignore_ascii_case("default") && v == "1" {
                default = true;
            }
        }
    }
    out
}

fn default_profiles_ini() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)?;
    let dirs: Vec<PathBuf> = if cfg!(target_os = "macos") {
        vec![home.join("Library/Mozilla/Firefox"), home.join("Library/Application Support/Firefox")]
    } else if cfg!(windows) {
        let mut v: Vec<PathBuf> =
            std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join(r"Mozilla\Firefox")).into_iter().collect();
        v.push(home.join(r"AppData\Roaming\Mozilla\Firefox"));
        v
    } else {
        vec![home.join(".mozilla/firefox")]
    };
    dirs.into_iter().map(|d| d.join("profiles.ini")).find(|p| p.is_file())
}

/// Starts the first launcher that runs (`xdg-open`, `gio`, ...), with the host's environment
/// rather than an AppImage's, and reaps it in the background.
#[cfg(target_os = "linux")]
fn spawn_with_host_env(commands: Vec<Command>) -> std::io::Result<()> {
    let mut last_err = None;
    for mut cmd in commands {
        ide_core::process::prepare(&mut cmd).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        match cmd.spawn() {
            Ok(mut child) => {
                std::thread::spawn(move || child.wait());
                return Ok(());
            }
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::other("no launcher available")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::settings::BrowserSpecificSettings;

    fn browser(family: Option<BrowserFamily>, settings: BrowserSpecificSettings) -> ConfiguredBrowser {
        ConfiguredBrowser { id: "x".into(), name: "X".into(), family, path: "x".into(), active: true, settings }
    }

    #[test]
    fn refuses_non_web_urls() {
        assert!(open_default("/etc/passwd").is_err());
        assert!(open_default("javascript:alert(1)").is_err());
        assert!(launch("javascript:alert(1)", &browser(None, Default::default())).is_err());
    }

    #[test]
    fn a_file_runs_directly() {
        let argv = open_command("/opt/b/browser", "http://h/", &["--x".into()], true);
        assert_eq!(argv, ["/opt/b/browser", "--x", "http://h/"]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_application_name_opens_with_open_a() {
        let argv = open_command("Google Chrome", "http://h/", &["--incognito".into()], false);
        assert_eq!(argv, ["open", "-a", "Google Chrome", "http://h/", "--args", "--incognito"]);
        assert_eq!(open_command("Safari", "http://h/", &[], false), ["open", "-a", "Safari", "http://h/"]);
    }

    #[test]
    fn chrome_options_and_profile() {
        let s = BrowserSpecificSettings {
            command_line_options: r#"--incognito --window-size="800,600" '--lang=zh CN'"#.into(),
            use_custom_profile: true,
            user_data_dir: "/tmp/chrome data".into(),
            ..Default::default()
        };
        assert_eq!(
            additional_parameters(&browser(Some(BrowserFamily::Chrome), s.clone())),
            ["--incognito", "--window-size=800,600", "--lang=zh CN", "--user-data-dir=/tmp/chrome data"]
        );
        let off = BrowserSpecificSettings { use_custom_profile: false, ..s };
        assert_eq!(additional_parameters(&browser(Some(BrowserFamily::Chrome), off)).len(), 3);
        // Other families ignore Chrome's options.
        let s = BrowserSpecificSettings { command_line_options: "--x".into(), ..Default::default() };
        assert!(additional_parameters(&browser(Some(BrowserFamily::Safari), s)).is_empty());
    }

    #[test]
    fn firefox_profiles_from_ini() {
        let dir = tempfile::tempdir().unwrap();
        let ini = dir.path().join("profiles.ini");
        std::fs::write(
            &ini,
            "[General]\nStartWithLastProfile=1\n\n[Profile1]\nName=dev\nIsRelative=1\nPath=a.dev\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=b.default\nDefault=1\n\n[Install4F96]\nDefault=b.default\n",
        )
        .unwrap();
        let p = firefox_profiles(Some(&ini)).profiles;
        assert_eq!(
            p,
            [
                FirefoxProfile { name: "dev".into(), default: false },
                FirefoxProfile { name: "default-release".into(), default: true }
            ]
        );
        let s = |profile: &str| BrowserSpecificSettings {
            profiles_ini_path: ini.to_string_lossy().into_owned(),
            profile: profile.into(),
            ..Default::default()
        };
        assert_eq!(additional_parameters(&browser(Some(BrowserFamily::Firefox), s("dev"))), ["-P", "dev"]);
        // The default profile, or an unknown one (falls back to the default), needs no option.
        assert!(additional_parameters(&browser(Some(BrowserFamily::Firefox), s("default-release"))).is_empty());
        assert!(additional_parameters(&browser(Some(BrowserFamily::Firefox), s("gone"))).is_empty());
    }
}
