//! Annotation meta model (IDEA's `MetaAnnotationUtil`): which annotations an annotation type is
//! annotated with, transitively. Spring's own annotations come from a built-in table so the
//! model works before (and without) the language server; the sources' annotation types are
//! added from the index; library annotation types arrive with the library model.

use super::super::{AnnotationValue, JavaAnnotation, JavaStub, JavaView, Resolved, TypeId, simple};
use std::collections::{HashMap, HashSet, VecDeque};

pub const COMPONENT: &str = "org.springframework.stereotype.Component";
pub const SERVICE: &str = "org.springframework.stereotype.Service";
pub const REPOSITORY: &str = "org.springframework.stereotype.Repository";
pub const CONTROLLER: &str = "org.springframework.stereotype.Controller";
pub const INDEXED: &str = "org.springframework.stereotype.Indexed";
pub const REST_CONTROLLER: &str = "org.springframework.web.bind.annotation.RestController";
pub const CONTROLLER_ADVICE: &str = "org.springframework.web.bind.annotation.ControllerAdvice";
pub const REST_CONTROLLER_ADVICE: &str = "org.springframework.web.bind.annotation.RestControllerAdvice";
pub const CONFIGURATION: &str = "org.springframework.context.annotation.Configuration";
pub const BEAN: &str = "org.springframework.context.annotation.Bean";
pub const COMPONENT_SCAN: &str = "org.springframework.context.annotation.ComponentScan";
pub const IMPORT: &str = "org.springframework.context.annotation.Import";
pub const PRIMARY: &str = "org.springframework.context.annotation.Primary";
pub const FALLBACK: &str = "org.springframework.context.annotation.Fallback";
pub const LAZY: &str = "org.springframework.context.annotation.Lazy";
pub const SCOPE: &str = "org.springframework.context.annotation.Scope";
pub const PROFILE: &str = "org.springframework.context.annotation.Profile";
pub const CONDITIONAL: &str = "org.springframework.context.annotation.Conditional";
pub const DEPENDS_ON: &str = "org.springframework.context.annotation.DependsOn";
pub const ORDER: &str = "org.springframework.core.annotation.Order";
pub const QUALIFIER: &str = "org.springframework.beans.factory.annotation.Qualifier";
pub const AUTOWIRED: &str = "org.springframework.beans.factory.annotation.Autowired";
pub const VALUE: &str = "org.springframework.beans.factory.annotation.Value";
pub const LOOKUP: &str = "org.springframework.beans.factory.annotation.Lookup";
pub const SPRING_BOOT_APPLICATION: &str = "org.springframework.boot.autoconfigure.SpringBootApplication";
pub const SPRING_BOOT_CONFIGURATION: &str = "org.springframework.boot.SpringBootConfiguration";
pub const ENABLE_AUTO_CONFIGURATION: &str = "org.springframework.boot.autoconfigure.EnableAutoConfiguration";
pub const AUTO_CONFIGURATION: &str = "org.springframework.boot.autoconfigure.AutoConfiguration";
pub const TEST_CONFIGURATION: &str = "org.springframework.boot.test.context.TestConfiguration";
pub const SPRING_BOOT_TEST: &str = "org.springframework.boot.test.context.SpringBootTest";
pub const CONTEXT_CONFIGURATION: &str = "org.springframework.test.context.ContextConfiguration";
pub const BOOTSTRAP_WITH: &str = "org.springframework.test.context.BootstrapWith";
pub const MAPPER: &str = "org.apache.ibatis.annotations.Mapper";
pub const MAPPER_SCAN: &str = "org.mybatis.spring.annotation.MapperScan";
pub const FEIGN_CLIENT: &str = "org.springframework.cloud.openfeign.FeignClient";
pub const ENABLE_FEIGN_CLIENTS: &str = "org.springframework.cloud.openfeign.EnableFeignClients";
pub const NO_REPOSITORY_BEAN: &str = "org.springframework.data.repository.NoRepositoryBean";
pub const REPOSITORY_DEFINITION: &str = "org.springframework.data.repository.RepositoryDefinition";
pub const LOMBOK_REQUIRED_ARGS: &str = "lombok.RequiredArgsConstructor";
pub const LOMBOK_ALL_ARGS: &str = "lombok.AllArgsConstructor";
pub const EVENT_LISTENER: &str = "org.springframework.context.event.EventListener";
pub const TRANSACTIONAL_EVENT_LISTENER: &str = "org.springframework.transaction.event.TransactionalEventListener";
pub const APPLICATION_LISTENER: &str = "org.springframework.context.ApplicationListener";
pub const SCHEDULED: &str = "org.springframework.scheduling.annotation.Scheduled";
pub const SCHEDULES: &str = "org.springframework.scheduling.annotation.Schedules";
pub const ASYNC: &str = "org.springframework.scheduling.annotation.Async";
pub const TRANSACTIONAL: &str = "org.springframework.transaction.annotation.Transactional";
pub const CACHEABLE: &str = "org.springframework.cache.annotation.Cacheable";
pub const CACHE_PUT: &str = "org.springframework.cache.annotation.CachePut";
pub const CACHE_EVICT: &str = "org.springframework.cache.annotation.CacheEvict";
pub const CACHING: &str = "org.springframework.cache.annotation.Caching";
pub const CACHE_CONFIG: &str = "org.springframework.cache.annotation.CacheConfig";
pub const BEFORE_TRANSACTION: &str = "org.springframework.test.context.transaction.BeforeTransaction";
pub const AFTER_TRANSACTION: &str = "org.springframework.test.context.transaction.AfterTransaction";
pub const DIRTIES_CONTEXT: &str = "org.springframework.test.annotation.DirtiesContext";
pub const SPRING_JUNIT_CONFIG: &str = "org.springframework.test.context.junit.jupiter.SpringJUnitConfig";
pub const SPRING_JUNIT_WEB_CONFIG: &str = "org.springframework.test.context.junit.jupiter.web.SpringJUnitWebConfig";
pub const POST_CONSTRUCT: [&str; 2] = ["jakarta.annotation.PostConstruct", "javax.annotation.PostConstruct"];

