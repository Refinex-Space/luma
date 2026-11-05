/**
 * The Redis key tree: keys grouped into folders by a separator (`user:42:profile` lives
 * in `user` › `42`), as RedisInsight and DataGrip show them. Built once per loaded key
 * list; a folder's children are looked up by its prefix.
 */
import type { RedisKeyEntry } from "@/platform/ipc";

export interface KeyFolder {
  /** The folder's name (one segment). */
  name: string;
  /** Prefix of every key inside, separator included (`user:42:`). */
  prefix: string;
  /** Keys inside, at any depth. */
  count: number;
}

export interface KeyLevel {
  folders: KeyFolder[];
  keys: Array<{ entry: RedisKeyEntry; name: string }>;
}

export interface KeyIndex {
  /** Prefix (`""`: the database) → what lies right under it. */
  levels: Map<string, KeyLevel>;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Groups `entries` by `separator`. Binary keys and keys without a separator stay at the top. */
export function indexKeys(entries: readonly RedisKeyEntry[], separator: string): KeyIndex {
  const levels = new Map<string, KeyLevel>();
  const folderCounts = new Map<string, Map<string, number>>();
  const level = (prefix: string) => {
    let l = levels.get(prefix);
    if (!l) levels.set(prefix, (l = { folders: [], keys: [] }));
    return l;
  };
  level("");
  for (const entry of entries) {
    const text = entry.key.text;
    if (entry.key.binary || !separator) {
      level("").keys.push({ entry, name: text });
      continue;
    }
    const parts = text.split(separator);
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      // `a::b` has an empty segment: still a folder, named by its separator position.
      const counts = folderCounts.get(prefix) ?? new Map<string, number>();
      folderCounts.set(prefix, counts);
      counts.set(parts[i]!, (counts.get(parts[i]!) ?? 0) + 1);
      prefix += parts[i] + separator;
    }
    level(prefix).keys.push({ entry, name: parts.at(-1)! });
  }
  for (const [prefix, counts] of folderCounts) {
    level(prefix).folders = [...counts]
      .map(([name, count]) => ({ name, prefix: prefix + name + separator, count }))
      .sort((a, b) => collator.compare(a.name, b.name));
  }
  for (const l of levels.values()) l.keys.sort((a, b) => collator.compare(a.name, b.name));
  return { levels };
}

/** The `MATCH` pattern of a folder: its prefix, glob characters escaped, then `*`. */
export function folderPattern(prefix: string): string {
  return `${prefix.replace(/[*?[\]\\]/g, "\\$&")}*`;
}
