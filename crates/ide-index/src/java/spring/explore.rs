//! The model as the Spring tool window and the Bean dependency graph see it (IDEA's Spring
//! tool window and Spring Beans Dependencies diagram): application contexts, their beans,
//! a bean's dependencies and dependents, and the dependency graph of a context.
//!
//! Beans are named by a stable id (their declaration, not their index in the model), so a
//! selection survives model rebuilds.

use super::markers::{SpringPresence, bean_target, multi_module};
use super::matching::{Outcome, Resolution, Supers, resolve};
use super::*;
use ide_core::{IpcPath, Location};
use specta::Type;

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpringContextInfo {
    pub id: String,
    pub label: String,
    pub kind: ContextKind,
    /// The application / configuration class.
    pub root: Option<Location>,
    /// The build module's folder name, when the project has several.
    pub module: Option<String>,
    pub test: bool,
    pub beans: u32,
    /// Beans may come from where the model cannot see.
    pub unknown_sources: bool,
}

/// Where a bean comes from, for grouping and colours (IDEA: libraries yellow, tests green).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SpringBeanSource {
    Project,
    Library,
    /// The framework's own (`applicationContext`, `environment`…): IDEA's implicit beans.
    Framework,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpringBeanInfo {
    /// Stable: its declaration and name.
    pub id: String,
    pub name: String,
    pub aliases: Vec<String>,
    /// The bean's type: simple and qualified.
    pub type_name: String,
    pub type_fqn: String,
    pub kind: BeanKind,
    pub source: SpringBeanSource,
    /// Its declaration (empty for library and framework beans).
    pub location: Option<Location>,
    /// A library bean's JDT handle (`spring_locate`).
    pub handle: Option<String>,
    /// `OrderService`, `Cfg.dataSource()`, `DataSourceConfiguration.Hikari.dataSource()`.
    pub declaration: String,
    /// The build module (project beans of a multi-module project) or the jar (library beans).
    pub module: Option<String>,
    pub primary: bool,
    pub fallback: bool,
    pub presence: SpringPresence,
    pub test: bool,
    pub scope: Option<String>,
    pub lazy: bool,
    pub profiles: Vec<String>,
    /// Condition annotations (simple names).
    pub conditions: Vec<String>,
    /// `@Qualifier` values and custom qualifier annotations (simple names).
    pub qualifiers: Vec<String>,
}

/// How a dependency is declared (IDEA's diagram edge labels).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SpringEdgeKind {
    Autowired,
    Resource,
    Inject,
    /// A `@Bean` method's parameter.
    BeanParam,
    /// A configuration class creates its `@Bean`s.
    Creates,
    /// `@DependsOn`.
    DependsOn,
}

/// One injection point of a bean and what it receives.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpringDependency {
    /// `orderService`, `OrderController(orders)`.
    pub label: String,
    pub location: Option<Location>,
    pub kind: SpringEdgeKind,
    /// The type looked for, as written (simple).
    pub wanted: String,
    pub resolution: super::SpringResolution,
    /// Bean ids: the injected one first.
    pub beans: Vec<String>,
}

