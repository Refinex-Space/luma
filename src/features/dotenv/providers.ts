/**
 * Where environment variables are declared (the JetBrains plugin's
 * `EnvironmentVariablesProvider`s): `.env` files, the `environment:` sections of
 * `docker-compose.yml` and the `ENV` instructions of Dockerfiles. A plain `.env` is a
 * primary source; `.env.example`, `.env.local` and the like are secondary: their values
 * and declarations count only where no primary source has the variable.
 *
 * File names mirror `ide-host::ops::dotenv`, which lists these files.
 */
import { parseDotEnv, type Span } from "./syntax";

export type SourceKind = "dotenv" | "compose" | "dockerfile";

export interface KeyValue {
  key: string;
  value: string;
  /** The key in the file text. */
  keySpan: Span;
}

const CODE_EXTENSIONS = new Set(
  "js mjs cjs ts mts cts json py php rb go rs sh yml yaml toml".split(" ").map((e) => e.toLowerCase()),
);

export function isDotEnvName(name: string): boolean {
  if (name === ".env" || name === ".flaskenv") return true;
  if (name.startsWith(".env.")) {
    const rest = name.slice(5);
    return rest !== "" && !CODE_EXTENSIONS.has(rest.slice(rest.lastIndexOf(".") + 1).toLowerCase());
  }
  return name.length > 4 && name.endsWith(".env");
}

export function isComposeName(name: string): boolean {
  return /^(?:docker-)?compose(?:[.-][^/]*)?\.ya?ml$/i.test(name);
}

export function isDockerfileName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === "dockerfile" ||
    lower === "containerfile" ||
    lower.startsWith("dockerfile.") ||
    (lower.length > 11 && lower.endsWith(".dockerfile"))
  );
}

export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function sourceKind(path: string): SourceKind | null {
  const name = baseName(path);
  if (isDotEnvName(name)) return "dotenv";
  if (isComposeName(name)) return "compose";
  if (isDockerfileName(name)) return "dockerfile";
  return null;
}

/** Whether a source's declarations win over the secondary ones (`.env.example`). */
export const isPrimarySource = (path: string, kind: SourceKind) => kind !== "dotenv" || baseName(path) === ".env";

export function declarationsIn(kind: SourceKind, text: string): KeyValue[] {
  switch (kind) {
    case "dotenv":
      return parseDotEnv(text).properties.map((p) => ({
        key: p.key,
        value: p.value?.text ?? "",
        keySpan: p.keySpan,
      }));
    case "compose":
      return composeEnvironment(text);
    case "dockerfile":
      return dockerfileEnv(text);
  }
}

const unquote = (v: string) => {
  const t = v.trim();
  return t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.endsWith(t[0]) ? t.slice(1, -1) : t;
};

/** Value of a YAML scalar on one line, its comment dropped. */
function yamlScalar(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"') || t.startsWith("'")) {
    const end = t.indexOf(t[0]!, 1);
    return end > 0 ? t.slice(1, end) : t.slice(1);
  }
  return t.replace(/\s+#.*$/, "");
}

/**
 * `environment:` of the services, as a map (`KEY: value`) or a list (`- KEY=value`,
 * `- "KEY=value"`, `- KEY`).
 */
export function composeEnvironment(text: string): KeyValue[] {
  const out: KeyValue[] = [];
  let block: number | null = null;
  let offset = 0;
  for (const line of text.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    const content = line.replace(/\r$/, "");
    if (!content.trim() || /^\s*#/.test(content)) continue;
    const indent = content.search(/\S/);
    if (block !== null && indent <= block) block = null;
    if (block === null) {
      const m = /^(\s*)environment\s*:\s*(?:#.*)?$/.exec(content);
      if (m) block = m[1]!.length;
      continue;
    }
    const list = /^(\s*-\s*)(["']?)([^=\s"'#]+)(?:=(.*?))?\2\s*(?:#.*)?$/.exec(content);
    if (list) {
      const from = lineStart + list[1]!.length + list[2]!.length;
      out.push({ key: list[3]!, value: list[4] ?? "", keySpan: { from, to: from + list[3]!.length } });
      continue;
    }
    const map = /^(\s*)(["']?)([^:\s"'#]+)\2\s*:(.*)$/.exec(content);
    if (map) {
      const from = lineStart + map[1]!.length + map[2]!.length;
      out.push({ key: map[3]!, value: yamlScalar(map[4]!), keySpan: { from, to: from + map[3]!.length } });
    }
  }
  return out;
}

/** `ENV KEY=value KEY2="v 2"` and the legacy `ENV KEY value with spaces`, with `\` continuations. */
export function dockerfileEnv(text: string): KeyValue[] {
  const out: KeyValue[] = [];
  const lines = text.split("\n");
  let offset = 0;
  let continuing = false;
  for (const raw of lines) {
    const lineStart = offset;
    offset += raw.length + 1;
    const line = raw.replace(/\r$/, "");
    let rest: string;
    let restFrom: number;
    const env = /^(\s*ENV\s+)/i.exec(line);
    if (env) {
      rest = line.slice(env[1]!.length);
      restFrom = lineStart + env[1]!.length;
    } else if (continuing) {
      rest = line;
      restFrom = lineStart;
    } else continue;
    continuing = /\\\s*$/.test(line);
    rest = rest.replace(/\\\s*$/, "");
    if (env && !/^[^\s=]+=/.test(rest.trim())) {
      // Legacy form: one variable, the rest of the line its value.
      const m = /^(\s*)([^\s=]+)\s*(.*)$/.exec(rest);
      if (m) {
        const from = restFrom + m[1]!.length;
        out.push({ key: m[2]!, value: unquote(m[3]!), keySpan: { from, to: from + m[2]!.length } });
      }
      continue;
    }
    const pair = /([^\s=]+)=("(?:[^"\\]|\\.)*"|'[^']*'|\S*)/g;
    for (let m; (m = pair.exec(rest));) {
      const from = restFrom + m.index;
      out.push({ key: m[1]!, value: unquote(m[2]!), keySpan: { from, to: from + m[1]!.length } });
    }
  }
  return out;
}