/// One FQN per name in both `jakarta` and `javax` (JSR-330 / JSR-250).
pub const INJECT: [&str; 2] = ["jakarta.inject.Inject", "javax.inject.Inject"];
pub const NAMED: [&str; 2] = ["jakarta.inject.Named", "javax.inject.Named"];
pub const RESOURCE: [&str; 2] = ["jakarta.annotation.Resource", "javax.annotation.Resource"];
pub const PRIORITY: [&str; 2] = ["jakarta.annotation.Priority", "javax.annotation.Priority"];

/// Spring's annotations and what they are annotated with (the parts that matter to the model).
const KNOWN: &[(&str, &[&str])] = &[
    (COMPONENT, &[INDEXED]),
    (SERVICE, &[COMPONENT]),
    (REPOSITORY, &[COMPONENT]),
    (CONTROLLER, &[COMPONENT]),
    (REST_CONTROLLER, &[CONTROLLER]),
    (CONTROLLER_ADVICE, &[COMPONENT]),
    (REST_CONTROLLER_ADVICE, &[CONTROLLER_ADVICE]),
    (CONFIGURATION, &[COMPONENT]),
    (SPRING_BOOT_CONFIGURATION, &[CONFIGURATION]),
    (SPRING_BOOT_APPLICATION, &[SPRING_BOOT_CONFIGURATION, ENABLE_AUTO_CONFIGURATION, COMPONENT_SCAN]),
    (AUTO_CONFIGURATION, &[CONFIGURATION]),
    (TEST_CONFIGURATION, &[CONFIGURATION]),
    ("org.springframework.boot.jackson.JsonComponent", &[COMPONENT]),
    ("org.springframework.boot.context.properties.ConfigurationPropertiesScan", &[]),
    ("org.springframework.boot.actuate.endpoint.annotation.Endpoint", &[]),
    ("org.springframework.boot.actuate.endpoint.web.annotation.ControllerEndpoint", &[COMPONENT]),
    ("org.springframework.boot.actuate.endpoint.web.annotation.RestControllerEndpoint", &[COMPONENT]),
    ("org.springframework.data.rest.webmvc.RepositoryRestController", &[COMPONENT]),
    ("org.springframework.data.rest.webmvc.BasePathAwareController", &[COMPONENT]),
    (PROFILE, &[CONDITIONAL]),
    ("org.springframework.boot.autoconfigure.condition.ConditionalOnClass", &[CONDITIONAL]),
    ("org.springframework.boot.autoconfigure.condition.ConditionalOnMissingClass", &[CONDITIONAL]),
    ("org.springframework.boot.autoconfigure.condition.ConditionalOnBean", &[CONDITIONAL]),
    ("org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean", &[CONDITIONAL]),
    ("org.springframework.boot.autoconfigure.condition.ConditionalOnSingleCandidate", &[CONDITIONAL]),
    ("org.springframework.boot.autoconfigure.condition.ConditionalOnProperty", &[CONDITIONAL]),
    ("org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty", &[CONDITIONAL]),
    ("org.springframework.boot.autoconfigure.condition.ConditionalOnExpression", &[CONDITIONAL]),
    ("org.springframework.boot.autoconfigure.condition.ConditionalOnResource", &[CONDITIONAL]),
    ("org.springframework.boot.autoconfigure.condition.ConditionalOnJava", &[CONDITIONAL]),
    ("org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication", &[CONDITIONAL]),
    ("org.springframework.boot.autoconfigure.condition.ConditionalOnNotWebApplication", &[CONDITIONAL]),
    ("org.springframework.boot.autoconfigure.condition.ConditionalOnCloudPlatform", &[CONDITIONAL]),
    ("org.springframework.boot.autoconfigure.condition.ConditionalOnThreading", &[CONDITIONAL]),
    ("org.springframework.boot.autoconfigure.condition.ConditionalOnWarDeployment", &[CONDITIONAL]),
    (SPRING_BOOT_TEST, &[BOOTSTRAP_WITH]),
    ("org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest", &[BOOTSTRAP_WITH]),
    ("org.springframework.boot.test.autoconfigure.web.reactive.WebFluxTest", &[BOOTSTRAP_WITH]),
    ("org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest", &[BOOTSTRAP_WITH]),
    ("org.springframework.boot.test.autoconfigure.jdbc.JdbcTest", &[BOOTSTRAP_WITH]),
    ("org.springframework.boot.test.autoconfigure.data.mongo.DataMongoTest", &[BOOTSTRAP_WITH]),
    ("org.springframework.boot.test.autoconfigure.data.redis.DataRedisTest", &[BOOTSTRAP_WITH]),
    ("org.springframework.boot.test.autoconfigure.json.JsonTest", &[BOOTSTRAP_WITH]),
    ("org.springframework.boot.test.autoconfigure.web.client.RestClientTest", &[BOOTSTRAP_WITH]),
    (CONTEXT_CONFIGURATION, &[]),
    (SPRING_JUNIT_CONFIG, &[CONTEXT_CONFIGURATION]),
    (SPRING_JUNIT_WEB_CONFIG, &[CONTEXT_CONFIGURATION]),
    ("org.springframework.boot.test.autoconfigure.data.jdbc.DataJdbcTest", &[BOOTSTRAP_WITH]),
    ("org.springframework.boot.test.autoconfigure.data.r2dbc.DataR2dbcTest", &[BOOTSTRAP_WITH]),
    ("org.springframework.boot.test.autoconfigure.graphql.GraphQlTest", &[BOOTSTRAP_WITH]),
    ("org.springframework.boot.test.autoconfigure.webservices.client.WebServiceClientTest", &[BOOTSTRAP_WITH]),
    (BOOTSTRAP_WITH, &[]),
    (QUALIFIER, &[]),
    (AUTOWIRED, &[]),
    (VALUE, &[]),
    (LOOKUP, &[]),
    (BEAN, &[]),
    (COMPONENT_SCAN, &[]),
    (IMPORT, &[]),
    (PRIMARY, &[]),
    (FALLBACK, &[]),
    (LAZY, &[]),
    (SCOPE, &[]),
    (DEPENDS_ON, &[]),
    (ORDER, &[]),
    (INDEXED, &[]),
    (MAPPER, &[]),
    (MAPPER_SCAN, &[]),
    (FEIGN_CLIENT, &[]),
    (ENABLE_FEIGN_CLIENTS, &[]),
    (NO_REPOSITORY_BEAN, &[]),
    (REPOSITORY_DEFINITION, &[]),
    (LOMBOK_REQUIRED_ARGS, &[]),
    (LOMBOK_ALL_ARGS, &[]),
    ("org.springframework.web.context.annotation.RequestScope", &[SCOPE]),
    ("org.springframework.web.context.annotation.SessionScope", &[SCOPE]),
    ("org.springframework.web.context.annotation.ApplicationScope", &[SCOPE]),
    (EVENT_LISTENER, &[]),
    (TRANSACTIONAL_EVENT_LISTENER, &[EVENT_LISTENER]),
    (SCHEDULED, &[]),
    (SCHEDULES, &[]),
    (ASYNC, &[]),
    (TRANSACTIONAL, &[]),
    (CACHEABLE, &[]),
    (CACHE_PUT, &[]),
    (CACHE_EVICT, &[]),
    (CACHING, &[]),
    (CACHE_CONFIG, &[]),
    (BEFORE_TRANSACTION, &[]),
    (AFTER_TRANSACTION, &[]),
    (DIRTIES_CONTEXT, &[]),
    (POST_CONSTRUCT[0], &[]),
    (POST_CONSTRUCT[1], &[]),
    ("jakarta.annotation.PreDestroy", &[]),
    ("javax.annotation.PreDestroy", &[]),
    (INJECT[0], &[]),
    (INJECT[1], &[]),
    (NAMED[0], &[QUALIFIER_JSR330[0]]),
    (NAMED[1], &[QUALIFIER_JSR330[1]]),
    (RESOURCE[0], &[]),
    (RESOURCE[1], &[]),
    (PRIORITY[0], &[]),
    (PRIORITY[1], &[]),
];

