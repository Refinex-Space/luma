/**
 * IDEA's Lombok inspections on a Java source: Lombok @Getter / @Setter may be used
 * (trivial accessors Lombok would generate under the same name), @Slf4j (an explicit
 * SLF4J logger of its own class) and Deprecated Lombok annotations. Each problem carries
 * its quick fix as a pure text transform. Lombok's naming: `getX` / `isX` (primitive
 * boolean; `isFoo` stays `isFoo`), `setX` (`isFoo` → `setFoo`).
 */
import { tx } from "@/platform/i18n";
import {
  addAnnotationAt,
  addImport,
  applyEdits,
  indentAt,
  lineStart,
  removeAnnotation,
  removeImport,
  removeLines,
  removeUnusedImports,
  renameRefs,
  type Edit,
} from "./edits";
import {
  allClasses,
  annotationIs,
  findAnnotation,
  parseJava,
  typeImported,
  type JavaClass,
  type JavaField,
  type JavaFile,
  type JavaMethod,
} from "./syntax";

export const LOMBOK = {
  getter: "lombok.Getter",
  setter: "lombok.Setter",
  data: "lombok.Data",
  value: "lombok.Value",
  toString: "lombok.ToString",
  equalsAndHashCode: "lombok.EqualsAndHashCode",
  slf4j: "lombok.extern.slf4j.Slf4j",
  tolerate: "lombok.experimental.Tolerate",
} as const;

export type ProblemKind = "getter" | "setter" | "logger" | "deprecated";

export interface Fix {
  label: string;
  /** The source with the fix applied (of the text the problem was found in). */
  apply: () => string;
}

