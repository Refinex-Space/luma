/**
 * SpEL in Java editors (IDEA's Spring Expression Language support): highlighting with the
 * injected-fragment background, completion (`@` beans, `#` variables, `T(` types, `.`
 * members), ⌘-click navigation (beans, types, members, parameters) and diagnostics (syntax,
 * unresolved beans, SpEL on static fields, unprefixed cache variables).
 */
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { ensureSyntaxTree, highlightingFor, syntaxTree } from "@codemirror/language";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { highlightTree, tags as t } from "@lezer/highlight";
import { CONTRIBUTED_DEFINITION, type ContributedDefinition } from "@/editor/api";
import { setFileDiagnostics } from "@/editor/lsp/diagnostics";
import { navigateTo } from "@/editor/lsp/navigation";
import { offsetsToRange } from "@/editor/lsp/positions";
import { tx, txTemplate } from "@/platform/i18n";
import { SPRING_PRODUCERS } from "@/platform/inspections";
import {
  call,
  commands,
  onIdeEvent,
  type Diagnostic,
  type SpringBeanInfo,
  type SpringContextInfo,
  type SpringTypeMembers,
} from "@/platform/ipc";
import { openBean } from "../explorer/open";
import { pieceAt, pieceOffset, regionPieces, spelRegions, type SpelPiece, type SpelRegion } from "./hosts";
import { parseSpel, spelErrors } from "./language";

// ---------------------------------------------------------------------------
// Analysis of a document version

interface Parsed {
  piece: SpelPiece;
  tree: Tree;
}

interface Analysis {
  regions: SpelRegion[];
  pieces: SpelPiece[];
  parsed: Parsed[];
  imports: Imports;
}

interface Imports {
  pkg: string;
  /** Simple name → FQN of single-type imports. */
  single: Map<string, string>;
  /** Packages imported on demand. */
  onDemand: string[];
}

const analyses = new WeakMap<EditorState, Analysis>();
const trees = new Map<string, Tree>();

function parsedTree(text: string): Tree {
  let tree = trees.get(text);
  if (!tree) {
    tree = parseSpel(text);
    if (trees.size > 2000) trees.clear();
    trees.set(text, tree);
  }
  return tree;
}

function javaImports(doc: string, tree: Tree): Imports {
  const out: Imports = { pkg: "", single: new Map(), onDemand: [] };
  const top = tree.topNode;
  for (let c = top.firstChild; c; c = c.nextSibling) {
    const text = doc.slice(c.from, c.to);
    if (c.name === "PackageDeclaration") out.pkg = text.replace(/^package\s+|;\s*$/g, "").replace(/\s+/g, "");
    else if (c.name === "ImportDeclaration" && !/\bstatic\b/.test(text)) {
      const path = text.replace(/^import\s+|;\s*$/g, "").replace(/\s+/g, "");
      if (path.endsWith(".*")) out.onDemand.push(path.slice(0, -2));
      else out.single.set(path.slice(path.lastIndexOf(".") + 1), path);
    } else if (/Declaration$/.test(c.name)) break;
  }
  return out;
}

/** Analysis of `state` (needs its Java syntax tree; parsed up to 60 ms when not there yet). */
export function analysis(state: EditorState): Analysis {
  let a = analyses.get(state);
  if (a) return a;
  const tree = ensureSyntaxTree(state, state.doc.length, 60) ?? syntaxTree(state);
  const doc = state.doc.toString();
  const regions = spelRegions(doc, tree);
  const pieces = regions.flatMap(regionPieces);
  a = {
    regions,
    pieces,
    parsed: pieces.map((piece) => ({ piece, tree: parsedTree(piece.text) })),
    imports: javaImports(doc, tree),
  };
  analyses.set(state, a);
  return a;
}

// ---------------------------------------------------------------------------
// Highlighting

const background = Decoration.mark({ class: "cm-luma-spel" });

