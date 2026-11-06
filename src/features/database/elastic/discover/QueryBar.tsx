/**
 * Discover's query bar: one line of KQL (or Lucene), coloured as it is typed, the range a
 * KQL error starts at underlined (the error in its tooltip), completion of field names,
 * operators, `and` / `or` and — after `field:` — the field's most common values. ↵ runs,
 * ⎋ clears; ↓ / ↑ pick a suggestion, ↵ / ⇥ take it; ⌃Space asks for suggestions.
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type UIEvent,
} from "react";
import clsx from "clsx";
import type { EsField } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { HighlightedText, Icon, Popup } from "@/ui";
import {
  kqlCompletions,
  kqlToDsl,
  kqlTokens,
  luceneCompletions,
  luceneTokens,
  type KqlOption,
  type KqlTokenKind,
} from "../kql";
import { FieldIcon } from "./FieldIcon";
import type { QueryLang } from "./search";
import { suggestValues } from "./state";
import css from "./Discover.module.css";

export interface QueryBarHandle {
  focus: () => void;
}

export interface QueryBarProps {
  tabKey: string;
  value: string;
  lang: QueryLang;
  fields: readonly EsField[];
  onChange: (text: string) => void;
  onLangChange: (lang: QueryLang) => void;
  onSubmit: (text: string) => void;
  /** ⎋ on an empty bar (the tab may want focus back). */
  onClear: () => void;
}

const TOKEN_CLASS: Record<KqlTokenKind, string | undefined> = {
  field: css.tkField,
  operator: css.tkOp,
  range: css.tkOp,
  keyword: css.tkKeyword,
  value: css.tkValue,
  string: css.tkString,
  paren: css.tkOp,
  error: css.tkError,
};

interface Suggest {
  from: number;
  to: number;
  options: Array<KqlOption & { field?: EsField }>;
}

const MAX_OPTIONS = 12;