/// A bean injecting this one.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpringDependent {
    pub bean: String,
    pub label: String,
    pub location: Option<Location>,
    pub kind: SpringEdgeKind,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpringBeanDetail {
    pub bean: SpringBeanInfo,
    pub dependencies: Vec<SpringDependency>,
    pub dependents: Vec<SpringDependent>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpringEdge {
    pub from: String,
    pub to: String,
    pub kind: SpringEdgeKind,
    /// The candidates are not decided (several beans, or conditional ones).
    pub uncertain: bool,
    /// Part of a dependency cycle.
    pub cycle: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpringGraph {
    pub nodes: Vec<SpringBeanInfo>,
    pub edges: Vec<SpringEdge>,
    /// More nodes than `limit`: the rest are left out.
    pub truncated: bool,
}

// ---------------------------------------------------------------------------

/// A bean's stable id.
pub fn bean_id(view: &JavaView, b: &BeanDef) -> String {
    let declared = |owner: TypeId, method: Option<u32>| {
        let fqn = view.qualified_name(owner).unwrap_or_default();
        match method.and_then(|m| view.ty(owner)?.members.get(m as usize)) {
            Some(m) => format!("{fqn}#{}", m.name),
            None => fqn,
        }
    };
    match &b.origin {
        BeanOrigin::Library { handle, .. } => format!("lib:{handle}/{}", b.name),
        BeanOrigin::Framework => format!("fw:{}", b.name),
        BeanOrigin::Provided { provider } => {
            format!("{provider}:{}/{}", b.owner.map(|o| declared(o, None)).unwrap_or_default(), b.name)
        }
        _ => format!("{}/{}", b.owner.map(|o| declared(o, b.method)).unwrap_or_default(), b.name),
    }
}

fn type_names(view: &JavaView, b: &BeanDef) -> (String, String) {
    match &b.ty.ty {
        Resolved::Source(id) => {
            let fqn = view.qualified_name(*id).unwrap_or_default();
            (view.ty(*id).map(|t| t.name.clone()).unwrap_or_else(|| simple(&fqn).to_owned()), fqn)
        }
        Resolved::External(e) => (simple(e).to_owned(), e.clone()),
    }
}

fn info(view: &JavaView, model: &SpringModel, b: &BeanDef, multi: bool) -> SpringBeanInfo {
    let target = bean_target(view, model, Path::new(""), b, multi);
    let (type_name, type_fqn) = type_names(view, b);
    let source = match b.origin {
        BeanOrigin::Library { .. } => SpringBeanSource::Library,
        BeanOrigin::Framework => SpringBeanSource::Framework,
        _ => SpringBeanSource::Project,
    };
    let (location, handle, declaration, module) = match target {
        Some(t) => (t.handle.is_none().then_some(t.location), t.handle, t.owner, t.module),
        None => (None, None, type_name.clone(), None),
    };
    SpringBeanInfo {
        id: bean_id(view, b),
        name: b.name.clone(),
        aliases: b.aliases.clone(),
        type_name,
        type_fqn,
        kind: b.kind,
        source,
        location,
        handle,
        declaration,
        module,
        primary: b.primary,
        fallback: b.fallback,
        presence: b.presence.into(),
        test: b.test,
        scope: b.scope.clone(),
        lazy: b.lazy,
        profiles: b.profiles.clone(),
        conditions: b.conditions.iter().map(|c| simple(c).to_owned()).collect(),
        qualifiers: b
            .qualifiers
            .iter()
            .map(|q| match &q.value {
                Some(v) if q.annotation == super::annotations::QUALIFIER => v.clone(),
                Some(v) => format!("@{}(\"{v}\")", simple(&q.annotation)),
                None => format!("@{}", simple(&q.annotation)),
            })
            .collect(),
    }
}

impl SpringModel {
    /// The contexts, Boot applications first.
    pub fn context_infos(&self, view: &JavaView) -> Vec<SpringContextInfo> {
        let multi = multi_module(self);
        let mut out: Vec<SpringContextInfo> = self
            .contexts
            .iter()
            .map(|c| {
                let root = c.root.and_then(|r| {
                    let stub = view.stub(r.file)?;
                    let t = stub.types.get(r.ty as usize)?;
                    let end = Pos::new(t.at.line, t.at.col + t.name.encode_utf16().count() as u32);
                    Some(Location {
                        path: IpcPath::from(view.path(r.file)?.to_path_buf()),
                        range: ide_core::Range::new(t.at, end),
                        uri: None,
                    })
                });
                SpringContextInfo {
                    id: c.id.clone(),
                    label: c.label.clone(),
                    kind: c.kind,
                    root,
                    module: if multi {
                        c.root
                            .and_then(|r| self.module_of(r.file))
                            .and_then(|m| m.file_name())
                            .map(|n| n.to_string_lossy().into_owned())
                    } else {
                        None
                    },
                    test: c.test,
                    beans: c.beans.len() as u32,
                    unknown_sources: c.unknown_sources,
                }
            })
            .collect();
        out.sort_by_key(|c| (c.test, c.kind != ContextKind::Boot, c.label.to_lowercase()));
        out
    }

    fn context_index(&self, id: Option<&str>) -> Option<usize> {
        match id {
            Some(id) => self.contexts.iter().position(|c| c.id == id),
            None => None,
        }
    }

    /// The beans of context `id` (every bean of the model without one).
    fn context_beans(&self, id: Option<&str>) -> Vec<usize> {
        match self.context_index(id) {
            Some(c) => {
                let mut beans = self.contexts[c].beans.clone();
                beans.sort_unstable();
                beans.dedup();
                beans
            }
            None => (0..self.beans.len()).collect(),
        }
    }

    pub fn bean_infos(&self, view: &JavaView, context: Option<&str>) -> Vec<SpringBeanInfo> {
        let multi = multi_module(self);
        self.context_beans(context).into_iter().map(|b| info(view, self, &self.beans[b], multi)).collect()
    }

    /// The bean with stable id `id` among the beans of `context`.
    fn find(&self, view: &JavaView, context: Option<&str>, id: &str) -> Option<usize> {
        self.context_beans(context).into_iter().find(|&b| bean_id(view, &self.beans[b]) == id)
    }

    /// The bean an injection point belongs to: its class, or the `@Bean` it is a parameter of.
    fn owning_bean(&self, ip: &InjectionPoint, pool: &HashSet<usize>) -> Option<usize> {
        pool.iter().copied().find(|&b| {
            let bean = &self.beans[b];
            bean.owner == Some(ip.owner)
                && match ip.kind {
                    InjectionKind::BeanMethodParam => bean.method == Some(ip.member),
                    _ => bean.method.is_none(),
                }
        })
    }

    /// Every dependency edge among the beans of `pool`.
    fn edges(&self, view: &JavaView, pool: &HashSet<usize>) -> Vec<(usize, usize, SpringEdgeKind, bool, usize)> {
        let mut supers = Supers::default();
        let mut out = Vec::new();
        for (ii, ip) in self.injections.iter().enumerate() {
            let Some(from) = self.owning_bean(ip, pool) else { continue };
            let r = resolve(view, self, ip, &mut supers);
            let kind = edge_kind(view, ip);
            let (targets, uncertain) = targets(&r);
            for t in targets {
                if pool.contains(&t) && t != from {
                    out.push((from, t, kind, uncertain, ii));
                }
            }
        }
        // `@Bean` methods are created by their configuration class.
        for &b in pool {
            let bean = &self.beans[b];
            if bean.method.is_some()
                && let Some(config) = pool.iter().copied().find(|&c| {
                    let cb = &self.beans[c];
                    cb.owner == bean.owner && cb.method.is_none()
                })
            {
                out.push((config, b, SpringEdgeKind::Creates, false, usize::MAX));
            }
        }
        out
    }

    pub fn bean_detail(&self, view: &JavaView, context: Option<&str>, id: &str) -> Option<SpringBeanDetail> {
        let b = self.find(view, context, id)?;
        let multi = multi_module(self);
        let pool: HashSet<usize> = self.context_beans(context).into_iter().collect();
        let bean = &self.beans[b];
        let mut supers = Supers::default();
        let mut dependencies = Vec::new();
        for ip in &self.injections {
            if self.owning_bean(ip, &pool) != Some(b) {
                continue;
            }
            let r = resolve(view, self, ip, &mut supers);
            let (shown, _) = targets(&r);
            dependencies.push(SpringDependency {
                label: ip.name.clone(),
                location: injection_location(view, ip),
                kind: edge_kind(view, ip),
                wanted: match &ip.wanted.ty {
                    Resolved::Source(id) => view.ty(*id).map(|t| t.name.clone()).unwrap_or_default(),
                    Resolved::External(e) => simple(e).to_owned(),
                },
                resolution: super::markers::resolution_of(&r),
                beans: shown
                    .iter()
                    .chain(r.beans.iter().filter(|x| !shown.contains(x)))
                    .map(|&t| bean_id(view, &self.beans[t]))
                    .collect(),
            });
        }
        let mut dependents = Vec::new();
        for ip in &self.injections {
            let Some(from) = self.owning_bean(ip, &pool) else { continue };
            if from == b {
                continue;
            }
            let wanted = match &ip.wanted.ty {
                Resolved::Source(id) => view.ty(*id).map_or("", |t| t.name.as_str()),
                Resolved::External(e) => simple(e),
            };
            if !bean.type_names.iter().any(|n| n == wanted) {
                continue;
            }
            let r = resolve(view, self, ip, &mut supers);
            if targets(&r).0.contains(&b) {
                dependents.push(SpringDependent {
                    bean: bean_id(view, &self.beans[from]),
                    label: format!("{}.{}", self.beans[from].name, ip.name),
                    location: injection_location(view, ip),
                    kind: edge_kind(view, ip),
                });
            }
        }
        Some(SpringBeanDetail { bean: info(view, self, bean, multi), dependencies, dependents })
    }

    /// The dependency graph of `context`: around `roots` (bean ids) up to `depth` steps in
    /// either direction, else the whole context; library and framework beans only when asked
    /// (or when they are roots). At most `limit` nodes.
    pub fn graph(
        &self,
        view: &JavaView,
        context: Option<&str>,
        roots: &[String],
        depth: u32,
        libraries: bool,
        limit: usize,
    ) -> SpringGraph {
        let multi = multi_module(self);
        let root_ix: HashSet<usize> = roots.iter().filter_map(|r| self.find(view, context, r)).collect();
        let pool: HashSet<usize> = self
            .context_beans(context)
            .into_iter()
            .filter(|&b| {
                root_ix.contains(&b)
                    || libraries
                    || !matches!(self.beans[b].origin, BeanOrigin::Library { .. } | BeanOrigin::Framework)
            })
            .collect();
        let all = self.edges(view, &pool);
        let mut chosen: Vec<usize> = Vec::new();
        let mut truncated = false;
        if roots.is_empty() {
            chosen = pool.iter().copied().collect();
            chosen.sort_by_key(|&b| self.beans[b].name.to_lowercase());
        } else {
            let mut seen: HashSet<usize> = root_ix.clone();
            chosen.extend(root_ix.iter().copied());
            let mut frontier: Vec<usize> = root_ix.iter().copied().collect();
            for _ in 0..depth {
                let mut next = Vec::new();
                for &n in &frontier {
                    for (f, t, ..) in &all {
                        let other = if *f == n {
                            *t
                        } else if *t == n {
                            *f
                        } else {
                            continue;
                        };
                        if seen.insert(other) {
                            chosen.push(other);
                            next.push(other);
                        }
                    }
                }
                frontier = next;
            }
        }
        if chosen.len() > limit {
            chosen.truncate(limit);
            truncated = true;
        }
        let set: HashSet<usize> = chosen.iter().copied().collect();
        let cycles = cyclic(&all, &set);
        let mut edges: Vec<SpringEdge> = Vec::new();
        for (f, t, kind, uncertain, _) in &all {
            if !(set.contains(f) && set.contains(t)) {
                continue;
            }
            let (from, to) = (bean_id(view, &self.beans[*f]), bean_id(view, &self.beans[*t]));
            if edges.iter().any(|e| e.from == from && e.to == to && e.kind == *kind) {
                continue;
            }
            edges.push(SpringEdge {
                from,
                to,
                kind: *kind,
                uncertain: *uncertain,
                cycle: *kind != SpringEdgeKind::Creates && cycles.contains(&(*f, *t)),
            });
        }
        SpringGraph {
            nodes: chosen.into_iter().map(|b| info(view, self, &self.beans[b], multi)).collect(),
            edges,
            truncated,
        }
    }
}

/// The beans an injection point receives (and whether that is undecided).
fn targets(r: &Resolution) -> (Vec<usize>, bool) {
    match r.outcome {
        Outcome::Unique(u) => (vec![u], false),
        Outcome::Many => (r.beans.clone(), false),
        Outcome::Ambiguous | Outcome::Conditional => (r.beans.clone(), true),
        Outcome::None => (Vec::new(), false),
    }
}

fn edge_kind(view: &JavaView, ip: &InjectionPoint) -> SpringEdgeKind {
    if ip.kind == InjectionKind::BeanMethodParam {
        return SpringEdgeKind::BeanParam;
    }
    let annotations = view.ty(ip.owner).and_then(|t| t.members.get(ip.member as usize)).map(|m| {
        let mut names: Vec<&str> = m.annotations.iter().map(|a| simple(a)).collect();
        if let Some(p) = ip.param.and_then(|p| m.param_details.get(p as usize)) {
            names.extend(p.annotations.iter().map(|a| simple(a)));
        }
        names.into_iter().map(str::to_owned).collect::<Vec<_>>()
    });
    let has = |n: &str| annotations.as_ref().is_some_and(|a| a.iter().any(|x| x == n));
    if ip.resource || has("Resource") {
        SpringEdgeKind::Resource
    } else if has("Inject") {
        SpringEdgeKind::Inject
    } else {
        SpringEdgeKind::Autowired
    }
}

fn injection_location(view: &JavaView, ip: &InjectionPoint) -> Option<Location> {
    let at = ip.at(view)?;
    let end = Pos::new(at.line, at.col + ip.name.encode_utf16().count() as u32);
    Some(Location {
        path: IpcPath::from(view.path(ip.owner.file)?.to_path_buf()),
        range: ide_core::Range::new(at, end),
        uri: None,
    })
}

/// Edges (by bean index) on a cycle among `set` (Tarjan's strongly connected components).
fn cyclic(edges: &[(usize, usize, SpringEdgeKind, bool, usize)], set: &HashSet<usize>) -> HashSet<(usize, usize)> {
    let mut adj: HashMap<usize, Vec<usize>> = HashMap::new();
    for (f, t, kind, ..) in edges {
        if *kind != SpringEdgeKind::Creates && set.contains(f) && set.contains(t) {
            adj.entry(*f).or_default().push(*t);
        }
    }
    struct S {
        index: HashMap<usize, usize>,
        low: HashMap<usize, usize>,
        stack: Vec<usize>,
        on: HashSet<usize>,
        next: usize,
        comp: HashMap<usize, usize>,
        comps: usize,
    }
    fn visit(v: usize, adj: &HashMap<usize, Vec<usize>>, s: &mut S) {
        s.index.insert(v, s.next);
        s.low.insert(v, s.next);
        s.next += 1;
        s.stack.push(v);
        s.on.insert(v);
        for &w in adj.get(&v).into_iter().flatten() {
            if !s.index.contains_key(&w) {
                visit(w, adj, s);
                let lw = s.low[&w];
                let lv = s.low.get_mut(&v).unwrap();
                *lv = (*lv).min(lw);
            } else if s.on.contains(&w) {
                let iw = s.index[&w];
                let lv = s.low.get_mut(&v).unwrap();
                *lv = (*lv).min(iw);
            }
        }
        if s.low[&v] == s.index[&v] {
            while let Some(w) = s.stack.pop() {
                s.on.remove(&w);
                s.comp.insert(w, s.comps);
                if w == v {
                    break;
                }
            }
            s.comps += 1;
        }
    }
    let mut s = S {
        index: HashMap::new(),
        low: HashMap::new(),
        stack: Vec::new(),
        on: HashSet::new(),
        next: 0,
        comp: HashMap::new(),
        comps: 0,
    };
    let mut nodes: Vec<usize> = adj.keys().copied().collect();
    nodes.sort_unstable();
    for v in nodes {
        if !s.index.contains_key(&v) {
            visit(v, &adj, &mut s);
        }
    }
    let mut out = HashSet::new();
    for (f, ts) in &adj {
        for t in ts {
            if f == t || s.comp.get(f) == s.comp.get(t) {
                out.insert((*f, *t));
            }
        }
    }
    out
}
