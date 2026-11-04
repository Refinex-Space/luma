/** The slash menu's list (see `slash.ts`): sections of Markdown blocks, or ranked search results. */
import { useLayoutEffect, useMemo, useRef } from "react";
import clsx from "clsx";
import { Icon, Popup } from "@/ui";
import { useTx } from "@/platform/i18n";
import { slashGroups } from "./catalog";
import { closeSlash, runSlash, useSlash } from "./slash";
import styles from "./SlashMenu.module.css";

export function SlashMenu() {
  const tx = useTx();
  const { view, query, active, rect } = useSlash();
  const groups = useMemo(() => slashGroups(query), [query]);
  const list = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, groups]);

  const anchor = useMemo(() => (rect ? { getBoundingClientRect: () => rect } : null), [rect]);
  if (!view || !anchor || !groups.length) return null;

  let index = 0;
  return (
    <Popup
      open
      anchor={anchor}
      placement="bottom-start"
      offset={6}
      autoFocus={false}
      restoreFocus={false}
      onClose={closeSlash}
      className={styles.popup}
      role="presentation"
    >
      <div ref={list} className={styles.list} role="listbox" aria-label={tx("Insert Block")}>
        {groups.map((g) => (
          <div key={g.section ?? "results"} role="group" aria-label={g.section ? tx(g.section) : undefined}>
            {g.section && <div className={styles.section}>{tx(g.section)}</div>}
            {g.items.map((item) => {
              const i = index++;
              return (
                <div
                  key={item.id}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  className={clsx(styles.item, i === active && styles.active)}
                  onMouseMove={() => i !== active && useSlash.setState({ active: i })}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    runSlash(item);
                  }}
                >
                  <span className={styles.icon}>
                    <Icon name={item.icon} size={16} />
                  </span>
                  <span className={styles.label}>{tx(item.label)}</span>
                  {item.hint && <span className={styles.hint}>{item.hint}</span>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </Popup>
  );
}
