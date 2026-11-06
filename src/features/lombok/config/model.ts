/**
 * `lombok.config` as Lombok reads it (`lombok.core.configuration.ConfigurationParser`):
 * one directive per line — `key = value`, `key += value` / `key -= value` (lists),
 * `clear key`, `import path` — and `#` comment lines. Keys and enum / boolean values are
 * case-insensitive. Pure: parsing, the problems IDEA's Lombok plugin reports, completion
 * candidates and key documentation.
 */
import { tx } from "@/platform/i18n";
import { CONFIG_KEYS, type ConfigKey } from "./keys";

const BY_NAME = new Map(CONFIG_KEYS.map((k) => [k.key.toLowerCase(), k]));

export function configKey(name: string): ConfigKey | undefined {
  return BY_NAME.get(name.trim().toLowerCase());
}

export type Operator = "=" | "+=" | "-=";

/** A directive, with offsets into the whole text. */
export type ConfigLine =
  | { kind: "comment"; from: number; to: number }
  | { kind: "clear"; from: number; to: number; keyFrom: number; key: string }
  | { kind: "import"; from: number; to: number; pathFrom: number; path: string }
  | {
      kind: "set";
      from: number;
      to: number;
      keyFrom: number;
      key: string;
      op: Operator;
      opFrom: number;
      valueFrom: number;
      value: string;
    }
  /** Text that is no directive (`lombok.foo` without `=`). */
  | { kind: "invalid"; from: number; to: number; text: string };

const SET = /^([^=+\-\s][^=]*?)\s*([+-]?=)\s*(.*?)\s*$/;

/** The directives of `text` (blank lines left out). */
export function parseConfig(text: string): ConfigLine[] {
  const out: ConfigLine[] = [];
  let from = 0;
  for (const raw of text.split("\n")) {
    const lineFrom = from;
    from += raw.length + 1;
    const line = raw.replace(/\r$/, "");
    const lead = line.length - line.trimStart().length;
    const body = line.trim();
    if (!body) continue;
    const start = lineFrom + lead;
    const end = lineFrom + line.trimEnd().length;
    if (body.startsWith("#")) {
      out.push({ kind: "comment", from: start, to: end });
      continue;
    }
    const clear = /^clear(\s+)(\S.*)$/.exec(body);
    if (clear) {
      out.push({ kind: "clear", from: start, to: end, keyFrom: start + 5 + clear[1]!.length, key: clear[2]!.trim() });
      continue;
    }
    const imp = /^import(\s+)(\S.*)$/.exec(body);
    if (imp) {
      out.push({ kind: "import", from: start, to: end, pathFrom: start + 6 + imp[1]!.length, path: imp[2]!.trim() });
      continue;
    }
    const set = SET.exec(body);
    if (set) {
      const key = set[1]!;
      const opFrom = start + body.indexOf(set[2]!, key.length);
      const value = set[3]!;
      const valueFrom = value ? start + body.lastIndexOf(value) : opFrom + set[2]!.length;
      out.push({
        kind: "set",
        from: start,
        to: end,
        keyFrom: start,
        key,
        op: set[2] as Operator,
        opFrom,
        valueFrom,
        value,
      });
      continue;
    }
    out.push({ kind: "invalid", from: start, to: end, text: body });
  }
  return out;
}

export interface ConfigProblem {
  from: number;
  to: number;
  message: string;
  severity: "error" | "warning";
  /** Unknown key: the known key it most likely means. */
  replacement?: string;
}

