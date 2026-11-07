//! What each file contributes to the Spring model: its beans (stereotyped classes, `@Bean`
//! methods, provider beans) and injection points.

use super::super::Resolved as JResolved;
use super::annotations::*;
use super::providers::{ProviderCx, SpringBeanProvider};
use super::*;

/// An annotation of a declaration with its FQN resolved where it is written.
pub(super) struct Ann<'a> {
    pub fqn: String,
    pub ann: &'a JavaAnnotation,
}

pub(super) fn resolve_all<'a>(
    view: &JavaView,
    meta: &AnnotationMeta,
    file: u32,
    context: Option<TypeId>,
    list: &'a [JavaAnnotation],
) -> Vec<Ann<'a>> {
    list.iter().map(|ann| Ann { fqn: annotation_fqn(view, meta, file, context, &ann.name), ann }).collect()
}

fn find<'a, 'b>(anns: &'b [Ann<'a>], fqns: &[&str]) -> Option<&'b Ann<'a>> {
    anns.iter().find(|a| fqns.contains(&a.fqn.as_str()))
}

/// The sources' annotation types and the annotations on them.
pub(super) fn annotation_types(view: &JavaView, meta: &mut AnnotationMeta) {
    let mut found = Vec::new();
    for (file, stub) in files(view) {
        for (ti, t) in stub.types.iter().enumerate() {
            if t.kind != JavaTypeKind::Annotation {
                continue;
            }
            let id = TypeId { file, ty: ti as u32 };
            let fqn = stub.qualified_name(ti as u32);
            found.push((id, fqn, file, &t.annotation_args));
        }
    }
    // Names resolve against the built-in table and each other; one pass suffices (FQNs, not
    // meta relations, are resolved here).
    for (id, fqn, file, args) in found {
        let metas = resolve_all(view, meta, file, Some(id), args).into_iter().map(|a| a.fqn).collect();
        meta.add(fqn, metas);
    }
}

/// Spring's default bean name of a class: `OrderService` → `orderService`, `URLMapper` stays,
/// nested `Outer.Inner` → `outer.Inner` (`AnnotationBeanNameGenerator`, `Introspector.decapitalize`).
pub(super) fn default_bean_name(short: &str) -> String {
    let mut chars = short.chars();
    match (chars.next(), chars.next()) {
        (Some(a), Some(b)) if a.is_uppercase() && b.is_uppercase() => short.to_owned(),
        (Some(a), _) => a.to_lowercase().chain(short.chars().skip(1)).collect(),
        _ => String::new(),
    }
}

/// Simple names of `ty` and every supertype the index knows of.
pub(super) fn type_names(view: &JavaView, ty: &JResolved) -> Vec<String> {
    let mut out = Vec::new();
    match ty {
        JResolved::Source(id) => {
            if let Some(t) = view.ty(*id) {
                out.push(t.name.clone());
            }
            let mut seen = HashSet::from([*id]);
            let mut queue = vec![*id];
            while let Some(t) = queue.pop() {
                for s in view.supertypes(t) {
                    match s {
                        JResolved::Source(s) => {
                            if seen.insert(s) {
                                if let Some(st) = view.ty(s) {
                                    out.push(st.name.clone());
                                }
                                queue.push(s);
                            }
                        }
                        JResolved::External(e) => out.push(simple(&e).to_owned()),
                    }
                }
            }
        }
        JResolved::External(e) => out.push(simple(e).to_owned()),
    }
    out.sort();
    out.dedup();
    out
}

/// Qualifiers carried by a declaration: `@Qualifier("x")`, `@Named("x")` and custom qualifier
/// annotations (meta-annotated with `@Qualifier`).
fn qualifiers(meta: &AnnotationMeta, anns: &[Ann]) -> Vec<Qualifier> {
    anns.iter()
        .filter(|a| meta.is_any(&a.fqn, &[QUALIFIER, QUALIFIER_JSR330[0], QUALIFIER_JSR330[1]]))
        .map(|a| Qualifier {
            annotation: if a.fqn == QUALIFIER || NAMED.contains(&a.fqn.as_str()) {
                QUALIFIER.to_owned()
            } else {
                a.fqn.clone()
            },
            value: a.ann.arg("value").and_then(AnnotationValue::as_str).map(str::to_owned),
        })
        .collect()
}

/// Common bean attributes from a declaration's annotations.
struct Attrs {
    primary: bool,
    fallback: bool,
    priority: Option<i64>,
    lazy: bool,
    scope: Option<String>,
    profiles: Vec<String>,
    conditions: Vec<String>,
}