function decorations(state: EditorState): DecorationSet {
  const ranges: ReturnType<Decoration["range"]>[] = [];
  const style = (tags: readonly import("@lezer/highlight").Tag[]) => highlightingFor(state, tags);
  const delimiter = style([t.special(t.brace)]);
  for (const { piece, tree } of analysis(state).parsed) {
    const from = pieceOffset(piece, 0);
    const to = pieceOffset(piece, piece.text.length);
    if (piece.template) {
      const map = piece.region.map;
      const open = map[piece.start - 2]!;
      const close = piece.unclosed ? to : map[piece.start + piece.text.length + 1]!;
      if (delimiter) {
        ranges.push(Decoration.mark({ class: delimiter }).range(open, from));
        if (!piece.unclosed) ranges.push(Decoration.mark({ class: delimiter }).range(to, close));
      }
      ranges.push(background.range(open, close));
    } else if (to > from) ranges.push(background.range(from, to));
    highlightTree(tree, { style }, (a, b, cls) => {
      const f = pieceOffset(piece, a);
      const e = pieceOffset(piece, b);
      if (e > f) ranges.push(Decoration.mark({ class: cls }).range(f, e));
    });
  }
  return Decoration.set(ranges, true);
}

const highlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorations(view.state);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = decorations(u.state);
    }
  },
  { decorations: (v) => v.decorations },
);

const theme = EditorView.baseTheme({
  ".cm-luma-spel": {
    backgroundColor: "color-mix(in srgb, var(--accent) 7%, transparent)",
    borderRadius: "2px",
  },
});

// ---------------------------------------------------------------------------
// The project's beans and types (completion, navigation, diagnostics)

const FRESH_MS = 5000;
let beansCache: { at: number; beans: Promise<SpringBeanInfo[]>; contexts: Promise<SpringContextInfo[]> } | null = null;

function project() {
  if (!beansCache || performance.now() - beansCache.at > FRESH_MS) {
    beansCache = {
      at: performance.now(),
      beans: call(commands.springBeans(null)).catch(() => []),
      contexts: call(commands.springContexts()).catch(() => []),
    };
  }
  return beansCache;
}

async function beanNamed(name: string): Promise<SpringBeanInfo | undefined> {
  return (await project().beans).find((b) => b.name === name || b.aliases.includes(name));
}

const memberCache = new Map<string, Promise<SpringTypeMembers | null>>();

function members(doc: number, fqn: string): Promise<SpringTypeMembers | null> {
  const key = `${doc}:${fqn}`;
  let p = memberCache.get(key);
  if (!p) {
    p = call(commands.springMembers(doc, fqn)).catch(() => null);
    memberCache.set(key, p);
    setTimeout(() => memberCache.delete(key), 30_000);
  }
  return p;
}

const PRIMITIVES = new Set(["int", "long", "short", "byte", "char", "boolean", "float", "double", "void"]);
const JAVA_LANG = new Set([
  "String",
  "Object",
  "Integer",
  "Long",
  "Short",
  "Byte",
  "Character",
  "Boolean",
  "Float",
  "Double",
  "Math",
  "System",
  "Class",
  "Number",
  "Iterable",
  "CharSequence",
  "Enum",
  "Thread",
  "StringBuilder",
]);

/** FQN of a type written in the Java file (imports, its package, `java.lang`). */
function qualify(written: string, imports: Imports): string | null {
  const name = written
    .replace(/<.*$/s, "")
    .replace(/\.\.\.$/, "")
    .trim();
  if (!name || PRIMITIVES.has(name.replace(/\[\]$/g, ""))) return null;
  if (name.includes(".") && /^[a-z]/.test(name)) return name;
  const head = name.split(".")[0]!;
  const imported = imports.single.get(head);
  if (imported) return name.includes(".") ? `${imported}${name.slice(head.length)}` : imported;
  if (JAVA_LANG.has(head)) return `java.lang.${name}`;
  return imports.pkg ? `${imports.pkg}.${name}` : name;
}

/** Types SpEL's `T()` finds without a package (Spring's `StandardTypeLocator`: `java.lang`), and common others. */
const COMMON_TYPES = [
  "java.lang.Math",
  "java.lang.String",
  "java.lang.Integer",
  "java.lang.Long",
  "java.lang.Boolean",
  "java.lang.Double",
  "java.lang.System",
  "java.lang.Character",
  "java.util.UUID",
  "java.util.Arrays",
  "java.util.Collections",
  "java.util.Objects",
  "java.time.LocalDate",
  "java.time.LocalDateTime",
  "java.time.Instant",
  "java.time.Duration",
  "java.util.concurrent.TimeUnit",
];

