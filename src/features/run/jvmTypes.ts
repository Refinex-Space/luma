/**
 * JVM run configuration types: Application and Spring Boot
 * (`java [VM options] -cp ${classpath} <main class> [program arguments]`), and the
 * VM options Maven / Gradle configurations hand to the JVM the build forks
 * (`spring-boot:run`, tests, `bootRun`) rather than to the build tool's own JVM.
 */
import { call, commands, type RunConfig } from "@/platform/ipc";
import { CLASSPATH, parseJavaArgs, TEST_CLASSPATH } from "@/platform/javaLaunch";
import { springBootPrefs } from "@/platform/springBootSettings";
import type { RunConfigTypeContribution, RunConfigTypeField } from "@/workbench/contributions";
import { formatArgs, parseArgs } from "./configs";
import { commandName } from "./commandName";
import { DEVTOOLS_TRIGGER_FILE, updatePolicyDefaults, updatePolicyFields, usesTriggerFile } from "./updatePolicies";

export const isWindows = () => typeof navigator !== "undefined" && /win/i.test(navigator.platform);

/** VM options / program arguments as typed; on Windows a backslash is a path separator. */
export const splitJvmArgs = (text: string | undefined, windows = isWindows()) => parseArgs(text ?? "", windows);

/** How Luma passed active profiles before (a program argument), still read from older configurations. */
export const PROFILES_ARG = "--spring.profiles.active=";
/** IDEA passes them as a system property: the files' `spring.profiles.active` loses to it. */
export const PROFILES_PROPERTY = "-Dspring.profiles.active=";

/**
 * Spring Boot options of the Modify options menu (`RunConfig.params[...] = "true"`), registered
 * by the Spring Boot plugin; the run configuration types apply them.
 */
export const SPRING_BOOT_OPTIONS = {
  debug: "springBoot.debugOutput",
  hideBanner: "springBoot.hideBanner",
  noOptimization: "springBoot.disableLaunchOptimization",
  noJmx: "springBoot.disableJmx",
} as const;

/** `key=value` lines of Override configuration properties (blank lines and `#` comments skipped). */
export function overrideProperties(text: string | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.search(/[=:]/);
    const key = (eq < 0 ? line : line.slice(0, eq)).trim();
    if (key) out.push([key, eq < 0 ? "" : line.slice(eq + 1).trim()]);
  }
  return out;
}

/**
 * System properties a Spring Boot launch gets from its configuration (IDEA's Spring section):
 * debug output, banner, active profiles, overridden properties, DevTools' trigger file.
 */
export function springBootJvmFlags(p: Readonly<Record<string, string>>): string[] {
  const on = (k: string) => p[k] === "true";
  const out: string[] = [];
  if (on(SPRING_BOOT_OPTIONS.debug)) out.push("-Ddebug");
  if (on(SPRING_BOOT_OPTIONS.hideBanner)) out.push("-Dspring.main.banner-mode=off");
  const profiles = p.activeProfiles?.trim();
  if (profiles) out.push(PROFILES_PROPERTY + profiles);
  for (const [k, v] of overrideProperties(p.overrideProperties)) out.push(`-D${k}=${v}`);
  if (usesTriggerFile(p.onUpdate)) out.push(`-Dspring.devtools.restart.trigger-file=${DEVTOOLS_TRIGGER_FILE}`);
  return out;
}

/** The launch optimization IDEA applies unless disabled (C1 only: faster startup). */
export function launchOptimization(p: Readonly<Record<string, string>>): string[] {
  return p[SPRING_BOOT_OPTIONS.noOptimization] === "true" ? [] : ["-XX:TieredStopAtLevel=1"];
}

/** An example, not text: shown as typed. */
const OVERRIDE_EXAMPLE = "server.port=9090";

const overridesField: RunConfigTypeField = {
  key: "overrideProperties",
  label: "Override configuration properties",
  control: "textarea",
  rows: 3,
  mono: true,
  placeholder: OVERRIDE_EXAMPLE,
  validate: (value) =>
    value
      .split(/\r?\n/)
      .map((l) => l.trim())
      .some((l) => l && !l.startsWith("#") && !/^[^=:\s][^=:]*[=:]/.test(l))
      ? "Each line is key=value"
      : null,
};

const VM_OPTIONS_PLACEHOLDER = "e.g. -Xmx1g -Dkey=value --add-opens java.base/java.lang=ALL-UNNAMED";

