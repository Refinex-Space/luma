/**
 * A Redis key (`RedisKeyView`, the Redis Browser's right side, and `RedisKeyEditor`, a
 * tab of its own): its type, time to live, length, memory and encoding, with Rename /
 * Expire / Persist / Delete; and its value: strings and JSON in a text editor (Text /
 * JSON / Hex views), hashes, lists, sets, sorted sets and streams in the data grid a
 * page at a time, their pending edits submitted together in one MULTI / EXEC
 * (`keyEdits`). Long or JSON values open the grid's Value panel beside it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { call, commands, isCancelled, type RedisBytes, type RedisKeyInfo, type RedisValuePage } from "@/platform/ipc";
import { Button, Icon, IconButton, Input, Popup, Spinner, EmptyState, T, copyText, showContextMenu } from "@/ui";
import { registerKeyClaim } from "@/platform/keymap";
import { tx } from "@/platform/i18n";
import { editorService, notifications, type EditorInput } from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";
import {
  DataView,
  ExtractorSelect,
  PanelToggle,
  exportMenu,
  shownData,
  useGridView,
  viewMenu,
  type DataPanel,
} from "../DataView";
import { emptyEdits, hasEdits, type Cell, type PendingEdits } from "../model";
import { addRow, deleteRows, editedValue, isModified, revertCells, rowState, setCell } from "../rowEdits";
import { useDatabase, withConnection } from "../store";
import styles from "../Database.module.css";
import {
  GRID_KINDS,
  ORDERED_KINDS,
  PATTERN_KINDS,
  VALUE_KINDS,
  appendPage,
  bytesOf,
  cellEditable,
  cellText,
  firstPage,
  draftValue,
  formatJson,
  hexDump,
  initialDraft,
  isKeyColumn,
  jsonError,
  keyEditCommands,
  pageRequest,
  replyErrors,
  saveValueCommand,
  type LoadedValue,
  type RedisRow,
  type ValueDraft,
} from "./keyEdits";
import { KindChip } from "./KindChip";
import { bytesLabel, redisKeyInput, sizeLabel, splitRedisTarget, textBytes, ttlLabel, type RedisKeyRef } from "./model";
import { deleteKey, keyChanged } from "./store";
import css from "./KeyEditor.module.css";

/** Entries a page of a hash, list, set, sorted set or stream loads. */
const PAGE_SIZE = 500;
const NOTIFY_KEY = "redis-key";
/** What `redis_value` reads of a string at most (`ide_db::redis::MAX_STRING_BYTES`). */
const MAX_STRING_BYTES = 1024 * 1024;
const NO_ROWS: RedisRow[] = [];

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function notifyError(title: string, e: unknown) {
  if (!isCancelled(e)) notifications().notify({ level: "error", title, body: errorText(e), key: NOTIFY_KEY });
}

function runCommand(target: string, args: RedisBytes[]) {
  return withConnection(target, () => call(commands.redisCommand(target, args)));
}

function confirmDiscard(name: string): Promise<boolean> {
  return confirm({
    title: "Discard Changes",
    message: tx`Discard the pending changes of '${name}'?`,
    ok: "Discard",
    icon: "warning",
  });
}

function useReadOnly(target: string): boolean {
  const id = splitRedisTarget(target).id;
  return useDatabase((s) => !!s.sources.find((x) => x.id === id)?.readOnly);
}

interface ValueProps {
  target: string;
  keyBytes: RedisBytes;
  kind: string;
  name: string;
  /** Bumped to reload from the start (Refresh, after a write). */
  version: number;
  readOnly: boolean;
  /** The value changed: key info and value reload. */
  onChanged: () => void;
  onDirty: (dirty: boolean) => void;
}

// ---- the editor -------------------------------------------------------------------------

/** The key editor tab: a rename opens the new name's tab, a delete closes it. */
export function RedisKeyEditor({ input }: { input: EditorInput }) {
  const { target, key } = input.data as RedisKeyRef;
  const close = async () => !!(await editorService().closeInput?.(input.key));
  return (
    <RedisKeyView
      target={target}
      keyBytes={key}
      onRenamed={async (next) => {
        keyChanged(target);
        await editorService().openInput(redisKeyInput(target, next), { focus: true });
        return close();
      }}
      onDeleted={close}
    />
  );
}

