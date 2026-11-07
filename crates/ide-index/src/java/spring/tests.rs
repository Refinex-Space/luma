//! The Spring model against Spring's rules: one fixture per rule.

use super::*;
use crate::data::{FileEntry, FileRecord, IndexData};
use ide_core::LanguageId;
use ide_language::Syntax;
use std::path::{Path, PathBuf};

fn stub(text: &str) -> JavaStub {
    Syntax::new().with_parsed(&LanguageId::new("java"), text, &|| false, |p| extract(p.tree, p.text)).unwrap()
}

/// An index of `files` (`rel`, text) under `/p`.
fn index(files: &[(&str, &str)]) -> IndexData {
    let mut d = IndexData::default();
    for (rel, text) in files {
        let record = FileRecord { java: Some(stub(text)), ..Default::default() };
        d.insert(FileEntry::new(PathBuf::from("/p").join(rel), (*rel).to_owned(), record));
    }
    d
}

fn view<'a>(d: &'a IndexData, path: &str, stub: &'a JavaStub) -> JavaView<'a> {
    JavaView::new(d, Some(Overlay { file: d.slot(Path::new(path)), stub }))
}

/// `line:name Kind targets` of the Spring markers of `rel` among `files`.
fn markers_of(files: &[(&str, &str)], rel: &str, options: &SpringOptions) -> Vec<String> {
    let d = index(files);
    let text = files.iter().find(|(r, _)| *r == rel).unwrap().1;
    let s = stub(text);
    let path = format!("/p/{rel}");
    let v = view(&d, &path, &s);
    let model = SpringModel::build(&v, Path::new(&path), options);
    spring_markers(&v, &model, Path::new(&path), &[])
        .markers
        .iter()
        .map(|m| {
            let mut owners: Vec<&str> = m.targets.iter().map(|t| t.owner.as_str()).collect();
            owners.sort();
            format!("{}:{} {:?} {}", m.line, m.name, m.kind, owners.join(","))
        })
        .collect()
}

/// The resolution and candidate labels (the injected one first, the others sorted) of the injection
/// point `needle` names on `line` of `rel`.
fn candidates_of(
    files: &[(&str, &str)],
    rel: &str,
    line: u32,
    needle: &str,
    options: &SpringOptions,
) -> (SpringResolution, Vec<String>, bool) {
    let d = index(files);
    let text = files.iter().find(|(r, _)| *r == rel).unwrap().1;
    let s = stub(text);
    let path = format!("/p/{rel}");
    let v = view(&d, &path, &s);
    let model = SpringModel::build(&v, Path::new(&path), options);
    let col = text.lines().nth(line as usize).and_then(|l| l.find(needle)).expect("needle on the line") as u32;
    let c = candidates_at(&v, &model, Path::new(&path), Pos::new(line, col)).expect("an injection point");
    let mut labels: Vec<String> = c.candidates.iter().map(|t| t.label.clone()).collect();
    if labels.len() > 1 {
        let first = if c.resolution == SpringResolution::Unique { 1 } else { 0 };
        labels[first..].sort();
    }
    (c.resolution, labels, c.unknown_sources)
}

const FILES: &[(&str, &str)] = &[
    ("shop/Order.java", "package shop;\npublic class Order {}\n"),
    (
        "shop/OrderRepository.java",
        "package shop;\nimport org.springframework.data.jpa.repository.JpaRepository;\npublic interface OrderRepository extends JpaRepository<Order, Long> {}\n",
    ),
    ("shop/pay/PaymentGateway.java", "package shop.pay;\npublic interface PaymentGateway { void pay(); }\n"),
    (
        "shop/pay/AlipayGateway.java",
        "package shop.pay;\nimport org.springframework.stereotype.Service;\n@Service\npublic class AlipayGateway implements PaymentGateway { public void pay() {} }\n",
    ),
    (
        "shop/pay/WechatGateway.java",
        "package shop.pay;\n@org.springframework.stereotype.Service @org.springframework.context.annotation.Primary\npublic class WechatGateway implements PaymentGateway { public void pay() {} }\n",
    ),
    (
        "shop/OrderService.java",
        "package shop;\nimport java.util.List;\nimport lombok.RequiredArgsConstructor;\nimport org.springframework.stereotype.Service;\nimport shop.pay.PaymentGateway;\n@Service\n@RequiredArgsConstructor\npublic class OrderService {\n    private final OrderRepository repo;\n    private final PaymentGateway gateway;\n    private final List<PaymentGateway> gateways;\n    private final String name = \"x\";\n}\n",
    ),
    (
        "shop/NotifyService.java",
        "package shop;\nimport shop.pay.*;\n@org.springframework.stereotype.Component\nclass NotifyService {\n    @Autowired @Qualifier(\"alipayGateway\") private PaymentGateway gateway;\n    @Autowired private PricingService pricing;\n}\n",
    ),
    (
        "shop/AppConfig.java",
        "package shop;\nimport org.springframework.web.client.RestTemplate;\n@Configuration\nclass AppConfig {\n    @Bean RestTemplate restTemplate() { return new RestTemplate(); }\n    @Bean(\"clock\") java.time.Clock systemClock(OrderService orders) { return null; }\n}\n",
    ),
    (
        "shop/ReportController.java",
        "package shop;\nimport org.springframework.web.client.RestTemplate;\n@RestController\nclass ReportController {\n    ReportController(RestTemplate rest, java.time.Clock clock) {}\n}\n",
    ),
    (
        "shop/DomainService.java",
        "package shop;\n@org.springframework.stereotype.Service\npublic @interface DomainService {}\n",
    ),
    ("shop/PricingService.java", "package shop;\n@DomainService\nclass PricingService {}\n"),
];

fn spring_of(rel: &str) -> Vec<String> {
    markers_of(FILES, rel, &SpringOptions::default())
}

