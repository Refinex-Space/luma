/**
 * The open document beside the hits: its index and id, ‹ › through the hits, Copy JSON,
 * Edit (writable data sources: the `_source` as JSON, saved with `PUT _doc` guarded by its
 * sequence number) and Delete; as a table of fields (filter for / out, toggle a column,
 * copy) or as JSON.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { EsField } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { Button, HighlightedText, Icon, IconButton, Input, Tabs, T, copyText, showContextMenu } from "@/ui";
import { JsonView } from "../JsonView";
import { FieldIcon } from "./FieldIcon";
import { fieldValue, formatTime, groupOf, highlightSegments, valueText, type Hit } from "./search";
import css from "./Discover.module.css";

export interface DocumentFlyoutProps {
  hit: Hit;
  row: Record<string, unknown>;
  position: number;
  count: number;
  fields: ReadonlyMap<string, EsField>;
  columns: readonly string[];
  readOnly: boolean;
  onStep: (by: -1 | 1) => void;
  onClose: () => void;
  onToggleColumn: (field: string) => void;
  onFilter: (field: string, value: unknown, negate: boolean) => void;
  onSave: (source: Record<string, unknown>) => Promise<string | null>;
  onDelete: () => void;
}

/** The document as the JSON tab shows it (and Copy JSON copies). */
function documentJson(hit: Hit) {
  return {
    _index: hit._index,
    _id: hit._id,
    ...(hit._score !== undefined && hit._score !== null ? { _score: hit._score } : {}),
    ...(hit._seq_no !== undefined ? { _seq_no: hit._seq_no, _primary_term: hit._primary_term } : {}),
    _source: hit._source ?? {},
  };
}

const UNKNOWN: EsField = { name: "", types: ["unknown"], searchable: false, aggregatable: false, metadata: false };

