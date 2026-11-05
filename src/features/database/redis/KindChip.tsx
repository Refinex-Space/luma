/** A Redis value type chip (`HASH`, `ZSET`…) in its colour, as RedisInsight tags keys. */
import { kindMeta } from "./model";
import styles from "./Redis.module.css";

export function KindChip({ kind, wide = false }: { kind: string; wide?: boolean }) {
  const m = kindMeta(kind);
  return (
    <span
      className={wide ? `${styles.chip} ${styles.chipWide}` : styles.chip}
      style={{ "--chip": m.color } as React.CSSProperties}
      title={m.label}
    >
      {wide ? m.label : m.short}
    </span>
  );
}
