/**
 * Where SpEL is in a Java file (IDEA's `SpringElInjector`): the string values of the
 * annotation attributes Spring evaluates as expressions, and `#{…}` templates in any
 * annotation string. Works on the Java syntax tree of the editor (`@lezer/java`) and maps
 * the decoded string back to document offsets. Pure.
 */
import type { SyntaxNode, Tree } from "@lezer/common";

/** What evaluates the expression, which decides its variables and root object. */
export type SpelHostKind = "value" | "cache" | "event" | "condition" | "security" | "generic";

export interface SpelHost {
  annotation: string;
  attribute: string;
  kind: SpelHostKind;
  /** `template`: `#{…}` parts of literal text; `expression`: the whole string. */
  mode: "template" | "expression";
}

interface HostSpec {
  attributes: readonly string[];
  kind: SpelHostKind;
  mode: "template" | "expression" | "auto";
}

/** Annotations evaluating attributes as SpEL (simple names; IDEA's injection table). */
const HOSTS: Record<string, HostSpec> = {
  Value: { attributes: ["value"], kind: "value", mode: "template" },
  Cacheable: { attributes: ["key", "condition", "unless"], kind: "cache", mode: "expression" },
  CachePut: { attributes: ["key", "condition", "unless"], kind: "cache", mode: "expression" },
  CacheEvict: { attributes: ["key", "condition"], kind: "cache", mode: "expression" },
  EventListener: { attributes: ["condition"], kind: "event", mode: "expression" },
  TransactionalEventListener: { attributes: ["condition"], kind: "event", mode: "expression" },
  // Boot wraps it in `#{…}` unless it is one already.
  ConditionalOnExpression: { attributes: ["value"], kind: "condition", mode: "auto" },
  PreAuthorize: { attributes: ["value"], kind: "security", mode: "expression" },
  PostAuthorize: { attributes: ["value"], kind: "security", mode: "expression" },
  PreFilter: { attributes: ["value"], kind: "security", mode: "expression" },
  PostFilter: { attributes: ["value"], kind: "security", mode: "expression" },
};

export interface SpelParam {
  name: string;
  type: string;
  /** The parameter name's position in the document. */
  at: number;
}

/** The method (or field) the annotation is on. */
export interface SpelTarget {
  kind: "method" | "field" | "type" | "other";
  isStatic: boolean;
  params: SpelParam[];
  /** A method's return type as written, `void` included. */
  returns: string | null;
}

export interface SpelRegion {
  host: SpelHost;
  /** The string's contents (inside the quotes) in the document. */
  from: number;
  to: number;
  /** The decoded string. */
  text: string;
  /** Document offset of each character of `text` (and of its end). */
  map: number[];
  target: SpelTarget;
}

/** One expression of a region: the whole string, or one `#{…}` of a template. */
export interface SpelPiece {
  region: SpelRegion;
  /** Where the expression starts in `region.text`. */
  start: number;
  text: string;
  /** Inside `#{…}` (the delimiters are at `start - 2` and `start + text.length`). */
  template: boolean;
  /** A template expression without its closing `}`. */
  unclosed: boolean;
}

/** Decodes a Java string literal's contents (`\"`, `\n`, `A`…) keeping each character's offset. */
export function decodeJavaString(raw: string, base: number): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  for (let i = 0; i < raw.length;) {
    const c = raw[i]!;
    if (c !== "\\" || i + 1 >= raw.length) {
      text += c;
      map.push(base + i);
      i++;
      continue;
    }
    const n = raw[i + 1]!;
    const simple: Record<string, string> = {
      b: "\b",
      t: "\t",
      n: "\n",
      f: "\f",
      r: "\r",
      s: " ",
      '"': '"',
      "'": "'",
      "\\": "\\",
    };
    if (n in simple) {
      text += simple[n];
      map.push(base + i);
      i += 2;
    } else if (n === "u") {
      let j = i + 1;
      while (raw[j] === "u") j++;
      const hex = raw.slice(j, j + 4);
      text += /^[0-9a-fA-F]{4}$/.test(hex) ? String.fromCharCode(parseInt(hex, 16)) : "\\";
      map.push(base + i);
      i = /^[0-9a-fA-F]{4}$/.test(hex) ? j + 4 : i + 1;
    } else if (/[0-7]/.test(n)) {
      const m = /^[0-7]{1,3}/.exec(raw.slice(i + 1))![0];
      text += String.fromCharCode(parseInt(m, 8));
      map.push(base + i);
      i += 1 + m.length;
    } else {
      // A line continuation (`\` at the end of a text block line) or an invalid escape.
      text += n === "\n" ? "" : n;
      if (n !== "\n") map.push(base + i);
      i += 2;
    }
  }
  map.push(base + raw.length);
  return { text, map };
}

