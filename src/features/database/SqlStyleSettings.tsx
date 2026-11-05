/**
 * Editor › Code Style › SQL: the three choices SQL formatting needs (keyword case, clause
 * layout, aligned aliases) over a live preview. The defaults are the recommended style;
 * Tabs and Indents › Indent below sets the indent unit. Reformat Code, completion and the
 * SQL live templates follow these.
 */
import { useMemo } from "react";
import { Checkbox, Select, T, type SelectOption } from "@/ui";
import type { LanguageCodeStyle } from "@/platform/editorSettings";
import { useSettingsForm } from "@/workbench/contributions";
import { tx } from "@/platform/i18n";
import { CodePreview } from "./CodePreview";
import { formatted } from "./sql/format";
import type { KeywordCase } from "./sql/keywords";
import { SQL_LANGUAGE_ID, sqlStyleOf } from "./sqlStyle";
import styles from "./SqlStyle.module.css";

const CASES: SelectOption<KeywordCase>[] = [
  { value: "upper", label: "UPPER" },
  { value: "lower", label: "lower" },
  { value: "preserve", label: "As typed" },
];

const LAYOUTS: SelectOption<"aligned" | "indented">[] = [
  { value: "aligned", label: "Aligned after the keyword" },
  { value: "indented", label: "Indented under the keyword" },
];

/** Typed carelessly on purpose: the preview shows what Reformat Code makes of it. */
const SAMPLE = [
  "select o.id, o.status, c.name customer, count(i.id) as items, sum(i.price * i.qty) as amount",
  "from orders o join customer c on c.id = o.customer_id left join order_item i on i.order_id = o.id",
  "where o.status in ('PAID', 'SHIPPED') and o.total > 100 or o.customer_id in (select id from vip)",
  "group by o.id, o.status, c.name having count(i.id) > 1 order by amount desc limit 20;",
  "",
  "insert into customer(name, email) values ('Ada', 'ada@example.com'), ('Linus', 'linus@example.com');",
  "",
  "create table product(id bigint not null primary key, name varchar(120) not null,",
  "price decimal(10, 2) default 0, created_at timestamp default current_timestamp);",
].join("\n");

const KEY = "editor.codeStyle.languages";

export function SqlStyleSettings() {
  const form = useSettingsForm();
  const all = (form.useValue(KEY) ?? {}) as Record<string, LanguageCodeStyle>;
  const own = all[SQL_LANGUAGE_ID];
  const style = sqlStyleOf(own);
  const set = (patch: Partial<LanguageCodeStyle>) => form.set(KEY, { ...all, [SQL_LANGUAGE_ID]: { ...own, ...patch } });
  const preview = useMemo(() => formatted(SAMPLE, "mysql", style), [style]);
  return (
    <section className={styles.section} aria-label={tx("SQL Formatting")}>
      <div className={styles.title}>
        <T>SQL Formatting</T>
      </div>
      <div className={styles.options}>
        <span className={styles.label}>
          <T>Keyword case</T>
        </span>
        <Select
          aria-label="Keyword case"
          value={style.keywordCase}
          options={CASES}
          onChange={(keywordCase) => set({ keywordCase })}
        />
        <span className={styles.label}>
          <T>Clause layout</T>
        </span>
        <Select
          aria-label="Clause layout"
          value={style.layout}
          options={LAYOUTS}
          onChange={(listLayout) => set({ listLayout })}
        />
        <div className={styles.wide}>
          <Checkbox
            checked={style.alignAliases}
            onChange={(alignAliases) => set({ alignAliases })}
            label="Align column aliases"
          />
        </div>
      </div>
      <CodePreview className={styles.preview} sql text={preview} aria-label={tx("SQL formatting preview")} />
    </section>
  );
}
