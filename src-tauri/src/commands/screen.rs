//! Context from Screen (the agent composer's "+" menu): a region of the screen the user picks,
//! with the system's own capture UI.
//!
//! - macOS: `screencapture -i` (drag a region; Space for a window; Esc cancels).
//! - Windows: the Snipping overlay (`ms-screenclip:`, Win+Shift+S; Windows 10 1809+). It puts
//!   the snip on the clipboard, so a PowerShell script waits for the clipboard to change
//!   (`GetClipboardSequenceNumber`) and saves the new image. Nothing else touches the clipboard;
//!   when the overlay closes without a snip, the capture was cancelled.

use ide_core::{IdeError, IdeResult};
use std::path::Path;

/// Lets the user select a region of the screen and returns it as a `data:` URL, or `None`
/// when they cancelled the selection. macOS and Windows; an error elsewhere.
#[tauri::command]
#[specta::specta]
pub async fn screen_capture() -> IdeResult<Option<String>> {
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let path = std::env::temp_dir().join(format!("luma-screen-{}-{stamp}.png", std::process::id()));
    let captured = capture(&path).await;
    let url = match captured {
        Ok(true) if path.exists() => {
            let read = path.clone();
            tokio::task::spawn_blocking(move || ide_vfs::read_data_url(&read))
                .await
                .map_err(|e| IdeError::internal(e.to_string()))
                .and_then(|r| r)
                .map(Some)
        }
        Ok(_) => Ok(None),
        Err(e) => Err(e),
    };
    let _ = std::fs::remove_file(&path);
    url
}

/// A command for a system tool: no console window, the host's environment.
#[cfg(any(target_os = "macos", windows))]
fn tool(program: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    ide_core::process::prepare(cmd.as_std_mut());
    cmd
}

/// Runs the capture into `path`; `false` when the user cancelled.
#[cfg(target_os = "macos")]
async fn capture(path: &Path) -> IdeResult<bool> {
    // `-i`: select interactively; `-x`: no sound.
    let status = tool("/usr/sbin/screencapture")
        .arg("-i")
        .arg("-x")
        .arg(path)
        .status()
        .await
        .map_err(|e| IdeError::internal(format!("screencapture: {e}")))?;
    // Cancelled: no file.
    Ok(status.success() && path.exists())
}

/// Opens the Snipping overlay and saves the snip it puts on the clipboard to `$env:LUMA_CAPTURE`.
/// Exit code 0: saved; 2: cancelled (the overlay closed, or two minutes passed).
#[cfg(windows)]
const SNIP_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace Luma -Name Clipboard -MemberDefinition '[DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();'
$seq = [Luma.Clipboard]::GetClipboardSequenceNumber()
Start-Process 'ms-screenclip:'
$started = Get-Date
while (((Get-Date) - $started).TotalMinutes -lt 2) {
  Start-Sleep -Milliseconds 150
  $now = [Luma.Clipboard]::GetClipboardSequenceNumber()
  if ($now -ne $seq) {
    $seq = $now
    $image = $null
    for ($i = 0; $i -lt 10 -and -not $image; $i++) {
      try { $image = [System.Windows.Forms.Clipboard]::GetImage() } catch { Start-Sleep -Milliseconds 50 }
    }
    if ($image) { $image.Save($env:LUMA_CAPTURE, [System.Drawing.Imaging.ImageFormat]::Png); exit 0 }
  }
  $overlay = Get-Process -Name ScreenClippingHost, SnippingTool -ErrorAction SilentlyContinue
  if (((Get-Date) - $started).TotalSeconds -gt 3 -and -not $overlay) { exit 2 }
}
exit 2
"#;

#[cfg(windows)]
async fn capture(path: &Path) -> IdeResult<bool> {
    // `-STA`: the clipboard API needs a single-threaded apartment.
    let status = tool("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", SNIP_SCRIPT])
        .env("LUMA_CAPTURE", path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .map_err(|e| IdeError::internal(format!("powershell: {e}")))?;
    Ok(status.code() == Some(0) && path.exists())
}

#[cfg(not(any(target_os = "macos", windows)))]
async fn capture(_path: &Path) -> IdeResult<bool> {
    Err(IdeError::invalid("Context from Screen is available on macOS and Windows"))
}
