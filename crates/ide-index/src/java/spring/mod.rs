//! The Spring model (IDEA Ultimate's Spring plugin, `com.intellij.spring`): which classes and
//! `@Bean` methods are beans, which application contexts they belong to, where beans are
//! injected and which beans an injection point receives, under Spring's own rules.
//!
//! Built from the structure index, so it answers before (and without) the language server:
//! - beans: classes carrying a stereotype (directly or through annotation types of the sources),
//!   `@Bean` methods, configuration classes registered with `@Import`, the framework's own
//!   beans (`ApplicationContext`, `Environment`, …) and beans contributed by
//!   [`SpringBeanProvider`]s (Spring Data repositories, MyBatis mappers, Feign clients);
//! - contexts: Boot applications and `@ComponentScan` configurations with their scanned
//!   packages and `@Import` closure; files outside any fall back to their build module;
//! - injection: by type (generic arguments compared), the element type of collections, `Map`,
//!   `Optional` and providers; narrowed by `@Qualifier` / `@Named` / `@Resource(name)` and custom
//!   qualifier annotations; then `@Primary`, `@Fallback`, `@Priority` and the parameter name
//!   (`DefaultListableBeanFactory.determineAutowireCandidate`).
//!
//! Library beans (auto-configuration) are not known to this model yet: a context that may
//! have some reports `unknown_sources`, so a missing candidate is never claimed.

pub mod annotations;
mod collect;
mod contexts;
mod explore;
mod features;
mod inspect;
pub mod library;
mod markers;
mod matching;
pub mod providers;

use super::*;
pub use annotations::AnnotationMeta;
pub use explore::{
    SpringBeanDetail, SpringBeanInfo, SpringBeanSource, SpringContextInfo, SpringDependency, SpringDependent,
    SpringEdge, SpringEdgeKind, SpringGraph, bean_id,
};
pub use features::{CacheOp, EventPublisher, Listener};
pub use inspect::{SpringEdit, SpringFix, SpringInspection, SpringProblem, SpringProblemSeverity, spring_problems};
pub use library::LibraryModel;
pub use markers::{
    SpringCandidates, SpringMarker, SpringMarkerKind, SpringMarkers, SpringPresence, SpringResolution, SpringTarget,
    candidates_at, spring_markers,
};
pub use providers::SpringBeanProvider;

use std::path::{Path, PathBuf};

/// A type as declared: resolved, with its type arguments as written (erased).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TypeRef {
    pub ty: Resolved,
    pub args: Vec<String>,
}

/// How a bean comes about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BeanOrigin {
    /// A class with a stereotype (`fqn`), found by component scanning.
    Scanned { stereotype: String },
    /// A `@Bean` method.
    Factory { is_static: bool },
    /// A configuration class registered with `@Import`.
    Imported,
    /// Contributed by a [`SpringBeanProvider`].
    Provided { provider: &'static str },
    /// One every application context has (`ApplicationContext`, `Environment`, …).
    Framework,
    /// Registered by a library's auto-configuration (see [`library`]).
    Library {
        /// JDT handle of the `@Bean` method (or of the properties class), to open it.
        handle: String,
        /// `DataSourceConfiguration.Hikari.dataSource()`-like label.
        configuration: String,
        /// The jar registering the auto-configuration.
        jar: String,
    },
}

/// Grouping and icon of a bean (IDEA's bean stereotypes).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum BeanKind {
    Configuration,
    Controller,
    Service,
    Repository,
    Component,
    /// A `@Bean` method.
    Factory,
    /// A Spring Data repository, MyBatis mapper, Feign client….
    Provided,
    Framework,
    /// From a library's auto-configuration.
    Library,
}

/// Whether a bean exists in the running application, as far as declarations tell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Presence {
    Certain,
    /// Depends on a condition or profile not evaluated statically.
    Conditional,
    /// Its `@Profile` is not among the active profiles (Settings › Spring).
    Inactive,
}

/// A qualifier a bean carries or an injection point asks for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Qualifier {
    /// `org.springframework.beans.factory.annotation.Qualifier`, `jakarta.inject.Named` or a custom
    /// annotation meta-annotated with one.
    pub annotation: String,
    pub value: Option<String>,
}

