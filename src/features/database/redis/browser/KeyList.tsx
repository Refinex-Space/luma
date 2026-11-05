/**
 * The Redis Browser's key list: the keys `SCAN` found, grouped into folders by the data
 * source's separator (or flat), each with its type, time to live (counting down) and
 * memory; multi-selection, speed search, menus, Delete / ⌘C, and the scan's progress
 * with Load More.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import type { RedisBytes, RedisKeyEntry } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import {
  EmptyState,
  HighlightedText,
  Icon,
  Spinner,
  T,
  Tree,
  copyText,
  showContextMenu,
  type MenuItem,
  type TreeHandle,
} from "@/ui";
import { KindChip } from "../KindChip";
import { bytesLabel, keyId, sizeLabel, splitRedisTarget, type RedisTarget } from "../model";
import {
  deleteKeys,
  loadKeys,
  openKeyTab,
  openRedisDialog,
  selectBrowserKey,
  separatorOf,
  useRedis,
  type DbKeys,
} from "../store";
import { folderPattern, indexKeys } from "../tree";
import { folderNodeKey as folderKey, setExpanded, useBrowserUi } from "./state";
import css from "./RedisBrowser.module.css";

type KeyNode =
  | { kind: "folder"; key: string; name: string; prefix: string; count: number }
  | { kind: "key"; key: string; entry: RedisKeyEntry; name: string };

const NONE: readonly string[] = [];
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const nodeKeyOf = (k: RedisBytes) => `k:${keyId(k)}`;
/** Milliseconds to live when scanned (`-1`: no expiry). */
const ttlOf = (e: RedisKeyEntry) => e.ttlMs ?? -1;

