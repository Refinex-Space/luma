/**
 * Highlighting of `lombok.config` (the `Lombok Config` ui-mode): `#` comment lines, the
 * `clear` / `import` keywords, keys as properties, `=` / `+=` / `-=` as operators, and
 * values — booleans and enum constants as atoms, numbers, paths and other text as strings.
 */
import { LanguageDescription, LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language";
import { configKey } from "./model";

export const LOMBOK_CONFIG_MODE = "Lombok Config";

interface State {
  /** What comes next on the line. */
  at: "start" | "key" | "operator" | "value" | "path";
  key: string;
}

const parser: StreamParser<State> = {
  name: "lombok-config",
  startState: () => ({ at: "start", key: "" }),
  copyState: (s) => ({ ...s }),
  token(stream, state) {
    if (stream.sol()) state.at = "start";
    if (stream.eatSpace()) return null;
    if (state.at === "start") {
      if (stream.peek() === "#") {
        stream.skipToEnd();
        return "comment";
      }
      if (stream.match(/^clear(?=\s)/)) {
        state.at = "key";
        return "keyword";
      }
      if (stream.match(/^import(?=\s)/)) {
        state.at = "path";
        return "keyword";
      }
    }
    switch (state.at) {
      case "start":
      case "key":
        // A key starts the line, or follows `clear`.
        if (!stream.match(/^[^\s=+-]+/)) stream.next();
        state.key = stream.current();
        state.at = state.at === "key" ? "value" : "operator";
        return "propertyName";
      case "operator":
        if (stream.match(/^[+-]?=/)) {
          state.at = "value";
          return "operator";
        }
        stream.skipToEnd();
        return "invalid";
      case "path":
        stream.skipToEnd();
        return "string";
      case "value": {
        stream.skipToEnd();
        const value = stream.current().trim();
        const key = configKey(state.key);
        if (/^(true|false)$/i.test(value)) return "bool";
        if (key?.values?.some((v) => v.toLowerCase() === value.toLowerCase())) return "atom";
        if (/^-?\d+(\.\d+)?$/.test(value)) return "number";
        return "string";
      }
    }
  },
  languageData: { commentTokens: { line: "#" } },
};

export const lombokConfigLanguage = StreamLanguage.define(parser);

/** The `Lombok Config` mode of `languages/lombok-config.toml`, for `registerLanguageMode`. */
export const lombokConfigLanguageDescription = LanguageDescription.of({
  name: LOMBOK_CONFIG_MODE,
  filename: /^lombok\.config$/,
  support: new LanguageSupport(lombokConfigLanguage),
});
