//! Member lookup and method invocation resolution (JLS §8.4.8, §15.12; IDEA's
//! `MethodCandidatesProcessor` and `JavaMethodsConflictResolver`): the methods a class type has
//! by inheritance with overridden ones removed, applicability by strict, loose and
//! variable-arity invocation, the most specific method, and inference of a generic method's
//! type arguments from the arguments, explicit type arguments and the target type.
//!
//! Applicability is three-valued: an argument whose type the engine does not know may or may not
//! fit. A choice is only made when no such doubt could change it.

use super::FileAnalysis;
use crate::classfile::BaseType;
use crate::model::{ACC_PRIVATE, ACC_PROTECTED, ACC_PUBLIC, ClassData, MethodData};
use crate::types::{ClassType, Key, OBJECT, Subst, Type, TypeArg, TypeVar};
use std::collections::HashSet;

/// A method as a member of some class type: where it is declared and the substitution the
/// receiver type applies to it.
#[derive(Clone, Debug)]
pub(crate) struct Candidate {
    pub class: Key,
    pub method: MethodData,
    pub subst: Subst,
}

/// An argument as overload resolution sees it.
#[derive(Clone, Debug)]
pub(crate) enum Arg {
    Ty(Type),
    /// An implicitly or explicitly typed lambda with this many parameters.
    Lambda(usize),
    MethodRef,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Fit {
    No,
    Maybe,
    Yes,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Strict,
    Loose,
    Varargs,
}

pub(crate) enum Choice {
    Chosen(Box<Candidate>),
    /// No method fits: an error in the code (or nothing named so).
    None,
    Unknown,
}

fn box_of(b: BaseType) -> &'static str {
    match b {
        BaseType::Boolean => "java/lang/Boolean",
        BaseType::Byte => "java/lang/Byte",
        BaseType::Char => "java/lang/Character",
        BaseType::Short => "java/lang/Short",
        BaseType::Int => "java/lang/Integer",
        BaseType::Long => "java/lang/Long",
        BaseType::Float => "java/lang/Float",
        BaseType::Double => "java/lang/Double",
    }
}

pub(crate) fn unbox_of(key: &str) -> Option<BaseType> {
    Some(match key {
        "java/lang/Boolean" => BaseType::Boolean,
        "java/lang/Byte" => BaseType::Byte,
        "java/lang/Character" => BaseType::Char,
        "java/lang/Short" => BaseType::Short,
        "java/lang/Integer" => BaseType::Int,
        "java/lang/Long" => BaseType::Long,
        "java/lang/Float" => BaseType::Float,
        "java/lang/Double" => BaseType::Double,
        _ => return None,
    })
}

pub(crate) fn boxed(t: &Type) -> Type {
    match t {
        Type::Prim(b) => Type::class(box_of(*b)),
        other => other.clone(),
    }
}

/// Widening primitive conversion (JLS §5.1.2), identity included.
fn prim_widens(from: BaseType, to: BaseType) -> bool {
    use BaseType::*;
    from == to
        || matches!(
            (from, to),
            (Byte, Short | Int | Long | Float | Double)
                | (Short, Int | Long | Float | Double)
                | (Char, Int | Long | Float | Double)
                | (Int, Long | Float | Double)
                | (Long, Float | Double)
                | (Float, Double)
        )
}

