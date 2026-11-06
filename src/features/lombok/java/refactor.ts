/**
 * Refactor › Lombok (IDEA's LombokActionGroup handlers) on the class at the caret:
 * @Getter / @Setter replace the accessors Lombok would generate (on the class when they
 * all share one access level, else per field), @ToString / @EqualsAndHashCode replace
 * those methods, @Data does all four, @Log (and friends) replaces a logger field.
 * Each handler is a pure text transform; steps re-parse the text between them.
 */
import { tx } from "@/platform/i18n";
import {
  addAnnotationAt,
  addImport,
  applyEdits,
  removeAnnotation,
  removeLines,
  removeUnusedImports,
  renameRefs,
  type Edit,
} from "./edits";
import { LOMBOK, simpleGetter, simpleSetter, type Accessor } from "./checks";
import {
  allClasses,
  findAnnotation,
  parseJava,
  typeImported,
  type JavaClass,
  type JavaField,
  type JavaFile,
  type JavaMethod,
} from "./syntax";

export type LombokHandler = "data" | "getter" | "setter" | "toString" | "equalsAndHashCode" | "logger";

/** The same class in a re-parsed file (by its nesting and name). */
function sameClass(file: JavaFile, cls: { outer: string[]; name: string }): JavaClass | null {
  const key = [...cls.outer, cls.name].join(".");
  return allClasses(file).find((c) => [...c.outer, c.name].join(".") === key) ?? null;
}

const ACCESS = ["public", "protected", "private"] as const;
const accessOf = (m: JavaMethod) => ACCESS.find((k) => m.mods.keywords.has(k)) ?? "package";

/** `@Getter`, or `@Getter(AccessLevel.PROTECTED)` for a method that wasn't public. */
const withAccess = (name: string, access: string) =>
  access === "public" ? `@${name}` : `@${name}(AccessLevel.${access.toUpperCase()})`;

function accessorsOf(file: JavaFile, cls: JavaClass, kind: "getter" | "setter"): Accessor[] {
  const find = kind === "getter" ? simpleGetter : simpleSetter;
  const out: Accessor[] = [];
  for (const m of cls.methods) {
    const a = find(file, cls, m, false);
    if (a && !out.some((x) => x.name === a.name)) out.push(a);
  }
  return out;
}

/** IDEA's `processIntern`: one class annotation when the accessors share an access level, else one per field. */
function replaceAccessors(text: string, target: JavaClass, kind: "getter" | "setter"): string {
  const file = parseJava(text);
  const cls = sameClass(file, target);
  if (!cls) return text;
  const fqn = kind === "getter" ? LOMBOK.getter : LOMBOK.setter;
  const short = kind === "getter" ? "Getter" : "Setter";
  const found = accessorsOf(file, cls, kind);
  if (!found.length) return text;
  const levels = new Set(found.map((a) => accessOf(a.method)));
  const present = findAnnotation(file, cls.mods, fqn);
  const level = accessOf(found[0]!.method);
  const onClass = levels.size === 1 && (!present || !present.hasArgs || level === "public");
  const edits: Edit[] = [];
  let access = false;
  if (onClass && !present) {
    edits.push(addAnnotationAt(text, cls.from, withAccess(short, level)));
    access ||= level !== "public";
  }
  // Fields annotated per variable: a split declaration is one edit per declaration.
  const byField = new Map<JavaField, Accessor[]>();
  for (const a of found) {
    if (a.field.isStatic || !onClass) byField.set(a.field, [...(byField.get(a.field) ?? []), a]);
    // The method's own annotations (but @Override) go to the field.
    const moved = a.method.mods.annotations.filter((x) => x.simple !== "Override");
    for (const x of moved) edits.push({ from: a.field.from, to: a.field.from, insert: `${text.slice(x.from, x.to)} ` });
    edits.push(removeLines(text, a.method.doc?.from ?? a.method.from, a.method.to));
  }
  for (const [field, list] of byField) {
    const names = new Set(list.map((a) => a.name));
    const annotation = (name: string) => {
      const a = list.find((x) => x.name === name);
      if (!a) return "";
      access ||= accessOf(a.method) !== "public";
      return withAccess(short, accessOf(a.method));
    };
    if (field.vars.length === 1) {
      if (!findAnnotation(file, field.mods, fqn))
        edits.push(addAnnotationAt(text, field.from, annotation(field.vars[0]!.name)));
    } else {
      const indent = text.slice(text.lastIndexOf("\n", field.from - 1) + 1, field.from);
      const prefix = text.slice(field.from, field.vars[0]!.from);
      const decls = field.vars.map((v) => {
        const ann = names.has(v.name) ? annotation(v.name) : "";
        return `${ann ? `${ann}\n${indent}` : ""}${prefix}${text.slice(v.from, v.to)};`;
      });
      edits.push({ from: field.from, to: field.to, insert: decls.join(`\n${indent}`) });
    }
  }
  let out = applyEdits(text, edits);
  for (const imp of [fqn, ...(access ? ["lombok.AccessLevel"] : [])]) {
    const e = addImport(parseJava(out), imp);
    if (e) out = applyEdits(out, [e]);
  }
  return out;
}

