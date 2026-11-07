//! Spring beans and their injection points, from the structure index: which beans an
//! `@Autowired` field, a bean's constructor parameter or a `@Bean` method parameter receives,
//! and where a bean is injected. (IDEA Ultimate's Spring gutter navigation; not in Community.)
//!
//! Beans are classes with a stereotype annotation (`@Component`, `@Service`, …, and annotations
//! of the sources meta-annotated with one), `@Bean` methods, and interfaces Spring Data,
//! MyBatis or OpenFeign implement. Injection follows Spring's rules as far as declarations
//! tell: by type (subtypes included), the element type of collections, `Optional` and
//! providers, narrowed by `@Qualifier` / `@Named` / `@Resource(name)`, then by `@Primary`,
//! then by the field or parameter name. Beans of libraries (auto-configuration) are not
//! known: an injection point without a source bean gets no marker.

use super::*;
use ide_core::{IpcPath, Location, Range};
use std::path::Path;

const STEREOTYPES: &[&str] = &[
    "Component",
    "Service",
    "Repository",
    "Controller",
    "RestController",
    "Configuration",
    "SpringBootApplication",
    "ControllerAdvice",
    "RestControllerAdvice",
    "Mapper",
    "FeignClient",
];
const INJECT: &[&str] = &["Autowired", "Inject", "Resource"];
/// Supertypes (simple names) that make an interface a bean Spring implements.
const IMPLEMENTED_INTERFACES: &[&str] = &[
    "Repository",
    "CrudRepository",
    "ListCrudRepository",
    "PagingAndSortingRepository",
    "ListPagingAndSortingRepository",
    "JpaRepository",
    "MongoRepository",
    "ReactiveCrudRepository",
    "ReactiveMongoRepository",
    "R2dbcRepository",
    "ElasticsearchRepository",
    "JpaSpecificationExecutor",
    "BaseMapper",
];
const COLLECTIONS: &[&str] = &["List", "Set", "Collection", "Iterable", "SortedSet", "Stream"];
const WRAPPERS: &[&str] = &["Optional", "ObjectProvider", "Provider", "ObjectFactory", "Lazy"];

/// A bean: a class (or interface) of the sources, or a `@Bean` method.
#[derive(Clone, Debug)]
struct Bean {
    owner: TypeId,
    /// The `@Bean` method, for a factory method bean.
    method: Option<u32>,
    name: String,
    qualifiers: Vec<String>,
    primary: bool,
    /// Its type: the class, or the method's return type.
    ty: Resolved,
}

/// A place a bean is injected into.
#[derive(Clone, Debug)]
struct Injection {
    owner: TypeId,
    member: u32,
    param: Option<u32>,
    /// The field or parameter name (a tie-breaker) and its position.
    name: String,
    at: Pos,
    /// The bean type looked for (the element type of a collection).
    ty: String,
    many: bool,
    qualifier: Option<String>,
}

fn value_of<'a>(values: &'a [(String, String)], names: &[&str]) -> Option<&'a str> {
    values.iter().find(|(a, _)| names.contains(&a.as_str())).map(|(_, v)| v.as_str())
}

/// Spring's default bean name: `OrderService` → `orderService`, `URLMapper` stays.
fn bean_name(class: &str) -> String {
    let mut chars = class.chars();
    match (chars.next(), chars.next()) {
        (Some(a), Some(b)) if a.is_uppercase() && b.is_uppercase() => class.to_owned(),
        (Some(a), _) => a.to_lowercase().chain(class.chars().skip(1)).collect(),
        _ => String::new(),
    }
}

/// What a declared injection type looks for: `List<Order>` → (`Order`, many).
fn injected_type(ty: &str, args: &[String]) -> (String, bool) {
    let base = simple(ty);
    if let Some(element) = ty.strip_suffix("[]") {
        return (element.to_owned(), true);
    }
    if COLLECTIONS.contains(&base) {
        return (args.first().cloned().unwrap_or_default(), true);
    }
    if base == "Map" {
        return (args.get(1).cloned().unwrap_or_default(), true);
    }
    if WRAPPERS.contains(&base) {
        let inner = args.first().cloned().unwrap_or_default();
        // `ObjectProvider<List<Order>>` is not unwrapped further: rare.
        return (inner, false);
    }
    (ty.to_owned(), false)
}

