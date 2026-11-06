/**
 * A declaration-level model of a Java source for the Lombok checks: imports, classes
 * (nested too), their fields, methods and annotations with exact offsets, read from the
 * `@lezer/java` tree. Method bodies keep their syntax node: the checks look at statements.
 */
import { javaLanguage } from "@codemirror/lang-java";
import type { SyntaxNode } from "@lezer/common";

export interface JavaAnnotation {
  /** As written after `@`: `Getter`, `lombok.Getter`. */
  name: string;
  /** Last segment: `Getter`. */
  simple: string;
  from: number;
  to: number;
  /** Has an argument list (`@Getter(AccessLevel.NONE)`, even `@Getter()`). */
  hasArgs: boolean;
}

export interface Modifiers {
  annotations: JavaAnnotation[];
  /** `public`, `static`, `final`… */
  keywords: Set<string>;
}

export interface JavaImport {
  /** `lombok.Getter`, `lombok` for `lombok.*`, `org.slf4j.LoggerFactory.getLogger` (static). */
  path: string;
  isStatic: boolean;
  wildcard: boolean;
  from: number;
  to: number;
}

export interface FieldVar {
  name: string;
  /** The declarator (`bar`, `bar = 1`). */
  from: number;
  to: number;
  init: string | null;
}

export interface JavaField {
  /** The declaration without its doc comment, `;` included. */
  from: number;
  to: number;
  doc: { from: number; to: number; text: string } | null;
  mods: Modifiers;
  /** Modifiers' range, null when there are none. */
  modsRange: { from: number; to: number } | null;
  type: string;
  typeFrom: number;
  vars: FieldVar[];
  isStatic: boolean;
  isFinal: boolean;
}

export interface JavaParam {
  name: string;
  type: string;
  /** Modifier keywords (`final`). */
  keywords: string[];
  annotations: number;
  varargs: boolean;
}

export interface JavaMethod {
  name: string;
  nameFrom: number;
  nameTo: number;
  from: number;
  to: number;
  doc: { from: number; to: number; text: string } | null;
  mods: Modifiers;
  /** `null` for `void`. */
  returnType: string | null;
  params: JavaParam[];
  throws: boolean;
  /** The body's statements (comments left out); null without a body. */
  statements: SyntaxNode[] | null;
}

export type ClassKind = "class" | "interface" | "enum" | "record" | "annotation";

export interface JavaClass {
  kind: ClassKind;
  name: string;
  nameFrom: number;
  nameTo: number;
  /** The declaration without its doc comment (annotations included). */
  from: number;
  to: number;
  doc: { from: number; to: number } | null;
  mods: Modifiers;
  /** After the body's `{`, at its `}`. */
  bodyFrom: number;
  bodyTo: number;
  fields: JavaField[];
  methods: JavaMethod[];
  classes: JavaClass[];
  /** Enclosing class names, outermost first. */
  outer: string[];
}

export interface JavaFile {
  text: string;
  /** End of the `package …;` declaration, 0 without one. */
  packageEnd: number;
  imports: JavaImport[];
  classes: JavaClass[];
}

const CLASS_NODES: Record<string, ClassKind> = {
  ClassDeclaration: "class",
  InterfaceDeclaration: "interface",
  EnumDeclaration: "enum",
  RecordDeclaration: "record",
  AnnotationTypeDeclaration: "annotation",
};

const children = (n: SyntaxNode): SyntaxNode[] => {
  const out: SyntaxNode[] = [];
  for (let c = n.firstChild; c; c = c.nextSibling) out.push(c);
  return out;
};

const isComment = (n: SyntaxNode) => n.name === "BlockComment" || n.name === "LineComment";