const vmOptionsField = (hint?: string, visible?: RunConfigTypeField["visible"]): RunConfigTypeField => ({
  key: "vmOptions",
  label: "VM options",
  control: "textarea",
  rows: 2,
  mono: true,
  placeholder: VM_OPTIONS_PLACEHOLDER,
  ...(hint ? { hint } : {}),
  ...(visible ? { visible } : {}),
});

const profilesField = (hint: string, visible?: RunConfigTypeField["visible"]): RunConfigTypeField => ({
  key: "activeProfiles",
  label: "Active profiles",
  mono: true,
  placeholder: "e.g. dev,local",
  hint,
  ...(visible ? { visible } : {}),
});

/** Main classes of the JVM configurations, offered while typing. */
function mainClasses(configs: readonly RunConfig[]): string[] {
  const out = new Set<string>();
  for (const c of configs) {
    if (c.kind !== "application" && c.kind !== "spring-boot") continue;
    const main = c.params?.mainClass || parseJavaArgs(c.args).mainClass;
    if (main) out.add(main);
  }
  return [...out];
}

function jvmApplicationType(spring: boolean): RunConfigTypeContribution {
  return {
    id: spring ? "spring-boot" : "application",
    label: spring ? "Spring Boot" : "Application",
    icon: spring ? "spring-boot" : "class",
    description: spring ? "Run a Spring Boot application" : "Run a Java main class",
    // Settings › Spring Boot can make new configurations start without the launch optimization.
    get defaults() {
      return {
        classpath: CLASSPATH,
        ...(spring ? updatePolicyDefaults : {}),
        ...(spring && springBootPrefs().disableLaunchOptimization
          ? { [SPRING_BOOT_OPTIONS.noOptimization]: "true" }
          : {}),
      };
    },
    debugAdapter: "java-debug",
    fields: [
      {
        key: "mainClass",
        label: "Main class",
        mono: true,
        required: true,
        placeholder: "e.g. com.example.Application",
        suggestions: mainClasses,
      },
      vmOptionsField(),
      { key: "programArgs", label: "Program arguments", mono: true },
      ...(spring ? [profilesField("Comma separated; passed as -Dspring.profiles.active"), overridesField] : []),
      ...(spring ? updatePolicyFields(false) : []),
      {
        key: "classpath",
        label: "Classpath",
        control: "select",
        options: [
          { value: CLASSPATH, label: "Runtime classpath of the module" },
          { value: TEST_CLASSPATH, label: "Test classpath of the module" },
        ],
      },
    ],
    commandLine(p) {
      const main = p.mainClass?.trim() ?? "";
      return {
        command: p.executable || "java",
        args: [
          ...(spring ? launchOptimization(p) : []),
          ...splitJvmArgs(p.vmOptions),
          ...(spring ? springBootJvmFlags(p) : []),
          "-cp",
          p.classpath || CLASSPATH,
          ...(main ? [main] : []),
          ...splitJvmArgs(p.programArgs),
        ],
      };
    },
    // Configurations detected or saved before these fields existed: `java [vm] -cp <cp> Main [args]`.
    paramsFrom(c) {
      if (!/^java$/i.test(commandName(c.command))) return null;
      const parsed = parseJavaArgs(c.args);
      const classpath =
        parsed.classpath === "runtime"
          ? CLASSPATH
          : parsed.classpath === "test"
            ? TEST_CLASSPATH
            : parsed.explicitClasspath;
      if (!parsed.mainClass || classpath === null) return null;
      const rest = parsed.programArgs;
      let vm = parsed.vmArgs;
      let activeProfiles = "";
      // The launch optimization leads the arguments; without it, the configuration disables it.
      const optimized = spring && vm[0] === "-XX:TieredStopAtLevel=1";
      if (optimized) vm = vm.slice(1);
      // Profiles as Luma's form writes them (after the VM options); an older program argument
      // `--spring.profiles.active=` stays a program argument, so the command line is the same.
      const last = vm.at(-1);
      if (spring && last?.startsWith(PROFILES_PROPERTY)) {
        activeProfiles = last.slice(PROFILES_PROPERTY.length);
        vm = vm.slice(0, -1);
      }
      return {
        ...(c.command !== "java" ? { executable: c.command } : {}),
        mainClass: parsed.mainClass,
        vmOptions: formatArgs(vm),
        programArgs: formatArgs(rest),
        classpath,
        ...(activeProfiles ? { activeProfiles } : {}),
        ...(spring && !optimized ? { [SPRING_BOOT_OPTIONS.noOptimization]: "true" } : {}),
      };
    },
  };
}

