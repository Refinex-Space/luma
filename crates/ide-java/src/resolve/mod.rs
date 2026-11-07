//! Reference resolution in a Java file (IDEA's `PsiReference.resolve()` over the Java PSI, with
//! `JavaResolveUtil`, the scope processors and `PsiResolveHelper`): every identifier of a parsed
//! file resolves to a declaration — a class, a type variable, a package, a field, a method or
//! constructor, a local variable / parameter — or to nothing, or the engine says it cannot tell.
//!
//! "Cannot tell" ([`Resolution::Unknown`]) is a first-class answer: a receiver whose type depends
//! on a class outside the class path, an overload choice that hinges on such a type, an
//! inference the engine does not perform. Callers fall back to the compiler-grade server for
//! those occurrences instead of guessing.

mod complete;
mod expr;
mod methods;
mod scope;

pub use complete::{Completion, CompletionKind, DUMMY_IDENTIFIER, completion_texts, short_type};
pub use scope::{LocalDecl, LocalKind};

use crate::model::{Model, Scope};
use crate::types::{Key, Type, TypeVar};
use ide_core::Pos;
use ide_index::java::{TypeId, node_pos};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use tree_sitter::{Node, Tree};

/// What a name refers to. Members are identified by their class, name and (methods) erased
/// parameter types, so a target found in one file compares equal to the same declaration found
/// from another.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Target {
    Class(Key),
    TypeVar(TypeVar),
    /// Dotted package name.
    Package(String),
    Field {
        class: Key,
        name: String,
    },
    /// `name` is `<init>` for a constructor; `desc` the erased parameter types, `(int,java.lang.String)`.
    Method {
        class: Key,
        name: String,
        desc: String,
    },
    /// A local variable, parameter or pattern variable of this file: its name's byte offset.
    Local(usize),
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Resolution {
    Found(Target),
    /// Refers to nothing: an error in the code.
    Missing,
    /// Something the language provides without a declaration: an array's `length`, a
    /// statement label.
    Builtin,
    /// The engine cannot tell.
    Unknown,
}

impl Resolution {
    pub fn target(&self) -> Option<&Target> {
        match self {
            Resolution::Found(t) => Some(t),
            _ => None,
        }
    }
}

pub(crate) const CLASS_DECLS: [&str; 5] = [
    "class_declaration",
    "interface_declaration",
    "enum_declaration",
    "record_declaration",
    "annotation_type_declaration",
];

pub(crate) fn is_class_decl(kind: &str) -> bool {
    CLASS_DECLS.contains(&kind)
}

/// The analysis of one file: its tree, the index's view of its declarations, and memoized
/// types and calls.
pub struct FileAnalysis<'m, 'a, 't> {
    pub model: &'m Model<'a>,
    pub tree: &'t Tree,
    pub text: &'t str,
    /// The file's slot in the index (the edited file's pseudo-slot for unsaved text).
    pub file: u32,
    /// Class declarations of the file by the position of their name (anonymous classes: of the
    /// instantiated type; enum constant bodies: of the constant).
    decls: HashMap<Pos, TypeId>,
    types: RefCell<HashMap<usize, Type>>,
    calls: RefCell<HashMap<usize, expr::Call>>,
    /// Standalone types of generic invocations used as arguments (see `standalone_type`).
    standalone: RefCell<HashMap<usize, Type>>,
    busy: RefCell<HashSet<usize>>,
}

impl<'m, 'a, 't> FileAnalysis<'m, 'a, 't> {
    /// `file`: the slot whose stub describes `text` (the view's overlay file for an edited file).
    pub fn new(model: &'m Model<'a>, tree: &'t Tree, text: &'t str, file: u32) -> Self {
        let mut decls = HashMap::new();
        if let Some(stub) = model.view.stub(file) {
            for (i, t) in stub.types.iter().enumerate() {
                decls.insert(t.at, TypeId { file, ty: i as u32 });
            }
        }
        Self {
            model,
            tree,
            text,
            file,
            decls,
            types: RefCell::default(),
            calls: RefCell::default(),
            standalone: RefCell::default(),
            busy: RefCell::default(),
        }
    }

