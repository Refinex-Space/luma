/**
 * The hits over time: one bar per bucket of the date histogram, quiet axes, a tooltip with
 * the bucket's time and count, and dragging across bars (or clicking one) zooms the time
 * range to them. Bars grow and shrink between searches; while one runs they dim.
 */
import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import clsx from "clsx";
import { tx } from "@/platform/i18n";
import { bucketLabel, tickLabel, tickStep, type Bucket, type Interval } from "./search";
import css from "./Discover.module.css";

const PLOT_H = 72;
const DAY = 86_400_000;
/** The plot's top (`.histogram` padding): room for the y axis' top label. */
const PAD_TOP = 12;
const GUTTER = 40;

export interface HistogramProps {
  buckets: readonly Bucket[];
  interval: Interval;
  bounds: { from: number; to: number };
  loading: boolean;
  onZoom: (from: number, to: number) => void;
}

/** A round count for the y axis' top line (1, 2, 5 × 10ⁿ). */
export function niceMax(n: number): number {
  // The middle line's label stays a whole count.
  if (n <= 2) return 2;
  const p = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= n) return m * p;
  return 10 * p;
}

function shortCount(n: number): string {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${+(n / 1e3).toFixed(0)}K`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export function Histogram({ buckets, interval, bounds, loading, onZoom }: HistogramProps) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const plotW = Math.max(0, width - GUTTER);
  const n = Math.max(1, buckets.length);
  const band = plotW / n;
  const gap = band >= 6 ? 2 : band >= 3 ? 1 : 0;
  const max = niceMax(Math.max(0, ...buckets.map((b) => b.count)));
  const first = buckets[0]?.key ?? bounds.from;
  const last = buckets.length ? buckets[buckets.length - 1]!.key + interval.ms : bounds.to;
  const span = Math.max(1, last - first);

  // Ticks on round times, at least ~90px apart.
  const ticks = useMemo(() => {
    if (!plotW) return [];
    // Past a few days, ticks fall on midnights (labels are dates).
    const step = Math.max(tickStep((span * 90) / plotW), span > 3 * DAY ? DAY : 0);
    const out: number[] = [];
    if (step >= DAY) {
      // Local midnights, counted in days (a daylight saving change keeps them on midnight).
      const days = Math.round(step / DAY);
      const d = new Date(first);
      d.setHours(0, 0, 0, 0);
      if (d.getTime() < first) d.setDate(d.getDate() + 1);
      for (; d.getTime() <= last && out.length < 40; d.setDate(d.getDate() + days)) out.push(d.getTime());
      return out;
    }
    const tz = new Date(first).getTimezoneOffset() * 60_000;
    for (let t = Math.ceil((first - tz) / step) * step + tz; t <= last && out.length < 40; t += step) out.push(t);
    return out;
  }, [plotW, span, first, last]);

  const at = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    const x = clientX - r.left - GUTTER;
    return Math.max(0, Math.min(buckets.length - 1, Math.floor(x / band)));
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || !buckets.length) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const a = at(e.clientX);
    const x0 = e.clientX;
    let moved = false;
    let cur = { a, b: a };
    setDrag(cur);
    const move = (ev: globalThis.PointerEvent) => {
      if (Math.abs(ev.clientX - x0) > 3) moved = true;
      cur = { a, b: at(ev.clientX) };
      setDrag(cur);
      setHover(cur.b);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setDrag(null);
      const lo = Math.min(cur.a, cur.b);
      const hi = Math.max(cur.a, cur.b);
      if (!moved && !buckets[lo]?.count) return;
      const from = Math.max(buckets[lo]!.key, bounds.from);
      const to = Math.min(buckets[hi]!.key + interval.ms, bounds.to);
      onZoom(from, Math.max(from + 1, to));
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const shown = hover !== null ? buckets[hover] : undefined;
  const every = interval.value;
  const sel = drag ? { lo: Math.min(drag.a, drag.b), hi: Math.max(drag.a, drag.b) } : null;
  return (
    <div
      ref={box}
      className={clsx(css.histogram, loading && css.histogramLoading)}
      role="img"
      aria-label={tx`Hits over time, ${every} per bar`}
    >
      <div className={css.yAxis} aria-hidden>
        <span style={{ top: 0 }}>{shortCount(max)}</span>
        <span style={{ top: PLOT_H / 2 }}>{shortCount(max / 2)}</span>
        <span style={{ top: PLOT_H }}>0</span>
      </div>
      <div
        className={css.plot}
        style={{ left: GUTTER, height: PLOT_H }}
        onPointerDown={onPointerDown}
        onPointerMove={(e) => !drag && buckets.length && setHover(at(e.clientX))}
        onPointerLeave={() => !drag && setHover(null)}
      >
        <i className={css.gridLine} style={{ top: 0 }} />
        <i className={css.gridLine} style={{ top: PLOT_H / 2 }} />
        {sel && <i className={css.brush} style={{ left: sel.lo * band, width: (sel.hi - sel.lo + 1) * band }} />}
        {buckets.map((b, i) => {
          const h = b.count ? Math.max(2, (b.count / max) * PLOT_H) : 0;
          return (
            <i
              key={i}
              className={clsx(
                css.hBar,
                hover === i && css.hBarHover,
                sel && i >= sel.lo && i <= sel.hi && css.hBarHover,
              )}
              style={{ left: i * band + gap / 2, width: Math.max(1, band - gap), height: h }}
            />
          );
        })}
        <i className={css.baseline} />
      </div>
      <div className={css.xAxis} style={{ left: GUTTER, top: PAD_TOP + PLOT_H + 5 }} aria-hidden>
        {ticks.map((t) => {
          const x = ((t - first) / span) * plotW;
          if (x < 0 || x > plotW - 24) return null;
          return (
            <span key={t} style={{ left: x }}>
              {tickLabel(t, span)}
            </span>
          );
        })}
      </div>
      {shown && hover !== null && (
        <div
          className={css.barTip}
          style={{
            left: Math.min(Math.max(GUTTER + (hover + 0.5) * band, GUTTER + 70), width - 70),
          }}
        >
          <span className={css.barTipTime}>{bucketLabel(shown.key, interval)}</span>
          <span className={css.barTipCount}>{shown.count.toLocaleString("en")}</span>
        </div>
      )}
    </div>
  );
}
