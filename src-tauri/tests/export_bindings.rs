//! `cargo test -p lama --test export_bindings` regenerates `src/bindings.ts`
//! without launching the app (used by `pnpm gen:bindings` and CI drift checks).

#[test]
fn export_bindings() {
    lama_lib::export_bindings(&lama_lib::specta_builder());
}