#[test]
fn injection_points_find_their_beans() {
    assert_eq!(
        spring_of("shop/OrderService.java"),
        [
            // Injected into AppConfig.systemClock's parameter.
            "7:OrderService Bean AppConfig.systemClock(orders)",
            "8:repo Injection OrderRepository",
            // Two implementations: the @Primary one.
            "9:gateway Injection WechatGateway",
            // A list receives every implementation.
            "10:gateways Injection AlipayGateway,WechatGateway",
        ]
    );
    assert_eq!(
        spring_of("shop/NotifyService.java"),
        ["3:NotifyService Bean ", "4:gateway Injection AlipayGateway", "5:pricing Injection PricingService"],
        "@Qualifier picks by name; a meta-annotated stereotype makes a bean"
    );
    assert_eq!(
        spring_of("shop/ReportController.java"),
        ["3:ReportController Bean ", "4:rest Injection AppConfig.restTemplate(),AppConfig.systemClock()"],
        "constructor parameters on one line share one marker; @Bean methods of library types"
    );
}

#[test]
fn beans_of_the_own_module_come_first() {
    let config = |pkg: &str| {
        format!(
            "package {pkg};\n@Configuration\nclass StoreConfig {{ @Bean io.minio.MinioClient minio() {{ return null; }} }}\n"
        )
    };
    let user = "package a;\n@Service\nclass Upload { @Autowired io.minio.MinioClient minio; }\n";
    let (a_config, b_config) = (config("a"), config("b"));
    let mut d = index(&[
        ("a/src/a/StoreConfig.java", &a_config),
        ("b/src/b/StoreConfig.java", &b_config),
        ("a/src/a/Upload.java", user),
    ]);
    let s = stub(user);
    let owners = |d: &IndexData| {
        let path = "/p/a/src/a/Upload.java";
        let v = view(d, path, &s);
        let model = SpringModel::build(&v, Path::new(path), &SpringOptions::default());
        spring_markers(&v, &model, Path::new(path), &[])
            .markers
            .iter()
            .flat_map(|m| m.targets.iter().map(|t| t.location.path.0.display().to_string()))
            .collect::<Vec<_>>()
    };
    assert_eq!(owners(&d).len(), 2, "no build files: every module");
    for pom in ["a/pom.xml", "b/pom.xml"] {
        d.insert(FileEntry::new(PathBuf::from("/p").join(pom), pom.into(), FileRecord::default()));
    }
    assert_eq!(owners(&d), ["/p/a/src/a/StoreConfig.java"]);
}

#[test]
fn beans_find_where_they_are_injected() {
    assert_eq!(
        spring_of("shop/pay/WechatGateway.java"),
        ["2:WechatGateway Bean OrderService.gateway,OrderService.gateways"]
    );
    assert_eq!(
        spring_of("shop/pay/AlipayGateway.java"),
        ["3:AlipayGateway Bean NotifyService.gateway,OrderService.gateways"]
    );
    assert_eq!(
        spring_of("shop/AppConfig.java"),
        [
            "3:AppConfig Bean ",
            "4:restTemplate Bean ReportController(rest)",
            "5:systemClock Bean ReportController(clock)",
            "5:orders Injection OrderService",
        ]
    );
    assert_eq!(spring_of("shop/OrderRepository.java"), ["2:OrderRepository Bean OrderService.repo"]);
    // Not Spring code: nothing.
    assert!(spring_of("shop/Order.java").is_empty());
}

const NO: SpringOptions = SpringOptions { active_profiles: Vec::new(), libraries: Vec::new(), library_revision: 0 };

#[test]
fn generic_arguments_select_the_repository() {
    let files: &[(&str, &str)] = &[
        ("a/Repo.java", "package a;\npublic interface Repo<T> {}\n"),
        (
            "a/UserRepo.java",
            "package a;\n@org.springframework.stereotype.Repository\nclass UserRepo implements Repo<User> {}\n",
        ),
        (
            "a/OrderRepo.java",
            "package a;\n@org.springframework.stereotype.Repository\nclass OrderRepo implements Repo<Order> {}\n",
        ),
        (
            "a/Svc.java",
            "package a;\n@org.springframework.stereotype.Service\nclass Svc {\n    Svc(Repo<User> users, Repo<?> any) {}\n}\n",
        ),
    ];
    let (r, c, _) = candidates_of(files, "a/Svc.java", 3, "users", &NO);
    assert_eq!((r, c), (SpringResolution::Unique, vec!["userRepo".to_owned()]));
    let (r, c, _) = candidates_of(files, "a/Svc.java", 3, "any", &NO);
    assert_eq!(r, SpringResolution::Ambiguous, "a wildcard matches both: {c:?}");
}

#[test]
fn primary_fallback_priority_and_names_decide() {
    let base = "package a;\npublic interface Store {}\n";
    let files: &[(&str, &str)] = &[
        ("a/Store.java", base),
        (
            "a/Cfg.java",
            "package a;\nimport org.springframework.context.annotation.*;\n@Configuration\nclass Cfg {\n    @Bean @Fallback Store memory() { return null; }\n    @Bean Store disk() { return null; }\n    @Bean(defaultCandidate = false) Store audit() { return null; }\n    @Bean(autowireCandidate = false) Store hidden() { return null; }\n}\n",
        ),
        (
            "a/Use.java",
            "package a;\nimport java.util.*;\n@org.springframework.stereotype.Component\nclass Use {\n    Use(Store store, List<Store> all, @org.springframework.beans.factory.annotation.Qualifier(\"audit\") Store audit) {}\n}\n",
        ),
    ];
    let (r, c, _) = candidates_of(files, "a/Use.java", 4, "store,", &NO);
    assert_eq!((r, c), (SpringResolution::Unique, vec!["disk".to_owned(), "memory".to_owned()]), "@Fallback yields");
    let (r, c, _) = candidates_of(files, "a/Use.java", 4, "all", &NO);
    assert_eq!(
        (r, c),
        (SpringResolution::Many, vec!["disk".to_owned(), "memory".to_owned()]),
        "defaultCandidate=false and autowireCandidate=false stay out"
    );
    let (r, c, _) = candidates_of(files, "a/Use.java", 4, "audit)", &NO);
    assert_eq!(
        (r, c),
        (SpringResolution::Unique, vec!["audit".to_owned()]),
        "a qualifier reaches a non-default candidate"
    );

    let files: &[(&str, &str)] = &[
        ("a/Store.java", base),
        (
            "a/A.java",
            "package a;\n@org.springframework.stereotype.Component @jakarta.annotation.Priority(2)\nclass A implements Store {}\n",
        ),
        (
            "a/B.java",
            "package a;\n@org.springframework.stereotype.Component @jakarta.annotation.Priority(1)\nclass B implements Store {}\n",
        ),
        ("a/C.java", "package a;\n@org.springframework.stereotype.Component\nclass C implements Store {}\n"),
        (
            "a/Use.java",
            "package a;\n@org.springframework.stereotype.Component\nclass Use {\n    @org.springframework.beans.factory.annotation.Autowired Store store;\n    @org.springframework.beans.factory.annotation.Autowired Store c;\n}\n",
        ),
    ];
    assert_eq!(candidates_of(files, "a/Use.java", 3, "store;", &NO).1[0], "b", "the highest @Priority (lowest value)");
}