export interface Problem {
  kind: ProblemKind;
  from: number;
  to: number;
  /** Where the caret offers the fix (the whole method / field / class header). */
  scopeFrom: number;
  scopeTo: number;
  message: string;
  severity: "error" | "warning";
  fix: Fix;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Lombok's getter name of field `name` of `type`. */
export function getterName(name: string, type: string): string {
  if (type === "boolean") return /^is[A-Z]/.test(name) ? name : `is${capitalize(name)}`;
  return `get${capitalize(name)}`;
}

/** Lombok's setter name of field `name` of `type`. */
export function setterName(name: string, type: string): string {
  if (type === "boolean" && /^is[A-Z]/.test(name)) return `set${name.slice(2)}`;
  return `set${capitalize(name)}`;
}

const UNSUITABLE = ["final", "abstract", "synchronized", "native", "strictfp"];

const plainMethod = (m: JavaMethod) =>
  m.mods.keywords.has("public") &&
  !m.throws &&
  !UNSUITABLE.some((k) => m.mods.keywords.has(k)) &&
  !m.mods.annotations.length &&
  m.statements !== null;

/** `x` / `this.x` / `Own.this.x`, parentheses dropped; null for anything else. */
function fieldRef(expr: string, cls: JavaClass): { name: string; qualified: boolean } | null {
  let e = expr.trim();
  while (e.startsWith("(") && e.endsWith(")")) e = e.slice(1, -1).trim();
  const m = /^(?:(?:([A-Za-z_$][\w$]*)\s*\.\s*)?this\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(e);
  if (!m) return null;
  if (m[1] && m[1] !== cls.name) return null;
  return { name: m[2]!, qualified: e.includes("this") };
}

export interface Accessor {
  field: JavaField;
  name: string;
  method: JavaMethod;
}

function fieldNamed(cls: JavaClass, name: string): JavaField | null {
  return cls.fields.find((f) => f.vars.some((v) => v.name === name)) ?? null;
}

/** The field `m` only returns, if Lombok's @Getter would generate `m` for it. */
export function simpleGetter(file: JavaFile, cls: JavaClass, m: JavaMethod, publicOnly = true): Accessor | null {
  const text = file.text;
  if (publicOnly ? !plainMethod(m) : m.statements === null || m.throws) return null;
  if (m.params.length || !m.returnType) return null;
  if (!m.name.startsWith(m.returnType === "boolean" ? "is" : "get")) return null;
  if (m.statements!.length !== 1 || m.statements![0]!.name !== "ReturnStatement") return null;
  const stmt = m.statements![0]!;
  const ref = fieldRef(
    text
      .slice(stmt.from, stmt.to)
      .replace(/^return\b/, "")
      .replace(/;\s*$/, ""),
    cls,
  );
  const field = ref && fieldNamed(cls, ref.name);
  if (!ref || !field) return null;
  if (field.isStatic !== m.mods.keywords.has("static") || field.type !== m.returnType) return null;
  if (getterName(ref.name, field.type) !== m.name) return null;
  return { field, name: ref.name, method: m };
}

/** The field `m` only assigns from its parameter, if Lombok's @Setter would generate `m` for it. */
export function simpleSetter(file: JavaFile, cls: JavaClass, m: JavaMethod, publicOnly = true): Accessor | null {
  const text = file.text;
  if (publicOnly ? !plainMethod(m) : m.statements === null || m.throws) return null;
  if (m.returnType || m.params.length !== 1 || !m.name.startsWith("set")) return null;
  const p = m.params[0]!;
  if (p.varargs || p.annotations || p.keywords.some((k) => k !== "final")) return null;
  // Lombok generates nothing when another method has the name (unless @Tolerate).
  const others = cls.methods.filter((x) => x !== m && x.name === m.name);
  if (others.some((x) => !x.mods.annotations.some((a) => annotationIs(file, a, LOMBOK.tolerate)))) return null;
  if (m.statements!.length !== 1 || m.statements![0]!.name !== "ExpressionStatement") return null;
  const stmt = text.slice(m.statements![0]!.from, m.statements![0]!.to).replace(/;\s*$/, "");
  const eq = /^([^=]+?)\s*=(?!=)\s*(.+)$/s.exec(stmt);
  if (!eq) return null;
  const target = fieldRef(eq[1]!, cls);
  const source = fieldRef(eq[2]!, cls);
  if (!target || !source || source.qualified || source.name !== p.name) return null;
  if (!target.qualified && target.name === p.name) return null;
  const field = fieldNamed(cls, target.name);
  if (!field || field.isFinal || field.isStatic !== m.mods.keywords.has("static") || field.type !== p.type) return null;
  if (setterName(target.name, field.type) !== m.name) return null;
  return { field, name: target.name, method: m };
}

// --- fixes ------------------------------------------------------------------------

type AccessorKind = "getter" | "setter";

const annotationOf = (kind: AccessorKind) => (kind === "getter" ? LOMBOK.getter : LOMBOK.setter);
const shortName = (fqn: string) => fqn.slice(fqn.lastIndexOf(".") + 1);

/** The method's doc comment as a field doc section: `-- GETTER --`, its text and its @return / @param tags. */
function docSection(doc: string, kind: AccessorKind): string[] {
  const lines = doc
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\*?\s?/, "").trimEnd());
  const tagAt = lines.findIndex((l) => l.startsWith("@"));
  const desc = (tagAt < 0 ? lines : lines.slice(0, tagAt)).filter((l) => l.trim());
  const tag = kind === "getter" ? "@return" : "@param";
  const tags: string[] = [];
  let inTag = false;
  for (const l of tagAt < 0 ? [] : lines.slice(tagAt)) {
    if (l.startsWith("@")) inTag = l.startsWith(tag);
    if (inTag && l.trim()) tags.push(l);
  }
  if (!desc.length && !tags.length) return [];
  return [`-- ${kind.toUpperCase()} --`, ...desc, ...(desc.length && tags.length ? [""] : []), ...tags];
}

