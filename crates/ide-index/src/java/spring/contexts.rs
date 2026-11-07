//! Application contexts (IDEA's Spring facet file sets, detected automatically): Boot
//! applications and `@ComponentScan` configurations, their scanned packages and `@Import`
//! closure. Which beans each holds decides what an injection point there can receive.

use super::super::Resolved as JResolved;
use super::annotations::*;
use super::collect::{Ann, resolve_all, type_names};
use super::*;

fn package_of(view: &JavaView, id: TypeId) -> String {
    view.stub(id.file).map(|s| s.package.clone()).unwrap_or_default()
}

fn in_packages(pkg: &str, bases: &[String]) -> bool {
    bases.iter().any(|b| b.is_empty() || pkg == b || pkg.strip_prefix(b.as_str()).is_some_and(|r| r.starts_with('.')))
}

/// Packages a scan annotation names: `value` / `basePackages` / `scanBasePackages`, and the
/// packages of `basePackageClasses` / `scanBasePackageClasses`.
fn scan_packages(view: &JavaView, owner: TypeId, ann: &JavaAnnotation, prefix: &str) -> Vec<String> {
    let key = |k: &str| {
        if prefix.is_empty() { k.to_owned() } else { format!("{prefix}{}{}", k[..1].to_uppercase(), &k[1..]) }
    };
    let mut out: Vec<String> = Vec::new();
    for k in ["value", "basePackages"] {
        if prefix.is_empty() || k != "value" {
            out.extend(ann.arg(&key(k)).into_iter().flat_map(|v| v.strings()).map(str::to_owned));
        }
    }
    for class in ann.arg(&key("basePackageClasses")).into_iter().flat_map(|v| v.classes()) {
        match view.resolve(owner, class) {
            JResolved::Source(id) => out.push(package_of(view, id)),
            JResolved::External(q) => {
                if let Some((p, _)) = q.rsplit_once('.') {
                    out.push(p.to_owned());
                }
            }
        }
    }
    out
}

/// `@Enable…` annotations and imports of types outside the sources register beans the model
/// cannot see.
fn opaque_registration(meta: &AnnotationMeta, anns: &[Ann]) -> bool {
    anns.iter()
        .any(|a| simple(&a.fqn).starts_with("Enable") && !meta.knows(&a.fqn) || a.fqn == ENABLE_AUTO_CONFIGURATION)
}

struct Builder<'v, 'a> {
    view: &'v JavaView<'a>,
    /// Bean index by declaring class, for class beans (scanned, provided, imported).
    class_beans: HashMap<TypeId, Vec<usize>>,
    /// `@Bean` methods by declaring class.
    factories: HashMap<TypeId, Vec<usize>>,
}