#[test]
fn qualifier_annotations_and_resource_names() {
    let files: &[(&str, &str)] = &[
        (
            "a/Fast.java",
            "package a;\n@org.springframework.beans.factory.annotation.Qualifier\npublic @interface Fast {}\n",
        ),
        ("a/Sender.java", "package a;\npublic interface Sender {}\n"),
        ("a/Sms.java", "package a;\n@org.springframework.stereotype.Component @Fast\nclass Sms implements Sender {}\n"),
        (
            "a/Mail.java",
            "package a;\n@org.springframework.stereotype.Component(\"mailer\")\nclass Mail implements Sender {}\n",
        ),
        (
            "a/Use.java",
            "package a;\nimport jakarta.annotation.Resource;\n@org.springframework.stereotype.Component\nclass Use {\n    @org.springframework.beans.factory.annotation.Autowired @Fast Sender fast;\n    @Resource(name = \"mailer\") Sender byName;\n    @Resource Sender sms;\n}\n",
        ),
    ];
    assert_eq!(candidates_of(files, "a/Use.java", 4, "fast;", &NO).1, ["sms"], "custom qualifier annotation");
    assert_eq!(candidates_of(files, "a/Use.java", 5, "byName", &NO).1, ["mailer"], "@Resource(name)");
    assert_eq!(candidates_of(files, "a/Use.java", 6, "sms;", &NO).1, ["sms"], "then the field name");
}

#[test]
fn shapes_unwrap_their_element() {
    let files: &[(&str, &str)] = &[
        ("a/Clock.java", "package a;\n@org.springframework.stereotype.Component\nclass Clock {}\n"),
        (
            "a/Use.java",
            "package a;\nimport java.util.*;\nimport org.springframework.beans.factory.ObjectProvider;\n@org.springframework.stereotype.Component\nclass Use {\n    Use(Map<String, Clock> byName, ObjectProvider<Clock> lazy, Optional<Clock> maybe, Clock[] all) {}\n}\n",
        ),
    ];
    for needle in ["byName", "lazy", "maybe", "all)"] {
        assert_eq!(candidates_of(files, "a/Use.java", 5, needle, &NO).1, ["clock"], "{needle}");
    }
}

#[test]
fn boot_applications_scan_their_packages() {
    let files: &[(&str, &str)] = &[
        (
            "shop/App.java",
            "package shop;\n@org.springframework.boot.autoconfigure.SpringBootApplication\nclass App {}\n",
        ),
        ("shop/Clock.java", "package shop;\npublic interface Clock {}\n"),
        (
            "shop/time/SystemClock.java",
            "package shop.time;\n@org.springframework.stereotype.Component\nclass SystemClock implements shop.Clock {}\n",
        ),
        (
            "tools/FakeClock.java",
            "package tools;\n@org.springframework.stereotype.Component\nclass FakeClock implements shop.Clock {}\n",
        ),
        (
            "tools/ToolsConfig.java",
            "package tools;\n@org.springframework.context.annotation.Configuration\nclass ToolsConfig { @org.springframework.context.annotation.Bean shop.Clock toolClock() { return null; } }\n",
        ),
        (
            "shop/Imports.java",
            "package shop;\n@org.springframework.context.annotation.Configuration @org.springframework.context.annotation.Import(tools.ToolsConfig.class)\nclass Imports {}\n",
        ),
        (
            "shop/Use.java",
            "package shop;\n@org.springframework.stereotype.Service\nclass Use { @org.springframework.beans.factory.annotation.Autowired java.util.List<Clock> clocks; }\n",
        ),
    ];
    let (r, c, unknown) = candidates_of(files, "shop/Use.java", 2, "clocks", &NO);
    assert_eq!(r, SpringResolution::Many);
    assert_eq!(
        c,
        ["systemClock", "toolClock"],
        "scanned packages and the @Import closure, not the unscanned FakeClock"
    );
    assert!(unknown, "Boot: auto-configuration may add beans");
}

#[test]
fn profiles_and_conditions() {
    let files: &[(&str, &str)] = &[
        ("a/Clock.java", "package a;\npublic interface Clock {}\n"),
        (
            "a/Dev.java",
            "package a;\n@org.springframework.stereotype.Component @org.springframework.context.annotation.Profile(\"dev\")\nclass Dev implements Clock {}\n",
        ),
        (
            "a/Prod.java",
            "package a;\n@org.springframework.stereotype.Component @org.springframework.context.annotation.Profile(\"!dev\")\nclass Prod implements Clock {}\n",
        ),
        (
            "a/Use.java",
            "package a;\n@org.springframework.stereotype.Component\nclass Use { @org.springframework.beans.factory.annotation.Autowired Clock clock; }\n",
        ),
    ];
    let (r, c, _) = candidates_of(files, "a/Use.java", 2, "clock;", &NO);
    assert_eq!((r, c.len()), (SpringResolution::Conditional, 2), "no active profiles configured: both may exist");
    let dev = SpringOptions { active_profiles: vec!["dev".into()], ..Default::default() };
    assert_eq!(candidates_of(files, "a/Use.java", 2, "clock;", &dev).1, ["dev"]);
}

