//! Expression types and the references in expressions (JLS §15; IDEA's `PsiExpression.getType()`,
//! `PsiReferenceExpressionImpl` and `PsiMethodCallExpression.resolveMethodGenerics()`).
//!
//! Invocations are resolved in two steps, as javac does for poly expressions: the method is
//! chosen with lambdas and method references seen only by their shape, then their parameter
//! types come from the chosen method and their bodies' types complete the inference of the
//! method's type arguments.

use super::methods::{Arg, Candidate, Choice, boxed, unbox_of};
use super::scope::{LocalDecl, LocalKind, VarLookup};
use super::{FileAnalysis, Resolution, Target, is_class_decl};
use crate::classfile::BaseType;
use crate::types::{ClassType, Key, OBJECT, STRING, Subst, Type, TypeArg, TypeVar};
use tree_sitter::Node;

/// The method an invocation calls, and what it was resolved with.
#[derive(Clone, Debug)]
pub(crate) struct Call {
    pub res: Resolution,
    pub chosen: Option<Candidate>,
    /// Inferred from the arguments that are not lambdas / method references.
    pub pre: Subst,
    pub unknown_args: bool,
}

/// What the qualifier of a dotted name is (JLS §6.5.2).
#[derive(Clone, Debug)]
pub(crate) enum Qualifier {
    Expr(Type),
    Type(Type),
    Package(String),
    /// `super` / `X.super`: the class whose supertypes are searched, and that class's key.
    Super(Key),
    Unknown,
}

/// The methods `java.lang.Object` declares.
pub(crate) const OBJECT_METHODS: [&str; 9] =
    ["equals", "hashCode", "toString", "getClass", "notify", "notifyAll", "wait", "clone", "finalize"];

/// Value literals (`class_literal`, `X.class`, is an expression of type `Class<X>`).
fn is_literal(kind: &str) -> bool {
    (kind.ends_with("_literal") && kind != "class_literal") || matches!(kind, "true" | "false")
}