/// JSR-330's `@Qualifier` meta-annotation (`@Named` carries it).
pub const QUALIFIER_JSR330: [&str; 2] = ["jakarta.inject.Qualifier", "javax.inject.Qualifier"];

/// Annotations of `java.lang` (an unimported simple name is one of these, or unresolved).
const JAVA_LANG: &[&str] = &["Deprecated", "Override", "FunctionalInterface", "SafeVarargs", "SuppressWarnings"];

/// Transitive "annotated with" relation over annotation types (FQNs).
#[derive(Default, Debug, Clone)]
pub struct AnnotationMeta {
    meta: HashMap<String, Vec<String>>,
    /// Built-in simple name → FQNs (to resolve unimported Spring annotations leniently).
    by_simple: HashMap<String, Vec<&'static str>>,
}

impl AnnotationMeta {
    pub fn builtin() -> Self {
        let mut m = Self::default();
        for (fqn, metas) in KNOWN {
            m.meta.insert((*fqn).to_owned(), metas.iter().map(|s| (*s).to_owned()).collect());
            m.by_simple.entry(simple(fqn).to_owned()).or_default().push(fqn);
        }
        m
    }

    /// Records an annotation type and the annotations on it (FQNs).
    pub fn add(&mut self, fqn: String, metas: Vec<String>) {
        self.meta.insert(fqn, metas);
    }