// ---------------------------------------------------------------------------
// Types of expressions

interface Typed {
  fqn: string;
  /** `T(Foo)`: its static members. */
  isStatic: boolean;
}

const ROOT_TYPES: Partial<Record<string, string>> = {
  cache: "org.springframework.cache.interceptor.CacheExpressionRootObject",
  event: "org.springframework.context.event.EventExpressionRootObject",
};

function paramType(piece: SpelPiece, name: string, imports: Imports): string | null {
  const params = piece.region.target.params;
  const m = /^[pa](\d+)$/.exec(name);
  const p = m ? params[Number(m[1])] : params.find((x) => x.name === name);
  return p ? qualify(p.type, imports) : null;
}

function getterOf(m: SpringTypeMembers, property: string) {
  const cap = property[0]!.toUpperCase() + property.slice(1);
  return (
    m.members.find((x) => x.kind === "field" && x.name === property) ??
    m.members.find(
      (x) => x.kind === "method" && x.params.length === 0 && (x.name === `get${cap}` || x.name === `is${cap}`),
    ) ??
    // Records: `name()`.
    m.members.find((x) => x.kind === "method" && x.params.length === 0 && x.name === property)
  );
}

async function typeOf(
  node: SyntaxNode,
  text: string,
  piece: SpelPiece,
  doc: number,
  imports: Imports,
): Promise<Typed | null> {
  const src = (n: SyntaxNode) => text.slice(n.from, n.to);
  switch (node.name) {
    case "ParenthesizedExpression": {
      const inner = node.firstChild?.nextSibling;
      return inner ? typeOf(inner, text, piece, doc, imports) : null;
    }
    case "String":
      return { fqn: "java.lang.String", isStatic: false };
    case "BeanReference": {
      const name = src(node).replace(/^[@&]'?|'$/g, "");
      const bean = await beanNamed(name);
      return bean ? { fqn: bean.typeFqn, isStatic: false } : null;
    }
    case "TypeReference": {
      const q = node.getChild("QualifiedName");
      if (!q) return null;
      const name = src(q);
      return { fqn: name.includes(".") ? name : `java.lang.${name}`, isStatic: true };
    }
    case "NewExpression": {
      const q = node.getChild("QualifiedName");
      return q ? { fqn: qualify(src(q), imports) ?? src(q), isStatic: false } : null;
    }
    case "VariableName": {
      const name = src(node).slice(1);
      const kind = piece.region.host.kind;
      if (name === "root") {
        const root = ROOT_TYPES[kind];
        return root ? { fqn: root, isStatic: false } : null;
      }
      if (name === "result" && kind === "cache") {
        const r = piece.region.target.returns;
        return r ? (qualify(r, imports) ? { fqn: qualify(r, imports)!, isStatic: false } : null) : null;
      }
      const p = paramType(piece, name, imports);
      return p ? { fqn: p, isStatic: false } : null;
    }
    case "PropertyName": {
      const name = src(node);
      const kind = piece.region.host.kind;
      const root = ROOT_TYPES[kind];
      if (root) {
        const m = await members(doc, root);
        const g = m && getterOf(m, name);
        return g ? { fqn: g.returns, isStatic: false } : null;
      }
      // `@Value`: the root resolves bean names.
      const bean = await beanNamed(name);
      return bean ? { fqn: bean.typeFqn, isStatic: false } : null;
    }
    case "MemberExpression": {
      const object = node.firstChild;
      const prop = node.lastChild;
      if (!object || !prop || prop.name !== "PropertyName") return null;
      const owner = await typeOf(object, text, piece, doc, imports);
      if (!owner) return null;
      const m = await members(doc, owner.fqn);
      const g = m && getterOf(m, src(prop));
      return g ? { fqn: g.returns, isStatic: false } : null;
    }
    case "CallExpression": {
      const callee = node.firstChild;
      if (!callee) return null;
      if (callee.name === "MemberExpression") {
        const object = callee.firstChild;
        const prop = callee.lastChild;
        if (!object || !prop) return null;
        const owner = await typeOf(object, text, piece, doc, imports);
        const m = owner && (await members(doc, owner.fqn));
        const method = m?.members.find((x) => x.kind === "method" && x.name === src(prop));
        return method ? { fqn: method.returns, isStatic: false } : null;
      }
      return null;
    }
    case "IndexExpression": {
      const owner = node.firstChild ? await typeOf(node.firstChild, text, piece, doc, imports) : null;
      return owner?.fqn.endsWith("[]") ? { fqn: owner.fqn.slice(0, -2), isStatic: false } : null;
    }
    default:
      return null;
  }
}