/** Deletes `public` non-static methods `name` taking `params` types, then annotates the class with `fqn`. */
function replaceMethods(
  text: string,
  target: JavaClass,
  methods: ReadonlyArray<{ name: string; returns: string; params: string[] }>,
  fqn: string,
): string {
  const file = parseJava(text);
  const cls = sameClass(file, target);
  if (!cls) return text;
  const edits: Edit[] = [];
  for (const spec of methods) {
    const m = cls.methods.find(
      (x) =>
        x.name === spec.name &&
        x.mods.keywords.has("public") &&
        !x.mods.keywords.has("static") &&
        (x.returnType ?? "void").replace(/^java\.lang\./, "") === spec.returns &&
        x.params.length === spec.params.length &&
        x.params.every((p, i) => p.type.replace(/^java\.lang\./, "") === spec.params[i]),
    );
    if (m) edits.push(removeLines(text, m.doc?.from ?? m.from, m.to));
  }
  if (!findAnnotation(file, cls.mods, fqn))
    edits.push(addAnnotationAt(text, cls.from, `@${fqn.slice(fqn.lastIndexOf(".") + 1)}`));
  const out = applyEdits(text, edits);
  const imp = addImport(parseJava(out), fqn);
  return imp ? applyEdits(out, [imp]) : out;
}

/** Logger types Lombok generates and their annotations (IDEA's log processors). */
export const LOGGERS: ReadonlyArray<{ type: string; annotation: string; factories: string[] }> = [
  { type: "java.util.logging.Logger", annotation: "lombok.extern.java.Log", factories: [] },
  {
    type: "org.apache.commons.logging.Log",
    annotation: "lombok.extern.apachecommons.CommonsLog",
    factories: ["org.apache.commons.logging.LogFactory"],
  },
  { type: "org.jboss.logging.Logger", annotation: "lombok.extern.jbosslog.JBossLog", factories: [] },
  { type: "org.apache.log4j.Logger", annotation: "lombok.extern.log4j.Log4j", factories: [] },
  {
    type: "org.apache.logging.log4j.Logger",
    annotation: "lombok.extern.log4j.Log4j2",
    factories: ["org.apache.logging.log4j.LogManager"],
  },
  { type: "org.slf4j.Logger", annotation: "lombok.extern.slf4j.Slf4j", factories: ["org.slf4j.LoggerFactory"] },
  {
    type: "org.slf4j.ext.XLogger",
    annotation: "lombok.extern.slf4j.XSlf4j",
    factories: ["org.slf4j.ext.XLoggerFactory"],
  },
  { type: "com.google.common.flogger.FluentLogger", annotation: "lombok.extern.flogger.Flogger", factories: [] },
];

export interface LoggerField {
  field: JavaField;
  name: string;
  logger: (typeof LOGGERS)[number];
  /** `private static final` and named `log`, as Lombok generates it. */
  conventional: boolean;
}

export function loggerFields(file: JavaFile, cls: JavaClass): LoggerField[] {
  const out: LoggerField[] = [];
  for (const field of cls.fields) {
    const logger = LOGGERS.find(
      (l) =>
        field.type === l.type ||
        (field.type === l.type.slice(l.type.lastIndexOf(".") + 1) && typeImported(file, l.type)),
    );
    if (!logger) continue;
    for (const v of field.vars) {
      const k = field.mods.keywords;
      out.push({
        field,
        name: v.name,
        logger,
        conventional: k.has("private") && k.has("static") && k.has("final") && v.name === "log",
      });
    }
  }
  return out;
}