/** Edit distance (Levenshtein) of `a` and `b`, case-insensitive. */
function distance(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const row = [i];
    for (let j = 1; j <= t.length; j++)
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (s[i - 1] === t[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[t.length]!;
}

/** The known key `name` most likely misspells, if one is close enough. */
export function closestKey(name: string): string | undefined {
  const n = name.trim();
  let best: { key: string; d: number } | undefined;
  for (const k of CONFIG_KEYS) {
    const d = distance(n, k.key);
    if (!best || d < best.d) best = { key: k.key, d };
  }
  // A typo, not another key: a few edits, relative to the name's length.
  return best && best.d <= Math.max(2, Math.floor(n.length / 4)) ? best.key : undefined;
}

const valueList = (k: ConfigKey) => (k.values ?? []).join(", ");

/** What Lombok rejects or ignores in `text`. */
export function validateConfig(text: string): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const unknown = (name: string, from: number) => {
    const replacement = closestKey(name);
    out.push({
      from,
      to: from + name.length,
      message: replacement ? tx`Unknown key '${name}'; did you mean '${replacement}'?` : tx`Unknown key '${name}'`,
      severity: "error",
      replacement,
    });
  };
  for (const line of parseConfig(text)) {
    switch (line.kind) {
      case "invalid":
        out.push({
          from: line.from,
          to: line.to,
          message: tx("Expected 'key = value', 'key += value', 'key -= value', 'clear key' or 'import path'"),
          severity: "error",
        });
        break;
      case "clear":
        if (!configKey(line.key)) unknown(line.key, line.keyFrom);
        break;
      case "import":
        break;
      case "set": {
        const key = configKey(line.key);
        if (!key) {
          unknown(line.key, line.keyFrom);
          break;
        }
        if (line.op !== "=" && key.kind !== "list") {
          const { op } = line;
          const name = key.key;
          out.push({
            from: line.opFrom,
            to: line.opFrom + op.length,
            message: tx`'${op}' adds to or removes from a list; '${name}' takes one value: use '='`,
            severity: "error",
          });
          break;
        }
        if (!line.value) {
          const name = key.key;
          out.push({
            from: line.opFrom,
            to: line.opFrom + line.op.length,
            message: tx`Missing value of '${name}'`,
            severity: "error",
          });
          break;
        }
        const { value } = line;
        if (key.values?.length && !key.values.some((v) => v.toLowerCase() === value.toLowerCase())) {
          const [name, values] = [key.key, valueList(key)];
          out.push({
            from: line.valueFrom,
            to: line.valueFrom + value.length,
            message: tx`'${value}' is not a value of '${name}' (${values})`,
            severity: "error",
          });
        }
        break;
      }
    }
  }
  return out;
}

/** Where the caret is in its line, for completion. */
export type ConfigContext =
  /** At the start of a directive: keys, `clear`, `import`. */
  | { kind: "directive"; from: number; typed: string }
  /** After `clear `: keys. */
  | { kind: "clearKey"; from: number; typed: string }
  /** After a key (and spaces): the operators it takes. */
  | { kind: "operator"; from: number; key: ConfigKey }
  /** After `key =`: its values. */
  | { kind: "value"; from: number; typed: string; key: ConfigKey; op: Operator }
  | null;

/** The completion context at `pos` of `text`. */
export function contextAt(text: string, pos: number): ConfigContext {
  const lineFrom = text.lastIndexOf("\n", pos - 1) + 1;
  const before = text.slice(lineFrom, pos);
  const lead = before.length - before.trimStart().length;
  const body = before.slice(lead);
  if (body.startsWith("#")) return null;
  const set = /^([^=\s]+)\s*([+-]?=)\s*(.*)$/.exec(body);
  if (set) {
    const key = configKey(set[1]!);
    if (!key) return null;
    const typed = set[3]!;
    return { kind: "value", from: pos - typed.length, typed, key, op: set[2] as Operator };
  }
  const clear = /^clear\s+(\S*)$/.exec(body);
  if (clear) return { kind: "clearKey", from: pos - clear[1]!.length, typed: clear[1]! };
  if (/^import\s/.test(body)) return null;
  const word = /^(\S*)$/.exec(body);
  if (word) return { kind: "directive", from: lineFrom + lead, typed: word[1]! };
  const keyThenSpace = /^(\S+)\s+([+-]?)$/.exec(body);
  if (keyThenSpace) {
    const key = configKey(keyThenSpace[1]!);
    if (key) return { kind: "operator", from: pos - keyThenSpace[2]!.length, key };
  }
  return null;
}

/** Operators `key` takes: lists are added to and removed from, others set. */
export const operatorsOf = (key: ConfigKey): Operator[] => (key.kind === "list" ? ["+=", "-=", "="] : ["="]);

/** Quick Documentation of `key` (Markdown). */
export function keyDoc(key: ConfigKey): string {
  const lines = [`**${key.key}**  \`${key.type}\``, "", key.doc];
  const code = (v: string) => `\`${v}\``;
  const values = key.values ?? key.suggestions;
  if (values?.length) lines.push("", `${tx("Values:")} ${values.map(code).join(" | ")}`);
  else if (key.example) lines.push("", `${tx("Value:")} ${code(key.example)}`);
  if (key.default) lines.push("", `${tx("Default:")} ${code(key.default)}`);
  return lines.join("\n");
}

/** The key a hover at `pos` is over (with its range), if any. */
export function keyAt(text: string, pos: number): { from: number; to: number; key: ConfigKey } | null {
  for (const line of parseConfig(text)) {
    if (pos < line.from || pos > line.to) continue;
    if (line.kind !== "set" && line.kind !== "clear") return null;
    const name = line.key.trimEnd();
    if (pos < line.keyFrom || pos > line.keyFrom + name.length) return null;
    const key = configKey(name);
    return key ? { from: line.keyFrom, to: line.keyFrom + name.length, key } : null;
  }
  return null;
}
