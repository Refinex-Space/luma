//! Go to Implementation (⌥⌘B) and the Type Hierarchy of Java declarations from the structure
//! index (IDEA's `ClassInheritorsSearch` / `OverridingMethodsSearch` over stub indexes): answered
//! in milliseconds, where JDT computes a type hierarchy over the whole workspace.
//!
//! The declaration is the one named at the caret, or the one the server's definition points to
//! (one quick request). Library declarations, and supertypes outside the sources, are left to the
//! server: these functions answer `None` and the caller asks it.

use crate::Project;
use ide_core::{DocId, Location, Pos, Range, SymbolKind};
use ide_index::java::{self, JavaTypeItem, JavaTypeKind};
use ide_lsp::types::{GotoKind, HierarchyDirection, HierarchyItem};
use std::path::PathBuf;
use std::sync::Arc;

/// A Java declaration in an indexed source file: where its name is, and the file's text.
struct Declaration {
    path: PathBuf,
    text: String,
    pos: Pos,
}

fn names_declaration(project: &Project, path: &std::path::Path, text: &str, pos: Pos) -> bool {
    project.index.with_java(path, text, |v| java::declaration_named_at(v, pos).is_some()).unwrap_or(false)
}

/// The text of `path`: the editor's when it is open.
fn text_of(project: &Project, path: &std::path::Path) -> Option<String> {
    match project.documents.by_path(path) {
        Some(doc) => project.documents.snapshot(doc).ok().map(|d| d.text),
        None => std::fs::read_to_string(path).ok(),
    }
}

async fn declaration(project: &Arc<Project>, doc: DocId, pos: Pos) -> Option<Declaration> {
    let info = project.documents.snapshot(doc).ok()?;
    if info.language.as_str() != "java" || info.large {
        return None;
    }
    let path = info.path.0.clone();
    let here = {
        let (project, path, text) = (project.clone(), path.clone(), info.text.clone());
        super::super::doc::blocking(move || Ok(names_declaration(&project, &path, &text, pos))).await.ok()?
    };
    if here {
        return Some(Declaration { path, text: info.text, pos });
    }
    // A reference: where it is declared, when that is a source file.
    let target = project.lsp.goto(doc, pos, GotoKind::Definition).await.ok()?.into_iter().next()?;
    if target.uri.is_some() || target.path.0.extension().is_none_or(|e| e != "java") {
        return None;
    }
    let project = project.clone();
    super::super::doc::blocking(move || {
        let path = target.path.0;
        let text = text_of(&project, &path);
        Ok(text.and_then(|text| {
            let pos = target.range.start;
            names_declaration(&project, &path, &text, pos).then_some(Declaration { path, text, pos })
        }))
    })
    .await
    .ok()
    .flatten()
}

/// Implementations of the Java declaration at `pos`, empty for none (as IDEA answers from its
/// index); `None` when the index cannot tell: not a source declaration, or none found where an
/// annotation processor may have generated them.
pub(crate) async fn implementations(project: &Arc<Project>, doc: DocId, pos: Pos) -> Option<Vec<Location>> {
    let d = declaration(project, doc, pos).await?;
    let project = project.clone();
    super::super::doc::blocking(move || {
        Ok(project.index.with_java(&d.path, &d.text, |v| {
            let (ty, member) = java::declaration_named_at(v, d.pos)?;
            let found = java::implementations(v, &d.path, ty, member);
            if found.is_empty() && java::implementations_may_be_generated(v, ty) {
                return None;
            }
            Some(found.into_iter().map(|t| t.location).collect::<Vec<_>>())
        }))
    })
    .await
    .ok()
    .flatten()
    .flatten()
}

fn hierarchy_item(item: JavaTypeItem) -> HierarchyItem {
    let kind = match item.kind {
        JavaTypeKind::Class | JavaTypeKind::Record => SymbolKind::Class,
        JavaTypeKind::Interface | JavaTypeKind::Annotation => SymbolKind::Interface,
        JavaTypeKind::Enum => SymbolKind::Enum,
    };
    HierarchyItem {
        name: item.name,
        kind,
        detail: (!item.package.is_empty()).then_some(item.package),
        path: item.location.path,
        uri: None,
        range: Range::new(item.range.start, item.range.end.max(item.location.range.end)),
        selection_range: item.location.range,
        from_ranges: Vec::new(),
    }
}

/// The Type Hierarchy level of the Java type at `pos` (a member: its type): subtypes always
/// from the index, supertypes when all are sources. `None`: ask the server.
pub(crate) async fn type_hierarchy(
    project: &Arc<Project>,
    doc: DocId,
    pos: Pos,
    direction: HierarchyDirection,
) -> Option<Vec<HierarchyItem>> {
    let d = declaration(project, doc, pos).await?;
    let project = project.clone();
    super::super::doc::blocking(move || {
        Ok(project.index.with_java(&d.path, &d.text, |v| {
            let (ty, _) = java::declaration_named_at(v, d.pos)?;
            let items = match direction {
                HierarchyDirection::Outgoing => java::subtype_items(v, &d.path, ty),
                HierarchyDirection::Incoming => match java::supertype_items(v, &d.path, ty) {
                    (items, false) => items,
                    (_, true) => return None,
                },
            };
            Some(items.into_iter().map(hierarchy_item).collect::<Vec<_>>())
        }))
    })
    .await
    .ok()
    .flatten()
    .flatten()
}