    pub fn knows(&self, fqn: &str) -> bool {
        self.meta.contains_key(fqn)
    }

    /// Whether `ann` is `target` or (transitively) annotated with it; cycle-safe.
    pub fn is_meta_annotated(&self, ann: &str, target: &str) -> bool {
        if ann == target {
            return true;
        }
        let mut seen = HashSet::from([ann]);
        let mut queue = VecDeque::from([ann]);
        while let Some(a) = queue.pop_front() {
            for m in self.meta.get(a).into_iter().flatten() {
                if m == target {
                    return true;
                }
                if seen.insert(m.as_str()) {
                    queue.push_back(m);
                }
            }
        }
        false
    }

    /// Whether `ann` is meta-annotated with any of `targets`.
    pub fn is_any(&self, ann: &str, targets: &[&str]) -> bool {
        targets.iter().any(|t| self.is_meta_annotated(ann, t))
    }

    /// Annotation types (FQNs known to the model) that are `target` or carry it.
    pub fn children(&self, target: &str) -> Vec<&str> {
        self.meta.keys().map(String::as_str).filter(|a| self.is_meta_annotated(a, target)).collect()
    }

    /// Built-in FQNs with this simple name.
    fn builtin_named(&self, name: &str) -> &[&'static str] {
        self.by_simple.get(name).map_or(&[], Vec::as_slice)
    }
}

