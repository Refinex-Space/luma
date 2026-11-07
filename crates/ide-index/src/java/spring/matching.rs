//! Which beans an injection point receives: Spring's `findAutowireCandidates` and
//! `determineAutowireCandidate` over the model (type with generics, qualifiers, `@Resource`
//! names, `defaultCandidate`, then `@Primary`, `@Fallback`, `@Priority`, the parameter name).

use super::super::Resolved as JResolved;
use super::annotations::QUALIFIER;
use super::*;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The bean injected (single shapes).
    Unique(usize),
    /// Every candidate is injected (collections, arrays, maps).
    Many,
    /// More than one candidate and nothing decides between them.
    Ambiguous,
    /// Only beans that depend on a condition or profile.
    Conditional,
    /// No candidate.
    None,
}

#[derive(Clone, Debug)]
pub struct Resolution {
    /// The candidates, the injected one first for `Unique`.
    pub beans: Vec<usize>,
    pub outcome: Outcome,
    /// Beans may come from where the model cannot see: a missing or ambiguous candidate is not certain.
    pub unknown_sources: bool,
}

/// Supertypes with the type arguments they are written with, per source type (computed once per query).
#[derive(Default)]
pub struct Supers(HashMap<TypeId, Vec<(JResolved, Vec<String>)>>);

impl Supers {
    fn closure(&mut self, view: &JavaView, id: TypeId) -> &Vec<(JResolved, Vec<String>)> {
        self.0.entry(id).or_insert_with(|| {
            let mut seen = HashSet::from([id]);
            let mut queue = vec![id];
            let mut out = Vec::new();
            while let Some(t) = queue.pop() {
                let args = view.ty(t).map(|ty| ty.super_args.clone()).unwrap_or_default();
                for (i, s) in view.supertypes(t).into_iter().enumerate() {
                    let a = args.get(i).cloned().unwrap_or_default();
                    if let JResolved::Source(sid) = s {
                        if !seen.insert(sid) {
                            continue;
                        }
                        queue.push(sid);
                    }
                    out.push((s, a));
                }
            }
            out
        })
    }

    /// Whether a bean of type `bean` can be injected where `wanted` is.
    pub fn assignable(&mut self, view: &JavaView, bean: &BeanDef, wanted: &TypeRef) -> bool {
        match (&bean.ty.ty, &wanted.ty) {
            (JResolved::Source(b), JResolved::Source(w)) => {
                b == w && args_ok(&bean.ty.args, &wanted.args)
                    || self
                        .closure(view, *b)
                        .iter()
                        .any(|(s, a)| matches!(s, JResolved::Source(s) if s == w) && args_ok(a, &wanted.args))
            }
            (JResolved::Source(b), JResolved::External(w)) => self
                .closure(view, *b)
                .iter()
                .any(|(s, a)| matches!(s, JResolved::External(e) if same_external(e, w)) && args_ok(a, &wanted.args)),
            (JResolved::External(b), JResolved::External(w)) => {
                (same_external(b, w) && args_ok(&bean.ty.args, &wanted.args))
                    || bean.supertypes.iter().any(|s| same_external(s, w))
                    || (bean.origin == BeanOrigin::Framework && bean.type_names.iter().any(|n| n == simple(w)))
            }
            (JResolved::External(_), JResolved::Source(_)) => false,
        }
    }
}

/// Two names of a type outside the sources: equal, or one is only a guess (`java.lang.X`, a
/// simple name) with the same simple name.
pub fn same_external(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let guess = |s: &str| !s.contains('.') || s.starts_with("java.lang.");
    simple(a) == simple(b) && (guess(a) || guess(b))
}

/// A type variable or wildcard: matches any argument.
fn open(arg: &str) -> bool {
    arg.is_empty()
        || arg == "?"
        || arg == "Object"
        || (arg.len() <= 2 && arg.chars().next().is_some_and(char::is_uppercase))
}

/// Type arguments compatible (`GenericTypeAwareAutowireCandidateResolver`, one level deep;
/// raw types and type variables match anything).
fn args_ok(have: &[String], want: &[String]) -> bool {
    if have.is_empty() || want.is_empty() || have.len() != want.len() {
        return true;
    }
    have.iter().zip(want).all(|(h, w)| open(h) || open(w) || simple(h) == simple(w))
}

fn names(b: &BeanDef) -> impl Iterator<Item = &str> {
    std::iter::once(b.name.as_str()).chain(b.aliases.iter().map(String::as_str))
}

/// The bean carries qualifier `q` (`@Qualifier` values also match bean names).
fn qualified(b: &BeanDef, q: &Qualifier) -> bool {
    if q.annotation == QUALIFIER {
        let Some(v) = &q.value else { return true };
        return names(b).any(|n| n == v)
            || b.qualifiers.iter().any(|bq| bq.annotation == QUALIFIER && bq.value.as_ref() == Some(v));
    }
    b.qualifiers.iter().any(|bq| bq.annotation == q.annotation && (q.value.is_none() || bq.value == q.value))
}

