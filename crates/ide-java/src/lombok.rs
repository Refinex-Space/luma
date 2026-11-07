//! Members Lombok generates, as IDEA's Lombok plugin (`plugins/lombok`, Apache 2.0) adds them to
//! the PSI so that code calling them resolves: accessors (`@Getter`, `@Setter`, `@Data`,
//! `@Value`, with `@Accessors`), constructors (`@NoArgsConstructor`, `@AllArgsConstructor`,
//! `@RequiredArgsConstructor`, with `staticName`), `@With`, the logger fields of the `@Log`
//! family, and `@Builder` (on a class, a constructor or a static method) with its builder class.
//!
//! Anything Lombok generates beyond these (`@SuperBuilder`, `@Singular` adders, `@Delegate`,
//! `lombok.config` naming) is not synthesized: references to it find nothing, and the search
//! leaves such occurrences undecided rather than counting them wrong.

use crate::model::{
    ACC_FINAL, ACC_PRIVATE, ACC_PUBLIC, ACC_STATIC, ClassData, FieldData, IMPLICIT, Members, MethodData, Model, Scope,
};
use crate::types::{ClassType, Key, Type};
use ide_index::java::{self as ix, AnnotationValue, JavaAnnotation, JavaMemberKind, JavaStub, JavaType, TypeId};

/// The package of Lombok annotation `name`.
fn lombok_package(name: &str) -> &'static str {
    match name {
        "Slf4j" | "XSlf4j" => "lombok.extern.slf4j",
        "Log4j2" | "Log4j" => "lombok.extern.log4j",
        "Log" => "lombok.extern.java",
        "CommonsLog" => "lombok.extern.apachecommons",
        "JBossLog" => "lombok.extern.jbosslog",
        "Flogger" => "lombok.extern.flogger",
        "Accessors" | "Delegate" | "UtilityClass" | "SuperBuilder" | "FieldDefaults" | "Wither" | "ExtensionMethod" => {
            "lombok.experimental"
        }
        _ => "lombok",
    }
}

/// Lombok annotation `name` (simple) on a declaration of a file: written fully qualified, or
/// simply with its class or package imported.
fn find<'s>(stub: &JavaStub, anns: &'s [JavaAnnotation], name: &str) -> Option<&'s JavaAnnotation> {
    let package = lombok_package(name);
    let qualified = format!("{package}.{name}");
    let imported = stub
        .imports
        .iter()
        .any(|i| !i.is_static && (i.on_demand && i.path == package || !i.on_demand && i.path == qualified));
    anns.iter().find(|a| a.name == qualified || imported && a.name == name)
}

/// The access level of an accessor annotation: `None` for `AccessLevel.NONE`.
fn access(a: &JavaAnnotation) -> Option<u32> {
    let level = a.arg("value").and_then(|v| match v {
        AnnotationValue::Name(n) => Some(ix::simple(n).to_owned()),
        _ => None,
    });
    Some(match level.as_deref() {
        Some("NONE") => return None,
        Some("PRIVATE") => ACC_PRIVATE as u32,
        Some("PROTECTED") => crate::model::ACC_PROTECTED as u32,
        Some("PACKAGE") | Some("MODULE") => 0,
        _ => ACC_PUBLIC as u32,
    })
}

fn bool_arg(a: &JavaAnnotation, name: &str) -> bool {
    a.arg(name).and_then(AnnotationValue::as_bool).unwrap_or(false)
}

fn str_arg(a: &JavaAnnotation, name: &str) -> Option<String> {
    a.arg(name).and_then(|v| v.as_str()).map(str::to_owned)
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().chain(c).collect(),
        None => String::new(),
    }
}

struct Accessors {
    fluent: bool,
    chain: bool,
    prefix: Vec<String>,
}

