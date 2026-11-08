/**
 * Spring Boot's part in starting applications (IDEA's JMX agent of the Spring Boot run
 * configuration): Spring Boot configurations with Actuator on the class path get the JMX and
 * Admin MBean switches and a session marker the live data sidecar finds the JVM by; their Run
 * tab gets the Beans / Health / Mappings / Environment views.
 */
import { parseJavaArgs, type JvmLaunchHook } from "@/platform/javaLaunch";
import { springBootPrefs } from "@/platform/springBootSettings";
import { selectSessionView, setSessionMark, useSessionMarks } from "@/workbench/contributions";
import { SPRING_BOOT_OPTIONS } from "@/features/run/jvmTypes";
import { useRun } from "@/features/run/store";
import { startLive, stopLive, useLive } from "./store";

export const LIVE_VIEWS = ["springBoot.beans", "springBoot.health", "springBoot.mappings", "springBoot.environment"];

const ACTUATOR = /(^|[\\/])spring-boot-actuator-\d[^\\/]*\.jar$/;

/** System properties exposing Actuator over JMX (Boot 3 exposes only health there by default). */
export const JMX_ARGS = [
  "-Dspring.jmx.enabled=true",
  "-Dspring.application.admin.enabled=true",
  "-Dmanagement.endpoints.jmx.exposure.include=*",
];

function mark(key: string) {
  const own = useSessionMarks.getState().marks[key];
  // Another feature's mark (Hot Reload) keeps its icon; the views add up.
  const views = [...new Set([...(own?.views ?? []), ...LIVE_VIEWS])];
  setSessionMark(key, {
    icon: own?.icon ?? "spring",
    tooltip: own?.tooltip ?? "Spring Boot",
    views,
    ...(own?.quiet ? { quiet: own.quiet } : {}),
  });
}

export function unmark(key: string) {
  const own = useSessionMarks.getState().marks[key];
  if (!own) return;
  const views = (own.views ?? []).filter((v) => !LIVE_VIEWS.includes(v));
  const selected = useSessionMarks.getState().selected[key];
  if (selected && LIVE_VIEWS.includes(selected)) selectSessionView(key, null);
  setSessionMark(key, own.icon === "spring" && !views.length ? null : { ...own, views });
}

export const liveHook: JvmLaunchHook = {
  async application(ctx) {
    const { config, session, info } = ctx;
    if (config.kind !== "spring-boot" || !springBootPrefs().enabled || !springBootPrefs().liveData) return null;
    if (config.params?.[SPRING_BOOT_OPTIONS.noJmx] === "true") return null;
    if (!info.classPaths.some((p) => ACTUATOR.test(p))) return null;
    const marker = session?.key ?? `debug:${config.id}:${Date.now()}`;
    if (session) {
      mark(session.key);
      startLive(session.key, marker, parseJavaArgs(config.args).mainClass, config.id);
    }
    return { javaExec: null, vmArgs: [...JMX_ARGS, `-Dluma.run.session=${marker}`] };
  },
};

/** Ends the live data of Run sessions that exited, restarted or closed. */
export function trackLiveSessions(): () => void {
  return useRun.subscribe((s) => {
    for (const live of Object.values(useLive.getState().sessions)) {
      const session = s.sessions.find((x) => `run:${x.id}` === live.key);
      // Still preparing ("starting") or running: keep following it.
      if (session && (session.status === "starting" || session.status === "running")) continue;
      stopLive(live.key);
      if (!session) unmark(live.key);
    }
  });
}
