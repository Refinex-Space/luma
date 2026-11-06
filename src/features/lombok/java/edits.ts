/**
 * Text edits of the Lombok refactorings: members removed with their lines, annotations
 * added on their own line, imports added in order and dropped when unused. Edits of one
 * step are non-overlapping ranges of the same text, applied together.
 */
import { identifierRefs, parseJava, usedIdentifiers, type JavaFile } from "./syntax";

export interface Edit {
  from: number;
  to: number;
  insert: string;
}

/** Applies non-overlapping `edits` to `text` (an insertion and a replacement at one position: the insertion first). */
export function applyEdits(text: string, edits: readonly Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.from - a.from || b.to - b.from - (a.to - a.from));
  let out = text;
  for (const e of sorted) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return out;
}

/** The one change turning `before` into `after` (shared prefix and suffix left alone). */
export function minimalChange(before: string, after: string): Edit | null {
  if (before === after) return null;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let end = 0;
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) };
}

export const lineStart = (text: string, pos: number) => text.lastIndexOf("\n", pos - 1) + 1;

function lineEnd(text: string, pos: number): number {
  const i = text.indexOf("\n", pos);
  return i < 0 ? text.length : i;
}

/** The whitespace before `pos` on its line, when only whitespace precedes it there. */
export function indentAt(text: string, pos: number): string {
  const before = text.slice(lineStart(text, pos), pos);
  return /^\s*$/.test(before) ? before : "";
}

/** Removes `from`–`to` (a member with its doc comment) with its own lines and the blank lines after it. */
export function removeLines(text: string, from: number, to: number): Edit {
  const start = lineStart(text, from);
  if (text.slice(start, from).trim()) return { from, to, insert: "" };
  let end = lineEnd(text, to);
  if (text.slice(to, end).trim()) return { from: start, to, insert: "" };
  // The blank lines after it go with it (the ones before stay: they separated the previous member).
  while (end < text.length) {
    const next = lineEnd(text, end + 1);
    if (text.slice(end + 1, next).trim() || next === text.length) break;
    end = next;
  }
  return { from: start, to: Math.min(text.length, end + 1), insert: "" };
}

/** Removes an import declaration with its line (the blank lines around it stay). */
export function removeImport(text: string, from: number, to: number): Edit {
  const start = lineStart(text, from);
  const end = lineEnd(text, to);
  return { from: start, to: Math.min(text.length, end + 1), insert: "" };
}

/** Removes an annotation: its line when it is alone there, else it and the spaces after it. */
export function removeAnnotation(text: string, from: number, to: number): Edit {
  const start = lineStart(text, from);
  const end = lineEnd(text, to);
  if (!text.slice(start, from).trim() && !text.slice(to, end).trim())
    return { from: start, to: Math.min(text.length, end + 1), insert: "" };
  let e = to;
  while (text[e] === " " || text[e] === "\t") e++;
  return { from, to: e, insert: "" };
}

/** `@Name` on its own line before the declaration starting at `pos` (IDEA puts it first). */
export function addAnnotationAt(text: string, pos: number, annotation: string): Edit {
  const indent = indentAt(text, pos);
  return {
    from: pos,
    to: pos,
    insert: indent || lineStart(text, pos) === pos ? `${annotation}\n${indent}` : `${annotation} `,
  };
}

const simpleName = (fqn: string) => fqn.slice(fqn.lastIndexOf(".") + 1);
const javaGroup = (path: string) => /^javax?\./.test(path);

/** `import fqn;` unless the name already refers to it; ordered among the imports (java / javax last, as IDEA). */
export function addImport(file: JavaFile, fqn: string): Edit | null {
  const pkg = fqn.slice(0, fqn.lastIndexOf("."));
  const text = file.text;
  if (file.imports.some((i) => !i.isStatic && (i.wildcard ? i.path === pkg : i.path === fqn))) return null;
  const line = `import ${fqn};`;
  const plain = file.imports.filter((i) => !i.isStatic);
  if (!file.imports.length) {
    const first = file.classes[0];
    if (file.packageEnd) {
      // After `package …;`, a blank line before and after.
      let p = file.packageEnd;
      while (p < text.length && /\s/.test(text[p]!)) p++;
      return { from: p, to: p, insert: `${line}\n\n` };
    }
    const at = first ? (first.doc?.from ?? first.from) : 0;
    return { from: lineStart(text, at), to: lineStart(text, at), insert: `${line}\n\n` };
  }
  const others = plain.filter((i) => !javaGroup(i.path));
  if (!javaGroup(fqn) && !others.length && plain.length) {
    const at = lineStart(text, plain[0]!.from);
    return { from: at, to: at, insert: `${line}\n\n` };
  }
  const group = javaGroup(fqn) ? plain.filter((i) => javaGroup(i.path)) : others;
  const pool = group.length ? group : plain.length ? plain : file.imports;
  const next = pool.find((i) => i.path > fqn);
  if (next) {
    const at = lineStart(text, next.from);
    return { from: at, to: at, insert: `${line}\n` };
  }
  const last = pool[pool.length - 1]!;
  const end = lineEnd(text, last.to);
  return { from: end, to: end, insert: `\n${line}` };
}

/** Drops the imports among `fqns` (single-type or static member) whose name the code no longer uses. */
export function removeUnusedImports(text: string, fqns: readonly string[]): string {
  const file = parseJava(text);
  const used = usedIdentifiers(text);
  const edits = file.imports
    .filter((i) => !i.wildcard && fqns.includes(i.path) && !used.has(simpleName(i.path)))
    .map((i) => removeImport(text, i.from, i.to));
  if (!edits.length) return text;
  const out = applyEdits(text, edits);
  // An emptied import block leaves one blank line (the code below is left as it is).
  const first = file.classes[0];
  const head = (first ? (first.doc?.from ?? first.from) : text.length) - edits.reduce((n, e) => n + e.to - e.from, 0);
  return out.slice(0, head).replace(/\n{3,}/g, "\n\n") + out.slice(head);
}

/** Renames references to `name` within `from`–`to` (a class body) to `to`. */
export function renameRefs(text: string, from: number, to: number, name: string, renamed: string): Edit[] {
  return identifierRefs(text, from, to, name).map((p) => ({ from: p, to: p + name.length, insert: renamed }));
}
