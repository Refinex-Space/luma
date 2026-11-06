/**
 * Discover's toolbar pickers: the index pattern (indices, data streams and aliases of the
 * cluster, or any pattern typed: `logs-*`; hidden and system ones only once typed) and the
 * time range (quick ranges, or absolute bounds).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { tx } from "@/platform/i18n";
import { Button, HighlightedText, Icon, Input, Popup, T } from "@/ui";
import { compactCount } from "../model";
import { loadIndices, useElastic } from "../store";
import { QUICK_RANGES, formatTime, parseTime, resolveRange, type TimeRange } from "./search";
import css from "./Discover.module.css";

// ---- index pattern --------------------------------------------------------------------------

interface Target {
  name: string;
  kind: "pattern" | "index" | "dataStream" | "alias";
  detail?: string;
}

const KIND_ICON: Record<Target["kind"], string> = {
  pattern: "search",
  index: "db-table",
  dataStream: "db-view",
  alias: "db-foreign-key",
};

const indicesLabel = (n: number) => (n === 1 ? tx("1 index") : tx`${n} indices`);

function matchIndices(text: string, name: string): number[] | null {
  if (!text) return [];
  const at = name.toLowerCase().indexOf(text.toLowerCase());
  return at < 0 ? null : Array.from({ length: text.length }, (_, i) => at + i);
}

export function IndexPicker({ id, value, onChange }: { id: string; value: string; onChange: (index: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const anchor = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const loaded = useElastic((s) => s.indices[id]);

  useEffect(() => {
    if (open && !loaded) void loadIndices(id);
  }, [open, loaded, id]);

  const targets = useMemo((): Target[] => {
    const v = loaded?.status === "ok" ? loaded.value : null;
    if (!v) return [];
    const typed = text.trim();
    // Hidden / system ones (`.kibana`, `.ds-…` backing indices) only when looked for.
    const shows = (name: string, hidden: boolean) => !hidden || (typed.length > 0 && name.includes(typed));
    const out: Target[] = [];
    for (const d of v.dataStreams)
      if (shows(d.name, d.hidden))
        out.push({ name: d.name, kind: "dataStream", detail: indicesLabel(d.indices.length) });
    for (const a of v.aliases)
      if (shows(a.name, a.name.startsWith(".")))
        out.push({
          name: a.name,
          kind: "alias",
          detail: a.indices.length === 1 ? a.indices[0] : indicesLabel(a.indices.length),
        });
    for (const i of v.indices)
      if (shows(i.name, i.hidden || !!i.dataStream))
        out.push({
          name: i.name,
          kind: "index",
          detail: i.status === "close" ? tx("closed") : compactCount(i.docs ?? 0),
        });
    return out.filter((t) => matchIndices(typed, t.name));
  }, [loaded, text]);

  const typed = text.trim();
  const items: Target[] =
    typed && !targets.some((t) => t.name === typed) ? [{ name: typed, kind: "pattern" }, ...targets] : targets;

  const choose = (name: string) => {
    setOpen(false);
    if (name && name !== value) onChange(name);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.max(0, Math.min(items.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)));
      setActive(next);
      list.current?.children[next]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(items[active]?.name ?? typed);
    }
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={clsx(css.picker, css.indexPicker)}
        aria-label={tx("Index pattern")}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tooltip="Index pattern"
        onClick={() => {
          setText("");
          setActive(0);
          setOpen((o) => !o);
        }}
      >
        <Icon name="db-table" size={14} />
        <span className={css.pickerText}>{value}</span>
        <Icon name="chevron-down" size={12} className={css.pickerChevron} />
      </button>
      <Popup
        open={open}
        anchor={anchor}
        placement="bottom-start"
        onClose={() => setOpen(false)}
        className={css.indexPopup}
        aria-label={tx("Index pattern")}
      >
        <div className={css.popupSearch}>
          <Icon name="search" size={14} />
          <Input
            variant="bare"
            mono
            autoFocus
            data-autofocus
            aria-label="Index pattern"
            placeholder={PATTERN_HINT}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div ref={list} className={css.indexList} role="listbox" aria-label={tx("Indices")}>
          {!loaded || loaded.status === "loading" ? (
            <div className={css.popupNote}>
              <T>Loading…</T>
            </div>
          ) : loaded.status === "error" ? (
            <div className={clsx(css.popupNote, css.danger)}>{loaded.message}</div>
          ) : !items.length ? (
            <div className={css.popupNote}>
              <T>Nothing matches</T>
            </div>
          ) : (
            items.map((t, i) => (
              <div
                key={`${t.kind}:${t.name}`}
                role="option"
                aria-selected={i === active}
                className={clsx(
                  css.indexItem,
                  i === active && css.indexItemActive,
                  t.name === value && css.indexItemCurrent,
                )}
                onMouseMove={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(t.name)}
              >
                <Icon name={KIND_ICON[t.kind]} size={14} />
                <span className={css.indexName}>
                  <HighlightedText text={t.name} indices={matchIndices(typed, t.name) ?? []} />
                </span>
                {t.kind === "pattern" ? (
                  <span className={css.indexDetail}>↵</span>
                ) : (
                  t.detail && <span className={css.indexDetail}>{t.detail}</span>
                )}
              </div>
            ))
          )}
        </div>
      </Popup>
    </>
  );
}

// ---- time range -----------------------------------------------------------------------------

/** Formats the fields read (not translated). */
const TIME_HINT = "yyyy-MM-dd HH:mm:ss";
const PATTERN_HINT = "logs-*";

