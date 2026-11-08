/**
 * How a completed configuration key is written (IDEA / Spring Tools' structured insertion):
 * in `.properties` the key and its separator; in YAML the key's elements as nested mappings
 * under the caret's parent — merged into a mapping of the document that already holds a
 * prefix of the key (the typed line is then removed), the caret left where the value goes.
 */
import type { BootSuffix, YamlInsert } from "@/platform/ipc";

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

export interface KeyEdit {
  changes: TextChange[];
  /** The caret, in the document after the changes. */
  cursor: number;
  /** Ask for completion again (nested keys, values). */
  retrigger: boolean;
}

/** Relaxed form of a key element (`max-Pool_size` → `maxpoolsize`); indexes kept. */
function uniform(element: string): string {
  return element.startsWith("[") ? element : element.replace(/[-_]/g, "").toLowerCase();
}

/** Canonical key (see `ide_spring_boot::name::canonical`). */
export function canonical(key: string): string {
  const out: string[] = [];
  for (const m of key.matchAll(/\[[^\]]*\]?|[^.[]+/g)) {
    const e = m[0];
    if (e.startsWith("[")) {
      const inner = e.replace(/^\[|\]$/g, "").replace(/^(["'])(.*)\1$/, "$2");
      out.push(`[${inner}]`);
    } else out.push(uniform(e));
  }
  return out.join(".").replace(/\.\[/g, "[");
}

function join(parent: string, rest: string): string {
  if (!parent) return rest;
  return rest.startsWith("[") ? `${parent}${rest}` : `${parent}.${rest}`;
}

const suffixText = (suffix: BootSuffix, indent: string): string => {
  switch (suffix) {
    case "value":
      return ": ";
    case "list":
      return `:\n${indent}- `;
    case "nested":
      return `:\n${indent}`;
    case "index":
      return `:\n${indent}- `;
    case "none":
      return "";
  }
};

/** Nested mapping lines for `elements`, the first at `column` (written `lead` before it). */
function nested(elements: readonly string[], column: number, unit: number, suffix: BootSuffix, lead: boolean): string {
  let text = "";
  elements.forEach((e, i) => {
    const pad = " ".repeat(column + i * unit);
    if (i > 0 || lead) text += pad;
    text += e;
    if (i < elements.length - 1) text += ":\n";
  });
  const last = column + (elements.length - 1) * unit;
  return text + suffixText(suffix, " ".repeat(last + unit));
}

/**
 * The edit writing YAML key `elements` (under the context's parent) for typed text `from`–`to`
 * of document `doc`.
 */
export function yamlKeyEdit(
  doc: string,
  ctx: YamlInsert,
  from: number,
  to: number,
  elements: readonly string[],
  suffix: BootSuffix,
): KeyEdit {
  const retrigger = suffix !== "none";
  // The deepest mapping of the document holding a proper prefix of the key.
  let target: { at: number; indent: number; depth: number } | null = null;
  let key = ctx.parent;
  for (let i = 0; i < elements.length - 1; i++) {
    key = join(key, canonical(elements[i]!));
    const found = ctx.paths.find((p) => p.key === key);
    if (found) target = { at: found.at, indent: found.indent, depth: i + 1 };
  }
  if (!target) {
    const insert = nested(elements, ctx.column, ctx.indentUnit, suffix, false);
    return { changes: [{ from, to, insert }], cursor: from + insert.length, retrigger };
  }
  const rest = elements.slice(target.depth);
  const text = `\n${nested(rest, target.indent, ctx.indentUnit, suffix, true)}`;
  // Remove the typed line (with its line break).
  const lineEnd = ctx.lineTo < doc.length ? ctx.lineTo + 1 : ctx.lineTo;
  const lineStart = lineEnd === ctx.lineTo && ctx.lineFrom > 0 ? ctx.lineFrom - 1 : ctx.lineFrom;
  const removed = { from: lineStart, to: lineEnd, insert: "" };
  const added = { from: target.at, to: target.at, insert: text };
  const changes = [added, removed].sort((a, b) => a.from - b.from);
  // The caret after the inserted text, in the new document.
  let cursor = target.at + text.length;
  if (removed.to <= target.at) cursor -= removed.to - removed.from;
  return { changes, cursor, retrigger };
}

/** The text inserted for a `.properties` key and whether to ask for completion again. */
export function propertiesKeyText(name: string, suffix: BootSuffix): { text: string; retrigger: boolean } {
  switch (suffix) {
    case "value":
    case "list":
      return { text: `${name}=`, retrigger: true };
    case "nested":
      return { text: `${name}.`, retrigger: true };
    case "index":
      return { text: `${name}[`, retrigger: false };
    case "none":
      return { text: name, retrigger: name.endsWith(".") };
  }
}