/** The whole expression ending at `end` (a member chain), in a tree of `text`. */
function expressionEndingAt(tree: Tree, end: number): SyntaxNode | null {
  let n: SyntaxNode | null = tree.resolveInner(end, -1);
  while (n && n.to === end && n.parent && n.parent.to === end && n.parent.name !== "Spel") {
    if (
      [
        "MemberExpression",
        "CallExpression",
        "IndexExpression",
        "BeanReference",
        "TypeReference",
        "ParenthesizedExpression",
        "NewExpression",
      ].includes(n.parent.name)
    )
      n = n.parent;
    else break;
  }
  return n && n.to === end && n.name !== "Spel" ? n : null;
}

// ---------------------------------------------------------------------------
// Completion

const VARIABLES: Record<string, Array<[string, string]>> = {
  cache: [
    ["root", "CacheExpressionRootObject"],
    ["result", "the method's result (unless, @CachePut key)"],
  ],
  event: [["root", "EventExpressionRootObject"]],
  value: [],
  condition: [],
  security: [],
  generic: [],
};

const SECURITY = [
  "hasRole('')",
  "hasAnyRole('')",
  "hasAuthority('')",
  "hasAnyAuthority('')",
  "isAuthenticated()",
  "isAnonymous()",
  "isFullyAuthenticated()",
  "permitAll",
  "denyAll",
  "principal",
  "authentication",
  "returnObject",
  "filterObject",
];

/** The project's beans first, then the framework's, the libraries' last. */
const beanBoost = (b: SpringBeanInfo) => (b.source === "project" ? 2 : b.source === "library" ? -1 : 0);

function option(label: string, extra: Partial<Completion> & { icon?: string; typeText?: string }): Completion {
  return { label, ...extra };
}