/// The project's beans and injection points, gathered in one pass over the stubs.
pub struct SpringModel {
    beans: Vec<Bean>,
    injections: Vec<Injection>,
    /// Per file, its build module (the nearest folder with a build file): an application
    /// context holds its own module's beans, so these are preferred.
    modules: HashMap<u32, Option<std::path::PathBuf>>,
}

const BUILD_FILES: &[&str] = &["pom.xml", "build.gradle", "build.gradle.kts"];

/// Folders with a build file, from the indexed files.
fn module_dirs(view: &JavaView) -> HashSet<std::path::PathBuf> {
    view.data
        .files
        .iter()
        .flatten()
        .filter(|e| BUILD_FILES.contains(&e.name()))
        .filter_map(|e| e.path.parent().map(Path::to_path_buf))
        .collect()
}

/// Every file of the view (the edited one from its text).
fn files<'a>(view: &'a JavaView<'a>) -> impl Iterator<Item = (u32, &'a JavaStub)> + 'a {
    let indexed = (0..view.data.files.len() as u32).filter_map(move |f| Some((f, view.stub(f)?)));
    let extra = view.overlay.as_ref().filter(|o| o.file.is_none()).map(|o| (u32::MAX, o.stub));
    indexed.chain(extra)
}

impl SpringModel {
    pub fn new(view: &JavaView, path: &Path) -> Self {
        // Stereotypes: Spring's, and annotation types of the sources annotated with one.
        let mut stereotypes: HashSet<String> = STEREOTYPES.iter().map(|s| (*s).to_owned()).collect();
        let annotation_types: Vec<(String, Vec<String>)> = files(view)
            .flat_map(|(_, s)| s.types.iter())
            .filter(|t| t.kind == JavaTypeKind::Annotation)
            .map(|t| (t.name.clone(), t.annotations.clone()))
            .collect();
        loop {
            let before = stereotypes.len();
            for (name, annotations) in &annotation_types {
                if annotations.iter().any(|a| stereotypes.contains(a)) {
                    stereotypes.insert(name.clone());
                }
            }
            if stereotypes.len() == before {
                break;
            }
        }
        let mut beans = Vec::new();
        let mut injections = Vec::new();
        for (file, stub) in files(view) {
            for (ti, t) in stub.types.iter().enumerate() {
                let owner = TypeId { file, ty: ti as u32 };
                if t.is(ANONYMOUS) || t.is(LOCAL) || t.kind == JavaTypeKind::Annotation {
                    continue;
                }
                let stereotype = t.annotations.iter().find(|a| stereotypes.contains(*a));
                let implemented = t.kind == JavaTypeKind::Interface
                    && t.supers.iter().any(|s| IMPLEMENTED_INTERFACES.contains(&simple(s)));
                // Spring instantiates concrete classes; interfaces only when it implements them.
                let is_bean = implemented
                    || match stereotype {
                        Some(s) if t.kind == JavaTypeKind::Interface => s == "Mapper" || s == "FeignClient",
                        Some(_) => !t.is(ABSTRACT),
                        None => false,
                    };
                if is_bean {
                    let named = stereotype
                        .and_then(|s| value_of(&t.values, &[s.as_str()]))
                        .filter(|_| stereotype.is_some_and(|s| s != "FeignClient" && s != "Mapper"));
                    beans.push(Bean {
                        owner,
                        method: None,
                        name: named.map(str::to_owned).unwrap_or_else(|| bean_name(&t.name)),
                        qualifiers: value_of(&t.values, &["Qualifier", "Named"])
                            .map(str::to_owned)
                            .into_iter()
                            .collect(),
                        primary: t.annotations.iter().any(|a| a == "Primary"),
                        ty: Resolved::Source(owner),
                    });
                }
                let constructors: Vec<(usize, &JavaMember)> =
                    t.members.iter().enumerate().filter(|(_, m)| m.kind == JavaMemberKind::Constructor).collect();
                let lombok_all = t.annotations.iter().any(|a| a == "AllArgsConstructor");
                let lombok_required = t.annotations.iter().any(|a| a == "RequiredArgsConstructor");
                for (mi, m) in t.members.iter().enumerate() {
                    let member = mi as u32;
                    match m.kind {
                        JavaMemberKind::Field if !m.is(STATIC) => {
                            let annotated = m.annotations.iter().any(|a| INJECT.contains(&a.as_str()));
                            let by_constructor =
                                is_bean && constructors.is_empty() && (lombok_all || (lombok_required && m.is(FINAL)));
                            if annotated || by_constructor {
                                let (ty, many) = injected_type(&m.ty, &m.ty_args);
                                injections.push(Injection {
                                    owner,
                                    member,
                                    param: None,
                                    name: m.name.clone(),
                                    at: m.at,
                                    ty,
                                    many,
                                    qualifier: value_of(&m.values, &["Qualifier", "Named", "Resource"])
                                        .map(str::to_owned),
                                });
                            }
                        }
                        JavaMemberKind::Method | JavaMemberKind::Constructor => {
                            let factory = m.kind == JavaMemberKind::Method && m.annotations.iter().any(|a| a == "Bean");
                            if factory {
                                beans.push(Bean {
                                    owner,
                                    method: Some(member),
                                    name: value_of(&m.values, &["Bean"])
                                        .map(str::to_owned)
                                        .unwrap_or_else(|| m.name.clone()),
                                    qualifiers: value_of(&m.values, &["Qualifier", "Named"])
                                        .map(str::to_owned)
                                        .into_iter()
                                        .collect(),
                                    primary: m.annotations.iter().any(|a| a == "Primary"),
                                    ty: view.resolve(owner, &m.ty),
                                });
                            }
                            let autowired = m.annotations.iter().any(|a| a == "Autowired" || a == "Inject");
                            let constructor = m.kind == JavaMemberKind::Constructor
                                && is_bean
                                && (constructors.len() == 1 || autowired);
                            if factory || autowired || constructor {
                                for (pi, p) in m.param_details.iter().enumerate() {
                                    if p.annotations.iter().any(|a| a == "Value") {
                                        continue;
                                    }
                                    let (ty, many) = injected_type(&p.ty, &p.ty_args);
                                    injections.push(Injection {
                                        owner,
                                        member,
                                        param: Some(pi as u32),
                                        name: p.name.clone(),
                                        at: p.at,
                                        ty,
                                        many,
                                        qualifier: value_of(&p.values, &["Qualifier", "Named"]).map(str::to_owned),
                                    });
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        let dirs = module_dirs(view);
        let mut modules = HashMap::new();
        for file in beans.iter().map(|b| b.owner.file).chain(injections.iter().map(|i| i.owner.file)) {
            modules.entry(file).or_insert_with(|| {
                let p = if Some(file) == view.overlay_file() { Some(path) } else { view.path(file) };
                p.and_then(|p| p.ancestors().skip(1).find(|d| dirs.contains(*d)).map(Path::to_path_buf))
            });
        }
        Self { beans, injections, modules }
    }

    /// The beans `i` receives.
    fn candidates<'m>(&'m self, view: &JavaView, i: &Injection, supers: &mut Supers) -> Vec<&'m Bean> {
        if i.ty.is_empty()
            || matches!(simple(&i.ty), "String" | "Object")
            || simple(&i.ty).chars().next().is_some_and(char::is_lowercase)
        {
            return Vec::new();
        }
        let wanted = view.resolve(i.owner, &i.ty);
        let mut found: Vec<&Bean> = self.beans.iter().filter(|b| supers.assignable(view, &b.ty, &wanted)).collect();
        // Beans of the injection point's own module, when it has some (else a module it uses).
        let module = self.modules.get(&i.owner.file).cloned().flatten();
        if module.is_some() && found.iter().any(|b| self.modules.get(&b.owner.file).cloned().flatten() == module) {
            found.retain(|b| self.modules.get(&b.owner.file).cloned().flatten() == module);
        }
        if let Some(q) = &i.qualifier {
            found.retain(|b| &b.name == q || b.qualifiers.contains(q));
        }
        if !i.many && found.len() > 1 {
            if found.iter().any(|b| b.primary) {
                found.retain(|b| b.primary);
            } else if found.iter().any(|b| b.name == i.name) {
                found.retain(|b| b.name == i.name);
            }
        }
        found
    }
}

/// Supertypes of bean types, computed once per query.
#[derive(Default)]
struct Supers(HashMap<TypeId, (Vec<TypeId>, Vec<String>)>);

impl Supers {
    /// Whether a bean of type `bean` can be injected where `wanted` is.
    fn assignable(&mut self, view: &JavaView, bean: &Resolved, wanted: &Resolved) -> bool {
        match (bean, wanted) {
            (Resolved::Source(b), Resolved::Source(w)) => b == w || self.of(view, *b).0.contains(w),
            (Resolved::Source(b), Resolved::External(w)) => self.of(view, *b).1.iter().any(|s| same_external(s, w)),
            (Resolved::External(b), Resolved::External(w)) => same_external(b, w),
            (Resolved::External(_), Resolved::Source(_)) => false,
        }
    }

    fn of(&mut self, view: &JavaView, id: TypeId) -> &(Vec<TypeId>, Vec<String>) {
        self.0.entry(id).or_insert_with(|| {
            let mut seen = HashSet::from([id]);
            let mut queue = vec![id];
            let (mut sources, mut external) = (Vec::new(), Vec::new());
            while let Some(t) = queue.pop() {
                for s in view.supertypes(t) {
                    match s {
                        Resolved::Source(s) if seen.insert(s) => {
                            sources.push(s);
                            queue.push(s);
                        }
                        Resolved::External(e) => external.push(e),
                        Resolved::Source(_) => {}
                    }
                }
            }
            (sources, external)
        })
    }
}

/// Two names of a type outside the sources: equal, or one is only a guess (`java.lang.X`, a
/// simple name) with the same simple name.
fn same_external(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let guess = |s: &str| !s.contains('.') || s.starts_with("java.lang.");
    simple(a) == simple(b) && (guess(a) || guess(b))
}

fn bean_target(view: &JavaView, path: &Path, b: &Bean) -> Option<JavaMarkerTarget> {
    let stub = view.stub(b.owner.file)?;
    let t = stub.types.get(b.owner.ty as usize)?;
    let (at, name, owner) = match b.method.and_then(|m| t.members.get(m as usize)) {
        Some(m) => (m.at, m.name.as_str(), format!("{}.{}()", stub.display_name(b.owner.ty), m.name)),
        None => (t.at, t.name.as_str(), stub.display_name(b.owner.ty)),
    };
    let file =
        if Some(b.owner.file) == view.overlay_file() { path.to_owned() } else { view.path(b.owner.file)?.to_owned() };
    let end = Pos::new(at.line, at.col + name.encode_utf16().count() as u32);
    Some(JavaMarkerTarget {
        location: Location { path: IpcPath::from(file), range: Range::new(at, end), uri: None },
        owner,
        abstract_: false,
    })
}

fn injection_target(view: &JavaView, path: &Path, i: &Injection) -> Option<JavaMarkerTarget> {
    let stub = view.stub(i.owner.file)?;
    let t = stub.types.get(i.owner.ty as usize)?;
    let m = t.members.get(i.member as usize)?;
    let owner = match (i.param, m.kind) {
        (None, _) => format!("{}.{}", stub.display_name(i.owner.ty), m.name),
        (Some(_), JavaMemberKind::Constructor) => format!("{}({})", stub.display_name(i.owner.ty), i.name),
        (Some(_), _) => format!("{}.{}({})", stub.display_name(i.owner.ty), m.name, i.name),
    };
    let file =
        if Some(i.owner.file) == view.overlay_file() { path.to_owned() } else { view.path(i.owner.file)?.to_owned() };
    let end = Pos::new(i.at.line, i.at.col + i.name.encode_utf16().count() as u32);
    Some(JavaMarkerTarget {
        location: Location { path: IpcPath::from(file), range: Range::new(i.at, end), uri: None },
        owner,
        abstract_: false,
    })
}

/// Spring markers of the edited file: on injection points, the beans they receive; on beans,
/// where they are injected (beans injected nowhere get none).
pub fn spring_markers(view: &JavaView, path: &Path) -> Vec<JavaMarker> {
    let Some(file) = view.overlay_file() else { return Vec::new() };
    let Some(stub) = view.stub(file) else { return Vec::new() };
    // Only files that may take part: Spring annotations, or Lombok constructors of beans.
    let relevant = stub.types.iter().any(|t| {
        !t.annotations.is_empty()
            || t.members.iter().any(|m| !m.annotations.is_empty() || m.kind == JavaMemberKind::Constructor)
            || t.supers.iter().any(|s| IMPLEMENTED_INTERFACES.contains(&simple(s)))
    });
    if !relevant {
        return Vec::new();
    }
    let model = SpringModel::new(view, path);
    let mut supers = Supers::default();
    let mut out: Vec<JavaMarker> = Vec::new();
    // Injection points here → their beans (one marker per line).
    for i in model.injections.iter().filter(|i| i.owner.file == file) {
        let targets: Vec<JavaMarkerTarget> =
            model.candidates(view, i, &mut supers).into_iter().filter_map(|b| bean_target(view, path, b)).collect();
        if targets.is_empty() {
            continue;
        }
        match out.iter_mut().find(|m| m.line == i.at.line && m.kind == JavaMarkerKind::Injection) {
            Some(m) => {
                for t in targets {
                    if !m.targets.iter().any(|x| x.location == t.location) {
                        m.targets.push(t);
                    }
                }
            }
            None => out.push(JavaMarker {
                line: i.at.line,
                col: i.at.col,
                name: i.name.clone(),
                method: false,
                kind: JavaMarkerKind::Injection,
                targets,
            }),
        }
    }
    // Beans here → where they are injected.
    for b in model.beans.iter().filter(|b| b.owner.file == file) {
        let names: HashSet<String> = {
            let mut n = HashSet::new();
            let base = match &b.ty {
                Resolved::Source(id) => {
                    let (s, e) = supers.of(view, *id).clone();
                    n.extend(s.iter().filter_map(|s| view.ty(*s)).map(|t| t.name.clone()));
                    n.extend(e.iter().map(|e| simple(e).to_owned()));
                    view.ty(*id).map(|t| t.name.clone())
                }
                Resolved::External(e) => Some(simple(e).to_owned()),
            };
            n.extend(base);
            n
        };
        let targets: Vec<JavaMarkerTarget> = model
            .injections
            .iter()
            .filter(|i| names.contains(simple(&i.ty)))
            .filter(|i| {
                model.candidates(view, i, &mut supers).iter().any(|c| c.owner == b.owner && c.method == b.method)
            })
            .filter_map(|i| injection_target(view, path, i))
            .collect();
        if targets.is_empty() {
            continue;
        }
        let Some(t) = view.ty(b.owner) else { continue };
        let (at, name) = match b.method.and_then(|m| t.members.get(m as usize)) {
            Some(m) => (m.at, m.name.clone()),
            None => (t.at, t.name.clone()),
        };
        out.push(JavaMarker {
            line: at.line,
            col: at.col,
            name,
            method: b.method.is_some(),
            kind: JavaMarkerKind::Bean,
            targets,
        });
    }
    out
}