export interface RedisKeyViewProps {
  target: string;
  keyBytes: RedisBytes;
  /** Bumped when the key may have changed elsewhere (the command line): it reloads. */
  reload?: number;
  /** Renamed to `next`; resolves `false` when this view still shows the old name. */
  onRenamed: (next: RedisBytes) => Promise<boolean>;
  /** Deleted; resolves `false` when this view stays. */
  onDeleted: () => Promise<boolean>;
  /** Extra buttons of the title row (before Refresh). */
  actions?: ReactNode;
}

/** One key: header (type, name, TTL, sizes, actions) and its value. */
export function RedisKeyView({ target, keyBytes: key, reload = 0, onRenamed, onDeleted, actions }: RedisKeyViewProps) {
  const name = bytesLabel(key);
  const readOnly = useReadOnly(target);
  // `info` reloads alone after a TTL change; `value` (and info) after writes and Refresh.
  const [infoVersion, setInfoVersion] = useState(0);
  const [valueVersion, setValueVersion] = useState(0);
  const [info, setInfo] = useState<{
    version: number;
    value: RedisKeyInfo | null;
    error: string | null;
    at: number;
  } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const dirty = useRef(false);

  const version = infoVersion + valueVersion;
  useEffect(() => {
    let live = true;
    withConnection(target, () => call(commands.redisKeyInfo(target, key))).then(
      (value) => live && setInfo({ version, value, error: null, at: Date.now() }),
      (e: unknown) =>
        live && setInfo((prev) => ({ version, value: prev?.value ?? null, error: errorText(e), at: Date.now() })),
    );
    return () => {
      live = false;
    };
  }, [target, key, version]);

  const loading = info?.version !== version;
  const current = info?.value ?? null;
  const ttlMs = current?.ttlMs ?? -1;
  const exists = !!current && current.kind !== "none" && ttlMs !== -2;
  const kind = current?.kind ?? "";

  const changed = useCallback(() => {
    keyChanged(target);
    setValueVersion((v) => v + 1);
  }, [target]);
  const reloadInfo = useCallback(() => setInfoVersion((v) => v + 1), []);
  const onDirty = useCallback((d: boolean) => {
    dirty.current = d;
  }, []);

  const refresh = async () => {
    if (dirty.current && !(await confirmDiscard(name))) return;
    setValueVersion((v) => v + 1);
  };

  // Changed elsewhere: reload, unless edits are pending (they'd be lost).
  const seenReload = useRef(reload);
  useEffect(() => {
    if (seenReload.current === reload) return;
    seenReload.current = reload;
    if (!dirty.current) setValueVersion((v) => v + 1);
  }, [reload]);

  const rename = async (next: string) => {
    setRenaming(null);
    if (!next || next === name) return;
    if (dirty.current && !(await confirmDiscard(name))) return;
    try {
      const reply = await runCommand(target, [textBytes("RENAMENX"), key, textBytes(next)]);
      if (reply.kind === "int" && reply.text === "0") {
        notifications().notify({
          level: "error",
          title: tx("Cannot rename the key"),
          body: tx`A key named '${next}' already exists.`,
          key: NOTIFY_KEY,
        });
        return;
      }
    } catch (e) {
      notifyError(tx("Cannot rename the key"), e);
      return;
    }
    if (!(await onRenamed(textBytes(next)))) setValueVersion((v) => v + 1);
  };

  const remove = async () => {
    if (!(await deleteKey(target, key))) return;
    if (!(await onDeleted())) setValueVersion((v) => v + 1);
  };

  const setTtl = async (args: RedisBytes[]) => {
    try {
      await runCommand(target, args);
      keyChanged(target);
    } catch (e) {
      notifyError(tx("Cannot change the time to live"), e);
    }
    reloadInfo();
  };

  const header = (
    <div className={css.header}>
      <div className={css.titleRow}>
        {exists && <KindChip kind={kind} wide />}
        {renaming !== null ? (
          <Input
            autoFocus
            mono
            className={css.renameInput}
            aria-label="New key name"
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={() => setRenaming(null)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void rename(renaming);
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setRenaming(null);
              }
            }}
          />
        ) : (
          <span
            className={css.name}
            title={name}
            onDoubleClick={() => exists && !readOnly && !key.binary && setRenaming(name)}
          >
            {name}
          </span>
        )}
        {exists && !readOnly && renaming === null && (
          <IconButton
            icon="edit"
            title="Rename Key"
            size="small"
            disabled={!!key.binary}
            onClick={() => setRenaming(name)}
          />
        )}
        <span className={styles.spacer} />
        {loading && <Spinner size={12} />}
        {actions}
        <IconButton icon="refresh" title="Refresh" disabled={loading} onClick={() => void refresh()} />
        <IconButton icon="copy" title="Copy Key Name" onClick={() => void copyText(name)} />
        {!readOnly && (
          <IconButton icon="trash" title="Delete Key" tone="danger" disabled={!exists} onClick={() => void remove()} />
        )}
      </div>
      {exists && current && (
        <div className={css.metaRow}>
          <TtlMeta
            ttlMs={ttlMs}
            loadedAt={info?.at ?? 0}
            readOnly={readOnly}
            onExpire={(seconds) => void setTtl([textBytes("EXPIRE"), key, textBytes(String(seconds))])}
            onPersist={() => void setTtl([textBytes("PERSIST"), key])}
            onExpired={reloadInfo}
          />
          {current.length !== null && (
            <Meta label="Length">
              {kind === "string" ? sizeLabel(current.length) : current.length.toLocaleString("en")}
            </Meta>
          )}
          {current.memory !== null && <Meta label="Memory">{sizeLabel(current.memory)}</Meta>}
          {current.encoding && <Meta label="Encoding">{current.encoding}</Meta>}
        </div>
      )}
    </div>
  );

  let body;
  if (!info || (loading && !current && !info.error)) body = <EmptyState title="Loading…" />;
  else if (info.error && !current) body = <pre className={styles.error}>{info.error}</pre>;
  else if (!exists) body = <EmptyState title="This key no longer exists" />;
  else {
    const props: ValueProps = {
      target,
      keyBytes: key,
      kind,
      name,
      version: valueVersion,
      readOnly,
      onChanged: changed,
      onDirty,
    };
    body = VALUE_KINDS.has(kind) ? (
      <StringValue key={kind} {...props} />
    ) : GRID_KINDS.has(kind) ? (
      <CollectionValue key={kind} {...props} />
    ) : (
      <EmptyState title={tx`Values of type ${kind} cannot be shown`} />
    );
  }

  return (
    <div className={styles.view}>
      {header}
      {info?.error && current && <pre className={styles.error}>{info.error}</pre>}
      <div className={clsx(styles.fill, css.body)}>{body}</div>
    </div>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className={css.meta}>
      <span className={css.metaLabel}>
        <T>{label}</T>
      </span>
      <span className={css.metaValue}>{children}</span>
    </span>
  );
}