pub fn resolve(view: &JavaView, model: &SpringModel, ip: &InjectionPoint, supers: &mut Supers) -> Resolution {
    let contexts = model.contexts_of(ip.owner);
    let (pool, unknown): (HashSet<usize>, bool) = if contexts.is_empty() {
        // No application context: every bean, the build module's first (as before contexts).
        ((0..model.beans.len()).collect(), true)
    } else {
        let mut pool = HashSet::new();
        let mut unknown = false;
        for &c in contexts {
            pool.extend(model.contexts[c].beans.iter().copied());
            unknown |= model.contexts[c].unknown_sources;
        }
        (pool, unknown)
    };
    let test_ip = model.is_test_file(ip.owner.file);
    let wanted_name = match &ip.wanted.ty {
        JResolved::Source(id) => view.ty(*id).map_or("", |t| t.name.as_str()),
        JResolved::External(e) => simple(e),
    };
    let mut found: Vec<usize> = model
        .beans_named_type(wanted_name)
        .iter()
        .copied()
        .filter(|i| pool.contains(i))
        .filter(|&i| {
            let b = &model.beans[i];
            b.autowire_candidate && b.presence != Presence::Inactive && (test_ip || !b.test)
        })
        .filter(|&i| supers.assignable(view, &model.beans[i], &ip.wanted))
        .collect();
    if contexts.is_empty() {
        let module = model.module_of(ip.owner.file).map(Path::to_path_buf);
        let same: Vec<usize> = found
            .iter()
            .copied()
            .filter(|&i| {
                model.beans[i].owner.map(|o| model.module_of(o.file).map(Path::to_path_buf)) == Some(module.clone())
            })
            .collect();
        if module.is_some() && !same.is_empty() {
            found.retain(|i| same.contains(i));
        }
    }
    // Not the bean being defined (`@Bean` parameters, a class's own constructor), unless alone.
    let self_ref = |i: &usize| {
        let b = &model.beans[*i];
        b.owner == Some(ip.owner)
            && (b.method == Some(ip.member) || (b.method.is_none() && ip.kind == InjectionKind::Constructor))
    };
    if found.iter().any(|i| !self_ref(i)) {
        found.retain(|i| !self_ref(i));
    }
    // `@Resource(name)`: by name only; `@Resource`: by the field name when a bean has it.
    if let Some(name) = &ip.by_name {
        found.retain(|&i| names(&model.beans[i]).any(|n| n == name));
    } else if ip.resource && found.iter().any(|&i| names(&model.beans[i]).any(|n| n == ip.name)) {
        found.retain(|&i| names(&model.beans[i]).any(|n| n == ip.name));
    }
    for q in &ip.qualifiers {
        found.retain(|&i| qualified(&model.beans[i], q));
    }
    if ip.qualifiers.is_empty() && ip.by_name.is_none() {
        found.retain(|&i| model.beans[i].default_candidate);
    }
    found.sort_unstable();
    found.dedup();

    if ip.shape == Shape::Many {
        let outcome = if found.is_empty() { Outcome::None } else { Outcome::Many };
        return Resolution { beans: found, outcome, unknown_sources: unknown };
    }
    let certain: Vec<usize> = found.iter().copied().filter(|&i| model.beans[i].presence == Presence::Certain).collect();
    let pick = |chosen: usize, mut beans: Vec<usize>| {
        beans.retain(|&i| i != chosen);
        beans.insert(0, chosen);
        beans
    };
    match certain.len() {
        0 if found.is_empty() => Resolution { beans: found, outcome: Outcome::None, unknown_sources: unknown },
        0 => Resolution { beans: found, outcome: Outcome::Conditional, unknown_sources: unknown },
        1 => Resolution {
            beans: pick(certain[0], found),
            outcome: Outcome::Unique(certain[0]),
            unknown_sources: unknown,
        },
        _ => match determine(model, ip, &certain) {
            Some(chosen) => {
                Resolution { beans: pick(chosen, found), outcome: Outcome::Unique(chosen), unknown_sources: unknown }
            }
            None => Resolution { beans: found, outcome: Outcome::Ambiguous, unknown_sources: unknown },
        },
    }
}

/// `determineAutowireCandidate`: the primary one, else the only non-fallback, else the highest
/// `@Priority`, else the one named like the field or parameter.
fn determine(model: &SpringModel, ip: &InjectionPoint, candidates: &[usize]) -> Option<usize> {
    let primaries: Vec<usize> = candidates.iter().copied().filter(|&i| model.beans[i].primary).collect();
    match primaries.len() {
        1 => return Some(primaries[0]),
        0 => {}
        _ => return None,
    }
    let regular: Vec<usize> = candidates.iter().copied().filter(|&i| !model.beans[i].fallback).collect();
    if regular.len() == 1 {
        return Some(regular[0]);
    }
    let prioritized: Vec<(i64, usize)> =
        candidates.iter().filter_map(|&i| Some((model.beans[i].priority?, i))).collect();
    if let Some(&(best, i)) = prioritized.iter().min_by_key(|(p, _)| *p)
        && prioritized.iter().filter(|(p, _)| *p == best).count() == 1
    {
        return Some(i);
    }
    let named: Vec<usize> =
        candidates.iter().copied().filter(|&i| names(&model.beans[i]).any(|n| n == ip.name)).collect();
    (named.len() == 1).then(|| named[0])
}