pub(super) fn detect(view: &JavaView, model: &mut SpringModel) {
    let mut b = Builder { view, class_beans: HashMap::new(), factories: HashMap::new() };
    for (i, bean) in model.beans.iter().enumerate() {
        let Some(owner) = bean.owner else { continue };
        match bean.origin {
            BeanOrigin::Factory { .. } => b.factories.entry(owner).or_default().push(i),
            _ => b.class_beans.entry(owner).or_default().push(i),
        }
    }

    // Roots: Boot application classes (`@SpringBootConfiguration`, directly or meta).
    let mut roots: Vec<(TypeId, ContextKind)> = Vec::new();
    for (file, stub) in files(view) {
        for (ti, t) in stub.types.iter().enumerate() {
            if t.kind != JavaTypeKind::Class || t.is(LOCAL) || t.annotation_args.is_empty() {
                continue;
            }
            let id = TypeId { file, ty: ti as u32 };
            let anns = resolve_all(view, &model.meta, file, Some(id), &t.annotation_args);
            if anns.iter().any(|a| model.meta.is_meta_annotated(&a.fqn, SPRING_BOOT_CONFIGURATION)) {
                roots.push((id, ContextKind::Boot));
            }
        }
    }
    // Plain Spring: `@ComponentScan` configurations no Boot application scans.
    let boot_scans: Vec<(TypeId, Vec<String>)> =
        roots.iter().map(|(id, _)| (*id, b.root_scan(&model.meta, *id))).collect();
    for (file, stub) in files(view) {
        for (ti, t) in stub.types.iter().enumerate() {
            if t.kind != JavaTypeKind::Class || t.is(LOCAL) || t.annotation_args.is_empty() || model.is_test_file(file)
            {
                continue;
            }
            let id = TypeId { file, ty: ti as u32 };
            if roots.iter().any(|(r, _)| *r == id) {
                continue;
            }
            let anns = resolve_all(view, &model.meta, file, Some(id), &t.annotation_args);
            let scan = anns.iter().any(|a| a.fqn == COMPONENT_SCAN);
            let config = anns.iter().any(|a| model.meta.is_meta_annotated(&a.fqn, CONFIGURATION));
            if scan && config && !boot_scans.iter().any(|(_, s)| in_packages(&stub.package, s)) {
                roots.push((id, ContextKind::Config));
            }
        }
    }

    for (root, kind) in roots {
        let ctx = b.context(model, root, kind);
        model.contexts.push(ctx);
    }
    // Framework beans are in every context.
    let framework: Vec<usize> =
        model.beans.iter().enumerate().filter(|(_, b)| b.origin == BeanOrigin::Framework).map(|(i, _)| i).collect();
    for c in &mut model.contexts {
        c.beans.extend(&framework);
    }
    // The contexts of every type with beans or injection points: main code is in main contexts
    // only; a test application serves the tests of its own module.
    let mut owners: Vec<TypeId> = model.injections.iter().map(|i| i.owner).collect();
    owners.extend(model.beans.iter().filter_map(|b| b.owner));
    owners.sort_by_key(|t| (t.file, t.ty));
    owners.dedup();
    for owner in owners {
        let pkg = package_of(view, owner);
        let test = model.is_test_file(owner.file);
        let module = model.module_of(owner.file).map(Path::to_path_buf);
        let ctxs: Vec<usize> = model
            .contexts
            .iter()
            .enumerate()
            .filter(|(_, c)| {
                if c.test
                    && (!test || c.root.map(|r| model.module_of(r.file).map(Path::to_path_buf)) != Some(module.clone()))
                {
                    return false;
                }
                c.beans.iter().any(|&bi| model.beans[bi].owner == Some(owner)) || in_packages(&pkg, &c.scan)
            })
            .map(|(i, _)| i)
            .collect();
        if !ctxs.is_empty() {
            model.type_contexts.insert(owner, ctxs);
        }
    }
}