export function parseJava(text: string): JavaFile {
  const tree = javaLanguage.parser.parse(text);
  const slice = (n: SyntaxNode) => text.slice(n.from, n.to);
  const squash = (s: string) =>
    s
      .replace(/\s+/g, " ")
      .replace(/\s*([<>,[\]])\s*/g, "$1")
      .trim();

  const modifiers = (n: SyntaxNode | null): Modifiers => {
    const out: Modifiers = { annotations: [], keywords: new Set() };
    if (!n || n.name !== "Modifiers") return out;
    for (const c of children(n)) {
      if (c.name === "MarkerAnnotation" || c.name === "Annotation") {
        const id = children(c).find((x) => x.name === "Identifier" || x.name === "ScopedIdentifier");
        const name = id ? slice(id).replace(/\s+/g, "") : "";
        out.annotations.push({
          name,
          simple: name.slice(name.lastIndexOf(".") + 1),
          from: c.from,
          to: c.to,
          hasArgs: c.name === "Annotation",
        });
      } else if (!isComment(c)) out.keywords.add(slice(c));
    }
    return out;
  };

  /** A doc comment right before `n` (only whitespace between). */
  const docOf = (n: SyntaxNode) => {
    let p = n.prevSibling;
    while (p && p.name === "LineComment") p = p.prevSibling;
    if (!p || p.name !== "BlockComment" || !slice(p).startsWith("/**")) return null;
    if (text.slice(p.to, n.from).trim()) return null;
    return { from: p.from, to: p.to, text: slice(p) };
  };

  const field = (n: SyntaxNode): JavaField => {
    const cs = children(n);
    const modsNode = cs.find((c) => c.name === "Modifiers") ?? null;
    const mods = modifiers(modsNode);
    const typeNode = cs.find((c) => c !== modsNode && !isComment(c) && c.name !== "VariableDeclarator");
    const vars: FieldVar[] = cs
      .filter((c) => c.name === "VariableDeclarator")
      .map((v) => {
        const vc = children(v);
        const def = vc.find((c) => c.name === "Definition");
        const op = vc.findIndex((c) => c.name === "AssignOp");
        const init = op >= 0 && vc[op + 1] ? text.slice(vc[op + 1]!.from, v.to).trim() : null;
        return { name: def ? slice(def) : "", from: v.from, to: v.to, init };
      });
    return {
      from: n.from,
      to: n.to,
      doc: docOf(n),
      mods,
      modsRange: modsNode ? { from: modsNode.from, to: modsNode.to } : null,
      type: typeNode ? squash(slice(typeNode)) : "",
      typeFrom: typeNode?.from ?? n.from,
      vars,
      isStatic: mods.keywords.has("static"),
      isFinal: mods.keywords.has("final"),
    };
  };

  const method = (n: SyntaxNode): JavaMethod => {
    const cs = children(n);
    const modsNode = cs.find((c) => c.name === "Modifiers") ?? null;
    const defIndex = cs.findIndex((c) => c.name === "Definition");
    const def = cs[defIndex];
    const before = cs.slice(0, Math.max(0, defIndex)).filter((c) => c !== modsNode && c.name !== "TypeParameters");
    const typeNode = before[before.length - 1];
    const paramsNode = cs.find((c) => c.name === "FormalParameters");
    const params: JavaParam[] = paramsNode
      ? children(paramsNode)
          .filter((c) => c.name === "FormalParameter" || c.name === "SpreadParameter")
          .map((p) => {
            const pc = children(p);
            const pm = pc.find((c) => c.name === "Modifiers") ?? null;
            const m = modifiers(pm);
            const pdef = pc.find((c) => c.name === "Definition");
            const ptype = pc.find((c) => c !== pm && c !== pdef && !isComment(c) && c.name !== "...");
            return {
              name: pdef ? slice(pdef) : "",
              type: ptype ? squash(slice(ptype)) : "",
              keywords: [...m.keywords],
              annotations: m.annotations.length,
              varargs: p.name === "SpreadParameter" || slice(p).includes("..."),
            };
          })
      : [];
    const block = cs.find((c) => c.name === "Block");
    return {
      name: def ? slice(def) : "",
      nameFrom: def?.from ?? n.from,
      nameTo: def?.to ?? n.from,
      from: n.from,
      to: n.to,
      doc: docOf(n),
      mods: modifiers(modsNode),
      returnType: !typeNode || typeNode.name === "void" ? null : squash(slice(typeNode)),
      params,
      throws: cs.some((c) => c.name === "Throws"),
      statements: block
        ? children(block).filter((c) => c.name !== "{" && c.name !== "}" && c.name !== ";" && !isComment(c))
        : null,
    };
  };

  const classOf = (n: SyntaxNode, outer: string[]): JavaClass => {
    const cs = children(n);
    const def = cs.find((c) => c.name === "Definition" || c.name === "Identifier");
    const body = cs.find((c) => /Body$/.test(c.name));
    const name = def ? slice(def) : "";
    const out: JavaClass = {
      kind: CLASS_NODES[n.name]!,
      name,
      nameFrom: def?.from ?? n.from,
      nameTo: def?.to ?? n.from,
      from: n.from,
      to: n.to,
      doc: docOf(n),
      mods: modifiers(cs.find((c) => c.name === "Modifiers") ?? null),
      bodyFrom: body ? body.from + 1 : n.to,
      bodyTo: body ? body.to - 1 : n.to,
      fields: [],
      methods: [],
      classes: [],
      outer,
    };
    const members = (b: SyntaxNode) => {
      for (const m of children(b)) {
        if (m.name === "FieldDeclaration") out.fields.push(field(m));
        else if (m.name === "MethodDeclaration") out.methods.push(method(m));
        else if (CLASS_NODES[m.name]) out.classes.push(classOf(m, [...outer, name]));
        else if (m.name === "EnumBodyDeclarations") members(m);
      }
    };
    if (body) members(body);
    return out;
  };

  const file: JavaFile = { text, packageEnd: 0, imports: [], classes: [] };
  for (const n of children(tree.topNode)) {
    if (n.name === "PackageDeclaration") file.packageEnd = n.to;
    else if (n.name === "ImportDeclaration") {
      const t = slice(n);
      const m = /^import\s+(static\s+)?([\w.$\s]+?)(\s*\.\s*\*)?\s*;/.exec(t);
      if (m)
        file.imports.push({
          path: m[2]!.replace(/\s+/g, ""),
          isStatic: !!m[1],
          wildcard: !!m[3],
          from: n.from,
          to: n.to,
        });
    } else if (CLASS_NODES[n.name]) file.classes.push(classOf(n, []));
  }
  return file;
}