export const applicationType = jvmApplicationType(false);
export const springBootType = jvmApplicationType(true);

/**
 * One value for a Maven property holding JVM arguments (`spring-boot.run.jvmArguments`,
 * `argLine`): the plugins split it on whitespace, honouring "…" and '…'.
 */
export function joinPropertyArgs(args: readonly string[]): string {
  return args
    .map((a) => {
      if (a && !/[\s"']/.test(a)) return a;
      return a.includes('"') ? `'${a}'` : `"${a}"`;
    })
    .join(" ");
}

const words = (tasks: string | undefined) => (tasks ?? "").split(/\s+/).filter(Boolean);

const isSpringBootRun = (goal: string) =>
  goal === "spring-boot:run" || /:spring-boot-maven-plugin:[^:]*:run$/.test(goal);
const isMavenTestGoal = (goal: string) =>
  /^(test|verify|integration-test|surefire:test|failsafe:integration-test)$/.test(goal);
const isBootRun = (task: string) => /(^|:)bootRun$/.test(task);
const isGradleJvmTask = (task: string) => /(^|:)(test|bootRun|run|integrationTest|check)$/.test(task);

/** What a build tool configuration does with VM options and Spring Boot profiles. */
export interface ForkedJvm {
  fields: readonly RunConfigTypeField[];
  /** Arguments appended to the build tool's command line. */
  args(params: Readonly<Record<string, string>>): string[];
  prepareLaunch?(config: RunConfig): Promise<RunConfig>;
}

export const mavenForkedJvm: ForkedJvm = {
  fields: [
    vmOptionsField("Passed to the JVM that spring-boot:run or the tests start, not to Maven", (p) =>
      words(p.tasks).some((g) => isSpringBootRun(g) || isMavenTestGoal(g)),
    ),
    profilesField("Comma separated; passed as -Dspring-boot.run.profiles", (p) => words(p.tasks).some(isSpringBootRun)),
  ],
  args(p) {
    const goals = words(p.tasks);
    const vm = splitJvmArgs(p.vmOptions);
    const out: string[] = [];
    if (goals.some(isSpringBootRun)) {
      // Profiles go through the plugin's own property; the other Boot flags join the JVM's arguments.
      const flags = springBootJvmFlags({ ...p, activeProfiles: "" });
      const jvm = [...vm, ...flags];
      if (jvm.length) out.push(`-Dspring-boot.run.jvmArguments=${joinPropertyArgs(jvm)}`);
      const profiles = p.activeProfiles?.trim();
      if (profiles) out.push(`-Dspring-boot.run.profiles=${profiles}`);
    } else if (vm.length && goals.some(isMavenTestGoal)) {
      out.push(`-DargLine=${joinPropertyArgs(vm)}`);
    }
    return out;
  },
};

/** VM options (and profiles, as `-Dspring.profiles.active`) of a Gradle configuration's forked JVMs. */
export function gradleJvmArgs(p: Readonly<Record<string, string>>): string[] {
  const tasks = words(p.tasks);
  if (!tasks.some(isGradleJvmTask)) return [];
  if (!tasks.some(isBootRun)) return splitJvmArgs(p.vmOptions);
  return [...splitJvmArgs(p.vmOptions), ...springBootJvmFlags(p)];
}

export const gradleForkedJvm: ForkedJvm = {
  fields: [
    vmOptionsField("Passed to the JVMs the tasks start (bootRun, run, test), not to Gradle", (p) =>
      words(p.tasks).some(isGradleJvmTask),
    ),
    profilesField("Comma separated; passed as -Dspring.profiles.active", (p) => words(p.tasks).some(isBootRun)),
  ],
  // Gradle has no command-line switch for them: an init script adds them to the JavaExec / Test tasks.
  args: () => [],
  async prepareLaunch(config) {
    const jvmArgs = gradleJvmArgs(config.params ?? {});
    if (!jvmArgs.length) return config;
    if (config.target) throw new Error("VM options of Gradle configurations are not applied on run targets");
    const script = await call(commands.runGradleJvmArgsScript(jvmArgs));
    return { ...config, args: ["--init-script", script, ...config.args] };
  },
};