impl<'a> Builder<'_, 'a> {
    fn anns(&self, meta: &AnnotationMeta, id: TypeId) -> Vec<Ann<'a>> {
        let Some(stub) = self.view.stub(id.file) else { return Vec::new() };
        let Some(t) = stub.types.get(id.ty as usize) else { return Vec::new() };
        resolve_all(self.view, meta, id.file, Some(id), &t.annotation_args)
    }

    /// The packages a root scans: its own (when it has no explicit base packages), the
    /// application annotation's `scanBasePackages`, and its `@ComponentScan`s.
    fn root_scan(&self, meta: &AnnotationMeta, root: TypeId) -> Vec<String> {
        let anns = self.anns(meta, root);
        let mut out = Vec::new();
        for a in &anns {
            if a.fqn == SPRING_BOOT_APPLICATION {
                out.extend(scan_packages(self.view, root, a.ann, "scan"));
            } else if a.fqn == COMPONENT_SCAN {
                out.extend(scan_packages(self.view, root, a.ann, ""));
            }
        }
        if out.is_empty() {
            out.push(package_of(self.view, root));
        }
        out.sort();
        out.dedup();
        out
    }

    fn context(&mut self, model: &mut SpringModel, root: TypeId, kind: ContextKind) -> SpringContext {
        let view = self.view;
        let mut scan = self.root_scan(&model.meta, root);
        let mut members: HashSet<usize> = HashSet::new();
        // Boot: auto-configuration adds beans the library model (when known) brings in.
        let mut opaque = false;
        let mut imported: Vec<TypeId> = vec![root];
        let mut done: HashSet<TypeId> = HashSet::new();
        // Scanned and provided beans in the scanned packages; their configuration classes'
        // `@ComponentScan`, `@Import` and `@Enable…` extend the context, until nothing changes.
        loop {
            let before = (members.len(), scan.len(), imported.len());
            for (owner, beans) in &self.class_beans {
                if !in_packages(&package_of(view, *owner), &scan) {
                    continue;
                }
                for &bi in beans {
                    if matches!(model.beans[bi].origin, BeanOrigin::Scanned { .. } | BeanOrigin::Provided { .. }) {
                        members.insert(bi);
                    }
                }
            }
            let configs: Vec<TypeId> = members
                .iter()
                .filter(|&&bi| model.beans[bi].kind == BeanKind::Configuration)
                .filter_map(|&bi| model.beans[bi].owner)
                .chain(imported.iter().copied())
                .collect();
            for cfg in configs {
                if !done.insert(cfg) {
                    continue;
                }
                let anns = self.anns(&model.meta, cfg);
                opaque |= opaque_registration(&model.meta, &anns);
                for a in &anns {
                    if a.fqn == COMPONENT_SCAN && cfg != root {
                        for p in scan_packages(view, cfg, a.ann, "") {
                            if !scan.contains(&p) {
                                scan.push(p);
                            }
                        }
                    }
                    if a.fqn == IMPORT {
                        for class in a.ann.arg("value").into_iter().flat_map(|v| v.classes()) {
                            match view.resolve(cfg, class) {
                                JResolved::Source(id) => {
                                    if !imported.contains(&id) {
                                        imported.push(id);
                                    }
                                }
                                JResolved::External(_) => opaque = true,
                            }
                        }
                    }
                }
            }
            // Imported classes are beans (configurations) even without a stereotype.
            for id in imported.clone() {
                match self.class_beans.get(&id) {
                    Some(beans) => members.extend(beans.iter().copied()),
                    None => {
                        let bi = model.beans.len();
                        let ty = JResolved::Source(id);
                        let name = view.qualified_name(id).unwrap_or_default();
                        model.beans.push(BeanDef {
                            name,
                            aliases: Vec::new(),
                            type_names: type_names(view, &ty),
                            ty: TypeRef { ty, args: Vec::new() },
                            owner: Some(id),
                            method: None,
                            origin: BeanOrigin::Imported,
                            kind: BeanKind::Configuration,
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
                            test: model.is_test_file(id.file),
                            supertypes: Vec::new(),
                        });
                        self.class_beans.insert(id, vec![bi]);
                        members.insert(bi);
                    }
                }
            }
            if (members.len(), scan.len(), imported.len()) == before {
                break;
            }
        }
        // A test application lives on its module's test classpath: other modules' beans stay out.
        let test = model.is_test_file(root.file);
        if test {
            let module = model.module_of(root.file).map(Path::to_path_buf);
            members.retain(|&bi| {
                model.beans[bi].owner.is_some_and(|o| model.module_of(o.file).map(Path::to_path_buf) == module)
            });
        }
        // `@Bean` methods of the member classes (full and lite configuration).
        let owners: Vec<TypeId> = members.iter().filter_map(|&bi| model.beans[bi].owner).collect();
        for owner in owners {
            members.extend(self.factories.get(&owner).into_iter().flatten().copied());
        }
        let mut beans: Vec<usize> = members.into_iter().collect();
        beans.sort_unstable();
        let fqn = view.qualified_name(root).unwrap_or_default();
        let label = view.ty(root).map(|t| t.name.clone()).unwrap_or_default();
        SpringContext {
            id: format!("{}:{fqn}", if kind == ContextKind::Boot { "boot" } else { "config" }),
            label,
            kind,
            root: Some(root),
            scan,
            beans,
            unknown_sources: opaque || test || kind == ContextKind::Boot,
            opaque,
            test,
        }
    }
}
