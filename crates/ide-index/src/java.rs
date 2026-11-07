//! Java structure index: IDEA's Java stub indexes (short class names, super class name
//! occurrences) and its identifier index (`IdIndex`), from a tree-sitter parse of each file.
//!
//! A [`JavaStub`] holds a file's package, imports, type and member declarations and the
//! identifiers its code mentions. [`JavaGraph`] inverts them over the project: types by simple
//! name, types by the simple name of a supertype they write, files by identifier. Supertypes are
//! resolved the way `javac` resolves a type name (enclosing types, single-type imports, the
//! package, on-demand imports) only when asked, so a change to one file never touches another
//! file's entries.

use crate::data::IndexData;
use ide_core::Pos;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use tree_sitter::{Node, Tree};

pub const PUBLIC: u16 = 1;
pub const PROTECTED: u16 = 1 << 1;
pub const PRIVATE: u16 = 1 << 2;
pub const STATIC: u16 = 1 << 3;
pub const ABSTRACT: u16 = 1 << 4;
pub const FINAL: u16 = 1 << 5;
pub const DEFAULT: u16 = 1 << 6;
/// A class declared in a method body.
pub const LOCAL: u16 = 1 << 7;
/// `new Foo() { … }`.
pub const ANONYMOUS: u16 = 1 << 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum JavaTypeKind {
    Class,
    Interface,
    Enum,
    Record,
    Annotation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum JavaMemberKind {
    Method,
    Constructor,
    Field,
    EnumConstant,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct JavaStub {
    pub package: String,
    /// Annotations of the package declaration (`package-info.java`).
    pub package_annotations: Vec<JavaAnnotation>,
    pub imports: Vec<JavaImport>,
    /// Every type of the file, outer before inner.
    pub types: Vec<JavaType>,
    /// Identifiers of the code (not comments or strings), sorted, unique.
    pub words: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct JavaImport {
    /// `java.util.List`, or `java.util` for `java.util.*`.
    pub path: String,
    pub is_static: bool,
    pub on_demand: bool,
    /// Where the imported name starts.
    pub at: Pos,
}

/// An annotation as written, with its arguments:
/// `@ConditionalOnProperty(prefix = "app", name = "on", havingValue = "true")`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct JavaAnnotation {
    /// As written, without whitespace: `Qualifier`, `org.springframework.context.annotation.Profile`.
    pub name: String,
    /// The `@`.
    pub at: Pos,
    /// Arguments in order; a single unnamed argument is `value`.
    pub args: Vec<(String, AnnotationValue)>,
}

/// A value of an annotation argument.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AnnotationValue {
    /// A string literal (or a concatenation of literals), decoded; `at` / `end` bound its
    /// contents (inside the quotes).
    Str {
        text: String,
        at: Pos,
        end: Pos,
    },
    /// `Foo.class`, the type as written.
    Class(String),
    /// A name: an enum constant or a constant (`ScopedProxyMode.TARGET_CLASS`, `Names.ORDERS`).
    Name(String),
    Bool(bool),
    Num(String),
    /// `{a, b}`.
    Array(Vec<AnnotationValue>),
    /// A nested annotation (`@ComponentScan.Filter(...)`).
    Annotation(Box<JavaAnnotation>),
    /// A concatenation with non-literal parts: `Paths.BASE + "/orders"`.
    Concat(Vec<AnnotationValue>),
    /// Anything else (arithmetic, method calls…).
    Other,
}

impl JavaAnnotation {
    /// The argument named `name` (`value` for a single unnamed one).
    pub fn arg(&self, name: &str) -> Option<&AnnotationValue> {
        self.args.iter().find(|(k, _)| k == name).map(|(_, v)| v)
    }

    /// The simple name: `Profile` for `org.springframework.context.annotation.Profile`.
    pub fn simple_name(&self) -> &str {
        simple(&self.name)
    }
}

impl AnnotationValue {
    /// The values of an array, or this single value.
    pub fn items(&self) -> &[AnnotationValue] {
        match self {
            AnnotationValue::Array(items) => items,
            other => std::slice::from_ref(other),
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            AnnotationValue::Str { text, .. } => Some(text),
            _ => None,
        }
    }

    /// Every string of the value (an array's in order).
    pub fn strings(&self) -> Vec<&str> {
        self.items().iter().filter_map(AnnotationValue::as_str).collect()
    }

    /// Type names of class literals (an array's in order).
    pub fn classes(&self) -> Vec<&str> {
        self.items()
            .iter()
            .filter_map(|v| match v {
                AnnotationValue::Class(c) => Some(c.as_str()),
                _ => None,
            })
            .collect()
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            AnnotationValue::Bool(b) => Some(*b),
            _ => None,
        }
    }

    /// The last segment of a name (`TARGET_CLASS` for `ScopedProxyMode.TARGET_CLASS`).
    pub fn name_segment(&self) -> Option<&str> {
        match self {
            AnnotationValue::Name(n) => Some(simple(n)),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct JavaType {
    /// Empty for an anonymous class.
    pub name: String,
    pub kind: JavaTypeKind,
    /// Index of the enclosing type in [`JavaStub::types`].
    pub outer: Option<u32>,
    pub flags: u16,
    /// Supertypes as written, without type arguments: `Foo`, `Outer.Inner`, `java.util.List`.
    pub supers: Vec<String>,
    pub type_params: Vec<String>,
    /// Simple names of the annotations.
    pub annotations: Vec<String>,
    /// The name (the type after `new` for an anonymous class).
    pub at: Pos,
    pub end_line: u32,
    pub members: Vec<JavaMember>,
    /// String values of annotations: `@Service("orders")` → `("Service", "orders")`.
    pub values: Vec<(String, String)>,
    /// The annotations with their arguments.
    pub annotation_args: Vec<JavaAnnotation>,
    /// Erased type arguments of each supertype, parallel to [`JavaType::supers`]:
    /// `implements Repository<User, Long>` → `[User, Long]`.
    pub super_args: Vec<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct JavaMember {
    pub name: String,
    pub kind: JavaMemberKind,
    pub flags: u16,
    /// Erased parameter types as written, simple names: `List`, `String[]`, `T`.
    pub params: Vec<String>,
    /// Erased type of a field (its accessors' names depend on `boolean`).
    pub ty: String,
    pub type_params: Vec<String>,
    pub annotations: Vec<String>,
    pub at: Pos,
    pub end_line: u32,
    /// Erased type arguments of a field's type or a method's return type: `List<Order>` → `[Order]`.
    pub ty_args: Vec<String>,
    /// String values of annotations (see [`JavaType::values`]).
    pub values: Vec<(String, String)>,
    /// Parameters of methods and constructors, in detail.
    pub param_details: Vec<JavaParam>,
    /// The annotations with their arguments.
    pub annotation_args: Vec<JavaAnnotation>,
}

/// A parameter of a method or constructor.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct JavaParam {
    pub name: String,
    /// Erased type as written.
    pub ty: String,
    /// Erased type arguments.
    pub ty_args: Vec<String>,
    pub annotations: Vec<String>,
    pub values: Vec<(String, String)>,
    pub at: Pos,
    /// The annotations with their arguments.
    pub annotation_args: Vec<JavaAnnotation>,
}

impl JavaType {
    pub fn is(&self, flag: u16) -> bool {
        self.flags & flag != 0
    }
}

impl JavaMember {
    pub fn is(&self, flag: u16) -> bool {
        self.flags & flag != 0
    }
}

impl JavaStub {
    /// `a.b.Outer.Inner` (`a.b.Outer.Inner$` for local and anonymous classes, which no name reaches).
    pub fn qualified_name(&self, ty: u32) -> String {
        let mut names = Vec::new();
        let mut next = Some(ty);
        let mut local = false;
        while let Some(i) = next {
            let t = &self.types[i as usize];
            local |= t.is(LOCAL) || t.is(ANONYMOUS);
            names.push(t.name.as_str());
            next = t.outer;
        }
        names.reverse();
        let mut out = self.package.clone();
        for n in names {
            if !out.is_empty() {
                out.push('.');
            }
            out.push_str(n);
        }
        if local {
            out.push('$');
        }
        out
    }

    /// Display name of a type: `Outer.Inner`, or `Outer$1` style for an anonymous class.
    pub fn display_name(&self, ty: u32) -> String {
        let t = &self.types[ty as usize];
        if t.is(ANONYMOUS) {
            let outer = t.outer.map(|o| self.display_name(o)).unwrap_or_default();
            let base = t.supers.first().map(|s| simple(s)).unwrap_or("Object");
            return format!("{outer} (new {base})");
        }
        match t.outer {
            Some(o) if !t.is(LOCAL) => format!("{}.{}", self.display_name(o), t.name),
            _ => t.name.clone(),
        }
    }

    /// The type and member declared at `pos` (its name), if any.
    pub fn declaration_at(&self, pos: Pos) -> Option<(u32, Option<u32>)> {
        for (ti, t) in self.types.iter().enumerate() {
            if t.at == pos && !t.is(ANONYMOUS) {
                return Some((ti as u32, None));
            }
            if let Some(mi) = t.members.iter().position(|m| m.at == pos) {
                return Some((ti as u32, Some(mi as u32)));
            }
        }
        None
    }

    /// Hash of what other files' resolution depends on: names, kinds, modifiers, supertypes and
    /// signatures; not positions or code.
    pub fn structure_hash(&self) -> u128 {
        let mut h = blake3::Hasher::new();
        let mut put = |s: &str| {
            h.update(s.as_bytes());
            h.update(&[0]);
        };
        put(&self.package);
        for a in &self.package_annotations {
            put(&annotation_key(a));
        }
        for i in &self.imports {
            put(&i.path);
            put(if i.is_static { "s" } else { "" });
            put(if i.on_demand { "*" } else { "" });
        }
        for t in &self.types {
            put(&t.name);
            put(&format!("{:?}{}{:?}", t.kind, t.flags, t.outer));
            t.supers.iter().chain(&t.type_params).chain(&t.annotations).for_each(|s| put(s));
            t.super_args.iter().flatten().for_each(|s| put(s));
            t.annotation_args.iter().for_each(|a| put(&annotation_key(a)));
            for m in &t.members {
                put(&m.name);
                put(&format!("{:?}{}", m.kind, m.flags));
                put(&m.ty);
                m.params.iter().chain(&m.type_params).chain(&m.annotations).chain(&m.ty_args).for_each(|s| put(s));
                m.annotation_args.iter().for_each(|a| put(&annotation_key(a)));
                for p in &m.param_details {
                    put(&p.name);
                    p.ty_args.iter().for_each(|s| put(s));
                    p.annotation_args.iter().for_each(|a| put(&annotation_key(a)));
                }
                put(";");
            }
            put("}");
        }
        let bytes = h.finalize();
        u128::from_le_bytes(bytes.as_bytes()[..16].try_into().unwrap_or_default())
    }
}

impl JavaStub {
    /// Hash of the file's type hierarchy: its types' names, kinds, modifiers, type parameters,
    /// supertypes and annotations (which may generate members).
    pub fn hierarchy_hash(&self) -> u128 {
        let mut h = Hash::default();
        h.put(&self.package);
        for (i, t) in self.types.iter().enumerate() {
            h.put(&self.qualified_name(i as u32));
            h.put(&format!("{:?}{}", t.kind, t.flags));
            t.supers.iter().chain(&t.type_params).chain(&t.annotations).for_each(|s| h.put(s));
            h.put("}");
        }
        h.finish()
    }

    /// Per member name, a hash of the declarations so named: owner, kind, modifiers, signature.
    /// A reference to a member only resolves differently when one of these changes.
    pub fn name_hashes(&self) -> Vec<(&str, u128)> {
        let mut out = Vec::new();
        for (i, t) in self.types.iter().enumerate() {
            let owner = self.qualified_name(i as u32);
            for m in &t.members {
                let mut h = Hash::default();
                h.put(&owner);
                h.put(&m.name);
                h.put(&format!("{:?}{}", m.kind, m.flags));
                h.put(&m.ty);
                m.params.iter().chain(&m.type_params).chain(&m.annotations).for_each(|s| h.put(s));
                out.push((m.name.as_str(), h.finish()));
            }
        }
        out
    }
}

#[derive(Default)]
struct Hash(blake3::Hasher);

impl Hash {
    fn put(&mut self, s: &str) {
        self.0.update(s.as_bytes());
        self.0.update(&[0]);
    }
    fn finish(&self) -> u128 {
        u128::from_le_bytes(self.0.finalize().as_bytes()[..16].try_into().unwrap_or_default())
    }
}

/// What an annotation contributes to a structure hash: its name and arguments, not positions.
fn annotation_key(a: &JavaAnnotation) -> String {
    fn value(v: &AnnotationValue, out: &mut String) {
        match v {
            AnnotationValue::Str { text, .. } => {
                out.push('"');
                out.push_str(text);
                out.push('"');
            }
            AnnotationValue::Class(c) => {
                out.push_str(c);
                out.push_str(".class");
            }
            AnnotationValue::Name(n) | AnnotationValue::Num(n) => out.push_str(n),
            AnnotationValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            AnnotationValue::Array(items) | AnnotationValue::Concat(items) => {
                out.push(if matches!(v, AnnotationValue::Array(_)) { '{' } else { '(' });
                for i in items {
                    value(i, out);
                    out.push(',');
                }
                out.push('}');
            }
            AnnotationValue::Annotation(a) => out.push_str(&annotation_key(a)),
            AnnotationValue::Other => out.push('?'),
        }
    }
    let mut out = format!("@{}(", a.name);
    for (k, v) in &a.args {
        out.push_str(k);
        out.push('=');
        value(v, &mut out);
        out.push(';');
    }
    out.push(')');
    out
}

/// Last segment of a dotted name.
pub fn simple(name: &str) -> &str {
    name.rsplit('.').next().unwrap_or(name)
}

// ---------------------------------------------------------------------------
// Extraction

/// The stub of a parsed Java file.
pub fn extract(tree: &Tree, text: &str) -> JavaStub {
    let mut stub = JavaStub::default();
    let root = tree.root_node();
    let mut cursor = root.walk();
    for child in root.named_children(&mut cursor) {
        match child.kind() {
            "package_declaration" => {
                stub.package_annotations = annotation_args(child, text);
                let mut c = child.walk();
                if let Some(n) =
                    child.named_children(&mut c).find(|n| matches!(n.kind(), "identifier" | "scoped_identifier"))
                {
                    stub.package = compact(node_text(n, text));
                }
            }
            "import_declaration" => {
                let mut import =
                    JavaImport { path: String::new(), is_static: false, on_demand: false, at: pos(child, text) };
                let mut c = child.walk();
                for n in child.children(&mut c) {
                    match n.kind() {
                        "static" => import.is_static = true,
                        "asterisk" => import.on_demand = true,
                        "identifier" | "scoped_identifier" => {
                            import.path = compact(node_text(n, text));
                            import.at = pos(n, text);
                        }
                        _ => {}
                    }
                }
                if !import.path.is_empty() {
                    stub.imports.push(import);
                }
            }
            k if type_kind(k).is_some() => declare_type(child, None, 0, text, &mut stub),
            _ => {}
        }
    }
    let mut words = HashSet::new();
    collect_words(root, text, &mut words);
    let mut words: Vec<String> = words.into_iter().map(str::to_owned).collect();
    words.sort_unstable();
    stub.words = words;
    stub
}

fn node_text<'a>(n: Node, text: &'a str) -> &'a str {
    text.get(n.byte_range()).unwrap_or_default()
}

/// Without whitespace and comments: `java . util . List` → `java.util.List`.
fn compact(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

/// 0-based line and UTF-16 column of a node's start.
fn pos(n: Node, text: &str) -> Pos {
    let p = n.start_position();
    let start = n.start_byte();
    let line_start = start.saturating_sub(p.column);
    let col = text.get(line_start..start).map_or(p.column, |s| s.encode_utf16().count());
    Pos::new(p.row as u32, col as u32)
}

fn type_kind(kind: &str) -> Option<JavaTypeKind> {
    Some(match kind {
        "class_declaration" => JavaTypeKind::Class,
        "interface_declaration" => JavaTypeKind::Interface,
        "enum_declaration" => JavaTypeKind::Enum,
        "record_declaration" => JavaTypeKind::Record,
        "annotation_type_declaration" => JavaTypeKind::Annotation,
        _ => return None,
    })
}

/// Modifier flags and annotation names of a declaration.
fn modifiers(decl: Node, text: &str) -> (u16, Vec<String>) {
    let mut flags = 0;
    let mut annotations = Vec::new();
    let mut c = decl.walk();
    for child in decl.children(&mut c) {
        if child.kind() != "modifiers" {
            continue;
        }
        let mut m = child.walk();
        for n in child.children(&mut m) {
            match n.kind() {
                "public" => flags |= PUBLIC,
                "protected" => flags |= PROTECTED,
                "private" => flags |= PRIVATE,
                "static" => flags |= STATIC,
                "abstract" => flags |= ABSTRACT,
                "final" => flags |= FINAL,
                "default" => flags |= DEFAULT,
                "marker_annotation" | "annotation" => {
                    if let Some(name) = n.child_by_field_name("name") {
                        annotations.push(simple(&compact(node_text(name, text))).to_owned());
                    }
                }
                _ => {}
            }
        }
    }
    (flags, annotations)
}

/// The first string literal of an annotation's arguments: its value (`@Qualifier("a")`,
/// `@Bean(name = "a")`, `@Bean({"a", "b"})`).
fn annotation_value(annotation: Node, text: &str) -> Option<String> {
    let args = annotation.child_by_field_name("arguments")?;
    let mut stack = vec![args];
    while let Some(n) = stack.pop() {
        if n.kind() == "string_literal" {
            let s = node_text(n, text);
            return Some(s.trim_matches('"').to_owned());
        }
        if n.kind() == "element_value_pair"
            && let Some(key) = n.child_by_field_name("key")
            && !matches!(node_text(key, text), "value" | "name")
        {
            continue;
        }
        let mut c = n.walk();
        let children: Vec<Node> = n.named_children(&mut c).collect();
        stack.extend(children.into_iter().rev());
    }
    None
}

/// String values of the annotations of a declaration (or parameter).
fn annotation_values(decl: Node, text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut c = decl.walk();
    for child in decl.children(&mut c) {
        let annotations: Vec<Node> = if child.kind() == "modifiers" {
            let mut m = child.walk();
            child.children(&mut m).collect()
        } else {
            vec![child]
        };
        for n in annotations.into_iter().filter(|n| n.kind() == "annotation") {
            if let (Some(name), Some(value)) = (n.child_by_field_name("name"), annotation_value(n, text)) {
                out.push((simple(&compact(node_text(name, text))).to_owned(), value));
            }
        }
    }
    out
}

/// Erased type arguments of a type node: `Map<String, List<Order>>` → `[String, List]`.
fn type_args(n: Node, text: &str) -> Vec<String> {
    let generic = match n.kind() {
        "generic_type" => Some(n),
        "annotated_type" => {
            let mut c = n.walk();
            n.named_children(&mut c).find(|c| c.kind() == "generic_type")
        }
        _ => None,
    };
    let Some(generic) = generic else { return Vec::new() };
    let mut c = generic.walk();
    let Some(args) = generic.named_children(&mut c).find(|c| c.kind() == "type_arguments") else { return Vec::new() };
    let mut a = args.walk();
    args.named_children(&mut a)
        .map(|t| if t.kind() == "wildcard" { wildcard_bound(t, text) } else { erased(t, text) })
        .collect()
}

/// `? extends Foo` → `Foo`; `?` → `Object`.
fn wildcard_bound(n: Node, text: &str) -> String {
    let mut c = n.walk();
    let bound = n.named_children(&mut c).filter(|c| !matches!(c.kind(), "annotation" | "marker_annotation")).last();
    bound.map(|b| erased(b, text)).unwrap_or_else(|| "Object".into())
}

fn param_details(params: Option<Node>, text: &str) -> Vec<JavaParam> {
    let Some(params) = params else { return Vec::new() };
    let mut out = Vec::new();
    let mut c = params.walk();
    for p in params.named_children(&mut c) {
        let (ty, name) = match p.kind() {
            "formal_parameter" => (p.child_by_field_name("type"), p.child_by_field_name("name")),
            "spread_parameter" => {
                let mut pc = p.walk();
                let ty = p.named_children(&mut pc).find(|n| {
                    !matches!(n.kind(), "modifiers" | "annotation" | "marker_annotation" | "variable_declarator")
                });
                let mut pc = p.walk();
                let decl = p.named_children(&mut pc).find(|n| n.kind() == "variable_declarator");
                (ty, decl.and_then(|d| d.child_by_field_name("name")))
            }
            _ => continue,
        };
        let (Some(ty), Some(name)) = (ty, name) else { continue };
        let (_, annotations) = modifiers(p, text);
        out.push(JavaParam {
            name: node_text(name, text).to_owned(),
            ty: erased(ty, text),
            ty_args: type_args(ty, text),
            annotations,
            values: annotation_values(p, text),
            at: pos(name, text),
            annotation_args: annotation_args(p, text),
        });
    }
    out
}

/// The erased type a type node names, as written: `Map<K, V>` → `Map`, `a.b.C<T>[]` → `a.b.C[]`.
fn erased(n: Node, text: &str) -> String {
    match n.kind() {
        "generic_type" | "annotated_type" => {
            let mut c = n.walk();
            let inner = n
                .named_children(&mut c)
                .filter(|c| !matches!(c.kind(), "type_arguments" | "annotation" | "marker_annotation"))
                .last();
            inner.map(|i| erased(i, text)).unwrap_or_default()
        }
        "array_type" => {
            let element = n.child_by_field_name("element").map(|e| erased(e, text)).unwrap_or_default();
            let dims = n.child_by_field_name("dimensions").map_or(1, |d| node_text(d, text).matches('[').count());
            format!("{element}{}", "[]".repeat(dims.max(1)))
        }
        _ => strip_type_arguments(&compact(node_text(n, text))),
    }
}

/// `Outer<T>.Inner<U>` → `Outer.Inner`; annotations dropped.
fn strip_type_arguments(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0u32;
    for c in s.chars() {
        match c {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    if out.contains('@') {
        out = out.split('.').filter(|p| !p.starts_with('@')).collect::<Vec<_>>().join(".");
    }
    out
}

fn type_list(n: Node, text: &str, out: &mut Vec<String>, args: &mut Vec<Vec<String>>) {
    let mut c = n.walk();
    for child in n.named_children(&mut c) {
        if child.kind() == "type_list" {
            let mut l = child.walk();
            for t in child.named_children(&mut l) {
                out.push(erased(t, text));
                args.push(type_args(t, text));
            }
        } else if !matches!(child.kind(), "annotation" | "marker_annotation") {
            out.push(erased(child, text));
            args.push(type_args(child, text));
        }
    }
}

/// Annotations of a declaration (in its modifiers, or directly among its children), with arguments.
fn annotation_args(decl: Node, text: &str) -> Vec<JavaAnnotation> {
    let mut out = Vec::new();
    let mut c = decl.walk();
    for child in decl.children(&mut c) {
        if child.kind() == "modifiers" {
            let mut m = child.walk();
            for n in child.children(&mut m) {
                if matches!(n.kind(), "annotation" | "marker_annotation") {
                    out.extend(parse_annotation(n, text));
                }
            }
        } else if matches!(child.kind(), "annotation" | "marker_annotation") {
            out.extend(parse_annotation(child, text));
        }
    }
    out
}

fn parse_annotation(n: Node, text: &str) -> Option<JavaAnnotation> {
    let name = compact(node_text(n.child_by_field_name("name")?, text));
    let mut args = Vec::new();
    if let Some(list) = n.child_by_field_name("arguments") {
        let mut c = list.walk();
        for a in list.named_children(&mut c) {
            if matches!(a.kind(), "line_comment" | "block_comment") {
                continue;
            }
            if a.kind() == "element_value_pair" {
                let (Some(k), Some(v)) = (a.child_by_field_name("key"), a.child_by_field_name("value")) else {
                    continue;
                };
                args.push((node_text(k, text).to_owned(), parse_value(v, text)));
            } else {
                args.push(("value".to_owned(), parse_value(a, text)));
            }
        }
    }
    Some(JavaAnnotation { name, at: pos(n, text), args })
}

/// Position of `byte` inside `n` (0-based line, UTF-16 column), counted from the node's start.
fn pos_in(n: Node, byte: usize, text: &str) -> Pos {
    let start = pos(n, text);
    let Some(between) = text.get(n.start_byte()..byte) else { return start };
    match between.rfind('\n') {
        Some(nl) => {
            Pos::new(start.line + between.matches('\n').count() as u32, between[nl + 1..].encode_utf16().count() as u32)
        }
        None => Pos::new(start.line, start.col + between.encode_utf16().count() as u32),
    }
}

/// A string literal's decoded text and the bounds of its contents.
fn string_value(n: Node, text: &str) -> AnnotationValue {
    let raw = node_text(n, text);
    let quote = if raw.starts_with("\"\"\"") { 3 } else { 1 };
    let (from, to) = (n.start_byte() + quote, n.end_byte().saturating_sub(quote).max(n.start_byte() + quote));
    let inner = text.get(from..to).unwrap_or_default();
    let mut decoded = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            decoded.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => decoded.push('\n'),
            Some('t') => decoded.push('\t'),
            Some('r') => decoded.push('\r'),
            Some('b') => decoded.push('\u{8}'),
            Some('f') => decoded.push('\u{c}'),
            Some('s') => decoded.push(' '),
            Some(o) => decoded.push(o),
            None => {}
        }
    }
    if quote == 3 {
        // A text block starts after the line break that follows its opening quotes.
        decoded = decoded.trim_start_matches([' ', '\t']).trim_start_matches('\n').to_owned();
    }
    AnnotationValue::Str { text: decoded, at: pos_in(n, from, text), end: pos_in(n, to, text) }
}

fn parse_value(n: Node, text: &str) -> AnnotationValue {
    match n.kind() {
        "string_literal" => string_value(n, text),
        "class_literal" => {
            let mut c = n.walk();
            let ty = n.named_children(&mut c).next().map(|t| erased(t, text)).unwrap_or_default();
            AnnotationValue::Class(ty)
        }
        "true" => AnnotationValue::Bool(true),
        "false" => AnnotationValue::Bool(false),
        "identifier" | "field_access" | "scoped_identifier" => AnnotationValue::Name(compact(node_text(n, text))),
        k if k.ends_with("_literal") && k != "null_literal" => AnnotationValue::Num(node_text(n, text).to_owned()),
        "unary_expression" => AnnotationValue::Num(compact(node_text(n, text))),
        "element_value_array_initializer" | "array_initializer" => {
            let mut c = n.walk();
            AnnotationValue::Array(
                n.named_children(&mut c)
                    .filter(|v| !matches!(v.kind(), "line_comment" | "block_comment"))
                    .map(|v| parse_value(v, text))
                    .collect(),
            )
        }
        "annotation" | "marker_annotation" => {
            parse_annotation(n, text).map_or(AnnotationValue::Other, |a| AnnotationValue::Annotation(Box::new(a)))
        }
        "parenthesized_expression" => {
            let mut c = n.walk();
            n.named_children(&mut c).next().map_or(AnnotationValue::Other, |v| parse_value(v, text))
        }
        "binary_expression" if n.child_by_field_name("operator").is_some_and(|o| node_text(o, text) == "+") => {
            let mut parts = Vec::new();
            let mut stack = vec![n];
            // Left-to-right leaves of a `+` chain.
            while let Some(e) = stack.pop() {
                let plus = e.kind() == "binary_expression"
                    && e.child_by_field_name("operator").is_some_and(|o| node_text(o, text) == "+");
                match (plus, e.child_by_field_name("left"), e.child_by_field_name("right")) {
                    (true, Some(l), Some(r)) => {
                        stack.push(r);
                        stack.push(l);
                    }
                    _ => parts.push(parse_value(e, text)),
                }
            }
            if parts.iter().all(|p| matches!(p, AnnotationValue::Str { .. })) {
                let (first, last) = (parts.first().cloned(), parts.last().cloned());
                let joined: String = parts.iter().filter_map(AnnotationValue::as_str).collect();
                match (first, last) {
                    (Some(AnnotationValue::Str { at, .. }), Some(AnnotationValue::Str { end, .. })) => {
                        AnnotationValue::Str { text: joined, at, end }
                    }
                    _ => AnnotationValue::Other,
                }
            } else {
                AnnotationValue::Concat(parts)
            }
        }
        _ => AnnotationValue::Other,
    }
}

fn type_params(decl: Node, text: &str) -> Vec<String> {
    let Some(params) = decl.child_by_field_name("type_parameters") else { return Vec::new() };
    let mut c = params.walk();
    params
        .named_children(&mut c)
        .filter(|p| p.kind() == "type_parameter")
        .filter_map(|p| {
            let mut pc = p.walk();
            let name = p.named_children(&mut pc).find(|n| n.kind() == "type_identifier");
            name.map(|n| node_text(n, text).to_owned())
        })
        .collect()
}

fn parameters(params: Option<Node>, text: &str) -> Vec<String> {
    let Some(params) = params else { return Vec::new() };
    let mut out = Vec::new();
    let mut c = params.walk();
    for p in params.named_children(&mut c) {
        match p.kind() {
            "formal_parameter" => {
                let mut ty = p.child_by_field_name("type").map(|t| erased(t, text)).unwrap_or_default();
                if let Some(d) = p.child_by_field_name("dimensions") {
                    ty.push_str(&"[]".repeat(node_text(d, text).matches('[').count()));
                }
                out.push(ty);
            }
            "spread_parameter" => {
                let mut pc = p.walk();
                let ty = p
                    .named_children(&mut pc)
                    .find(|n| {
                        !matches!(n.kind(), "modifiers" | "annotation" | "marker_annotation" | "variable_declarator")
                    })
                    .map(|t| erased(t, text))
                    .unwrap_or_default();
                out.push(format!("{ty}[]"));
            }
            _ => {}
        }
    }
    out
}

fn declare_type(decl: Node, outer: Option<u32>, extra: u16, text: &str, stub: &mut JavaStub) {
    let Some(kind) = type_kind(decl.kind()) else { return };
    let Some(name) = decl.child_by_field_name("name") else { return };
    let (mut flags, annotations) = modifiers(decl, text);
    flags |= extra;
    let outer_kind = outer.map(|o| stub.types[o as usize].kind);
    // Member types of interfaces are implicitly public and static; nested enums, records,
    // interfaces and annotations are implicitly static.
    if matches!(outer_kind, Some(JavaTypeKind::Interface | JavaTypeKind::Annotation)) && flags & LOCAL == 0 {
        flags |= PUBLIC | STATIC;
    }
    if outer.is_some() && kind != JavaTypeKind::Class {
        flags |= STATIC;
    }
    match kind {
        JavaTypeKind::Interface | JavaTypeKind::Annotation => flags |= ABSTRACT,
        JavaTypeKind::Enum | JavaTypeKind::Record => flags |= FINAL,
        JavaTypeKind::Class => {}
    }
    let mut supers = Vec::new();
    let mut super_args = Vec::new();
    let mut c = decl.walk();
    for child in decl.children(&mut c) {
        match child.kind() {
            "superclass" | "super_interfaces" | "extends_interfaces" => {
                type_list(child, text, &mut supers, &mut super_args)
            }
            _ => {}
        }
    }
    let index = stub.types.len() as u32;
    stub.types.push(JavaType {
        name: node_text(name, text).to_owned(),
        kind,
        outer,
        flags,
        supers,
        type_params: type_params(decl, text),
        annotations,
        at: pos(name, text),
        end_line: decl.end_position().row as u32,
        members: Vec::new(),
        values: annotation_values(decl, text),
        annotation_args: annotation_args(decl, text),
        super_args,
    });
    if kind == JavaTypeKind::Record
        && let Some(params) = decl.child_by_field_name("parameters")
    {
        let mut pc = params.walk();
        for p in params.named_children(&mut pc).filter(|p| p.kind() == "formal_parameter") {
            let (Some(n), Some(t)) = (p.child_by_field_name("name"), p.child_by_field_name("type")) else { continue };
            let (ty, at, end_line) = (erased(t, text), pos(n, text), p.end_position().row as u32);
            let name = node_text(n, text).to_owned();
            let member = |kind, flags, ty: &str| JavaMember {
                name: name.clone(),
                kind,
                flags,
                params: Vec::new(),
                ty: ty.to_owned(),
                type_params: Vec::new(),
                annotations: Vec::new(),
                at,
                end_line,
                ty_args: Vec::new(),
                values: Vec::new(),
                param_details: Vec::new(),
                annotation_args: Vec::new(),
            };
            // The component's field and its accessor, both at the component.
            let members = &mut stub.types[index as usize].members;
            members.push(member(JavaMemberKind::Field, PRIVATE | FINAL, &ty));
            members.push(member(JavaMemberKind::Method, PUBLIC, &ty));
        }
    }
    if let Some(body) = decl.child_by_field_name("body") {
        declare_members(body, index, kind, text, stub);
    }
}

fn declare_members(body: Node, owner: u32, owner_kind: JavaTypeKind, text: &str, stub: &mut JavaStub) {
    let interface = matches!(owner_kind, JavaTypeKind::Interface | JavaTypeKind::Annotation);
    let mut c = body.walk();
    for child in body.named_children(&mut c) {
        let kind = child.kind();
        if type_kind(kind).is_some() {
            declare_type(child, Some(owner), 0, text, stub);
            continue;
        }
        match kind {
            "enum_body_declarations" => declare_members(child, owner, JavaTypeKind::Class, text, stub),
            "method_declaration"
            | "constructor_declaration"
            | "compact_constructor_declaration"
            | "annotation_type_element_declaration" => {
                let Some(name) = child.child_by_field_name("name") else { continue };
                let (mut flags, annotations) = modifiers(child, text);
                let member_kind = if kind == "method_declaration" || kind == "annotation_type_element_declaration" {
                    JavaMemberKind::Method
                } else {
                    JavaMemberKind::Constructor
                };
                if interface && member_kind == JavaMemberKind::Method {
                    if flags & PRIVATE == 0 {
                        flags |= PUBLIC;
                    }
                    if flags & (DEFAULT | STATIC | PRIVATE) == 0 && child.child_by_field_name("body").is_none() {
                        flags |= ABSTRACT;
                    }
                }
                let params = if kind == "compact_constructor_declaration" {
                    record_components(stub, owner)
                } else {
                    parameters(child.child_by_field_name("parameters"), text)
                };
                stub.types[owner as usize].members.push(JavaMember {
                    name: node_text(name, text).to_owned(),
                    kind: member_kind,
                    flags,
                    params,
                    ty: child.child_by_field_name("type").map(|t| erased(t, text)).unwrap_or_default(),
                    type_params: type_params(child, text),
                    annotations,
                    at: pos(name, text),
                    end_line: child.end_position().row as u32,
                    ty_args: child.child_by_field_name("type").map(|t| type_args(t, text)).unwrap_or_default(),
                    values: annotation_values(child, text),
                    param_details: param_details(child.child_by_field_name("parameters"), text),
                    annotation_args: annotation_args(child, text),
                });
                if let Some(body) = child.child_by_field_name("body") {
                    local_types(body, owner, text, stub);
                }
            }
            "field_declaration" | "constant_declaration" => {
                let (mut flags, annotations) = modifiers(child, text);
                if interface || kind == "constant_declaration" {
                    flags |= PUBLIC | STATIC | FINAL;
                }
                let ty_node = child.child_by_field_name("type");
                let ty = ty_node.map(|t| erased(t, text)).unwrap_or_default();
                let ty_args = ty_node.map(|t| type_args(t, text)).unwrap_or_default();
                let values = annotation_values(child, text);
                let args = annotation_args(child, text);
                let mut dc = child.walk();
                for d in child.children_by_field_name("declarator", &mut dc) {
                    let Some(name) = d.child_by_field_name("name") else { continue };
                    stub.types[owner as usize].members.push(JavaMember {
                        name: node_text(name, text).to_owned(),
                        kind: JavaMemberKind::Field,
                        flags,
                        params: Vec::new(),
                        ty: ty.clone(),
                        type_params: Vec::new(),
                        annotations: annotations.clone(),
                        at: pos(name, text),
                        end_line: d.end_position().row as u32,
                        ty_args: ty_args.clone(),
                        values: values.clone(),
                        param_details: Vec::new(),
                        annotation_args: args.clone(),
                    });
                    if let Some(value) = d.child_by_field_name("value") {
                        local_types(value, owner, text, stub);
                    }
                }
            }
            "enum_constant" => {
                let Some(name) = child.child_by_field_name("name") else { continue };
                let (_, annotations) = modifiers(child, text);
                let ty = stub.types[owner as usize].name.clone();
                stub.types[owner as usize].members.push(JavaMember {
                    name: node_text(name, text).to_owned(),
                    kind: JavaMemberKind::EnumConstant,
                    flags: PUBLIC | STATIC | FINAL,
                    params: Vec::new(),
                    ty,
                    type_params: Vec::new(),
                    annotations,
                    at: pos(name, text),
                    end_line: child.end_position().row as u32,
                    ty_args: Vec::new(),
                    values: Vec::new(),
                    param_details: Vec::new(),
                    annotation_args: annotation_args(child, text),
                });
                if let Some(args) = child.child_by_field_name("arguments") {
                    local_types(args, owner, text, stub);
                }
                // A constant with a body is an anonymous subclass of the enum.
                if let Some(body) = child.child_by_field_name("body") {
                    let enum_name = stub.types[owner as usize].name.clone();
                    anonymous_type(body, enum_name, pos(name, text), child, owner, text, stub);
                }
            }
            "static_initializer" | "block" => local_types(child, owner, text, stub),
            _ => {}
        }
    }
}

fn record_components(stub: &JavaStub, owner: u32) -> Vec<String> {
    stub.types[owner as usize]
        .members
        .iter()
        .filter(|m| m.kind == JavaMemberKind::Field && !m.is(STATIC))
        .map(|m| simple(&m.ty).to_owned())
        .collect()
}

/// Local and anonymous classes inside code.
fn local_types(n: Node, owner: u32, text: &str, stub: &mut JavaStub) {
    let mut c = n.walk();
    for child in n.named_children(&mut c) {
        if type_kind(child.kind()).is_some() {
            declare_type(child, Some(owner), LOCAL, text, stub);
        } else if child.kind() == "object_creation_expression" {
            let mut cc = child.walk();
            let body = child.named_children(&mut cc).find(|b| b.kind() == "class_body");
            match (body, child.child_by_field_name("type")) {
                (Some(body), Some(ty)) => {
                    let base = erased(ty, text);
                    if let Some(args) = child.child_by_field_name("arguments") {
                        local_types(args, owner, text, stub);
                    }
                    anonymous_type(body, base, pos(ty, text), child, owner, text, stub);
                }
                _ => local_types(child, owner, text, stub),
            }
        } else {
            local_types(child, owner, text, stub);
        }
    }
}

fn anonymous_type(body: Node, base: String, at: Pos, decl: Node, owner: u32, text: &str, stub: &mut JavaStub) {
    let index = stub.types.len() as u32;
    stub.types.push(JavaType {
        name: String::new(),
        kind: JavaTypeKind::Class,
        outer: Some(owner),
        flags: ANONYMOUS | LOCAL | FINAL,
        supers: vec![base],
        type_params: Vec::new(),
        annotations: Vec::new(),
        at,
        end_line: decl.end_position().row as u32,
        members: Vec::new(),
        values: Vec::new(),
        annotation_args: Vec::new(),
        super_args: vec![Vec::new()],
    });
    declare_members(body, index, JavaTypeKind::Class, text, stub);
}

fn collect_words<'a>(root: Node, text: &'a str, out: &mut HashSet<&'a str>) {
    let mut cursor = root.walk();
    loop {
        let n = cursor.node();
        if matches!(n.kind(), "identifier" | "type_identifier") {
            out.insert(node_text(n, text));
        }
        if !matches!(n.kind(), "line_comment" | "block_comment" | "string_literal") && cursor.goto_first_child() {
            continue;
        }
        while !cursor.goto_next_sibling() {
            if !cursor.goto_parent() {
                return;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The project graph

/// A type of an indexed file: file slot and index in its stub.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TypeId {
    pub file: u32,
    pub ty: u32,
}

/// Inverted Java indexes over the files of an [`IndexData`], kept in step with it.
#[derive(Default)]
pub(crate) struct JavaGraph {
    by_name: HashMap<Box<str>, Vec<TypeId>>,
    by_super: HashMap<Box<str>, Vec<TypeId>>,
    /// Identifier index: interned words, and per word the files mentioning it.
    word_ids: HashMap<Box<str>, u32>,
    word_names: Vec<Box<str>>,
    postings: Vec<Vec<u32>>,
    /// XOR of the files' [`JavaStub::structure_hash`]: changes when any declaration does.
    pub structure: u128,
    /// XOR of the files' [`JavaStub::hierarchy_hash`].
    hierarchy: u128,
    /// Per member name, XOR of the files' [`JavaStub::name_hashes`].
    names: HashMap<Box<str>, u128>,
    pub files: u32,
}

impl JavaGraph {
    /// Adds a file; takes its words (kept here, interned) and returns their ids.
    pub(crate) fn add(&mut self, file: u32, stub: &mut JavaStub) -> Box<[u32]> {
        for (i, t) in stub.types.iter().enumerate() {
            let id = TypeId { file, ty: i as u32 };
            if !t.name.is_empty() {
                self.by_name.entry(t.name.as_str().into()).or_default().push(id);
            }
            let mut seen = HashSet::new();
            for s in &t.supers {
                let name = simple(s);
                if seen.insert(name) {
                    self.by_super.entry(name.into()).or_default().push(id);
                }
            }
        }
        let words: Box<[u32]> = std::mem::take(&mut stub.words)
            .into_iter()
            .map(|w| {
                let id = match self.word_ids.get(w.as_str()) {
                    Some(&id) => id,
                    None => {
                        let id = self.word_names.len() as u32;
                        let w: Box<str> = w.into();
                        self.word_ids.insert(w.clone(), id);
                        self.word_names.push(w);
                        self.postings.push(Vec::new());
                        id
                    }
                };
                self.postings[id as usize].push(file);
                id
            })
            .collect();
        self.structure ^= stub.structure_hash();
        self.hierarchy ^= stub.hierarchy_hash();
        for (name, h) in stub.name_hashes() {
            *self.names.entry(name.into()).or_default() ^= h;
        }
        self.files += 1;
        words
    }

    pub(crate) fn remove(&mut self, file: u32, stub: &JavaStub, words: &[u32]) {
        fn drop_from(map: &mut HashMap<Box<str>, Vec<TypeId>>, key: &str, file: u32) {
            if let Some(list) = map.get_mut(key) {
                list.retain(|id| id.file != file);
                if list.is_empty() {
                    map.remove(key);
                }
            }
        }
        for t in &stub.types {
            if !t.name.is_empty() {
                drop_from(&mut self.by_name, &t.name, file);
            }
            for s in &t.supers {
                drop_from(&mut self.by_super, simple(s), file);
            }
        }
        for &w in words {
            if let Some(p) = self.postings.get_mut(w as usize) {
                p.retain(|&f| f != file);
            }
        }
        self.structure ^= stub.structure_hash();
        self.hierarchy ^= stub.hierarchy_hash();
        for (name, h) in stub.name_hashes() {
            if let Some(v) = self.names.get_mut(name) {
                *v ^= h;
                if *v == 0 {
                    self.names.remove(name);
                }
            }
        }
        self.files -= 1;
    }

    /// What resolving references written with `words` depends on beyond the referencing file:
    /// the type hierarchy, and the declarations with one of those names.
    pub(crate) fn dependency_hash(&self, words: &[String]) -> u128 {
        let mut h = Hash::default();
        h.put(&self.hierarchy.to_string());
        for w in words {
            h.put(w);
            h.put(&self.names.get(w.as_str()).copied().unwrap_or_default().to_string());
        }
        h.finish()
    }

    /// Files whose code mentions `word`.
    pub(crate) fn files_with_word(&self, word: &str) -> &[u32] {
        self.word_ids.get(word).map_or(&[], |&id| self.postings[id as usize].as_slice())
    }

    pub(crate) fn word_names(&self, ids: &[u32]) -> Vec<String> {
        ids.iter().filter_map(|&id| self.word_names.get(id as usize)).map(|w| w.to_string()).collect()
    }
}

/// A file being edited, parsed from its unsaved text: answers for it replace the index's.
pub struct Overlay<'a> {
    /// Its slot in the index, if it is indexed.
    pub file: Option<u32>,
    pub stub: &'a JavaStub,
}

/// A type found by name: in a source file, or outside the sources (a library, the JDK).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Resolved {
    Source(TypeId),
    /// Fully qualified as far as known (`java.lang.Runnable`, or the name as written).
    External(String),
}

/// Overlay file pseudo-slot when the edited file is not indexed.
const OVERLAY: u32 = u32::MAX;

/// Queries over the index, with the edited file's unsaved declarations.
pub struct JavaView<'a> {
    pub(crate) data: &'a IndexData,
    pub(crate) overlay: Option<Overlay<'a>>,
}

impl<'a> JavaView<'a> {
    fn overlay_slot(&self) -> Option<u32> {
        self.overlay.as_ref().map(|o| o.file.unwrap_or(OVERLAY))
    }

    /// The edited file's slot (or its pseudo-slot when it is not indexed).
    pub fn overlay_file(&self) -> Option<u32> {
        self.overlay_slot()
    }

    pub fn stub(&self, file: u32) -> Option<&'a JavaStub> {
        if let Some(o) = &self.overlay
            && o.file.unwrap_or(OVERLAY) == file
        {
            return Some(o.stub);
        }
        self.data.files.get(file as usize)?.as_ref()?.java.as_deref()
    }

    pub fn ty(&self, id: TypeId) -> Option<&'a JavaType> {
        self.stub(id.file)?.types.get(id.ty as usize)
    }

    pub fn path(&self, file: u32) -> Option<&'a std::path::Path> {
        self.data.files.get(file as usize)?.as_ref().map(|e| e.path.as_path())
    }

    /// Types named `name`, the edited file's from its unsaved text.
    fn named(&self, name: &str) -> Vec<TypeId> {
        let skip = self.overlay_slot();
        let mut out: Vec<TypeId> = self
            .data
            .java
            .by_name
            .get(name)
            .map(|v| v.iter().copied().filter(|id| Some(id.file) != skip).collect())
            .unwrap_or_default();
        if let Some(o) = &self.overlay {
            let file = o.file.unwrap_or(OVERLAY);
            out.extend(
                o.stub
                    .types
                    .iter()
                    .enumerate()
                    .filter(|(_, t)| t.name == name)
                    .map(|(i, _)| TypeId { file, ty: i as u32 }),
            );
        }
        out
    }

    /// Types writing a supertype named `name` (simple name).
    fn writing_super(&self, name: &str) -> Vec<TypeId> {
        let skip = self.overlay_slot();
        let mut out: Vec<TypeId> = self
            .data
            .java
            .by_super
            .get(name)
            .map(|v| v.iter().copied().filter(|id| Some(id.file) != skip).collect())
            .unwrap_or_default();
        if let Some(o) = &self.overlay {
            let file = o.file.unwrap_or(OVERLAY);
            out.extend(
                o.stub
                    .types
                    .iter()
                    .enumerate()
                    .filter(|(_, t)| t.supers.iter().any(|s| simple(s) == name))
                    .map(|(i, _)| TypeId { file, ty: i as u32 }),
            );
        }
        out
    }

    pub fn qualified_name(&self, id: TypeId) -> Option<String> {
        Some(self.stub(id.file)?.qualified_name(id.ty))
    }

    /// The source type with this fully qualified name (`a.b.Outer.Inner`).
    fn by_qualified(&self, fqn: &str) -> Option<TypeId> {
        self.named(simple(fqn)).into_iter().find(|&id| self.qualified_name(id).as_deref() == Some(fqn))
    }

    /// Member type `name` of `owner` (declared there, not inherited).
    fn member_type(&self, owner: TypeId, name: &str) -> Option<TypeId> {
        let stub = self.stub(owner.file)?;
        stub.types
            .iter()
            .position(|t| t.outer == Some(owner.ty) && t.name == name && !t.is(LOCAL))
            .map(|i| TypeId { file: owner.file, ty: i as u32 })
    }

    /// Resolves a type name written in `context` (a type of a file), as `javac` would for the
    /// source types; other names are reported as external with their best qualified guess.
    pub fn resolve(&self, context: TypeId, written: &str) -> Resolved {
        let written = written.trim_end_matches("[]");
        let (first, rest) = match written.split_once('.') {
            Some((a, b)) => (a, Some(b)),
            None => (written, None),
        };
        match self.resolve_simple(context, first) {
            Some(Resolved::Source(mut id)) => {
                for part in rest.into_iter().flat_map(|r| r.split('.')) {
                    match self.member_type(id, part) {
                        Some(inner) => id = inner,
                        None => return Resolved::External(written.to_owned()),
                    }
                }
                Resolved::Source(id)
            }
            Some(Resolved::External(q)) => Resolved::External(match rest {
                Some(r) => format!("{q}.{r}"),
                None => q,
            }),
            None if rest.is_some() => match self.by_qualified(written) {
                Some(id) => Resolved::Source(id),
                None => Resolved::External(written.to_owned()),
            },
            None => Resolved::External(written.to_owned()),
        }
    }

    fn resolve_simple(&self, context: TypeId, name: &str) -> Option<Resolved> {
        let stub = self.stub(context.file)?;
        // The type itself, its member types, and those of the enclosing types.
        let mut next = Some(context.ty);
        while let Some(i) = next {
            let t = &stub.types[i as usize];
            if t.name == name {
                return Some(Resolved::Source(TypeId { file: context.file, ty: i }));
            }
            if t.type_params.iter().any(|p| p == name) {
                return Some(Resolved::External(name.to_owned()));
            }
            if let Some(id) = self.member_type(TypeId { file: context.file, ty: i }, name) {
                return Some(Resolved::Source(id));
            }
            next = t.outer;
        }
        // Single-type imports.
        if let Some(import) = stub.imports.iter().find(|i| !i.on_demand && simple(&i.path) == name) {
            return Some(match self.by_qualified(&import.path) {
                Some(id) => Resolved::Source(id),
                None => Resolved::External(import.path.clone()),
            });
        }
        // The package (top-level types of every file of it, this one included).
        let in_package = self.named(name).into_iter().find(|&id| {
            self.stub(id.file).is_some_and(|s| s.package == stub.package && s.types[id.ty as usize].outer.is_none())
        });
        if let Some(id) = in_package {
            return Some(Resolved::Source(id));
        }
        // On-demand imports: `p.*` (a package or a type's members).
        for import in stub.imports.iter().filter(|i| i.on_demand) {
            if let Some(id) = self.by_qualified(&format!("{}.{name}", import.path)) {
                return Some(Resolved::Source(id));
            }
        }
        let first = name.chars().next().is_some_and(char::is_uppercase);
        if !first {
            return None;
        }
        Some(Resolved::External(format!("java.lang.{name}")))
    }

    /// Resolved supertypes of `id`, as written.
    pub fn supertypes(&self, id: TypeId) -> Vec<Resolved> {
        let Some(t) = self.ty(id) else { return Vec::new() };
        // Supertypes are resolved where the type is declared, not inside it.
        let context = match t.outer {
            Some(o) if !t.is(ANONYMOUS) && !t.is(LOCAL) => TypeId { file: id.file, ty: o },
            _ => id,
        };
        t.supers
            .iter()
            .map(|s| {
                // A nested type cannot extend itself; resolve from the outer type for top-level ones too.
                if t.outer.is_none() && simple(s) == t.name && !t.is(ANONYMOUS) {
                    return self.resolve_from_file(id.file, s);
                }
                self.resolve(context, s)
            })
            .collect()
    }

    /// Resolution from a file's top level (imports and package), not from inside a type.
    fn resolve_from_file(&self, file: u32, written: &str) -> Resolved {
        let Some(stub) = self.stub(file) else { return Resolved::External(written.to_owned()) };
        let name = simple(written);
        if written.contains('.') {
            return self.by_qualified(written).map_or_else(|| Resolved::External(written.to_owned()), Resolved::Source);
        }
        if let Some(import) = stub.imports.iter().find(|i| !i.on_demand && simple(&i.path) == name) {
            return self
                .by_qualified(&import.path)
                .map_or_else(|| Resolved::External(import.path.clone()), Resolved::Source);
        }
        Resolved::External(written.to_owned())
    }

    /// Types writing `target` as a supertype.
    pub fn direct_subtypes(&self, target: TypeId) -> Vec<TypeId> {
        let Some(t) = self.ty(target) else { return Vec::new() };
        if t.name.is_empty() {
            return Vec::new();
        }
        self.writing_super(&t.name)
            .into_iter()
            .filter(|&c| c != target && self.supertypes(c).contains(&Resolved::Source(target)))
            .collect()
    }

    /// Every subtype of `target`, nearest first (at most `limit`).
    pub fn all_subtypes(&self, target: TypeId, limit: usize) -> Vec<TypeId> {
        let mut seen = HashSet::from([target]);
        let mut queue = VecDeque::from([target]);
        let mut out = Vec::new();
        while let Some(t) = queue.pop_front() {
            for s in self.direct_subtypes(t) {
                if seen.insert(s) {
                    out.push(s);
                    if out.len() >= limit {
                        return out;
                    }
                    queue.push_back(s);
                }
            }
        }
        out
    }

    /// Every supertype of `target`: the source ones, and whether one is outside the sources
    /// (a library type, which may declare more methods).
    pub fn all_supertypes(&self, target: TypeId) -> (Vec<TypeId>, bool) {
        let mut seen = HashSet::from([target]);
        let mut queue = VecDeque::from([target]);
        let mut out = Vec::new();
        let mut external = false;
        while let Some(t) = queue.pop_front() {
            for s in self.supertypes(t) {
                match s {
                    Resolved::Source(id) => {
                        if seen.insert(id) {
                            out.push(id);
                            queue.push_back(id);
                        }
                    }
                    Resolved::External(_) => external = true,
                }
            }
        }
        (out, external)
    }

    /// Whether method `m` of `owner` may override method `s` of `super_owner`: same name and
    /// arity, and parameter types with the same simple names (type variables match anything).
    pub fn overrides(&self, owner: TypeId, m: &JavaMember, super_owner: TypeId, s: &JavaMember) -> bool {
        if m.kind != JavaMemberKind::Method || s.kind != JavaMemberKind::Method || m.name != s.name {
            return false;
        }
        if m.params.len() != s.params.len() || m.is(STATIC) || s.is(STATIC) || s.is(PRIVATE) {
            return false;
        }
        /// Type variables in scope of a method: its own and its (non-static) enclosing types'.
        fn vars<'x>(stub: Option<&'x JavaStub>, ty: u32, member: &'x JavaMember) -> Vec<&'x str> {
            let mut v: Vec<&str> = member.type_params.iter().map(String::as_str).collect();
            let mut next = Some(ty);
            while let (Some(i), Some(stub)) = (next, stub) {
                let t = &stub.types[i as usize];
                v.extend(t.type_params.iter().map(String::as_str));
                next = if t.is(STATIC) { None } else { t.outer };
            }
            v
        }
        let mine = vars(self.stub(owner.file), owner.ty, m);
        let theirs = vars(self.stub(super_owner.file), super_owner.ty, s);
        m.params.iter().zip(&s.params).all(|(a, b)| {
            let (a_dims, b_dims) = (a.matches("[]").count(), b.matches("[]").count());
            let (a, b) = (simple(a.trim_end_matches("[]")), simple(b.trim_end_matches("[]")));
            a_dims == b_dims && (a == b || mine.contains(&a) || theirs.contains(&b))
        })
    }
}

mod insight;
pub mod spring;
pub use insight::{
    JavaMarker, JavaMarkerKind, JavaMarkerTarget, JavaMarkers, JavaTypeItem, UsageScope, declaration_named_at,
    implementations, implementations_may_be_generated, markers, subtype_items, supertype_items, usage_scope,
};

#[cfg(test)]
mod tests;
