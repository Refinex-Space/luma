//! What a written configuration key binds to: a property of the metadata, an entry of a map
//! property, an item of a list property, a property of a nested bean (followed through its
//! Java type), a group, or nothing.

use crate::metadata::{MetadataIndex, Property};
use crate::name::{self, Element};
use crate::types::{JavaType, Scalar};
use crate::{ClassKind, TypeOracle};

#[derive(Debug)]
pub enum Resolved<'a> {
    /// A property of the metadata, exactly.
    Property(&'a Property),
    /// Under a property, through its type: a map entry, a list item, a nested bean's property.
    /// `ty` is the type of the value written at the key (`None` when not known).
    Nested { property: &'a Property, ty: Option<JavaType>, doc: Option<String> },
    /// A prefix of known properties (a group, a parent YAML key).
    Group,
    /// Under something whose structure is not known (a `Map<String, Object>`, an unknown
    /// class): never reported.
    Opaque,
    /// Nothing binds to it.
    Unknown(Problem),
}

/// Why a key under a known property does not bind.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Problem {
    /// No property with this name.
    Unknown,
    /// `list.x` where `list` needs an index (`list[0].x`).
    IndexRequired { property: String },
    /// `list[a]` with a non-integer index.
    NonIntegerIndex,
    /// `prop[`.
    UnclosedBracket,
}

/// The type of a property, parsed.
pub fn type_of(p: &Property) -> Option<JavaType> {
    p.ty.as_deref().and_then(JavaType::parse)
}

pub fn resolve<'a>(ix: &'a MetadataIndex, oracle: &dyn TypeOracle, key: &str) -> Resolved<'a> {
    if key.contains('[') && !key.contains(']') {
        return Resolved::Unknown(Problem::UnclosedBracket);
    }
    let canonical = name::canonical(key);
    if let Some(p) = ix.property(&canonical) {
        return Resolved::Property(p);
    }
    if let Some(p) = ix.longest_prefix_property(&canonical) {
        let written = name::elements(key);
        let consumed = name::elements(&p.name).len();
        // The written key has as many elements before the rest as the property's name (the
        // property's name may itself contain no brackets).
        let rest: Vec<Element> = written.into_iter().skip(consumed).collect();
        return match type_of(p) {
            Some(ty) => navigate(oracle, p, ty, &rest),
            None => Resolved::Opaque,
        };
    }
    if ix.has_under(&canonical) || ix.groups_named(&canonical).next().is_some() {
        return Resolved::Group;
    }
    Resolved::Unknown(Problem::Unknown)
}

fn navigate<'a>(oracle: &dyn TypeOracle, p: &'a Property, ty: JavaType, rest: &[Element]) -> Resolved<'a> {
    let mut ty = ty;
    let mut doc = None;
    let mut i = 0;
    while i < rest.len() {
        let e = &rest[i];
        match ty {
            JavaType::Map(_, v) => {
                let value = *v;
                // A map of values: everything after the property is the map key (`a.b.c`
                // under `logging.level` is the key `b.c`).
                match shape(oracle, &value) {
                    Shape::Value => return Resolved::Nested { property: p, ty: Some(value), doc: None },
                    Shape::Unknown => return Resolved::Opaque,
                    Shape::Structure => {}
                }
                ty = value;
                i += 1;
            }
            JavaType::List(item) => {
                if !e.indexed {
                    return Resolved::Unknown(Problem::IndexRequired { property: p.name.to_string() });
                }
                if e.text.trim().parse::<u32>().is_err() {
                    return Resolved::Unknown(Problem::NonIntegerIndex);
                }
                ty = *item;
                i += 1;
            }
            JavaType::Scalar(Scalar::Object) => return Resolved::Opaque,
            JavaType::Scalar(_) => return Resolved::Unknown(Problem::Unknown),
            JavaType::Class(ref c) => match oracle.class_kind(c) {
                ClassKind::Bean(props) => {
                    let want = name::uniform(e.text);
                    match props.into_iter().find(|bp| name::uniform(&bp.name) == want) {
                        Some(bp) => {
                            doc = bp.description.clone();
                            ty = bp.ty.as_deref().and_then(JavaType::parse).unwrap_or(JavaType::Scalar(Scalar::Object));
                            i += 1;
                        }
                        None => return Resolved::Unknown(Problem::Unknown),
                    }
                }
                ClassKind::Enum(_) | ClassKind::Value => return Resolved::Unknown(Problem::Unknown),
                ClassKind::Unknown => return Resolved::Opaque,
            },
        }
    }
    Resolved::Nested { property: p, ty: Some(ty), doc }
}