export function DocumentFlyout(props: DocumentFlyoutProps) {
  const { hit, row, fields, readOnly } = props;
  const [tab, setTab] = useState<"table" | "json">("table");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<{ text: string; error: string | null; saving: boolean } | null>(null);
  const doc = useMemo(() => documentJson(hit), [hit]);
  const editor = useRef<HTMLTextAreaElement>(null);

  // Another document leaves the editor (unsaved text with it).
  const id = `${hit._index}\u0000${hit._id}`;
  const docId = hit._id;
  const shownId = useRef(id);
  useEffect(() => {
    if (shownId.current === id) return;
    shownId.current = id;
    setEditing(null);
  }, [id]);

  const parsed = useMemo(() => {
    if (!editing) return null;
    try {
      const v = JSON.parse(editing.text) as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) return { error: tx("A document is a JSON object") };
      return { value: v as Record<string, unknown> };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [editing]);

  const save = async () => {
    if (!editing || !parsed || !("value" in parsed) || editing.saving) return;
    setEditing({ ...editing, saving: true, error: null });
    const error = await props.onSave(parsed.value!);
    setEditing((cur) => (cur ? (error ? { ...cur, saving: false, error } : null) : null));
  };

  const names = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return Object.keys(row)
      .sort((a, b) => a.localeCompare(b))
      .filter((k) => !needle || k.toLowerCase().includes(needle));
  }, [row, search]);
  const meta = (["_index", "_id"] as const).filter((k) => !search.trim() || k.includes(search.trim().toLowerCase()));

  const valueCell = (field: string, v: unknown) => {
    const hl = hit.highlight?.[field];
    if (hl?.length)
      return highlightSegments(hl.join(" … ")).map((s, i) =>
        s.hit ? (
          <mark key={i} className={css.hl}>
            {s.text}
          </mark>
        ) : (
          s.text
        ),
      );
    const f = fields.get(field);
    if (f && groupOf(f) === "date" && typeof v === "string") return <span title={v}>{formatTime(v)}</span>;
    if (v === null) return <span className={css.muted}>null</span>;
    if (Array.isArray(v) && v.every((x) => x === null || typeof x !== "object")) return valueText(v);
    if (typeof v === "object")
      return <span className={css.jsonValue}>{JSON.stringify(v, null, 1).replace(/\n\s*/g, " ")}</span>;
    return valueText(v);
  };

  const fieldRow = (name: string, v: unknown, isMeta: boolean) => {
    const f = isMeta ? { ...UNKNOWN, name, types: ["keyword"] } : (fields.get(name) ?? { ...UNKNOWN, name });
    const isCol = props.columns.includes(name);
    const filterable = !isMeta && v !== undefined && (typeof v !== "object" || v === null);
    const needle = search.trim();
    const at = needle ? name.toLowerCase().indexOf(needle.toLowerCase()) : -1;
    return (
      <div
        key={name}
        role="row"
        className={clsx(css.docRow, isMeta && css.docRowMeta)}
        onContextMenu={(e) => {
          e.preventDefault();
          showContextMenu(e, [
            { label: "Copy Value", icon: "copy", run: () => void copyText(valueText(v)) },
            { label: "Copy Field Name", run: () => void copyText(name) },
            ...(isMeta
              ? []
              : [
                  { kind: "separator" as const },
                  {
                    label: "Filter for Value",
                    icon: "plus",
                    disabled: !filterable,
                    run: () => props.onFilter(name, v, false),
                  },
                  {
                    label: "Filter out Value",
                    icon: "minus",
                    disabled: !filterable,
                    run: () => props.onFilter(name, v, true),
                  },
                  { label: isCol ? "Remove Column" : "Add Column", run: () => props.onToggleColumn(name) },
                ]),
          ]);
        }}
      >
        <span className={css.docField} role="rowheader" title={name}>
          <FieldIcon field={f} />
          <span className={css.docFieldName}>
            <HighlightedText
              text={name}
              indices={at < 0 ? [] : Array.from({ length: needle.length }, (_, i) => at + i)}
            />
          </span>
        </span>
        <span className={css.docValue} role="cell">
          {valueCell(name, v)}
        </span>
        <span className={css.docActions}>
          {!isMeta && (
            <>
              <IconButton
                icon="plus"
                title="Filter for Value"
                size="small"
                iconSize={12}
                disabled={!filterable}
                onClick={() => props.onFilter(name, v, false)}
              />
              <IconButton
                icon="minus"
                title="Filter out Value"
                size="small"
                iconSize={12}
                disabled={!filterable}
                onClick={() => props.onFilter(name, v, true)}
              />
              <IconButton
                icon="db-columns"
                title={isCol ? "Remove Column" : "Add Column"}
                size="small"
                iconSize={12}
                pressed={isCol}
                onClick={() => props.onToggleColumn(name)}
              />
            </>
          )}
          <IconButton
            icon="copy"
            title="Copy Value"
            size="small"
            iconSize={12}
            onClick={() => void copyText(valueText(v))}
          />
        </span>
      </div>
    );
  };

  return (
    <section className={css.flyout} aria-label={tx("Document")}>
      <header className={css.flyHead}>
        <div className={css.flyTitle}>
          <span className={css.flyId} title={hit._id}>
            {hit._id}
          </span>
          <span className={css.flyIndex} title={hit._index}>
            {hit._index}
          </span>
        </div>
        <span className={css.flyPos}>
          {(props.position + 1).toLocaleString("en")} / {props.count.toLocaleString("en")}
        </span>
        <IconButton
          icon="chevron-up"
          title="Previous Document"
          shortcut="↑"
          disabled={props.position <= 0}
          onClick={() => props.onStep(-1)}
        />
        <IconButton
          icon="chevron-down"
          title="Next Document"
          shortcut="↓"
          disabled={props.position >= props.count - 1}
          onClick={() => props.onStep(1)}
        />
        <span className={css.barSep} />
        <IconButton icon="copy" title="Copy JSON" onClick={() => void copyText(JSON.stringify(doc, null, 2))} />
        {!readOnly && (
          <>
            <IconButton
              icon="edit"
              title="Edit Document"
              pressed={!!editing}
              onClick={() => {
                if (editing) setEditing(null);
                else {
                  setEditing({ text: JSON.stringify(hit._source ?? {}, null, 2), error: null, saving: false });
                  requestAnimationFrame(() => editor.current?.focus());
                }
              }}
            />
            <IconButton icon="trash" title="Delete Document" onClick={props.onDelete} />
          </>
        )}
        <IconButton icon="close" title="Close" shortcut="⎋" onClick={props.onClose} />
      </header>

      {editing ? (
        <div className={css.editor}>
          <textarea
            ref={editor}
            className={clsx(css.editorText, parsed && "error" in parsed && css.editorInvalid)}
            aria-label={tx`Source of ${docId}`}
            spellCheck={false}
            value={editing.text}
            onChange={(e) => setEditing({ ...editing, text: e.target.value, error: null })}
            onKeyDown={(e) => {
              const mod = e.metaKey || e.ctrlKey;
              if (mod && (e.key === "Enter" || e.key.toLowerCase() === "s")) {
                e.preventDefault();
                void save();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setEditing(null);
              } else if (e.key === "Tab" && !e.shiftKey) {
                e.preventDefault();
                const el = e.currentTarget;
                const { selectionStart: a, selectionEnd: b } = el;
                const text = `${el.value.slice(0, a)}  ${el.value.slice(b)}`;
                setEditing({ ...editing, text, error: null });
                requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
              }
            }}
          />
          <div className={css.editorFoot}>
            <span
              className={clsx(css.editorStatus, (editing.error || (parsed && "error" in parsed)) && css.danger)}
              role="status"
            >
              {editing.error ?? (parsed && "error" in parsed ? parsed.error : "")}
            </span>
            <Button size="small" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              size="small"
              variant="primary"
              disabled={!parsed || "error" in parsed || editing.saving}
              onClick={() => void save()}
              title="⌘↵"
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className={css.flyTabs}>
            <Tabs
              variant="compact"
              aria-label={tx("View")}
              items={[
                { id: "table", label: tx("Table") },
                { id: "json", label: "JSON" },
              ]}
              activeId={tab}
              onSelect={(t) => setTab(t as "table" | "json")}
              trailing={
                tab === "table" ? (
                  <label className={css.flySearch}>
                    <Icon name="search" size={12} />
                    <Input
                      variant="bare"
                      aria-label="Filter fields"
                      placeholder={tx("Filter fields")}
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
                ) : undefined
              }
            />
          </div>
          {tab === "table" ? (
            <div className={css.docTable} role="table" aria-label={tx("Fields")}>
              {meta.map((k) => fieldRow(k, hit[k], true))}
              {names.map((k) => fieldRow(k, fieldValue(row, k), false))}
              {!names.length && !meta.length && (
                <div className={css.popupNote}>
                  <T>No fields match</T>
                </div>
              )}
            </div>
          ) : (
            <JsonView key={id} value={doc} expandDepth={3} className={css.flyJson} aria-label="Document JSON" />
          )}
        </>
      )}
    </section>
  );
}
