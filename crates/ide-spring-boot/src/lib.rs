//! Spring Boot support (IDEA's Spring Boot plugin, `com.intellij.spring.boot`):
//!
//! * [`metadata`]: configuration metadata files and the merged index a module sees.
//! * [`name`]: relaxed property names (`ConfigurationPropertyName`).
//! * [`types`]: property types and the binder's scalar conversions.
//! * [`document`]: `application.properties` / `application.yml` as documents of entries.
//! * [`resolve`]: what a written key binds to.
//! * [`analysis`]: completion, documentation and inspections of configuration files.
//! * [`source`]: metadata worked out from `@ConfigurationProperties` sources.
//! * [`imports`]: `META-INF/spring/*.imports` and `spring.factories`.
//! * [`java`]: Boot inspections of Java sources.
//!
//! What a configuration file needs to know of Java types is asked through [`TypeOracle`],
//! answered by Luma's Java engine in the host.

pub mod additional;
pub mod analysis;
pub mod document;
pub mod imports;
pub mod java;
pub mod metadata;
pub mod module;
pub mod name;
pub mod resolve;
pub mod source;
pub mod types;

/// A property of a bean type (setter, constructor parameter, record component).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BeanProperty {
    /// Kebab-case.
    pub name: String,
    /// Metadata-style type (`java.util.List<java.lang.String>`).
    pub ty: Option<String>,
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnumConstant {
    pub name: String,
    pub description: Option<String>,
}

/// What a class is to the binder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClassKind {
    /// Bound from nested keys: its properties.
    Bean(Vec<BeanProperty>),
    /// Bound from text by name.
    Enum(Vec<EnumConstant>),
    /// Bound from text by a converter (a value type).
    Value,
    /// Not found, or not decidable.
    Unknown,
}

/// Java type information a configuration file needs (the host answers with the Java engine).
pub trait TypeOracle {
    fn class_kind(&self, fqn: &str) -> ClassKind;
    /// Whether a class exists on the module's class path (`None`: not known).
    fn class_exists(&self, fqn: &str) -> Option<bool>;
    /// Classes assignable to `target` (all classes when `None`): qualified names.
    fn subclasses(&self, target: Option<&str>, concrete: bool, limit: usize) -> Vec<String>;
    /// The Javadoc of a class, as Markdown-ready text.
    fn class_doc(&self, fqn: &str) -> Option<String>;
    /// Packages and classes of the project and its libraries starting with `prefix` (logger names).
    fn logger_names(&self, prefix: &str, limit: usize) -> Vec<String>;
    /// Beans (name, type) assignable to `target`.
    fn beans(&self, target: Option<&str>) -> Vec<(String, String)>;
}

/// An oracle that knows nothing (Java support not ready).
pub struct NoTypes;

impl TypeOracle for NoTypes {
    fn class_kind(&self, _: &str) -> ClassKind {
        ClassKind::Unknown
    }
    fn class_exists(&self, _: &str) -> Option<bool> {
        None
    }
    fn subclasses(&self, _: Option<&str>, _: bool, _: usize) -> Vec<String> {
        Vec::new()
    }
    fn class_doc(&self, _: &str) -> Option<String> {
        None
    }
    fn logger_names(&self, _: &str, _: usize) -> Vec<String> {
        Vec::new()
    }
    fn beans(&self, _: Option<&str>) -> Vec<(String, String)> {
        Vec::new()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// `demo.Server` is a bean (`host`, `port`), `demo.Mode` an enum (`FAST`, `SLOW_START`).
    #[derive(Default)]
    pub struct FakeOracle;

    impl TypeOracle for FakeOracle {
        fn class_kind(&self, fqn: &str) -> ClassKind {
            match fqn {
                "demo.Server" => ClassKind::Bean(vec![
                    BeanProperty {
                        name: "host".into(),
                        ty: Some("java.lang.String".into()),
                        description: Some("Host.".into()),
                    },
                    BeanProperty { name: "port".into(), ty: Some("java.lang.Integer".into()), description: None },
                ]),
                "demo.Mode" => ClassKind::Enum(vec![
                    EnumConstant { name: "FAST".into(), description: Some("Fast mode.".into()) },
                    EnumConstant { name: "SLOW_START".into(), description: None },
                ]),
                "java.sql.Driver" | "org.h2.Driver" => ClassKind::Value,
                _ => ClassKind::Unknown,
            }
        }
        fn class_exists(&self, fqn: &str) -> Option<bool> {
            Some(matches!(fqn, "demo.Server" | "demo.Mode" | "org.h2.Driver" | "java.sql.Driver"))
        }
        fn subclasses(&self, target: Option<&str>, _: bool, _: usize) -> Vec<String> {
            match target {
                Some("java.sql.Driver") => vec!["org.h2.Driver".into()],
                _ => Vec::new(),
            }
        }
        fn class_doc(&self, _: &str) -> Option<String> {
            None
        }
        fn logger_names(&self, prefix: &str, _: usize) -> Vec<String> {
            ["demo", "demo.web", "demo.web.Controller"]
                .into_iter()
                .filter(|n| n.starts_with(prefix))
                .map(String::from)
                .collect()
        }
        fn beans(&self, _: Option<&str>) -> Vec<(String, String)> {
            vec![("dataSource".into(), "javax.sql.DataSource".into())]
        }
    }
}
