import { describe, expect, it } from "vitest";
import { commandAt, commandsIn, parseCommands, splitLine, wordTexts } from "./parse";

const texts = (line: string) => splitLine(line).words.map((w) => w.value);

describe("splitLine", () => {
  it("splits words on blanks", () => {
    expect(texts("  SET   user:1\tjohn ").map((w) => w.text)).toEqual(["SET", "user:1", "john"]);
    expect(splitLine("GET k").words.map((w) => [w.from, w.to])).toEqual([
      [0, 3],
      [4, 5],
    ]);
  });

  it("reads double quotes with redis-cli escapes", () => {
    expect(texts('SET k "a b\\n\\r\\t\\b\\a\\\\\\"c"')[2]).toEqual({ text: 'a b\n\r\t\b\u0007\\"c', binary: false });
    // An unknown escape is the character itself.
    expect(texts('ECHO "\\q"')[1]!.text).toBe("q");
  });

  it("reads single quotes with only the quote escape", () => {
    expect(texts("SET k 'it\\'s \\n'")[2]!.text).toBe("it's \\n");
  });

  it("decodes \\xHH escapes as bytes, text when they are UTF-8", () => {
    expect(texts('SET "\\xe4\\xbd\\xa0" v')[1]).toEqual({ text: "你", binary: false });
    expect(texts('SET "\\xff\\x00a" v')[1]).toEqual({ text: "ff0061", binary: true });
    // `\x` without two hex digits is a plain `x`.
    expect(texts('ECHO "\\x4"')[1]!.text).toBe("x4");
  });

  it("keeps Unicode outside escapes as UTF-8 text", () => {
    expect(texts("SET 键 值")[1]).toEqual({ text: "键", binary: false });
  });

  it("joins a quote starting mid-word, like sdssplitargs", () => {
    expect(texts('SET a"b c" v').map((w) => w.text)).toEqual(["SET", "ab c", "v"]);
  });

  it("reports unbalanced quotes", () => {
    expect(splitLine('SET k "abc').error).toBe("Unbalanced quotes");
    expect(splitLine("SET k 'abc").error).toBe("Unbalanced quotes");
    // A closing quote must end the word.
    expect(splitLine('SET k "a"b').error).toBe("Unbalanced quotes");
  });

  it("allows empty quoted words", () => {
    expect(texts('SET k ""').map((w) => w.text)).toEqual(["SET", "k", ""]);
  });

  it("marks quoted words", () => {
    expect(splitLine('GET "k" k').words.map((w) => w.quoted)).toEqual([false, true, false]);
  });
});

const DOC = ["# users", "SET user:1 john", "", "  GET user:1  ", "# the end", 'HSET h f "v 1"'].join("\n");

describe("parseCommands", () => {
  it("skips comments and blank lines, with trimmed ranges", () => {
    const all = parseCommands(DOC);
    expect(all.map(wordTexts)).toEqual([
      ["SET", "user:1", "john"],
      ["GET", "user:1"],
      ["HSET", "h", "f", "v 1"],
    ]);
    const get = all[1]!;
    expect(DOC.slice(get.from, get.to)).toBe("GET user:1");
    expect(DOC.slice(get.lineFrom, get.lineTo)).toBe("  GET user:1  ");
  });
});

describe("commandAt / commandsIn", () => {
  const at = (needle: string, delta = 0) => DOC.indexOf(needle) + delta;

  it("takes the command on the caret's line", () => {
    expect(wordTexts(commandAt(DOC, at("john"))!)).toEqual(["SET", "user:1", "john"]);
    // Anywhere on the line, its indent too.
    expect(wordTexts(commandAt(DOC, at("  GET"))!)[0]).toBe("GET");
  });

  it("takes the command just above a blank line the caret is on", () => {
    expect(wordTexts(commandAt(DOC, at("\n\n", 1))!)[0]).toBe("SET");
    expect(commandAt(DOC, at("# users"))).toBeNull();
    expect(commandAt("PING\n\n\n", 6)).toBeNull();
  });

  it("takes every command a selection touches", () => {
    const from = at("john");
    const to = at("GET") + 1;
    expect(commandsIn(DOC, from, to).map((c) => wordTexts(c)[0])).toEqual(["SET", "GET"]);
    expect(commandsIn(DOC, 0, DOC.length)).toHaveLength(3);
  });

  it("leaves out a line the selection merely starts or ends at", () => {
    // From the end of the SET line to the start of the GET line.
    const from = at("john") + 4;
    const to = at("  GET");
    expect(commandsIn(DOC, from, to)).toEqual([]);
  });

  it("is empty on comments", () => {
    expect(commandsIn(DOC, 2, 2)).toEqual([]);
  });
});