#[derive(Clone, Debug)]
pub struct BeanDef {
    pub name: String,
    pub aliases: Vec<String>,
    pub ty: TypeRef,
    /// The class (for a `@Bean`, the class declaring the method).
    pub owner: Option<TypeId>,
    /// The `@Bean` method (index in the owner's members).
    pub method: Option<u32>,
    pub origin: BeanOrigin,
    pub kind: BeanKind,
    pub qualifiers: Vec<Qualifier>,
    pub primary: bool,
    pub fallback: bool,
    pub autowire_candidate: bool,
    pub default_candidate: bool,
    pub priority: Option<i64>,
    pub scope: Option<String>,
    pub lazy: bool,
    pub profiles: Vec<String>,
    /// Condition annotations (FQNs), `@Profile` excluded.
    pub conditions: Vec<String>,
    pub presence: Presence,
    /// Declared in test sources.
    pub test: bool,
    /// Simple names of its type and every supertype (an index key).
    pub type_names: Vec<String>,
    /// Qualified supertypes of a type outside the sources (library beans).
    pub supertypes: Vec<String>,
}

/// What an injection point receives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    Single,
    Optional,
    /// `ObjectProvider<T>`, `Provider<T>`, `ObjectFactory<T>`.
    Provider,
    /// Collections, arrays and `Map<String, T>`: every matching bean.
    Many,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InjectionKind {
    Field,
    Constructor,
    Setter,
    BeanMethodParam,
}

