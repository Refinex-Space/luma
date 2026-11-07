//! Variables in scope at a point of a method body (JLS §6.3, §6.4; IDEA's
//! `PsiScopesUtil.treeWalkUp` with `VariablesProcessor`): locals declared earlier in enclosing
//! blocks, `for` / enhanced-`for` / resource / `catch` / lambda / method parameters, pattern
//! variables by the flow-scoping rules of JLS §6.3.1, and — when the walk leaves a class body —
//! that class's fields, which shadow the enclosing method's locals.

use super::{FileAnalysis, is_class_decl};
use crate::types::Key;
use tree_sitter::Node;

#[derive(Clone, Copy, Debug)]
pub struct LocalDecl<'t> {
    /// The identifier declaring it.
    pub name: Node<'t>,
    pub kind: LocalKind<'t>,
}

#[derive(Clone, Copy, Debug)]
pub enum LocalKind<'t> {
    /// Declared with a type node; `dims` extra `[]` written after the name.
    Typed { ty: Node<'t>, dims: usize },
    /// `var x = init`.
    Inferred { init: Node<'t> },
    /// `for (T x : iterable)`; `ty` is `None` for `var`.
    ForEach { ty: Option<Node<'t>>, iterable: Node<'t> },
    /// An implicitly typed lambda parameter (`x -> …`, `(x, y) -> …`, `(var x) -> …`).
    LambdaParam { lambda: Node<'t>, index: usize },
    /// A variable-arity parameter `T... xs`: `T[]`.
    Varargs { ty: Node<'t> },
    /// `catch (A | B e)`.
    Catch { types: Node<'t> },
    /// A record pattern component written with `var`: typed by the record's component.
    PatternVar { component: Node<'t> },
}

/// What a simple name in an expression refers to.
pub(crate) enum VarLookup<'t> {
    Local(LocalDecl<'t>),
    /// A field found in the class whose body the walk left (declared there or inherited):
    /// the class searched and the field's declaring class.
    Field {
        searched: Key,
        declaring: Key,
    },
    None,
}

fn dims_of(n: Node, text: &str) -> usize {
    n.child_by_field_name("dimensions").map_or(0, |d| text.get(d.byte_range()).unwrap_or_default().matches('[').count())
}

impl<'t> FileAnalysis<'_, '_, 't> {
    fn local_of_declarator(&self, decl: Node<'t>, ty: Node<'t>, name: &str) -> Option<LocalDecl<'t>> {
        let n = decl.child_by_field_name("name")?;
        if self.node_text(n) != name {
            return None;
        }
        // `var`, and Lombok's `val` (a final `var`).
        let kind = if matches!(self.node_text(ty), "var" | "val" | "lombok.val") {
            LocalKind::Inferred { init: decl.child_by_field_name("value")? }
        } else {
            LocalKind::Typed { ty, dims: dims_of(decl, self.text) }
        };
        Some(LocalDecl { name: n, kind })
    }

    /// A local variable declaration statement declaring `name` (the last declarator so named
    /// before `limit`, when given).
    fn in_local_declaration(&self, stmt: Node<'t>, name: &str, limit: Option<usize>) -> Option<LocalDecl<'t>> {
        let ty = stmt.child_by_field_name("type")?;
        let mut c = stmt.walk();
        let mut found = None;
        for d in stmt.children_by_field_name("declarator", &mut c) {
            if limit.is_some_and(|l| d.start_byte() >= l) {
                break;
            }
            if let Some(l) = self.local_of_declarator(d, ty, name) {
                found = Some(l);
            }
        }
        found
    }

    fn parameter(&self, p: Node<'t>, name: &str) -> Option<LocalDecl<'t>> {
        match p.kind() {
            "formal_parameter" => {
                let n = p.child_by_field_name("name")?;
                (self.node_text(n) == name).then(|| LocalDecl {
                    name: n,
                    kind: LocalKind::Typed {
                        ty: p.child_by_field_name("type").unwrap_or(p),
                        dims: dims_of(p, self.text),
                    },
                })
            }
            "spread_parameter" => {
                let mut c = p.walk();
                let children: Vec<Node> = p.named_children(&mut c).filter(|x| !x.is_extra()).collect();
                let decl = children.iter().find(|n| n.kind() == "variable_declarator")?;
                let n = decl.child_by_field_name("name")?;
                let ty = children.iter().find(|n| {
                    !matches!(n.kind(), "modifiers" | "annotation" | "marker_annotation" | "variable_declarator")
                })?;
                (self.node_text(n) == name).then_some(LocalDecl { name: n, kind: LocalKind::Varargs { ty: *ty } })
            }
            _ => None,
        }
    }

    fn in_parameters(&self, params: Node<'t>, name: &str) -> Option<LocalDecl<'t>> {
        let mut c = params.walk();
        params.named_children(&mut c).filter(|x| !x.is_extra()).find_map(|p| self.parameter(p, name))
    }

    fn lambda_param(&self, lambda: Node<'t>, name: &str) -> Option<LocalDecl<'t>> {
        let params = lambda.child_by_field_name("parameters")?;
        match params.kind() {
            "identifier" => (self.node_text(params) == name)
                .then_some(LocalDecl { name: params, kind: LocalKind::LambdaParam { lambda, index: 0 } }),
            "inferred_parameters" => {
                let mut c = params.walk();
                params
                    .named_children(&mut c)
                    .filter(|x| !x.is_extra())
                    .enumerate()
                    .find(|(_, p)| self.node_text(*p) == name)
                    .map(|(index, p)| LocalDecl { name: p, kind: LocalKind::LambdaParam { lambda, index } })
            }
            "formal_parameters" => {
                let mut c = params.walk();
                for (index, p) in params.named_children(&mut c).filter(|x| !x.is_extra()).enumerate() {
                    if let Some(mut l) = self.parameter(p, name) {
                        // `(var x, var y) -> …` is implicitly typed.
                        if let LocalKind::Typed { ty, .. } = l.kind
                            && self.node_text(ty) == "var"
                        {
                            l.kind = LocalKind::LambdaParam { lambda, index };
                        }
                        return Some(l);
                    }
                }
                None
            }
            _ => None,
        }
    }

    /// Pattern variables a boolean expression introduces when it evaluates to `when`
    /// (JLS §6.3.1).
    pub(crate) fn bindings(&self, e: Node<'t>, when: bool, name: &str) -> Option<LocalDecl<'t>> {
        match e.kind() {
            "parenthesized_expression" => {
                let mut c = e.walk();
                let inner = e.named_children(&mut c).find(|x| !x.is_extra())?;
                self.bindings(inner, when, name)
            }
            "unary_expression" if e.child_by_field_name("operator").is_some_and(|o| self.node_text(o) == "!") => {
                self.bindings(e.child_by_field_name("operand")?, !when, name)
            }
            "binary_expression" => {
                let op = self.node_text(e.child_by_field_name("operator")?);
                let (l, r) = (e.child_by_field_name("left")?, e.child_by_field_name("right")?);
                match (op, when) {
                    ("&&", true) | ("||", false) => {
                        self.bindings(l, when, name).or_else(|| self.bindings(r, when, name))
                    }
                    _ => None,
                }
            }
            "instanceof_expression" if when => {
                if let Some(n) = e.child_by_field_name("name")
                    && self.node_text(n) == name
                {
                    let ty = e.child_by_field_name("right")?;
                    return Some(LocalDecl { name: n, kind: LocalKind::Typed { ty, dims: 0 } });
                }
                self.pattern_binding(e.child_by_field_name("pattern")?, name)
            }
            _ => None,
        }
    }

    /// A variable declared by a (record or type) pattern.
    pub(crate) fn pattern_binding(&self, p: Node<'t>, name: &str) -> Option<LocalDecl<'t>> {
        match p.kind() {
            "pattern" => {
                let mut c = p.walk();
                let inner = p.named_children(&mut c).find(|x| !x.is_extra())?;
                self.pattern_binding(inner, name)
            }
            "type_pattern" => {
                let mut c = p.walk();
                let children: Vec<Node> = p.named_children(&mut c).filter(|x| !x.is_extra()).collect();
                let n = *children.iter().rev().find(|n| n.kind() == "identifier")?;
                let ty = *children.iter().find(|x| x.id() != n.id())?;
                (self.node_text(n) == name).then_some(LocalDecl { name: n, kind: LocalKind::Typed { ty, dims: 0 } })
            }
            "record_pattern" => {
                let mut c = p.walk();
                let children: Vec<Node> = p.named_children(&mut c).filter(|x| !x.is_extra()).collect();
                if let Some(body) = children.iter().find(|n| n.kind() == "record_pattern_body") {
                    let mut bc = body.walk();
                    for comp in body.named_children(&mut bc).filter(|x| !x.is_extra()) {
                        if let Some(l) = self.pattern_binding(comp, name) {
                            return Some(l);
                        }
                    }
                }
                None
            }
            "record_pattern_component" => {
                let mut c = p.walk();
                let children: Vec<Node> = p.named_children(&mut c).filter(|x| !x.is_extra()).collect();
                if let Some(inner) = children.iter().find(|n| matches!(n.kind(), "record_pattern" | "type_pattern")) {
                    return self.pattern_binding(*inner, name);
                }
                let n = children.iter().rev().find(|n| n.kind() == "identifier")?;
                if self.node_text(*n) != name {
                    return None;
                }
                let ty = children.iter().find(|x| x.id() != n.id() && !matches!(x.kind(), "underscore_pattern"))?;
                let kind = if self.node_text(*ty) == "var" {
                    LocalKind::PatternVar { component: p }
                } else {
                    LocalKind::Typed { ty: *ty, dims: 0 }
                };
                Some(LocalDecl { name: *n, kind })
            }
            _ => None,
        }
    }

    /// A statement that cannot complete normally (JLS §14.22, the common cases).
    fn completes_abruptly(&self, s: Node) -> bool {
        match s.kind() {
            "return_statement" | "throw_statement" | "break_statement" | "continue_statement" | "yield_statement" => {
                true
            }
            "block" => {
                let mut c = s.walk();
                s.named_children(&mut c).filter(|x| !x.is_extra()).last().is_some_and(|l| self.completes_abruptly(l))
            }
            "expression_statement" => false,
            _ => false,
        }
    }

    /// Bindings introduced into the statements after `stmt` of a block: `if (!(x instanceof T t))
    /// return;` (JLS §6.3.2.2), `while (!(x instanceof T t)) {…}` without `break`.
    fn bindings_after(&self, stmt: Node<'t>, name: &str) -> Option<LocalDecl<'t>> {
        match stmt.kind() {
            "if_statement" => {
                let cond = stmt.child_by_field_name("condition")?;
                let then = stmt.child_by_field_name("consequence")?;
                let alternative = stmt.child_by_field_name("alternative");
                if self.completes_abruptly(then)
                    && alternative.is_none_or(|a| !self.completes_abruptly(a))
                    && let Some(l) = self.bindings(cond, false, name)
                {
                    return Some(l);
                }
                if let Some(a) = alternative
                    && self.completes_abruptly(a)
                    && !self.completes_abruptly(then)
                {
                    return self.bindings(cond, true, name);
                }
                None
            }
            _ => None,
        }
    }

    /// Resolves a simple name used as a variable at `at` (JLS §6.5.6.1).
    /// The local variable (or parameter) named `name` in scope at `at`: its name's byte offset.
    pub fn visible_local(&self, name: &str, at: Node<'t>) -> Option<usize> {
        match self.lookup_variable(name, at) {
            VarLookup::Local(d) => Some(d.name.start_byte()),
            _ => None,
        }
    }

    pub(crate) fn lookup_variable(&self, name: &str, at: Node<'t>) -> VarLookup<'t> {
        let mut child = at;
        let mut cur = at.parent();
        while let Some(p) = cur {
            let found = match p.kind() {
                "block" | "switch_block_statement_group" | "constructor_body" => {
                    let mut c = p.walk();
                    let mut found = None;
                    for s in p.named_children(&mut c).filter(|x| !x.is_extra()) {
                        if s.id() == child.id() {
                            // Inside a declaration statement: its earlier declarators, and the
                            // declarator whose initializer we are in.
                            if s.kind() == "local_variable_declaration" {
                                found = self.in_local_declaration(s, name, Some(at.start_byte())).or(found);
                            }
                            break;
                        }
                        if s.start_byte() > child.start_byte() {
                            break;
                        }
                        if s.kind() == "local_variable_declaration" {
                            if let Some(l) = self.in_local_declaration(s, name, None) {
                                found = Some(l);
                            }
                        } else if let Some(l) = self.bindings_after(s, name) {
                            found = Some(l);
                        }
                    }
                    found
                }
                "for_statement" => {
                    let mut c = p.walk();
                    let mut found = None;
                    let is_init = p.children_by_field_name("init", &mut c).any(|i| i.id() == child.id());
                    if !is_init {
                        let mut c = p.walk();
                        for init in p.children_by_field_name("init", &mut c) {
                            if init.kind() == "local_variable_declaration"
                                && let Some(l) = self.in_local_declaration(init, name, None)
                            {
                                found = Some(l);
                            }
                        }
                        // The condition holds in the body and the update.
                        if found.is_none()
                            && p.child_by_field_name("body").is_some_and(|b| b.id() == child.id())
                            && let Some(cond) = p.child_by_field_name("condition")
                        {
                            found = self.bindings(cond, true, name);
                        }
                    }
                    found
                }
                "enhanced_for_statement" if p.child_by_field_name("body").is_some_and(|b| b.id() == child.id()) => {
                    let n = p.child_by_field_name("name");
                    match (n, p.child_by_field_name("value")) {
                        (Some(n), Some(iterable)) if self.node_text(n) == name => {
                            let ty = p.child_by_field_name("type").filter(|t| self.node_text(*t) != "var");
                            Some(LocalDecl { name: n, kind: LocalKind::ForEach { ty, iterable } })
                        }
                        _ => None,
                    }
                }
                "catch_clause" if p.child_by_field_name("body").is_some_and(|b| b.id() == child.id()) => {
                    let mut c = p.walk();
                    p.named_children(&mut c)
                        .filter(|x| !x.is_extra())
                        .find(|n| n.kind() == "catch_formal_parameter")
                        .and_then(|param| {
                            let n = param.child_by_field_name("name")?;
                            let mut pc = param.walk();
                            let types = param
                                .named_children(&mut pc)
                                .filter(|x| !x.is_extra())
                                .find(|n| n.kind() == "catch_type")?;
                            (self.node_text(n) == name)
                                .then_some(LocalDecl { name: n, kind: LocalKind::Catch { types } })
                        })
                }
                "resource_specification" => {
                    let mut c = p.walk();
                    let mut found = None;
                    for r in p.named_children(&mut c).filter(|x| !x.is_extra()) {
                        if r.start_byte() >= child.start_byte() {
                            break;
                        }
                        if let Some(l) = self.resource(r, name) {
                            found = Some(l);
                        }
                    }
                    found
                }
                "try_with_resources_statement"
                    if p.child_by_field_name("body").is_some_and(|b| b.id() == child.id()) =>
                {
                    let spec = p.child_by_field_name("resources");
                    spec.and_then(|spec| {
                        let mut c = spec.walk();
                        spec.named_children(&mut c)
                            .filter(|x| !x.is_extra())
                            .filter_map(|r| self.resource(r, name))
                            .last()
                    })
                }
                "lambda_expression" if p.child_by_field_name("body").is_some_and(|b| b.id() == child.id()) => {
                    self.lambda_param(p, name)
                }
                "method_declaration" | "constructor_declaration" => {
                    p.child_by_field_name("parameters").and_then(|ps| self.in_parameters(ps, name))
                }
                "compact_constructor_declaration" => {
                    // The record's components are its parameters.
                    let record = p.parent().and_then(|b| b.parent());
                    record.and_then(|r| r.child_by_field_name("parameters")).and_then(|ps| self.in_parameters(ps, name))
                }
                "if_statement" => {
                    let cond = p.child_by_field_name("condition");
                    match cond {
                        Some(c) if p.child_by_field_name("consequence").is_some_and(|t| t.id() == child.id()) => {
                            self.bindings(c, true, name)
                        }
                        Some(c) if p.child_by_field_name("alternative").is_some_and(|t| t.id() == child.id()) => {
                            self.bindings(c, false, name)
                        }
                        _ => None,
                    }
                }
                "while_statement" if p.child_by_field_name("body").is_some_and(|b| b.id() == child.id()) => {
                    p.child_by_field_name("condition").and_then(|c| self.bindings(c, true, name))
                }
                "ternary_expression" => {
                    let cond = p.child_by_field_name("condition");
                    match cond {
                        Some(c) if p.child_by_field_name("consequence").is_some_and(|t| t.id() == child.id()) => {
                            self.bindings(c, true, name)
                        }
                        Some(c) if p.child_by_field_name("alternative").is_some_and(|t| t.id() == child.id()) => {
                            self.bindings(c, false, name)
                        }
                        _ => None,
                    }
                }
                "binary_expression" if p.child_by_field_name("right").is_some_and(|r| r.id() == child.id()) => {
                    let op = p.child_by_field_name("operator").map(|o| self.node_text(o)).unwrap_or_default();
                    let left = p.child_by_field_name("left");
                    match (op, left) {
                        ("&&", Some(l)) => self.bindings(l, true, name),
                        ("||", Some(l)) => self.bindings(l, false, name),
                        _ => None,
                    }
                }
                _ => None,
            };
            if let Some(l) = found {
                return VarLookup::Local(l);
            }
            // Case labels with patterns: their variables are in scope in the case's body/guard.
            if matches!(p.kind(), "switch_rule" | "switch_block_statement_group") {
                let mut c = p.walk();
                for label in p.named_children(&mut c).filter(|x| !x.is_extra()).filter(|n| n.kind() == "switch_label") {
                    let mut lc = label.walk();
                    for part in label.named_children(&mut lc).filter(|x| !x.is_extra()) {
                        if matches!(part.kind(), "pattern" | "record_pattern" | "type_pattern")
                            && let Some(l) = self.pattern_binding(part, name)
                        {
                            return VarLookup::Local(l);
                        }
                    }
                }
            }
            if p.kind() == "switch_label" {
                let mut lc = p.walk();
                for part in p.named_children(&mut lc).filter(|x| !x.is_extra()) {
                    if matches!(part.kind(), "pattern" | "record_pattern" | "type_pattern")
                        && let Some(l) = self.pattern_binding(part, name)
                    {
                        return VarLookup::Local(l);
                    }
                }
            }
            // Leaving a class body: the class's fields come before the enclosing scopes.
            let class_body_exit = (is_class_decl(p.kind())
                && p.child_by_field_name("body").is_some_and(|b| b.id() == child.id()))
                || (matches!(p.kind(), "object_creation_expression" | "enum_constant") && child.kind() == "class_body");
            if class_body_exit
                && let Some(key) = self.declared_key(p)
                && let Some(declaring) = self.field_declaring_class(&key, name)
            {
                return VarLookup::Field { searched: key, declaring };
            }
            child = p;
            cur = p.parent();
        }
        VarLookup::None
    }

    fn resource(&self, r: Node<'t>, name: &str) -> Option<LocalDecl<'t>> {
        if r.kind() != "resource" {
            return None;
        }
        let n = r.child_by_field_name("name")?;
        if self.node_text(n) != name {
            return None;
        }
        let ty = r.child_by_field_name("type")?;
        let kind = if self.node_text(ty) == "var" {
            LocalKind::Inferred { init: r.child_by_field_name("value")? }
        } else {
            LocalKind::Typed { ty, dims: dims_of(r, self.text) }
        };
        Some(LocalDecl { name: n, kind })
    }

    /// The class declaring field `name` as a member of `class` (declared or inherited).
    pub(crate) fn field_declaring_class(&self, class: &str, name: &str) -> Option<Key> {
        let mut seen = std::collections::HashSet::new();
        self.field_in(class, name, &mut seen)
    }

    fn field_in(&self, class: &str, name: &str, seen: &mut std::collections::HashSet<Key>) -> Option<Key> {
        if !seen.insert(class.into()) {
            return None;
        }
        let c = self.model.class(class)?;
        if self.model.members(&c).fields.iter().any(|f| f.name == name) {
            return Some(c.key.clone());
        }
        let supers: Vec<Key> =
            c.super_class.iter().chain(&c.interfaces).filter_map(|t| t.as_class().map(|x| x.key.clone())).collect();
        supers.into_iter().find_map(|s| self.field_in(&s, name, seen))
    }
}
