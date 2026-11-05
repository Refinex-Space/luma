/** Building blocks shared by the Project Structure pages. */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import clsx from "clsx";
import { Icon, List, SearchField, T } from "@/ui";
import { tx } from "@/platform/i18n";
import styles from "./ProjectStructure.module.css";

export function PageHead({ title, note }: { title: string; note?: ReactNode }) {
  return (
    <header className={styles.pageHead}>
      <h2 className={styles.pageTitle}>
        <T>{title}</T>
      </h2>
      {note && <p className={styles.pageNote}>{note}</p>}
    </header>
  );
}

export type MasterRow<T> = { section: string } | { item: T };

export interface MasterDetailProps<T> {
  label: string;
  items: readonly T[];
  getKey: (item: T) => string;
  /** Text matched by the filter. */
  getText: (item: T) => string;
  renderRow: (item: T) => ReactNode;
  /** Groups the list under section headers. */
  sectionOf?: (item: T) => string;
  selected: string | undefined;
  onSelect: (key: string) => void;
  /** Toolbar actions after the filter. */
  actions?: ReactNode;
  empty: ReactNode;
  detail: (item: T) => ReactNode;
  loading?: boolean;
}

/** IDEA's master-detail page: a filterable list on the left, the selected item on the right. */
export function MasterDetail<T>({
  label,
  items,
  getKey,
  getText,
  renderRow,
  sectionOf,
  selected,
  onSelect,
  actions,
  empty,
  detail,
  loading,
}: MasterDetailProps<T>) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((i) => getText(i).toLowerCase().includes(q)) : [...items];
  }, [items, query, getText]);
  const rows = useMemo<MasterRow<T>[]>(() => {
    if (!sectionOf) return shown.map((item) => ({ item }));
    const out: MasterRow<T>[] = [];
    let last: string | null = null;
    for (const item of shown) {
      const s = sectionOf(item);
      if (s !== last) out.push({ section: s });
      last = s;
      out.push({ item });
    }
    return out;
  }, [shown, sectionOf]);
  const current = shown.find((i) => getKey(i) === selected) ?? shown[0];
  const currentKey = current ? getKey(current) : undefined;
  // Keep the shown item selected (first one by default, or after filtering).
  useEffect(() => {
    if (currentKey !== undefined && currentKey !== selected) onSelect(currentKey);
  }, [currentKey, selected, onSelect]);
  const activeIndex = rows.findIndex((r) => "item" in r && getKey(r.item) === currentKey);

  return (
    <>
      <div className={styles.master}>
        <div className={styles.masterBar}>
          <SearchField
            className={styles.masterSearch}
            value={query}
            onChange={setQuery}
            placeholder="Filter"
            aria-label={tx`Filter ${tx(label)}`}
          />
          {actions}
        </div>
        <List<MasterRow<T>>
          className={styles.masterList}
          aria-label={tx(label)}
          items={rows}
          getKey={(r, i) => ("section" in r ? `section:${r.section}:${i}` : getKey(r.item))}
          isSection={(r) => "section" in r}
          renderSection={(r) => <div className={styles.section}>{"section" in r ? tx(r.section) : null}</div>}
          renderItem={(r) => ("item" in r ? renderRow(r.item) : null)}
          activeIndex={activeIndex < 0 ? undefined : activeIndex}
          onActiveChange={(i) => {
            const r = rows[i];
            if (r && "item" in r) onSelect(getKey(r.item));
          }}
          empty={<div className={styles.empty}>{loading ? tx("Loading…") : query ? tx("Nothing matches") : empty}</div>}
        />
      </div>
      <div className={styles.detail}>{current ? detail(current) : null}</div>
    </>
  );
}

export function ItemRow({
  icon,
  name,
  detail,
  dim,
  indent = 0,
}: {
  icon: string;
  name: ReactNode;
  detail?: ReactNode;
  dim?: boolean;
  /** Nesting level (modules inside aggregators). */
  indent?: number;
}) {
  return (
    <span className={styles.row} style={indent ? { paddingLeft: indent * 14 } : undefined}>
      <Icon name={icon} size={16} />
      <span className={clsx(styles.rowName, dim && styles.rowDim)} title={typeof name === "string" ? name : undefined}>
        {name}
      </span>
      {detail && <span className={styles.rowDetail}>{detail}</span>}
    </span>
  );
}

export function DetailHead({
  icon,
  title,
  sub,
  actions,
}: {
  icon: string;
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={styles.detailHead}>
      <Icon name={icon} size={20} />
      <span className={styles.detailTitle}>{title}</span>
      {sub && <span className={styles.detailSub}>{sub}</span>}
      {actions && <span className={styles.detailActions}>{actions}</span>}
    </div>
  );
}

/** Label / value pairs. */
export function Facts({ rows }: { rows: ReadonlyArray<[string, ReactNode] | null | false> }) {
  return (
    <dl className={styles.facts}>
      {rows
        .filter((r): r is [string, ReactNode] => !!r)
        .map(([k, v]) => (
          <FactRow key={k} label={k} value={v} />
        ))}
    </dl>
  );
}

function FactRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt>
        <T>{label}</T>
      </dt>
      <dd>{value}</dd>
    </>
  );
}
