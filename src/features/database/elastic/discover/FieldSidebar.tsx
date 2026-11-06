/**
 * Discover's field list: the chosen columns, the fields the loaded hits have values for and
 * the rest (folded), filtered by name. A field's row adds or removes it as a column; a click
 * shows its five most common values (share bars, filter for / out).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { EsField } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { HighlightedText, Icon, IconButton, Input, Popup, Spinner, T, copyText, showContextMenu } from "@/ui";
import { FieldIcon } from "./FieldIcon";
import { fieldSections, type TopValues } from "./search";
import { topValues } from "./state";
import css from "./Discover.module.css";

export interface FieldSidebarProps {
  tabKey: string;
  fields: readonly EsField[];
  loading: boolean;
  error: string | null;
  /** Fields with a value in a loaded hit. */
  present: ReadonlySet<string>;
  columns: readonly string[];
  onToggleColumn: (field: string) => void;
  onFilter: (field: string, value: string, negate: boolean) => void;
}

type Section = "selected" | "available" | "empty";

const matchOf = (needle: string, name: string) => {
  if (!needle) return [];
  const at = name.toLowerCase().indexOf(needle.toLowerCase());
  return at < 0 ? [] : Array.from({ length: needle.length }, (_, i) => at + i);
};

export function FieldSidebar(props: FieldSidebarProps) {
  const { fields, present, columns, onToggleColumn } = props;
  const [search, setSearch] = useState("");
  const [folded, setFolded] = useState<ReadonlySet<Section>>(new Set(["empty"]));
  const [shown, setShown] = useState<{ field: EsField; anchor: HTMLElement } | null>(null);
  const sections = useMemo(() => fieldSections(fields, present, columns, search), [fields, present, columns, search]);
  const chosen = new Set(columns);

  const toggleSection = (s: Section) =>
    setFolded((f) => {
      const next = new Set(f);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const block = (section: Section, title: string, list: EsField[]) => {
    if (!list.length && (section !== "available" || search)) return null;
    const open = !folded.has(section) || !!search.trim();
    return (
      <div className={css.fieldSection} key={section}>
        <button type="button" className={css.sectionHead} aria-expanded={open} onClick={() => toggleSection(section)}>
          <Icon name="chevron-right" size={12} className={clsx(css.sectionChevron, open && css.sectionChevronOpen)} />
          <span className={css.sectionTitle}>{tx(title)}</span>
          <span className={css.sectionCount}>{list.length.toLocaleString("en")}</span>
        </button>
        {open && (
          <div role="list" aria-label={tx(title)}>
            {list.map((f) => {
              const isCol = chosen.has(f.name);
              return (
                <div
                  key={f.name}
                  role="listitem"
                  className={clsx(css.fieldRow, shown?.field.name === f.name && css.fieldRowOpen)}
                  onClick={(e) => setShown({ field: f, anchor: e.currentTarget })}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    showContextMenu(e, [
                      {
                        label: isCol ? "Remove Column" : "Add Column",
                        icon: isCol ? "minus" : "plus",
                        run: () => onToggleColumn(f.name),
                      },
                      { label: "Copy Field Name", icon: "copy", run: () => void copyText(f.name) },
                    ]);
                  }}
                >
                  <FieldIcon field={f} />
                  <span className={css.fieldName} title={f.name}>
                    <HighlightedText text={f.name} indices={matchOf(search.trim(), f.name)} />
                  </span>
                  <IconButton
                    icon={isCol ? "minus" : "plus"}
                    title={isCol ? "Remove Column" : "Add Column"}
                    size="small"
                    iconSize={12}
                    className={clsx(css.fieldToggle, isCol && css.fieldToggleOn)}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleColumn(f.name);
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <section className={css.sidebar} aria-label={tx("Fields")}>
      <label className={css.sideSearch}>
        <Icon name="search" size={14} />
        <Input
          variant="bare"
          aria-label="Search field names"
          placeholder={tx("Search field names")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && search) {
              e.preventDefault();
              e.stopPropagation();
              setSearch("");
            }
          }}
        />
      </label>
      <div className={css.fieldScroll}>
        {props.error ? (
          <div className={clsx(css.popupNote, css.danger)}>{props.error}</div>
        ) : props.loading && !fields.length ? (
          <div className={css.popupNote}>
            <Spinner size={12} />
          </div>
        ) : (
          <>
            {block("selected", "Selected", sections.selected)}
            {block("available", "Available", sections.available)}
            {block("empty", "Empty", sections.empty)}
          </>
        )}
      </div>
      {shown && (
        <TopValuesPopup
          key={shown.field.name}
          tabKey={props.tabKey}
          field={shown.field}
          anchor={shown.anchor}
          isColumn={chosen.has(shown.field.name)}
          onClose={() => setShown(null)}
          onToggleColumn={() => onToggleColumn(shown.field.name)}
          onFilter={(v, negate) => {
            setShown(null);
            props.onFilter(shown.field.name, v, negate);
          }}
        />
      )}
    </section>
  );
}

function TopValuesPopup(props: {
  tabKey: string;
  field: EsField;
  anchor: HTMLElement;
  isColumn: boolean;
  onClose: () => void;
  onToggleColumn: () => void;
  onFilter: (value: string, negate: boolean) => void;
}) {
  const { tabKey, field } = props;
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ok"; value: TopValues & { sampled: boolean } }
    | { status: "error"; message: string }
  >({ status: "loading" });
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    topValues(tabKey, field.name).then(
      (value) => n === seq.current && setState({ status: "ok", value }),
      (e: unknown) =>
        n === seq.current && setState({ status: "error", message: e instanceof Error ? e.message : String(e) }),
    );
  }, [tabKey, field.name]);

  return (
    <Popup
      open
      anchor={props.anchor}
      placement="right-start"
      offset={6}
      autoFocus={false}
      onClose={props.onClose}
      className={css.topPopup}
      role="dialog"
      aria-label={tx`Top values of ${field.name}`}
    >
      <div className={css.topHead}>
        <FieldIcon field={field} />
        <span className={css.topName} title={field.name}>
          {field.name}
        </span>
        <IconButton
          icon={props.isColumn ? "minus" : "plus"}
          title={props.isColumn ? "Remove Column" : "Add Column"}
          size="small"
          onClick={props.onToggleColumn}
        />
      </div>
      <div className={css.topBody}>
        {state.status === "loading" ? (
          <div className={css.topNote}>
            <Spinner size={12} />
          </div>
        ) : state.status === "error" ? (
          <div className={clsx(css.topNote, css.danger)}>{state.message}</div>
        ) : !state.value.values.length ? (
          <div className={css.topNote}>
            <T>No values</T>
          </div>
        ) : (
          state.value.values.map((v) => (
            <div key={v.value} className={css.topRow}>
              <div className={css.topLine}>
                <span className={css.topValue} title={v.value}>
                  {v.value === "" ? <em className={css.muted}>""</em> : v.value}
                </span>
                <span className={css.topPct}>{formatShare(v.share)}</span>
                <IconButton
                  icon="plus"
                  title="Filter for Value"
                  size="small"
                  iconSize={12}
                  onClick={() => props.onFilter(v.value, false)}
                />
                <IconButton
                  icon="minus"
                  title="Filter out Value"
                  size="small"
                  iconSize={12}
                  onClick={() => props.onFilter(v.value, true)}
                />
              </div>
              <span className={css.topBar}>
                <i style={{ width: `${Math.max(0.5, v.share * 100)}%` }} />
              </span>
            </div>
          ))
        )}
      </div>
      {state.status === "ok" && <div className={css.topFoot}>{footLabel(state.value)}</div>}
    </Popup>
  );
}

function footLabel(v: TopValues & { sampled: boolean }): string {
  const present = v.present.toLocaleString("en");
  const total = v.total.toLocaleString("en");
  return v.sampled ? tx`In ${total} loaded documents` : tx`In ${present} of ${total} documents`;
}

function formatShare(share: number): string {
  const pct = share * 100;
  if (pct > 0 && pct < 0.1) return "<0.1%";
  return `${pct >= 10 || pct === 0 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}