/** Moves `m`'s doc comment onto `field` (merged into its own doc comment, if any). */
function moveDoc(text: string, field: JavaField, m: JavaMethod, kind: AccessorKind): Edit | null {
  if (!m.doc) return null;
  const section = docSection(m.doc.text, kind);
  if (!section.length) return null;
  const at = field.doc?.from ?? field.from;
  const indent = indentAt(text, at);
  const body = section.map((l) => (l ? `${indent} * ${l}` : `${indent} *`)).join("\n");
  if (field.doc) {
    const close = field.doc.to - 2;
    const start = lineStart(text, close);
    // `/** text */` on one line: open it up.
    if (start <= field.doc.from) {
      const inner = text.slice(field.doc.from + 3, close).trim();
      return {
        from: field.doc.from,
        to: field.doc.to,
        insert: `/**\n${inner ? `${indent} * ${inner}\n` : ""}${body}\n${indent} */`,
      };
    }
    return { from: start, to: start, insert: `${body}\n` };
  }
  return { from: lineStart(text, at), to: lineStart(text, at), insert: `${indent}/**\n${body}\n${indent} */\n` };
}

/**
 * Annotates field variable `name` with `annotation`: on the declaration, after splitting a
 * multi-variable one (`int a, b;`) so only `name` gets it.
 */
function annotateField(text: string, field: JavaField, name: string, annotation: string): Edit {
  if (field.vars.length === 1) return addAnnotationAt(text, field.from, annotation);
  const indent = indentAt(text, field.from);
  const prefix = text.slice(field.from, field.vars[0]!.from);
  const decls = field.vars.map(
    (v) => `${v.name === name ? `${annotation}\n${indent}` : ""}${prefix}${text.slice(v.from, v.to)};`,
  );
  return { from: field.from, to: field.to, insert: decls.join(`\n${indent}`) };
}

const classHasAny = (file: JavaFile, cls: JavaClass, fqns: string[]) =>
  fqns.some((f) => findAnnotation(file, cls.mods, f));

function fieldFix(text: string, cls: JavaClass, a: Accessor, kind: AccessorKind): string {
  const file = parseJava(text);
  const fqn = annotationOf(kind);
  const edits: Edit[] = [];
  const covered = classHasAny(file, cls, [LOMBOK.data, LOMBOK.value, fqn]);
  if (a.field.isStatic || !covered) edits.push(annotateField(text, a.field, a.name, `@${shortName(fqn)}`));
  const doc = moveDoc(text, a.field, a.method, kind);
  if (doc) edits.push(doc);
  edits.push(removeLines(text, a.method.doc?.from ?? a.method.from, a.method.to));
  const imp = edits.length && (a.field.isStatic || !covered) ? addImport(file, fqn) : null;
  return applyEdits(text, imp ? [...edits, imp] : edits);
}

function classFix(text: string, cls: JavaClass, accessors: Accessor[], kind: AccessorKind): string {
  const file = parseJava(text);
  const fqn = annotationOf(kind);
  const edits: Edit[] = [];
  const covered = classHasAny(file, cls, [LOMBOK.data, LOMBOK.value, fqn]);
  if (!covered) {
    edits.push(addAnnotationAt(text, cls.from, `@${shortName(fqn)}`));
    const imp = addImport(file, fqn);
    if (imp) edits.push(imp);
  }
  for (const a of accessors) {
    const doc = moveDoc(text, a.field, a.method, kind);
    if (doc) edits.push(doc);
    edits.push(removeLines(text, a.method.doc?.from ?? a.method.from, a.method.to));
  }
  // Field annotations the class annotation now covers.
  for (const f of cls.fields) {
    if (f.isStatic) continue;
    const own = findAnnotation(file, f.mods, fqn);
    if (own && !own.hasArgs) edits.push(removeAnnotation(text, own.from, own.to));
  }
  return applyEdits(text, edits);
}

// --- inspections -------------------------------------------------------------------