const shortTime = (ms: number) => formatTime(ms).slice(0, 16);

export function rangeLabel(r: TimeRange): string {
  if (r.kind === "all") return tx("All time");
  if (r.kind === "relative") {
    const q = QUICK_RANGES.find((x) => x.ms === r.ms);
    const minutes = Math.round(r.ms / 60_000);
    return q ? tx(q.label) : tx`Last ${minutes} minutes`;
  }
  return `${shortTime(r.from)} → ${shortTime(r.to)}`;
}

export function TimePicker({ value, onChange }: { value: TimeRange; onChange: (r: TimeRange) => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const start = () => {
    const b = resolveRange(value, Date.now()) ?? { from: Date.now() - 86_400_000, to: Date.now() };
    setFrom(formatTime(b.from).slice(0, 19));
    setTo(formatTime(b.to).slice(0, 19));
    setOpen((o) => !o);
  };
  const f = parseTime(from);
  const t = parseTime(to);
  const valid = f !== null && t !== null && f < t;
  const apply = () => {
    if (!valid) return;
    setOpen(false);
    onChange({ kind: "absolute", from: f, to: t });
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={clsx(css.picker, css.timePicker)}
        aria-label={tx("Time range")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={start}
      >
        <Icon name="clock" size={14} />
        <span className={css.pickerText}>{rangeLabel(value)}</span>
        <Icon name="chevron-down" size={12} className={css.pickerChevron} />
      </button>
      <Popup
        open={open}
        anchor={anchor}
        placement="bottom-end"
        onClose={() => setOpen(false)}
        className={css.timePopup}
        role="dialog"
        aria-label={tx("Time range")}
        trapFocus
      >
        <div className={css.quick} role="listbox" aria-label={tx("Quick ranges")}>
          {QUICK_RANGES.map((q) => {
            const r: TimeRange = q.ms === null ? { kind: "all" } : { kind: "relative", ms: q.ms };
            const current =
              value.kind === r.kind && (r.kind !== "relative" || (value.kind === "relative" && value.ms === r.ms));
            return (
              <button
                key={q.short}
                type="button"
                role="option"
                aria-selected={current}
                className={clsx(css.quickItem, current && css.quickCurrent)}
                onClick={() => {
                  setOpen(false);
                  onChange(r);
                }}
              >
                <span>{tx(q.label)}</span>
                <span className={css.quickShort}>{q.short}</span>
              </button>
            );
          })}
        </div>
        <form
          className={css.absolute}
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <label className={css.absField}>
            <span>
              <T>From</T>
            </span>
            <Input
              mono
              value={from}
              invalid={f === null}
              onChange={(e) => setFrom(e.target.value)}
              placeholder={TIME_HINT}
            />
          </label>
          <label className={css.absField}>
            <span>
              <T>To</T>
            </span>
            <Input
              mono
              value={to}
              invalid={t === null}
              onChange={(e) => setTo(e.target.value)}
              placeholder={TIME_HINT}
            />
          </label>
          <Button type="submit" variant="primary" size="small" disabled={!valid} className={css.absApply}>
            Apply
          </Button>
        </form>
      </Popup>
    </>
  );
}
