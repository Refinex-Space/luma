/**
 * Highlighting of `.redis` console files (the `Redis` ui-mode): the command name at the
 * start of a line and a known subcommand as keywords, the command's option words
 * (`EX`, `WITHSCORES`…) as modifiers, quoted strings with their escapes, numbers and
 * `#` comment lines.
 */
import { LanguageDescription, LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language";
import { findCommand, isCommandName, isContainer, isKeyPosition, optionWords, type RedisCommandDoc } from "./commands";

interface State {
  /** Words started on this line so far (their text, unquoted words only). */
  words: string[];
  /** The command of the line, once known. */
  command: RedisCommandDoc | null;
  /** Inside a `"…"` or `'…'` string. */
  quote: '"' | "'" | null;
  /** The next token starts a word (after blanks or at the line start). */
  wordStart: boolean;
}

const NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;

export const redisParser: StreamParser<State> = {
  name: "redis",
  startState: () => ({ words: [], command: null, quote: null, wordStart: true }),
  copyState: (s) => ({ ...s, words: [...s.words] }),
  token(stream, state) {
    if (stream.sol()) {
      state.words = [];
      state.command = null;
      state.quote = null;
      state.wordStart = true;
    }
    if (state.quote) {
      const q = state.quote;
      if (q === '"' && stream.match(/^\\(x[0-9a-fA-F]{2}|.)/)) return "escape";
      if (q === "'" && stream.match("\\'")) return "escape";
      if (stream.eat(q)) {
        state.quote = null;
        return "string";
      }
      if (!stream.match(q === '"' ? /^[^"\\]+/ : /^[^'\\]+/)) stream.next();
      return "string";
    }
    if (stream.eatSpace()) {
      state.wordStart = true;
      return null;
    }
    const starts = state.wordStart;
    state.wordStart = false;
    if (starts && !state.words.length && stream.peek() === "#") {
      stream.skipToEnd();
      return "comment";
    }
    const c = stream.peek();
    if (c === '"' || c === "'") {
      stream.next();
      state.quote = c;
      if (starts) state.words.push("");
      return "string";
    }
    stream.match(/^[^\s"']+/);
    const word = stream.current();
    if (!starts) return null;
    state.words.push(word);
    const index = state.words.length - 1;
    if (index === 0) {
      state.command = findCommand([word]);
      return isCommandName(word) ? "keyword" : null;
    }
    if (index === 1 && isContainer(state.words[0]!)) {
      const sub = findCommand(state.words);
      if (sub && sub.name.includes(" ")) {
        state.command = sub;
        return "keyword";
      }
    }
    if (NUMBER.test(word)) return "number";
    const cmd = state.command;
    if (cmd && optionWords(cmd).includes(word.toUpperCase()) && !isKeyPosition(cmd, state.words, index))
      return "modifier";
    return null;
  },
  languageData: { commentTokens: { line: "#" } },
};

export const redisLanguage = StreamLanguage.define(redisParser);

/** The `Redis` mode of `languages/redis.toml`, for `registerLanguageMode`. */
export const redisLanguageDescription = LanguageDescription.of({
  name: "Redis",
  extensions: ["redis"],
  support: new LanguageSupport(redisLanguage),
});
