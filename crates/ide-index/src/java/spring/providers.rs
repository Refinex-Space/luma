//! Beans other frameworks register for interfaces (IDEA's `customLocalComponentsDiscoverer`):
//! Spring Data repositories, MyBatis mappers and OpenFeign clients. Other Spring plugins add
//! their own by implementing [`SpringBeanProvider`].

use super::super::Resolved as JResolved;
use super::annotations::*;
use super::collect::{default_bean_name, resolve_all, type_names};
use super::*;

/// What a provider sees of the project while the model is built.
pub struct ProviderCx<'a> {
    pub view: &'a JavaView<'a>,
    pub meta: &'a AnnotationMeta,
    /// The file is test code.
    pub test: bool,
}

pub trait SpringBeanProvider: Send + Sync {
    /// Stable id: `spring-data`, `mybatis`, `openfeign`.
    fn id(&self) -> &'static str;
    /// The beans this provider registers for the types of one file.
    fn file_beans(&self, cx: &ProviderCx, file: u32, stub: &JavaStub) -> Vec<BeanDef>;
}

/// The providers shipped with the Spring model.
pub(super) fn builtin() -> Vec<Box<dyn SpringBeanProvider>> {
    vec![Box::new(SpringData), Box::new(MyBatis), Box::new(OpenFeign)]
}

fn provided(cx: &ProviderCx, provider: &'static str, owner: TypeId, name: String, kind: BeanKind) -> BeanDef {
    let ty = JResolved::Source(owner);
    BeanDef {
        name,
        aliases: Vec::new(),
        type_names: type_names(cx.view, &ty),
        ty: TypeRef { ty, args: Vec::new() },
        owner: Some(owner),
        method: None,
        origin: BeanOrigin::Provided { provider },
        kind,
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
        test: cx.test,
        supertypes: Vec::new(),
    }
}

/// Every supertype of `id` outside the sources, as (qualified as known) names.
fn external_supers(view: &JavaView, id: TypeId) -> Vec<String> {
    let mut seen = HashSet::from([id]);
    let mut queue = vec![id];
    let mut out = Vec::new();
    while let Some(t) = queue.pop() {
        for s in view.supertypes(t) {
            match s {
                JResolved::Source(s) if seen.insert(s) => queue.push(s),
                JResolved::External(e) => out.push(e),
                JResolved::Source(_) => {}
            }
        }
    }
    out
}

/// Spring Data's repository interfaces.
const REPOSITORIES: &[&str] = &[
    "Repository",
    "CrudRepository",
    "ListCrudRepository",
    "PagingAndSortingRepository",
    "ListPagingAndSortingRepository",
    "JpaRepository",
    "JpaSpecificationExecutor",
    "QuerydslPredicateExecutor",
    "MongoRepository",
    "ReactiveCrudRepository",
    "ReactiveSortingRepository",
    "ReactiveMongoRepository",
    "R2dbcRepository",
    "ElasticsearchRepository",
    "CassandraRepository",
    "Neo4jRepository",
    "KeyValueRepository",
    "RedisRepository",
    "CouchbaseRepository",
];

/// An external name that can be the Spring Data type `name`: qualified in Spring Data's
/// packages, or a guess the resolver made (unimported, on-demand import).
fn spring_data_type(e: &str) -> bool {
    let guess = !e.contains('.') || e.starts_with("java.lang.");
    REPOSITORIES.contains(&simple(e)) && (guess || e.starts_with("org.springframework.data."))
}

struct SpringData;

impl SpringBeanProvider for SpringData {
    fn id(&self) -> &'static str {
        "spring-data"
    }

    fn file_beans(&self, cx: &ProviderCx, file: u32, stub: &JavaStub) -> Vec<BeanDef> {
        let mut out = Vec::new();
        for (ti, t) in stub.types.iter().enumerate() {
            if t.kind != JavaTypeKind::Interface || t.is(LOCAL) {
                continue;
            }
            let owner = TypeId { file, ty: ti as u32 };
            let anns = resolve_all(cx.view, cx.meta, file, Some(owner), &t.annotation_args);
            if anns.iter().any(|a| a.fqn == NO_REPOSITORY_BEAN) {
                continue;
            }
            let defined = anns.iter().any(|a| a.fqn == REPOSITORY_DEFINITION);
            if defined || external_supers(cx.view, owner).iter().any(|e| spring_data_type(e)) {
                let name = default_bean_name(&t.name);
                out.push(provided(cx, "spring-data", owner, name, BeanKind::Repository));
            }
        }
        out
    }
}

struct MyBatis;

impl SpringBeanProvider for MyBatis {
    fn id(&self) -> &'static str {
        "mybatis"
    }

    fn file_beans(&self, cx: &ProviderCx, file: u32, stub: &JavaStub) -> Vec<BeanDef> {
        let mut out = Vec::new();
        for (ti, t) in stub.types.iter().enumerate() {
            if t.kind != JavaTypeKind::Interface || t.is(LOCAL) {
                continue;
            }
            let owner = TypeId { file, ty: ti as u32 };
            let anns = resolve_all(cx.view, cx.meta, file, Some(owner), &t.annotation_args);
            let mapper =
                anns.iter().any(|a| a.fqn == MAPPER || simple(&a.fqn) == "Mapper" && !a.fqn.contains("mapstruct"));
            // MyBatis-Plus mappers extend `BaseMapper<T>`.
            let plus = external_supers(cx.view, owner).iter().any(|e| simple(e) == "BaseMapper");
            if mapper || plus {
                out.push(provided(cx, "mybatis", owner, default_bean_name(&t.name), BeanKind::Repository));
            }
        }
        out
    }
}

struct OpenFeign;

impl SpringBeanProvider for OpenFeign {
    fn id(&self) -> &'static str {
        "openfeign"
    }

    fn file_beans(&self, cx: &ProviderCx, file: u32, stub: &JavaStub) -> Vec<BeanDef> {
        let mut out = Vec::new();
        for (ti, t) in stub.types.iter().enumerate() {
            if t.kind != JavaTypeKind::Interface || t.is(LOCAL) {
                continue;
            }
            let owner = TypeId { file, ty: ti as u32 };
            let anns = resolve_all(cx.view, cx.meta, file, Some(owner), &t.annotation_args);
            let Some(feign) = anns.iter().find(|a| a.fqn == FEIGN_CLIENT) else { continue };
            // `FeignClientsRegistrar`: named by the interface, aliased `<contextId | name>FeignClient`,
            // primary unless `primary = false`, qualified by `qualifiers`.
            let id = ["contextId", "name", "value"]
                .iter()
                .find_map(|k| feign.ann.arg(k).and_then(AnnotationValue::as_str).filter(|s| !s.is_empty()));
            let mut bean = provided(cx, "openfeign", owner, stub.qualified_name(ti as u32), BeanKind::Provided);
            bean.aliases.extend(id.map(|id| format!("{id}FeignClient")));
            bean.primary = bool_of(feign.ann, "primary", true);
            bean.qualifiers = strings_of(feign.ann, &["qualifiers"])
                .into_iter()
                .map(|q| Qualifier { annotation: QUALIFIER.to_owned(), value: Some(q) })
                .collect();
            out.push(bean);
        }
        out
    }
}
