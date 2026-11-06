/**
 * HotswapAgent's log (`HOTSWAP AGENT: HH:mm:ss.SSS LEVEL (logger) - message` on stdout)
 * read as what happened: the agent started, framework plugins initialized, classes
 * reloaded, Spring beans added / refreshed, properties and MyBatis mappers reloaded,
 * warnings and errors.
 */

export const AGENT_PREFIX = "HOTSWAP AGENT:";

export type AgentLevel = "TRACE" | "DEBUG" | "INFO" | "RELOAD" | "WARNING" | "ERROR";

export interface AgentLine {
  /** `17:09:21.281` as written. */
  time: string;
  /** Milliseconds since midnight (local time of the JVM). */
  ms: number;
  level: AgentLevel;
  logger: string;
  message: string;
}

const LINE =
  /^\s*HOTSWAP AGENT:\s+(\d{1,2}):(\d{2}):(\d{2})\.(\d{3})\s+(TRACE|DEBUG|INFO|RELOAD|WARNING|ERROR)\s+\(([^)]*)\)\s+-\s+(.*?)\s*$/;

export function parseAgentLine(text: string): AgentLine | null {
  const m = LINE.exec(text);
  if (!m) return null;
  const [, h, min, s, ms, level, logger, message] = m;
  return {
    time: `${h!.padStart(2, "0")}:${min}:${s}.${ms}`,
    ms: ((Number(h) * 60 + Number(min)) * 60 + Number(s)) * 1000 + Number(ms),
    level: level as AgentLevel,
    logger: logger!,
    message: message!,
  };
}

export type AgentEvent =
  | { kind: "started"; version: string }
  | { kind: "plugin"; name: string; version: string | null }
  | { kind: "classes"; classes: string[] }
  | { kind: "beanAdded"; bean: string }
  | { kind: "beanRefreshed"; bean: string | null }
  | { kind: "properties"; file: string | null }
  | { kind: "mapper"; name: string }
  | { kind: "noChange" }
  | { kind: "warning"; message: string }
  | { kind: "error"; message: string }
  | { kind: "other" };

const quoted = (message: string) => /'([^']+)'/.exec(message)?.[1] ?? null;

/** The last path segment of a `file:/…/application.properties` or `…/UserMapper.xml`. */
export function fileName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? path
  );
}

/** What one agent line says. */
export function agentEvent(line: AgentLine): AgentEvent {
  const { level, logger, message } = line;
  if (level === "ERROR") return { kind: "error", message };
  if (level === "WARNING") return { kind: "warning", message };
  let m = /^Loading Hotswap agent\s+(\S+)/i.exec(message);
  if (m) return { kind: "started", version: m[1]! };
  m = /^(.+?) plugin initialized(?:.*?version\s+'([^']+)')?/i.exec(message);
  if (m) return { kind: "plugin", name: m[1]!.trim(), version: m[2] ?? null };
  m = /^Reloading classes \[([^\]]*)\]/i.exec(message);
  if (m)
    return {
      kind: "classes",
      classes: m[1]!
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean),
    };
  if (/^no change, ignore reloading/i.test(message)) return { kind: "noChange" };
  m = /^add new spring bean '([^']+)'/i.exec(message);
  if (m) return { kind: "beanAdded", bean: m[1]! };
  if (/changed property|properties of .* (?:is|are) changed|reload(?:ing)? (?:spring )?propert/i.test(message)) {
    const file = /changed property '([^']+)'/i.exec(message)?.[1];
    return { kind: "properties", file: file ? fileName(file) : null };
  }
  if (/mybatis/i.test(logger) && /mapper|\.xml\b|reload/i.test(message)) {
    const name = /([\w.-]+\.xml)\b/.exec(message)?.[1] ?? quoted(message) ?? "mapper";
    return { kind: "mapper", name: fileName(name) };
  }
  if (/spring/i.test(logger) && /\b(?:reload|refresh|recreat|destroy)\w*\b.*\bbean/i.test(message))
    return { kind: "beanRefreshed", bean: quoted(message) };
  return { kind: "other" };
}

/** `demo.HelloController$Inner` → `demo/HelloController`: the source file it compiles from (without extension). */
export function classSourcePath(className: string): string {
  return className.split("$")[0]!.replace(/\./g, "/");
}
