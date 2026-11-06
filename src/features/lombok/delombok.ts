/**
 * Delombok (IDEA's Refactor › Delombok), on top of Lombok's own `delombok`: the source is
 * delomboked with only the chosen annotations left in (`delombokInput`), then the members
 * Lombok generated (`@lombok.Generated` in its output) are inserted into the original text
 * and the chosen annotations removed (`applyDelombok`). The rest of the file keeps its
 * formatting and comments, which a whole-file delombok would reflow.
 *
 * Annotations that rewrite existing code instead of adding members (`@NonNull`,
 * `@SneakyThrows`, `@Cleanup`, `@Synchronized`, `@Locked`, `val` / `var`) stay: they still
 * shape the generated code (a setter's null check) but are never delomboked.
 */
import { javaLanguage } from "@codemirror/lang-java";
import type { SyntaxNode } from "@lezer/common";

export type DelombokTarget =
  | "all"
  | "data"
  | "value"
  | "getter"
  | "setter"
  | "equalsAndHashCode"
  | "toString"
  | "constructors"
  | "builder"
  | "superBuilder"
  | "logger"
  | "with"
  | "delegate"
  | "utilityClass"
  | "fieldNameConstants"
  | "standardException";

const LOGGERS = ["Log", "Log4j", "Log4j2", "Slf4j", "XSlf4j", "CommonsLog", "JBossLog", "Flogger", "CustomLog"];

/** IDEA's Delombok group, in its order: the annotations each entry delomboks. */
export const DELOMBOK_TARGETS: ReadonlyArray<{ id: DelombokTarget; label: string; annotations: readonly string[] }> = [
  { id: "all", label: "All Lombok Annotations", annotations: [] },
  { id: "data", label: "@Data", annotations: ["Data"] },
  { id: "value", label: "@Value", annotations: ["Value"] },
  { id: "with", label: "@With", annotations: ["With", "Wither"] },
  { id: "delegate", label: "@Delegate", annotations: ["Delegate"] },
  { id: "builder", label: "@Builder", annotations: ["Builder"] },
  { id: "superBuilder", label: "@SuperBuilder", annotations: ["SuperBuilder"] },
  {
    id: "constructors",
    label: "Constructors",
    annotations: ["NoArgsConstructor", "RequiredArgsConstructor", "AllArgsConstructor"],
  },
  { id: "getter", label: "@Getter", annotations: ["Getter"] },
  { id: "setter", label: "@Setter", annotations: ["Setter"] },
  { id: "equalsAndHashCode", label: "@EqualsAndHashCode", annotations: ["EqualsAndHashCode"] },
  { id: "toString", label: "@ToString", annotations: ["ToString"] },
  { id: "logger", label: "@Log (and other loggers)", annotations: LOGGERS },
  { id: "fieldNameConstants", label: "@FieldNameConstants", annotations: ["FieldNameConstants"] },
  { id: "utilityClass", label: "@UtilityClass", annotations: ["UtilityClass"] },
  { id: "standardException", label: "@StandardException", annotations: ["StandardException"] },
];

/** Annotations that generate members or change declarations (what "All" delomboks). */
const GENERATING = new Set([...DELOMBOK_TARGETS.flatMap((t) => t.annotations), "FieldDefaults", "Jacksonized"]);

/** Settings of other annotations, removed with the last annotation they configure. */
const HELPERS: Record<string, readonly string[]> = {
  "ToString.Exclude": ["ToString", "Data", "Value"],
  "ToString.Include": ["ToString", "Data", "Value"],
  "EqualsAndHashCode.Exclude": ["EqualsAndHashCode", "Data", "Value"],
  "EqualsAndHashCode.Include": ["EqualsAndHashCode", "Data", "Value"],
  "Builder.Default": ["Builder", "SuperBuilder"],
  "Builder.ObtainVia": ["Builder", "SuperBuilder"],
  Singular: ["Builder", "SuperBuilder"],
  Jacksonized: ["Builder", "SuperBuilder"],
  Accessors: ["Getter", "Setter", "Data", "Value", "With", "Wither"],
  Tolerate: ["Getter", "Setter", "Data", "Value", "With", "Wither"],
  "FieldNameConstants.Include": ["FieldNameConstants"],
  "FieldNameConstants.Exclude": ["FieldNameConstants"],
};