/** TTL counting down, and (writable sources) its popup: expire in N seconds, or Persist. */
function TtlMeta(props: {
  ttlMs: number;
  loadedAt: number;
  readOnly: boolean;
  onExpire: (seconds: number) => void;
  onPersist: () => void;
  onExpired: () => void;
}) {
  const { ttlMs, loadedAt, onExpired } = props;
  const [now, setNow] = useState(() => Date.now());
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [seconds, setSeconds] = useState("");
  useEffect(() => {
    if (ttlMs <= 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ttlMs, loadedAt]);
  const left = ttlMs > 0 ? Math.max(0, ttlMs - Math.max(0, now - loadedAt)) : ttlMs;
  useEffect(() => {
    if (ttlMs > 0 && left === 0) onExpired();
  }, [ttlMs, left, onExpired]);

  const valid = /^\d+$/.test(seconds.trim()) && Number(seconds) > 0;
  const label = ttlLabel(left);
  return (
    <span className={css.meta}>
      <span className={css.metaLabel}>TTL</span>
      {props.readOnly ? (
        <span className={css.metaValue}>{label}</span>
      ) : (
        <button
          type="button"
          className={css.ttlButton}
          aria-haspopup="dialog"
          title={tx("Set Time to Live…")}
          onClick={(e) => {
            setSeconds(left > 0 ? String(Math.ceil(left / 1000)) : "");
            setAnchor(e.currentTarget);
          }}
        >
          <Icon name="clock" size={12} />
          {label}
        </button>
      )}
      <Popup
        open={!!anchor}
        anchor={anchor}
        placement="bottom-start"
        onClose={() => setAnchor(null)}
        aria-label={tx("Time to live")}
        className={css.ttlPopup}
        trapFocus
      >
        <form
          className={css.ttlForm}
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            setAnchor(null);
            props.onExpire(Number(seconds));
          }}
        >
          <label className={css.ttlField}>
            <T>Expire in</T>
            <Input
              autoFocus
              mono
              inputMode="numeric"
              aria-label="Seconds"
              value={seconds}
              invalid={!!seconds.trim() && !valid}
              onChange={(e) => setSeconds(e.target.value)}
            />
            <span className={css.metaLabel}>
              <T>seconds</T>
            </span>
          </label>
          <div className={css.ttlButtons}>
            <Button
              size="small"
              disabled={ttlMs === -1}
              onClick={() => {
                setAnchor(null);
                props.onPersist();
              }}
            >
              <T>Persist</T>
            </Button>
            <Button size="small" variant="primary" type="submit" disabled={!valid}>
              <T>Set TTL</T>
            </Button>
          </div>
        </form>
      </Popup>
    </span>
  );
}

