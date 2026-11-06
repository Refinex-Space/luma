import { foldable } from "@codemirror/language";
import { StringStream } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { esFoldRange, esLanguageDescription, esParser } from "./language";

/** `[text, style]` of each token of `text`, lines tokenized with one state. */
function tokens(text: string): Array<[string, string | null]> {
  const state = esParser.startState!(2);
  const out: Array<[string, string | null]> = [];
  for (const line of text.split("\n")) {
    const stream = new StringStream(line, 2, 2);
    while (!stream.eol()) {
      const style = esParser.token(stream, state);
      const t = stream.current();
      if (t.trim()) out.push([t, style]);
      stream.start = stream.pos;
    }
  }
  return out;
}

describe("highlighting", () => {
  it("highlights the request line", () => {
    expect(tokens("GET /logs-*/_search?size=5&pretty")).toEqual([
      ["GET", "keyword"],
      ["/", "punctuation"],
      ["logs-*", "typeName"],
      ["/", "punctuation"],
      ["_search", "variableName.function"],
      ["?", "operator"],
      ["size", "attributeName"],
      ["=", "operator"],
      ["5", "attributeValue"],
      ["&", "operator"],
      ["pretty", "attributeName"],
    ]);
    expect(tokens("get _cat/indices").map((t) => t[1])).toEqual([
      "keyword",
      "variableName.function",
      "punctuation",
      "variableName.function",
    ]);
    // Known API words after an `_api` word stay API words; other ids are strings.
    expect(tokens("PUT logs/_doc/indices")).toEqual([
      ["PUT", "keyword"],
      ["logs", "typeName"],
      ["/", "punctuation"],
      ["_doc", "variableName.function"],
      ["/", "punctuation"],
      ["indices", "variableName.function"],
    ]);
    expect(tokens("DELETE logs/_doc/42").at(-1)).toEqual(["42", "string"]);
  });

  it("highlights JSON bodies: keys, strings, numbers, literals", () => {
    expect(tokens('{\n  "size": 10, "q": "a \\"b\\"",\n  "ok": [true, null, -1.5e3]\n}')).toEqual([
      ["{", "brace"],
      ['"size"', "propertyName"],
      [":", "punctuation"],
      ["10", "number"],
      [",", "punctuation"],
      ['"q"', "propertyName"],
      [":", "punctuation"],
      ['"a \\"b\\""', "string"],
      [",", "punctuation"],
      ['"ok"', "propertyName"],
      [":", "punctuation"],
      ["[", "squareBracket"],
      ["true", "bool"],
      [",", "punctuation"],
      ["null", "null"],
      [",", "punctuation"],
      ["-1.5e3", "number"],
      ["]", "squareBracket"],
      ["}", "brace"],
    ]);
  });

  it("highlights comments and triple-quoted strings across lines", () => {
    expect(tokens('# a\n// b\n/* c\nGET x */\n{"q": """\nFROM x\n"""}')).toEqual([
      ["# a", "lineComment"],
      ["// b", "lineComment"],
      ["/* c", "blockComment"],
      ["GET x */", "blockComment"],
      ["{", "brace"],
      ['"q"', "propertyName"],
      [":", "punctuation"],
      ['"""', "string.special"],
      ["FROM x", "string.special"],
      ['"""', "string.special"],
      ["}", "brace"],
    ]);
  });

  it("indents bodies by bracket depth", () => {
    const state = esParser.startState!(2);
    for (const line of ['{"a": {', '  "b": ['])
      for (const stream = new StringStream(line, 2, 2); !stream.eol(); stream.start = stream.pos)
        esParser.token(stream, state);
    const cx = { unit: 2 } as Parameters<NonNullable<typeof esParser.indent>>[2];
    expect(esParser.indent!(state, "", cx)).toBe(6);
    expect(esParser.indent!(state, "]", cx)).toBe(4);
    expect(esParser.indent!(state, "GET x", cx)).toBe(0);
  });

  it("is registered as the Elasticsearch mode of .es files", () => {
    expect(esLanguageDescription.name).toBe("Elasticsearch");
    expect(esLanguageDescription.extensions).toEqual(["es"]);
  });
});

describe("folding", () => {
  const DOC =
    'GET x/_search\n{\n  "query": {\n    "match_all": {}\n  }\n}\n# next\n\nGET _cat/health\nPOST x/_doc\n{"a": 1}';
  const state = EditorState.create({ doc: DOC });
  const fold = (lineNo: number) => {
    const line = state.doc.line(lineNo);
    const r = esFoldRange(state, line.from, line.to);
    return r ? state.sliceDoc(r.from, r.to) : null;
  };

  it("folds a request block to its last content line", () => {
    expect(fold(1)).toBe('\n{\n  "query": {\n    "match_all": {}\n  }\n}');
    expect(fold(9)).toBeNull();
    expect(fold(10)).toBe('\n{"a": 1}');
  });

  it("folds brackets opened on a line", () => {
    expect(fold(2)).toBe('\n  "query": {\n    "match_all": {}\n  }\n');
    expect(fold(3)).toBe('\n    "match_all": {}\n  ');
    expect(fold(4)).toBeNull();
    expect(fold(11)).toBeNull();
  });

  it("is wired as a fold service", () => {
    const withLang = EditorState.create({ doc: DOC, extensions: esLanguageDescription.support! });
    const line = withLang.doc.line(2);
    expect(foldable(withLang, line.from, line.to)).toEqual({ from: line.from + 1, to: DOC.indexOf("}\n# next") });
  });
});