#[derive(Clone, Debug)]
pub struct InjectionPoint {
    pub owner: TypeId,
    pub member: u32,
    pub param: Option<u32>,
    /// The field or parameter name (a tie-breaker).
    pub name: String,
    pub kind: InjectionKind,
    /// The bean type looked for (the element type of a collection).
    pub wanted: TypeRef,
    pub shape: Shape,
    pub qualifiers: Vec<Qualifier>,
    /// `@Resource(name = …)`: by name.
    pub by_name: Option<String>,
    /// `@Resource`: by the field / parameter name first, then by type.
    pub resource: bool,
    pub required: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ContextKind {
    /// A `@SpringBootApplication` / `@SpringBootConfiguration` class: scanning + auto-configuration.
    Boot,
    /// A `@Configuration` class with `@ComponentScan` that nothing else registers.
    Config,
    /// No application class: the beans of the build module (and the others).
    Module,
}

#[derive(Clone, Debug)]
pub struct SpringContext {
    /// Stable: `boot:a.b.App`, `config:a.b.Cfg`, `module:/path`.
    pub id: String,
    pub label: String,
    pub kind: ContextKind,
    pub root: Option<TypeId>,
    /// Scanned packages (empty for `Module`).
    pub scan: Vec<String>,
    /// Beans of the context (indices into [`SpringModel::beans`]).
    pub beans: Vec<usize>,
    /// Beans may come from where the model cannot see (auto-configuration, `@Enable…`, registrars).
    pub unknown_sources: bool,
    /// `@Enable…` annotations or imports of library types: registrations the model cannot see,
    /// even with the library model.
    pub opaque: bool,
    /// Rooted in test sources (a test application): it only serves test code of its module.
    pub test: bool,
}

/// The model of a project, one per index state (see [`SpringModel::key`]).
#[derive(Clone, Debug, Default)]
pub struct SpringModel {
    pub beans: Vec<BeanDef>,
    pub injections: Vec<InjectionPoint>,
    pub contexts: Vec<SpringContext>,
    /// `@EventListener` methods and `ApplicationListener`s.
    pub listeners: Vec<Listener>,
    /// `@Cacheable` / `@CachePut` / `@CacheEvict` operations.
    pub cache_ops: Vec<CacheOp>,
    pub meta: AnnotationMeta,
    /// Per file, its build module (nearest folder with a build file).
    modules: HashMap<u32, Option<PathBuf>>,
    /// Per file, whether it is test code.
    tests: HashMap<u32, bool>,
    /// Beans by the simple names of their types and supertypes.
    by_type_name: HashMap<String, Vec<usize>>,
    /// Per type with injection points or beans: the contexts it belongs to.
    type_contexts: HashMap<TypeId, Vec<usize>>,
    /// Active profiles the model was built with (empty: not configured).
    pub active_profiles: Vec<String>,
}

/// What the model depends on besides the Java files.
#[derive(Clone, Debug, Default)]
pub struct SpringOptions {
    /// Settings › Spring › Active profiles (empty: every profile may be active).
    pub active_profiles: Vec<String>,
    /// Library models by build module folder (canonical).
    pub libraries: Vec<(PathBuf, std::sync::Arc<LibraryModel>)>,
    /// Changes whenever `libraries` does.
    pub library_revision: u64,
}

const BUILD_FILES: &[&str] = &["pom.xml", "build.gradle", "build.gradle.kts"];

/// Folders with a build file, from the indexed files.
fn module_dirs(view: &JavaView) -> HashSet<PathBuf> {
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

fn is_test_path(p: &Path) -> bool {
    let s = p.to_string_lossy();
    s.contains("/src/test/") || s.contains("\\src\\test\\") || s.contains("/src/testFixtures/")
}

impl SpringModel {
    /// The cache key of the model of `view`'s index (without its overlay): the Java declarations,
    /// the files (build files decide modules) and the options.
    pub fn key(view: &JavaView, options: &SpringOptions) -> u128 {
        let mut h = Hash::default();
        h.put(&view.data.java.structure.to_string());
        h.put(&view.data.file_count.to_string());
        for p in &options.active_profiles {
            h.put(p);
        }
        h.put(&options.library_revision.to_string());
        h.finish()
    }

    /// Whether the model built for the index answers for `view`: its edited file declares the
    /// same as the indexed one (only positions differ, read through the view).
    pub fn reusable_for(view: &JavaView) -> bool {
        match &view.overlay {
            None => true,
            Some(o) => match o.file.and_then(|f| view.data.files.get(f as usize)?.as_ref()?.java.as_deref()) {
                Some(indexed) => indexed.structure_hash() == o.stub.structure_hash(),
                None => false,
            },
        }
    }

    pub fn build(view: &JavaView, path: &Path, options: &SpringOptions) -> Self {
        let mut model = SpringModel {
            meta: AnnotationMeta::builtin(),
            active_profiles: options.active_profiles.clone(),
            ..Default::default()
        };
        collect::annotation_types(view, &mut model.meta);
        let dirs = module_dirs(view);
        for (file, _) in files(view) {
            let p = if Some(file) == view.overlay_file() { Some(path) } else { view.path(file) };
            model
                .modules
                .insert(file, p.and_then(|p| p.ancestors().skip(1).find(|d| dirs.contains(*d)).map(Path::to_path_buf)));
            model.tests.insert(file, p.is_some_and(is_test_path));
        }
        let providers = providers::builtin();
        for (file, stub) in files(view) {
            collect::file(view, &mut model, &providers, file, stub);
        }
        collect::framework_beans(&mut model);
        features::collect(view, &mut model);
        contexts::detect(view, &mut model);
        // Auto-configuration joins the Boot applications of the module whose classpath it is on.
        for ci in 0..model.contexts.len() {
            let c = &model.contexts[ci];
            if c.kind != ContextKind::Boot {
                continue;
            }
            let module = c.root.and_then(|r| model.module_of(r.file)).map(Path::to_path_buf);
            let library = module.and_then(|m| options.libraries.iter().find(|(p, _)| *p == m).map(|(_, l)| l.clone()));
            if let Some(library) = library {
                library::join(&mut model, ci, &library);
                let c = &mut model.contexts[ci];
                c.unknown_sources = c.opaque || c.test || library.incomplete;
            }
        }
        for (i, b) in model.beans.iter().enumerate() {
            for n in &b.type_names {
                model.by_type_name.entry(n.clone()).or_default().push(i);
            }
        }
        model
    }

    pub fn module_of(&self, file: u32) -> Option<&Path> {
        self.modules.get(&file).and_then(|m| m.as_deref())
    }

    pub fn is_test_file(&self, file: u32) -> bool {
        self.tests.get(&file).copied().unwrap_or(false)
    }

    /// The contexts a type takes part in (a bean of them, or in their scanned packages).
    pub fn contexts_of(&self, ty: TypeId) -> &[usize] {
        self.type_contexts.get(&ty).map_or(&[], Vec::as_slice)
    }

    /// Bean candidates by type name (before the assignability check).
    fn beans_named_type(&self, simple_name: &str) -> &[usize] {
        self.by_type_name.get(simple_name).map_or(&[], Vec::as_slice)
    }
}

impl SpringModel {
    /// The Boot applications: their build module and a source file of each (a Java file of the
    /// module, to reach its classpath through the language server).
    pub fn boot_applications(&self, view: &JavaView) -> Vec<(PathBuf, PathBuf)> {
        let mut out: Vec<(PathBuf, PathBuf)> = Vec::new();
        for c in self.contexts.iter().filter(|c| c.kind == ContextKind::Boot && !c.test) {
            let Some(root) = c.root else { continue };
            let (Some(module), Some(file)) = (self.module_of(root.file), view.path(root.file)) else { continue };
            if !out.iter().any(|(m, _)| m == module) {
                out.push((module.to_path_buf(), file.to_path_buf()));
            }
        }
        out
    }
}

impl InjectionPoint {
    /// Where its name is, read from the view (the edited file's current text).
    pub fn at(&self, view: &JavaView) -> Option<Pos> {
        let m = view.ty(self.owner)?.members.get(self.member as usize)?;
        match self.param {
            Some(p) => m.param_details.get(p as usize).map(|p| p.at),
            None => Some(m.at),
        }
    }
}

#[cfg(test)]
mod tests;