/// The FQN an annotation is written with, resolved from where it is written: `context` is the
/// annotated type (or the type declaring the annotated member), `None` for package annotations.
pub fn annotation_fqn(
    view: &JavaView,
    meta: &AnnotationMeta,
    file: u32,
    context: Option<TypeId>,
    written: &str,
) -> String {
    let Some(stub) = view.stub(file) else { return written.to_owned() };
    if written.contains('.') {
        // `org.springframework.stereotype.Service`, or `Outer.Nested` resolved below.
        if written.split('.').next().is_some_and(|p| p.chars().next().is_some_and(char::is_lowercase)) {
            return written.to_owned();
        }
    }
    let resolved = match context {
        Some(ctx) => view.resolve(ctx, written),
        None => import_of(stub, written).map_or_else(|| Resolved::External(written.to_owned()), Resolved::External),
    };
    match resolved {
        Resolved::Source(id) => view.qualified_name(id).unwrap_or_else(|| written.to_owned()),
        Resolved::External(q) => lenient(stub, meta, written, q),
    }
}

/// The single-type import naming `written`.
fn import_of(stub: &JavaStub, written: &str) -> Option<String> {
    let name = written.split('.').next().unwrap_or(written);
    stub.imports.iter().find(|i| !i.on_demand && !i.is_static && simple(&i.path) == name).map(|i| {
        match written.split_once('.') {
            Some((_, rest)) => format!("{}.{rest}", i.path),
            None => i.path.clone(),
        }
    })
}

/// A guess of the resolver (`java.lang.X` for an unimported name) made precise for Spring's
/// annotations: an on-demand import of their package, else the only built-in with that name.
fn lenient(stub: &JavaStub, meta: &AnnotationMeta, written: &str, guess: String) -> String {
    let name = simple(written);
    let unresolved = guess.strip_prefix("java.lang.").is_some_and(|n| !JAVA_LANG.contains(&n)) || !guess.contains('.');
    if !unresolved {
        return guess;
    }
    let candidates = meta.builtin_named(name);
    for import in stub.imports.iter().filter(|i| i.on_demand && !i.is_static) {
        if let Some(fqn) = candidates.iter().find(|c| c.rsplit_once('.').is_some_and(|(p, _)| p == import.path)) {
            return (*fqn).to_owned();
        }
    }
    match candidates {
        // Unimported (or imported from a package the index cannot see): Spring's, as written.
        [only] => (*only).to_owned(),
        [first, ..] => (*first).to_owned(),
        [] => guess,
    }
}

/// An annotation of a declaration with its resolved FQN.
#[derive(Clone, Copy)]
pub struct Ann<'a> {
    pub fqn: &'a str,
    pub ann: &'a JavaAnnotation,
}

/// `@Profile` expression evaluation (`dev`, `!prod`, `dev & cloud`, `(a | b) & !c`), as Spring's
/// `Profiles.of` reads it. `active` is never empty: Spring uses `default` when nothing is active.
pub fn profile_matches(expressions: &[&str], active: &[String]) -> Option<bool> {
    let is_active = |p: &str| active.iter().any(|a| a == p);
    let mut any = false;
    for e in expressions {
        match eval_profile(e, &is_active) {
            Some(true) => return Some(true),
            Some(false) => any = true,
            None => return None,
        }
    }
    if any { Some(false) } else { None }
}

