//! Luma's Java engine against jdtls on a real project: every reference identifier of sampled
//! files resolved by the engine and by jdtls's Go to Definition, compared.
//!
//! `#[ignore]`d: needs jdtls, a JDK and a project copy jdtls may write metadata into:
//! `LUMA_JAVA_PROJECT=/copy/of/project LUMA_RESOLVE_FILES=40 \
//!  cargo test -p ide-host --release --test java_resolve_real -- --ignored --nocapture`

use futures::StreamExt;
use ide_core::{NullSink, Pos};
use ide_host::{Host, HostConfig, ops};
use ide_java::model::{Model, Origin};
use ide_java::resolve::{FileAnalysis, Resolution, Target, method_desc};
use ide_lsp::types::GotoKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn host(base: &Path) -> Arc<Host> {
    Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: true,
    }))
}

fn pos_of(text: &str, byte: usize) -> Pos {
    let before = &text[..byte];
    let line = before.matches('\n').count() as u32;
    let col = before.rsplit('\n').next().unwrap_or("").encode_utf16().count() as u32;
    Pos::new(line, col)
}

#[derive(Clone, Debug, PartialEq)]
enum Expect {
    Source(PathBuf, Pos),
    /// Top-level class binary name (`java/util/Map`).
    Library(String),
    /// Implicit members (default constructors, Lombok's): no declaration to compare.
    Skip,
}

#[derive(Debug)]
struct Occurrence {
    pos: Pos,
    name: String,
    engine: Result<Expect, &'static str>,
    /// The name of a method reference: jdtls's Go to Definition opens the functional
    /// interface's method there, not the method referenced.
    method_ref: bool,
}

fn expect_of(model: &Model, target: &Target, path: &Path, text: &str) -> Expect {
    let view = model.view;
    let source_member = |class: &str, name: &str, method: Option<&str>| -> Option<Expect> {
        let c = model.class(class)?;
        let Origin::Source(id) = c.origin else { return None };
        let file = view.path(id.file).map(Path::to_owned).unwrap_or_else(|| path.to_owned());
        let t = view.ty(id)?;
        match method {
            None => {
                let m = t.members.iter().find(|m| m.name == name)?;
                Some(Expect::Source(file, m.at))
            }
            Some(desc) => {
                let members = model.members(&c);
                let m = members.methods.iter().find(|m| (m.name == name) && method_desc(model, m) == desc)?;
                match m.source {
                    Some(i) => Some(Expect::Source(file, t.members.get(i as usize)?.at)),
                    None => Some(Expect::Skip),
                }
            }
        }
    };
    match target {
        Target::Local(byte) => Expect::Source(path.to_owned(), pos_of(text, *byte)),
        Target::Class(k) => match model.source_type(k) {
            Some(id) => match (view.path(id.file), view.ty(id)) {
                (Some(p), Some(t)) => Expect::Source(p.to_owned(), t.at),
                _ => Expect::Source(path.to_owned(), view.ty(id).map(|t| t.at).unwrap_or_default()),
            },
            None if k.contains("$#") => Expect::Skip,
            None => Expect::Library(k.split('$').next().unwrap_or(k).to_owned()),
        },
        Target::Field { class, name } => source_member(class, name, None).unwrap_or_else(|| {
            if model.source_type(class).is_some() {
                Expect::Skip
            } else {
                Expect::Library(class.split('$').next().unwrap_or(class).to_owned())
            }
        }),
        Target::Method { class, name, desc } => {
            let name = if name == "<init>" { class.rsplit(['/', '$']).next().unwrap_or(class) } else { name.as_str() };
            let lookup = if name == class.rsplit(['/', '$']).next().unwrap_or("") { "<init>" } else { name };
            source_member(class, lookup, Some(desc)).unwrap_or_else(|| {
                if model.source_type(class).is_some() || class.contains("Builder") {
                    Expect::Skip
                } else {
                    Expect::Library(class.split('$').next().unwrap_or(class).to_owned())
                }
            })
        }
        Target::Package(_) | Target::TypeVar(_) => Expect::Skip,
    }
}

/// The top-level class of a `jdt://contents/<jar>/<package>/<Class>.(class|java)?…` URI, as a
/// binary name (`java/util/Map`).
fn jdt_class(uri: &str) -> Option<String> {
    let before = uri.split('?').next()?;
    let mut segs = before.rsplit('/');
    let file = segs.next()?;
    let package = segs.next()?;
    // `.class`, or the attached source's extension (`.java`, `.kt` for Kotlin libraries).
    let class = file.rsplit_once('.').map(|(stem, _)| stem)?;
    let class = class.split('$').next().unwrap_or(class);
    Some(format!("{}/{class}", package.replace('.', "/")))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore = "requires jdtls, a JDK and LUMA_JAVA_PROJECT"]
