/**
 * Completion in Redis consoles: command names (synopsis beside, summary as
 * documentation, inserted upper case), subcommands of containers (`CONFIG GET`), the
 * command's option words and key names at key positions (`SCAN … MATCH prefix*`).
 */
import {
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { call, commands, type RedisBytes, type RedisKeyEntry } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { bytesLabel, kindMeta, type RedisTarget } from "../model";
import {
  REDIS_COMMANDS,
  findCommand,
  isContainer,
  isKeyPosition,
  optionWords,
  subcommandsOf,
  type RedisCommandDoc,
} from "./commands";
import { splitLine } from "./parse";
import { quoted } from "./reply";

/** Where the caret is in a command line. */
export interface ArgumentContext {
  /** Words before the one being typed (their text). */
  words: string[];
  /** argv index of the word being typed (0: the command name). */
  index: number;
  /** What is typed of it, and where it starts. */
  prefix: string;
  from: number;
}

/**
 * The argument at `pos` of a line starting at `lineFrom` (`textBefore`: the line up to
 * `pos`); null in comments, quoted words and unbalanced quotes.
 */
export function argumentAt(textBefore: string, lineFrom: number): ArgumentContext | null {
  if (/^\s*#/.test(textBefore)) return null;
  const { words, error } = splitLine(textBefore, lineFrom);
  if (error) return null;
  const pos = lineFrom + textBefore.length;
  const last = words.at(-1);
  if (!last || last.to < pos)
    return { words: words.map((w) => w.value.text), index: words.length, prefix: "", from: pos };
  if (last.quoted) return null;
  return {
    words: words.slice(0, -1).map((w) => w.value.text),
    index: words.length - 1,
    prefix: textBefore.slice(last.from - lineFrom),
    from: last.from,
  };
}

/** A key as a command line word: bare when it can be, else quoted (binary keys as `\xHH`). */
export function argText(b: RedisBytes): string {
  if (!b.binary && b.text && !/[\s"'\\]/.test(b.text)) return b.text;
  return quoted(b);
}

/** A glob matching the keys starting with `prefix` (its `* ? [ ] \` escaped). */
export const keyPattern = (prefix: string) => `${prefix.replace(/[*?[\]\\]/g, "\\$&")}*`;

function docNode(doc: RedisCommandDoc): Node {
  const pre = document.createElement("pre");
  pre.className = "cm-luma-db-doc";
  const since = doc.since;
  pre.textContent = [
    `${doc.name}${doc.args ? ` ${doc.args}` : ""}`,
    "",
    doc.summary,
    "",
    `${tx("Group")}: ${doc.group}    ${tx("Since")}: ${since}`,
  ].join("\n");
  return pre;
}

interface RichCompletion extends Completion {
  icon?: string | null;
  typeText?: string;
}

/** Inserts a command name (upper case), and the blank before its arguments. */
function applyName(name: string, args: string) {
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    const blank = args && view.state.sliceDoc(to, to + 1) !== " " ? " " : "";
    const insert = name + blank;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
      userEvent: "input.complete",
      annotations: pickedCompletion.of(completion),
      scrollIntoView: true,
    });
  };
}

const commandOption = (doc: RedisCommandDoc, label = doc.name): RichCompletion => ({
  label,
  detail: doc.args,
  typeText: doc.group,
  icon: null,
  type: "keyword",
  info: () => docNode(doc),
  apply: applyName(label, doc.args),
});

/** Command names at the start of a line (subcommands by their full name, `CONFIG GET`). */
export function commandCompletions(): RichCompletion[] {
  return REDIS_COMMANDS.filter((c) => !c.listens).map((c) => commandOption(c));
}

/** Subcommands of container `name` (`GET`, `SET`… of `CONFIG`). */
export function subcommandCompletions(name: string): RichCompletion[] {
  return subcommandsOf(name).map((c) => commandOption(c, c.name.slice(c.name.indexOf(" ") + 1)));
}

/** What completes at argument `index` of a line with `words`: keys, options, or nothing. */
export function argumentKind(words: readonly string[], index: number): { doc: RedisCommandDoc; keys: boolean } | null {
  const doc = findCommand(words);
  if (!doc) return null;
  return { doc, keys: isKeyPosition(doc, words, index) };
}

// ---- key names ---------------------------------------------------------------------

const KEY_LIMIT = 100;
const KEY_TTL_MS = 5000;
const DEBOUNCE_MS = 120;

interface KeyLookup {
  at: number;
  keys: Promise<{ keys: RedisKeyEntry[]; complete: boolean }>;
}

const keyCache = new Map<string, KeyLookup>();

/** Keys of `target` starting with `prefix` (cached a few seconds per prefix). */
export function keysStartingWith(target: RedisTarget, prefix: string) {
  const id = `${target}\u0000${prefix}`;
  const hit = keyCache.get(id);
  if (hit && Date.now() - hit.at < KEY_TTL_MS) return hit.keys;
  const keys = call(commands.redisScan(target, keyPattern(prefix), null, "0", KEY_LIMIT))
    .then((page) => ({ keys: page.keys, complete: page.done && page.keys.length < KEY_LIMIT }))
    .catch(() => ({ keys: [], complete: false }));
  keyCache.set(id, { at: Date.now(), keys });
  if (keyCache.size > 200) keyCache.delete(keyCache.keys().next().value!);
  return keys;
}

/** Forgets the cached keys of `target` (after commands that may have changed them). */
export function forgetKeys(target: RedisTarget) {
  for (const k of [...keyCache.keys()]) if (k.startsWith(`${target}\u0000`)) keyCache.delete(k);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const NAME = /^[\w.-]*$/;
const KEY = /^[^\s"']*$/;

/** The completion source of a Redis console bound through `targetOf`. */
export function redisCompletionSource(targetOf: () => RedisTarget | null) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const arg = argumentAt(line.text.slice(0, ctx.pos - line.from), line.from);
    if (!arg) return null;
    if (!ctx.explicit && !arg.prefix) return null;
    if (arg.index === 0) return { from: arg.from, options: commandCompletions(), validFor: NAME };
    if (arg.index === 1 && isContainer(arg.words[0]!)) {
      const options = subcommandCompletions(arg.words[0]!);
      if (options.length) return { from: arg.from, options, validFor: NAME };
    }
    const kind = argumentKind(arg.words, arg.index);
    if (!kind) return null;
    if (!kind.keys) {
      const options = optionWords(kind.doc).map((w): RichCompletion => ({
        label: w,
        type: "keyword",
        icon: null,
        boost: -1,
      }));
      return options.length ? { from: arg.from, options, validFor: NAME } : null;
    }
    const target = targetOf();
    if (!target) return null;
    await sleep(DEBOUNCE_MS);
    if (ctx.aborted) return null;
    const { keys, complete } = await keysStartingWith(target, arg.prefix);
    if (ctx.aborted || !keys.length) return null;
    return {
      from: arg.from,
      options: keys.map((k): RichCompletion => ({
        label: bytesLabel(k.key),
        apply: argText(k.key),
        typeText: kindMeta(k.kind).label,
        icon: "db-key",
        type: "variable",
      })),
      // A complete listing narrows locally; a partial one asks again as the prefix grows.
      validFor: complete ? KEY : undefined,
    };
  };
}