function accessorProblems(file: JavaFile, cls: JavaClass, kind: AccessorKind, out: Problem[]) {
  const text = file.text;
  const find = kind === "getter" ? simpleGetter : simpleSetter;
  const fqn = annotationOf(kind);
  const found = cls.methods.map((m) => find(file, cls, m)).filter((a): a is Accessor => !!a);
  const instance = found.filter((a) => !a.field.isStatic);
  const statics = found.filter((a) => a.field.isStatic);
  const fieldMessage = (name: string) =>
    kind === "getter" ? tx`Field '${name}' may have Lombok @Getter` : tx`Field '${name}' may have Lombok @Setter`;
  const fixLabel = (name: string) =>
    kind === "getter" ? tx`Use lombok @Getter for '${name}'` : tx`Use lombok @Setter for '${name}'`;
  const perField = (a: Accessor) =>
    out.push({
      kind,
      from: a.method.nameFrom,
      to: a.method.nameTo,
      scopeFrom: a.method.doc?.from ?? a.method.from,
      scopeTo: a.method.to,
      message: fieldMessage(a.name),
      severity: "warning",
      fix: { label: fixLabel(a.name), apply: () => fieldFix(text, cls, a, kind) },
    });
  if (instance.length) {
    const vars = cls.fields.flatMap((f) => f.vars.map(() => f));
    const staticCount = vars.filter((f) => f.isStatic).length;
    const annotated = vars.filter((f) => !f.isStatic && findAnnotation(file, f.mods, fqn)).length;
    if (annotated + instance.length + staticCount === vars.length) {
      const name = cls.name;
      out.push({
        kind,
        from: cls.nameFrom,
        to: cls.nameTo,
        scopeFrom: cls.doc?.from ?? cls.from,
        scopeTo: cls.bodyFrom,
        message:
          kind === "getter" ? tx`Class '${name}' may use Lombok @Getter` : tx`Class '${name}' may use Lombok @Setter`,
        severity: "warning",
        fix: { label: fixLabel(name), apply: () => classFix(text, cls, instance, kind) },
      });
    } else instance.forEach(perField);
  }
  statics.forEach(perField);
}

const SLF4J_LOGGER = "org.slf4j.Logger";
const SLF4J_FACTORY = "org.slf4j.LoggerFactory";

/** Whether `type` (as written) is SLF4J's Logger here. */
const isSlf4jLogger = (file: JavaFile, type: string) =>
  type === SLF4J_LOGGER || (type === "Logger" && typeImported(file, SLF4J_LOGGER));

/** `LoggerFactory.getLogger(Own.class)` (SLF4J's, also qualified or statically imported). */
function isOwnLoggerInit(file: JavaFile, init: string, cls: JavaClass): boolean {
  const m = /^\(*\s*((?:[\w$]+\s*\.\s*)*)getLogger\s*\(\s*([\w$.]+)\s*\.\s*class\s*\)\s*\)*$/.exec(init.trim());
  if (!m) return false;
  const own = m[2]!.replace(/\s+/g, "");
  if (own !== cls.name && !own.endsWith(`.${cls.name}`)) return false;
  const qualifier = m[1]!.replace(/[\s.]+$/g, "").replace(/\s+/g, "");
  if (qualifier === SLF4J_FACTORY) return true;
  if (qualifier === "LoggerFactory") return typeImported(file, SLF4J_FACTORY);
  if (qualifier) return false;
  return file.imports.some(
    (i) => i.isStatic && (i.wildcard ? i.path === SLF4J_FACTORY : i.path === `${SLF4J_FACTORY}.getLogger`),
  );
}

/** Removes the logger field `name` of `cls`, renames its uses to `log` and annotates the class with @Slf4j. */
export function slf4jFix(text: string, cls: JavaClass, field: JavaField, name: string): string {
  const file = parseJava(text);
  const edits: Edit[] = [];
  if (name !== "log")
    edits.push(...renameRefs(text, cls.bodyFrom, cls.bodyTo, name, "log").filter((e) => !within(e, field)));
  if (field.vars.length === 1) edits.push(removeLines(text, field.doc?.from ?? field.from, field.to));
  else {
    const prefix = text.slice(field.from, field.vars[0]!.from);
    const rest = field.vars.filter((v) => v.name !== name).map((v) => text.slice(v.from, v.to));
    edits.push({ from: field.from, to: field.to, insert: `${prefix}${rest.join(", ")};` });
  }
  if (!findAnnotation(file, cls.mods, LOMBOK.slf4j)) {
    edits.push(addAnnotationAt(text, cls.from, "@Slf4j"));
    const imp = addImport(file, LOMBOK.slf4j);
    if (imp) edits.push(imp);
  }
  return removeUnusedImports(applyEdits(text, edits), [SLF4J_LOGGER, SLF4J_FACTORY, `${SLF4J_FACTORY}.getLogger`]);
}