fn accessors(stub: &JavaStub, t: &JavaType, field_anns: &[JavaAnnotation]) -> Accessors {
    let a = find(stub, field_anns, "Accessors").or_else(|| find(stub, &t.annotation_args, "Accessors"));
    match a {
        None => Accessors { fluent: false, chain: false, prefix: Vec::new() },
        Some(a) => {
            let fluent = bool_arg(a, "fluent");
            Accessors {
                fluent,
                chain: bool_arg(a, "chain") || fluent && a.arg("chain").is_none(),
                prefix: a
                    .arg("prefix")
                    .map(|v| v.strings().into_iter().map(str::to_owned).collect())
                    .unwrap_or_default(),
            }
        }
    }
}

/// The field name without an `@Accessors(prefix)` prefix; `None` when a prefix is configured
/// and the field has none (Lombok then generates nothing).
fn base_name(field: &str, acc: &Accessors) -> Option<String> {
    if acc.prefix.is_empty() {
        return Some(field.to_owned());
    }
    for p in &acc.prefix {
        if let Some(rest) = field.strip_prefix(p.as_str())
            && rest.chars().next().is_some_and(|c| !c.is_lowercase() || p.is_empty())
            && !rest.is_empty()
        {
            let mut c = rest.chars();
            let first = c.next().unwrap_or_default();
            return Some(first.to_lowercase().chain(c).collect());
        }
    }
    None
}

/// Lombok's accessor names: `getFoo` / `isFoo` (primitive boolean; a field `isFoo` keeps its
/// name) and `setFoo`; with `fluent`, the field name.
fn getter_name(field: &str, boolean: bool, acc: &Accessors) -> Option<String> {
    let base = base_name(field, acc)?;
    if acc.fluent {
        return Some(base);
    }
    if boolean {
        if base.starts_with("is") && base[2..].chars().next().is_some_and(char::is_uppercase) {
            return Some(base);
        }
        return Some(format!("is{}", capitalize(&base)));
    }
    Some(format!("get{}", capitalize(&base)))
}

fn setter_name(field: &str, boolean: bool, acc: &Accessors) -> Option<String> {
    let base = base_name(field, acc)?;
    if acc.fluent {
        return Some(base);
    }
    let base = if boolean && base.starts_with("is") && base[2..].chars().next().is_some_and(char::is_uppercase) {
        base[2..].to_owned()
    } else {
        base
    };
    Some(format!("set{}", capitalize(&base)))
}

fn method(name: &str, flags: u32, params: Vec<Type>, ret: Type) -> MethodData {
    MethodData {
        name: name.to_owned(),
        flags: flags | IMPLICIT,
        type_params: Vec::new(),
        params,
        varargs: false,
        ret,
        source: None,
    }
}

const LOGGERS: [(&str, &str); 9] = [
    ("Slf4j", "org/slf4j/Logger"),
    ("XSlf4j", "org/slf4j/ext/XLogger"),
    ("Log4j2", "org/apache/logging/log4j/Logger"),
    ("Log4j", "org/apache/log4j/Logger"),
    ("Log", "java/util/logging/Logger"),
    ("CommonsLog", "org/apache/commons/logging/Log"),
    ("JBossLog", "org/jboss/logging/Logger"),
    ("Flogger", "com/google/common/flogger/FluentLogger"),
    ("CustomLog", ""),
];

/// Whether `t` (in `stub`) carries a Lombok annotation that generates members.
pub fn generates(stub: &JavaStub, t: &JavaType) -> bool {
    const ANNS: [&str; 12] = [
        "Data",
        "Value",
        "Getter",
        "Setter",
        "Builder",
        "SuperBuilder",
        "NoArgsConstructor",
        "AllArgsConstructor",
        "RequiredArgsConstructor",
        "With",
        "Delegate",
        "UtilityClass",
    ];
    ANNS.iter().any(|a| find(stub, &t.annotation_args, a).is_some())
        || LOGGERS.iter().any(|(a, _)| find(stub, &t.annotation_args, a).is_some())
        || t.members.iter().any(|m| ANNS.iter().any(|a| find(stub, &m.annotation_args, a).is_some()))
}