/** The `#{…}` expressions of a template (Spring's `TemplateAwareExpressionParser`). */
export function templatePieces(region: SpelRegion): SpelPiece[] {
  const out: SpelPiece[] = [];
  const s = region.text;
  let i = 0;
  while ((i = s.indexOf("#{", i)) >= 0) {
    const start = i + 2;
    let depth = 0;
    let j = start;
    let end = -1;
    for (; j < s.length; j++) {
      const c = s[j]!;
      if (c === "'" || c === '"') {
        // A SpEL string: its quote doubled inside.
        j++;
        while (j < s.length && !(s[j] === c && s[j + 1] !== c)) j += s[j] === c ? 2 : 1;
      } else if (c === "{") depth++;
      else if (c === "}") {
        if (depth === 0) {
          end = j;
          break;
        }
        depth--;
      }
    }
    out.push({
      region,
      start,
      text: s.slice(start, end < 0 ? s.length : end),
      template: true,
      unclosed: end < 0,
    });
    if (end < 0) break;
    i = end + 1;
  }
  return out;
}

export function regionPieces(region: SpelRegion): SpelPiece[] {
  return region.host.mode === "template"
    ? templatePieces(region)
    : [{ region, start: 0, text: region.text, template: false, unclosed: false }];
}

const lastName = (doc: string, n: SyntaxNode | null): string => {
  if (!n) return "";
  const text = doc.slice(n.from, n.to);
  return text.slice(text.lastIndexOf(".") + 1).trim();
};

function stringRange(doc: string, n: SyntaxNode): { from: number; to: number } | null {
  const raw = doc.slice(n.from, n.to);
  if (raw.startsWith('"""')) {
    // A text block: its contents start after the line break following the opening quotes.
    const nl = raw.indexOf("\n");
    if (nl < 0) return null;
    return { from: n.from + nl + 1, to: n.to - (raw.endsWith('"""') && raw.length >= 6 ? 3 : 0) };
  }
  if (!raw.startsWith('"')) return null;
  return { from: n.from + 1, to: n.to - (raw.length > 1 && raw.endsWith('"') ? 1 : 0) };
}

function modifiersStatic(doc: string, decl: SyntaxNode): boolean {
  const mods = decl.getChild("Modifiers");
  return !!mods && /\bstatic\b/.test(doc.slice(mods.from, mods.to).replace(/@[\w.]+(\([^)]*\))?/g, ""));
}

function targetOf(doc: string, annotation: SyntaxNode): SpelTarget {
  // Annotation → Modifiers → declaration.
  const decl = annotation.parent?.parent ?? null;
  if (!decl) return { kind: "other", isStatic: false, params: [], returns: null };
  if (decl.name === "MethodDeclaration") {
    const params: SpelParam[] = [];
    const formals = decl.getChild("FormalParameters");
    for (let p = formals?.firstChild ?? null; p; p = p.nextSibling) {
      if (p.name !== "FormalParameter" && p.name !== "SpreadParameter") continue;
      const def = p.getChild("Definition") ?? p.getChild("VariableDeclarator")?.getChild("Definition") ?? null;
      const type = p.firstChild?.name === "Modifiers" ? p.firstChild.nextSibling : p.firstChild;
      if (!def) continue;
      params.push({
        name: doc.slice(def.from, def.to),
        type: type ? doc.slice(type.from, type.to).trim() : "",
        at: def.from,
      });
    }
    let returns: string | null = null;
    for (let c = decl.firstChild; c; c = c.nextSibling) {
      if (c.name === "Definition") break;
      if (c.name !== "Modifiers" && c.name !== "TypeParameters") returns = doc.slice(c.from, c.to).trim();
    }
    return { kind: "method", isStatic: modifiersStatic(doc, decl), params, returns };
  }
  if (decl.name === "FieldDeclaration")
    return { kind: "field", isStatic: modifiersStatic(doc, decl), params: [], returns: null };
  if (decl.name === "FormalParameter") return { kind: "other", isStatic: false, params: [], returns: null };
  if (/Declaration$/.test(decl.name)) return { kind: "type", isStatic: false, params: [], returns: null };
  return { kind: "other", isStatic: false, params: [], returns: null };
}