// ---- strings and JSON -----------------------------------------------------------------------

function StringValue({ target, keyBytes, kind, name, version, readOnly, onChanged, onDirty }: ValueProps) {
  const [loaded, setLoaded] = useState<{ version: number; page: RedisValuePage | null; error: string | null } | null>(
    null,
  );
  const [draft, setDraft] = useState<ValueDraft>({ text: "", json: false, edited: false });
  const [hex, setHex] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [saving, setSaving] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let live = true;
    withConnection(target, () => call(commands.redisValue(target, keyBytes, kind, {}))).then(
      (page) => {
        if (!live) return;
        setLoaded({ version, page, error: null });
        setDraft(initialDraft(kind, page.value));
        setHex(!!page.value?.binary);
      },
      (e: unknown) => live && setLoaded((prev) => ({ version, page: prev?.page ?? null, error: errorText(e) })),
    );
    return () => {
      live = false;
    };
  }, [target, keyBytes, kind, version]);

  const page = loaded?.page ?? null;
  const value = page?.value ?? null;
  const binary = !!value?.binary;
  const original = value && !binary ? value.text : "";
  const pretty = useMemo(() => formatJson(original), [original]);
  const saved = useMemo(() => draftValue(kind, draft, original, pretty), [kind, draft, original, pretty]);
  const invalid = useMemo(
    () => (draft.json || kind === "ReJSON-RL" ? jsonError(draft.text) : null),
    [draft.json, draft.text, kind],
  );
  const editable = !readOnly && !binary && !page?.truncated && !!page;
  const dirty = editable && draft.edited && saved !== original;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  const save = async () => {
    if (!dirty || saved === null || saving) return;
    setSaving(true);
    try {
      await runCommand(target, saveValueCommand(kind, keyBytes, saved));
      onChanged();
    } catch (e) {
      notifyError(tx`${name}: the value was not saved`, e);
    } finally {
      setSaving(false);
    }
  };

  // ⌘S / Ctrl+S in the editor saves the value rather than the open files.
  useEffect(
    () =>
      registerKeyClaim(
        (e) => e.target === area.current && (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s",
      ),
    [],
  );

  const hexText = useMemo(() => {
    if (!hex || !value) return "";
    const bytes = bytesOf(binary ? value : textBytes(saved ?? draft.text));
    const dump = hexDump(bytes);
    const more = dump.rest.toLocaleString("en");
    return dump.rest ? `${dump.text}\n${tx`… ${more} more bytes`}` : dump.text;
  }, [hex, value, binary, saved, draft.text]);

  const toJson = () => {
    setHex(false);
    if (draft.json) return;
    setDraft({ ...draft, text: draft.text === original ? pretty : formatJson(draft.text), json: true });
  };
  const toText = () => {
    setHex(false);
    if (!draft.json) return;
    setDraft({ ...draft, text: saved ?? draft.text, json: false });
  };
  const view = hex ? "hex" : draft.json ? "json" : "text";
  const jsonDisabled = binary || (!draft.json && jsonError(draft.text) !== null);
  const modes: Array<{ id: string; label: string; disabled: boolean; run: () => void }> = [
    { id: "text", label: "Text", disabled: binary, run: toText },
    { id: "json", label: "JSON", disabled: jsonDisabled, run: toJson },
  ];
  if (kind !== "ReJSON-RL") modes.push({ id: "hex", label: "Hex", disabled: false, run: () => setHex(true) });

  if (!page)
    return loaded?.error ? <pre className={styles.error}>{loaded.error}</pre> : <EmptyState title="Loading…" />;
  const loading = loaded?.version !== version;
  const [shownSize, totalSize] = [sizeLabel(MAX_STRING_BYTES), sizeLabel(page?.total ?? 0)];
  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <div className={css.segmented} role="radiogroup" aria-label={tx("View as")}>
          {modes.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={view === m.id}
              className={css.segment}
              disabled={m.disabled}
              onClick={m.run}
            >
              <T>{m.label}</T>
            </button>
          ))}
        </div>
        <IconButton icon="soft-wrap" title="Soft-Wrap" pressed={wrap} onClick={() => setWrap(!wrap)} />
        {editable && (
          <>
            <span className={styles.toolbarSeparator} />
            <Button
              size="small"
              variant="primary"
              disabled={!dirty || saved === null || saving}
              onClick={() => void save()}
            >
              <T>Save</T>
            </Button>
            <Button size="small" disabled={!dirty || saving} onClick={() => setDraft(initialDraft(kind, value))}>
              <T>Revert</T>
            </Button>
          </>
        )}
        {(loading || saving) && <Spinner size={12} />}
        <span className={styles.spacer} />
        <IconButton
          icon="copy"
          title="Copy Value"
          disabled={!value}
          onClick={() => value && void copyText(binary ? value.text : (saved ?? draft.text))}
        />
      </div>
      {page.truncated && (
        <div className={styles.notice}>{tx`Read-only: showing the first ${shownSize} of ${totalSize}.`}</div>
      )}
      {readOnly && <div className={styles.notice}>{tx("Read-only data source.")}</div>}
      {loaded?.error && <pre className={styles.error}>{loaded.error}</pre>}
      {invalid !== null && !hex && (
        <div className={css.jsonError} role="alert">
          {invalid}
        </div>
      )}
      <textarea
        ref={area}
        className={clsx(css.editor, (!wrap || hex) && css.noWrap)}
        aria-label={tx`Value of ${name}`}
        value={hex ? hexText : draft.text}
        readOnly={hex || !editable}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => setDraft({ ...draft, text: e.target.value, edited: true })}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
            e.preventDefault();
            void save();
          }
        }}
      />
    </div>
  );
}