#[test]
fn framework_and_provided_beans() {
    let files: &[(&str, &str)] = &[
        (
            "a/Api.java",
            "package a;\n@org.springframework.cloud.openfeign.FeignClient(name = \"orders\")\npublic interface Api {}\n",
        ),
        ("a/Mapper.java", "package a;\n@org.apache.ibatis.annotations.Mapper\npublic interface UserMapper {}\n"),
        (
            "a/Use.java",
            "package a;\nimport org.springframework.context.ApplicationEventPublisher;\n@org.springframework.stereotype.Component\nclass Use {\n    Use(ApplicationEventPublisher events, Api api, UserMapper users) {}\n}\n",
        ),
    ];
    let (r, c, _) = candidates_of(files, "a/Use.java", 4, "events", &NO);
    assert_eq!((r, c.len()), (SpringResolution::Unique, 0), "the application context, which has no source");
    assert_eq!(
        candidates_of(files, "a/Use.java", 4, "api,", &NO).1,
        ["a.Api"],
        "Feign clients are named by their interface"
    );
    assert_eq!(candidates_of(files, "a/Use.java", 4, "users)", &NO).1, ["userMapper"]);
}

#[test]
fn an_unchanged_structure_reuses_the_model() {
    let text = "package a;\n@org.springframework.stereotype.Component\nclass A { void m() { int x = 1; } }\n";
    let d = index(&[("a/A.java", text)]);
    let same = stub("package a;\n\n@org.springframework.stereotype.Component\nclass A { void m() { int y = 2; } }\n");
    assert!(SpringModel::reusable_for(&view(&d, "/p/a/A.java", &same)), "positions and code may differ");
    let changed = stub("package a;\n@org.springframework.stereotype.Service\nclass A { void m() {} }\n");
    assert!(!SpringModel::reusable_for(&view(&d, "/p/a/A.java", &changed)));
}

/// A library model with Hikari's `dataSource` (if no `DataSource` bean of the application's
/// own) and Jackson's `jsonMapper`, for the module at `/p/app`.
fn boot_library() -> SpringOptions {
    let json = r#"{
        "project": "/p/app", "web": "servlet", "incomplete": false,
        "types": {
            "com.zaxxer.hikari.HikariDataSource": ["com.zaxxer.hikari.HikariConfig", "javax.sql.DataSource", "java.io.Closeable"],
            "tools.jackson.databind.json.JsonMapper": ["tools.jackson.databind.ObjectMapper"]
        },
        "configurations": [
            {"fqn": "org.springframework.boot.jdbc.autoconfigure.DataSourceConfiguration$Hikari", "handle": "=h", "jar": "spring-boot-jdbc-4.1.2.jar", "source": "nested",
             "conditions": [{"kind": "ConditionalOnMissingBean", "attrs": {"value": ["javax.sql.DataSource"]}},
                            {"kind": "ConditionalOnProperty", "attrs": {"name": ["spring.datasource.type"], "matchIfMissing": ["true"]}}],
             "beans": [{"names": ["dataSource"], "type": "com.zaxxer.hikari.HikariDataSource", "handle": "=h/ds", "member": "dataSource", "autowireCandidate": true, "defaultCandidate": true, "conditions": []}]},
            {"fqn": "org.springframework.boot.jackson.autoconfigure.JacksonAutoConfiguration", "handle": "=j", "jar": "spring-boot-jackson-4.1.2.jar", "source": "autoConfiguration",
             "beans": [{"names": ["jsonMapper"], "type": "tools.jackson.databind.json.JsonMapper", "handle": "=j/m", "member": "jsonMapper", "autowireCandidate": true, "defaultCandidate": true,
                        "conditions": [{"kind": "ConditionalOnMissingBean", "attrs": {}}]}]}
        ]
    }"#;
    let library: LibraryModel = serde_json::from_str(json).unwrap();
    SpringOptions {
        libraries: vec![(PathBuf::from("/p/app"), std::sync::Arc::new(library))],
        library_revision: 1,
        ..Default::default()
    }
}

#[test]
fn auto_configured_beans_join_the_boot_application() {
    let files: &[(&str, &str)] = &[
        ("app/pom.xml", ""),
        (
            "app/src/main/java/shop/App.java",
            "package shop;\n@org.springframework.boot.autoconfigure.SpringBootApplication\nclass App {}\n",
        ),
        (
            "app/src/main/java/shop/Repo.java",
            "package shop;\nimport javax.sql.DataSource;\nimport tools.jackson.databind.ObjectMapper;\n@org.springframework.stereotype.Repository\nclass Repo {\n    Repo(DataSource dataSource, ObjectMapper mapper) {}\n}\n",
        ),
    ];
    let options = boot_library();
    let (r, c, unknown) = candidates_of(files, "app/src/main/java/shop/Repo.java", 5, "dataSource", &options);
    assert_eq!(
        (r, c),
        (SpringResolution::Unique, vec!["dataSource".to_owned()]),
        "Hikari's, a DataSource by its supertypes"
    );
    assert!(!unknown, "with the library model, the Boot application's beans are known");
    assert_eq!(candidates_of(files, "app/src/main/java/shop/Repo.java", 5, "mapper", &options).1, ["jsonMapper"]);

    // The application's own DataSource switches the auto-configured one off.
    let mut own = files.to_vec();
    own.push((
        "app/src/main/java/shop/Db.java",
        "package shop;\n@org.springframework.context.annotation.Configuration\nclass Db { @org.springframework.context.annotation.Bean javax.sql.DataSource primaryDb() { return null; } }\n",
    ));
    assert_eq!(candidates_of(&own, "app/src/main/java/shop/Repo.java", 5, "dataSource", &options).1, ["primaryDb"]);

    // The gutter target of a library bean carries its handle to open it.
    let d = index(files);
    let rel = "app/src/main/java/shop/Repo.java";
    let s = stub(files.iter().find(|(r, _)| *r == rel).unwrap().1);
    let path = format!("/p/{rel}");
    let v = view(&d, &path, &s);
    let model = SpringModel::build(&v, Path::new(&path), &options);
    let m = spring_markers(&v, &model, Path::new(&path), &[]);
    let targets: Vec<(String, Option<String>, Option<String>)> = m
        .markers
        .iter()
        .flat_map(|m| m.targets.iter().map(|t| (t.owner.clone(), t.handle.clone(), t.module.clone())))
        .collect();
    assert!(
        targets.contains(&(
            "Hikari.dataSource()".to_owned(),
            Some("=h/ds".to_owned()),
            Some("spring-boot-jdbc-4.1.2.jar".to_owned())
        )),
        "{targets:?}"
    );
}

// ---------------------------------------------------------------------------
// Events, scheduling, caches, test configuration; inspections and their fixes

