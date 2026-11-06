use ide_core::{EventSink, IdeEvent};
use tauri::{AppHandle, Emitter, Manager};

/// Name of the single backend → UI event. Payload: [`IdeEvent`].
pub const IDE_EVENT: &str = "ide://event";

/// Forwards events to one window (`Some(label)`) or to all windows.
pub struct TauriSink {
    pub app: AppHandle,
    pub window: Option<String>,
}

impl EventSink for TauriSink {
    fn emit(&self, event: IdeEvent) {
        // Pages open in a browser reload when a file they loaded changes on disk.
        if let IdeEvent::FsChanged { created, modified, removed } = &event
            && let Some(state) = self.app.try_state::<crate::state::AppState>()
        {
            state.web.files_changed(created.iter().chain(modified).chain(removed).map(|p| p.0.as_path()));
        }
        let result = match &self.window {
            Some(label) => self.app.emit_to(label.as_str(), IDE_EVENT, &event),
            None => self.app.emit(IDE_EVENT, &event),
        };
        if let Err(e) = result {
            tracing::warn!("failed to emit ide event: {e}");
        }
    }
}