/** Options matching what is typed: prefix matches first, then substring ones. */
function rank(options: readonly KqlOption[], typed: string): KqlOption[] {
  const t = typed.replace(/^"/, "").toLowerCase();
  if (!t) return [...options];
  const scored = options
    .map((o) => {
      const l = o.label.toLowerCase();
      const at = l.indexOf(t);
      return { o, s: l === t ? -1 : at === 0 ? 0 : at > 0 ? 1 : 9 };
    })
    .filter((x) => x.s < 9);
  return scored
    .sort((a, b) => a.s - b.s || (b.o.boost ?? 0) - (a.o.boost ?? 0) || a.o.label.length - b.o.label.length)
    .map((x) => x.o);
}

const quoteValue = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

let canvas: HTMLCanvasElement | null = null;
function textWidth(text: string, font: string): number {
  canvas ??= document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return text.length * 7.8;
  ctx.font = font;
  return ctx.measureText(text).width;
}

export const QueryBar = forwardRef<QueryBarHandle, QueryBarProps>(function QueryBar(props, ref) {
  const { tabKey, value, lang, fields, onChange } = props;
  const input = useRef<HTMLInputElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const [suggest, setSuggest] = useState<Suggest | null>(null);
  const [active, setActive] = useState(-1);
  const [anchorX, setAnchorX] = useState(0);
  const seq = useRef(0);
  // Where the suggestions open: under the start of the word completed.
  const caretAnchor = useMemo(() => ({ getBoundingClientRect: () => caretRect(input.current, anchorX) }), [anchorX]);
  useImperativeHandle(ref, () => ({
    focus: () => {
      input.current?.focus();
      input.current?.select();
    },
  }));

  const byName = useMemo(() => new Map(fields.map((f) => [f.name, f])), [fields]);
  const tokens = useMemo(() => (lang === "kql" ? kqlTokens(value) : luceneTokens(value)), [value, lang]);
  const [focused, setFocused] = useState(false);
  const error = useMemo(() => {
    if (lang !== "kql" || !value.trim()) return null;
    const r = kqlToDsl(value, fields);
    return r.ok ? null : r;
  }, [value, lang, fields]);
  // A query cut short at the end is one being typed: marked once the bar is left.
  const invalid = error && !(focused && error.to >= value.trimEnd().length) ? error : null;

  const syncScroll = () => {
    if (overlay.current && input.current)
      overlay.current.style.transform = `translateX(${-input.current.scrollLeft}px)`;
  };
  useEffect(syncScroll);

  const close = () => {
    seq.current++;
    setSuggest(null);
    setActive(-1);
  };

  const complete = (text: string, pos: number) => {
    const n = ++seq.current;
    const c = lang === "kql" ? kqlCompletions(text, pos, fields) : luceneCompletions(text, pos, fields);
    const typed = text.slice(c.from, pos);
    const show = (options: KqlOption[]) => {
      if (n !== seq.current) return;
      const ranked = rank(options, typed)
        .filter((o) => o.label !== typed || options.length > 1)
        .slice(0, MAX_OPTIONS)
        .map((o) => ({ ...o, field: o.type === "property" ? byName.get(o.label) : undefined }));
      if (!ranked.length || (ranked.length === 1 && ranked[0]!.label === typed)) {
        setSuggest(null);
        return;
      }
      const el = input.current;
      if (el) {
        const style = getComputedStyle(el);
        const x = textWidth(text.slice(0, c.from), style.font) + parseFloat(style.paddingLeft) - el.scrollLeft;
        setAnchorX(Math.max(0, Math.min(x, el.clientWidth - 40)));
      }
      setSuggest({ from: c.from, to: pos, options: ranked });
      setActive((a) => (a >= ranked.length ? -1 : a));
    };
    show(c.options);
    if (c.field) {
      void suggestValues(tabKey, c.field).then(
        (values) =>
          show([
            ...c.options,
            ...values.map((v): KqlOption => ({ label: v, apply: `${quoteValue(v)} `, type: "text", icon: null })),
          ]),
        () => {},
      );
    }
  };

  const accept = (o: KqlOption) => {
    if (!suggest) return;
    const apply = typeof o.apply === "string" ? o.apply : o.label;
    // `level ` + `: ` reads `level: ` (a field's completion leaves a space for what follows).
    const head =
      o.type === "operator" && apply.startsWith(":")
        ? value.slice(0, suggest.from).replace(/\s+$/, "")
        : value.slice(0, suggest.from);
    const next = head + apply + value.slice(suggest.to);
    const caret = head.length + apply.length;
    onChange(next);
    close();
    requestAnimationFrame(() => {
      input.current?.setSelectionRange(caret, caret);
      syncScroll();
      // The next step (an operator after a field, a value after `:`) is offered at once.
      complete(next, caret);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const open = !!suggest?.options.length;
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const n = suggest.options.length;
      setActive((a) => (e.key === "ArrowDown" ? (a + 1) % n : a <= 0 ? n - 1 : a - 1));
      return;
    }
    if (open && e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      accept(suggest.options[Math.max(0, active)]!);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (open && active >= 0) accept(suggest.options[active]!);
      else {
        close();
        props.onSubmit(value);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (open) close();
      else if (value) {
        onChange("");
        props.onSubmit("");
      } else props.onClear();
      return;
    }
    if (e.key === " " && e.ctrlKey) {
      e.preventDefault();
      complete(value, e.currentTarget.selectionStart ?? value.length);
    }
  };

  const typedSpan = suggest ? value.slice(suggest.from, suggest.to).replace(/^"/, "") : "";
  const matchOf = (label: string) => {
    const at = typedSpan ? label.toLowerCase().indexOf(typedSpan.toLowerCase()) : -1;
    return at < 0 ? [] : Array.from({ length: typedSpan.length }, (_, i) => at + i);
  };

  // The text, coloured; the error's range underlined (an error at the end marks the end).
  const painted = useMemo(() => {
    const parts: ReactNode[] = [];
    const err = invalid
      ? { from: Math.min(invalid.from, value.length), to: Math.min(Math.max(invalid.to, invalid.from), value.length) }
      : null;
    const marks = new Array<string | undefined>(value.length).fill(undefined);
    for (const t of tokens) for (let i = t.from; i < t.to && i < value.length; i++) marks[i] = TOKEN_CLASS[t.kind];
    let i = 0;
    while (i < value.length) {
      let j = i + 1;
      const inErr = (k: number) => !!err && k >= err.from && k < err.to;
      while (j < value.length && marks[j] === marks[i] && inErr(j) === inErr(i)) j++;
      parts.push(
        <span key={i} className={clsx(marks[i], inErr(i) && css.tkInvalid)}>
          {value.slice(i, j)}
        </span>,
      );
      i = j;
    }
    if (err && err.from >= err.to) parts.push(<span key="end" className={css.tkInvalidEnd} />);
    return parts;
  }, [tokens, invalid, value]);

  return (
    <div
      className={clsx(css.query, invalid && css.queryInvalid)}
      {...(invalid ? { "data-tooltip": invalid.error } : {})}
    >
      <Icon name="search" size={14} className={css.queryIcon} />
      <div className={css.queryField}>
        <div className={css.queryPaint} aria-hidden>
          <div ref={overlay} className={css.queryPaintInner}>
            {painted}
          </div>
        </div>
        <input
          ref={input}
          className={css.queryInput}
          aria-label={tx("Query")}
          aria-invalid={!!invalid || undefined}
          aria-autocomplete="list"
          aria-expanded={!!suggest}
          placeholder={lang === "kql" ? tx("Filter with KQL") : tx("Filter with Lucene")}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            complete(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyDown={onKeyDown}
          onScroll={(_e: UIEvent) => syncScroll()}
          onSelect={syncScroll}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            close();
          }}
        />
      </div>
      {invalid && <Icon name="error" size={14} className={css.queryErrorIcon} />}
      <button
        type="button"
        className={css.langToggle}
        aria-label={tx("Query language")}
        data-tooltip={lang === "kql" ? "Switch to Lucene" : "Switch to KQL"}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          close();
          props.onLangChange(lang === "kql" ? "lucene" : "kql");
        }}
      >
        {lang === "kql" ? "KQL" : "Lucene"}
      </button>
      <Popup
        open={!!suggest?.options.length}
        anchor={caretAnchor}
        placement="bottom-start"
        offset={4}
        autoFocus={false}
        restoreFocus={false}
        onClose={close}
        className={css.suggest}
        role="listbox"
        aria-label={tx("Suggestions")}
      >
        {suggest?.options.map((o, i) => (
          <div
            key={`${o.type}:${o.label}`}
            role="option"
            aria-selected={i === active}
            className={clsx(css.suggestItem, i === active && css.suggestActive)}
            onMouseDown={(e) => e.preventDefault()}
            onMouseMove={() => setActive(i)}
            onClick={() => accept(o)}
          >
            <span className={css.suggestIcon}>
              {o.field ? (
                <FieldIcon field={o.field} />
              ) : o.type === "text" || o.type === "constant" ? (
                <span className={css.valueDot} />
              ) : null}
            </span>
            <span className={clsx(css.suggestLabel, (o.type === "keyword" || o.type === "operator") && css.tkKeyword)}>
              <HighlightedText text={o.label} indices={matchOf(o.label)} />
            </span>
            {o.typeText && <span className={css.suggestType}>{o.typeText}</span>}
          </div>
        ))}
      </Popup>
    </div>
  );
});

function caretRect(el: HTMLElement | null, x: number): DOMRect {
  const r = el?.getBoundingClientRect() ?? new DOMRect();
  return new DOMRect(r.left + x, r.top, 0, r.height);
}