/// Adds the members Lombok generates for source class `c` (`id`) to `out`.
pub(crate) fn add_members(model: &Model, c: &ClassData, id: TypeId, out: &mut Members) {
    let Some(stub) = model.view.stub(id.file) else { return };
    let Some(t) = stub.types.get(id.ty as usize) else { return };
    if !generates(stub, t) {
        return;
    }
    let me = Type::Class(c.self_type());
    let data = find(stub, &t.annotation_args, "Data");
    let value = find(stub, &t.annotation_args, "Value");
    let class_getter = find(stub, &t.annotation_args, "Getter");
    let class_setter = find(stub, &t.annotation_args, "Setter");
    let class_with = find(stub, &t.annotation_args, "With");
    let has = |name: &str, params: usize, out: &Members| {
        out.methods.iter().any(|m| m.name == name && m.params.len() == params)
    };

    // Instance fields with their types, in declaration order.
    let fields: Vec<(String, Type, u32, &[JavaAnnotation], bool)> = t
        .members
        .iter()
        .filter(|m| m.kind == JavaMemberKind::Field && !m.is(ix::STATIC))
        .filter_map(|m| {
            let f = out.fields.iter().find(|f| f.name == m.name)?;
            Some((m.name.clone(), f.ty.clone(), f.flags, m.annotation_args.as_slice(), m.is(ix::INITIALIZED)))
        })
        .collect();
    let is_final = |flags: u32| flags & ACC_FINAL as u32 != 0 || value.is_some();

    for (name, ty, flags, anns, _) in &fields {
        let acc = accessors(stub, t, anns);
        let boolean = *ty == Type::Prim(crate::classfile::BaseType::Boolean);
        let getter = find(stub, anns, "Getter").map(access).unwrap_or_else(|| {
            class_getter.map(access).unwrap_or(if data.is_some() || value.is_some() {
                Some(ACC_PUBLIC as u32)
            } else {
                None
            })
        });
        if let Some(level) = getter
            && let Some(g) = getter_name(name, boolean, &acc)
            && !has(&g, 0, out)
        {
            out.methods.push(method(&g, level, Vec::new(), ty.clone()));
        }
        let setter = find(stub, anns, "Setter").map(access).unwrap_or_else(|| {
            class_setter.map(access).unwrap_or(if data.is_some() { Some(ACC_PUBLIC as u32) } else { None })
        });
        if let Some(level) = setter
            && !is_final(*flags)
            && let Some(s) = setter_name(name, boolean, &acc)
            && !has(&s, 1, out)
        {
            let ret = if acc.chain { me.clone() } else { Type::Void };
            out.methods.push(method(&s, level, vec![ty.clone()], ret));
        }
        let with = find(stub, anns, "With").or(class_with).and_then(access);
        if let Some(level) = with
            && let Some(base) = base_name(name, &acc)
        {
            let w = format!("with{}", capitalize(&base));
            if !has(&w, 1, out) {
                out.methods.push(method(&w, level, vec![ty.clone()], me.clone()));
            }
        }
    }

    // Constructors.
    let explicit_ctor = out.methods.iter().any(|m| m.is_constructor() && m.flags & IMPLICIT == 0);
    let required: Vec<Type> = fields
        .iter()
        .filter(|(_, _, flags, anns, init)| {
            (is_final(*flags) && !init) || anns.iter().any(|a| ix::simple(&a.name) == "NonNull") && !init
        })
        .map(|(_, ty, ..)| ty.clone())
        .collect();
    let all: Vec<Type> = fields
        .iter()
        .filter(|(_, _, flags, _, init)| !(is_final(*flags) && *init))
        .map(|(_, ty, ..)| ty.clone())
        .collect();
    let ctor = |ann: Option<&JavaAnnotation>, params: Vec<Type>, out: &mut Members| {
        let Some(a) = ann else { return };
        let level = access(a).unwrap_or(ACC_PUBLIC as u32);
        if let Some(name) = str_arg(a, "staticName").filter(|s| !s.is_empty()) {
            out.methods.push(method(&name, level | ACC_STATIC as u32, params.clone(), me.clone()));
            out.methods.push(method("<init>", ACC_PRIVATE as u32, params, Type::Void));
        } else if !out.methods.iter().any(|m| m.is_constructor() && m.params == params) {
            out.methods.push(method("<init>", level, params, Type::Void));
        }
    };
    // The implicit default constructor exists only when no constructor is declared.
    let implicit_default =
        out.methods.iter().position(|m| m.is_constructor() && m.flags & IMPLICIT != 0 && m.source.is_none());
    let no_args = find(stub, &t.annotation_args, "NoArgsConstructor");
    let all_args = find(stub, &t.annotation_args, "AllArgsConstructor");
    let req_args = find(stub, &t.annotation_args, "RequiredArgsConstructor");
    if (no_args.is_some() || all_args.is_some() || req_args.is_some() || data.is_some() || value.is_some())
        && let Some(i) = implicit_default
    {
        out.methods.remove(i);
    }
    ctor(no_args, Vec::new(), out);
    ctor(all_args, all.clone(), out);
    ctor(req_args, required.clone(), out);
    let no_ctor_annotation = no_args.is_none() && all_args.is_none() && req_args.is_none();
    if let Some(a) = data
        && !explicit_ctor
        && no_ctor_annotation
    {
        let params = required;
        match str_arg(a, "staticConstructor").filter(|s| !s.is_empty()) {
            Some(name) => {
                out.methods.push(method(&name, ACC_PUBLIC as u32 | ACC_STATIC as u32, params.clone(), me.clone()));
                out.methods.push(method("<init>", ACC_PRIVATE as u32, params, Type::Void));
            }
            None => out.methods.push(method("<init>", ACC_PUBLIC as u32, params, Type::Void)),
        }
    }
    if let Some(a) = value
        && !explicit_ctor
        && no_ctor_annotation
    {
        match str_arg(a, "staticConstructor").filter(|s| !s.is_empty()) {
            Some(name) => {
                out.methods.push(method(&name, ACC_PUBLIC as u32 | ACC_STATIC as u32, all.clone(), me.clone()));
                out.methods.push(method("<init>", ACC_PRIVATE as u32, all, Type::Void));
            }
            None => out.methods.push(method("<init>", ACC_PUBLIC as u32, all, Type::Void)),
        }
    }

    // Loggers.
    for (ann, logger) in LOGGERS {
        if let Some(a) = find(stub, &t.annotation_args, ann)
            && !logger.is_empty()
        {
            let _ = a;
            if !out.fields.iter().any(|f| f.name == "log") {
                out.fields.push(FieldData {
                    name: "log".into(),
                    flags: ACC_PRIVATE as u32 | ACC_STATIC as u32 | ACC_FINAL as u32 | IMPLICIT,
                    ty: Type::class(logger),
                    enum_constant: false,
                    source: None,
                });
            }
        }
    }

    // Builders.
    for b in builders(model, c, id) {
        if !has(&b.builder_method, 0, out) {
            out.methods.push(method(
                &b.builder_method,
                ACC_PUBLIC as u32 | ACC_STATIC as u32,
                Vec::new(),
                Type::class(b.key.clone()),
            ));
        }
        if b.to_builder && !has("toBuilder", 0, out) {
            out.methods.push(method("toBuilder", ACC_PUBLIC as u32, Vec::new(), Type::class(b.key.clone())));
        }
    }
}