/** `42s`, `5m`, `3h`, `2d`: one unit, as a column reads at a glance. */
export function shortTtl(ms: number): string {
  if (ms < 0) return "";
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** The current time, ticking each second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export interface KeyListProps {
  target: RedisTarget;
  list: DbKeys | undefined;
  /** Keys in the database (`DBSIZE`), when known. */
  total: number | null;
  readOnly: boolean;
  /** Shows only the keys matching `pattern` (a folder's “Show Only This Folder”). */
  onFilter: (pattern: string) => void;
  /** Puts `text` into the command line. */
  onInsert: (text: string) => void;
}

export function KeyList({ target, list, total, readOnly, onFilter, onInsert }: KeyListProps) {
  const flat = useBrowserUi((s) => s.flat);
  const expandedList = useBrowserUi((s) => s.expanded[target] ?? NONE);
  const stored = useMemo(() => new Set(expandedList), [expandedList]);
  const shown = useRedis((s) => s.browserKey[target] ?? null);
  const reveal = useRedis((s) => s.reveal[target]);
  const separator = separatorOf(splitRedisTarget(target).id);
  const tree = useRef<TreeHandle>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(shown ? [nodeKeyOf(shown)] : []));

  const keys = list?.keys;
  const { roots, childrenOf, byNodeKey } = useMemo(() => {
    const entries = keys ?? [];
    const byNodeKey = new Map<string, KeyNode>();
    const keyNode = (entry: RedisKeyEntry, name: string): KeyNode => {
      const n: KeyNode = { kind: "key", key: nodeKeyOf(entry.key), entry, name };
      byNodeKey.set(n.key, n);
      return n;
    };
    if (flat) {
      const roots = entries
        .map((e) => ({ e, label: bytesLabel(e.key) }))
        .sort((a, b) => collator.compare(a.label, b.label))
        .map(({ e, label }) => keyNode(e, label));
      return { roots, childrenOf: new Map<string, KeyNode[]>(), byNodeKey };
    }
    const index = indexKeys(entries, separator);
    const childrenOf = new Map<string, KeyNode[]>();
    for (const [prefix, level] of index.levels) {
      const nodes: KeyNode[] = [
        ...level.folders.map((f): KeyNode => {
          const n: KeyNode = {
            kind: "folder",
            key: folderKey(f.prefix),
            name: f.name,
            prefix: f.prefix,
            count: f.count,
          };
          byNodeKey.set(n.key, n);
          return n;
        }),
        ...level.keys.map((k) => keyNode(k.entry, k.name)),
      ];
      childrenOf.set(prefix, nodes);
    }
    return { roots: childrenOf.get("") ?? [], childrenOf, byNodeKey };
  }, [keys, flat, separator]);

  // Filtered keys show with every folder open (matches are what's wanted), until folded
  // by hand; the unfiltered tree keeps the folders the user opened.
  const filterSig = list && (list.pattern !== "*" || list.type !== null) ? `${list.pattern}\u0000${list.type}` : null;
  const [folded, setFolded] = useState<{ sig: string; open: Set<string> } | null>(null);
  const allFolders = useMemo(
    () => (filterSig ? new Set([...childrenOf.keys()].filter((p) => p !== "").map(folderKey)) : null),
    [filterSig, childrenOf],
  );
  const expanded = filterSig ? (folded?.sig === filterSig ? folded.open : allFolders!) : stored;
  const setExpandedHere = (next: Set<string>) => {
    if (filterSig) setFolded({ sig: filterSig, open: next });
    else setExpanded(target, next);
  };

  // TTLs count down from when the page was read; a key whose time ran out reads as expired.
  const at = list?.at ?? 0;
  const counting = useMemo(() => (keys ?? []).some((k) => ttlOf(k) > 0), [keys]);
  const now = useNow(counting);
  const ttlLeft = (e: RedisKeyEntry) => {
    const ttl = ttlOf(e);
    return ttl > 0 ? ttl - Math.max(0, now - at) : ttl;
  };

  // Reveal: expand the key's folders, then select and scroll to it once its row exists.
  const pending = useRef<string | null>(null);
  const handled = useRef(0);
  useEffect(() => {
    if (!reveal || reveal.seq === handled.current) return;
    const nodeKey = nodeKeyOf(reveal.key);
    if (!byNodeKey.has(nodeKey)) {
      // Not loaded (yet): a reload in flight may bring it; a finished one won't.
      if (list && !list.loading) handled.current = reveal.seq;
      return;
    }
    // Its folders were opened with the reveal (`revealBrowserKey`).
    handled.current = reveal.seq;
    pending.current = nodeKey;
  }, [reveal, byNodeKey, list]);
  useLayoutEffect(() => {
    const key = pending.current;
    if (!key || !tree.current) return;
    if (!byNodeKey.has(key)) {
      pending.current = null;
      return;
    }
    tree.current.reveal(key);
    if (tree.current.leadKey() === key) pending.current = null;
  });

  const selectedNodes = () => [...selected].map((k) => byNodeKey.get(k)).filter((n): n is KeyNode => !!n);
  const selectedKeys = () => selectedNodes().flatMap((n) => (n.kind === "key" ? [n.entry.key] : []));

  const keyMenu = (n: Extract<KeyNode, { kind: "key" }>): MenuItem[] => {
    const name = bytesLabel(n.entry.key);
    const writes: MenuItem[] = readOnly
      ? []
      : [
          { kind: "separator" },
          {
            label: "Rename Key…",
            icon: "edit",
            disabled: n.entry.key.binary,
            run: () => openRedisDialog({ kind: "rename", target, key: n.entry.key }),
          },
          {
            label: "Set Time to Live…",
            icon: "clock",
            run: () => openRedisDialog({ kind: "ttl", target, key: n.entry.key, ttlMs: ttlLeft(n.entry) }),
          },
          { kind: "separator" },
          {
            label: "Delete Key…",
            icon: "trash",
            shortcut: "⌫",
            danger: true,
            run: () => void deleteKeys(target, [n.entry.key]),
          },
        ];
    return [
      { label: "Open in New Tab", icon: "external-link", run: () => openKeyTab(target, n.entry.key) },
      { label: "Copy Key Name", icon: "copy", shortcut: "⌘C", run: () => void copyText(name) },
      { label: "Insert into Command Line", icon: "terminal", run: () => onInsert(name) },
      ...writes,
    ];
  };

  const folderMenu = (n: Extract<KeyNode, { kind: "folder" }>): MenuItem[] => {
    const pattern = folderPattern(n.prefix);
    return [
      ...(readOnly
        ? []
        : ([
            {
              label: "New Key Here…",
              icon: "plus",
              run: () => openRedisDialog({ kind: "newKey", target, prefix: n.prefix }),
            },
            { kind: "separator" },
          ] satisfies MenuItem[])),
      { label: "Show Only This Folder", icon: "filter", run: () => onFilter(pattern) },
      { label: "Copy Pattern", icon: "copy", run: () => void copyText(pattern) },
      ...(readOnly
        ? []
        : ([
            { kind: "separator" },
            {
              label: "Delete Keys in Folder…",
              icon: "trash",
              danger: true,
              run: () => openRedisDialog({ kind: "deleteMatching", target, pattern }),
            },
          ] satisfies MenuItem[])),
    ];
  };

  const manyMenu = (keys: RedisBytes[]): MenuItem[] => {
    const n = keys.length;
    return [
      {
        label: "Copy Key Names",
        icon: "copy",
        shortcut: "⌘C",
        run: () => void copyText(keys.map(bytesLabel).join("\n")),
      },
      ...(readOnly
        ? []
        : ([
            { kind: "separator" },
            {
              label: tx`Delete ${n} Keys…`,
              icon: "trash",
              shortcut: "⌫",
              danger: true,
              run: () => void deleteKeys(target, keys),
            },
          ] satisfies MenuItem[])),
    ];
  };

  const backgroundMenu: MenuItem[] = [
    ...(readOnly
      ? []
      : ([
          { label: "New Key…", icon: "plus", run: () => openRedisDialog({ kind: "newKey", target, prefix: "" }) },
          { kind: "separator" },
        ] satisfies MenuItem[])),
    { label: "Refresh Keys", icon: "refresh", run: () => void loadKeys(target, { list: "browser" }) },
  ];

  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "c") {
      const names = selectedKeys().map(bytesLabel);
      if (!names.length) return;
      e.preventDefault();
      void copyText(names.join("\n"));
    }
    if (!readOnly && (e.key === "Delete" || (e.key === "Backspace" && mod))) {
      const keys = selectedKeys();
      if (!keys.length) return;
      e.preventDefault();
      void deleteKeys(target, keys);
    }
  };

  const loading = !!list?.loading;
  const filtered = !!list && (list.pattern !== "*" || list.type !== null);
  const loaded = keys?.length ?? 0;
  const loadedText = loaded.toLocaleString("en");
  const totalText = total?.toLocaleString("en") ?? "";
  const status = !list
    ? ""
    : filtered
      ? list.done
        ? tx`${loadedText} matching`
        : tx`${loadedText} matching so far`
      : total !== null && !list.done
        ? tx`${loadedText} of ${totalText}`
        : tx`${loadedText} keys`;
  // How much of the database is loaded, while some is still to load (Load More).
  const progress = list && !list.done && !filtered && total ? Math.min(1, loaded / total) : null;

  let empty;
  if (!list || (loading && !loaded)) empty = <EmptyState title="Loading…" />;
  else if (list.error && !loaded) empty = <pre className={css.listError}>{list.error}</pre>;
  else if (filtered) empty = <EmptyState title="No matching keys" />;
  else empty = <EmptyState title="No keys" />;

  return (
    <section className={css.keys} aria-label={tx("Keys")}>
      <div className={css.keysHead} aria-hidden>
        <span className={css.colName}>
          <T>Key</T>
        </span>
        <span className={css.colTtl}>TTL</span>
        <span className={css.colSize}>
          <T>Size</T>
        </span>
      </div>
      <div className={css.keysTree} onKeyDown={onKeyDown}>
        <Tree<KeyNode>
          aria-label={tx("Keys")}
          handleRef={tree}
          roots={roots}
          getKey={(n) => n.key}
          getLabel={(n) => n.name}
          getChildren={(n) => (n.kind === "folder" ? childrenOf.get(n.prefix) : undefined)}
          isExpandable={(n) => n.kind === "folder"}
          expanded={expanded}
          onExpandedChange={setExpandedHere}
          selected={selected}
          multiSelect
          onSelectionChange={(next, lead) => {
            setSelected(next);
            if (lead?.kind === "key") selectBrowserKey(target, lead.entry.key);
          }}
          rowHeight={24}
          speedSearch
          empty={empty}
          onContextMenu={(n, sel, e) => {
            const nodes = [...sel].map((k) => byNodeKey.get(k)).filter((x): x is KeyNode => !!x);
            const keysOf = nodes.flatMap((x) => (x.kind === "key" ? [x.entry.key] : []));
            if (!n) return showContextMenu(e, backgroundMenu);
            if (keysOf.length > 1 && sel.has(n.key)) return showContextMenu(e, manyMenu(keysOf));
            showContextMenu(e, n.kind === "key" ? keyMenu(n) : folderMenu(n));
          }}
          renderNode={(n, state) => {
            if (n.kind === "folder")
              return (
                <span className={css.keyRow}>
                  <Icon name="db-folder" size={16} />
                  <span className={css.keyName}>
                    <HighlightedText text={n.name} indices={state.matches} />
                    <span className={css.folderCount}>{n.count.toLocaleString("en")}</span>
                  </span>
                </span>
              );
            const left = ttlLeft(n.entry);
            const expired = ttlOf(n.entry) > 0 && left <= 0;
            return (
              <span className={clsx(css.keyRow, expired && css.expired)} title={bytesLabel(n.entry.key)}>
                <KindChip kind={n.entry.kind} />
                <span className={clsx(css.keyName, css.mono)}>
                  <HighlightedText text={n.name} indices={state.matches} />
                </span>
                <span className={clsx(css.colTtl, left > 0 && left < 60_000 && css.soon)}>
                  {expired ? tx("expired") : shortTtl(left)}
                </span>
                <span className={css.colSize}>{n.entry.memory !== null ? sizeLabel(n.entry.memory) : ""}</span>
              </span>
            );
          }}
        />
      </div>
      <footer className={css.keysFoot}>
        {loading && <Spinner size={12} />}
        <span className={css.footText} role="status">
          {list?.error && loaded ? <span className={css.footError}>{list.error}</span> : status}
        </span>
        {progress !== null && (
          <span className={css.progress} aria-hidden>
            <i style={{ width: `${progress * 100}%` }} />
          </span>
        )}
        {list && !list.done && (
          <button
            type="button"
            className={css.link}
            disabled={loading}
            onClick={() => void loadKeys(target, { list: "browser", more: true })}
          >
            <T>Load More</T>
          </button>
        )}
      </footer>
    </section>
  );
}
