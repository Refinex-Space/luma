/**
 * Highlighting of `.env` files (the `DotEnv` ui-mode), coloured like the JetBrains plugin:
 * keys as keywords, values as strings, comments and the `export` prefix as line comments,
 * `=` / `:` as operators. Nested `${NAME}` in double-quoted values shows the name as a key.
 */
import {
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
  type StreamParser,
  type StringStream,
} from "@codemirror/language";
import { lexToken, lineBreak, type LexState, type TokenType } from "./syntax";

export const DOTENV_MODE = "DotEnv";
export const DOTENV_LANGUAGE = "dotenv";

const STYLE: Record<TokenType, string | null> = {
  comment: "comment",
  export: "comment",
  key: "keyword",
  separator: "operator",
  value: "string",
  quote: "string",
  nestedStart: "string",
  nestedKey: "keyword",
  nestedEnd: "string",
  space: null,
  bad: "invalid",
};

interface State {
  lex: LexState;
}

export const dotenvParser: StreamParser<State> = {
  name: "dotenv",
  startState: () => ({ lex: "initial" }),
  copyState: (s) => ({ ...s }),
  token(stream: StringStream, state: State) {
    if (stream.sol() && stream.pos === 0) state.lex = lineBreak(state.lex);
    const t = lexToken(state.lex, stream.string, stream.pos);
    stream.pos = Math.max(t.end, stream.pos + 1);
    state.lex = t.state;
    return STYLE[t.type];
  },
  blankLine(state: State) {
    state.lex = lineBreak(state.lex);
  },
  languageData: { commentTokens: { line: "#" } },
};

export const dotenvLanguage = StreamLanguage.define(dotenvParser);

export const dotenvLanguageDescription = LanguageDescription.of({
  name: DOTENV_MODE,
  extensions: ["env"],
  filename: /^(?:\.env(?:\..+)?|\.flaskenv)$/,
  support: new LanguageSupport(dotenvLanguage),
});