/// A `@Builder` of a class: its builder class and what it builds.
pub(crate) struct Builder {
    pub key: Key,
    pub builder_method: String,
    pub build_method: String,
    pub to_builder: bool,
    /// The builder's setters: (name, type).
    pub params: Vec<(String, Type)>,
    /// What `build()` returns.
    pub builds: Type,
}

/// The builders `@Builder` gives class `c` (on the class, its constructors, its static methods).
pub(crate) fn builders(model: &Model, c: &ClassData, id: TypeId) -> Vec<Builder> {
    let Some(stub) = model.view.stub(id.file) else { return Vec::new() };
    let Some(t) = stub.types.get(id.ty as usize) else { return Vec::new() };
    let scope = Scope { class: Some(c.key.clone()), file: Some(id.file), ..Default::default() };
    let mut out = Vec::new();
    let mut add = |a: &JavaAnnotation, params: Vec<(String, Type)>, builds: Type, base: &str| {
        let simple =
            str_arg(a, "builderClassName").filter(|s| !s.is_empty()).unwrap_or_else(|| format!("{base}Builder"));
        out.push(Builder {
            key: format!("{}${simple}", c.key).into(),
            builder_method: str_arg(a, "builderMethodName")
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "builder".into()),
            build_method: str_arg(a, "buildMethodName").filter(|s| !s.is_empty()).unwrap_or_else(|| "build".into()),
            to_builder: bool_arg(a, "toBuilder"),
            params,
            builds,
        });
    };
    let me = Type::Class(ClassType { key: c.key.clone(), args: Vec::new(), outer: None });
    if let Some(a) = find(stub, &t.annotation_args, "Builder") {
        let params = t
            .members
            .iter()
            .filter(|m| {
                m.kind == JavaMemberKind::Field && !m.is(ix::STATIC) && !(m.is(ix::FINAL) && m.is(ix::INITIALIZED))
            })
            .map(|m| (m.name.clone(), model.resolve_text(&m.sig.ty, &scope)))
            .collect();
        add(a, params, me.clone(), &t.name);
    }
    for m in &t.members {
        let Some(a) = find(stub, &m.annotation_args, "Builder") else { continue };
        let params = m
            .param_details
            .iter()
            .zip(&m.sig.params)
            .map(|(p, ty)| (p.name.clone(), model.resolve_text(ty, &scope)))
            .collect();
        match m.kind {
            JavaMemberKind::Constructor => add(a, params, me.clone(), &t.name),
            JavaMemberKind::Method => {
                let ret = model.resolve_text(&m.sig.ty, &scope);
                let base = ret
                    .as_class()
                    .map(|r| r.key.rsplit(['/', '$']).next().unwrap_or("").to_owned())
                    .unwrap_or_default();
                add(a, params, ret, &base);
            }
            _ => {}
        }
    }
    out
}

