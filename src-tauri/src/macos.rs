//! macOS window tab preferences, applied to application-drawn project tabs.
use crate::windows::{Launch, WindowsState};
use ide_core::{IdeError, IdeResult};
use ide_workspace::window_groups::{TabbingPreference, should_group_new_project};
use objc2::{MainThreadMarker, rc::Retained, runtime::ProtocolObject};
use objc2_app_kit::{NSWindow, NSWindowUserTabbingPreference};
use objc2_foundation::{NSNotificationCenter, NSObjectProtocol};
use tauri::{AppHandle, Manager, WebviewWindow};

fn tabbing_preference(app: &AppHandle) -> IdeResult<TabbingPreference> {
    fn read(mtm: MainThreadMarker) -> TabbingPreference {
        match NSWindow::userTabbingPreference(mtm) {
            NSWindowUserTabbingPreference::Always => TabbingPreference::Always,
            NSWindowUserTabbingPreference::InFullScreen => TabbingPreference::InFullScreen,
            _ => TabbingPreference::Manually,
        }
    }
    if let Some(mtm) = MainThreadMarker::new() {
        return Ok(read(mtm));
    }
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = tx.send(read(MainThreadMarker::new().expect("AppKit main thread")));
    })
    .map_err(|e| IdeError::internal(e.to_string()))?;
    rx.recv().map_err(|e| IdeError::internal(e.to_string()))
}

/// Capture before building the new window, which takes focus itself.
pub fn new_project_tab_target(app: &AppHandle, launch: &Launch) -> IdeResult<Option<WebviewWindow>> {
    let windows = app.webview_windows();
    let active = windows
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .cloned()
        .or_else(|| app.state::<WindowsState>().last_focused().and_then(|label| windows.get(&label).cloned()));
    let active = active.and_then(|w| {
        let label = crate::windows::settings_parent(w.label()).unwrap_or(w.label());
        windows.get(label).cloned()
    });
    let active = active.filter(|w| {
        let host = app.state::<crate::state::AppState>();
        host.project(w.label()).is_ok_and(|p| !p.light) || host.remote_dev.get(w.label()).is_some()
    });
    let fullscreen = active.as_ref().is_some_and(|w| w.is_fullscreen().unwrap_or(false));
    let light_edit = launch.project.is_none() && launch.remote.is_none();
    Ok(should_group_new_project(tabbing_preference(app)?, fullscreen, active.is_some(), light_edit)
        .then_some(active)
        .flatten())
}

struct FullscreenObserver(Retained<ProtocolObject<dyn NSObjectProtocol>>);

impl Drop for FullscreenObserver {
    fn drop(&mut self) {
        let observer: &ProtocolObject<dyn NSObjectProtocol> = &self.0;
        unsafe { NSNotificationCenter::defaultCenter().removeObserver(observer.as_ref()) };
    }
}

thread_local! {
    static FULLSCREEN_TRANSFERS: std::cell::RefCell<std::collections::HashMap<String, FullscreenObserver>> = std::cell::RefCell::default();
}

pub fn forget_fullscreen(label: &str) {
    FULLSCREEN_TRANSFERS.with_borrow_mut(|observers| observers.remove(label));
}

/// AppKit cannot enter another window's fullscreen Space until the old one has exited.
pub fn transfer_fullscreen(from: &WebviewWindow, to: &WebviewWindow) -> tauri::Result<()> {
    let source = from.label().to_owned();
    let to = to.clone();
    from.with_webview(move |webview| unsafe {
        let native = &*webview.ns_window().cast::<NSWindow>();
        forget_fullscreen(&source);
        let label = source.clone();
        let block = block2::RcBlock::new(move |_| {
            forget_fullscreen(&label);
            let app = to.app_handle();
            let selected = app.state::<WindowsState>().groups.lock().group(to.label()).map(|g| g.selected.clone());
            if let Some(selected) = selected {
                // Exiting fullscreen can show the old window again; reapply group visibility.
                let _ = crate::window_groups::select(app, &selected, &selected);
                if selected == to.label() {
                    let _ = to.set_fullscreen(true);
                }
            }
        });
        let observer = NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(objc2_app_kit::NSWindowDidExitFullScreenNotification),
            Some(native),
            None,
            &block,
        );
        FULLSCREEN_TRANSFERS.with_borrow_mut(|observers| observers.insert(source, FullscreenObserver(observer)));
        native.toggleFullScreen(None);
    })
}