/// Every marker of `rel` as `line:name Kind [detail] targets`.
fn feature_markers(files: &[(&str, &str)], rel: &str, publishers: &[EventPublisher]) -> Vec<String> {
    let d = index(files);
    let text = files.iter().find(|(r, _)| *r == rel).unwrap().1;
    let s = stub(text);
    let path = format!("/p/{rel}");
    let v = view(&d, &path, &s);
    let model = SpringModel::build(&v, Path::new(&path), &SpringOptions::default());
    spring_markers(&v, &model, Path::new(&path), publishers)
        .markers
        .iter()
        .filter(|m| !matches!(m.kind, SpringMarkerKind::Bean | SpringMarkerKind::Injection))
        .map(|m| {
            let targets: Vec<String> = m.targets.iter().map(|t| format!("{}@{}", t.label, t.owner)).collect();
            format!(
                "{}:{} {:?} [{}] {}",
                m.line,
                m.name,
                m.kind,
                m.detail.clone().unwrap_or_default(),
                targets.join(",")
            )
        })
        .collect()
}

fn problems(files: &[(&str, &str)], rel: &str) -> (String, Vec<SpringProblem>) {
    let d = index(files);
    let text = files.iter().find(|(r, _)| *r == rel).unwrap().1;
    let s = stub(text);
    let path = format!("/p/{rel}");
    let v = view(&d, &path, &s);
    let model = SpringModel::build(&v, Path::new(&path), &SpringOptions::default());
    let out = Syntax::new()
        .with_parsed(&LanguageId::new("java"), text, &|| false, |p| spring_problems(&v, &model, p.tree, p.text))
        .unwrap();
    (text.to_owned(), out)
}

/// `line:text-at-range Inspection: message` of each problem.
fn problem_lines(files: &[(&str, &str)], rel: &str) -> Vec<String> {
    let (text, list) = problems(files, rel);
    list.iter()
        .map(|p| {
            let line = text.lines().nth(p.range.start.line as usize).unwrap_or_default();
            let at: String = line
                .chars()
                .skip(p.range.start.col as usize)
                .take((p.range.end.col.saturating_sub(p.range.start.col)) as usize)
                .collect();
            format!("{}:{at} {:?}: {}", p.range.start.line, p.inspection, p.message)
        })
        .collect()
}

/// `text` with `fix` applied (edits in original coordinates, applied back to front).
fn apply(text: &str, fix: &SpringFix) -> String {
    let offset = |p: Pos| -> usize {
        let mut start = 0;
        for (i, l) in text.split_inclusive('\n').enumerate() {
            if i == p.line as usize {
                return start + l.char_indices().nth(p.col as usize).map_or(l.trim_end_matches('\n').len(), |(b, _)| b);
            }
            start += l.len();
        }
        text.len()
    };
    let mut edits: Vec<(usize, usize, &str)> =
        fix.edits.iter().map(|e| (offset(e.range.start), offset(e.range.end), e.text.as_str())).collect();
    edits.sort_by_key(|e| std::cmp::Reverse((e.0, e.1)));
    let mut out = text.to_owned();
    for (from, to, insert) in edits {
        out.replace_range(from..to, insert);
    }
    out
}

const APP: (&str, &str) = (
    "shop/AppConfig.java",
    "package shop;\nimport org.springframework.context.annotation.*;\n@Configuration\n@ComponentScan\npublic class AppConfig {}\n",
);

#[test]
fn event_listeners_and_publishers() {
    let files: &[(&str, &str)] = &[
        APP,
        ("shop/OrderPlaced.java", "package shop;\npublic class OrderPlaced extends DomainEvent {}\n"),
        ("shop/DomainEvent.java", "package shop;\npublic class DomainEvent {}\n"),
        (
            "shop/Audit.java",
            "package shop;\nimport org.springframework.context.event.EventListener;\nimport org.springframework.stereotype.Component;\n@Component\nclass Audit {\n  @EventListener\n  void on(DomainEvent e) {}\n  @EventListener(classes = Other.class)\n  void other() {}\n}\n",
        ),
        (
            "shop/Mailer.java",
            "package shop;\nimport org.springframework.context.ApplicationListener;\n@org.springframework.stereotype.Component\nclass Mailer implements ApplicationListener<OrderPlaced> {\n  public void onApplicationEvent(OrderPlaced e) {}\n}\n",
        ),
        (
            "shop/Orders.java",
            "package shop;\nclass Orders {\n  void place() {\n    publisher.publishEvent(new OrderPlaced());\n  }\n}\n",
        ),
    ];
    let published = EventPublisher {
        path: PathBuf::from("/p/shop/Orders.java"),
        line: 3,
        col: 14,
        len: 12,
        event: "shop.OrderPlaced".into(),
        supertypes: vec!["shop.DomainEvent".into()],
        method: "Orders.place()".into(),
    };
    assert_eq!(
        feature_markers(files, "shop/Audit.java", std::slice::from_ref(&published)),
        ["6:on EventListener [DomainEvent] Orders.place()@OrderPlaced", "8:other EventListener [Other] ",],
        "a listener of a supertype hears it; one hearing nothing published still gets its marker"
    );
    assert_eq!(
        feature_markers(files, "shop/Mailer.java", std::slice::from_ref(&published)),
        ["4:onApplicationEvent EventListener [OrderPlaced] Orders.place()@OrderPlaced"]
    );
    assert_eq!(
        feature_markers(files, "shop/Orders.java", &[published]),
        ["3:publishEvent EventPublisher [OrderPlaced] Audit.on()@DomainEvent,Mailer.onApplicationEvent()@OrderPlaced"]
    );
}