/// The members of a builder class.
pub(crate) fn builder_members(b: &Builder) -> Members {
    let me = Type::class(b.key.clone());
    let mut methods: Vec<MethodData> =
        b.params.iter().map(|(name, ty)| method(name, ACC_PUBLIC as u32, vec![ty.clone()], me.clone())).collect();
    methods.push(method(&b.build_method, ACC_PUBLIC as u32, Vec::new(), b.builds.clone()));
    methods.push(method("<init>", 0, Vec::new(), Type::Void));
    Members { fields: Vec::new(), methods }
}

/// Simple names of the builder classes `@Builder` declares in `t`, without resolving anything.
pub(crate) fn builder_names(stub: &JavaStub, t: &JavaType) -> Vec<String> {
    let mut out = Vec::new();
    let name_of = |a: &JavaAnnotation, base: &str| {
        str_arg(a, "builderClassName").filter(|s| !s.is_empty()).unwrap_or_else(|| format!("{base}Builder"))
    };
    if let Some(a) = find(stub, &t.annotation_args, "Builder") {
        out.push(name_of(a, &t.name));
    }
    for m in &t.members {
        let Some(a) = find(stub, &m.annotation_args, "Builder") else { continue };
        let base = match m.kind {
            JavaMemberKind::Method => {
                let ret = m.sig.ty.split('<').next().unwrap_or("");
                ix::simple(ret).to_owned()
            }
            _ => t.name.clone(),
        };
        out.push(name_of(a, &base));
    }
    out
}