/** Replaces the class's logger fields with Lombok's annotation, renaming their uses to `log`. */
function replaceLogger(text: string, target: JavaClass): string {
  const file = parseJava(text);
  const cls = sameClass(file, target);
  const first = cls && loggerFields(file, cls)[0];
  if (!cls || !first) return text;
  const edits: Edit[] = [];
  if (first.name !== "log")
    edits.push(
      ...renameRefs(text, cls.bodyFrom, cls.bodyTo, first.name, "log").filter(
        (e) => e.from < first.field.from || e.to > first.field.to,
      ),
    );
  if (first.field.vars.length === 1)
    edits.push(removeLines(text, first.field.doc?.from ?? first.field.from, first.field.to));
  else {
    const prefix = text.slice(first.field.from, first.field.vars[0]!.from);
    const rest = first.field.vars.filter((v) => v.name !== first.name).map((v) => text.slice(v.from, v.to));
    edits.push({ from: first.field.from, to: first.field.to, insert: `${prefix}${rest.join(", ")};` });
  }
  const fqn = first.logger.annotation;
  if (!findAnnotation(file, cls.mods, fqn))
    edits.push(addAnnotationAt(text, cls.from, `@${fqn.slice(fqn.lastIndexOf(".") + 1)}`));
  let out = applyEdits(text, edits);
  const imp = addImport(parseJava(out), fqn);
  if (imp) out = applyEdits(out, [imp]);
  return removeUnusedImports(out, [first.logger.type, ...first.logger.factories]);
}

const TO_STRING = [{ name: "toString", returns: "String", params: [] }];
const EQUALS_AND_HASH_CODE = [
  { name: "equals", returns: "boolean", params: ["Object"] },
  { name: "hashCode", returns: "int", params: [] },
];

/** Removes the class's argument-less `fqns` annotations (@Data covers them). */
function dropCovered(text: string, target: JavaClass, fqns: string[]): string {
  const file = parseJava(text);
  const cls = sameClass(file, target);
  if (!cls) return text;
  const edits = fqns
    .map((f) => findAnnotation(file, cls.mods, f))
    .filter((a) => a && !a.hasArgs)
    .map((a) => removeAnnotation(text, a!.from, a!.to));
  return removeUnusedImports(applyEdits(text, edits), fqns);
}

/** `text` with `handler` applied to class `cls` (found in `text`). */
export function applyLombok(text: string, cls: JavaClass, handler: LombokHandler): string {
  switch (handler) {
    case "getter":
      return replaceAccessors(text, cls, "getter");
    case "setter":
      return replaceAccessors(text, cls, "setter");
    case "toString":
      return replaceMethods(text, cls, TO_STRING, LOMBOK.toString);
    case "equalsAndHashCode":
      return replaceMethods(text, cls, EQUALS_AND_HASH_CODE, LOMBOK.equalsAndHashCode);
    case "logger":
      return replaceLogger(text, cls);
    case "data": {
      let out = replaceAccessors(text, cls, "getter");
      out = replaceAccessors(out, cls, "setter");
      out = replaceMethods(out, cls, TO_STRING, LOMBOK.toString);
      out = replaceMethods(out, cls, EQUALS_AND_HASH_CODE, LOMBOK.equalsAndHashCode);
      out = dropCovered(out, cls, [LOMBOK.getter, LOMBOK.setter, LOMBOK.toString, LOMBOK.equalsAndHashCode]);
      const file = parseJava(out);
      const now = sameClass(file, cls);
      if (!now || findAnnotation(file, now.mods, LOMBOK.data)) return out;
      out = applyEdits(out, [addAnnotationAt(out, now.from, "@Data")]);
      const imp = addImport(parseJava(out), LOMBOK.data);
      return imp ? applyEdits(out, [imp]) : out;
    }
  }
}

/** Why `handler` can't run on `cls`, or null. */
export function lombokUnavailable(file: JavaFile, cls: JavaClass | null, handler: LombokHandler): string | null {
  if (!cls || cls.kind !== "class") return tx("Place the caret in a class");
  if (handler === "logger" && !loggerFields(file, cls).length) return tx("The class has no logger field");
  return null;
}