/// Space between the longest label of a menu and its shortcut column, in points.
const SHORTCUT_GAP: f64 = 24.0;

/// Where a menu's right-aligned shortcut column ends: after its longest label, a gap, and its
/// longest shortcut.
pub(crate) fn shortcut_column(label_widths: &[f64], shortcut_widths: &[f64]) -> f64 {
    let widest = |w: &[f64]| w.iter().copied().fold(0.0, f64::max);
    (widest(label_widths) + SHORTCUT_GAP + widest(shortcut_widths)).ceil()
}

/// Lines up the shortcuts of the app menu in a right-aligned column.
///
/// Menu items carry their shortcut as display text after a tab (`Save All\t⌘S`, see `menu.rs`:
/// native key equivalents would take keys before the webview). AppKit draws that tab as plain
/// text, so each shortcut followed its label's length. Here every item of a menu gets an
/// attributed title with one right-aligned tab stop shared by the whole menu: the shortcuts end
/// on the same edge, as the system's own key equivalents do. No colour is set, so highlighting
/// and the disabled state still draw as for a plain title.
pub fn align_menu_shortcuts(mtm: MainThreadMarker) {
    use objc2_app_kit::NSApplication;
    if let Some(menu) = NSApplication::sharedApplication(mtm).mainMenu() {
        align_menu(&menu);
    }
}

fn align_menu(menu: &objc2_app_kit::NSMenu) {
    use objc2::{AnyThread, runtime::AnyObject};
    use objc2_app_kit::{
        NSAttributedStringNSStringDrawing, NSFont, NSFontAttributeName, NSMenuItem, NSMutableParagraphStyle,
        NSParagraphStyleAttributeName, NSTextAlignment, NSTextTab,
    };
    use objc2_foundation::{NSArray, NSAttributedString, NSAttributedStringKey, NSDictionary, NSString};

    let font = NSFont::menuFontOfSize(0.0);
    // SAFETY: AppKit's attribute key constants, valid for the process lifetime.
    let (font_key, style_key): (&NSAttributedStringKey, &NSAttributedStringKey) =
        unsafe { (NSFontAttributeName, NSParagraphStyleAttributeName) };
    let measure = |text: &str| {
        let font_obj: &AnyObject = &font;
        let attrs = NSDictionary::from_slices(&[font_key], &[font_obj]);
        // SAFETY: a font attribute dictionary, as NSStringDrawing expects.
        let s = unsafe { NSAttributedString::new_with_attributes(&NSString::from_str(text), &attrs) };
        s.size().width
    };

    let mut items: Vec<(objc2::rc::Retained<NSMenuItem>, String)> = Vec::new();
    let (mut labels, mut shortcuts) = (Vec::new(), Vec::new());
    for item in menu.itemArray().iter() {
        if let Some(sub) = item.submenu() {
            align_menu(&sub);
        }
        let title = item.title().to_string();
        if let Some((label, shortcut)) = title.split_once('\t') {
            labels.push(measure(label));
            shortcuts.push(measure(shortcut));
            items.push((item.clone(), title));
        }
    }
    if items.is_empty() {
        return;
    }
    let column = shortcut_column(&labels, &shortcuts);
    // SAFETY: a right-aligned tab stop without options.
    let tab = unsafe {
        NSTextTab::initWithTextAlignment_location_options(
            NSTextTab::alloc(),
            NSTextAlignment::Right,
            column,
            &NSDictionary::new(),
        )
    };
    let style = NSMutableParagraphStyle::new();
    style.setTabStops(Some(&NSArray::from_retained_slice(&[tab])));
    let font_obj: &AnyObject = &font;
    let style_obj: &AnyObject = &style;
    let attrs = NSDictionary::from_slices(&[font_key, style_key], &[font_obj, style_obj]);
    for (item, title) in items {
        // SAFETY: font and paragraph style attributes, as a menu title takes.
        let s = unsafe { NSAttributedString::new_with_attributes(&NSString::from_str(&title), &attrs) };
        item.setAttributedTitle(Some(&s));
    }
}

#[cfg(test)]
mod tests {
    use super::shortcut_column;

    #[test]
    fn shortcut_column_ends_after_the_longest_label_and_shortcut() {
        assert_eq!(shortcut_column(&[60.0, 112.4], &[30.0, 41.0]), 178.0);
        assert_eq!(shortcut_column(&[], &[]), 24.0);
    }
}