/// How values of a type are written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    /// One text (a scalar, an enum, a comma-separated list of those).
    Value,
    /// Nested keys (a bean, a map, a list of beans).
    Structure,
    /// The class is not known.
    Unknown,
}

pub fn shape(oracle: &dyn TypeOracle, ty: &JavaType) -> Shape {
    let class = |c: &str| match oracle.class_kind(c) {
        ClassKind::Bean(_) => Shape::Structure,
        ClassKind::Enum(_) | ClassKind::Value => Shape::Value,
        ClassKind::Unknown => Shape::Unknown,
    };
    match ty {
        JavaType::Scalar(Scalar::Object) => Shape::Unknown,
        JavaType::Scalar(_) => Shape::Value,
        JavaType::Class(c) => class(c),
        JavaType::List(e) => match &**e {
            JavaType::Scalar(_) => Shape::Value,
            JavaType::Class(c) => class(c),
            _ => Shape::Structure,
        },
        JavaType::Map(..) => Shape::Structure,
    }
}

/// The type whose value is written at `resolved` (`None` when unknown).
pub fn value_type(resolved: &Resolved) -> Option<JavaType> {
    match resolved {
        Resolved::Property(p) => type_of(p),
        Resolved::Nested { ty, .. } => ty.clone(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata::{Builder, Origin, OriginKind, parse};
    use crate::tests::FakeOracle;
    use std::sync::Arc;

    fn index() -> MetadataIndex {
        let raw = parse(
            br#"{"properties":[
            {"name":"logging.level","type":"java.util.Map<java.lang.String,java.lang.String>"},
            {"name":"app.servers","type":"java.util.List<demo.Server>"},
            {"name":"app.tags","type":"java.util.List<java.lang.String>"},
            {"name":"app.clients","type":"java.util.Map<java.lang.String,demo.Server>"},
            {"name":"app.any","type":"java.util.Map<java.lang.String,java.lang.Object>"},
            {"name":"server.port","type":"java.lang.Integer"}]}"#,
        )
        .unwrap();
        let mut b = Builder::new();
        b.add(&raw, Arc::new(Origin { kind: OriginKind::Jar, path: "x".into() }), false);
        b.build()
    }

    #[test]
    fn resolves_through_types() {
        let ix = index();
        let o = FakeOracle;
        assert!(matches!(resolve(&ix, &o, "server.port"), Resolved::Property(_)));
        assert!(matches!(resolve(&ix, &o, "server.Port"), Resolved::Property(_)));
        assert!(matches!(resolve(&ix, &o, "server"), Resolved::Group));
        assert!(matches!(resolve(&ix, &o, "server.prot"), Resolved::Unknown(Problem::Unknown)));
        assert!(matches!(
            resolve(&ix, &o, "logging.level.org.springframework.web"),
            Resolved::Nested { ty: Some(JavaType::Scalar(Scalar::String)), .. }
        ));
        assert!(matches!(
            resolve(&ix, &o, "app.servers[0].host"),
            Resolved::Nested { ty: Some(JavaType::Scalar(Scalar::String)), .. }
        ));
        assert!(matches!(resolve(&ix, &o, "app.servers[0].nope"), Resolved::Unknown(Problem::Unknown)));
        assert!(matches!(resolve(&ix, &o, "app.servers.host"), Resolved::Unknown(Problem::IndexRequired { .. })));
        assert!(matches!(resolve(&ix, &o, "app.servers[x].host"), Resolved::Unknown(Problem::NonIntegerIndex)));
        assert!(matches!(resolve(&ix, &o, "app.tags[0]"), Resolved::Nested { .. }));
        assert!(matches!(resolve(&ix, &o, "app.clients.east.port"), Resolved::Nested { .. }));
        assert!(matches!(resolve(&ix, &o, "app.any.x.y.z"), Resolved::Opaque));
        assert!(matches!(resolve(&ix, &o, "server.port.x"), Resolved::Unknown(Problem::Unknown)));
        assert!(matches!(resolve(&ix, &o, "app.servers[0"), Resolved::Unknown(Problem::UnclosedBracket)));
    }
}
