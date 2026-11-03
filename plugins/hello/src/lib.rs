//! Sample Lama plugin. Build with `../build.sh hello` (see plugins/README.md).

wit_bindgen::generate!({
    world: "plugin",
    path: "../../wit",
});

use lama::plugin::host::{self, LogLevel, NotificationLevel};

struct Hello;

impl Guest for Hello {
    fn activate(ctx: Context) -> Result<(), String> {
        host::log(LogLevel::Info, &format!("hello {} activated", ctx.plugin_version));
        host::register_command("insert-date", "Hello: Insert Date", Some("Hello"));
        host::register_command("word-count", "Hello: Word Count of Active File", Some("Hello"));
        Ok(())
    }

    fn deactivate() {
        host::log(LogLevel::Info, "hello deactivated");
    }

    fn run_command(id: String, _arg: Option<String>) -> Result<Option<String>, String> {
        match id.as_str() {
            "insert-date" => {
                let date = today();
                host::insert_text(&date);
                Ok(Some(date))
            }
            "word-count" => {
                let path = host::active_file().ok_or("no file is open in the editor")?;
                let text = host::read_file(&path)?;
                let words = text.split_whitespace().count();
                let lines = text.lines().count();
                let name = path.rsplit(['/', '\\']).next().unwrap_or(&path);
                let body = format!("{words} words, {lines} lines, {} characters", text.chars().count());
                host::show_notification(NotificationLevel::Info, &format!("Word count: {name}"), &body);
                Ok(Some(body))
            }
            other => Err(format!("unknown command: {other}")),
        }
    }
}

/// Today's UTC date as `YYYY-MM-DD` (WASI wall clock).
fn today() -> String {
    let secs =
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    format!("{y:04}-{m:02}-{d:02}")
}

/// Howard Hinnant's days-to-civil algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

export!(Hello);