const LOMBOK_PACKAGES = /^lombok(\.experimental|\.extern\.\w+)?$/;

interface Ann {
  /** `Getter`, `ToString.Exclude` (the qualifier `lombok.` dropped). */
  name: string;
  from: number;
  to: number;
}

const parse = (text: string) => javaLanguage.parser.parse(text);

const isTypeDecl = (n: SyntaxNode) =>
  n.name === "ClassDeclaration" ||
  n.name === "EnumDeclaration" ||
  n.name === "RecordDeclaration" ||
  n.name === "InterfaceDeclaration" ||
  n.name === "AnnotationTypeDeclaration";

const MEMBERS = new Set([
  "FieldDeclaration",
  "MethodDeclaration",
  "ConstructorDeclaration",
  "ClassDeclaration",
  "EnumDeclaration",
  "RecordDeclaration",
  "InterfaceDeclaration",
  "AnnotationTypeDeclaration",
]);

const BODIES = new Set([
  "ClassBody",
  "EnumBody",
  "RecordBody",
  "InterfaceBody",
  "AnnotationTypeBody",
  "EnumBodyDeclarations",
]);

/** Simple names imported from Lombok's packages, and whether a package is imported whole. */
function lombokImports(text: string, root: SyntaxNode): { names: Set<string>; wildcard: boolean } {
  const names = new Set<string>();
  let wildcard = false;
  for (let n = root.firstChild; n; n = n.nextSibling) {
    if (n.name !== "ImportDeclaration") continue;
    const decl = text.slice(n.from, n.to).replace(/\s+/g, " ");
    const m = /^import (static )?([\w.]+?)(\.\*)? ?;$/.exec(decl);
    if (!m || m[1]) continue;
    if (m[3]) {
      if (LOMBOK_PACKAGES.test(m[2]!)) wildcard = true;
      continue;
    }
    const dot = m[2]!.lastIndexOf(".");
    if (LOMBOK_PACKAGES.test(m[2]!.slice(0, dot))) names.add(m[2]!.slice(dot + 1));
  }
  return { names, wildcard };
}

/** The Lombok annotations of `text` (anywhere: classes, fields, methods, parameters). */
function lombokAnnotations(text: string, root: SyntaxNode): Ann[] {
  const { names, wildcard } = lombokImports(text, root);
  const known = (n: string) => GENERATING.has(n) || n in HELPERS || BODY_ANNOTATIONS.has(n);
  const out: Ann[] = [];
  root.cursor().iterate((c) => {
    if (c.name !== "Annotation" && c.name !== "MarkerAnnotation") return;
    const id = c.node.firstChild;
    if (!id) return;
    let written = text.slice(id.from, id.to).replace(/\s+/g, "");
    let lombok = false;
    const q = /^lombok(?:\.experimental|\.extern\.\w+)?\.(.+)$/.exec(written);
    if (q) {
      written = q[1]!;
      lombok = true;
    }
    const head = written.split(".")[0]!;
    if (!lombok) lombok = names.has(head) || (wildcard && known(written));
    if (lombok) out.push({ name: written, from: c.from, to: c.to });
  });
  return out;
}

const BODY_ANNOTATIONS = new Set(["NonNull", "SneakyThrows", "Cleanup", "Synchronized", "Locked"]);

/** The annotation names `target` delomboks. */
export function targetAnnotations(target: DelombokTarget): ReadonlySet<string> {
  if (target === "all") return GENERATING;
  return new Set(DELOMBOK_TARGETS.find((t) => t.id === target)?.annotations ?? []);
}

/** Whether `text` has an annotation `target` would delombok. */
export function hasDelombokWork(text: string, target: DelombokTarget): boolean {
  const chosen = targetAnnotations(target);
  return lombokAnnotations(text, parse(text).topNode).some((a) => chosen.has(a.name));
}

