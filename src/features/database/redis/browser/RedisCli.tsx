/**
 * The Redis Browser's command line, `redis-cli` in a pane: a prompt with highlighting,
 * command / key completion and the command's argument hint; replies printed as
 * `redis-cli` prints them. Enter runs (a completion list open or not), Tab accepts a
 * completion (or inserts the selected key), ↑ / ↓ move in the list or the history, ⌃L
 * clears, Esc closes the list or cancels a running command. It runs on the console connection of its
 * database (`redis_execute`), `SELECT n` moves it; writes refresh the key list and the
 * value shown.
 */
import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionStatus,
  moveCompletionSelection,
  startCompletion,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  tooltips,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import clsx from "clsx";
import { lumaHighlightStyle } from "@/editor/core/cm/highlight";
import { kindBadge, typeColumn } from "@/editor/lsp/completion";
import { lspTheme } from "@/editor/lsp/theme";
import { call, commands, isCancelled, nextRequestId, type RequestId } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { Icon, IconButton, Spinner, T } from "@/ui";
import { sourceById, withConnection } from "../../store";
import { redisTarget, splitRedisTarget, type RedisTarget } from "../model";
import { keyChanged, useRedis } from "../store";
import { findCommand, nameWords } from "../console/commands";
import { argText, forgetKeys, redisCompletionSource } from "../console/completion";
import { redisParser } from "../console/language";
import { splitLine } from "../console/parse";
import { cliText } from "../console/reply";
import { MAX_ENTRIES, bumpReload, cliSession, pushHistory, updateCli, useBrowserUi, type CliEntry } from "./state";
import css from "./RedisBrowser.module.css";

export interface RedisCliHandle {
  /** Inserts `text` at the caret (spaced from the word before) and focuses the prompt. */
  insert(text: string): void;
  focus(): void;
}

/** Lines of one reply shown at most (the rest is counted). */
const MAX_LINES = 500;
let entrySeq = 0;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function promptOf(target: RedisTarget): string {
  const { id, db } = splitRedisTarget(target);
  return `${sourceById(id)?.name ?? id}:db${db}`;
}

/** `redis-cli`'s hint: the argument synopsis after a command name typed in full. */
class HintWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: HintWidget) {
    return other.text === this.text;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = css.hint!;
    span.textContent = this.text;
    return span;
  }
}

function hintAt(state: EditorState): DecorationSet {
  const text = state.doc.toString();
  const head = state.selection.main.head;
  if (head !== text.length || !text.trim()) return Decoration.none;
  const { words } = splitLine(text);
  const doc = findCommand(words.map((w) => w.value.text));
  if (!doc?.args || words.length !== nameWords(doc)) return Decoration.none;
  const hint = (/\s$/.test(text) ? "" : " ") + doc.args;
  return Decoration.set([Decoration.widget({ widget: new HintWidget(hint), side: 1 }).range(text.length)]);
}

const hints = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = hintAt(view.state);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet) this.decorations = hintAt(u.state);
    }
  },
  { decorations: (v) => v.decorations },
);

const cliTheme = EditorView.theme({
  "&": { flex: "1", minWidth: "0", backgroundColor: "transparent", color: "var(--fg-strong)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--luma-editor-font, var(--font-mono))", lineHeight: "20px", overflow: "hidden" },
  ".cm-content": { padding: "0", caretColor: "var(--caret)" },
  ".cm-line": { padding: "0" },
  ".cm-cursor": { borderLeftColor: "var(--caret)" },
});

export interface RedisCliProps {
  /** The Browser's database: where the command line starts and whose views it refreshes. */
  browser: RedisTarget;
  open: boolean;
  onToggle: () => void;
  handleRef?: Ref<RedisCliHandle>;
}

