/**
 * `redis-cli` command lines (its `sdssplitargs`): one command per line, words separated
 * by blanks, `"…"` with C-like escapes (`\n \r \t \b \a \\ \" \xHH`), `'…'` with only
 * `\'`, quotes starting mid-word (`a"b c"` is `ab c`), `#` comment lines. Offsets are
 * UTF-16 positions of the console text (CodeMirror's).
 */
import type { RedisBytes } from "@/platform/ipc";

/** A word of a line: its bytes as the server gets them, and where it is. */
export interface RedisWord {
  value: RedisBytes;
  from: number;
  to: number;
  /** Starts with a quote (completion leaves it alone). */
  quoted: boolean;
}

export interface RedisCommandLine {
  /** First and past-the-last character of the words (blanks trimmed). */
  from: number;
  to: number;
  /** The whole line. */
  lineFrom: number;
  lineTo: number;
  words: RedisWord[];
  /** Unbalanced quotes: `redis-cli`'s "Invalid argument(s)". */
  error: string | null;
}

const BLANK = /[ \t\r\n\f\v]/;
const ESCAPES: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, a: 7 };
const encoder = new TextEncoder();
const strict = new TextDecoder("utf-8", { fatal: true });

const hex = (bytes: readonly number[]) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");

/** Bytes as `RedisBytes`: text when they are UTF-8, else lowercase hex. */
export function bytesOf(bytes: readonly number[]): RedisBytes {
  try {
    return { text: strict.decode(new Uint8Array(bytes)), binary: false };
  } catch {
    return { text: hex(bytes), binary: true };
  }
}

/** One line's words from `offset` (the line's start in the text). */
export function splitLine(line: string, offset = 0): { words: RedisWord[]; error: string | null } {
  const words: RedisWord[] = [];
  let i = 0;
  const n = line.length;
  for (;;) {
    while (i < n && BLANK.test(line[i]!)) i++;
    if (i >= n) return { words, error: null };
    const start = i;
    const bytes: number[] = [];
    // Plain characters are UTF-8 encoded; `\xHH` escapes add raw bytes.
    const push = (s: string) => {
      for (const b of encoder.encode(s)) bytes.push(b);
    };
    let inDouble = false;
    let inSingle = false;
    let done = false;
    while (!done) {
      if (inDouble) {
        if (i >= n) return { words, error: "Unbalanced quotes" };
        const c = line[i]!;
        if (c === "\\" && line[i + 1] === "x" && /^[0-9a-fA-F]{2}$/.test(line.slice(i + 2, i + 4))) {
          bytes.push(parseInt(line.slice(i + 2, i + 4), 16));
          i += 4;
          continue;
        }
        if (c === "\\" && i + 1 < n) {
          const e = line[i + 1]!;
          if (e in ESCAPES) bytes.push(ESCAPES[e]!);
          else push(e);
          i += 2;
          continue;
        }
        if (c === '"') {
          // The closing quote must end the word.
          if (i + 1 < n && !BLANK.test(line[i + 1]!)) return { words, error: "Unbalanced quotes" };
          i++;
          done = true;
          continue;
        }
        const cp = line.codePointAt(i)!;
        const ch = String.fromCodePoint(cp);
        push(ch);
        i += ch.length;
      } else if (inSingle) {
        if (i >= n) return { words, error: "Unbalanced quotes" };
        const c = line[i]!;
        if (c === "\\" && line[i + 1] === "'") {
          bytes.push(39);
          i += 2;
          continue;
        }
        if (c === "'") {
          if (i + 1 < n && !BLANK.test(line[i + 1]!)) return { words, error: "Unbalanced quotes" };
          i++;
          done = true;
          continue;
        }
        const ch = String.fromCodePoint(line.codePointAt(i)!);
        push(ch);
        i += ch.length;
      } else {
        if (i >= n || BLANK.test(line[i]!)) {
          done = true;
          continue;
        }
        const c = line[i]!;
        if (c === '"') inDouble = true;
        else if (c === "'") inSingle = true;
        else {
          const ch = String.fromCodePoint(line.codePointAt(i)!);
          push(ch);
          i += ch.length - 1;
        }
        i++;
      }
    }
    words.push({
      value: bytesOf(bytes),
      from: offset + start,
      to: offset + i,
      quoted: line[start] === '"' || line[start] === "'",
    });
  }
}

const isComment = (line: string) => /^\s*#/.test(line);

/** Every command line of `text` (blank and comment lines skipped). */
export function parseCommands(text: string): RedisCommandLine[] {
  const out: RedisCommandLine[] = [];
  let at = 0;
  for (const line of text.split("\n")) {
    const lineFrom = at;
    const lineTo = at + line.length;
    at = lineTo + 1;
    if (!line.trim() || isComment(line)) continue;
    const { words, error } = splitLine(line, lineFrom);
    const lead = line.length - line.trimStart().length;
    const trail = line.trimEnd().length;
    out.push({ from: lineFrom + lead, to: lineFrom + trail, lineFrom, lineTo, words, error });
  }
  return out;
}

/** The command on the line at `pos`, else on the line just above (after typing ↵). */
export function commandAt(text: string, pos: number): RedisCommandLine | null {
  const all = parseCommands(text);
  const here = all.find((c) => c.lineFrom <= pos && pos <= c.lineTo);
  if (here) return here;
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const lineEnd = text.indexOf("\n", pos);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  if (line.trim() || lineStart === 0) return null;
  return all.find((c) => c.lineTo === lineStart - 1) ?? null;
}

/** The commands to run: the selection's (every command it touches), else the one at the caret. */
export function commandsIn(text: string, from: number, to: number): RedisCommandLine[] {
  if (from === to) {
    const c = commandAt(text, from);
    return c ? [c] : [];
  }
  // A selection merely touching a line's edge (its line break, its indent) leaves it out.
  return parseCommands(text).filter((c) => c.from < to && c.to > from);
}

/** The words of a command line as text (binary words: their hex). */
export const wordTexts = (c: Pick<RedisCommandLine, "words">) => c.words.map((w) => w.value.text);
