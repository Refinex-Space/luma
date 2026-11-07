//! Luma's Java semantic engine, modelled on IntelliJ IDEA's Java PSI
//! (`java/java-psi-api`, `java/java-psi-impl` of intellij-community, Apache 2.0):
//!
//! * [`classfile`]: class files → stubs (`ClsStubBuilder`), with generic signatures.
//! * [`jimage`]: the JDK's runtime image (`lib/modules`), read like IDEA's `JrtFileSystem`.
//! * [`archive`]: jars, read by position without keeping them open or mapped.
//! * [`classpath`]: class path roots and the lazy class finder over them.
//! * [`types`], [`typeref`]: semantic types and types as written.
//! * [`model`]: one class view over sources and the class path, with type name resolution.
//! * [`resolve`]: references in a parsed file: names, members, invocations, lambdas.

pub use tree_sitter;

pub mod archive;
pub mod classfile;
pub mod classpath;
pub mod javadoc;
pub mod jimage;
pub mod lombok;
pub mod model;
pub mod resolve;
pub mod search;
pub mod typeref;
pub mod types;

/// Parses Java source (tree-sitter-java, the grammar the index uses).
pub fn parse(text: &str) -> Option<tree_sitter::Tree> {
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&tree_sitter_java::LANGUAGE.into()).ok()?;
    parser.parse(text, None)
}