async function complete(ctx: CompletionContext, doc: number): Promise<CompletionResult | null> {
  const a = analysis(ctx.state);
  const hit = pieceAt(a.pieces, ctx.pos);
  if (!hit) return null;
  const { piece, at } = hit;
  const before = piece.text.slice(0, at);
  const local = (i: number) => pieceOffset(piece, i);

  // `@bean` / `&factory`
  let m = /[@&]([\w$]*)$/.exec(before);
  if (m) {
    const beans = await project().beans;
    const seen = new Set<string>();
    const options = beans
      .filter((b) => !seen.has(b.name) && seen.add(b.name))
      .map((b) => option(b.name, { type: "variable", icon: "spring-bean", typeText: b.typeName, boost: beanBoost(b) }));
    return { from: local(at - m[1]!.length), to: ctx.pos, options, validFor: /^[\w$]*$/ };
  }
  // `#variable`
  m = /#([\w$]*)$/.exec(before);
  if (m) {
    const t = piece.region.target;
    const vars: Completion[] = [
      ...(VARIABLES[piece.region.host.kind] ?? []).map(([name, detail]) => option(name, { type: "variable", detail })),
      option("this", { type: "keyword", detail: "the current evaluation object" }),
    ];
    if (
      piece.region.host.kind === "cache" ||
      piece.region.host.kind === "event" ||
      piece.region.host.kind === "security"
    )
      t.params.forEach((p, i) => {
        vars.push(option(p.name, { type: "variable", typeText: p.type }));
        vars.push(option(`p${i}`, { type: "variable", typeText: p.type, detail: p.name }));
        vars.push(option(`a${i}`, { type: "variable", typeText: p.type, detail: p.name }));
      });
    return { from: local(at - m[1]!.length), to: ctx.pos, options: vars, validFor: /^[\w$]*$/ };
  }
  // `T(java.util.UU`
  m = /\bT\(\s*([\w$.]*)$/.exec(before);
  if (m) {
    const typed = m[1]!;
    const query = typed.slice(typed.lastIndexOf(".") + 1);
    const found = query.length >= 1 ? await call(commands.findSymbols(query, "types", 40)).catch(() => []) : [];
    const options = [
      ...COMMON_TYPES.map((fqn) => ({ fqn, name: fqn.slice(fqn.lastIndexOf(".") + 1) })),
      ...found.map((s) => ({ fqn: s.container ? `${s.container}.${s.name}` : s.name, name: s.name })),
    ].map((x) =>
      option(x.fqn.startsWith("java.lang.") ? x.name : x.fqn, { type: "class", icon: "symbol-class", detail: x.fqn }),
    );
    return { from: local(at - typed.length), to: ctx.pos, options, validFor: /^[\w$.]*$/ };
  }
  // `expr.` / `expr?.` members
  m = /(\?\.|\.)([\w$]*)$/.exec(before);
  if (m && !/^\d/.test(before.slice(-m[0].length - 1))) {
    const end = at - m[0].length;
    const prefixTree = parsedTree(before.slice(0, end));
    const node = expressionEndingAt(prefixTree, end);
    if (!node) return null;
    const type = await typeOf(node, before.slice(0, end), piece, doc, a.imports);
    const info = type && (await members(doc, type.fqn));
    if (!info) return null;
    const options: Completion[] = [];
    const seen = new Set<string>();
    for (const x of info.members) {
      if (type.isStatic !== x.static) continue;
      const simple = x.returns.slice(x.returns.lastIndexOf(".") + 1);
      if (x.kind === "field") {
        if (!seen.has(x.name) && seen.add(x.name)) options.push(option(x.name, { type: "property", typeText: simple }));
        continue;
      }
      const label = `${x.name}(${x.params.join(", ")})`;
      if (seen.has(label)) continue;
      seen.add(label);
      options.push(
        option(x.name, {
          type: "method",
          detail: `(${x.params.join(", ")})`,
          typeText: simple,
          apply: x.params.length ? `${x.name}(` : `${x.name}()`,
        }),
      );
      // A getter is also a property.
      const prop = /^(?:get|is)([A-Z]\w*)$/.exec(x.name);
      if (prop && !x.params.length && !type.isStatic) {
        const name = prop[1]![0]!.toLowerCase() + prop[1]!.slice(1);
        if (!seen.has(name) && seen.add(name))
          options.push(option(name, { type: "property", typeText: simple, boost: 1 }));
      }
    }
    return { from: local(at - m[2]!.length), to: ctx.pos, options, validFor: /^[\w$]*$/ };
  }
  // A name at the start of an operand: beans (`@Value`'s root resolves them), the root object's properties, security functions.
  m = /(?:^|[\s(,+\-*/%<>=!&|?:[{])([\w$]*)$/.exec(before);
  if (m && (ctx.explicit || m[1]!.length)) {
    const kind = piece.region.host.kind;
    const options: Completion[] = [];
    if (kind === "value" || kind === "generic" || kind === "condition") {
      const seen = new Set<string>();
      for (const b of await project().beans)
        if (!seen.has(b.name) && seen.add(b.name))
          options.push(
            option(b.name, { type: "variable", icon: "spring-bean", typeText: b.typeName, boost: beanBoost(b) }),
          );
    }
    const root = ROOT_TYPES[kind];
    if (root) {
      const info = await members(doc, root);
      for (const x of info?.members ?? []) {
        const prop = /^(?:get|is)([A-Z]\w*)$/.exec(x.name);
        if (prop && !x.params.length)
          options.push(
            option(prop[1]![0]!.toLowerCase() + prop[1]!.slice(1), {
              type: "property",
              typeText: x.returns.slice(x.returns.lastIndexOf(".") + 1),
            }),
          );
      }
    }
    if (kind === "security") options.push(...SECURITY.map((s) => option(s, { type: "function" })));
    for (const k of ["T()", "new ", "true", "false", "null"]) options.push(option(k, { type: "keyword" }));
    return { from: local(at - m[1]!.length), to: ctx.pos, options, validFor: /^[\w$]*$/ };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Navigation

interface Target {
  from: number;
  to: number;
  open(view: EditorView): Promise<void> | void;
}

function targetAt(state: EditorState, pos: number, doc: number): Target | null {
  const a = analysis(state);
  const hit = pieceAt(a.pieces, pos);
  if (!hit) return null;
  const { piece } = hit;
  const tree = parsedTree(piece.text);
  const node = tree.resolveInner(hit.at, 1);
  const src = (n: SyntaxNode) => piece.text.slice(n.from, n.to);
  const range = (n: SyntaxNode) => ({ from: pieceOffset(piece, n.from), to: pieceOffset(piece, n.to) });
  const locate = async (handle: string) => {
    const loc = await call(commands.springLocate(doc, handle)).catch(() => null);
    if (loc) await navigateTo(loc);
  };
  if (
    node.name === "BeanName" ||
    node.name === "FactoryBeanName" ||
    (node.name === "String" && node.parent?.name === "BeanReference")
  ) {
    const name = src(node).replace(/^[@&]|^'|'$/g, "");
    return {
      ...range(node),
      open: async () => {
        const bean = await beanNamed(name);
        if (bean) await openBean(bean);
      },
    };
  }
  if (
    node.name === "TypeName" &&
    node.parent?.name === "QualifiedName" &&
    node.parent.parent?.name === "TypeReference"
  ) {
    const q = node.parent;
    const name = src(q);
    return {
      ...range(q),
      open: async () => {
        const info = await members(doc, name.includes(".") ? name : `java.lang.${name}`);
        if (info) await locate(info.handle);
      },
    };
  }
  if (node.name === "VariableName") {
    const p = piece.region.target.params.find(
      (x, i) => `#${x.name}` === src(node) || `#p${i}` === src(node) || `#a${i}` === src(node),
    );
    if (!p) return null;
    return {
      ...range(node),
      open: (view) => view.dispatch({ selection: { anchor: p.at }, scrollIntoView: true }),
    };
  }
  if (node.name === "PropertyName" && node.parent?.name === "MemberExpression") {
    const member = node.parent;
    const object = member.firstChild;
    if (!object) return null;
    const name = src(node);
    return {
      ...range(node),
      open: async () => {
        const owner = await typeOf(object, piece.text, piece, doc, a.imports);
        const info = owner && (await members(doc, owner.fqn));
        const found =
          info &&
          (member.parent?.name === "CallExpression" ? info.members.find((x) => x.name === name) : getterOf(info, name));
        if (found) await locate(found.handle);
      },
    };
  }
  if (node.name === "PropertyName" && piece.region.host.kind === "value") {
    const name = src(node);
    return {
      ...range(node),
      open: async () => {
        const bean = await beanNamed(name);
        if (bean) await openBean(bean);
      },
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Diagnostics

const SPEL_PRODUCERS = [
  SPRING_PRODUCERS.spelSyntax,
  SPRING_PRODUCERS.spelReferences,
  SPRING_PRODUCERS.spelStatic,
  SPRING_PRODUCERS.spelCacheVariable,
] as const;

export interface SpelProblem {
  producer: (typeof SPEL_PRODUCERS)[number];
  from: number;
  to: number;
  severity: Diagnostic["severity"];
  message: string;
}

/** Problems of a document's SpEL; bean references checked against `beans` when `complete`. */
export function spelProblems(a: Analysis, beans: ReadonlySet<string> | null): SpelProblem[] {
  const out: SpelProblem[] = [];
  const statics = new Set<SpelRegion>();
  for (const { piece, tree } of a.parsed) {
    const at = (i: number) => pieceOffset(piece, i);
    const r = piece.region;
    if (piece.unclosed) {
      out.push({
        producer: SPRING_PRODUCERS.spelSyntax,
        from: r.map[piece.start - 2]!,
        to: at(piece.text.length),
        severity: "warning",
        message: tx`No ending suffix '}' for expression starting at character ${piece.start - 2}`,
      });
    }
    for (const e of spelErrors(tree, piece.text))
      out.push({
        producer: SPRING_PRODUCERS.spelSyntax,
        from: at(e.from),
        to: at(e.to),
        severity: "warning",
        message:
          e.to >= piece.text.length && e.from >= piece.text.length - 1
            ? "Expression is incomplete"
            : "Unexpected token",
      });
    if (!piece.text.trim() && !piece.unclosed)
      out.push({
        producer: SPRING_PRODUCERS.spelSyntax,
        from: at(0),
        to: at(0) + 1,
        severity: "warning",
        message: "Expression is empty",
      });
    if (r.target.kind === "field" && r.target.isStatic && r.host.annotation === "Value" && !statics.has(r)) {
      statics.add(r);
      out.push({
        producer: SPRING_PRODUCERS.spelStatic,
        from: r.from,
        to: r.to,
        severity: "warning",
        message: "Injection to static fields is not allowed",
      });
    }
    const params = new Set(r.target.params.flatMap((p, i) => [p.name, `p${i}`, `a${i}`]));
    if (r.host.kind === "cache") params.add("result");
    tree.iterate({
      enter(n) {
        const text = piece.text.slice(n.from, n.to);
        if ((n.name === "BeanName" || n.name === "FactoryBeanName") && beans && !beans.has(text.slice(1)))
          out.push({
            producer: SPRING_PRODUCERS.spelReferences,
            from: at(n.from),
            to: at(n.to),
            severity: "error",
            message: tx`Cannot resolve bean '${text.slice(1)}'`,
          });
        // `key = "p0"`: a cache variable without its `#` reads a root property that does not exist.
        if (
          r.host.kind === "cache" &&
          n.name === "PropertyName" &&
          n.node.parent?.name !== "MemberExpression" &&
          params.has(text)
        )
          out.push({
            producer: SPRING_PRODUCERS.spelCacheVariable,
            from: at(n.from),
            to: at(n.to),
            severity: "warning",
            message: tx`Cache SpEL variable '${text}' must be prefixed with #`,
          });
      },
    });
  }
  return out;
}

function diagnostics(path: string) {
  return ViewPlugin.define((view) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    const publish = async () => {
      const gen = ++generation;
      const state = view.state;
      const a = analysis(state);
      let beans: Set<string> | null = null;
      if (a.pieces.some((p) => /[@&][\w$]/.test(p.text))) {
        const { beans: list, contexts } = project();
        const [all, ctxs] = await Promise.all([list, contexts]);
        // Only when every context is complete: a missing bean is never claimed otherwise.
        if (ctxs.length && ctxs.every((c) => !c.unknownSources))
          beans = new Set(all.flatMap((b) => [b.name, ...b.aliases]));
      }
      if (gen !== generation || view.state !== state) return;
      const problems = spelProblems(a, beans);
      for (const producer of SPEL_PRODUCERS)
        setFileDiagnostics(
          path,
          producer,
          problems
            .filter((p) => p.producer === producer)
            .map((p) => ({
              range: offsetsToRange(state.doc, p.from, p.to),
              severity: p.severity,
              message: txTemplate(p.message),
              source: "Spring",
              code: null,
            })),
        );
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void publish(), 400);
    };
    schedule();
    // The beans or the contexts' completeness changed (a library model, a saved file): ask again.
    const refresh = () => {
      beansCache = null;
      schedule();
    };
    const offs = [
      onIdeEvent("springModelChanged", refresh),
      onIdeEvent("indexState", (e) => {
        if (!e.indexing) refresh();
      }),
    ];
    return {
      update: (u: ViewUpdate) => {
        if (u.docChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) schedule();
      },
      destroy: () => {
        clearTimeout(timer);
        generation++;
        offs.forEach((off) => off());
        for (const producer of SPEL_PRODUCERS) setFileDiagnostics(path, producer, []);
      },
    };
  });
}

/** The SpEL support of a Java editor (`doc`: its document id, `path`: its file). */
export function spelSupport(path: string, doc: number): Extension {
  const definition: ContributedDefinition = Object.assign(
    (view: EditorView, pos: number) => {
      const target = targetAt(view.state, pos, doc);
      if (!target) return false;
      void target.open(view);
      return true;
    },
    { covers: (state: EditorState, pos: number) => !!targetAt(state, pos, doc) },
  );
  return [
    // Inside the Java string's highlighting (the innermost mark's colour shows).
    Prec.highest(highlighter),
    theme,
    diagnostics(path),
    Prec.high(
      EditorState.languageData.of((state: EditorState, pos: number) => {
        if (!pieceAt(analysis(state).pieces, pos)) return [];
        return [
          { [CONTRIBUTED_DEFINITION]: definition },
          {
            lumaExclusiveCompletion: (s: EditorState) =>
              pieceAt(analysis(s).pieces, s.selection.main.head)
                ? (ctx: CompletionContext) => complete(ctx, doc)
                : null,
          },
        ];
      }),
    ),
  ];
}
