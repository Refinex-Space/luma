import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import type { SpringBeanInfo, SpringMarker, SpringProblem, SpringTarget } from "@/platform/ipc";
import { DEFAULT_OPTIONS, groupBeans, type ExplorerOptions } from "./explorer/model";
import { matchBean } from "./explorer/search";
import { SPRING_PRODUCERS } from "@/platform/inspections";
import { validateSpring } from "@/platform/springSettings";
import { byRelevance, featureItem, springLineMarker, targetItem } from "./gutter";
import { fixActions, problemDiagnostics } from "./inspections";

const target = (label: string, owner: string, extra: Partial<SpringTarget> = {}): SpringTarget => ({
  location: { path: `/p/${owner}.java`, range: { start: { line: 4, col: 2 }, end: { line: 4, col: 9 } }, uri: null },
  label,
  owner,
  module: null,
  kind: "service",
  primary: false,
  fallback: false,
  presence: "certain",
  handle: null,
  ...extra,
});

const marker = (
  kind: SpringMarker["kind"],
  targets: SpringTarget[],
  resolution: SpringMarker["resolution"] = null,
): SpringMarker => ({
  line: 3,
  col: 4,
  name: "orders",
  kind,
  resolution,
  targets,
  detail: null,
  bean: null,
  context: null,
});

describe("Spring gutter markers", () => {
  it("names the injected bean, or the candidates", () => {
    const one = springLineMarker(marker("injection", [target("orderService", "OrderService")], "unique"));
    expect([one.kind, one.tooltip, one.uncertain]).toEqual(["injection", "Autowired: orderService", false]);
    const many = springLineMarker(
      marker("injection", [target("a", "A"), target("b", "B"), target("c", "C"), target("d", "D")], "many"),
    );
    expect([many.tooltip, many.chooserTitle]).toEqual([
      "Autowired candidates: a, b, c, …",
      "Choose Autowired Candidate (4 found)",
    ]);
    const conditional = springLineMarker(
      marker("injection", [target("dev", "Dev", { presence: "conditional" })], "conditional"),
    );
    expect(conditional.uncertain).toBe(true);
  });

  it("lists where a bean is injected", () => {
    const m = springLineMarker(marker("bean", [target("Checkout.orders", "Checkout.orders")]));
    expect([m.kind, m.tooltip, m.chooserTitle]).toEqual([
      "bean",
      "Spring bean injected into Checkout.orders",
      "Choose Injection Point of orders (1 found)",
    ]);
  });

  it("marks primary, fallback and conditional candidates in the chooser", () => {
    const item = targetItem(
      target("jpaOrders", "JpaOrders", { primary: true, presence: "conditional", module: "core" }),
      0,
      true,
    );
    expect([item.label, item.detail]).toEqual(["jpaOrders ★ ◌", "JpaOrders · core"]);
    expect(targetItem(target("disk", "Cfg.disk()", { fallback: true }), 1, true).detail).toBe("Cfg.disk()");
    expect(targetItem(target("Use.store", "Use.store"), 2, false).detail).toBe("Use.store.java:5");
    const sorted = [
      target("z", "Z", { presence: "conditional" }),
      target("b", "B", { fallback: true }),
      target("a", "A"),
      target("p", "P", { primary: true }),
    ].sort(byRelevance);
    expect(sorted.map((t) => t.label)).toEqual(["p", "a", "b", "z"]);
  });

  it("navigates between event listeners and publishers", () => {
    const listener = springLineMarker(marker("eventListener", [target("Orders.place()", "OrderPlaced")]));
    expect([listener.kind, listener.tooltip, listener.uncertain]).toEqual([
      "springListener",
      "Go to event publisher",
      false,
    ]);
    const lonely = springLineMarker(marker("eventListener", []));
    expect([lonely.tooltip, lonely.uncertain]).toEqual(["No event publishers found", true]);
    const publisher = springLineMarker(marker("eventPublisher", [target("Audit.on()", "A"), target("Mail.on()", "B")]));
    expect([publisher.kind, publisher.chooserTitle]).toEqual(["springPublisher", "Choose Event Listener (2 found)"]);
    expect(featureItem(target("Audit.on()", "DomainEvent"), 0, "x").detail).toBe("DomainEvent · DomainEvent.java:5");
  });

  it("marks scheduled tasks, cache operations and test contexts", () => {
    const task = springLineMarker({ ...marker("scheduled", []), detail: 'cron "0 0 * * * *"' });
    expect([task.kind, task.tooltip, task.passive]).toEqual(["springScheduled", 'Scheduled: cron "0 0 * * * *"', true]);
    const withScheduler = springLineMarker({
      ...marker("scheduled", [target("timer", "Cfg.timer()")]),
      detail: "fixedRate 5",
    });
    expect(withScheduler.passive).toBe(false);
    const cache = springLineMarker(marker("cacheable", [target("Users.clear()", "@CacheEvict(users)")]));
    expect([cache.kind, cache.tooltip]).toEqual(["springCache", "Go to cacheable operation with the same name"]);
    const test = springLineMarker(marker("testContext", [target("App", "")]));
    expect([test.kind, test.tooltip]).toEqual(["springTest", "Navigate to Application Context"]);
  });

  it("publishes problems per inspection and groups fix choices", () => {
    const doc = Text.of(["class A {", "  @Autowired Store store;", "}"]);
    const problem: SpringProblem = {
      inspection: "autowiring",
      range: { start: { line: 1, col: 18 }, end: { line: 1, col: 23 } },
      severity: "error",
      message: "Could not autowire. There is more than one bean of 'Store' type. Beans: cloud, disk",
      fixes: ["cloud", "disk"].map((choice) => ({
        label: "Add qualifier",
        choice,
        edits: [{ range: { start: { line: 1, col: 2 }, end: { line: 1, col: 2 } }, text: `@Qualifier("${choice}") ` }],
      })),
    };
    const weak: SpringProblem = { ...problem, inspection: "fieldInjection", severity: "weakWarning", fixes: [] };
    const out = problemDiagnostics(doc, [problem, weak]);
    expect(out.get(SPRING_PRODUCERS.autowiring)!.map((d) => d.severity)).toEqual(["error"]);
    expect(out.get(SPRING_PRODUCERS.fieldInjection)!.map((d) => d.severity)).toEqual(["info"]);
    expect(out.get(SPRING_PRODUCERS.cacheNames)).toEqual([]);
    expect(fixActions(problem).map((a) => [a.label, a.fixes.length])).toEqual([["Add qualifier", 2]]);
    const propagation: SpringProblem = {
      ...problem,
      fixes: ["Set propagation to REQUIRES_NEW", "Remove @Transactional"].map((label) => ({
        label,
        choice: null,
        edits: [],
      })),
    };
    expect(fixActions(propagation).map((a) => a.label)).toEqual([
      "Set propagation to REQUIRES_NEW",
      "Remove @Transactional",
    ]);
  });

  it("validates settings", () => {
    expect(validateSpring(undefined)).toEqual({ enabled: true, activeProfiles: [], libraryBeans: true });
    expect(validateSpring({ enabled: false, activeProfiles: [" dev ", "", 3] })).toEqual({
      enabled: false,
      activeProfiles: ["dev"],
      libraryBeans: true,
    });
  });
});

