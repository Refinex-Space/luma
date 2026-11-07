//! Beans of the libraries (auto-configuration), as Luma's jdtls extension reads them from the
//! classpath (`luma.spring.library`), joined to the Boot application contexts of their module.
//!
//! Class conditions and the web application type are decided by the extension (it knows the
//! classpath); here the conditions that depend on the project are evaluated as Spring Boot
//! would: `@ConditionalOnMissingBean` against the context's own beans (a user `DataSource`
//! switches Hikari's off), `@ConditionalOnBean` likewise, `@Profile` against the active
//! profiles. Property conditions are not read from the configuration yet: one that matches
//! when the property is missing counts as met, the others leave the bean conditional.

use super::super::Resolved as JResolved;
use super::annotations::profile_matches;
use super::matching::same_external;
use super::*;
use serde::Deserialize;

/// The extension's answer for one Java project (module).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LibraryModel {
    /// The Java project's folder, as jdtls has it.
    pub project: String,
    /// `servlet`, `reactive` or `none` (Boot's `WebApplicationType.deduceFromClasspath`).
    pub web: String,
    pub configurations: Vec<LibConfiguration>,
    /// Bean type → its supertypes (FQNs).
    pub types: HashMap<String, Vec<String>>,
    pub incomplete: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LibConfiguration {
    pub fqn: String,
    pub handle: String,
    /// The jar file name registering it.
    pub jar: String,
    /// `autoConfiguration`, `import` or `nested`.
    pub source: String,
    pub before: Vec<String>,
    pub after: Vec<String>,
    pub conditions: Vec<LibCondition>,
    pub beans: Vec<LibBean>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LibBean {
    pub names: Vec<String>,
    #[serde(rename = "type")]
    pub ty: String,
    pub args: Vec<String>,
    pub conditions: Vec<LibCondition>,
    /// JDT handle of the `@Bean` method (or of the properties class).
    pub handle: String,
    /// The `@Bean` method's name; empty for `@EnableConfigurationProperties` beans.
    pub member: String,
    pub primary: bool,
    pub autowire_candidate: bool,
    pub default_candidate: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct LibCondition {
    /// Simple name: `ConditionalOnMissingBean`, `ConditionalOnProperty`, `Profile`, ….
    pub kind: String,
    pub attrs: HashMap<String, Vec<String>>,
}

impl LibCondition {
    fn values(&self, keys: &[&str]) -> Vec<&str> {
        keys.iter().flat_map(|k| self.attrs.get(*k).into_iter().flatten()).map(String::as_str).collect()
    }
}

/// What a condition says about a bean, given the context's own beans.
enum Verdict {
    Met,
    Unmet,
    Unknown,
}

struct Own<'m> {
    model: &'m SpringModel,
    beans: Vec<usize>,
}

impl Own<'_> {
    /// A certain bean of the context's own (source and framework) beans has one of these types
    /// or names.
    fn has(&self, types: &[&str], names: &[&str]) -> bool {
        self.beans.iter().map(|&i| &self.model.beans[i]).filter(|b| b.presence == Presence::Certain).any(|b| {
            names.iter().any(|n| b.name == *n || b.aliases.iter().any(|a| a == n))
                || types.iter().any(|t| {
                    b.type_names.iter().any(|n| n == simple(t))
                        && match &b.ty.ty {
                            JResolved::External(e) => {
                                same_external(e, t) || b.supertypes.iter().any(|s| same_external(s, t))
                            }
                            // A source type with that simple name among its supertypes: the
                            // qualified names of source supertypes are not kept, the simple one decides.
                            JResolved::Source(_) => true,
                        }
                })
        })
    }
}

fn verdict(c: &LibCondition, bean_type: &str, own: &Own, active: &[String]) -> Verdict {
    match c.kind.as_str() {
        "ConditionalOnMissingBean" | "ConditionalOnBean" | "ConditionalOnSingleCandidate" => {
            let mut types = c.values(&["value", "type"]);
            let names = c.values(&["name"]);
            if types.is_empty() && names.is_empty() {
                types.push(bean_type);
            }
            let present = own.has(&types, &names);
            match (c.kind.as_str(), present) {
                ("ConditionalOnMissingBean", true) => Verdict::Unmet,
                ("ConditionalOnMissingBean", false) => Verdict::Met,
                (_, true) => Verdict::Met,
                // Another library bean may satisfy it: the model does not order auto-configurations.
                (_, false) => Verdict::Unknown,
            }
        }
        "ConditionalOnProperty" | "ConditionalOnBooleanProperty" => {
            if c.values(&["matchIfMissing"]).first().is_some_and(|v| *v == "true") {
                Verdict::Met
            } else {
                Verdict::Unknown
            }
        }
        "Profile" => {
            if active.is_empty() {
                return Verdict::Unknown;
            }
            match profile_matches(&c.values(&["value"]), active) {
                Some(true) => Verdict::Met,
                Some(false) => Verdict::Unmet,
                None => Verdict::Unknown,
            }
        }
        _ => Verdict::Unknown,
    }
}

/// Adds the beans of `library` to context `ctx` (a Boot application of its module).
pub(super) fn join(model: &mut SpringModel, ctx: usize, library: &LibraryModel) {
    let own = Own { model, beans: model.contexts[ctx].beans.clone() };
    let active = model.active_profiles.clone();
    let mut added: Vec<BeanDef> = Vec::new();
    for config in &library.configurations {
        let config_simple = config.fqn.rsplit(['.', '$']).next().unwrap_or(&config.fqn).to_owned();
        for bean in &config.beans {
            let mut presence = Presence::Certain;
            for c in config.conditions.iter().chain(&bean.conditions) {
                match verdict(c, &bean.ty, &own, &active) {
                    Verdict::Met => {}
                    Verdict::Unmet => {
                        presence = Presence::Inactive;
                        break;
                    }
                    Verdict::Unknown => presence = Presence::Conditional,
                }
            }
            if presence == Presence::Inactive {
                continue;
            }
            let supertypes = library.types.get(&bean.ty).cloned().unwrap_or_default();
            let mut type_names: Vec<String> =
                std::iter::once(&bean.ty).chain(&supertypes).map(|t| simple(t).to_owned()).collect();
            type_names.sort();
            type_names.dedup();
            let mut names = bean.names.clone();
            if names.is_empty() {
                names.push(bean.member.clone());
            }
            let name = names.remove(0);
            added.push(BeanDef {
                name,
                aliases: names,
                ty: TypeRef { ty: JResolved::External(bean.ty.clone()), args: bean.args.clone() },
                owner: None,
                method: None,
                origin: BeanOrigin::Library {
                    handle: bean.handle.clone(),
                    configuration: if bean.member.is_empty() {
                        simple(&bean.ty).to_owned()
                    } else {
                        format!("{config_simple}.{}()", bean.member)
                    },
                    jar: config.jar.clone(),
                },
                kind: BeanKind::Library,
                qualifiers: Vec::new(),
                primary: bean.primary,
                fallback: false,
                autowire_candidate: bean.autowire_candidate,
                default_candidate: bean.default_candidate,
                priority: None,
                scope: None,
                lazy: false,
                profiles: Vec::new(),
                conditions: config.conditions.iter().chain(&bean.conditions).map(|c| c.kind.clone()).collect(),
                presence,
                test: false,
                type_names,
                supertypes,
            });
        }
    }
    for b in added {
        model.contexts[ctx].beans.push(model.beans.len());
        model.beans.push(b);
    }
}