#[test]
fn scheduled_cache_and_test_markers() {
    let files: &[(&str, &str)] = &[
        (
            "app/src/main/java/shop/App.java",
            "package shop;\n@org.springframework.boot.autoconfigure.SpringBootApplication\npublic class App {}\n",
        ),
        (
            "app/src/main/java/shop/Jobs.java",
            "package shop;\nimport org.springframework.scheduling.annotation.Scheduled;\n@org.springframework.stereotype.Component\nclass Jobs {\n  @Scheduled(cron = \"0 0 * * * *\", zone = \"UTC\")\n  void nightly() {}\n  @Scheduled(fixedRate = 5000, scheduler = \"jobs\")\n  void often() {}\n}\n",
        ),
        (
            "app/src/main/java/shop/Users.java",
            "package shop;\nimport org.springframework.cache.annotation.*;\n@CacheConfig(cacheNames = \"users\")\n@org.springframework.stereotype.Service\nclass Users {\n  @Cacheable\n  public String find(long id) { return null; }\n  @CacheEvict(allEntries = true)\n  public void clear() {}\n  @Cacheable(\"other\")\n  public String other() { return null; }\n}\n",
        ),
        (
            "app/src/test/java/shop/web/UsersTest.java",
            "package shop.web;\n@org.springframework.boot.test.context.SpringBootTest\nclass UsersTest {}\n",
        ),
        (
            "app/src/test/java/shop/CfgTest.java",
            "package shop;\nimport org.springframework.test.context.ContextConfiguration;\n@ContextConfiguration(classes = Jobs.class)\nclass CfgTest {}\n",
        ),
        (
            "app/src/test/java/shop/NestedTest.java",
            "package shop;\n@org.springframework.test.context.junit.jupiter.SpringJUnitConfig\nclass NestedTest {\n  @org.springframework.context.annotation.Configuration\n  static class Cfg {}\n}\n",
        ),
    ];
    assert_eq!(
        feature_markers(files, "app/src/main/java/shop/Jobs.java", &[]),
        ["5:nightly Scheduled [cron \"0 0 * * * *\", zone \"UTC\"] ", "7:often Scheduled [fixedRate 5000] jobs@Jobs",],
        "the scheduler bean named is a target"
    );
    assert_eq!(
        feature_markers(files, "app/src/main/java/shop/Users.java", &[]),
        [
            "6:find Cacheable [users] Users.clear()@@CacheEvict(users)",
            "8:clear Cacheable [users] Users.find()@@Cacheable(users)"
        ],
        "@CacheConfig names; a cache nothing else uses gets no marker"
    );
    assert_eq!(
        feature_markers(files, "app/src/test/java/shop/web/UsersTest.java", &[]),
        ["2:UsersTest TestContext [] App@"],
        "the @SpringBootConfiguration of an enclosing package"
    );
    assert_eq!(feature_markers(files, "app/src/test/java/shop/CfgTest.java", &[]), ["3:CfgTest TestContext [] Jobs@"]);
    assert_eq!(
        feature_markers(files, "app/src/test/java/shop/NestedTest.java", &[]),
        ["2:NestedTest TestContext [] NestedTest.Cfg@"]
    );
}

#[test]
fn autowiring_problems_and_add_qualifier() {
    let files: &[(&str, &str)] = &[
        APP,
        ("shop/Store.java", "package shop;\npublic interface Store {}\n"),
        (
            "shop/Disk.java",
            "package shop;\n@org.springframework.stereotype.Component\nclass Disk implements Store {}\n",
        ),
        (
            "shop/Cloud.java",
            "package shop;\n@org.springframework.stereotype.Component\nclass Cloud implements Store {}\n",
        ),
        ("shop/Missing.java", "package shop;\npublic interface Missing {}\n"),
        (
            "shop/Use.java",
            "package shop;\nimport org.springframework.beans.factory.annotation.Autowired;\n@org.springframework.stereotype.Service\nclass Use {\n  @Autowired\n  private Store store;\n  Use(Missing missing, @org.springframework.beans.factory.annotation.Qualifier(\"nope\") Store q) {}\n}\n",
        ),
    ];
    assert_eq!(
        problem_lines(files, "shop/Use.java"),
        [
            "5:store Autowiring: Could not autowire. There is more than one bean of 'Store' type. Beans: cloud, disk",
            "5:store FieldInjection: Field injection is not recommended",
            "6:missing Autowiring: Could not autowire. No beans of 'Missing' type found.",
            "6:q Autowiring: Cannot find bean with qualifier 'nope'",
        ]
    );
    let (text, list) = problems(files, "shop/Use.java");
    let fixes = &list.iter().find(|p| p.inspection == SpringInspection::Autowiring).unwrap().fixes;
    assert_eq!(fixes.iter().map(|f| f.choice.clone().unwrap()).collect::<Vec<_>>(), ["cloud", "disk"]);
    assert_eq!(
        apply(&text, &fixes[1]),
        "package shop;\nimport org.springframework.beans.factory.annotation.Autowired;\nimport org.springframework.beans.factory.annotation.Qualifier;\n@org.springframework.stereotype.Service\nclass Use {\n  @Qualifier(\"disk\")\n  @Autowired\n  private Store store;\n  Use(Missing missing, @org.springframework.beans.factory.annotation.Qualifier(\"nope\") Store q) {}\n}\n"
    );

    // Beans may come from where the model cannot see (a Boot application without its libraries): nothing is claimed.
    let mut boot = files.to_vec();
    boot[0] = (
        "shop/AppConfig.java",
        "package shop;\n@org.springframework.boot.autoconfigure.SpringBootApplication\npublic class AppConfig {}\n",
    );
    assert_eq!(problem_lines(&boot, "shop/Use.java"), ["5:store FieldInjection: Field injection is not recommended"]);
}