impl<'t> FileAnalysis<'_, '_, 't> {
    fn named_children(&self, n: Node<'t>) -> Vec<Node<'t>> {
        let mut c = n.walk();
        n.named_children(&mut c).filter(|x| !x.is_extra()).collect()
    }

    fn strip_parens(&self, mut e: Node<'t>) -> Node<'t> {
        while e.kind() == "parenthesized_expression" {
            match self.named_children(e).into_iter().next() {
                Some(inner) => e = inner,
                None => break,
            }
        }
        e
    }

    pub(crate) fn enclosing_key(&self, n: Node<'t>) -> Option<Key> {
        self.enclosing_class(n).map(|(_, k)| k)
    }

    /// The type of expression `e` (memoized; `Unknown` on a cycle).
    pub fn type_of(&self, e: Node<'t>) -> Type {
        if let Some(t) = self.types.borrow().get(&e.id()) {
            return t.clone();
        }
        if !self.busy.borrow_mut().insert(e.id()) {
            return Type::Unknown;
        }
        let t = self.compute_type(e);
        self.busy.borrow_mut().remove(&e.id());
        self.types.borrow_mut().insert(e.id(), t.clone());
        t
    }

    fn compute_type(&self, e: Node<'t>) -> Type {
        let kind = e.kind();
        if is_literal(kind) {
            return self.literal_type(e);
        }
        match kind {
            "parenthesized_expression" => {
                self.named_children(e).first().map(|i| self.type_of(*i)).unwrap_or(Type::Unknown)
            }
            "identifier" => match self.lookup_variable(self.node_text(e), e) {
                VarLookup::Local(l) => self.local_type(&l),
                VarLookup::Field { searched, declaring } => {
                    self.field_type_in(&searched, &declaring, self.node_text(e), None)
                }
                VarLookup::None => self.static_import_field(self.node_text(e)).map(|(_, t)| t).unwrap_or(Type::Unknown),
            },
            "this" => self
                .enclosing_class(e)
                .and_then(|(_, k)| self.model.class(&k))
                .map(|c| Type::Class(c.self_type()))
                .unwrap_or(Type::Unknown),
            "field_access" => self.field_access_type(e),
            "method_invocation" => self.invocation_type(e),
            "object_creation_expression" => self.creation_type(e),
            "array_creation_expression" => {
                let Some(ty) = e.child_by_field_name("type") else { return Type::Unknown };
                let base = self.resolve_type_node(ty);
                let mut c = e.walk();
                let dims: usize = e
                    .children(&mut c)
                    .filter(|n| matches!(n.kind(), "dimensions_expr" | "dimensions"))
                    .map(|n| if n.kind() == "dimensions" { self.node_text(n).matches('[').count() } else { 1 })
                    .sum();
                base.array_of(dims.max(1))
            }
            "array_access" => match e.child_by_field_name("array").map(|a| self.type_of(a)) {
                Some(Type::Array(c)) => *c,
                _ => Type::Unknown,
            },
            "cast_expression" => {
                let ty = e.child_by_field_name("type");
                ty.map(|t| self.resolve_type_node(t)).unwrap_or(Type::Unknown)
            }
            "ternary_expression" => {
                let a = e.child_by_field_name("consequence").map(|n| self.type_of(n)).unwrap_or(Type::Unknown);
                let b = e.child_by_field_name("alternative").map(|n| self.type_of(n)).unwrap_or(Type::Unknown);
                self.conditional_type(a, b)
            }
            "binary_expression" => self.binary_type(e),
            "unary_expression" => {
                let op = e.child_by_field_name("operator").map(|o| self.node_text(o)).unwrap_or_default();
                let t = e.child_by_field_name("operand").map(|o| self.type_of(o)).unwrap_or(Type::Unknown);
                match op {
                    "!" => Type::Prim(BaseType::Boolean),
                    _ => self.unary_promote(&t),
                }
            }
            "update_expression" => {
                let inner = self.named_children(e).into_iter().next();
                inner.map(|i| self.type_of(i)).unwrap_or(Type::Unknown)
            }
            "assignment_expression" => e.child_by_field_name("left").map(|l| self.type_of(l)).unwrap_or(Type::Unknown),
            "instanceof_expression" => Type::Prim(BaseType::Boolean),
            "lambda_expression" | "method_reference" => self.target_type(e).unwrap_or(Type::Unknown),
            "class_literal" => {
                let inner = self.named_children(e).into_iter().next();
                let t = inner.map(|i| self.resolve_type_node(i)).unwrap_or(Type::Unknown);
                Type::Class(ClassType {
                    key: "java/lang/Class".into(),
                    args: vec![TypeArg::Exact(boxed(&t))],
                    outer: None,
                })
            }
            "switch_expression" => self.switch_type(e),
            "array_initializer" => self.target_type(e).unwrap_or(Type::Unknown),
            _ => Type::Unknown,
        }
    }

    fn literal_type(&self, e: Node<'t>) -> Type {
        let text = self.node_text(e);
        match e.kind() {
            "decimal_integer_literal" | "hex_integer_literal" | "octal_integer_literal" | "binary_integer_literal" => {
                if text.ends_with(['l', 'L']) {
                    Type::Prim(BaseType::Long)
                } else {
                    Type::Prim(BaseType::Int)
                }
            }
            "decimal_floating_point_literal" | "hex_floating_point_literal" => {
                if text.ends_with(['f', 'F']) {
                    Type::Prim(BaseType::Float)
                } else {
                    Type::Prim(BaseType::Double)
                }
            }
            "true" | "false" => Type::Prim(BaseType::Boolean),
            "character_literal" => Type::Prim(BaseType::Char),
            "string_literal" | "text_block" => Type::string(),
            "null_literal" => Type::Null,
            _ => Type::Unknown,
        }
    }

    fn numeric(&self, t: &Type) -> Option<BaseType> {
        match t {
            Type::Prim(b) if *b != BaseType::Boolean => Some(*b),
            Type::Class(c) => unbox_of(&c.key).filter(|b| *b != BaseType::Boolean),
            _ => None,
        }
    }

    fn unary_promote(&self, t: &Type) -> Type {
        match self.numeric(t) {
            Some(BaseType::Byte | BaseType::Short | BaseType::Char | BaseType::Int) => Type::Prim(BaseType::Int),
            Some(b) => Type::Prim(b),
            None => Type::Unknown,
        }
    }

    /// Binary numeric promotion (JLS §5.6).
    fn promote(&self, a: &Type, b: &Type) -> Type {
        match (self.numeric(a), self.numeric(b)) {
            (Some(x), Some(y)) => {
                use BaseType::*;
                let r = if x == Double || y == Double {
                    Double
                } else if x == Float || y == Float {
                    Float
                } else if x == Long || y == Long {
                    Long
                } else {
                    Int
                };
                Type::Prim(r)
            }
            _ => Type::Unknown,
        }
    }

    fn binary_type(&self, e: Node<'t>) -> Type {
        let op = e.child_by_field_name("operator").map(|o| self.node_text(o)).unwrap_or_default();
        let l = e.child_by_field_name("left").map(|n| self.type_of(n)).unwrap_or(Type::Unknown);
        let r = e.child_by_field_name("right").map(|n| self.type_of(n)).unwrap_or(Type::Unknown);
        match op {
            "==" | "!=" | "<" | ">" | "<=" | ">=" | "&&" | "||" => Type::Prim(BaseType::Boolean),
            "+" if l.as_class().is_some_and(|c| &*c.key == STRING)
                || r.as_class().is_some_and(|c| &*c.key == STRING) =>
            {
                Type::string()
            }
            "+" | "-" | "*" | "/" | "%" => self.promote(&l, &r),
            "<<" | ">>" | ">>>" => self.unary_promote(&l),
            "&" | "|" | "^" => {
                let is_bool = |t: &Type| {
                    matches!(t, Type::Prim(BaseType::Boolean))
                        || t.as_class().is_some_and(|c| &*c.key == "java/lang/Boolean")
                };
                if is_bool(&l) && is_bool(&r) { Type::Prim(BaseType::Boolean) } else { self.promote(&l, &r) }
            }
            _ => Type::Unknown,
        }
    }

    fn conditional_type(&self, a: Type, b: Type) -> Type {
        match (&a, &b) {
            (Type::Null, x) | (x, Type::Null) => boxed(x),
            _ if a == b => a,
            _ if self.numeric(&a).is_some() && self.numeric(&b).is_some() && (a.is_primitive() || b.is_primitive()) => {
                self.promote(&a, &b)
            }
            (Type::Class(x), Type::Class(y)) => {
                if self.model.is_subclass(&x.key, &y.key) {
                    b
                } else if self.model.is_subclass(&y.key, &x.key) {
                    a
                } else {
                    Type::Unknown
                }
            }
            _ => Type::Unknown,
        }
    }

    fn switch_type(&self, e: Node<'t>) -> Type {
        let Some(body) = e.child_by_field_name("body") else { return Type::Unknown };
        let mut found = Type::Unknown;
        for rule in self.named_children(body) {
            if rule.kind() != "switch_rule" {
                continue;
            }
            for part in self.named_children(rule) {
                if part.kind() == "expression_statement" {
                    if let Some(x) = self.named_children(part).into_iter().next() {
                        let t = self.type_of(x);
                        if !matches!(t, Type::Null | Type::Unknown) {
                            return t;
                        }
                    }
                } else if !matches!(part.kind(), "switch_label" | "block" | "throw_statement") {
                    let t = self.type_of(part);
                    if !matches!(t, Type::Null | Type::Unknown) {
                        found = t;
                        break;
                    }
                }
            }
            if !found.is_unknown() {
                return found;
            }
        }
        found
    }

    // ---------------------------------------------------------------- variables

    /// The type of a local variable / parameter.
    pub(crate) fn local_type(&self, l: &LocalDecl<'t>) -> Type {
        match l.kind {
            LocalKind::Typed { ty, dims } => self.resolve_type_node(ty).array_of(dims),
            LocalKind::Varargs { ty } => self.resolve_type_node(ty).array_of(1),
            LocalKind::Inferred { init } => {
                // `var` takes the initializer's type (an intersection or capture is upward-projected).
                match self.type_of(init) {
                    Type::Null => Type::Unknown,
                    t => t,
                }
            }
            LocalKind::ForEach { ty: Some(ty), .. } => self.resolve_type_node(ty),
            LocalKind::ForEach { ty: None, iterable } => self.element_type(&self.type_of(iterable)),
            LocalKind::LambdaParam { lambda, index } => self.lambda_param_type(lambda, index),
            LocalKind::Catch { types } => {
                let parts: Vec<Node> = self.named_children(types);
                if parts.len() == 1 {
                    self.resolve_type_node(parts[0])
                } else {
                    // A union type: its members only through their common supertype.
                    Type::Unknown
                }
            }
            LocalKind::PatternVar { .. } => Type::Unknown,
        }
    }

    /// The element type of an array or `Iterable` (enhanced `for`).
    pub(crate) fn element_type(&self, t: &Type) -> Type {
        match t {
            Type::Array(e) => (**e).clone(),
            Type::Class(c) => match self.model.as_super(c, "java/lang/Iterable") {
                Some(it) => match it.args.first() {
                    Some(a) => a.upper().cloned().unwrap_or_else(Type::object),
                    None => Type::object(),
                },
                None => Type::Unknown,
            },
            Type::Var(v) => {
                let b = self.model.var_bound(v);
                if matches!(b, Type::Var(_)) { Type::Unknown } else { self.element_type(&b) }
            }
            _ => Type::Unknown,
        }
    }

    /// The type field `name` (declared in `declaring`) has as a member of `searched` (a class
    /// whose body encloses the use; its own type variables are in scope there) or of `recv`.
    fn field_type_in(&self, searched: &str, declaring: &str, name: &str, recv: Option<&ClassType>) -> Type {
        let Some(c) = self.model.class(declaring) else { return Type::Unknown };
        let Some(f) = self.model.members(&c).fields.iter().find(|f| f.name == name) else { return Type::Unknown };
        let base = match recv {
            Some(r) => r.clone(),
            None => match self.model.class(searched) {
                Some(s) => s.self_type(),
                None => return f.ty.clone(),
            },
        };
        match self.model.as_super(&base, declaring) {
            Some(view) => self.model.apply(&self.model.subst_of(&view), &f.ty),
            None => f.ty.clone(),
        }
    }

    /// `import static a.B.name;` / `import static a.B.*;` naming a field: (class, type).
    fn static_import_field(&self, name: &str) -> Option<(Key, Type)> {
        let stub = self.model.view.stub(self.file)?;
        let try_class = |owner: &str| -> Option<(Key, Type)> {
            let o = self.model.by_dotted(owner)?;
            let declaring = self.field_declaring_class(&o, name)?;
            let c = self.model.class(&declaring)?;
            let f = self
                .model
                .members(&c)
                .fields
                .iter()
                .find(|f| f.name == name && f.flags & crate::model::ACC_STATIC as u32 != 0)?;
            Some((declaring.clone(), f.ty.clone()))
        };
        for i in stub.imports.iter().filter(|i| i.is_static && !i.on_demand) {
            if let Some((owner, member)) = i.path.rsplit_once('.')
                && member == name
                && let Some(found) = try_class(owner)
            {
                return Some(found);
            }
        }
        stub.imports.iter().filter(|i| i.is_static && i.on_demand).find_map(|i| try_class(&i.path))
    }

    // ---------------------------------------------------------------- qualifiers and fields

    /// Classifies the qualifier of a dotted name or invocation (JLS §6.5.2).
    pub(crate) fn qualifier(&self, n: Node<'t>) -> Qualifier {
        match n.kind() {
            "identifier" => {
                let name = self.node_text(n);
                match self.lookup_variable(name, n) {
                    VarLookup::Local(l) => return Qualifier::Expr(self.local_type(&l)),
                    VarLookup::Field { searched, declaring } => {
                        return Qualifier::Expr(self.field_type_in(&searched, &declaring, name, None));
                    }
                    VarLookup::None => {}
                }
                if let Some((_, t)) = self.static_import_field(name) {
                    return Qualifier::Expr(t);
                }
                if let Some(t) = self.model.resolve_simple_type(name, &self.scope_at(n)) {
                    return Qualifier::Type(t);
                }
                if self.model.has_package(name) {
                    return Qualifier::Package(name.to_owned());
                }
                // A package with no class of its own (`com` of `com.acme.X`) or an unknown name.
                Qualifier::Package(name.to_owned())
            }
            "this" => Qualifier::Expr(self.type_of(n)),
            "super" => self.enclosing_key(n).map(Qualifier::Super).unwrap_or(Qualifier::Unknown),
            "field_access" => {
                let (Some(obj), Some(field)) = (n.child_by_field_name("object"), n.child_by_field_name("field")) else {
                    return Qualifier::Unknown;
                };
                let fname = self.node_text(field);
                if field.kind() == "this" {
                    // `Outer.this`
                    return match self.qualifier(obj) {
                        Qualifier::Type(Type::Class(c)) => Qualifier::Expr(
                            self.model.class(&c.key).map(|d| Type::Class(d.self_type())).unwrap_or(Type::Class(c)),
                        ),
                        _ => Qualifier::Unknown,
                    };
                }
                if obj.kind() == "super" || fname == "super" {
                    return Qualifier::Expr(self.type_of(n));
                }
                match self.qualifier(obj) {
                    Qualifier::Package(p) => {
                        let slashed = format!("{}/{fname}", p.replace('.', "/"));
                        if let Some(k) = self.model.top_level(&p.replace('.', "/"), fname) {
                            return Qualifier::Type(Type::class(k));
                        }
                        let _ = slashed;
                        Qualifier::Package(format!("{p}.{fname}"))
                    }
                    Qualifier::Type(Type::Class(c)) => {
                        if let Some(declaring) = self.field_declaring_class(&c.key, fname) {
                            return Qualifier::Expr(self.field_type_in(&c.key, &declaring, fname, Some(&c)));
                        }
                        match self.model.member_class(&c.key, fname) {
                            Some(k) => Qualifier::Type(Type::class(k)),
                            None => Qualifier::Unknown,
                        }
                    }
                    Qualifier::Expr(_) | Qualifier::Super(_) => Qualifier::Expr(self.type_of(n)),
                    _ => Qualifier::Unknown,
                }
            }
            _ => Qualifier::Expr(self.type_of(n)),
        }
    }

    /// The class type whose members a qualifier of type `t` exposes (a type variable: its bound;
    /// an array: `Object`'s).
    pub(crate) fn member_owner(&self, t: &Type) -> Option<ClassType> {
        match t {
            Type::Class(c) => Some(c.clone()),
            Type::Var(v) => match self.model.var_bound(v) {
                Type::Var(w) if &w != v => self.member_owner(&Type::Var(w)),
                Type::Class(c) => Some(c),
                _ => Some(ClassType { key: OBJECT.into(), args: Vec::new(), outer: None }),
            },
            Type::Array(_) => Some(ClassType { key: OBJECT.into(), args: Vec::new(), outer: None }),
            _ => None,
        }
    }

    fn field_access_type(&self, e: Node<'t>) -> Type {
        let (Some(obj), Some(field)) = (e.child_by_field_name("object"), e.child_by_field_name("field")) else {
            return Type::Unknown;
        };
        let name = self.node_text(field);
        if field.kind() == "this" {
            return match self.qualifier(e) {
                Qualifier::Expr(t) => t,
                _ => Type::Unknown,
            };
        }
        let (owner, recv) = match self.qualifier(obj) {
            Qualifier::Expr(Type::Array(_)) if name == "length" => return Type::Prim(BaseType::Int),
            Qualifier::Expr(t) => match self.member_owner(&t) {
                Some(c) => (c.key.clone(), Some(c)),
                None => return Type::Unknown,
            },
            Qualifier::Type(Type::Class(c)) => (c.key.clone(), None),
            Qualifier::Super(k) => {
                let sup = self.model.class(&k).and_then(|c| c.super_class.clone());
                match sup {
                    Some(Type::Class(c)) => (c.key.clone(), Some(c)),
                    _ => return Type::Unknown,
                }
            }
            Qualifier::Package(p) => {
                // `pkg.Type` used as an expression is not one; a qualified class name.
                let _ = p;
                return Type::Unknown;
            }
            _ => return Type::Unknown,
        };
        match self.field_declaring_class(&owner, name) {
            Some(declaring) => self.field_type_in(&owner, &declaring, name, recv.as_ref()),
            None => Type::Unknown,
        }
    }

    /// The field a `field_access` names: (declaring class).
    fn field_access_target(&self, e: Node<'t>) -> Resolution {
        let (Some(obj), Some(field)) = (e.child_by_field_name("object"), e.child_by_field_name("field")) else {
            return Resolution::Unknown;
        };
        let name = self.node_text(field);
        let owner = match self.qualifier(obj) {
            Qualifier::Expr(Type::Array(_)) if name == "length" => return Resolution::Builtin,
            Qualifier::Expr(t) => match self.member_owner(&t) {
                Some(c) => c.key,
                None => return Resolution::Unknown,
            },
            Qualifier::Type(Type::Class(c)) => c.key,
            Qualifier::Super(k) => match self.model.class(&k).and_then(|c| c.super_class.clone()) {
                Some(Type::Class(c)) => c.key,
                _ => return Resolution::Unknown,
            },
            Qualifier::Package(p) => {
                // `a.b` naming a package or a class (`java.util` in `java.util.List.of()`).
                if let Some(k) = self.model.top_level(&p.replace('.', "/"), name) {
                    return Resolution::Found(Target::Class(k));
                }
                return Resolution::Found(Target::Package(format!("{p}.{name}")));
            }
            _ => return Resolution::Unknown,
        };
        if self.model.class(&owner).is_none() {
            return Resolution::Unknown;
        }
        match self.field_declaring_class(&owner, name) {
            Some(class) => Resolution::Found(Target::Field { class, name: name.to_owned() }),
            None => match self.model.member_class(&owner, name) {
                Some(k) => Resolution::Found(Target::Class(k)),
                None => Resolution::Missing,
            },
        }
    }

    // ---------------------------------------------------------------- invocations

    fn arguments(&self, inv: Node<'t>) -> Vec<Node<'t>> {
        inv.child_by_field_name("arguments").map(|a| self.named_children(a)).unwrap_or_default()
    }

    fn arg_shape(&self, a: Node<'t>) -> Arg {
        let a = self.strip_parens(a);
        match a.kind() {
            "lambda_expression" => {
                let n = match a.child_by_field_name("parameters") {
                    Some(p) if p.kind() == "identifier" => 1,
                    Some(p) => self.named_children(p).len(),
                    None => 0,
                };
                Arg::Lambda(n)
            }
            "method_reference" => Arg::MethodRef,
            // A generic invocation (or `new C<>()`) is typed for applicability without its
            // target: typing it with the target would need this very call chosen first.
            "method_invocation" => Arg::Ty(self.standalone_type(a)),
            "object_creation_expression"
                if a.child_by_field_name("type")
                    .is_some_and(|t| ide_index::java::type_text(t, self.text).ends_with("<>")) =>
            {
                Arg::Ty(self.standalone_diamond(a))
            }
            _ => Arg::Ty(self.type_of(a)),
        }
    }

    /// The type of invocation `inv` from its arguments alone (JLS §15.12.2.2: implicitly typed
    /// lambdas and method references are not pertinent to applicability): the method's type
    /// arguments inferred from the other arguments and explicitly typed lambda parameters,
    /// what they leave open Unknown.
    fn standalone_type(&self, inv: Node<'t>) -> Type {
        if let Some(t) = self.standalone.borrow().get(&inv.id()) {
            return t.clone();
        }
        let call = self.call(inv);
        let t = match &call.chosen {
            None => Type::Unknown,
            Some(c) if c.method.type_params.is_empty() => self.type_of(inv),
            Some(c) => {
                let vars: Vec<TypeVar> = c.method.type_params.iter().map(|p| p.var.clone()).collect();
                let mut s = call.pre.clone();
                self.explicit_lambda_params(inv, c, &vars, &mut s);
                for v in &vars {
                    if s.get(v).is_none() {
                        s.put(v.clone(), TypeArg::Exact(Type::Unknown));
                    }
                }
                let mut all = c.subst.clone();
                all.extend(&s);
                self.model.apply(&all, &c.method.ret)
            }
        };
        self.standalone.borrow_mut().insert(inv.id(), t.clone());
        t
    }

    /// `new C<>(…)` before its target is known: C with Unknown type arguments.
    fn standalone_diamond(&self, inv: Node<'t>) -> Type {
        let Some(ty) = inv.child_by_field_name("type") else { return Type::Unknown };
        let Some(ct) = self.resolve_type_node(ty).as_class().cloned() else { return Type::Unknown };
        let Some(c) = self.model.class(&ct.key) else { return Type::Class(ct) };
        let args = c.type_params.iter().map(|_| TypeArg::Exact(Type::Unknown)).collect();
        Type::Class(ClassType { key: ct.key, args, outer: ct.outer })
    }

    /// Binds method type variables from the full types of the generic invocations (and `new`
    /// expressions) among `inv`'s arguments, but argument `skip`.
    fn unify_invocation_args(
        &self,
        inv: Node<'t>,
        c: &Candidate,
        vars: &[TypeVar],
        skip: Option<usize>,
        s: &mut Subst,
    ) {
        let n = c.method.params.len();
        for (i, a) in self.arguments(inv).into_iter().enumerate() {
            let a = self.strip_parens(a);
            if Some(i) == skip || !matches!(a.kind(), "method_invocation" | "object_creation_expression") {
                continue;
            }
            let Some(p) = c.method.params.get(i.min(n.saturating_sub(1))) else { continue };
            let p = match p {
                Type::Array(e) if c.method.varargs && i + 1 >= n => (**e).clone(),
                p => p.clone(),
            };
            let t = self.type_of(a);
            self.unify(&self.model.apply(&c.subst, &p), &t, vars, s);
        }
    }

    /// Binds method type variables from the declared parameter types of explicitly typed
    /// lambda arguments (`(Item c) -> …` makes `comparingInt`'s `T` an `Item`).
    fn explicit_lambda_params(&self, inv: Node<'t>, c: &Candidate, vars: &[TypeVar], s: &mut Subst) {
        for (i, a) in self.arguments(inv).into_iter().enumerate() {
            let a = self.strip_parens(a);
            if a.kind() != "lambda_expression" {
                continue;
            }
            let Some(params) = a.child_by_field_name("parameters").filter(|p| p.kind() == "formal_parameters") else {
                continue;
            };
            let declared: Vec<Type> = self
                .named_children(params)
                .into_iter()
                .filter_map(|fp| {
                    let ty = fp.child_by_field_name("type")?;
                    (self.node_text(ty) != "var").then(|| self.resolve_type_node(ty))
                })
                .collect();
            let Some(p) = self.param_type_for(c, i, s) else { continue };
            let Some(f) = self.functional_method(&self.non_wildcard(&p)) else { continue };
            if declared.len() != f.method.params.len() {
                continue;
            }
            for (fp, d) in f.method.params.iter().zip(&declared) {
                self.unify(&self.model.apply(&f.subst, fp), d, vars, s);
            }
        }
    }

    /// What `inv`'s method type arguments are while typing its lambda arguments: from the other
    /// arguments, explicitly typed lambda parameters and the invocation's target type
    /// (`sorted(Comparator.comparingInt(e -> …))` makes `T` the stream's element type). What stays
    /// open is Unknown — never the variable's bound, which would make real members "missing".
    fn inference_for_target(&self, inv: Node<'t>, c: &Candidate, call: &Call, skip: usize) -> Subst {
        let vars: Vec<TypeVar> = c.method.type_params.iter().map(|p| p.var.clone()).collect();
        let mut s = call.pre.clone();
        if vars.is_empty() {
            return s;
        }
        // Bindings from standalone argument types may hold Unknown parts: the other generic
        // invocations among the arguments are typed in full (`usingWhen(fromSupplier(() -> r),
        // r -> …)`: the resource type comes from the first argument's lambda), then the target.
        s.retain(|_, a| !matches!(a, TypeArg::Exact(t) | TypeArg::Extends(t) | TypeArg::Super(t) if t.has_unknown()));
        self.unify_invocation_args(inv, c, &vars, Some(skip), &mut s);
        self.explicit_lambda_params(inv, c, &vars, &mut s);
        if vars.iter().any(|v| s.get(v).is_none())
            && let Some(target) = self.target_type(inv)
        {
            let ret = self.model.apply(&c.subst, &c.method.ret);
            self.unify_target(&ret, &target, &vars, &mut s);
        }
        for v in &vars {
            if s.get(v).is_none() {
                s.put(v.clone(), TypeArg::Exact(Type::Unknown));
            }
        }
        s
    }

    /// Explicit type arguments of an invocation (`this.<String>m()`).
    fn explicit_type_args(&self, inv: Node<'t>) -> Vec<Type> {
        inv.child_by_field_name("type_arguments")
            .map(|ta| self.named_children(ta).into_iter().map(|t| self.resolve_type_node(t)).collect())
            .unwrap_or_default()
    }

    /// The method invoked by a `method_invocation`, an `object_creation_expression`, an
    /// `explicit_constructor_invocation` or an `enum_constant` (memoized).
    pub(crate) fn call(&self, inv: Node<'t>) -> Call {
        if let Some(c) = self.calls.borrow().get(&inv.id()) {
            return c.clone();
        }
        let key = usize::MAX - inv.id();
        if !self.busy.borrow_mut().insert(key) {
            return Call { res: Resolution::Unknown, chosen: None, pre: Subst::default(), unknown_args: true };
        }
        let call = self.compute_call(inv);
        self.busy.borrow_mut().remove(&key);
        self.calls.borrow_mut().insert(inv.id(), call.clone());
        call
    }

    fn compute_call(&self, inv: Node<'t>) -> Call {
        let unknown = Call { res: Resolution::Unknown, chosen: None, pre: Subst::default(), unknown_args: true };
        let from = self.enclosing_key(inv);
        let candidates: Vec<Candidate> = match inv.kind() {
            "method_invocation" => {
                let Some(name) = inv.child_by_field_name("name") else { return unknown };
                let name = self.node_text(name);
                match inv.child_by_field_name("object") {
                    None => {
                        // JLS §15.12.1: the innermost enclosing class with a member method so named.
                        let mut found = Vec::new();
                        let mut next = from.clone();
                        while let Some(k) = next {
                            let Some(c) = self.model.class(&k) else { return unknown };
                            let ms = self.member_methods(&c.self_type(), name, from.as_deref());
                            if !ms.is_empty() {
                                found = ms;
                                break;
                            }
                            if self.has_unknown_supertype(&k) {
                                return unknown;
                            }
                            next = c.outer.clone();
                        }
                        if found.is_empty() {
                            found = self.static_import_methods(name, from.as_deref());
                        }
                        found
                    }
                    Some(obj) => {
                        let recv = match self.qualifier(obj) {
                            Qualifier::Expr(t) => match self.member_owner(&t) {
                                Some(c) => c,
                                None => return unknown,
                            },
                            Qualifier::Type(Type::Class(c)) => ClassType { args: Vec::new(), ..c },
                            Qualifier::Super(k) => {
                                // `super.m()` and `X.super.m()` (X an interface: its method).
                                let target = if obj.kind() == "field_access" {
                                    obj.child_by_field_name("object").and_then(|q| match self.qualifier(q) {
                                        Qualifier::Type(Type::Class(c)) => Some(c),
                                        _ => None,
                                    })
                                } else {
                                    None
                                };
                                match target {
                                    Some(iface) if self.model.class(&iface.key).is_some_and(|c| c.is_interface()) => {
                                        iface
                                    }
                                    _ => match self.model.class(&k).and_then(|c| c.super_class.clone()) {
                                        Some(Type::Class(c)) => c,
                                        _ => return unknown,
                                    },
                                }
                            }
                            _ => return unknown,
                        };
                        if self.model.class(&recv.key).is_none() || self.has_unknown_supertype(&recv.key) {
                            return unknown;
                        }
                        self.member_methods(&recv, name, from.as_deref())
                    }
                }
            }
            "object_creation_expression" => {
                let Some(ct) = self.created_class(inv) else { return unknown };
                let Some(c) = self.model.class(&ct.key) else { return unknown };
                if c.is_interface() {
                    // `new I() {…}`: Object's constructor, no argument.
                    return Call { res: Resolution::Missing, chosen: None, pre: Subst::default(), unknown_args: false };
                }
                let anonymous = self.named_children(inv).iter().any(|n| n.kind() == "class_body");
                if anonymous {
                    // The anonymous class is a subclass: protected constructors are accessible
                    // (JLS §6.6.2.2).
                    let mut ctors = self.constructors(&ct, Some(&ct.key));
                    let top = |k: &str| k.split('$').next().unwrap_or(k).to_owned();
                    ctors.retain(|m| {
                        m.method.flags & crate::model::ACC_PRIVATE as u32 == 0
                            || from.as_deref().is_some_and(|f| top(f) == top(&ct.key))
                    });
                    ctors
                } else {
                    self.constructors(&ct, from.as_deref())
                }
            }
            "explicit_constructor_invocation" => {
                let Some(k) = from.clone() else { return unknown };
                let Some(c) = self.model.class(&k) else { return unknown };
                let is_super = inv.child_by_field_name("constructor").is_some_and(|n| n.kind() == "super");
                let ct = if is_super {
                    match &c.super_class {
                        Some(Type::Class(s)) => s.clone(),
                        _ => return unknown,
                    }
                } else {
                    c.self_type()
                };
                self.constructors(&ct, from.as_deref())
            }
            "enum_constant" => {
                let Some(k) = from.clone() else { return unknown };
                // The constant's own body is an anonymous subclass: its enum's constructor.
                let enum_key = if self.model.class(&k).is_some_and(|c| c.kind == crate::model::ClassKind::Enum) {
                    k
                } else {
                    self.model.class(&k).and_then(|c| c.outer.clone()).unwrap_or(k)
                };
                let Some(c) = self.model.class(&enum_key) else { return unknown };
                self.constructors(&c.self_type(), Some(&enum_key))
            }
            _ => return unknown,
        };
        // Without the JDK, `Object`'s methods are unknown: a call that may be one of them is too.
        if inv.kind() == "method_invocation"
            && self.model.class(OBJECT).is_none()
            && inv.child_by_field_name("name").is_some_and(|n| OBJECT_METHODS.contains(&self.node_text(n)))
        {
            return unknown;
        }
        let args: Vec<Arg> = self.arguments(inv).into_iter().map(|a| self.arg_shape(a)).collect();
        let unknown_args = args.iter().any(|a| matches!(a, Arg::Ty(t) if t.has_unknown()));
        match self.choose(candidates, &args) {
            Choice::Chosen(c) => {
                let c = *c;
                let mut pre = Subst::default();
                let vars: Vec<TypeVar> = c.method.type_params.iter().map(|p| p.var.clone()).collect();
                let explicit = self.explicit_type_args(inv);
                if explicit.len() == vars.len() {
                    for (v, t) in vars.iter().zip(explicit) {
                        pre.put(v.clone(), TypeArg::Exact(t));
                    }
                }
                let arg_nodes = self.arguments(inv);
                for (i, a) in args.iter().enumerate() {
                    if let Arg::Ty(t) = a {
                        let n = c.method.params.len();
                        let p = if c.method.varargs && i + 1 >= n {
                            match c.method.params.get(n - 1) {
                                // A matching array passes as the array itself.
                                Some(Type::Array(e)) if !matches!(t, Type::Array(_)) || args.len() != n => {
                                    (**e).clone()
                                }
                                Some(p) => p.clone(),
                                None => continue,
                            }
                        } else {
                            c.method.params[i].clone()
                        };
                        let p = self.model.apply(&c.subst, &p);
                        self.unify(&p, t, &vars, &mut pre);
                    }
                    let _ = &arg_nodes;
                }
                let target = self.method_target(&c.class, &c.method);
                Call { res: Resolution::Found(target), chosen: Some(c), pre, unknown_args }
            }
            Choice::None => Call { res: Resolution::Missing, chosen: None, pre: Subst::default(), unknown_args },
            Choice::Unknown => Call { res: Resolution::Unknown, chosen: None, pre: Subst::default(), unknown_args },
        }
    }

    /// Whether a supertype of `key` is unknown (its inherited members could be anything).
    /// A missing `java.lang.Object` (no JDK known) is not: it only contributes the methods
    /// [`OBJECT_METHODS`] names, which callers check for themselves.
    pub(crate) fn has_unknown_supertype(&self, key: &str) -> bool {
        let mut seen = std::collections::HashSet::new();
        let mut queue: Vec<Key> = vec![key.into()];
        while let Some(k) = queue.pop() {
            if !seen.insert(k.clone()) {
                continue;
            }
            let Some(c) = self.model.class(&k) else {
                if &*k == OBJECT {
                    continue;
                }
                return true;
            };
            for s in c.super_class.iter().chain(&c.interfaces) {
                match s {
                    Type::Class(x) => queue.push(x.key.clone()),
                    _ => return true,
                }
            }
        }
        false
    }

    fn static_import_methods(&self, name: &str, from: Option<&str>) -> Vec<Candidate> {
        let Some(stub) = self.model.view.stub(self.file) else { return Vec::new() };
        let mut out = Vec::new();
        let statics = |owner: &str, out: &mut Vec<Candidate>| {
            if let Some(o) = self.model.by_dotted(owner)
                && let Some(c) = self.model.class(&o)
            {
                let raw = ClassType { key: c.key.clone(), args: Vec::new(), outer: None };
                out.extend(self.member_methods(&raw, name, from).into_iter().filter(|m| m.method.is_static()));
            }
        };
        for i in stub.imports.iter().filter(|i| i.is_static && !i.on_demand) {
            if let Some((owner, member)) = i.path.rsplit_once('.')
                && member == name
            {
                statics(owner, &mut out);
            }
        }
        if out.is_empty() {
            for i in stub.imports.iter().filter(|i| i.is_static && i.on_demand) {
                statics(&i.path, &mut out);
            }
        }
        out
    }

    /// The class instantiated by `new` (with its written type arguments, or inferred for `<>`).
    pub(crate) fn created_class(&self, inv: Node<'t>) -> Option<ClassType> {
        let ty = inv.child_by_field_name("type")?;
        // `outer.new Inner()`: Inner is a member class of outer's type.
        let qualified = self.named_children(inv).into_iter().find(|n| {
            !matches!(n.kind(), "argument_list" | "class_body" | "type_arguments" | "annotation" | "marker_annotation")
                && n.id() != ty.id()
        });
        let t = match qualified {
            Some(q) => {
                let outer = self.member_owner(&self.type_of(q))?;
                let name = ide_index::java::type_text(ty, self.text);
                let base = name.split('<').next().unwrap_or(&name);
                Type::class(self.model.member_class(&outer.key, base)?)
            }
            None => self.resolve_type_node(ty),
        };
        let ct = t.as_class()?.clone();
        let text = ide_index::java::type_text(ty, self.text);
        if text.ends_with("<>") {
            return Some(self.diamond(inv, ct));
        }
        Some(ct)
    }

    /// `new C<>(args)`: C's type arguments from the target type, else Unknown arguments.
    fn diamond(&self, inv: Node<'t>, ct: ClassType) -> ClassType {
        let Some(c) = self.model.class(&ct.key) else { return ct };
        let vars: Vec<TypeVar> = c.type_params.iter().map(|p| p.var.clone()).collect();
        let mut s = Subst::default();
        if let Some(target) = self.target_type(inv) {
            self.unify_target(&Type::Class(c.self_type()), &target, &vars, &mut s);
        }
        let args = vars
            .iter()
            .map(|v| match s.get(v) {
                Some(a) => a.clone(),
                None => TypeArg::Exact(Type::Unknown),
            })
            .collect();
        ClassType { key: ct.key, args, outer: ct.outer }
    }

    fn creation_type(&self, inv: Node<'t>) -> Type {
        // An anonymous class instance has the anonymous class's type.
        if self.named_children(inv).iter().any(|n| n.kind() == "class_body")
            && let Some(k) = self.declared_key(inv)
        {
            return Type::class(k);
        }
        self.created_class(inv).map(Type::Class).unwrap_or(Type::Unknown)
    }

    /// The type an invocation evaluates to, with the method's type arguments inferred from all
    /// the arguments (lambda bodies included) and the target type.
    fn invocation_type(&self, inv: Node<'t>) -> Type {
        let call = self.call(inv);
        let Some(c) = &call.chosen else { return Type::Unknown };
        let vars: Vec<TypeVar> = c.method.type_params.iter().map(|p| p.var.clone()).collect();
        let mut s = call.pre.clone();
        if !vars.is_empty() {
            // Generic invocations among the arguments were typed standalone for choosing the
            // method; now that it is chosen they are typed with their target.
            s.retain(
                |_, a| !matches!(a, TypeArg::Exact(t) | TypeArg::Extends(t) | TypeArg::Super(t) if t.has_unknown()),
            );
            self.unify_invocation_args(inv, c, &vars, None, &mut s);
            self.explicit_lambda_params(inv, c, &vars, &mut s);
            // Lambda and method reference arguments: their bodies' types.
            for (i, a) in self.arguments(inv).into_iter().enumerate() {
                let a = self.strip_parens(a);
                if !matches!(a.kind(), "lambda_expression" | "method_reference") {
                    continue;
                }
                let Some(p) = self.param_type_for(c, i, &s) else { continue };
                let Some(f) = self.functional_method(&self.non_wildcard(&p)) else { continue };
                let ret_template = self.model.apply(&f.subst, &f.method.ret);
                let body = match a.kind() {
                    "lambda_expression" => self.lambda_body_type(a),
                    _ => self.method_ref_return(a),
                };
                if let Some(b) = body {
                    self.unify(&ret_template, &b, &vars, &mut s);
                }
            }
            if vars.iter().any(|v| s.get(v).is_none())
                && let Some(target) = self.target_type(inv)
            {
                let ret = self.model.apply(&c.subst, &c.method.ret);
                self.unify_target(&ret, &target, &vars, &mut s);
            }
            for v in &vars {
                if s.get(v).is_none() {
                    let fill =
                        if call.unknown_args { Type::Unknown } else { self.model.erasure(&Type::Var(v.clone())) };
                    s.put(v.clone(), TypeArg::Exact(fill));
                }
            }
        }
        let mut all = c.subst.clone();
        all.extend(&s);
        let ret = self.model.apply(&all, &c.method.ret);
        // `getClass()` is typed `Class<? extends |T|>` (JLS §4.3.2).
        if c.method.name == "getClass"
            && c.method.params.is_empty()
            && &*c.class == OBJECT
            && let Some(obj) = inv.child_by_field_name("object")
        {
            let t = self.model.erasure(&self.type_of(obj));
            return Type::Class(ClassType {
                key: "java/lang/Class".into(),
                args: vec![TypeArg::Extends(t)],
                outer: None,
            });
        }
        ret
    }

    /// Parameter `i` of the chosen method as the argument sees it (varargs element beyond the
    /// last), with the receiver's and inferred substitutions.
    fn param_type_for(&self, c: &Candidate, i: usize, inferred: &Subst) -> Option<Type> {
        let n = c.method.params.len();
        let p = if c.method.varargs && i + 1 >= n {
            match c.method.params.get(n.checked_sub(1)?)? {
                Type::Array(e) if i + 1 > n || n > 0 => (**e).clone(),
                other => other.clone(),
            }
        } else {
            c.method.params.get(i)?.clone()
        };
        let mut s = c.subst.clone();
        s.extend(inferred);
        Some(self.model.apply(&s, &p))
    }

    // ---------------------------------------------------------------- lambdas and targets

    /// The type the context of expression `e` expects (JLS §15.27.3 target typing).
    pub(crate) fn target_type(&self, e: Node<'t>) -> Option<Type> {
        let parent = e.parent()?;
        match parent.kind() {
            "parenthesized_expression" => self.target_type(parent),
            "argument_list" => {
                let inv = parent.parent()?;
                let index = self.named_children(parent).iter().position(|a| a.id() == e.id())?;
                let call = self.call(inv);
                let c = call.chosen.as_ref()?;
                let s = self.inference_for_target(inv, c, &call, index);
                self.param_type_for(c, index, &s)
            }
            "variable_declarator" if parent.child_by_field_name("value").is_some_and(|v| v.id() == e.id()) => {
                let decl = parent.parent()?;
                let ty = decl.child_by_field_name("type")?;
                if self.node_text(ty) == "var" {
                    return None;
                }
                let dims =
                    parent.child_by_field_name("dimensions").map_or(0, |d| self.node_text(d).matches('[').count());
                Some(self.resolve_type_node(ty).array_of(dims))
            }
            "assignment_expression" if parent.child_by_field_name("right").is_some_and(|r| r.id() == e.id()) => {
                parent.child_by_field_name("left").map(|l| self.type_of(l))
            }
            "return_statement" => self.return_target(parent),
            "lambda_expression" if parent.child_by_field_name("body").is_some_and(|b| b.id() == e.id()) => {
                let f = self.functional_method(&self.non_wildcard(&self.target_type(parent)?))?;
                Some(self.model.apply(&f.subst, &f.method.ret))
            }
            "cast_expression" => parent.child_by_field_name("type").map(|t| self.resolve_type_node(t)),
            "ternary_expression" if parent.child_by_field_name("condition").is_none_or(|c| c.id() != e.id()) => {
                self.target_type(parent)
            }
            "array_initializer" => match self.target_type(parent)? {
                Type::Array(c) => Some(*c),
                _ => None,
            },
            "array_creation_expression" => {
                let ty = parent.child_by_field_name("type")?;
                let base = self.resolve_type_node(ty);
                let dims = parent
                    .child_by_field_name("dimensions")
                    .map_or(1, |d| self.node_text(d).matches('[').count().max(1));
                Some(base.array_of(dims))
            }
            "element_value_pair" | "annotation_argument_list" => None,
            _ => None,
        }
    }

    /// What a `return` inside a lambda or method must produce.
    fn return_target(&self, ret: Node<'t>) -> Option<Type> {
        let mut cur = ret.parent();
        while let Some(p) = cur {
            match p.kind() {
                "lambda_expression" => {
                    let f = self.functional_method(&self.non_wildcard(&self.target_type(p)?))?;
                    return Some(self.model.apply(&f.subst, &f.method.ret));
                }
                "method_declaration" => {
                    let ty = p.child_by_field_name("type")?;
                    return Some(self.resolve_type_node(ty));
                }
                k if is_class_decl(k) || k == "class_body" => return None,
                _ => {}
            }
            cur = p.parent();
        }
        None
    }

    /// The non-wildcard parameterization of a functional interface type (JLS §9.9): `?` → the
    /// parameter's bound, `? extends U` → `U`, `? super L` → `L`.
    pub(crate) fn non_wildcard(&self, t: &Type) -> Type {
        let Type::Class(ct) = t else { return t.clone() };
        if ct.args.iter().all(|a| matches!(a, TypeArg::Exact(_))) {
            return t.clone();
        }
        let params = self.model.class(&ct.key).map(|c| c.type_params.clone()).unwrap_or_default();
        let args = ct
            .args
            .iter()
            .enumerate()
            .map(|(i, a)| match a {
                TypeArg::Exact(x) | TypeArg::Extends(x) | TypeArg::Super(x) => TypeArg::Exact(x.clone()),
                TypeArg::Any => TypeArg::Exact(
                    params
                        .get(i)
                        .and_then(|p| p.bounds.first().cloned())
                        .filter(|b| !matches!(b, Type::Var(_)))
                        .unwrap_or_else(Type::object),
                ),
            })
            .collect();
        Type::Class(ClassType { key: ct.key.clone(), args, outer: ct.outer.clone() })
    }

    /// The type of parameter `index` of an implicitly typed lambda (JLS §15.27.3: the function
    /// type of the target, wildcards replaced by their bounds, §9.9).
    pub(crate) fn lambda_param_type(&self, lambda: Node<'t>, index: usize) -> Type {
        let Some(target) = self.target_type(lambda) else { return Type::Unknown };
        let Some(f) = self.functional_method(&self.non_wildcard(&target)) else { return Type::Unknown };
        match f.method.params.get(index) {
            Some(p) => self.model.apply(&f.subst, p),
            None => Type::Unknown,
        }
    }

    /// The type a lambda's body produces: its expression, or its first `return` with a value.
    fn lambda_body_type(&self, lambda: Node<'t>) -> Option<Type> {
        let body = lambda.child_by_field_name("body")?;
        if body.kind() != "block" {
            let t = self.type_of(body);
            return (!t.is_unknown()).then_some(t);
        }
        let mut stack = vec![body];
        while let Some(n) = stack.pop() {
            for c in self.named_children(n).into_iter().rev() {
                match c.kind() {
                    "return_statement" => {
                        if let Some(v) = self.named_children(c).into_iter().next() {
                            let t = self.type_of(v);
                            if !matches!(t, Type::Unknown | Type::Null) {
                                return Some(t);
                            }
                        }
                    }
                    "lambda_expression" | "class_body" => {}
                    _ => stack.push(c),
                }
            }
        }
        None
    }

    // ---------------------------------------------------------------- method references

    /// The method a method reference names, given its target's function type.
    pub(crate) fn method_ref(&self, r: Node<'t>) -> (Resolution, Option<Candidate>) {
        let parts = self.named_children(r);
        let Some(last) = parts.last() else { return (Resolution::Unknown, None) };
        let qualifier = parts.first().copied();
        // `Type::new`: the last token is the `new` keyword (not a named child).
        let is_new = r.child(r.child_count().saturating_sub(1)).is_some_and(|t| t.kind() == "new");
        if !is_new && parts.len() < 2 {
            return (Resolution::Unknown, None);
        }
        let name = if is_new { "<init>".to_owned() } else { self.node_text(*last).to_owned() };
        let from = self.enclosing_key(r);
        let fn_params: Option<Vec<Type>> = self
            .target_type(r)
            .and_then(|t| self.functional_method(&self.non_wildcard(&t)))
            .map(|f| f.method.params.iter().map(|p| self.model.apply(&f.subst, p)).collect());
        let Some(q) = qualifier else { return (Resolution::Unknown, None) };
        let (owner, static_ok, instance_shift) = match q.kind() {
            "super" => {
                match self.enclosing_key(r).and_then(|k| self.model.class(&k)).and_then(|c| c.super_class.clone()) {
                    Some(Type::Class(c)) => (c, false, false),
                    _ => return (Resolution::Unknown, None),
                }
            }
            _ => match self.qualifier(q) {
                Qualifier::Type(Type::Class(c)) => (c, true, true),
                Qualifier::Expr(t) => match self.member_owner(&t) {
                    Some(c) => (c, false, false),
                    None => return (Resolution::Unknown, None),
                },
                _ => {
                    // An array type or a generic type written with arguments (`List<String>::size`).
                    let t = self.resolve_type_node(q);
                    match t {
                        Type::Class(c) => (c, true, true),
                        _ => return (Resolution::Unknown, None),
                    }
                }
            },
        };
        if self.model.class(&owner.key).is_none() || self.has_unknown_supertype(&owner.key) {
            return (Resolution::Unknown, None);
        }
        let candidates = if is_new {
            self.constructors(&owner, from.as_deref())
        } else {
            self.member_methods(&owner, &name, from.as_deref())
        };
        if candidates.is_empty() {
            return (Resolution::Missing, None);
        }
        // One method so named: whatever the target, it is the one meant.
        let pick = |c: &Candidate| (Resolution::Found(self.method_target(&c.class, &c.method)), Some(c.clone()));
        if candidates.len() == 1 {
            return pick(&candidates[0]);
        }
        let Some(params) = fn_params else { return (Resolution::Unknown, None) };
        // `Type::m` may be a static method taking all the parameters or an instance method
        // taking all but the first (the receiver); `expr::m` an instance method taking all.
        let mut fits: Vec<&Candidate> = Vec::new();
        for c in &candidates {
            let n = c.method.params.len();
            let as_static = (is_new || c.method.is_static() || !instance_shift) && n == params.len();
            let as_instance = static_ok && instance_shift && !c.method.is_static() && n + 1 == params.len();
            let check = |args: &[Type]| {
                args.iter().zip(&c.method.params).all(|(a, p)| {
                    let p = self.model.apply(&c.subst, p);
                    let vars: Vec<TypeVar> = c.method.type_params.iter().map(|x| x.var.clone()).collect();
                    self.fits(a, &p, true, &vars) != super::methods::Fit::No
                })
            };
            if as_static && check(&params) || as_instance && check(&params[1..]) {
                fits.push(c);
            }
        }
        match fits.len() {
            1 => pick(fits[0]),
            0 => (Resolution::Missing, None),
            _ => (Resolution::Unknown, None),
        }
    }

    fn method_ref_return(&self, r: Node<'t>) -> Option<Type> {
        let (_, c) = self.method_ref(r);
        let c = c?;
        if c.method.is_constructor() {
            return Some(Type::Class(self.model.class(&c.class)?.self_type()));
        }
        let t = self.model.apply(&c.subst, &c.method.ret);
        (!t.has_unknown() && c.method.type_params.is_empty()).then_some(t)
    }

    // ---------------------------------------------------------------- references

    /// Resolves an identifier by its syntactic role.
    pub(crate) fn resolve_reference(&self, ident: Node<'t>) -> Resolution {
        let Some(parent) = ident.parent() else { return Resolution::Unknown };
        let is_field = |f: &str| parent.child_by_field_name(f).is_some_and(|n| n.id() == ident.id());
        if let Some(t) = self.declared_target(ident) {
            return Resolution::Found(t);
        }
        match parent.kind() {
            "method_invocation" if is_field("name") => return self.call(parent).res,
            "field_access" if is_field("field") => return self.field_access_target(parent),
            "method_reference" => {
                let parts = self.named_children(parent);
                if parts.last().is_some_and(|l| l.id() == ident.id()) && parts.len() > 1 {
                    return self.method_ref(parent).0;
                }
            }
            "marker_annotation" | "annotation" if is_field("name") => {
                return match self.model.resolve_simple_type(self.node_text(ident), &self.scope_at(ident)) {
                    Some(Type::Class(c)) => Resolution::Found(Target::Class(c.key)),
                    _ => Resolution::Unknown,
                };
            }
            "element_value_pair" if is_field("key") => return self.annotation_element(parent, ident),
            "scoped_identifier" => return self.resolve_scoped_identifier(ident),
            "switch_label" => {
                if let Some(r) = self.enum_case(parent, ident) {
                    return r;
                }
            }
            "labeled_statement" | "break_statement" | "continue_statement" => return Resolution::Builtin,
            _ => {}
        }
        if ident.kind() == "type_identifier" {
            return self.resolve_type_identifier(ident);
        }
        // An expression name: variable, else a type or package qualifying something.
        let name = self.node_text(ident);
        match self.lookup_variable(name, ident) {
            VarLookup::Local(l) => return Resolution::Found(Target::Local(l.name.start_byte())),
            VarLookup::Field { declaring, .. } => {
                return Resolution::Found(Target::Field { class: declaring, name: name.to_owned() });
            }
            VarLookup::None => {}
        }
        if let Some((class, _)) = self.static_import_field(name) {
            return Resolution::Found(Target::Field { class, name: name.to_owned() });
        }
        // An enclosing class with an unknown supertype may have inherited the field.
        if let Some(k) = self.enclosing_key(ident)
            && self.has_unknown_supertype(&k)
        {
            return Resolution::Unknown;
        }
        match self.qualifier(ident) {
            Qualifier::Type(Type::Class(c)) => Resolution::Found(Target::Class(c.key)),
            Qualifier::Type(Type::Var(v)) => Resolution::Found(Target::TypeVar(v)),
            Qualifier::Package(p) if self.model.has_package(&p.replace('.', "/")) => {
                Resolution::Found(Target::Package(p))
            }
            _ => Resolution::Unknown,
        }
    }

    /// A `type_identifier`: a type name, possibly a segment of a qualified one.
    fn resolve_type_identifier(&self, ident: Node<'t>) -> Resolution {
        // The segments of the qualified name up to and including `ident`.
        let mut segs: Vec<Node<'t>> = vec![ident];
        // `a.b.C`: ident is the last child of a scoped name whose first child qualifies it (when
        // ident is that first child, it is a qualifier itself and resolves on its own).
        if let Some(p) = ident.parent().filter(|p| p.kind() == "scoped_type_identifier") {
            let children = self.named_children(p);
            let pos = children.iter().position(|c| c.id() == ident.id());
            if pos.is_some_and(|i| i > 0)
                && matches!(children[0].kind(), "type_identifier" | "scoped_type_identifier" | "generic_type")
            {
                segs.insert(0, children[0]);
            }
        }
        if segs.len() == 1 {
            let name = self.node_text(ident);
            if name == "var" {
                return Resolution::Missing;
            }
            return match self.model.resolve_simple_type(name, &self.scope_at(ident)) {
                Some(Type::Class(c)) => Resolution::Found(Target::Class(c.key)),
                Some(Type::Var(v)) => Resolution::Found(Target::TypeVar(v)),
                _ => {
                    // `java` of `java.util.List`: a package.
                    if ident.parent().is_some_and(|p| p.kind() == "scoped_type_identifier")
                        && self.model.has_package(name)
                    {
                        Resolution::Found(Target::Package(name.to_owned()))
                    } else {
                        Resolution::Unknown
                    }
                }
            };
        }
        // Qualifier then this segment: resolve the qualifier's type text, then a member class.
        let qual_text = ide_index::java::type_text(segs[0], self.text);
        let qual_plain: String = {
            let mut depth = 0;
            qual_text
                .chars()
                .filter(|c| {
                    match c {
                        '<' => depth += 1,
                        '>' => depth -= 1,
                        _ => return depth == 0,
                    }
                    false
                })
                .collect()
        };
        let name = self.node_text(ident);
        match self.model.resolve_text(&qual_plain, &self.scope_at(ident)) {
            Type::Class(c) => match self.model.member_class(&c.key, name) {
                Some(k) => Resolution::Found(Target::Class(k)),
                None => Resolution::Missing,
            },
            _ => {
                let pkg = qual_plain.replace('.', "/");
                if let Some(k) = self.model.top_level(&pkg, name) {
                    Resolution::Found(Target::Class(k))
                } else if self.model.has_package(&format!("{pkg}/{name}")) {
                    Resolution::Found(Target::Package(format!("{qual_plain}.{name}")))
                } else {
                    Resolution::Unknown
                }
            }
        }
    }

    /// An identifier in an import / package declaration (`scoped_identifier` chains).
    fn resolve_scoped_identifier(&self, ident: Node<'t>) -> Resolution {
        // The dotted text up to and including ident.
        let mut top = ident;
        while let Some(p) = top.parent() {
            if p.kind() != "scoped_identifier" {
                break;
            }
            top = p;
        }
        let in_package = top.parent().is_some_and(|p| p.kind() == "package_declaration");
        // The identifiers of the chain up to `ident` (comments and spaces between them aside).
        let mut parts = Vec::new();
        let mut stack = vec![top];
        while let Some(x) = stack.pop() {
            if x.kind() == "identifier" {
                if x.start_byte() <= ident.start_byte() {
                    parts.push((x.start_byte(), self.node_text(x)));
                }
                continue;
            }
            let mut c = x.walk();
            stack.extend(x.named_children(&mut c).filter(|y| !y.is_extra()));
        }
        parts.sort();
        let dotted: String = parts.iter().map(|(_, t)| *t).collect::<Vec<_>>().join(".");
        // `@Outer.Inner(…)`: a type name in scope, not an import.
        if top.parent().is_some_and(|p| matches!(p.kind(), "annotation" | "marker_annotation")) {
            return match self.model.resolve_text(&dotted, &self.scope_at(top)) {
                Type::Class(c) => Resolution::Found(Target::Class(c.key)),
                _ if self.model.has_package(&dotted.replace('.', "/")) => Resolution::Found(Target::Package(dotted)),
                _ => Resolution::Unknown,
            };
        }
        if in_package {
            return Resolution::Found(Target::Package(dotted));
        }
        let is_static_import = top.parent().is_some_and(|p| {
            p.kind() == "import_declaration" && {
                let mut c = p.walk();
                p.children(&mut c).any(|x| x.kind() == "static")
            }
        });
        if let Some(k) = self.model.by_dotted(&dotted) {
            return Resolution::Found(Target::Class(k));
        }
        if is_static_import
            && ident.end_byte() == top.end_byte()
            && let Some((owner, member)) = dotted.rsplit_once('.')
            && let Some(o) = self.model.by_dotted(owner)
        {
            if let Some(class) = self.field_declaring_class(&o, member) {
                return Resolution::Found(Target::Field { class, name: member.to_owned() });
            }
            // A static method import names every static method so called: the first stands for them.
            if let Some(c) = self.model.class(&o) {
                let raw = ClassType { key: c.key.clone(), args: Vec::new(), outer: None };
                let ms: Vec<Candidate> =
                    self.member_methods(&raw, member, None).into_iter().filter(|m| m.method.is_static()).collect();
                if ms.len() == 1 {
                    return Resolution::Found(self.method_target(&ms[0].class, &ms[0].method));
                }
                if !ms.is_empty() {
                    return Resolution::Unknown;
                }
            }
            return Resolution::Missing;
        }
        if self.model.has_package(&dotted.replace('.', "/")) {
            Resolution::Found(Target::Package(dotted))
        } else {
            Resolution::Unknown
        }
    }

    /// `@Ann(key = …)`: the annotation type's element method `key`.
    fn annotation_element(&self, pair: Node<'t>, key: Node<'t>) -> Resolution {
        let Some(args) = pair.parent() else { return Resolution::Unknown };
        let Some(ann) = args.parent() else { return Resolution::Unknown };
        let Some(name) = ann.child_by_field_name("name") else { return Resolution::Unknown };
        let text = ide_index::java::type_text(name, self.text);
        let Type::Class(c) = self.model.resolve_text(&text, &self.scope_at(name)) else { return Resolution::Unknown };
        let Some(cls) = self.model.class(&c.key) else { return Resolution::Unknown };
        let elem = self.node_text(key);
        match self.model.members(&cls).methods.iter().find(|m| m.name == elem && m.params.is_empty()) {
            Some(m) => Resolution::Found(self.method_target(&cls.key, m)),
            None => Resolution::Missing,
        }
    }

    /// `case RED ->` in a switch on an enum: the enum's constant.
    fn enum_case(&self, label: Node<'t>, ident: Node<'t>) -> Option<Resolution> {
        let mut cur = label.parent();
        while let Some(p) = cur {
            if matches!(p.kind(), "switch_expression" | "switch_statement") {
                let cond = p.child_by_field_name("condition")?;
                let t = self.type_of(self.strip_parens(cond));
                let c = t.as_class()?;
                let cls = self.model.class(&c.key)?;
                if cls.kind != crate::model::ClassKind::Enum {
                    return None;
                }
                let name = self.node_text(ident);
                return Some(if self.model.members(&cls).fields.iter().any(|f| f.name == name && f.enum_constant) {
                    Resolution::Found(Target::Field { class: cls.key.clone(), name: name.to_owned() })
                } else {
                    Resolution::Missing
                });
            }
            cur = p.parent();
        }
        None
    }
}
