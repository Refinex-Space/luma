//! `cargo test -p luma --test export_bindings` regenerates `src/bindings.ts`
//! without launching the app (used by `pnpm gen:bindings` and CI drift checks).

#[test]
fn export_bindings() {
    luma_lib::export_bindings(&luma_lib::specta_builder());
}
