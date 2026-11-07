//! Member completion after a qualifier (`order.`, `List.`, `super.`): IDEA's
//! `JavaCompletionContributor` variants of a qualified reference — the fields, methods and
//! member types of the qualifier's type that the code can access (JLS §6.6, §8.4.8), inherited
//! ones once (an override hides what it overrides), statics only through a type name.
//!
//! The caller completes on text with a dummy identifier at the caret (IDEA's
//! `CompletionUtil.DUMMY_IDENTIFIER`), so an unfinished `order.` parses as a field access.

use super::FileAnalysis;
use super::expr::Qualifier;
use crate::classfile::{ACC_BRIDGE, ACC_PRIVATE, ACC_STATIC, ACC_SYNTHETIC, DEPRECATED};
use crate::types::{ClassType, Type};
use std::collections::HashSet;
use tree_sitter::Node;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompletionKind {
    Field,
    Method,
    Class,
    Keyword,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Completion {
    pub name: String,
    pub kind: CompletionKind,
    /// Parameter types (methods), as short names: `List<String>`.
    pub params: Vec<String>,
    /// A field's type or a method's return type, short.
    pub ty: String,
    /// The class declaring it (simple name).
    pub owner: String,
    /// 0 for the qualifier's own class, more for supertypes further up.
    pub depth: usize,
    pub deprecated: bool,
}

/// The identifier put at the caret so that unfinished code parses (IDEA's
/// `CompletionUtil.DUMMY_IDENTIFIER_TRIMMED`).
pub const DUMMY_IDENTIFIER: &str = "LumaCompletionDummy";

/// `text` with the dummy identifier at byte `at`: alone first (`f(o.|)`), then closing the
/// statement (`o.|` at the end of a line).
pub fn completion_texts(text: &str, at: usize) -> [String; 2] {
    let (before, after) = text.split_at(at);
    [format!("{before}{DUMMY_IDENTIFIER}{after}"), format!("{before}{DUMMY_IDENTIFIER};{after}")]
}

/// `java.util.Map.Entry<java.lang.String, ? extends a.B>` → `Entry<String, ? extends B>`.
pub fn short_type(t: &str) -> String {
    let mut out = String::with_capacity(t.len());
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut String| {
        out.push_str(word.rsplit('.').next().unwrap_or(word));
        word.clear();
    };
    for c in t.chars() {
        if c.is_alphanumeric() || c == '_' || c == '$' || c == '.' {
            word.push(c);
        } else {
            flush(&mut word, &mut out);
            out.push(c);
        }
    }
    flush(&mut word, &mut out);
    out
}

impl<'t> FileAnalysis<'_, '_, 't> {
    /// The members completing the name `ident` qualified as `q.ident` (`None` when `ident` is
    /// not qualified, or the qualifier's type is unknown).
    pub fn member_completions(&self, ident: Node<'t>) -> Option<Vec<Completion>> {
        let parent = ident.parent()?;
        let field = |f: &str| parent.child_by_field_name(f).is_some_and(|n| n.id() == ident.id());
        let object = match parent.kind() {
            "field_access" if field("field") => parent.child_by_field_name("object")?,
            "method_invocation" if field("name") => parent.child_by_field_name("object")?,
            _ => return None,
        };
        let from = self.enclosing_key(ident);
        let (owner, statics) = match self.qualifier(object) {
            Qualifier::Expr(t) if !t.is_unknown() => (self.member_owner(&t)?, false),
            Qualifier::Type(Type::Class(c)) => (c, true),
            Qualifier::Super(k) => {
                let c = self.model.class(&k)?;
                let sup = c.super_class.clone().unwrap_or_else(|| Type::class("java/lang/Object"));
                (self.member_owner(&sup)?, false)
            }
            _ => return None,
        };
        self.model.class(&owner.key)?;
        Some(self.members_of(&owner, statics, from.as_deref()))
    }

    fn members_of(&self, owner: &ClassType, statics: bool, from: Option<&str>) -> Vec<Completion> {
        let mut out = Vec::new();
        let mut fields: HashSet<String> = HashSet::new();
        let mut methods: HashSet<(String, String)> = HashSet::new();
        let mut seen = HashSet::new();
        let mut level: Vec<ClassType> = vec![owner.clone()];
        let mut depth = 0;
        while !level.is_empty() {
            let mut next = Vec::new();
            for t in level {
                if !seen.insert(t.key.clone()) {
                    continue;
                }
                let Some(c) = self.model.class(&t.key) else { continue };
                let subst = self.model.subst_of(&t);
                let simple = c.name.clone();
                let members = self.model.members(&c);
                let visible = |flags: u32| {
                    flags & (ACC_SYNTHETIC | ACC_BRIDGE) as u32 == 0
                        && (depth == 0 || flags & ACC_PRIVATE as u32 == 0)
                        && (!statics || flags & ACC_STATIC as u32 != 0)
                        && (statics || flags & ACC_STATIC as u32 == 0)
                        && self.accessible(flags, &c, from)
                };
                for f in members.fields.iter().filter(|f| visible(f.flags)) {
                    // A field hides the same-named fields of supertypes.
                    if fields.insert(f.name.clone()) {
                        out.push(Completion {
                            name: f.name.clone(),
                            kind: CompletionKind::Field,
                            params: Vec::new(),
                            ty: short_type(&self.model.apply(&subst, &f.ty).to_string()),
                            owner: simple.clone(),
                            depth,
                            deprecated: f.flags & DEPRECATED != 0,
                        });
                    }
                }
                for m in members.methods.iter().filter(|m| !m.is_constructor() && visible(m.flags)) {
                    if m.name.contains('$') {
                        continue;
                    }
                    let params: Vec<Type> = m.params.iter().map(|p| self.model.apply(&subst, p)).collect();
                    let erased: Vec<String> = params.iter().map(|p| self.model.erasure(p).to_string()).collect();
                    // An override hides the methods it overrides.
                    if !methods.insert((m.name.clone(), erased.join(","))) {
                        continue;
                    }
                    let mut shown: Vec<String> = params.iter().map(|p| short_type(&p.to_string())).collect();
                    if m.varargs
                        && let Some(last) = shown.last_mut()
                        && last.ends_with("[]")
                    {
                        last.truncate(last.len() - 2);
                        last.push_str("...");
                    }
                    out.push(Completion {
                        name: m.name.clone(),
                        kind: CompletionKind::Method,
                        params: shown,
                        ty: short_type(&self.model.apply(&subst, &m.ret).to_string()),
                        owner: simple.clone(),
                        depth,
                        deprecated: m.flags & DEPRECATED != 0,
                    });
                }
                if statics {
                    for (name, key) in &c.member_classes {
                        let Some(mc) = self.model.class(key) else { continue };
                        if self.accessible(mc.flags, &c, from) && fields.insert(format!("class {name}")) {
                            out.push(Completion {
                                name: name.clone(),
                                kind: CompletionKind::Class,
                                params: Vec::new(),
                                ty: String::new(),
                                owner: simple.clone(),
                                depth,
                                deprecated: mc.flags & DEPRECATED != 0,
                            });
                        }
                    }
                }
                next.extend(self.model.direct_supertypes(&t));
            }
            level = next;
            depth += 1;
        }
        if statics {
            // `Type.class`.
            out.push(Completion {
                name: "class".into(),
                kind: CompletionKind::Keyword,
                params: Vec::new(),
                ty: String::new(),
                owner: String::new(),
                depth: 0,
                deprecated: false,
            });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::short_type;

    #[test]
    fn short_types() {
        assert_eq!(
            short_type("java.util.Map.Entry<java.lang.String, ? extends a.B>[]"),
            "Entry<String, ? extends B>[]"
        );
        assert_eq!(short_type("int"), "int");
    }
}