fn attrs(meta: &AnnotationMeta, anns: &[Ann]) -> Attrs {
    let scope = find(anns, &[SCOPE])
        .and_then(|a| a.ann.arg("value").or_else(|| a.ann.arg("scopeName")).and_then(AnnotationValue::as_str))
        .map(str::to_owned)
        .or_else(|| {
            anns.iter().find(|a| a.fqn != SCOPE && meta.is_meta_annotated(&a.fqn, SCOPE)).map(|a| {
                match simple(&a.fqn) {
                    "RequestScope" => "request",
                    "SessionScope" => "session",
                    "ApplicationScope" => "application",
                    other => other,
                }
                .to_owned()
            })
        });
    Attrs {
        primary: find(anns, &[PRIMARY]).is_some(),
        fallback: find(anns, &[FALLBACK]).is_some(),
        priority: find(anns, &PRIORITY).and_then(|a| match a.ann.arg("value") {
            Some(AnnotationValue::Num(n)) => n.parse().ok(),
            _ => None,
        }),
        lazy: find(anns, &[LAZY]).is_some_and(|a| bool_of(a.ann, "value", true)),
        scope,
        profiles: find(anns, &[PROFILE]).map(|a| strings_of(a.ann, &["value"])).unwrap_or_default(),
        conditions: anns
            .iter()
            .filter(|a| a.fqn != PROFILE && meta.is_meta_annotated(&a.fqn, CONDITIONAL))
            .map(|a| a.fqn.clone())
            .collect(),
    }
}

fn presence(model: &SpringModel, a: &Attrs) -> Presence {
    if !a.profiles.is_empty() {
        if model.active_profiles.is_empty() {
            return Presence::Conditional;
        }
        let exprs: Vec<&str> = a.profiles.iter().map(String::as_str).collect();
        match profile_matches(&exprs, &model.active_profiles) {
            Some(false) => return Presence::Inactive,
            None => return Presence::Conditional,
            Some(true) => {}
        }
    }
    if a.conditions.is_empty() { Presence::Certain } else { Presence::Conditional }
}

fn kind_of(meta: &AnnotationMeta, stereotype: &str) -> BeanKind {
    if meta.is_meta_annotated(stereotype, CONFIGURATION) {
        BeanKind::Configuration
    } else if meta.is_any(stereotype, &[CONTROLLER, CONTROLLER_ADVICE]) {
        BeanKind::Controller
    } else if meta.is_meta_annotated(stereotype, SERVICE) {
        BeanKind::Service
    } else if meta.is_meta_annotated(stereotype, REPOSITORY) {
        BeanKind::Repository
    } else {
        BeanKind::Component
    }
}

/// Containers whose element type is what is injected.
const COLLECTIONS: &[&str] = &["List", "Set", "Collection", "Iterable", "SortedSet", "NavigableSet", "Stream"];
const PROVIDERS: &[&str] = &["ObjectProvider", "Provider", "ObjectFactory"];

/// What a declared injection type looks for: `List<Order>` → (`Order`, many).
fn wanted_of(ty: &str, args: &[String]) -> (String, Vec<String>, Shape) {
    if let Some(element) = ty.strip_suffix("[]") {
        return (element.to_owned(), Vec::new(), Shape::Many);
    }
    let base = simple(ty);
    if COLLECTIONS.contains(&base) {
        return (args.first().cloned().unwrap_or_default(), Vec::new(), Shape::Many);
    }
    if base == "Map" {
        return (args.get(1).cloned().unwrap_or_default(), Vec::new(), Shape::Many);
    }
    if base == "Optional" {
        return (args.first().cloned().unwrap_or_default(), Vec::new(), Shape::Optional);
    }
    if PROVIDERS.contains(&base) {
        return (args.first().cloned().unwrap_or_default(), Vec::new(), Shape::Provider);
    }
    (ty.to_owned(), args.to_vec(), Shape::Single)
}

/// Types never looked up as beans by type (`@Value` targets, primitives).
fn injectable(ty: &str) -> bool {
    let base = simple(ty);
    !(ty.is_empty()
        || matches!(
            base,
            "String" | "Object" | "Integer" | "Long" | "Boolean" | "Double" | "Float" | "Short" | "Byte" | "Character"
        )
        || base.chars().next().is_some_and(char::is_lowercase))
}

#[allow(clippy::too_many_arguments)]
fn injection(
    view: &JavaView,
    meta: &AnnotationMeta,
    owner: TypeId,
    member: u32,
    param: Option<u32>,
    name: &str,
    kind: InjectionKind,
    ty: &str,
    ty_args: &[String],
    anns: &[Ann],
    required_default: bool,
) -> Option<InjectionPoint> {
    if find(anns, &[VALUE]).is_some() {
        return None;
    }
    let (wanted, args, shape) = wanted_of(ty, ty_args);
    if !injectable(&wanted) {
        return None;
    }
    let required = required_default
        && !matches!(shape, Shape::Optional | Shape::Provider)
        && !find(anns, &[AUTOWIRED]).is_some_and(|a| !bool_of(a.ann, "required", true))
        && !anns.iter().any(|a| simple(&a.fqn) == "Nullable");
    let by_name =
        find(anns, &RESOURCE).and_then(|a| a.ann.arg("name")).and_then(AnnotationValue::as_str).map(str::to_owned);
    Some(InjectionPoint {
        owner,
        member,
        param,
        name: name.to_owned(),
        kind,
        wanted: TypeRef { ty: view.resolve(owner, &wanted), args },
        shape,
        qualifiers: qualifiers(meta, anns),
        by_name,
        resource: find(anns, &RESOURCE).is_some(),
        required,
    })
}