/** Range covering `a` and the whitespace after it (its whole line when it stands alone there). */
function removalRange(text: string, a: { from: number; to: number }): { from: number; to: number } {
  const lineStart = text.lastIndexOf("\n", a.from - 1) + 1;
  let end = a.to;
  while (end < text.length && (text[end] === " " || text[end] === "\t")) end++;
  const alone = !text.slice(lineStart, a.from).trim();
  if (alone && (text[end] === "\n" || end === text.length))
    return { from: lineStart, to: Math.min(text.length, end + 1) };
  return { from: a.from, to: end };
}

interface Edit {
  from: number;
  to: number;
  insert: string;
}

function applyEdits(text: string, edits: readonly Edit[]): string {
  let out = "";
  let at = 0;
  for (const e of [...edits].sort((a, b) => a.from - b.from || a.to - b.to)) {
    if (e.from < at) continue; // overlapping: the first wins
    out += text.slice(at, e.from) + e.insert;
    at = e.to;
  }
  return out + text.slice(at);
}

/** Owners of a helper still annotating the text once `removed` are gone. */
function helperOrphaned(helper: string, anns: readonly Ann[], removed: ReadonlySet<Ann>): boolean {
  const owners = HELPERS[helper] ?? [];
  return !anns.some((a) => !removed.has(a) && owners.includes(a.name));
}

/**
 * The text Lombok's delombok runs on: the chosen annotations (and the annotations
 * shaping their code) kept, every other member-generating Lombok annotation removed.
 */
export function delombokInput(text: string, target: DelombokTarget): string {
  const chosen = targetAnnotations(target);
  const anns = lombokAnnotations(text, parse(text).topNode);
  const dropped = new Set(anns.filter((a) => GENERATING.has(a.name) && !chosen.has(a.name)));
  const helpers = anns.filter((a) => a.name in HELPERS && helperOrphaned(a.name, anns, dropped));
  return applyEdits(
    text,
    [...dropped, ...helpers].map((a) => ({ ...removalRange(text, a), insert: "" })),
  );
}

/** Direct members of a type body, and the type's name. */
function bodyOf(decl: SyntaxNode): SyntaxNode | null {
  for (let c = decl.firstChild; c; c = c.nextSibling) if (BODIES.has(c.name)) return c;
  return null;
}

function members(body: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let c = body.firstChild; c; c = c.nextSibling) {
    if (MEMBERS.has(c.name)) out.push(c);
    else if (c.name === "EnumBodyDeclarations") out.push(...members(c));
  }
  return out;
}

function nameOf(text: string, decl: SyntaxNode): string {
  const d = decl.getChild("Definition");
  if (d) return text.slice(d.from, d.to);
  const v = decl.getChild("VariableDeclarator")?.getChild("Definition");
  return v ? text.slice(v.from, v.to) : "";
}

/** `Outer.Inner` paths of every type declaration. */
function typesByPath(text: string, root: SyntaxNode): Map<string, SyntaxNode> {
  const out = new Map<string, SyntaxNode>();
  const visit = (n: SyntaxNode, prefix: string) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (isTypeDecl(c)) {
        const path = prefix + nameOf(text, c);
        out.set(path, c);
        const body = bodyOf(c);
        if (body) visit(body, `${path}.`);
      } else if (c.name === "EnumBodyDeclarations") visit(c, prefix);
    }
  };
  visit(root, "");
  return out;
}

function isGenerated(text: string, member: SyntaxNode): boolean {
  const mods = member.getChild("Modifiers");
  if (!mods) return false;
  for (let a = mods.firstChild; a; a = a.nextSibling)
    if (
      (a.name === "MarkerAnnotation" || a.name === "Annotation") &&
      /^@\s*lombok\s*\.\s*Generated\b/.test(text.slice(a.from, a.to))
    )
      return true;
  return false;
}

/** A member's javadoc (a block comment right before it), else the member itself. */
function withDoc(text: string, member: SyntaxNode): number {
  const prev = member.prevSibling;
  if (
    prev?.name === "BlockComment" &&
    text.slice(prev.from, prev.from + 3) === "/**" &&
    !text.slice(prev.to, member.from).trim()
  )
    return prev.from;
  return member.from;
}

const lineStartOf = (text: string, pos: number) => text.lastIndexOf("\n", pos - 1) + 1;
const indentAt = (text: string, pos: number) => /^[ \t]*/.exec(text.slice(lineStartOf(text, pos)))![0];