impl FileAnalysis<'_, '_, '_> {
    /// Whether code in class `from` may use a member of `owner` with `flags` (JLS §6.6).
    pub(crate) fn accessible(&self, flags: u32, owner: &ClassData, from: Option<&str>) -> bool {
        if flags & ACC_PUBLIC as u32 != 0 || owner.is_interface() && flags & ACC_PRIVATE as u32 == 0 {
            return true;
        }
        let Some(from) = from else { return flags & (ACC_PRIVATE | ACC_PROTECTED) as u32 == 0 };
        if flags & ACC_PRIVATE as u32 != 0 {
            // Within the same top-level class.
            let top = |k: &str| k.split('$').next().unwrap_or(k).to_owned();
            return top(from) == top(&owner.key);
        }
        if crate::model::package_of(from) == owner.package() {
            return true;
        }
        // Protected: from a subclass (the receiver rule of §6.6.2 is not checked).
        flags & ACC_PROTECTED as u32 != 0 && self.model.is_subclass(from, &owner.key)
            || flags & ACC_PROTECTED as u32 != 0 && self.encloses_subclass(from, &owner.key)
    }

    fn encloses_subclass(&self, from: &str, owner: &str) -> bool {
        let mut next = self.model.class(from).and_then(|c| c.outer.clone());
        while let Some(k) = next {
            if self.model.is_subclass(&k, owner) {
                return true;
            }
            next = self.model.class(&k).and_then(|c| c.outer.clone());
        }
        false
    }

    /// The methods named `name` that `recv` has as members (declared or inherited), overridden
    /// and inaccessible ones left out (JLS §8.4.8).
    pub(crate) fn member_methods(&self, recv: &ClassType, name: &str, from: Option<&str>) -> Vec<Candidate> {
        let mut out: Vec<Candidate> = Vec::new();
        // Collected signatures: (erased parameters, abstract, declared in an interface).
        let mut sigs: Vec<(String, bool, bool)> = Vec::new();
        let mut seen: HashSet<Key> = HashSet::new();
        let mut queue: std::collections::VecDeque<ClassType> = std::collections::VecDeque::from([recv.clone()]);
        let mut is_first = true;
        // An interface's own declarations are its members; `Object`'s methods only stand in for
        // those it does not declare (JLS §9.2). A class inherits a superclass's concrete method
        // over an interface's abstract one (JLS §8.4.8).
        let recv_is_interface = self.model.class(&recv.key).is_some_and(|c| c.is_interface());
        while let Some(t) = queue.pop_front() {
            if !seen.insert(t.key.clone()) {
                continue;
            }
            let Some(c) = self.model.class(&t.key) else { continue };
            let subst = self.model.subst_of(&t);
            for m in self.model.members(&c).methods.iter().filter(|m| m.name == name) {
                if m.is_constructor() {
                    continue;
                }
                // Private methods are not inherited.
                if !is_first && m.flags & ACC_PRIVATE as u32 != 0 {
                    continue;
                }
                if !self.accessible(m.flags, &c, from) {
                    continue;
                }
                let sig = self.erased_sig(m, &subst);
                let abstract_ = m.is_abstract();
                // Overridden by a method collected from a subtype (or a concrete method
                // implementing an abstract one met later).
                if let Some(i) = sigs.iter().position(|(s, _, _)| *s == sig) {
                    // An interface's abstract method found first, a superclass's concrete one later:
                    // the class inherits the concrete one. A class re-declaring a method abstract
                    // (`abstract String toString();`) keeps its abstract one.
                    if sigs[i].1 && sigs[i].2 && !abstract_ && !c.is_interface() && !recv_is_interface {
                        out[i] = Candidate { class: c.key.clone(), method: m.clone(), subst: subst.clone() };
                        sigs[i].1 = false;
                        sigs[i].2 = false;
                    }
                    continue;
                }
                sigs.push((sig, abstract_, c.is_interface()));
                out.push(Candidate { class: c.key.clone(), method: m.clone(), subst: subst.clone() });
            }
            is_first = false;
            queue.extend(self.model.direct_supertypes(&t));
        }
        out
    }

    /// Erased parameter types after substitution: the override-equivalence key.
    fn erased_sig(&self, m: &MethodData, subst: &Subst) -> String {
        let params: Vec<String> =
            m.params.iter().map(|p| self.model.erasure(&self.model.apply(subst, p)).to_string()).collect();
        params.join(",")
    }

    /// Constructors of class type `t` accessible from `from`.
    pub(crate) fn constructors(&self, t: &ClassType, from: Option<&str>) -> Vec<Candidate> {
        let Some(c) = self.model.class(&t.key) else { return Vec::new() };
        let subst = self.model.subst_of(t);
        self.model
            .members(&c)
            .methods
            .iter()
            .filter(|m| m.is_constructor() && self.accessible(m.flags, &c, from))
            .map(|m| Candidate { class: c.key.clone(), method: m.clone(), subst: subst.clone() })
            .collect()
    }

    fn param_at(&self, c: &Candidate, i: usize, phase: Phase) -> Option<Type> {
        let m = &c.method;
        let n = m.params.len();
        let p = if phase == Phase::Varargs && m.varargs && i + 1 >= n {
            match &m.params[n - 1] {
                Type::Array(e) => (**e).clone(),
                other => other.clone(),
            }
        } else {
            m.params.get(i)?.clone()
        };
        Some(self.model.apply(&c.subst, &p))
    }

    /// Whether a value of type `arg` can be passed for `param` (JLS §5.3) in `phase`.
    /// Type variables of the method stand for any reference type.
    pub(crate) fn fits(&self, arg: &Type, param: &Type, loose: bool, method_vars: &[TypeVar]) -> Fit {
        if arg.is_unknown() || param.is_unknown() {
            return Fit::Maybe;
        }
        match (arg, param) {
            (Type::Prim(a), Type::Prim(p)) => {
                if prim_widens(*a, *p) {
                    Fit::Yes
                } else {
                    Fit::No
                }
            }
            (Type::Prim(a), _) => {
                if !loose {
                    return Fit::No;
                }
                self.fits(&Type::class(box_of(*a)), param, false, method_vars)
            }
            (Type::Null, Type::Prim(_)) => Fit::No,
            (Type::Null, _) => Fit::Yes,
            (_, Type::Prim(p)) => {
                if !loose {
                    return Fit::No;
                }
                match arg {
                    Type::Class(c) => match unbox_of(&c.key) {
                        Some(a) if prim_widens(a, *p) => Fit::Yes,
                        Some(_) => Fit::No,
                        None => Fit::No,
                    },
                    Type::Var(_) => Fit::Maybe,
                    _ => Fit::No,
                }
            }
            (_, Type::Var(v)) => {
                if method_vars.contains(v) {
                    return Fit::Yes;
                }
                // A class type variable in scope: the argument must fit its bound.
                let bound = self.model.erasure(param);
                match self.fits(arg, &bound, loose, method_vars) {
                    Fit::Yes => Fit::Maybe,
                    other => other,
                }
            }
            (Type::Var(_), _) => {
                let bound = self.model.erasure(arg);
                match self.fits(&bound, param, loose, method_vars) {
                    Fit::No => Fit::Maybe,
                    f => f,
                }
            }
            (Type::Array(a), Type::Array(p)) => match (&**a, &**p) {
                (Type::Prim(x), Type::Prim(y)) => {
                    if x == y {
                        Fit::Yes
                    } else {
                        Fit::No
                    }
                }
                (Type::Prim(_), _) | (_, Type::Prim(_)) => Fit::No,
                (x, y) => self.fits(x, y, false, method_vars),
            },
            (Type::Array(_), Type::Class(c)) => {
                matches!(&*c.key, OBJECT | "java/lang/Cloneable" | "java/io/Serializable")
                    .then_some(Fit::Yes)
                    .unwrap_or(Fit::No)
            }
            (Type::Class(a), Type::Class(p)) => {
                if self.model.class(&a.key).is_none() || self.model.class(&p.key).is_none() {
                    return Fit::Maybe;
                }
                if self.model.is_subclass(&a.key, &p.key) { Fit::Yes } else { Fit::No }
            }
            (Type::Class(_), Type::Array(_)) => Fit::No,
            _ => Fit::Maybe,
        }
    }

    /// The single abstract method of a functional interface type, if it is one (JLS §9.8).
    pub(crate) fn functional_method(&self, t: &Type) -> Option<Candidate> {
        let ct = t.as_class()?;
        let c = self.model.class(&ct.key)?;
        if !c.is_interface() {
            return None;
        }
        let object_sigs: Vec<(String, usize)> = self
            .model
            .class(OBJECT)
            .map(|o| self.model.members(&o).methods.iter().map(|m| (m.name.clone(), m.params.len())).collect())
            .unwrap_or_else(|| vec![("equals".into(), 1), ("hashCode".into(), 0), ("toString".into(), 0)]);
        let mut found: Option<Candidate> = None;
        let mut seen = HashSet::new();
        let mut queue = vec![ct.clone()];
        let mut sigs: Vec<String> = Vec::new();
        while let Some(x) = queue.pop() {
            if !seen.insert(x.key.clone()) {
                continue;
            }
            let cls = self.model.class(&x.key)?;
            if !cls.is_interface() {
                continue;
            }
            let subst = self.model.subst_of(&x);
            for m in self.model.members(&cls).methods.iter() {
                if !m.is_abstract()
                    || m.is_static()
                    || object_sigs.iter().any(|(n, k)| *n == m.name && *k == m.params.len())
                {
                    continue;
                }
                let sig = format!("{}({})", m.name, self.erased_sig(m, &subst));
                if sigs.contains(&sig) {
                    continue;
                }
                sigs.push(sig);
                if found.is_some() {
                    // Two abstract methods with different signatures: not functional (generic
                    // overrides with equal erasure were merged above).
                    return None;
                }
                found = Some(Candidate { class: cls.key.clone(), method: m.clone(), subst: subst.clone() });
            }
            queue.extend(self.model.direct_supertypes(&x).into_iter().filter(|s| &*s.key != OBJECT));
        }
        // Default methods of subinterfaces may implement an inherited abstract one.
        if let Some(f) = &found {
            let defaults = self.member_methods(ct, &f.method.name, None);
            if defaults.iter().any(|d| !d.method.is_abstract() && d.method.params.len() == f.method.params.len()) {
                return None;
            }
        }
        found
    }

    fn arg_fits(&self, arg: &Arg, param: &Type, loose: bool, method_vars: &[TypeVar]) -> Fit {
        match arg {
            Arg::Ty(t) => self.fits(t, param, loose, method_vars),
            Arg::Lambda(n) => {
                if param.is_unknown() {
                    return Fit::Maybe;
                }
                if let Type::Var(v) = param
                    && method_vars.contains(v)
                {
                    return Fit::No;
                }
                match self.functional_method(param) {
                    Some(f) if f.method.params.len() == *n => Fit::Yes,
                    Some(_) => Fit::No,
                    None if param.as_class().is_some_and(|c| self.model.class(&c.key).is_none()) => Fit::Maybe,
                    None => Fit::No,
                }
            }
            // An implicitly typed lambda or a method reference is not pertinent to applicability
            // (JLS §15.12.2.2): potentially compatible with a functional interface parameter
            // (§15.12.2.1), it fits; only the other arguments decide.
            Arg::MethodRef => {
                if param.is_unknown() {
                    return Fit::Maybe;
                }
                if let Type::Var(v) = param
                    && method_vars.contains(v)
                {
                    return Fit::No;
                }
                match self.functional_method(param) {
                    Some(_) => Fit::Yes,
                    None if param.as_class().is_some_and(|c| self.model.class(&c.key).is_none()) => Fit::Maybe,
                    None => Fit::No,
                }
            }
        }
    }

    fn applicable(&self, c: &Candidate, args: &[Arg], phase: Phase) -> Fit {
        let n = c.method.params.len();
        let arity_ok = match phase {
            Phase::Strict | Phase::Loose => args.len() == n,
            Phase::Varargs => c.method.varargs && args.len() + 1 >= n,
        };
        if !arity_ok {
            return Fit::No;
        }
        let vars: Vec<TypeVar> = c.method.type_params.iter().map(|p| p.var.clone()).collect();
        let loose = phase != Phase::Strict;
        let mut fit = Fit::Yes;
        for (i, a) in args.iter().enumerate() {
            let Some(p) = self.param_at(c, i, phase) else { return Fit::No };
            fit = fit.min(self.arg_fits(a, &p, loose, &vars));
            if fit == Fit::No {
                return Fit::No;
            }
        }
        fit
    }

    /// `a` is more specific than `b` for these arguments (JLS §15.12.2.5, by parameter types).
    fn more_specific(&self, a: &Candidate, b: &Candidate, args: usize, phase: Phase) -> bool {
        let k = if phase == Phase::Varargs { args.max(a.method.params.len()).max(b.method.params.len()) } else { args };
        let vars: Vec<TypeVar> = b.method.type_params.iter().map(|p| p.var.clone()).collect();
        (0..k).all(|i| match (self.param_at(a, i, phase), self.param_at(b, i, phase)) {
            (Some(x), Some(y)) => {
                // A functional interface parameter vs another (both lambdas fit): equal here.
                let x = self.model.erasure(&x);
                let y = self.model.erasure(&y);
                x == y || self.fits(&x, &y, false, &vars) == Fit::Yes
            }
            _ => true,
        })
    }

    /// Chooses the method invoked with `args` among `candidates` (JLS §15.12.2).
    pub(crate) fn choose(&self, candidates: Vec<Candidate>, args: &[Arg]) -> Choice {
        if candidates.is_empty() {
            return Choice::None;
        }
        // Arity alone: only one method could be meant.
        let by_arity: Vec<&Candidate> = candidates
            .iter()
            .filter(|c| {
                c.method.params.len() == args.len() || c.method.varargs && args.len() + 1 >= c.method.params.len()
            })
            .collect();
        if by_arity.is_empty() {
            return Choice::None;
        }
        if by_arity.len() == 1 {
            let c = by_arity[0];
            // Unless the one candidate cannot take the arguments at all.
            let any =
                [Phase::Strict, Phase::Loose, Phase::Varargs].iter().any(|p| self.applicable(c, args, *p) != Fit::No);
            return if any { Choice::Chosen(Box::new(c.clone())) } else { Choice::None };
        }
        for phase in [Phase::Strict, Phase::Loose, Phase::Varargs] {
            let fits: Vec<(Fit, &Candidate)> = candidates
                .iter()
                .map(|c| (self.applicable(c, args, phase), c))
                .filter(|(f, _)| *f != Fit::No)
                .collect();
            if fits.is_empty() {
                continue;
            }
            if fits.iter().any(|(f, _)| *f == Fit::Maybe) {
                // A doubtful candidate might be the more specific (or the only) one.
                let sure: Vec<&Candidate> = fits.iter().filter(|(f, _)| *f == Fit::Yes).map(|(_, c)| *c).collect();
                let doubtful: Vec<&Candidate> =
                    fits.iter().filter(|(f, _)| *f == Fit::Maybe).map(|(_, c)| *c).collect();
                // Safe only when a sure candidate is strictly more specific than every doubtful one.
                let winner = sure.iter().find(|s| {
                    doubtful.iter().all(|d| {
                        self.more_specific(s, d, args.len(), phase) && !self.more_specific(d, s, args.len(), phase)
                    }) && sure.iter().all(|o| std::ptr::eq(*o, **s) || self.more_specific(s, o, args.len(), phase))
                });
                return match winner {
                    Some(w) => Choice::Chosen(Box::new((*w).clone())),
                    None => Choice::Unknown,
                };
            }
            let applicable: Vec<&Candidate> = fits.into_iter().map(|(_, c)| c).collect();
            let maximal: Vec<&Candidate> = applicable
                .iter()
                .filter(|a| {
                    applicable.iter().all(|b| std::ptr::eq(**a, *b) || self.more_specific(a, b, args.len(), phase))
                })
                .copied()
                .collect();
            return match maximal.len() {
                1 => Choice::Chosen(Box::new(maximal[0].clone())),
                0 => Choice::Unknown,
                _ => {
                    // Override-equivalent maxima (JLS §15.12.2.5): a concrete one wins, else any
                    // abstract one stands for them all — but distinct declarations are not
                    // interchangeable targets, so only pick when one is concrete.
                    let concrete: Vec<&&Candidate> = maximal.iter().filter(|c| !c.method.is_abstract()).collect();
                    if concrete.len() == 1 { Choice::Chosen(Box::new((*concrete[0]).clone())) } else { Choice::Unknown }
                }
            };
        }
        // Nothing applicable: an error unless doubt about an argument hides the right one.
        if args.iter().any(|a| matches!(a, Arg::Ty(t) if t.has_unknown())) { Choice::Unknown } else { Choice::None }
    }

    // ---------------------------------------------------------------- inference

    /// Binds the method's type variables appearing in `param` from the argument type `arg`.
    pub(crate) fn unify(&self, param: &Type, arg: &Type, vars: &[TypeVar], out: &mut Subst) {
        if arg.is_unknown() {
            return;
        }
        match param {
            Type::Var(v) if vars.contains(v) => {
                if out.get(v).is_none() && !matches!(arg, Type::Null) {
                    out.put(v.clone(), TypeArg::Exact(boxed(arg)));
                }
            }
            Type::Array(pe) => {
                if let Type::Array(ae) = arg {
                    self.unify(pe, ae, vars, out);
                }
            }
            Type::Class(pc) if !pc.args.is_empty() => {
                let arg = boxed(arg);
                let Some(ac) = arg.as_class() else { return };
                let Some(view) = self.model.as_super(ac, &pc.key) else { return };
                for (p, a) in pc.args.iter().zip(&view.args) {
                    let (pt, at) = match (p, a) {
                        (
                            TypeArg::Exact(pt) | TypeArg::Extends(pt) | TypeArg::Super(pt),
                            TypeArg::Exact(at) | TypeArg::Extends(at) | TypeArg::Super(at),
                        ) => (pt, at),
                        _ => continue,
                    };
                    self.unify(pt, at, vars, out);
                }
            }
            _ => {}
        }
    }

    /// Binds variables of `ret` from the target type `target` (`List<String> x = emptyList()`).
    pub(crate) fn unify_target(&self, ret: &Type, target: &Type, vars: &[TypeVar], out: &mut Subst) {
        match (ret, target) {
            (Type::Var(v), _) if vars.contains(v) => {
                if out.get(v).is_none() && target.is_reference() && !target.has_unknown() {
                    out.put(v.clone(), TypeArg::Exact(target.clone()));
                }
            }
            (Type::Class(rc), Type::Class(tc)) if rc.key == tc.key => {
                for (r, t) in rc.args.iter().zip(&tc.args) {
                    if let (TypeArg::Exact(rt), TypeArg::Exact(tt) | TypeArg::Extends(tt) | TypeArg::Super(tt)) = (r, t)
                    {
                        self.unify_target(rt, tt, vars, out);
                    }
                }
            }
            (Type::Class(rc), Type::Class(tc)) => {
                // The return type seen as the target's class.
                if let Some(view) = self.model.as_super(rc, &tc.key) {
                    self.unify_target(&Type::Class(view), target, vars, out);
                }
            }
            _ => {}
        }
    }
}
