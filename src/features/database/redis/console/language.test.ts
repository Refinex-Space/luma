import { StringStream } from "@codemirror/language";
import { expect, it } from "vitest";
import { redisParser } from "./language";

/** `[text, style]` of each token of `line`. */
function tokens(line: string): Array<[string, string | null]> {
  const state = redisParser.startState!(2);
  const stream = new StringStream(line, 2, 2);
  const out: Array<[string, string | null]> = [];
  while (!stream.eol()) {
    const style = redisParser.token(stream, state);
    const text = stream.current();
    if (text.trim()) out.push([text, style]);
    stream.start = stream.pos;
  }
  return out;
}

it("highlights the command, its subcommand and options", () => {
  expect(tokens("set user:1 10 EX 60 nx")).toEqual([
    ["set", "keyword"],
    ["user:1", null],
    ["10", "number"],
    ["EX", "modifier"],
    ["60", "number"],
    ["nx", "modifier"],
  ]);
  expect(tokens("CONFIG GET maxmemory").map((t) => t[1])).toEqual(["keyword", "keyword", null]);
  // A key named like an option stays a key.
  expect(tokens("GET ex")).toEqual([
    ["GET", "keyword"],
    ["ex", null],
  ]);
  expect(tokens("FROB x")[0]).toEqual(["FROB", null]);
});

it("highlights strings, escapes and comments", () => {
  expect(tokens('SET k "a\\x41"')).toEqual([
    ["SET", "keyword"],
    ["k", null],
    ['"', "string"],
    ["a", "string"],
    ["\\x41", "escape"],
    ['"', "string"],
  ]);
  expect(tokens("  # note")).toEqual([["# note", "comment"]]);
});