/** Re-indents delombok's 4-space code to `indent` (one level) and `unit`. */
function reindent(code: string, base: string, indent: string, unit: string): string {
  return code
    .split("\n")
    .map((line) => {
      if (!line.trim()) return "";
      const rest = line.startsWith(base) ? line.slice(base.length) : line.trimStart();
      const lead = /^ */.exec(rest)![0].length;
      const levels = Math.floor(lead / 4);
      return indent + unit.repeat(levels) + " ".repeat(lead % 4) + rest.slice(lead);
    })
    .join("\n");
}

/** The generated member's text without Lombok's marks. */
function cleanGenerated(code: string): string {
  return code.replace(/^[ \t]*@lombok\.Generated[ \t]*\n/gm, "").replace(/@lombok\.Generated\s+/g, "");
}

const KEYWORDS = new Set([
  "public",
  "protected",
  "private",
  "static",
  "final",
  "abstract",
  "transient",
  "volatile",
  "synchronized",
  "native",
  "strictfp",
  "default",
  "sealed",
  "non-sealed",
]);

function keywords(text: string, decl: SyntaxNode): { list: SyntaxNode[]; set: Set<string> } {
  const list: SyntaxNode[] = [];
  const mods = decl.getChild("Modifiers");
  for (let c = mods?.firstChild; c; c = c.nextSibling) if (KEYWORDS.has(text.slice(c.from, c.to))) list.push(c);
  return { list, set: new Set(list.map((c) => text.slice(c.from, c.to))) };
}

/** A member's identity across the original and delombok's output. */
function memberKey(text: string, m: SyntaxNode): string {
  const params = m.getChild("FormalParameters");
  const arity = params
    ? params.getChildren("FormalParameter").length + params.getChildren("SpreadParameter").length
    : -1;
  const names =
    m.name === "FieldDeclaration"
      ? m
          .getChildren("VariableDeclarator")
          .map((v) => nameOf(text, v))
          .join(",")
      : nameOf(text, m);
  return `${m.name}:${names}:${arity}`;
}

/** Keyword edits that make `decl` carry `want`'s modifier keywords (`@Value` makes fields `private final`). */
function keywordEdit(text: string, decl: SyntaxNode, outText: string, outDecl: SyntaxNode): Edit | null {
  const have = keywords(text, decl);
  const want = keywords(outText, outDecl);
  if (have.set.size === want.set.size && [...want.set].every((k) => have.set.has(k))) return null;
  const words = want.list.map((c) => outText.slice(c.from, c.to)).join(" ");
  if (have.list.length) {
    return { from: have.list[0]!.from, to: have.list[have.list.length - 1]!.to, insert: words };
  }
  // No keyword yet: right before the type / `class` (after annotations, which may be removed).
  const mods = decl.getChild("Modifiers");
  const at = mods ? (mods.nextSibling?.from ?? mods.to) : decl.from;
  return { from: at, to: at, insert: `${words} ` };
}

export interface DelombokResult {
  text: string;
  /** Annotations delomboked. */
  removed: number;
  /** Members inserted. */
  generated: number;
}

/**
 * The original `text` with what Lombok generated for `target` (`output`: delombok's output
 * of `delombokInput(text, target)`) written out. `unit` is the file's indentation unit.
 */