    pub(crate) fn node_text(&self, n: Node) -> &'t str {
        self.text.get(n.byte_range()).unwrap_or_default()
    }

    /// The constructor or method an invocation / creation / `this(…)` / enum constant calls.
    pub fn resolve_call(&self, inv: Node<'t>) -> Resolution {
        self.call(inv).res
    }

    /// The text of node `n`.
    pub fn node_text_pub(&self, n: Node) -> &'t str {
        self.node_text(n)
    }

    pub(crate) fn pos(&self, n: Node) -> Pos {
        node_pos(n, self.text)
    }

    /// The stub type a class declaration node (or anonymous class / enum constant with a body)
    /// declares.
    pub fn declared_type(&self, decl: Node) -> Option<TypeId> {
        let anchor = match decl.kind() {
            k if is_class_decl(k) => decl.child_by_field_name("name")?,
            "object_creation_expression" => decl.child_by_field_name("type")?,
            "enum_constant" => decl.child_by_field_name("name")?,
            _ => return None,
        };
        let id = *self.decls.get(&self.pos(anchor))?;
        // The stub must describe this text (an indexed file may have changed on disk since).
        let t = self.model.view.ty(id)?;
        match decl.kind() {
            k if is_class_decl(k) => (t.name == self.node_text(anchor)).then_some(id),
            _ => Some(id),
        }
    }

    pub fn declared_key(&self, decl: Node) -> Option<Key> {
        self.model.source_key(self.declared_type(decl)?)
    }

    /// The class body a node is in: (the declaring node, its key). Anonymous classes and enum
    /// constant bodies count; a class's header (its name, supertypes) belongs to the enclosing
    /// class.
    pub fn enclosing_class(&self, n: Node<'t>) -> Option<(Node<'t>, Key)> {
        let mut child = n;
        let mut cur = n.parent();
        while let Some(p) = cur {
            let inside_body = |field: &str| p.child_by_field_name(field).is_some_and(|b| b.id() == child.id());
            let hit = match p.kind() {
                k if is_class_decl(k) => inside_body("body"),
                "object_creation_expression" | "enum_constant" => {
                    child.kind() == "class_body" && (p.kind() != "enum_constant" || inside_body("body"))
                }
                _ => false,
            };
            if hit {
                return Some((p, self.declared_key(p)?));
            }
            child = p;
            cur = p.parent();
        }
        None
    }

    /// The member index (in its stub type) of a method / field declaration node's name.
    pub(crate) fn member_index(&self, class: TypeId, name: Node) -> Option<u32> {
        let t = self.model.view.ty(class)?;
        let at = self.pos(name);
        let text = self.node_text(name);
        t.members.iter().position(|m| m.at == at && m.name == text).map(|i| i as u32)
    }

    /// The type-name scope at node `n`: its class, the type parameters of the enclosing generic
    /// methods, the local classes declared before it in enclosing blocks.
    pub fn scope_at(&self, n: Node<'t>) -> Scope {
        let mut scope = Scope { file: Some(self.file), ..Default::default() };
        // In a class header (type parameters, supertypes): that class's type parameters and the
        // classes around it, not its members.
        {
            let mut child = n;
            let mut cur = n.parent();
            while let Some(p) = cur {
                if is_class_decl(p.kind()) {
                    // A record's header (its components) is in the scope of its members, member
                    // types included (JLS §6.3): `record R(List<R.Part> parts) { record Part() {} }`.
                    if p.kind() == "record_declaration"
                        && p.child_by_field_name("parameters").is_some_and(|h| h.id() == child.id())
                    {
                        scope.class = self.declared_key(p);
                        return scope;
                    }
                    let in_body = p.child_by_field_name("body").is_some_and(|b| b.id() == child.id());
                    if !in_body && child.kind() != "modifiers" {
                        scope.header_of = self.declared_key(p);
                        return scope;
                    }
                    break;
                }
                if matches!(p.kind(), "class_body" | "block") {
                    break;
                }
                child = p;
                cur = p.parent();
            }
        }
        let class = self.enclosing_class(n);
        scope.class = class.as_ref().map(|(_, k)| k.clone());
        // Generic methods enclosing n (innermost first), up to the class.
        let mut cur = n.parent();
        let class_node = class.as_ref().map(|(c, _)| c.id());
        while let Some(p) = cur {
            if Some(p.id()) == class_node {
                break;
            }
            if matches!(p.kind(), "method_declaration" | "constructor_declaration")
                && let Some((_, key)) = &class
                && let Some(c) = self.model.class(key)
                && let crate::model::Origin::Source(id) = c.origin
                && let Some(name) = p.child_by_field_name("name")
                && let Some(index) = self.member_index(id, name)
            {
                let members = self.model.members(&c);
                if let Some(m) = members.methods.iter().find(|m| m.source == Some(index)) {
                    scope.method_type_params.extend(m.type_params.iter().cloned());
                }
            }
            cur = p.parent();
        }
        // Local classes before n in the blocks enclosing it (and the one n is inside of).
        let mut child = n;
        let mut cur = n.parent();
        let mut locals = Vec::new();
        while let Some(p) = cur {
            if matches!(p.kind(), "block" | "switch_block_statement_group" | "constructor_body") {
                let mut c = p.walk();
                for s in p.named_children(&mut c).filter(|x| !x.is_extra()) {
                    if s.start_byte() >= child.start_byte() && s.id() != child.id() {
                        break;
                    }
                    if is_class_decl(s.kind())
                        && let (Some(name), Some(key)) = (s.child_by_field_name("name"), self.declared_key(s))
                    {
                        locals.push((self.node_text(name).to_owned(), key));
                    }
                }
            }
            child = p;
            cur = p.parent();
        }
        locals.reverse();
        scope.local_classes = locals;
        scope
    }

    /// Resolves the type written by a type node at its place.
    pub fn resolve_type_node(&self, ty: Node<'t>) -> Type {
        let text = ide_index::java::type_text(ty, self.text);
        self.model.resolve_text(&text, &self.scope_at(ty))
    }

    /// What the identifier (or `this` / `super` / type identifier) node at `ident` refers to.
    pub fn resolve(&self, ident: Node<'t>) -> Resolution {
        self.resolve_reference(ident)
    }

    /// The identifier node at byte offset `byte`.
    pub fn identifier_at(&self, byte: usize) -> Option<Node<'t>> {
        let n = self.tree.root_node().descendant_for_byte_range(byte, byte)?;
        matches!(n.kind(), "identifier" | "type_identifier").then_some(n)
    }

    /// The declaration a name node declares, if it is one: a class, method, field, enum
    /// constant, parameter or local variable.
    pub fn declared_target(&self, name: Node<'t>) -> Option<Target> {
        let parent = name.parent()?;
        if parent.child_by_field_name("name").is_none_or(|n| n.id() != name.id()) {
            // Lambda parameters, inferred parameters and patterns name variables without a field.
            return match parent.kind() {
                "inferred_parameters" | "type_pattern" => Some(Target::Local(name.start_byte())),
                "record_pattern_component"
                    if parent
                        .named_children(&mut parent.walk())
                        .filter(|x| !x.is_extra())
                        .last()
                        .is_some_and(|l| l.id() == name.id()) =>
                {
                    Some(Target::Local(name.start_byte()))
                }
                // `<T extends …>`: the declaration of a type variable.
                "type_parameter" if name.kind() == "type_identifier" => {
                    let decl = parent.parent()?.parent()?;
                    let text = self.node_text(name);
                    let var = match decl.kind() {
                        k if is_class_decl(k) => {
                            let key = self.declared_key(decl)?;
                            self.model.class(&key)?.type_params.iter().find(|p| &*p.var.name == text)?.var.clone()
                        }
                        _ => self.scope_at(name).method_type_params.iter().find(|p| &*p.var.name == text)?.var.clone(),
                    };
                    Some(Target::TypeVar(var))
                }
                "lambda_expression"
                    if parent.child_by_field_name("parameters").is_some_and(|p| p.id() == name.id()) =>
                {
                    Some(Target::Local(name.start_byte()))
                }
                _ => None,
            };
        }
        match parent.kind() {
            k if is_class_decl(k) => self.declared_key(parent).map(Target::Class),
            "method_declaration"
            | "constructor_declaration"
            | "compact_constructor_declaration"
            | "annotation_type_element_declaration" => {
                let (_, class) = self.enclosing_class(parent)?;
                let c = self.model.class(&class)?;
                let crate::model::Origin::Source(id) = c.origin else { return None };
                let index = self.member_index(id, name)?;
                let m = self.model.members(&c).methods.iter().find(|m| m.source == Some(index))?.clone();
                Some(self.method_target(&class, &m))
            }
            "enum_constant" => {
                let (_, class) = self.enclosing_class(parent)?;
                Some(Target::Field { class, name: self.node_text(name).to_owned() })
            }
            "variable_declarator" => {
                let decl = parent.parent()?;
                if matches!(decl.kind(), "field_declaration" | "constant_declaration") {
                    let (_, class) = self.enclosing_class(decl)?;
                    Some(Target::Field { class, name: self.node_text(name).to_owned() })
                } else {
                    Some(Target::Local(name.start_byte()))
                }
            }
            "formal_parameter"
                if parent.parent().and_then(|p| p.parent()).is_some_and(|g| g.kind() == "record_declaration") =>
            {
                // A record component names its field (the accessor is a method of the same name).
                let rec = parent.parent()?.parent()?;
                Some(Target::Field { class: self.declared_key(rec)?, name: self.node_text(name).to_owned() })
            }
            "formal_parameter"
            | "catch_formal_parameter"
            | "resource"
            | "enhanced_for_statement"
            | "spread_parameter"
            | "instanceof_expression" => Some(Target::Local(name.start_byte())),
            _ => None,
        }
    }

    /// The identity of method `m` of class `class`.
    pub fn method_target(&self, class: &Key, m: &crate::model::MethodData) -> Target {
        Target::Method { class: class.clone(), name: m.name.clone(), desc: method_desc(self.model, m) }
    }
}

/// `(int,java.util.List)`: the erased parameter types of a method.
pub fn method_desc(model: &Model, m: &crate::model::MethodData) -> String {
    let params: Vec<String> = m.params.iter().map(|p| model.erasure(p).to_string()).collect();
    format!("({})", params.join(","))
}

#[cfg(test)]
mod tests;