const within = (e: Edit, f: JavaField) => e.from >= f.from && e.to <= f.to;

function loggerProblems(file: JavaFile, cls: JavaClass, out: Problem[]) {
  for (const f of cls.fields) {
    if (!isSlf4jLogger(file, f.type)) continue;
    for (const v of f.vars) {
      if (!v.init || !isOwnLoggerInit(file, v.init, cls)) continue;
      out.push({
        kind: "logger",
        from: f.modsRange?.from ?? f.typeFrom,
        to: f.to,
        scopeFrom: f.doc?.from ?? f.from,
        scopeTo: f.to,
        message: tx("Slf4j Logger is defined explicitly. Use Lombok @Slf4j annotation instead."),
        severity: "warning",
        fix: {
          label: tx("Replace logger field with @Slf4j annotation"),
          apply: () => slf4jFix(file.text, cls, f, v.name),
        },
      });
    }
  }
}

/** Annotations that moved out of `lombok.experimental`, and where to. */
const DEPRECATED: ReadonlyArray<[string, string]> = [
  ["lombok.experimental.Builder", "lombok.Builder"],
  ["lombok.experimental.Value", "lombok.Value"],
  ["lombok.experimental.Wither", "lombok.With"],
];

/** Replaces deprecated annotation `old` by `now` everywhere in the file (its import too). */
export function replaceDeprecated(text: string, old: string, now: string): string {
  const file = parseJava(text);
  const edits: Edit[] = [];
  const newShort = shortName(now);
  for (const cls of allClasses(file)) {
    const owners = [cls.mods, ...cls.fields.map((f) => f.mods), ...cls.methods.map((m) => m.mods)];
    for (const mods of owners)
      for (const a of mods.annotations) {
        if (!annotationIs(file, a, old)) continue;
        const nameFrom = a.from + 1;
        edits.push({ from: nameFrom, to: nameFrom + a.name.length, insert: a.name === old ? now : newShort });
      }
  }
  const single = file.imports.find((i) => !i.isStatic && !i.wildcard && i.path === old);
  if (single) edits.push(removeImport(text, single.from, single.to));
  const fixed = applyEdits(text, edits);
  if (!edits.some((e) => e.insert === newShort)) return fixed;
  const imp = addImport(parseJava(fixed), now);
  return imp ? applyEdits(fixed, [imp]) : fixed;
}

function deprecatedProblems(file: JavaFile, cls: JavaClass, out: Problem[]) {
  const owners = [
    { mods: cls.mods, scope: [cls.from, cls.bodyFrom] as const },
    ...cls.fields.map((f) => ({ mods: f.mods, scope: [f.from, f.to] as const })),
    ...cls.methods.map((m) => ({ mods: m.mods, scope: [m.from, m.to] as const })),
  ];
  for (const { mods, scope } of owners)
    for (const a of mods.annotations)
      for (const [old, now] of DEPRECATED) {
        if (!annotationIs(file, a, old)) continue;
        out.push({
          kind: "deprecated",
          from: a.from,
          to: a.to,
          scopeFrom: scope[0],
          scopeTo: scope[1],
          message: tx`Lombok's annotation '${old}' is deprecated and not supported by Lombok plugin anymore. Use '${now}' instead.`,
          severity: "error",
          fix: { label: tx`Replace with '@${now}'`, apply: () => replaceDeprecated(file.text, old, now) },
        });
      }
}

/** Every Lombok problem of `text`, in document order. */
export function lombokProblems(text: string): Problem[] {
  const file = parseJava(text);
  const out: Problem[] = [];
  for (const cls of allClasses(file)) {
    deprecatedProblems(file, cls, out);
    if (cls.kind !== "class" && cls.kind !== "enum") continue;
    accessorProblems(file, cls, "getter", out);
    accessorProblems(file, cls, "setter", out);
    loggerProblems(file, cls, out);
  }
  return out.sort((a, b) => a.from - b.from);
}