// ---- hashes, lists, sets, sorted sets, streams -------------------------------------------------

/** A value worth the Value panel: long, several lines, or a JSON object / array. */
function isLongValue(text: string | null): boolean {
  if (!text) return false;
  return text.length > 80 || text.includes("\n") || (/^\s*[[{]/.test(text) && jsonError(text) === null);
}

function columnType(kind: string, col: number): string {
  if (kind === "list" && col === 0) return "integer";
  if (kind === "zset" && col === 1) return "double";
  return "";
}

function CollectionValue({ target, keyBytes, kind, name, version, readOnly, onChanged, onDirty }: ValueProps) {
  const [patternText, setPatternText] = useState("");
  const [pattern, setPattern] = useState("");
  // Streams open newest first, as RedisInsight shows them.
  const [descending, setDescending] = useState(kind === "stream");
  const [data, setData] = useState<{ key: string; value: LoadedValue | null; error: string | null } | null>(null);
  // The first long value, selected when the Value panel opens by itself.
  const [firstLong, setFirstLong] = useState<{ row: number; col: number } | null>(null);
  const [edits, setEdits] = useState<PendingEdits>(emptyEdits);
  const [panel, setPanel] = useState<DataPanel | null>(null);
  // The Value panel opens by itself for long or JSON values, until it is toggled.
  const panelTouched = useRef(false);
  const choosePanel = useCallback((p: DataPanel | null) => {
    panelTouched.current = true;
    setPanel(p);
  }, []);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadKey = JSON.stringify([target, keyBytes, kind, pattern, descending, version]);
  const loading = data?.key !== loadKey;
  useEffect(() => {
    let live = true;
    const request = pageRequest(kind, { count: PAGE_SIZE, pattern, descending }, null);
    withConnection(target, () => call(commands.redisValue(target, keyBytes, kind, request))).then(
      (page) => {
        if (!live) return;
        const first = firstPage(page);
        setData({ key: loadKey, value: first, error: null });
        setEdits(emptyEdits());
        if (panelTouched.current) return;
        const row = first.rows.findIndex((r) => r.some((c) => isLongValue(cellText(c))));
        if (row < 0) return;
        setFirstLong({ row, col: first.rows[row]!.findIndex((c) => isLongValue(cellText(c))) });
        setPanel((p) => p ?? "value");
      },
      (e: unknown) => live && setData((prev) => ({ key: loadKey, value: prev?.value ?? null, error: errorText(e) })),
    );
    return () => {
      live = false;
    };
  }, [loadKey, target, keyBytes, kind, pattern, descending]);

  const value = data?.value ?? null;
  const raw = value?.rows ?? NO_ROWS;
  const names = useMemo(() => value?.columns ?? [], [value]);
  const cells = useMemo(() => raw.map((r) => r.map(cellText)), [raw]);
  const loaded = raw.length;
  const gridColumns = useMemo(
    () => names.map((n, i) => ({ name: n, type: columnType(kind, i), primaryKey: i === 0 })),
    [names, kind],
  );
  const view = useGridView(gridColumns);
  const cellValue = useCallback(
    (row: number, col: number): Cell => editedValue(edits, cells, names, row, col),
    [edits, cells, names],
  );
  const dirty = hasEdits(edits);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  const editable = !readOnly && !busy && !!value;
  const canEdit = (row: number, col: number) => cellEditable(kind, raw, row, col);
  // Redis has no NULL: Set NULL writes an empty string.
  const onEdit = (row: number, col: number, v: Cell) => {
    if (canEdit(row, col)) setEdits((e) => setCell(e, cells, names, row, col, v ?? ""));
  };
  // A new stream entry gets its id from the server (`XADD key *`).
  const newRow = (from?: (col: number) => Cell) =>
    setEdits((e) =>
      addRow(e, names, (c) => (kind === "stream" && c === 0 ? "*" : from && !isKeyColumn(kind, c) ? from(c) : null)),
    );
  const removeRows = (rows: number[]) => setEdits((e) => deleteRows(e, loaded, rows));

  /** Runs `then` unless pending edits are kept (the reload would drop them). */
  const reloading = async (then: () => void) => {
    if (dirty && !(await confirmDiscard(name))) return;
    then();
  };

  const loadMore = async () => {
    const cursor = value?.cursor;
    if (!cursor || more) return;
    const at = loadKey;
    setMore(true);
    try {
      const request = pageRequest(kind, { count: PAGE_SIZE, pattern, descending }, cursor);
      const page = await withConnection(target, () => call(commands.redisValue(target, keyBytes, kind, request)));
      setData((d) => (d && d.key === at && d.value ? { ...d, value: appendPage(d.value, page) } : d));
    } catch (e) {
      notifyError(tx`Cannot load more of ${name}`, e);
    } finally {
      setMore(false);
    }
  };

  const submit = async () => {
    if (!value || busy) return;
    const built = keyEditCommands(kind, keyBytes, value.columns, value.rows, edits);
    if (!built.ok) {
      notifications().notify({
        level: "error",
        title: tx("Changes were not submitted"),
        body: built.error,
        key: NOTIFY_KEY,
      });
      return;
    }
    if (!built.commands.length) {
      setEdits(emptyEdits());
      return;
    }
    setBusy(true);
    try {
      const replies = await withConnection(target, () => call(commands.redisTransaction(target, built.commands)));
      const errors = replyErrors(replies);
      if (errors.length)
        notifications().notify({
          level: "error",
          title: tx`Some changes to ${name} failed`,
          body: errors.join("\n"),
          key: NOTIFY_KEY,
        });
      onChanged();
    } catch (e) {
      notifyError(tx("Changes were not submitted"), e);
    } finally {
      setBusy(false);
    }
  };

  const filterable = PATTERN_KINDS.has(kind);
  const total = value?.total ?? null;
  const shown = loaded.toLocaleString("en");
  const totalText = total?.toLocaleString("en") ?? "";
  const count = !pattern && total !== null ? tx`${shown} of ${totalText}` : value?.cursor ? `${shown}+` : shown;
  const exportTarget = { table: name, driver: "redis" as const, redisKind: kind };

  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        {!readOnly && (
          <>
            <IconButton icon="plus" title="Add Row" disabled={!editable} onClick={() => newRow()} />
            <Button size="small" variant="primary" disabled={!dirty || busy} onClick={() => void submit()}>
              <T>Submit</T>
            </Button>
            <Button size="small" disabled={!dirty || busy} onClick={() => setEdits(emptyEdits())}>
              <T>Revert</T>
            </Button>
            <span className={styles.toolbarSeparator} />
          </>
        )}
        {filterable && (
          <label className={css.pattern}>
            <Icon name="filter" size={14} />
            <Input
              variant="bare"
              mono
              aria-label="MATCH pattern"
              placeholder={kind === "hash" ? "Field pattern" : "Member pattern"}
              value={patternText}
              onChange={(e) => setPatternText(e.target.value)}
              onKeyDown={(e) => {
                const apply = (next: string) => {
                  if (next === pattern) return;
                  void reloading(() => setPattern(next));
                };
                if (e.key === "Enter") apply(patternText.trim());
                if (e.key === "Escape" && patternText) {
                  e.preventDefault();
                  e.stopPropagation();
                  setPatternText("");
                  apply("");
                }
              }}
            />
          </label>
        )}
        {ORDERED_KINDS.has(kind) && (
          <IconButton
            icon="sort"
            title={kind === "stream" ? "Newest First" : "Score Descending"}
            pressed={descending}
            disabled={kind === "zset" && !!pattern}
            onClick={() => void reloading(() => setDescending(!descending))}
          />
        )}
        {(loading || more || busy) && <Spinner size={12} />}
        <span className={styles.spacer} />
        {value && (
          <span className={css.count} role="status">
            {count}
          </span>
        )}
        {value?.cursor && (
          <Button size="small" disabled={more || loading} onClick={() => void loadMore()}>
            <T>Load More</T>
          </Button>
        )}
        <span className={styles.toolbarSeparator} />
        <ExtractorSelect driver="redis" />
        <IconButton
          icon="export"
          title="Export Data"
          aria-haspopup="menu"
          disabled={!value}
          onClick={(e) =>
            value &&
            showContextMenu(
              e,
              exportMenu(shownData({ ...exportTarget, columns: gridColumns, rows: cells }, view), name),
            )
          }
        />
        <IconButton
          icon="settings"
          title="View Options"
          aria-haspopup="menu"
          onClick={(e) => showContextMenu(e, viewMenu(view, gridColumns))}
        />
        <PanelToggle panel={panel} onChange={choosePanel} />
      </div>
      {readOnly && <div className={styles.notice}>{tx("Read-only data source.")}</div>}
      {data?.error && <pre className={styles.error}>{data.error}</pre>}
      {!value ? (
        !data?.error && <EmptyState title="Loading…" />
      ) : (
        <div className={clsx(styles.fill, styles.gridHost, (loading || busy) && styles.gridBusy)}>
          <DataView
            aria-label={tx`Value of ${name}`}
            columns={gridColumns}
            rowCount={loaded + edits.inserts.length}
            fixedRows={loaded}
            value={cellValue}
            panel={panel}
            onPanelChange={choosePanel}
            initialCell={firstLong}
            rowState={(r) => rowState(edits, loaded, r)}
            isModified={(r, c) => isModified(edits, names, r, c)}
            editable={editable}
            cellEditable={canEdit}
            onEdit={onEdit}
            target={exportTarget}
            view={view}
            onRevert={editable ? (rs, cs) => setEdits((e) => revertCells(e, names, loaded, rs, cs)) : undefined}
            onDeleteRows={editable ? removeRows : undefined}
            rowMenu={(rows) =>
              editable
                ? [
                    { label: "Add Row", icon: "plus", run: () => newRow() },
                    {
                      label: "Clone Row",
                      disabled: rows.length !== 1,
                      run: () => newRow((c) => cellValue(rows[0]!, c)),
                    },
                    { label: "Delete Rows", icon: "trash", shortcut: "⌘⌫", run: () => removeRows(rows) },
                  ]
                : []
            }
          />
        </div>
      )}
    </div>
  );
}