/// The beans and injection points of one file.
pub(super) fn file(
    view: &JavaView,
    model: &mut SpringModel,
    providers: &[Box<dyn SpringBeanProvider>],
    file: u32,
    stub: &JavaStub,
) {
    let test = model.is_test_file(file);
    for (ti, t) in stub.types.iter().enumerate() {
        let owner = TypeId { file, ty: ti as u32 };
        if t.is(ANONYMOUS) || t.is(LOCAL) || t.kind == JavaTypeKind::Annotation {
            continue;
        }
        let anns = resolve_all(view, &model.meta, file, Some(owner), &t.annotation_args);
        let stereotype = anns
            .iter()
            .find(|a| model.meta.is_meta_annotated(&a.fqn, COMPONENT))
            .or_else(|| find(&anns, &NAMED))
            .map(|a| (a.fqn.clone(), a.ann));
        let concrete =
            matches!(t.kind, JavaTypeKind::Class | JavaTypeKind::Record | JavaTypeKind::Enum) && !t.is(ABSTRACT);
        let is_bean = stereotype.is_some() && concrete && (t.outer.is_none() || t.is(STATIC));
        if let (true, Some((stereo, ann))) = (is_bean, &stereotype) {
            let a = attrs(&model.meta, &anns);
            let ty = JResolved::Source(owner);
            let name = ann
                .arg("value")
                .and_then(AnnotationValue::as_str)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| default_bean_name(&stub.display_name(ti as u32)));
            model.beans.push(BeanDef {
                name,
                aliases: Vec::new(),
                type_names: type_names(view, &ty),
                ty: TypeRef { ty, args: Vec::new() },
                owner: Some(owner),
                method: None,
                origin: BeanOrigin::Scanned { stereotype: stereo.clone() },
                kind: kind_of(&model.meta, stereo),
                qualifiers: qualifiers(&model.meta, &anns),
                primary: a.primary,
                fallback: a.fallback,
                autowire_candidate: true,
                default_candidate: true,
                priority: a.priority,
                scope: a.scope.clone(),
                lazy: a.lazy,
                presence: presence(model, &a),
                profiles: a.profiles,
                conditions: a.conditions,
                test,
                supertypes: Vec::new(),
            });
        }
        let lombok_all = find(&anns, &[LOMBOK_ALL_ARGS]).is_some();
        let lombok_required = find(&anns, &[LOMBOK_REQUIRED_ARGS]).is_some();
        let constructors: Vec<usize> = t
            .members
            .iter()
            .enumerate()
            .filter(|(_, m)| m.kind == JavaMemberKind::Constructor)
            .map(|(i, _)| i)
            .collect();
        let lombok_constructor = is_bean && constructors.is_empty() && (lombok_all || lombok_required);
        for (mi, m) in t.members.iter().enumerate() {
            let member = mi as u32;
            let manns = resolve_all(view, &model.meta, file, Some(owner), &m.annotation_args);
            match m.kind {
                JavaMemberKind::Field if !m.is(STATIC) => {
                    let annotated = find(&manns, &[AUTOWIRED])
                        .or_else(|| find(&manns, &INJECT))
                        .or_else(|| find(&manns, &RESOURCE))
                        .is_some();
                    let by_constructor = lombok_constructor && (lombok_all || m.is(FINAL));
                    if !(annotated || by_constructor) {
                        continue;
                    }
                    let kind = if annotated { InjectionKind::Field } else { InjectionKind::Constructor };
                    model.injections.extend(injection(
                        view,
                        &model.meta,
                        owner,
                        member,
                        None,
                        &m.name,
                        kind,
                        &m.ty,
                        &m.ty_args,
                        &manns,
                        true,
                    ));
                }
                JavaMemberKind::Method | JavaMemberKind::Constructor => {
                    let bean_ann = (m.kind == JavaMemberKind::Method).then(|| find(&manns, &[BEAN])).flatten();
                    if let Some(bean_ann) = bean_ann
                        && m.ty != "void"
                        && !m.ty.is_empty()
                    {
                        let a = attrs(&model.meta, &manns);
                        let mut names = strings_of(bean_ann.ann, &["name", "value"]);
                        if names.is_empty() {
                            names.push(m.name.clone());
                        }
                        let ty = view.resolve(owner, &m.ty);
                        model.beans.push(BeanDef {
                            name: names.remove(0),
                            aliases: names,
                            type_names: type_names(view, &ty),
                            ty: TypeRef { ty, args: m.ty_args.clone() },
                            owner: Some(owner),
                            method: Some(member),
                            origin: BeanOrigin::Factory { is_static: m.is(STATIC) },
                            kind: BeanKind::Factory,
                            qualifiers: qualifiers(&model.meta, &manns),
                            primary: a.primary,
                            fallback: a.fallback,
                            autowire_candidate: bool_of(bean_ann.ann, "autowireCandidate", true),
                            default_candidate: bool_of(bean_ann.ann, "defaultCandidate", true),
                            priority: a.priority,
                            scope: a.scope.clone(),
                            lazy: a.lazy,
                            presence: presence(model, &a),
                            profiles: a.profiles,
                            conditions: a.conditions,
                            test,
                            supertypes: Vec::new(),
                        });
                    }
                    let autowired = find(&manns, &[AUTOWIRED]).or_else(|| find(&manns, &INJECT)).is_some();
                    let constructor =
                        m.kind == JavaMemberKind::Constructor && is_bean && (constructors.len() == 1 || autowired);
                    let kind = if bean_ann.is_some() {
                        InjectionKind::BeanMethodParam
                    } else if constructor {
                        InjectionKind::Constructor
                    } else if autowired {
                        InjectionKind::Setter
                    } else {
                        continue;
                    };
                    let required = !find(&manns, &[AUTOWIRED]).is_some_and(|a| !bool_of(a.ann, "required", true));
                    for (pi, p) in m.param_details.iter().enumerate() {
                        let panns = resolve_all(view, &model.meta, file, Some(owner), &p.annotation_args);
                        model.injections.extend(injection(
                            view,
                            &model.meta,
                            owner,
                            member,
                            Some(pi as u32),
                            &p.name,
                            kind,
                            &p.ty,
                            &p.ty_args,
                            &panns,
                            required,
                        ));
                    }
                }
                _ => {}
            }
        }
    }
    let cx = ProviderCx { view, meta: &model.meta, test };
    let mut provided = Vec::new();
    for p in providers {
        provided.extend(p.file_beans(&cx, file, stub));
    }
    model.beans.extend(provided);
}