async fn engine_agrees_with_jdtls_on_a_real_project() {
    let Ok(root) = std::env::var("LUMA_JAVA_PROJECT") else { return };
    let max_files: usize = std::env::var("LUMA_RESOLVE_FILES").ok().and_then(|v| v.parse().ok()).unwrap_or(40);
    let root = dunce::canonicalize(PathBuf::from(root)).unwrap();
    let base = tempfile::tempdir().unwrap();
    ide_host::trust::TrustStore::load(&base.path().join("config"), &base.path().join("data"))
        .decide(&root, true, false)
        .unwrap();
    let host = host(base.path());
    host.open_project("main", &root).unwrap();
    let project = host.project("main").unwrap();
    let started = Instant::now();
    assert!(project.index.wait_idle(Duration::from_secs(900)));
    println!("index ready in {:?}", started.elapsed());

    let mut files: Vec<PathBuf> = ignore::WalkBuilder::new(&root)
        .build()
        .flatten()
        .map(|e| e.into_path())
        .filter(|p| p.extension().is_some_and(|e| e == "java") && p.to_string_lossy().contains("/src/main/java/"))
        .collect();
    files.sort();
    let step = (files.len() / max_files.max(1)).max(1);
    let only = std::env::var("LUMA_RESOLVE_ONLY").ok();
    let sample: Vec<PathBuf> = match &only {
        Some(o) => files.iter().filter(|f| f.to_string_lossy().contains(o.as_str())).cloned().collect(),
        None => files.iter().step_by(step).take(max_files).cloned().collect(),
    };
    println!("{} Java files, {} sampled", files.len(), sample.len());

    // Start jdtls on the first file and wait for its import.
    let first = ops::doc::open(&host, "main", sample[0].clone()).await.unwrap();
    let started = Instant::now();
    loop {
        if project.java_engine.refresh(&project.lsp, &sample[0]).await {
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(1200), "jdtls never answered");
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    println!("jdtls ready in {:?}", started.elapsed());
    let _ = first;

    let (mut agree, mut disagree, mut undecided, mut missing, mut skipped, mut jdtls_none) = (0, 0, 0, 0, 0, 0);
    let mut method_refs = 0;
    let mut open: Vec<String> = Vec::new();
    let mut total = 0;
    let mut engine_time = Duration::ZERO;
    let mut reports: Vec<String> = Vec::new();
    let jdk = ide_sdk::apply::project_jdk(&root, &project.settings.effective()).map(|j| j.home);
    for path in &sample {
        project.java_engine.refresh(&project.lsp, path).await;
        let info = ops::doc::open(&host, "main", path.clone()).await.unwrap();
        let text = info.text.clone();
        let cp = project.java_engine.classpath(path, jdk.as_deref());
        let t0 = Instant::now();
        let occurrences: Vec<Occurrence> = project
            .index
            .with_java(path, &text, |view| {
                let tree = ide_java::parse(&text).unwrap();
                let model = Model::new(view, &cp).with_visibility(project.java_engine.visibility(path));
                let fa = FileAnalysis::new(&model, &tree, &text, view.overlay_file().unwrap());
                let mut out = Vec::new();
                let mut stack = vec![tree.root_node()];
                while let Some(n) = stack.pop() {
                    let mut c = n.walk();
                    stack.extend(n.children(&mut c));
                    if !matches!(n.kind(), "identifier" | "type_identifier") {
                        continue;
                    }
                    let mut anc = n.parent();
                    let mut in_header = false;
                    while let Some(a) = anc {
                        if matches!(a.kind(), "import_declaration" | "package_declaration") {
                            in_header = true;
                        }
                        anc = a.parent();
                    }
                    if in_header || fa.declared_target(n).is_some() || fa.node_text_pub(n) == "var" {
                        continue;
                    }
                    // `new T(…)`: Go to Definition on T opens the constructor called.
                    let creation = {
                        // Up through `Outer.Inner` / `C<…>` while n is the type's last name.
                        let mut ty = n;
                        while let Some(p) =
                            ty.parent().filter(|p| matches!(p.kind(), "generic_type" | "scoped_type_identifier"))
                        {
                            let mut c = p.walk();
                            let last = p.named_children(&mut c).filter(|x| x.kind() != "type_arguments").last();
                            if last.is_none_or(|l| l.id() != ty.id()) {
                                break;
                            }
                            ty = p;
                        }
                        ty.parent().filter(|p| {
                            p.kind() == "object_creation_expression"
                                && p.child_by_field_name("type").is_some_and(|t| t.id() == ty.id())
                        })
                    };
                    let resolved = match creation {
                        Some(c) => match fa.resolve_call(c) {
                            Resolution::Missing => fa.resolve(n),
                            r => r,
                        },
                        None => fa.resolve(n),
                    };
                    let engine = match resolved {
                        Resolution::Found(t) => Ok(expect_of(&model, &t, path, &text)),
                        Resolution::Missing => Err("missing"),
                        Resolution::Builtin => Ok(Expect::Skip),
                        Resolution::Unknown => Err("unknown"),
                    };
                    let method_ref = n.parent().is_some_and(|p| p.kind() == "method_reference");
                    out.push(Occurrence {
                        pos: pos_of(&text, n.start_byte()),
                        name: fa.node_text_pub(n).to_owned(),
                        engine,
                        method_ref,
                    });
                }
                out
            })
            .unwrap_or_default();
        engine_time += t0.elapsed();
        let unknowns = occurrences.iter().filter(|o| o.engine == Err("unknown")).count();
        if unknowns > 0 {
            println!(
                "  [{} unknown] {} module {:?}, {} class path roots",
                unknowns,
                path.strip_prefix(&root).unwrap_or(path).display(),
                project.java_engine.module_root(path).map(|m| m.strip_prefix(&root).map(Path::to_owned).unwrap_or(m)),
                cp.roots().len()
            );
        }
        let lsp = project.lsp.clone();
        let doc = info.id;
        let answers: Vec<(Occurrence, Option<ide_core::Location>)> =
            futures::stream::iter(occurrences.into_iter().map(|o| {
                let lsp = lsp.clone();
                async move {
                    let loc = lsp.goto(doc, o.pos, GotoKind::Definition).await.ok().and_then(|v| v.into_iter().next());
                    (o, loc)
                }
            }))
            .buffer_unordered(8)
            .collect()
            .await;
        for (o, loc) in answers {
            total += 1;
            let rel = path.strip_prefix(&root).unwrap_or(path).display().to_string();
            if o.method_ref && o.engine.is_ok() {
                method_refs += 1;
                continue;
            }
            match (&o.engine, &loc) {
                (Err(why), _) => {
                    if *why == "unknown" {
                        undecided += 1
                    } else {
                        missing += 1
                    }
                    let theirs = loc.as_ref().map(|l| {
                        l.uri
                            .clone()
                            .map(|u| jdt_class(&u).unwrap_or(u))
                            .unwrap_or_else(|| l.path.0.strip_prefix(&root).unwrap_or(&l.path.0).display().to_string())
                    });
                    open.push(format!(
                        "{why} {rel}:{}:{} `{}` (jdtls: {})",
                        o.pos.line + 1,
                        o.pos.col + 1,
                        o.name,
                        theirs.unwrap_or_default()
                    ));
                }
                (Ok(Expect::Skip), _) => skipped += 1,
                (Ok(_), None) => jdtls_none += 1,
                (Ok(Expect::Source(p, at)), Some(l)) => {
                    if l.uri.is_none() && l.path.0 == *p && l.range.start == *at {
                        agree += 1;
                    } else {
                        disagree += 1;
                        reports.push(format!(
                            "{rel}:{}:{} `{}`: engine {}:{}:{}, jdtls {}:{}:{}",
                            o.pos.line + 1,
                            o.pos.col + 1,
                            o.name,
                            p.strip_prefix(&root).unwrap_or(p).display(),
                            at.line + 1,
                            at.col + 1,
                            l.uri.clone().unwrap_or_else(|| l
                                .path
                                .0
                                .strip_prefix(&root)
                                .unwrap_or(&l.path.0)
                                .display()
                                .to_string()),
                            l.range.start.line + 1,
                            l.range.start.col + 1
                        ));
                    }
                }
                (Ok(Expect::Library(class)), Some(l)) => {
                    let theirs = l.uri.as_deref().and_then(jdt_class);
                    if theirs.as_deref() == Some(class.as_str()) {
                        agree += 1;
                    } else {
                        disagree += 1;
                        reports.push(format!(
                            "{rel}:{}:{} `{}`: engine library {class}, jdtls {}",
                            o.pos.line + 1,
                            o.pos.col + 1,
                            o.name,
                            l.uri.clone().unwrap_or_else(|| l.path.0.display().to_string())
                        ));
                    }
                }
            }
        }
        let _ = ops::doc::close(&host, "main", doc);
    }
    let decided = agree + disagree;
    println!(
        "{total} references: {agree} agree, {disagree} disagree, {undecided} undecided, {missing} missing, {skipped} implicit, {method_refs} method references, {jdtls_none} without a jdtls answer"
    );
    println!(
        "decided {:.1}%, agreement among decided {:.2}%, engine time {:?}",
        100.0 * (decided + skipped) as f64 / total.max(1) as f64,
        100.0 * agree as f64 / decided.max(1) as f64,
        engine_time
    );
    for r in reports.iter().take(200) {
        println!("  {r}");
    }
    // Most frequent undecided / missing names, then samples of each kind.
    let mut by_name: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for r in &open {
        let mut parts = r.split('`');
        let why = r.split(' ').next().unwrap_or("");
        let name = parts.nth(1).unwrap_or("");
        *by_name.entry(format!("{why} {name}")).or_default() += 1;
    }
    let mut names: Vec<_> = by_name.into_iter().collect();
    names.sort_by_key(|n| std::cmp::Reverse(n.1));
    println!("undecided / missing by name:");
    for (n, c) in names.iter().take(60) {
        println!("  {c:>5} {n}");
    }
    println!("undecided / missing samples:");
    let mut shown: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for r in &open {
        let key = r.split('`').nth(1).unwrap_or("").to_owned();
        let n = shown.entry(key).or_default();
        if *n < 2 {
            *n += 1;
            println!("  {r}");
        }
    }
}
