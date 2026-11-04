//! Test fixture for the ide-plugin sandbox. Never shipped.

wit_bindgen::generate!({
    world: "plugin",
    path: "../../../../../wit",
});

use luma::plugin::host;

struct Misbehave;

impl Guest for Misbehave {
    fn activate(_ctx: Context) -> Result<(), String> {
        for id in ["echo", "panic", "spin", "alloc", "read", "root", "insert", "language", "theme"] {
            host::register_command(id, id, None);
        }
        Ok(())
    }

    fn deactivate() {}

    fn run_command(id: String, arg: Option<String>) -> Result<Option<String>, String> {
        match id.as_str() {
            "echo" => Ok(arg),
            "panic" => panic!("boom"),
            "spin" => {
                let mut x: u64 = 0;
                loop {
                    x = std::hint::black_box(x.wrapping_add(1));
                }
            }
            "alloc" => {
                let mut chunks: Vec<Vec<u8>> = Vec::new();
                loop {
                    chunks.push(vec![1u8; 16 << 20]);
                    std::hint::black_box(&chunks);
                }
            }
            "read" => host::read_file(&arg.unwrap_or_default()).map(Some),
            "root" => Ok(host::workspace_root()),
            // Not permitted by the manifest: traps.
            "insert" => {
                host::insert_text("x");
                Ok(None)
            }
            "language" => host::register_language(&arg.unwrap_or_default()).map(|_| None),
            "theme" => host::register_theme(&arg.unwrap_or_default()).map(|_| None),
            other => Err(format!("unknown command: {other}")),
        }
    }
}

export!(Misbehave);