/// Beans every application context has, registered by the framework itself. Their type names
/// include the types Spring resolves to them (`resolvableDependencies`).
pub(super) fn framework_beans(model: &mut SpringModel) {
    const FRAMEWORK: &[(&str, &str, &[&str])] = &[
        (
            "beanFactory",
            "org.springframework.beans.factory.support.DefaultListableBeanFactory",
            &[
                "BeanFactory",
                "ListableBeanFactory",
                "HierarchicalBeanFactory",
                "ConfigurableBeanFactory",
                "ConfigurableListableBeanFactory",
                "AutowireCapableBeanFactory",
                "DefaultListableBeanFactory",
                "BeanDefinitionRegistry",
            ],
        ),
        (
            "applicationContext",
            "org.springframework.context.ApplicationContext",
            &[
                "ApplicationContext",
                "ConfigurableApplicationContext",
                "WebApplicationContext",
                "ReactiveWebApplicationContext",
                "ResourceLoader",
                "ResourcePatternResolver",
                "ApplicationEventPublisher",
            ],
        ),
        (
            "environment",
            "org.springframework.core.env.Environment",
            &["Environment", "ConfigurableEnvironment", "StandardEnvironment", "PropertyResolver"],
        ),
        ("messageSource", "org.springframework.context.MessageSource", &["MessageSource", "HierarchicalMessageSource"]),
        (
            "applicationEventMulticaster",
            "org.springframework.context.event.ApplicationEventMulticaster",
            &["ApplicationEventMulticaster"],
        ),
    ];
    for (name, fqn, names) in FRAMEWORK {
        model.beans.push(BeanDef {
            name: (*name).to_owned(),
            aliases: Vec::new(),
            ty: TypeRef { ty: JResolved::External((*fqn).to_owned()), args: Vec::new() },
            owner: None,
            method: None,
            origin: BeanOrigin::Framework,
            kind: BeanKind::Framework,
            qualifiers: Vec::new(),
            primary: false,
            fallback: false,
            autowire_candidate: true,
            default_candidate: true,
            priority: None,
            scope: None,
            lazy: false,
            profiles: Vec::new(),
            conditions: Vec::new(),
            presence: Presence::Certain,
            test: false,
            type_names: names.iter().map(|s| (*s).to_owned()).collect(),
            supertypes: Vec::new(),
        });
    }
}