fn eval_profile(expr: &str, active: &dyn Fn(&str) -> bool) -> Option<bool> {
    struct P<'a> {
        tokens: Vec<&'a str>,
        i: usize,
    }
    fn tokenize(s: &str) -> Vec<&str> {
        let mut out = Vec::new();
        let mut start = None;
        for (i, c) in s.char_indices() {
            if "!&|()".contains(c) || c.is_whitespace() {
                if let Some(st) = start.take() {
                    out.push(&s[st..i]);
                }
                if !c.is_whitespace() {
                    out.push(&s[i..i + 1]);
                }
            } else if start.is_none() {
                start = Some(i);
            }
        }
        if let Some(st) = start {
            out.push(&s[st..]);
        }
        out
    }
    impl<'a> P<'a> {
        fn peek(&self) -> Option<&'a str> {
            self.tokens.get(self.i).copied()
        }
        fn or(&mut self, a: &dyn Fn(&str) -> bool) -> Option<bool> {
            let mut v = self.and(a)?;
            while self.peek() == Some("|") {
                self.i += 1;
                v |= self.and(a)?;
            }
            Some(v)
        }
        fn and(&mut self, a: &dyn Fn(&str) -> bool) -> Option<bool> {
            let mut v = self.not(a)?;
            while self.peek() == Some("&") {
                self.i += 1;
                v &= self.not(a)?;
            }
            Some(v)
        }
        fn not(&mut self, a: &dyn Fn(&str) -> bool) -> Option<bool> {
            match self.peek()? {
                "!" => {
                    self.i += 1;
                    Some(!self.not(a)?)
                }
                "(" => {
                    self.i += 1;
                    let v = self.or(a)?;
                    if self.peek() != Some(")") {
                        return None;
                    }
                    self.i += 1;
                    Some(v)
                }
                ")" | "&" | "|" => None,
                name => {
                    self.i += 1;
                    Some(a(name))
                }
            }
        }
    }
    let mut p = P { tokens: tokenize(expr), i: 0 };
    let v = p.or(active)?;
    (p.i == p.tokens.len()).then_some(v)
}

/// A `@Bean`'s / stereotype's string array argument, or none.
pub fn strings_of(a: &JavaAnnotation, names: &[&str]) -> Vec<String> {
    names.iter().filter_map(|n| a.arg(n)).flat_map(|v| v.strings().into_iter().map(str::to_owned)).collect()
}

/// Boolean argument `name`, or `default`.
pub fn bool_of(a: &JavaAnnotation, name: &str, default: bool) -> bool {
    a.arg(name).and_then(AnnotationValue::as_bool).unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles() {
        let active = vec!["dev".to_owned(), "cloud".to_owned()];
        assert_eq!(profile_matches(&["dev"], &active), Some(true));
        assert_eq!(profile_matches(&["!dev"], &active), Some(false));
        assert_eq!(profile_matches(&["prod", "cloud"], &active), Some(true), "any of the expressions");
        assert_eq!(profile_matches(&["dev & !cloud"], &active), Some(false));
        assert_eq!(profile_matches(&["(prod | dev) & cloud"], &active), Some(true));
        assert_eq!(profile_matches(&["dev &"], &active), None, "malformed");
    }

    #[test]
    fn meta_chains() {
        let mut m = AnnotationMeta::builtin();
        assert!(m.is_meta_annotated(REST_CONTROLLER, COMPONENT));
        assert!(m.is_meta_annotated(SPRING_BOOT_APPLICATION, CONFIGURATION));
        m.add("a.Domain".into(), vec![SERVICE.into()]);
        m.add("a.Loop".into(), vec!["a.Loop".into()]);
        assert!(m.is_meta_annotated("a.Domain", COMPONENT));
        assert!(!m.is_meta_annotated("a.Loop", COMPONENT));
        assert!(m.children(CONTROLLER).contains(&REST_CONTROLLER));
    }
}