/** Every class of the file, nested ones after their outer class. */
export function allClasses(file: JavaFile): JavaClass[] {
  const out: JavaClass[] = [];
  const walk = (cs: JavaClass[]) => {
    for (const c of cs) {
      out.push(c);
      walk(c.classes);
    }
  };
  walk(file.classes);
  return out;
}

/** The innermost class whose declaration contains `pos`. */
export function classAt(file: JavaFile, pos: number): JavaClass | null {
  let best: JavaClass | null = null;
  for (const c of allClasses(file)) {
    const from = c.doc?.from ?? c.from;
    if (from <= pos && pos <= c.to && (!best || c.from >= best.from)) best = c;
  }
  return best;
}

/** Whether annotation `a` names class `fqn` here (written qualified, or imported). */
export function annotationIs(file: JavaFile, a: JavaAnnotation, fqn: string): boolean {
  if (a.name === fqn) return true;
  const dot = fqn.lastIndexOf(".");
  if (a.name !== fqn.slice(dot + 1)) return false;
  return typeImported(file, fqn);
}

/** Whether the simple name of `fqn` refers to it in this file (single-type or on-demand import). */
export function typeImported(file: JavaFile, fqn: string): boolean {
  const pkg = fqn.slice(0, fqn.lastIndexOf("."));
  return file.imports.some((i) => !i.isStatic && (i.wildcard ? i.path === pkg : i.path === fqn));
}

export const findAnnotation = (file: JavaFile, mods: Modifiers, fqn: string) =>
  mods.annotations.find((a) => annotationIs(file, a, fqn)) ?? null;

/** Identifiers used outside import declarations and comments (for unused imports). */
export function usedIdentifiers(text: string): Set<string> {
  const tree = javaLanguage.parser.parse(text);
  const out = new Set<string>();
  tree.iterate({
    enter: (n) => {
      if (n.name === "ImportDeclaration" || n.name === "PackageDeclaration") return false;
      if (n.name === "Identifier" || n.name === "TypeName" || n.name === "Definition")
        out.add(text.slice(n.from, n.to));
      return undefined;
    },
  });
  return out;
}

/** Positions of identifier references named `name` (not declarations, not `x.name` member accesses). */
export function identifierRefs(text: string, from: number, to: number, name: string): number[] {
  const tree = javaLanguage.parser.parse(text);
  const out: number[] = [];
  tree.iterate({
    from,
    to,
    enter: (n) => {
      if (n.name !== "Identifier" || n.from < from || n.to > to || text.slice(n.from, n.to) !== name) return;
      const before = text.slice(0, n.from).trimEnd();
      // `this.name` and `Own.name` still mean the field; `other.name` does not.
      if (before.endsWith(".") && !/(?:\bthis|\b[A-Z][\w$]*)\s*\.$/.test(before)) return;
      out.push(n.from);
    },
  });
  return out;
}
