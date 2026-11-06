/**
 * Highlighting of `.es` console files (the `Elasticsearch` ui-mode): the method of a
 * request line as a keyword, its path (index names as types, `_api` words as function
 * calls, ids as strings), query parameters, and JSON bodies (keys as properties, strings,
 * numbers, `true` / `false` / `null`, Kibana's `"""` strings) with `#`, `//` and `/* *\/`
 * comments. Bodies and request blocks fold; bodies auto-indent by bracket depth.
 */
import {
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
  foldService,
  type StreamParser,
} from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { API_PATH_WORDS } from "./catalog";
import { REQUEST_LINE } from "./parse";

interface State {
  /** On a request line: the method, path or query string is next. */
  line: "body" | "method" | "path" | "query";
  /** Path segments seen on the request line; the previous one was an `_api` word. */
  segment: number;
  afterApi: boolean;
  /** In the query string, after `=`. */
  queryValue: boolean;
  /** Open `{` / `[` of the body. */
  brackets: string;
  /** Inside a `/* *\/` comment or a `"""` string spanning lines. */
  block: "comment" | "triple" | null;
}

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?/;

type Stream = Parameters<StreamParser<State>["token"]>[0];

function requestToken(stream: Stream, state: State): string | null {
  if (stream.eatSpace()) return null;
  if (state.line === "method") {
    stream.match(/^[A-Za-z]+/);
    state.line = "path";
    return "keyword";
  }
  if (state.line === "path") {
    if (stream.eat("/")) return "punctuation";
    if (stream.eat("?")) {
      state.line = "query";
      return "operator";
    }
    stream.match(/^[^/?\s]+/);
    const seg = stream.current();
    const index = state.segment++;
    if (seg.startsWith("_")) {
      state.afterApi = true;
      return "variableName.function";
    }
    const api = state.afterApi && API_PATH_WORDS.has(seg);
    state.afterApi = api;
    if (api) return "variableName.function";
    return index === 0 ? "typeName" : "string";
  }
  if (stream.eat("&")) {
    state.queryValue = false;
    return "operator";
  }
  if (stream.eat("=")) {
    state.queryValue = true;
    return "operator";
  }
  if (!stream.match(/^[^&=\s]+/)) stream.next();
  return state.queryValue ? "attributeValue" : "attributeName";
}

/** The rest of a `/* *\/` comment or `"""` string, up to its end or the line's. */
function blockToken(stream: Stream, state: State): string {
  const comment = state.block === "comment";
  const end = comment ? "*/" : '"""';
  if (stream.skipTo(end)) {
    stream.pos += end.length;
    state.block = null;
  } else stream.skipToEnd();
  return comment ? "blockComment" : "string.special";
}

export const esParser: StreamParser<State> = {
  name: "elasticsearch",
  startState: () => ({ line: "body", segment: 0, afterApi: false, queryValue: false, brackets: "", block: null }),
  copyState: (s) => ({ ...s }),
  token(stream, state) {
    if (stream.sol() && !state.block) {
      if (REQUEST_LINE.test(stream.string)) {
        state.line = "method";
        state.segment = 0;
        state.afterApi = false;
        state.queryValue = false;
        state.brackets = "";
      } else state.line = "body";
    }
    if (state.block) return blockToken(stream, state);
    if (state.line !== "body") return requestToken(stream, state);
    if (stream.eatSpace()) return null;
    if (stream.peek() === "#" || stream.match("//")) {
      stream.skipToEnd();
      return "lineComment";
    }
    if (stream.match("/*")) {
      state.block = "comment";
      return blockToken(stream, state);
    }
    if (stream.match('"""')) {
      state.block = "triple";
      return blockToken(stream, state);
    }
    const c = stream.next()!;
    switch (c) {
      case '"':
        stream.match(/^(?:[^"\\]|\\.)*"?/);
        return stream.match(/^\s*:/, false) ? "propertyName" : "string";
      case "{":
      case "[":
        state.brackets += c;
        return c === "{" ? "brace" : "squareBracket";
      case "}":
      case "]":
        state.brackets = state.brackets.slice(0, -1);
        return c === "}" ? "brace" : "squareBracket";
      case ":":
      case ",":
        return "punctuation";
      default:
    }
    stream.backUp(1);
    if (stream.match(NUMBER)) return "number";
    if (stream.match(/^(true|false)\b/)) return "bool";
    if (stream.match(/^null\b/)) return "null";
    if (!stream.match(/^[^\s{}[\]:,"]+/)) stream.next();
    return null;
  },
  indent(state, textAfter, cx) {
    if (state.block) return null;
    if (REQUEST_LINE.test(textAfter)) return 0;
    const depth = state.brackets.length - (/^\s*[}\]]/.test(textAfter) ? 1 : 0);
    return Math.max(0, depth) * cx.unit;
  },
  languageData: {
    commentTokens: { line: "#" },
    closeBrackets: { brackets: ["(", "[", "{", '"'] },
    indentOnInput: /^\s*[}\]]$/,
  },
};

export const esLanguage = StreamLanguage.define(esParser);

/** Characters scanned at most to find the end of a fold. */
const FOLD_SCAN_LIMIT = 2_000_000;

/** Fold range of a request block (to its last content line) or a bracket opened on a line. */
export function esFoldRange(
  state: EditorState,
  lineStart: number,
  lineEnd: number,
): { from: number; to: number } | null {
  const doc = state.doc;
  const text = doc.sliceString(lineStart, lineEnd);
  if (REQUEST_LINE.test(text)) {
    const first = doc.lineAt(lineStart).number;
    let end = lineEnd;
    for (let n = first + 1; n <= doc.lines; n++) {
      const line = doc.line(n);
      if (REQUEST_LINE.test(line.text)) break;
      const t = line.text.trim();
      if (t && !t.startsWith("#") && !t.startsWith("//")) end = line.from + line.text.trimEnd().length;
    }
    return end > lineEnd ? { from: lineEnd, to: end } : null;
  }
  // The first bracket of the line left open at its end.
  const open: number[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "#" || (c === "/" && text[i + 1] === "/")) break;
    else if (c === "{" || c === "[") open.push(i);
    else if ((c === "}" || c === "]") && open.length) open.pop();
  }
  if (!open.length) return null;
  const from = lineStart + open[0]! + 1;
  let depth = 1;
  let pos = from;
  inString = false;
  const iter = doc.iterRange(from, Math.min(doc.length, from + FOLD_SCAN_LIMIT));
  let lineStartChunk = false;
  while (!iter.next().done) {
    if (iter.lineBreak) {
      pos += 1;
      lineStartChunk = true;
      continue;
    }
    const chunk = iter.value;
    if (lineStartChunk && REQUEST_LINE.test(chunk)) return null;
    lineStartChunk = false;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]!;
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "#" || (c === "/" && chunk[i + 1] === "/")) break;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        if (--depth === 0) {
          const to = pos + i;
          return doc.lineAt(to).number > doc.lineAt(lineStart).number ? { from, to } : null;
        }
      }
    }
    pos += chunk.length;
  }
  return null;
}

export const esFolding = foldService.of(esFoldRange);

/** The `Elasticsearch` mode of `languages/elasticsearch.toml`, for `registerLanguageMode`. */
export const esLanguageDescription = LanguageDescription.of({
  name: "Elasticsearch",
  extensions: ["es"],
  support: new LanguageSupport(esLanguage, [esFolding]),
});
