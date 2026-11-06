/**
 * Discover's documents: a virtualised table of the hits loaded, the time first, then the
 * chosen columns or (none chosen) a summary of each document's fields with the query's
 * matches highlighted. Sortable headers (fields that sort), resizable columns, ↑/↓ and ↵ to
 * open a document, menus to copy, filter by a value or change the columns, Load More.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import type { EsField } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { Icon, Spinner, T, copyText, showContextMenu, type MenuItem } from "@/ui";
import {
  MAX_HITS,
  fieldValue,
  formatTime,
  groupOf,
  highlightSegments,
  hitsLabel,
  isSortable,
  valueText,
  type Hit,
  type SortSpec,
} from "./search";
import { docKey, type DiscoverResult } from "./state";
import css from "./Discover.module.css";

const ROW_SUMMARY = 46;
const ROW_COLUMNS = 26;
const EXPAND_W = 28;
const TIME_W = 196;
const COL_W = 160;

/** A column's width until resized: by what its values look like. */
function defaultWidth(name: string, f: EsField | undefined): number {
  // Room for the header: name, sort arrow, remove button.
  return Math.max(Math.min(280, name.length * 7 + 56), typeWidth(f));
}

function typeWidth(f: EsField | undefined): number {
  if (!f) return COL_W;
  switch (groupOf(f)) {
    case "number":
      return 104;
    case "boolean":
      return 88;
    case "date":
      return TIME_W;
    case "ip":
      return 132;
    case "string":
      return f.types.includes("text") ? 360 : 150;
    default:
      return COL_W;
  }
}
const SUMMARY_FIELDS = 40;
const SUMMARY_VALUE = 200;

/** Where each tab's table was scrolled (kept while the tab is hidden; not worth a re-render). */
const scrollTops = new Map<string, number>();

export interface HitsTableProps {
  tabKey: string;
  result: DiscoverResult;
  fields: ReadonlyMap<string, EsField>;
  timeField: string | null;
  columns: readonly string[];
  sort: readonly SortSpec[];
  widths: Readonly<Record<string, number>>;
  open: string | null;
  loadingMore: boolean;
  onOpen: (key: string | null) => void;
  onSort: (sort: SortSpec[]) => void;
  onWidth: (field: string, width: number) => void;
  onToggleColumn: (field: string) => void;
  onMoveColumn: (field: string, by: -1 | 1) => void;
  onFilter: (field: string, value: unknown, negate: boolean) => void;
  onLoadMore: () => void;
}

/** A highlighted value (ES `highlight` fragments) or the plain one. */
function Value({ hit, field, value }: { hit: Hit; field: string; value: unknown }): ReactNode {
  const hl = hit.highlight?.[field];
  if (hl?.length) {
    return highlightSegments(hl.join(" … ")).map((s, i) =>
      s.hit ? (
        <mark key={i} className={css.hl}>
          {s.text}
        </mark>
      ) : (
        s.text
      ),
    );
  }
  const text = valueText(value);
  return text.length > SUMMARY_VALUE * 4 ? `${text.slice(0, SUMMARY_VALUE * 4)}…` : text;
}