#[test]
fn field_injection_becomes_constructor_injection() {
    let fix = |class: &str| {
        let files = [APP, ("shop/Repo.java", "package shop;\npublic interface Repo {}\n"), ("shop/Svc.java", class)];
        let (text, list) = problems(&files, "shop/Svc.java");
        let p = list.iter().find(|p| p.inspection == SpringInspection::FieldInjection).expect("field injection");
        assert_eq!(p.severity, SpringProblemSeverity::WeakWarning);
        let f = p.fixes.first().expect("a fix");
        (f.label.clone(), apply(&text, f))
    };
    assert_eq!(
        fix("package shop;\nimport org.springframework.beans.factory.annotation.*;\n@org.springframework.stereotype.Service\npublic class Svc {\n    @Autowired\n    @Qualifier(\"main\")\n    private Repo repo;\n\n    void run() {}\n}\n"),
        (
            "Create constructor: repo".to_owned(),
            "package shop;\nimport org.springframework.beans.factory.annotation.*;\n@org.springframework.stereotype.Service\npublic class Svc {\n    private final Repo repo;\n\n    public Svc(@Qualifier(\"main\") Repo repo) {\n        this.repo = repo;\n    }\n\n    void run() {}\n}\n".to_owned()
        )
    );
    assert_eq!(
        fix("package shop;\n@org.springframework.stereotype.Service\npublic class Svc {\n  @org.springframework.beans.factory.annotation.Autowired private Repo repo;\n  private final String name;\n  Svc(String name) {\n    this.name = name;\n  }\n}\n"),
        (
            "Add parameter(s) to constructor: repo".to_owned(),
            "package shop;\n@org.springframework.stereotype.Service\npublic class Svc {\n  private final Repo repo;\n  private final String name;\n  Svc(String name, Repo repo) {\n    this.name = name;\n    this.repo = repo;\n  }\n}\n".to_owned()
        )
    );
    assert_eq!(
        fix("package shop;\nimport org.springframework.beans.factory.annotation.Autowired;\nimport org.springframework.stereotype.Service;\n@Service\npublic class Svc {\n  @Autowired\n  private Repo repo;\n}\n").1,
        "package shop;\nimport org.springframework.stereotype.Service;\n@Service\npublic class Svc {\n  private final Repo repo;\n\n  public Svc(Repo repo) {\n    this.repo = repo;\n  }\n}\n",
        "the import of the removed @Autowired goes when nothing else uses it"
    );
    assert_eq!(
        fix("package shop;\n@lombok.RequiredArgsConstructor\n@org.springframework.stereotype.Service\npublic class Svc {\n  @javax.inject.Inject Repo repo;\n}\n").1,
        "package shop;\n@lombok.RequiredArgsConstructor\n@org.springframework.stereotype.Service\npublic class Svc {\n  final Repo repo;\n}\n",
        "Lombok's constructor takes final fields"
    );
}

#[test]
fn bean_reference_profile_and_bean_method_problems() {
    let files: &[(&str, &str)] = &[
        APP,
        ("shop/Pool.java", "package shop;\npublic class Pool { public void start() {} }\n"),
        (
            "shop/Cfg.java",
            "package shop;\nimport org.springframework.context.annotation.*;\n@Configuration\n@DependsOn({\"pool\", \"ghost\"})\n@Profile(\"dev & cloud | test\")\nclass Cfg {\n  @Bean(initMethod = \"start\", destroyMethod = \"stop\")\n  Pool pool() { return new Pool(); }\n  @Bean @Profile({\"(dev | test) & !prod\", \"\"})\n  String name() { return \"\"; }\n  @org.springframework.scheduling.annotation.Scheduled(fixedDelay = 1, scheduler = \"timer\")\n  void tick() {}\n}\n",
        ),
    ];
    assert_eq!(
        problem_lines(files, "shop/Cfg.java"),
        [
            "3:ghost DependsOn: Cannot resolve bean 'ghost'",
            "4:dev & cloud | test ProfileExpression: Malformed profile expression",
            "6:stop BeanMethods: Cannot resolve method",
            "8: ProfileExpression: Profile expression must contain text",
            "10:timer ScheduledBean: Cannot resolve bean 'timer'",
        ]
    );
    assert!(inspect::profile_well_formed("(a | b) & !c"));
    assert!(!inspect::profile_well_formed("a &"));
    assert!(!inspect::profile_well_formed("(a"));
}

#[test]
fn method_signature_problems_and_fixes() {
    let files: &[(&str, &str)] = &[
        APP,
        (
            "shop/Tasks.java",
            "package shop;\nimport org.springframework.scheduling.annotation.*;\nimport org.springframework.context.event.EventListener;\nimport org.springframework.transaction.annotation.Transactional;\nimport org.springframework.transaction.event.TransactionalEventListener;\n@org.springframework.stereotype.Component\nclass Tasks {\n  @Scheduled(fixedRate = 10)\n  void run(String a) {}\n  @Async\n  public int count() { if (true) return 1; return 2; }\n  @Async\n  public java.util.concurrent.CompletableFuture<String> ok() { return null; }\n  @EventListener\n  static void both(String a, String b) {}\n  @EventListener\n  void none() {}\n  @TransactionalEventListener\n  @Transactional(readOnly = true)\n  public void after(String e) {}\n  @org.springframework.test.context.transaction.BeforeTransaction\n  boolean before(int x) { return true; }\n}\n",
        ),
    ];
    assert_eq!(
        problem_lines(files, "shop/Tasks.java"),
        [
            "8:run ScheduledSignature: @Scheduled methods must not take any arguments",
            "10:count AsyncSignature: Method annotated with @Async should return 'void' or \"Future-like\" type",
            "14:both EventListener: Method must have maximum one parameter",
            "14:both EventListener: Method annotated with @EventListener must be non-static",
            "16:none EventListener: Event parameter is mandatory for event listener method",
            "18:Transactional TransactionalEventListener: @TransactionalEventListener method must not be annotated with @Transactional unless when declared as REQUIRES_NEW or NOT_SUPPORTED",
            "21:before TransactionLifecycle: Wrong number of arguments",
            "21:before TransactionLifecycle: Expected method return type is 'void'",
        ]
    );
    let (text, list) = problems(files, "shop/Tasks.java");
    let fix = |i: SpringInspection, n: usize| {
        let p = list.iter().find(|p| p.inspection == i).unwrap();
        (p.fixes[n].label.clone(), apply(&text, &p.fixes[n]))
    };
    let (label, out) = fix(SpringInspection::ScheduledSignature, 0);
    assert_eq!(label, "Change 'run' to no-arg");
    assert!(out.contains("  void run() {}\n"), "{out}");
    let (label, out) = fix(SpringInspection::AsyncSignature, 0);
    assert_eq!(label, "Change method to return 'CompletableFuture<Integer>'");
    assert!(
        out.contains("  public CompletableFuture<Integer> count() { if (true) return CompletableFuture.completedFuture(1); return CompletableFuture.completedFuture(2); }"),
        "{out}"
    );
    assert!(
        out.contains(
            "import java.util.concurrent.CompletableFuture;\nimport org.springframework.scheduling.annotation.*;"
        ),
        "imports stay sorted: {out}"
    );
    let (label, out) = fix(SpringInspection::TransactionalEventListener, 0);
    assert_eq!(label, "Set propagation to REQUIRES_NEW");
    assert!(out.contains("@Transactional(readOnly = true, propagation = Propagation.REQUIRES_NEW)"), "{out}");
    assert!(
        out.contains("import org.springframework.transaction.annotation.Propagation;\nimport org.springframework.transaction.annotation.Transactional;"),
        "{out}"
    );
    let (label, out) = fix(SpringInspection::TransactionalEventListener, 2);
    assert_eq!(label, "Remove @Transactional");
    assert!(out.contains("  @TransactionalEventListener\n  public void after"), "{out}");
    assert!(!out.contains("annotation.Transactional;"), "its unused import goes too: {out}");
}