export function applyDelombok(text: string, output: string, target: DelombokTarget, unit = "    "): DelombokResult {
  const tree = parse(text).topNode;
  const outTree = parse(output).topNode;
  const chosen = targetAnnotations(target);
  const anns = lombokAnnotations(text, tree);
  const removed = new Set(anns.filter((a) => chosen.has(a.name)));
  const helpers = anns.filter((a) => a.name in HELPERS && helperOrphaned(a.name, anns, removed));
  const edits: Edit[] = [...removed, ...helpers].map((a) => ({ ...removalRange(text, a), insert: "" }));
  const outTypes = typesByPath(output, outTree);
  let generated = 0;
  for (const [path, decl] of typesByPath(text, tree)) {
    const outDecl = outTypes.get(path);
    const body = bodyOf(decl);
    const outBody = outDecl && bodyOf(outDecl);
    if (!body || !outDecl || !outBody) continue;
    const own = members(body);
    const outMembers = members(outBody);
    // Declarations Lombok changed (`@Value`, `@UtilityClass`, `@FieldDefaults`): their keywords.
    if (target === "all" || chosen.has("Value") || chosen.has("UtilityClass")) {
      const edit = keywordEdit(text, decl, output, outDecl);
      if (edit) edits.push(edit);
      const byKey = new Map(outMembers.filter((m) => !isGenerated(output, m)).map((m) => [memberKey(output, m), m]));
      for (const m of own) {
        const twin = byKey.get(memberKey(text, m));
        const e = twin && keywordEdit(text, m, output, twin);
        if (e) edits.push(e);
      }
    }
    const fresh = outMembers.filter((m) => isGenerated(output, m));
    if (!fresh.length) continue;
    const indent = own.length ? indentAt(text, withDoc(text, own[0]!)) : indentAt(text, decl.from) + unit;
    const code = (m: SyntaxNode) => {
      const from = withDoc(output, m);
      const base = indentAt(output, from);
      return reindent(cleanGenerated(base + output.slice(from, m.to)), base, indent, unit);
    };
    const fields = fresh.filter((m) => m.name === "FieldDeclaration").map(code);
    const rest = fresh.filter((m) => m.name !== "FieldDeclaration").map(code);
    generated += fresh.length;
    const open = body.firstChild!; // `{`
    const close = body.lastChild!; // `}`
    if (fields.length) edits.push({ from: open.to, to: open.to, insert: `\n${fields.join("\n")}` });
    if (rest.length) {
      // Before `}`: after the last member's line, separated by blank lines.
      const closeLine = lineStartOf(text, close.from);
      const inline = text.slice(closeLine, close.from).trim() !== "";
      const at = inline ? close.from : closeLine;
      const lead = own.length || fields.length ? "\n" : "";
      edits.push({
        from: at,
        to: at,
        insert: `${inline ? "\n" : ""}${lead}${rest.join("\n\n")}\n${inline ? indentAt(text, decl.from) : ""}`,
      });
    }
  }
  let next = applyEdits(text, edits);
  next = dropUnusedImports(next);
  return { text: next, removed: removed.size, generated };
}

/** Lombok imports no annotation of `text` refers to any more. */
function dropUnusedImports(text: string): string {
  const root = parse(text).topNode;
  const used = new Set(lombokAnnotations(text, root).map((a) => a.name.split(".")[0]!));
  const edits: Edit[] = [];
  for (let n = root.firstChild; n; n = n.nextSibling) {
    if (n.name !== "ImportDeclaration") continue;
    const decl = text.slice(n.from, n.to).replace(/\s+/g, " ");
    const m = /^import ([\w.]+?)(\.\*)? ?;$/.exec(decl);
    if (!m) continue;
    const pkg = m[2] ? m[1]! : m[1]!.slice(0, m[1]!.lastIndexOf("."));
    if (!LOMBOK_PACKAGES.test(pkg)) continue;
    const name = m[1]!.slice(m[1]!.lastIndexOf(".") + 1);
    const keep = m[2] ? used.size > 0 : used.has(name) || new RegExp(`\\b${name}\\b`).test(withoutImports(text, root));
    if (!keep) edits.push({ ...removalRange(text, n), insert: "" });
  }
  if (!edits.length) return text;
  const next = applyEdits(text, edits);
  // The import block may have emptied: one blank line before the declarations.
  const first = parse(next).topNode.getChildren("ImportDeclaration")[0]?.from ?? firstTypeFrom(next);
  return next.slice(0, first).replace(/\n{3,}/g, "\n\n") + next.slice(first);
}

function firstTypeFrom(text: string): number {
  for (let n = parse(text).topNode.firstChild; n; n = n.nextSibling) if (isTypeDecl(n)) return n.from;
  return text.length;
}

function withoutImports(text: string, root: SyntaxNode): string {
  let out = text;
  for (let n = root.lastChild; n; n = n.prevSibling)
    if (n.name === "ImportDeclaration" || n.name === "PackageDeclaration") out = out.slice(0, n.from) + out.slice(n.to);
  return out;
}