function Summary({ hit, row, timeField }: { hit: Hit; row: Record<string, unknown>; timeField: string | null }) {
  // Fields with matches first (what the query found), then the document's order.
  const names = Object.keys(row).filter((k) => k !== timeField);
  const matched = names.filter((k) => hit.highlight?.[k]);
  const ordered = [...matched, ...names.filter((k) => !hit.highlight?.[k])].slice(0, SUMMARY_FIELDS);
  return (
    <div className={css.summary}>
      {ordered.map((k) => {
        const v = row[k];
        const text = valueText(v);
        return (
          <span key={k} className={css.pair}>
            <span className={css.chip}>{k}</span>
            <span className={css.pairValue}>
              {hit.highlight?.[k] ? (
                <Value hit={hit} field={k} value={v} />
              ) : text.length > SUMMARY_VALUE ? (
                `${text.slice(0, SUMMARY_VALUE)}…`
              ) : (
                text
              )}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function footLabel(n: number, result: DiscoverResult, done: boolean): string {
  const loaded = n.toLocaleString("en");
  const total = hitsLabel(result.total, result.relation);
  const max = MAX_HITS.toLocaleString("en");
  if (!done) return tx`${loaded} of ${total}`;
  return n >= MAX_HITS ? tx`First ${max} of ${total}` : tx`${loaded} documents`;
}

export function HitsTable(props: HitsTableProps) {
  const { tabKey, result, fields, timeField, columns, sort, widths, open } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const summary = columns.length === 0;
  const rowH = summary ? ROW_SUMMARY : ROW_COLUMNS;
  const n = result.hits.length;
  const openIndex = open ? result.hits.findIndex((h) => docKey(h) === open) : -1;
  const lead = useRef(openIndex >= 0 ? openIndex : -1);
  if (openIndex >= 0) lead.current = openIndex;
  // The keyboard's row (with a document open, the open one).
  const [focusRow, setFocusRow] = useState(-1);

  const virtualizer = useVirtualizer({
    count: n,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowH,
    overscan: 10,
    initialOffset: scrollTops.get(tabKey) ?? 0,
  });
  useEffect(() => virtualizer.measure(), [rowH, virtualizer]);

  // Restores the scroll position when the tab shows again.
  useLayoutEffect(() => {
    const el = scroller.current;
    const top = scrollTops.get(tabKey);
    if (el && top) el.scrollTop = top;
  }, [tabKey]);

  // A new search starts at the top.
  const basis = result.basis;
  const firstBasis = useRef(basis);
  useEffect(() => {
    if (firstBasis.current === basis) return;
    firstBasis.current = basis;
    if (scroller.current) scroller.current.scrollTop = 0;
    scrollTops.set(tabKey, 0);
  }, [basis, tabKey]);

  // The open document stays in view (stepping through with ‹ ›).
  useEffect(() => {
    if (openIndex >= 0) virtualizer.scrollToIndex(openIndex, { align: "auto" });
  }, [openIndex, virtualizer]);

  const dataCols = summary ? [] : [...columns];
  const widthOf = (c: string) => widths[c] ?? defaultWidth(c, fields.get(c));
  const template = [
    `${EXPAND_W}px`,
    ...(timeField ? [`${widths[timeField] ?? TIME_W}px`] : []),
    ...(summary
      ? ["minmax(240px, 1fr)"]
      : dataCols.map((c, i) => (i === dataCols.length - 1 ? `minmax(${widthOf(c)}px, 1fr)` : `${widthOf(c)}px`))),
  ].join(" ");
  const minWidth =
    EXPAND_W +
    (timeField ? (widths[timeField] ?? TIME_W) : 0) +
    (summary ? 240 : dataCols.reduce((a, c) => a + widthOf(c), 0));
  const effective = sort.length ? sort : timeField ? [{ field: timeField, dir: "desc" as const }] : [];

  const sortBy = (field: string) => {
    const cur =
      sort.find((s) => s.field === field) ?? (sort.length ? undefined : effective.find((s) => s.field === field));
    let next: SortSpec[];
    if (!cur) next = [{ field, dir: field === timeField ? "desc" : "asc" }];
    else if (field === timeField || cur.dir === "asc") next = [{ field, dir: cur.dir === "asc" ? "desc" : "asc" }];
    else next = [];
    props.onSort(next);
  };

  const startResize = (e: MouseEvent, field: string, start: number) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const move = (ev: globalThis.MouseEvent) => props.onWidth(field, Math.max(72, Math.round(start + ev.clientX - x0)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const header = (field: string, label: ReactNode, width: number, removable: boolean, index = -1) => {
    const name = field;
    const f = fields.get(field);
    const sortable = field === timeField || isSortable(f);
    const s = effective.find((x) => x.field === field);
    return (
      <div
        key={field}
        role="columnheader"
        aria-sort={s ? (s.dir === "asc" ? "ascending" : "descending") : undefined}
        className={clsx(css.th, sortable && css.thSortable, f && groupOf(f) === "number" && css.thNumber)}
        title={sortable ? tx`Sort by ${field}` : field}
        onClick={sortable ? () => sortBy(field) : undefined}
        onContextMenu={(e) => {
          e.preventDefault();
          const items: MenuItem[] = [];
          if (sortable)
            items.push(
              { label: "Sort Ascending", icon: "arrow-up", run: () => props.onSort([{ field, dir: "asc" }]) },
              { label: "Sort Descending", icon: "arrow-down", run: () => props.onSort([{ field, dir: "desc" }]) },
              { label: "Clear Sorting", disabled: !sort.length, run: () => props.onSort([]) },
              { kind: "separator" },
            );
          if (removable)
            items.push(
              {
                label: "Move Left",
                icon: "arrow-left",
                disabled: index <= 0,
                run: () => props.onMoveColumn(field, -1),
              },
              {
                label: "Move Right",
                icon: "arrow-right",
                disabled: index >= dataCols.length - 1,
                run: () => props.onMoveColumn(field, 1),
              },
              { label: "Remove Column", icon: "close", run: () => props.onToggleColumn(field) },
              { kind: "separator" },
            );
          items.push({ label: "Copy Field Name", icon: "copy", run: () => void copyText(field) });
          showContextMenu(e, items);
        }}
      >
        <span className={css.thName}>{label}</span>
        {s ? (
          <Icon name={s.dir === "asc" ? "arrow-up" : "arrow-down"} size={12} className={css.thSort} />
        ) : (
          sortable && <Icon name="db-sort" size={14} className={css.thSortHint} />
        )}
        {removable && (
          <button
            type="button"
            className={css.thRemove}
            aria-label={tx`Remove column ${name}`}
            data-tooltip="Remove Column"
            onClick={(e) => {
              e.stopPropagation();
              props.onToggleColumn(field);
            }}
          >
            <Icon name="close" size={12} />
          </button>
        )}
        <span
          className={css.thResize}
          onMouseDown={(e) => startResize(e, field, width)}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    );
  };

  const rowMenu = (e: MouseEvent, i: number, field: string | null) => {
    e.preventDefault();
    const hit = result.hits[i]!;
    const row = result.rows[i]!;
    const items: MenuItem[] = [
      { label: "Open Document", icon: "panel-right", shortcut: "↵", run: () => props.onOpen(docKey(hit)) },
      { kind: "separator" },
    ];
    if (field) {
      const v = fieldValue(row, field);
      const text = valueText(v);
      items.push(
        { label: "Copy Value", icon: "copy", disabled: v === undefined, run: () => void copyText(text) },
        {
          label: "Filter for Value",
          icon: "plus",
          disabled: v === undefined || (typeof v === "object" && v !== null),
          run: () => props.onFilter(field, v, false),
        },
        {
          label: "Filter out Value",
          icon: "minus",
          disabled: v === undefined || (typeof v === "object" && v !== null),
          run: () => props.onFilter(field, v, true),
        },
        { kind: "separator" },
      );
    }
    items.push(
      {
        label: "Copy Document",
        icon: "copy",
        run: () => void copyText(JSON.stringify(hit._source ?? {}, null, 2)),
      },
      { label: "Copy ID", run: () => void copyText(hit._id) },
    );
    showContextMenu(e, items);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget || !n) return;
    const go = (i: number) => {
      const to = Math.max(0, Math.min(n - 1, i));
      lead.current = to;
      virtualizer.scrollToIndex(to, { align: "auto" });
      props.onOpen(open !== null || e.key === "Enter" ? docKey(result.hits[to]!) : null);
      setFocusRow(to);
    };
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 400) / rowH) - 1);
    if (e.key === "ArrowDown") go(lead.current + 1);
    else if (e.key === "ArrowUp") go(lead.current < 0 ? 0 : lead.current - 1);
    else if (e.key === "PageDown") go(lead.current + page);
    else if (e.key === "PageUp") go(lead.current - page);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(n - 1);
    else if (e.key === "Enter") go(Math.max(0, lead.current));
    else if (e.key === "Escape" && open) props.onOpen(null);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const timeHeader = timeField ? header(timeField, timeField, widths[timeField] ?? TIME_W, false) : null;
  const shownAll = result.done;
  return (
    <div className={css.table}>
      <div
        ref={scroller}
        className={css.tableScroll}
        tabIndex={0}
        role="grid"
        aria-label={tx("Documents")}
        aria-rowcount={n}
        onKeyDown={onKeyDown}
        onScroll={(e) => scrollTops.set(tabKey, e.currentTarget.scrollTop)}
      >
        <div className={css.tableInner} style={{ minWidth, height: virtualizer.getTotalSize() + 28 }}>
          <div className={clsx(css.tr, css.thead)} role="row" style={{ gridTemplateColumns: template }}>
            <div className={css.th} aria-hidden />
            {timeHeader}
            {summary ? (
              <div className={css.th} role="columnheader">
                <span className={css.thName}>
                  <T>Document</T>
                </span>
              </div>
            ) : (
              dataCols.map((c, i) => header(c, c, widthOf(c), true, i))
            )}
          </div>
          {virtualizer.getVirtualItems().map((v) => {
            const i = v.index;
            const hit = result.hits[i]!;
            const row = result.rows[i]!;
            const k = docKey(hit);
            const isOpen = k === open;
            return (
              <div
                key={k}
                data-index={i}
                role="row"
                aria-selected={isOpen || undefined}
                className={clsx(
                  css.tr,
                  css.trBody,
                  summary && css.trSummary,
                  isOpen && css.trOpen,
                  focusRow === i && css.trFocus,
                )}
                style={
                  {
                    gridTemplateColumns: template,
                    height: rowH,
                    transform: `translateY(${v.start + 28}px)`,
                  } as CSSProperties
                }
                onMouseDown={() => {
                  lead.current = i;
                  setFocusRow(i);
                }}
                onClick={() => {
                  if (open !== null) props.onOpen(k);
                }}
                onDoubleClick={() => props.onOpen(k)}
              >
                <div className={css.tdExpand} role="gridcell">
                  <button
                    type="button"
                    className={css.expand}
                    aria-label={isOpen ? tx("Close Document") : tx("Open Document")}
                    aria-pressed={isOpen}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onOpen(isOpen ? null : k);
                    }}
                  >
                    <Icon name={isOpen ? "chevron-left" : "chevron-right"} size={12} />
                  </button>
                </div>
                {timeField && (
                  <div
                    className={clsx(css.td, css.tdTime)}
                    role="gridcell"
                    onContextMenu={(e) => rowMenu(e, i, timeField)}
                  >
                    {formatTime(fieldValue(row, timeField))}
                  </div>
                )}
                {summary ? (
                  <div className={css.td} role="gridcell" onContextMenu={(e) => rowMenu(e, i, null)}>
                    <Summary hit={hit} row={row} timeField={timeField} />
                  </div>
                ) : (
                  dataCols.map((c) => {
                    const f = fields.get(c);
                    const v = fieldValue(row, c);
                    const group = f ? groupOf(f) : "other";
                    return (
                      <div
                        key={c}
                        role="gridcell"
                        className={clsx(css.td, group === "number" && css.tdNumber, v === undefined && css.tdEmpty)}
                        onContextMenu={(e) => rowMenu(e, i, c)}
                      >
                        {v === undefined ? (
                          "—"
                        ) : group === "date" ? (
                          formatTime(v)
                        ) : (
                          <Value hit={hit} field={c} value={v} />
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            );
          })}
        </div>
      </div>
      <footer className={css.tableFoot}>
        {props.loadingMore && <Spinner size={12} />}
        <span className={css.footText} role="status">
          {footLabel(n, result, shownAll)}
        </span>
        {!shownAll && (
          <button type="button" className={css.link} disabled={props.loadingMore} onClick={props.onLoadMore}>
            <T>Load More</T>
          </button>
        )}
      </footer>
    </div>
  );
}