/** The SpEL regions of a Java document. */
export function spelRegions(doc: string, tree: Tree): SpelRegion[] {
  const out: SpelRegion[] = [];
  tree.iterate({
    enter(n) {
      if (n.name !== "Annotation") return;
      const node = n.node;
      const nameNode = node.getChild("Identifier") ?? node.getChild("ScopedIdentifier");
      const annotation = lastName(doc, nameNode);
      const spec = HOSTS[annotation];
      const args = node.getChild("AnnotationArgumentList");
      if (!args) return false;
      const values: Array<{ attribute: string; value: SyntaxNode }> = [];
      for (let a = args.firstChild; a; a = a.nextSibling) {
        if (a.name === "ElementValuePair") {
          const key = a.getChild("Identifier");
          const attribute = key ? doc.slice(key.from, key.to) : "value";
          for (let v = a.firstChild; v; v = v.nextSibling)
            if (v.name !== "Identifier" && v.name !== "AssignOp") values.push({ attribute, value: v });
        } else if (a.name !== "(" && a.name !== ")" && a.name !== ",") values.push({ attribute: "value", value: a });
      }
      let target: SpelTarget | null = null;
      for (const { attribute, value } of values) {
        // `{"a", "b"}` arrays: each string.
        const strings: SyntaxNode[] = [];
        if (value.name === "StringLiteral" || value.name === "TextBlock") strings.push(value);
        else if (value.name === "ElementValueArrayInitializer" || value.name === "ArrayInitializer")
          for (let c = value.firstChild; c; c = c.nextSibling) if (c.name === "StringLiteral") strings.push(c);
        for (const s of strings) {
          const range = stringRange(doc, s);
          if (!range) continue;
          const raw = doc.slice(range.from, range.to);
          let mode: "template" | "expression" | null = null;
          let kind: SpelHostKind = "generic";
          if (spec && spec.attributes.includes(attribute)) {
            kind = spec.kind;
            mode = spec.mode === "auto" ? (raw.includes("#{") ? "template" : "expression") : spec.mode;
          } else if (raw.includes("#{")) mode = "template";
          if (!mode) continue;
          const { text, map } = decodeJavaString(raw, range.from);
          target ??= targetOf(doc, node);
          out.push({ host: { annotation, attribute, kind, mode }, from: range.from, to: range.to, text, map, target });
        }
      }
      return false;
    },
  });
  return out;
}

/** Document offset of position `i` of a piece's text. */
export const pieceOffset = (p: SpelPiece, i: number): number => {
  const map = p.region.map;
  return map[Math.min(map.length - 1, p.start + i)]!;
};

/** The piece and its local position at document offset `pos` (inside or at the end of an expression). */
export function pieceAt(pieces: readonly SpelPiece[], pos: number): { piece: SpelPiece; at: number } | null {
  for (const p of pieces) {
    const from = pieceOffset(p, 0);
    const to = pieceOffset(p, p.text.length);
    if (pos < from || pos > to) continue;
    // The local index whose offset is `pos` (escapes make some characters longer).
    let at = 0;
    while (at < p.text.length && pieceOffset(p, at + 1) <= pos) at++;
    return { piece: p, at };
  }
  return null;
}