describe("Spring tool window and search", () => {
  const bean = (name: string, extra: Partial<SpringBeanInfo> = {}): SpringBeanInfo => ({
    id: `a.${name}/${name}`,
    name,
    aliases: [],
    typeName: name[0]!.toUpperCase() + name.slice(1),
    typeFqn: `a.${name}`,
    kind: "service",
    source: "project",
    location: null,
    handle: null,
    declaration: name,
    module: null,
    primary: false,
    fallback: false,
    presence: "certain",
    test: false,
    scope: null,
    lazy: false,
    profiles: [],
    conditions: [],
    qualifiers: [],
    ...extra,
  });

  it("groups beans by stereotype and filters by the view options", () => {
    const beans = [
      bean("orders"),
      bean("dataSource", { kind: "library", source: "library" }),
      bean("environment", { kind: "framework", source: "framework" }),
      bean("fixture", { kind: "component", test: true }),
    ];
    const ids = (o: ExplorerOptions, filter = "") =>
      groupBeans(beans, o, filter).map((g) => [g.id, g.beans.map((b) => b.bean.name)]);
    expect(ids(DEFAULT_OPTIONS)).toEqual([
      ["service", ["orders"]],
      ["component", ["fixture"]],
    ]);
    expect(ids({ libraries: true, tests: false, implicit: true })).toEqual([
      ["service", ["orders"]],
      ["library", ["dataSource"]],
      ["framework", ["environment"]],
    ]);
    expect(ids(DEFAULT_OPTIONS, "ord")).toEqual([["service", ["orders"]]]);
  });

  it("matches beans by name, alias or type", () => {
    expect(matchBean(bean("orderService"), "@ordSer")?.indices.length).toBeGreaterThan(0);
    expect(matchBean(bean("x", { aliases: ["primaryDb"] }), "primaryDb")).not.toBeNull();
    expect(matchBean(bean("x", { typeName: "HikariDataSource" }), "Hikari")).not.toBeNull();
    expect(matchBean(bean("x"), "zzz")).toBeNull();
  });
});