export function RedisCli({ browser, open, onToggle, handleRef }: RedisCliProps) {
  const session = useBrowserUi((s) => s.cli[browser]) ?? cliSession(browser);
  const prompt = promptOf(session.target);
  const [running, setRunning] = useState<RequestId | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const out = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Read by the editor's handlers, which outlive renders.
  const live = useRef({ browser, running, historyAt: -1, draft: "" });
  useLayoutEffect(() => {
    live.current.browser = browser;
    live.current.running = running;
  });

  const clear = () => updateCli(browser, (s) => ({ ...s, entries: [] }));
  const cancel = () => {
    const r = live.current.running;
    if (r) void commands.cancelRequest(r);
  };

  const run = async (line: string) => {
    const b = live.current.browser;
    const text = line.trim();
    if (!text || live.current.running) return;
    live.current.historyAt = -1;
    const on = cliSession(b).target;
    const id = ++entrySeq;
    const entry: CliEntry = { id, prompt: promptOf(on), text, reply: null, error: null, ms: null };
    const finish = (p: Partial<CliEntry>) =>
      updateCli(b, (s) => ({ ...s, entries: s.entries.map((x) => (x.id === id ? { ...x, ...p } : x)) }));
    updateCli(b, (s) => ({
      ...s,
      history: pushHistory(s.history, text),
      entries: [...s.entries, entry].slice(-MAX_ENTRIES),
    }));
    const { words, error } = splitLine(text);
    if (error) return finish({ error: tx`Invalid argument(s): ${error}` });
    if (!words.length) return;
    const request = nextRequestId();
    live.current.running = request;
    setRunning(request);
    try {
      const [o] = await withConnection(on, () =>
        call(commands.redisExecute(request, on, [{ from: 0, to: text.length, args: words.map((w) => w.value) }])),
      );
      if (!o) return finish({ error: tx("No reply") });
      finish({ text: o.text, reply: o.reply, error: o.error, ms: o.elapsedMs });
      if (o.select !== null && o.select !== undefined) {
        const next = redisTarget(splitRedisTarget(on).id, o.select);
        updateCli(b, (s) => ({ ...s, target: next }));
      }
      if (o.writes && !o.error) {
        forgetKeys(on);
        keyChanged(on);
        if (on === b) bumpReload(b);
      }
    } catch (e) {
      finish({ error: isCancelled(e) ? tx("Cancelled") : errorText(e) });
    } finally {
      live.current.running = null;
      setRunning(null);
    }
  };
  const runRef = useRef(run);
  useLayoutEffect(() => {
    runRef.current = run;
  });

  // The prompt's editor, created once per pane.
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const setDoc = (v: EditorView, text: string) =>
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, selection: { anchor: text.length } });
    const browse = (v: EditorView, dir: 1 | -1) => {
      const past = cliSession(live.current.browser).history;
      const at = live.current.historyAt;
      if (at === -1) live.current.draft = v.state.doc.toString();
      const next = Math.max(-1, Math.min(past.length - 1, at + dir));
      if (next === at) return true;
      live.current.historyAt = next;
      setDoc(v, next === -1 ? live.current.draft : past[next]!);
      return true;
    };
    const completing = (v: EditorView) => completionStatus(v.state) === "active";
    const keys = keymap.of([
      {
        key: "Enter",
        run: (v) => {
          closeCompletion(v);
          const line = v.state.doc.toString();
          if (!line.trim() || live.current.running) return true;
          setDoc(v, "");
          void runRef.current(line);
          return true;
        },
      },
      { key: "ArrowUp", run: (v) => (completing(v) ? moveCompletionSelection(false)(v) : browse(v, 1)) },
      { key: "ArrowDown", run: (v) => (completing(v) ? moveCompletionSelection(true)(v) : browse(v, -1)) },
      { key: "Ctrl-Space", run: startCompletion },
      {
        key: "Tab",
        run: (v) => {
          if (completing(v)) return acceptCompletion(v);
          const text = v.state.doc.toString();
          const key = useRedis.getState().browserKey[live.current.browser];
          // An empty argument after a command: the key the Browser shows.
          if (key && /\S\s$/.test(text) && v.state.selection.main.head === text.length) {
            v.dispatch(v.state.replaceSelection(argText(key)));
            return true;
          }
          return startCompletion(v);
        },
      },
      {
        key: "Ctrl-l",
        run: () => {
          updateCli(live.current.browser, (s) => ({ ...s, entries: [] }));
          return true;
        },
      },
      {
        key: "Escape",
        run: (v) => {
          if (completionStatus(v.state) !== null) return closeCompletion(v);
          if (!live.current.running) return false;
          void commands.cancelRequest(live.current.running);
          return true;
        },
      },
      {
        key: "Ctrl-c",
        run: (v) => {
          if (live.current.running) {
            void commands.cancelRequest(live.current.running);
            return true;
          }
          if (!v.state.selection.main.empty) return false;
          setDoc(v, "");
          return true;
        },
      },
    ]);
    const completion = redisCompletionSource(() => cliSession(live.current.browser).target);
    const extensions: Extension[] = [
      keys,
      history(),
      keymap.of([...historyKeymap, ...defaultKeymap]),
      // One line: pasted line breaks become spaces.
      EditorState.transactionFilter.of((tr) => {
        if (!tr.docChanged || tr.newDoc.lines === 1) return tr;
        const text = tr.newDoc.toString().replace(/\r?\n/g, " ");
        return [tr, { changes: { from: 0, to: tr.newDoc.length, insert: text }, sequential: true }];
      }),
      StreamLanguage.define(redisParser),
      syntaxHighlighting(lumaHighlightStyle),
      // The editor's completion list: kind badges, a type column, keywords in bold.
      autocompletion({
        override: [completion],
        icons: false,
        defaultKeymap: false,
        addToOptions: [
          { render: kindBadge, position: 20 },
          { render: typeColumn, position: 90 },
        ],
        optionClass: (c) => (c.type === "keyword" ? "cm-lsp-keyword-option" : ""),
        tooltipClass: () => "cm-lsp-completion",
      }),
      hints,
      // The pane clips (overflow): completion lists and their docs live on the body, above it.
      tooltips({ parent: document.body, position: "fixed" }),
      lspTheme,
      cliTheme,
      EditorView.contentAttributes.of({ "aria-label": tx("Redis command"), spellcheck: "false" }),
    ];
    const v = new EditorView({ parent, state: EditorState.create({ extensions }) });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);

  useImperativeHandle(handleRef, () => ({
    insert: (text: string) => {
      const v = view.current;
      if (!v) return;
      const head = v.state.selection.main.head;
      const before = v.state.doc.sliceString(Math.max(0, head - 1), head);
      v.dispatch(v.state.replaceSelection(before && !/\s/.test(before) ? ` ${text}` : text));
      v.focus();
    },
    focus: () => view.current?.focus(),
  }));

  // Follow the output; refocus the prompt when a command ends.
  const entries = session.entries;
  useLayoutEffect(() => {
    const el = out.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, open]);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running && open) view.current?.focus();
    wasRunning.current = !!running;
  }, [running, open]);

  return (
    <>
      <div
        className={css.cliHead}
        onClick={(e) => {
          if (!open && !(e.target as HTMLElement).closest("button")) onToggle();
        }}
      >
        <button
          type="button"
          className={css.cliChevron}
          aria-expanded={open}
          aria-label={open ? tx("Collapse Command Line") : tx("Expand Command Line")}
          onClick={onToggle}
        >
          <Icon name="chevron-down" size={14} />
        </button>
        <span className={css.cliTitle}>
          <T>Command Line</T>
        </span>
        <span className={css.cliTarget}>{prompt}</span>
        <span className={css.cliSpacer} />
        {running && (
          <>
            <Spinner size={12} />
            <IconButton icon="stop" title="Cancel Running Command" shortcut="Esc" size="small" onClick={cancel} />
          </>
        )}
        <IconButton
          icon="trash"
          title="Clear"
          shortcut="⌃L"
          size="small"
          disabled={!entries.length}
          onClick={() => {
            clear();
            view.current?.focus();
          }}
        />
      </div>
      <div
        ref={out}
        className={css.cliOut}
        inert={!open}
        onMouseUp={() => {
          // A click (not a text selection) puts the caret in the prompt.
          if (!window.getSelection()?.toString()) view.current?.focus();
        }}
      >
        {entries.map((e) => (
          <CliOutput key={e.id} entry={e} pending={!!running && e === entries.at(-1) && e.ms === null && !e.error} />
        ))}
        <div className={css.cliPrompt}>
          <span className={css.promptLabel}>{prompt}&gt;</span>
          <div ref={host} className={css.cliInput} />
        </div>
      </div>
    </>
  );
}

function CliOutput({ entry, pending }: { entry: CliEntry; pending: boolean }) {
  let body: string | null = null;
  let more = 0;
  if (entry.error) body = entry.error.startsWith("(error)") ? entry.error : `(error) ${entry.error}`;
  else if (entry.reply) {
    const lines = cliText(entry.reply).split("\n");
    more = Math.max(0, lines.length - MAX_LINES);
    body = (more ? lines.slice(0, MAX_LINES) : lines).join("\n");
  }
  const ms = entry.ms;
  const count = more.toLocaleString("en");
  return (
    <div className={css.cliEntry}>
      <div className={css.cliEcho}>
        <span className={css.promptLabel}>{entry.prompt}&gt;</span>
        <span className={css.cliCommand}>{entry.text}</span>
        {ms !== null && <span className={css.cliMs}>{ms < 10 ? ms.toFixed(2) : Math.round(ms)} ms</span>}
        {pending && <Spinner size={11} />}
      </div>
      {body !== null && <pre className={clsx(css.cliReply, entry.error && css.cliError)}>{body}</pre>}
      {more > 0 && <div className={css.cliMore}>{tx`… ${count} more lines`}</div>}
    </div>
  );
}
