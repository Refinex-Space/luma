//! Member completion by Luma's engine (`order.` → the members of `Order`), for when jdtls cannot
//! answer yet — starting, importing the project — or answers slowly.

use super::usages::{byte_of, unsaved_java};
use crate::Project;
use ide_core::{Pos, ServerId};
use ide_java::model::Model;
use ide_java::resolve::{CompletionKind, FileAnalysis, completion_texts};
use ide_lsp::types::{CompletionItem, CompletionKind as Kind, CompletionList};
use std::path::Path;

/// The members completing the qualified name at `pos` of `path`; `None` when the position is
/// not after a qualifier whose type the engine knows.
pub(crate) fn engine_completion(project: &Project, path: &Path, text: &str, pos: Pos) -> Option<CompletionList> {
    let at = byte_of(text, pos)?;
    let cp = crate::java_engine::classpath_for(project, path);
    let visibility = project.java_engine.visibility(path);
    let unsaved = unsaved_java(project, path);
    let items = completion_texts(text, at).into_iter().find_map(|t| {
        project
            .index
            .with_java_edits(path, &t, &unsaved, |view| {
                let me = view.overlay_file()?;
                let tree = ide_java::parse(&t)?;
                let model = Model::new(view, &cp).with_visibility(visibility.clone());
                let fa = FileAnalysis::new(&model, &tree, &t, me);
                fa.member_completions(fa.identifier_at(at)?)
            })
            .flatten()
    })?;
    let items = items
        .into_iter()
        .map(|c| {
            let method = c.kind == CompletionKind::Method;
            CompletionItem {
                label: c.name.clone(),
                label_detail: method.then(|| format!("({})", c.params.join(", "))),
                detail: (!c.ty.is_empty()).then(|| c.ty.clone()),
                kind: Some(match c.kind {
                    CompletionKind::Field => Kind::Field,
                    CompletionKind::Method => Kind::Method,
                    CompletionKind::Class => Kind::Class,
                    CompletionKind::Keyword => Kind::Keyword,
                }),
                documentation: None,
                // The qualifier's own members first, then each supertype level.
                sort_text: Some(format!("{:02}{}", c.depth, c.name)),
                filter_text: Some(c.name.clone()),
                preselect: false,
                deprecated: c.deprecated,
                insert_text: match (method, c.params.is_empty()) {
                    (true, true) => format!("{}()", c.name),
                    (true, false) => format!("{}($1)$0", c.name),
                    _ => c.name.clone(),
                },
                is_snippet: method && !c.params.is_empty(),
                replace_range: None,
                replace_range_tab: None,
                additional_edits: Vec::new(),
                commit_characters: Vec::new(),
                command: None,
                data: None,
                // No server resolves these.
                server: ServerId(0),
            }
        })
        .collect();
    // Asked again as the user types: jdtls may be ready by then.
    Some(CompletionList { is_incomplete: true, items })
}