#[test]
fn cache_problems() {
    let files: &[(&str, &str)] = &[
        APP,
        (
            "shop/Cache.java",
            "package shop;\nimport org.springframework.cache.annotation.*;\n@org.springframework.stereotype.Service\nclass Cache {\n  @Cacheable\n  public String a() { return null; }\n  @Cacheable(\"x\") @CachePut(\"x\")\n  public String b() { return null; }\n  @Cacheable(value = \"x\", key = \"#id\", keyGenerator = \"gen\")\n  private String c(long id) { return null; }\n}\n",
        ),
        (
            "shop/Api.java",
            "package shop;\ninterface Api {\n  @org.springframework.cache.annotation.CacheEvict(\"x\")\n  void evict();\n}\n",
        ),
    ];
    assert_eq!(
        problem_lines(files, "shop/Cache.java"),
        [
            "4:Cacheable CacheNames: At least one non-empty cache name is required per cache operation.",
            "7:b CacheableAndCachePut: Spring doesn't recommend using @CachePut and @Cacheable annotate on the same method",
            "8:Cacheable CacheAnnotations: Both 'key' and 'keyGenerator' attributes have been set. These attributes are mutually exclusive: either set the SpEL expression used to compute the key at runtime or set the name of the KeyGenerator bean to use.",
            "8:gen CacheAnnotations: Cannot resolve bean 'gen'",
            "9:c CacheAnnotations: Caching annotations should be defined on public methods",
        ]
    );
    assert_eq!(
        problem_lines(files, "shop/Api.java"),
        [
            "2:org.springframework.cache.annotation.CacheEvict CacheOnInterface: Spring doesn't recommend annotating interface methods with @Cache* annotation"
        ]
    );
}

#[test]
fn tool_window_and_dependency_graph() {
    let files: &[(&str, &str)] = &[
        APP,
        ("shop/A.java", "package shop;\n@org.springframework.stereotype.Service\nclass A { A(B b) {} }\n"),
        (
            "shop/B.java",
            "package shop;\n@org.springframework.stereotype.Service\nclass B { @javax.inject.Inject C c; }\n",
        ),
        (
            "shop/C.java",
            "package shop;\n@org.springframework.stereotype.Component\nclass C { @org.springframework.beans.factory.annotation.Autowired A a; }\n",
        ),
        (
            "shop/Cfg.java",
            "package shop;\n@org.springframework.context.annotation.Configuration\nclass Cfg { @org.springframework.context.annotation.Bean java.time.Clock clock(B b) { return null; } }\n",
        ),
    ];
    let d = index(files);
    let v = JavaView::new(&d, None);
    let model = SpringModel::build(&v, Path::new(""), &SpringOptions::default());
    let contexts = model.context_infos(&v);
    assert_eq!(contexts.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["config:shop.AppConfig"]);
    let ctx = Some(contexts[0].id.as_str());
    let beans = model.bean_infos(&v, ctx);
    let names: HashSet<&str> = beans.iter().map(|b| b.name.as_str()).collect();
    assert!(
        ["a", "b", "c", "cfg", "clock", "appConfig", "applicationContext"].iter().all(|n| names.contains(n)),
        "{names:?}"
    );
    let clock = beans.iter().find(|b| b.name == "clock").unwrap();
    assert_eq!(
        (clock.id.as_str(), clock.declaration.as_str(), clock.type_fqn.as_str()),
        ("shop.Cfg#clock/clock", "Cfg.clock()", "java.time.Clock")
    );
    let fw = beans.iter().find(|b| b.name == "environment").unwrap();
    assert_eq!(fw.source, SpringBeanSource::Framework);

    let detail = model.bean_detail(&v, ctx, "shop.B/b").unwrap();
    assert_eq!(
        detail.dependencies.iter().map(|d| (d.label.as_str(), d.kind, d.beans.clone())).collect::<Vec<_>>(),
        [("c", SpringEdgeKind::Inject, vec!["shop.C/c".to_owned()])]
    );
    let mut dependents: Vec<(String, SpringEdgeKind)> =
        detail.dependents.iter().map(|d| (d.bean.clone(), d.kind)).collect();
    dependents.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        dependents,
        [
            ("shop.A/a".to_owned(), SpringEdgeKind::Autowired),
            ("shop.Cfg#clock/clock".to_owned(), SpringEdgeKind::BeanParam)
        ]
    );

    // Around `a`, one step: its dependency and dependent; the a → b → c → a cycle is marked.
    let g = model.graph(&v, ctx, &["shop.A/a".to_owned()], 1, false, 100);
    let mut nodes: Vec<&str> = g.nodes.iter().map(|n| n.name.as_str()).collect();
    nodes.sort_unstable();
    assert_eq!(nodes, ["a", "b", "c"]);
    let mut edges: Vec<String> = g
        .edges
        .iter()
        .map(|e| format!("{}>{} {:?} {}", e.from, e.to, e.kind, if e.cycle { "cycle" } else { "" }))
        .collect();
    edges.sort();
    assert_eq!(
        edges,
        ["shop.A/a>shop.B/b Autowired cycle", "shop.B/b>shop.C/c Inject cycle", "shop.C/c>shop.A/a Autowired cycle",]
    );
    // The whole context: the configuration creates its @Bean; framework beans hidden.
    let all = model.graph(&v, ctx, &[], 0, false, 100);
    assert!(
        all.edges
            .iter()
            .any(|e| e.from == "shop.Cfg/cfg" && e.to == "shop.Cfg#clock/clock" && e.kind == SpringEdgeKind::Creates)
    );
    assert!(!all.nodes.iter().any(|n| n.source == SpringBeanSource::Framework));
    assert!(model.graph(&v, ctx, &[], 0, true, 3).truncated);
}
