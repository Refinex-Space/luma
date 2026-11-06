/**
 * Which launches hot-reload and how the runtime and agents get into each kind of JVM:
 * Application / Spring Boot (the launcher and VM options of the `java` command line, in
 * Run and in java-debug's launch), Maven `spring-boot:run` (`-Dspring-boot.run.jvmArguments`
 * and `JAVA_HOME`), Gradle `bootRun` (an init script setting the task's `executable` and
 * JVM arguments) and Tomcat (`JAVA_HOME` through the JRE field, `CATALINA_OPTS`).
 */
import type { RunConfig } from "@/platform/ipc";
import type { HotReloadPrefs } from "@/platform/hotReloadSettings";

/** `params` flag: this configuration runs with hot reload (Modify options › Use hot reload, the executors). */
export const HOT_RELOAD_PARAM = "hotReload";

const words = (s: string | undefined) => (s ?? "").split(/\s+/).filter(Boolean);
const isSpringBootRun = (a: string) => a === "spring-boot:run" || /:spring-boot-maven-plugin:[^:]*:run$/.test(a);
const isBootRun = (a: string) => /(^|:)bootRun$/.test(a);

const goals = (config: RunConfig) => [...config.args, ...words(config.params?.tasks)];

export const isMavenBootRun = (config: RunConfig) =>
  (config.kind === "maven" || /(^|[\\/])mvnw?(\.cmd)?$/.test(config.command)) && goals(config).some(isSpringBootRun);
export const isGradleBootRun = (config: RunConfig) =>
  (config.kind === "gradle" || /(^|[\\/])gradlew?(\.bat)?$/.test(config.command)) && goals(config).some(isBootRun);

/** Configurations hot reload can run: JVM applications, `spring-boot:run`, `bootRun`, Tomcat (local only). */
export function supportsHotReload(config: RunConfig): boolean {
  if (config.target || config.isTest) return false;
  return (
    config.kind === "application" ||
    config.kind === "spring-boot" ||
    config.kind === "tomcat" ||
    isMavenBootRun(config) ||
    isGradleBootRun(config)
  );
}

/**
 * Whether this launch hot-reloads: through the executors or Use hot reload (the flag), or a
 * Spring Boot configuration while "Use hot reload for Spring Boot by default" is on.
 */
export function wantsHotReload(config: RunConfig, prefs: HotReloadPrefs): boolean {
  if (!prefs.enabled || !supportsHotReload(config)) return false;
  const flag = config.params?.[HOT_RELOAD_PARAM];
  if (flag === "false") return false;
  return flag === "true" || (prefs.springBootDefault && config.kind === "spring-boot");
}

/** `config` flagged to hot-reload (the executors). */
export function withHotReload(config: RunConfig): RunConfig {
  return { ...config, params: { ...config.params, [HOT_RELOAD_PARAM]: "true" } };
}

/** The JDK home of a `…/bin/java` launcher. */
export function javaHomeOf(javaExec: string): string {
  return javaExec.replace(/[\\/]bin[\\/]java(?:w)?(?:\.exe)?$/i, "");
}

/** Arguments as one shell-like value (Maven properties, `CATALINA_OPTS`): quoted when they hold spaces. */
export function joinOptions(args: readonly string[]): string {
  return args
    .map((a) => {
      if (a && !/[\s"']/.test(a)) return a;
      return a.includes('"') ? `'${a}'` : `"${a}"`;
    })
    .join(" ");
}

export interface HotReloadVm {
  /** `null`: the project's JDK stays (JRebel). */
  javaExec: string | null;
  vmArgs: string[];
  /** Java version of the JetBrains Runtime (`null` with JRebel). */
  major?: number | null;
}

const PROPERTY = "spring-boot.run.jvmArguments";

/** Maven `spring-boot:run`: the options go first into the forked JVM's arguments; Maven runs on the runtime. */
export function mavenHotReload(launch: RunConfig, vm: HotReloadVm): RunConfig {
  const prefix = `-D${PROPERTY}=`;
  const value = joinOptions(vm.vmArgs);
  const args = [...launch.args];
  const i = args.findIndex((a) => a.startsWith(prefix));
  if (i < 0) {
    // Before the goals, like the property the form writes.
    const at = args.findIndex(isSpringBootRun);
    args.splice(at < 0 ? args.length : at, 0, prefix + value);
  } else {
    const current = args[i]!.slice(prefix.length).trim();
    args[i] = prefix + (current ? `${value} ${current}` : value);
  }
  const env = vm.javaExec ? { ...launch.env, JAVA_HOME: javaHomeOf(vm.javaExec) } : launch.env;
  return { ...launch, args, env };
}

/** Groovy string literal. */
const groovy = (s: string) =>
  `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r")}'`;

/**
 * Init script for Gradle `bootRun`: its JVM runs on the runtime with the agents. Spring Boot's
 * task reads its toolchain `javaLauncher`, so the launcher is replaced by the JetBrains Runtime
 * toolchain (found through `org.gradle.java.installations.paths`, see [gradleHotReload]) once
 * the build scripts have configured the task.
 */
export function gradleInitScript(vm: HotReloadVm): string {
  const args = vm.vmArgs.map(groovy).join(", ");
  const launcher =
    vm.javaExec && vm.major
      ? "\n      t.javaLauncher.set(t.project.extensions.getByType(JavaToolchainService).launcherFor { spec ->" +
        `\n        spec.languageVersion = JavaLanguageVersion.of(${vm.major})` +
        "\n        spec.vendor = JvmVendorSpec.JETBRAINS" +
        "\n      })"
      : "";
  return (
    "// Written by Luma: hot reload of the bootRun task.\n" +
    "gradle.projectsEvaluated {\n" +
    "  allprojects {\n" +
    "    tasks.withType(JavaExec).matching { it.name == 'bootRun' }.configureEach { t ->" +
    launcher +
    `\n      t.jvmArgs([${args}])\n` +
    "    }\n" +
    "  }\n" +
    "}\n"
  );
}

/** Gradle: `--init-script <script>` first, and the runtime among the toolchains Gradle knows. */
export function gradleHotReload(launch: RunConfig, script: string, vm?: HotReloadVm): RunConfig {
  const paths = vm?.javaExec && vm.major ? [`-Porg.gradle.java.installations.paths=${javaHomeOf(vm.javaExec)}`] : [];
  return { ...launch, args: ["--init-script", script, ...paths, ...launch.args] };
}

/** Tomcat: the runtime as its JRE, the options first in `CATALINA_OPTS`. */
export function tomcatHotReload(launch: RunConfig, vm: HotReloadVm): RunConfig {
  const current = launch.env.CATALINA_OPTS?.trim();
  const opts = joinOptions(vm.vmArgs);
  return {
    ...launch,
    params: vm.javaExec ? { ...launch.params, jre: javaHomeOf(vm.javaExec) } : launch.params,
    env: { ...launch.env, CATALINA_OPTS: current ? `${opts} ${current}` : opts },
  };
}

/** FNV-1a of `text`, hex: names generated files by their content. */
export function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
