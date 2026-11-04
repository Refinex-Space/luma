/**
 * The message box of the New Task page and of sessions: the "+" menu's context chips (files,
 * folders, images, commits, skills), `@` file references (project file search), `/` agent
 * commands, ↑ / ↓ history, pasted or dropped images, Shift+Tab to cycle the agent's mode. Its
 * draft lives in the store under `id`.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";
import type { AgentCommand, AgentConfigOption, AgentImage } from "@/bindings";
import { call, commands, isTauri } from "@/platform/ipc";
import { nativeDropPoint } from "@/platform/nativeDrop";
import { invokeLocal } from "@/platform/tauriCore";
import { useTx } from "@/platform/i18n";
import { basename } from "@/platform/project";
import { editorService, notifications, OWNS_FILE_DROP } from "@/workbench/contributions";
import { FileIcon } from "@/platform/FileIcon";
import { Icon, IconButton, Popup, fileIconName } from "@/ui";
import {
  IMAGE_EXTENSIONS,
  MAX_IMAGE_BYTES,
  applyCompletion,
  atEdgeLine,
  isPathQuery,
  resolveTyped,
  completionAt,
  imageFromDataUrl,
  matchCommands,
  mentionOf,
  modeOption,
  nextValue,
  recall,
  type Completion,
  type FileRef,
} from "./composerModel";
import { composerDraft, updateComposer, useAgents } from "./store";
import { ContextPicker } from "./ContextPicker";
import { addContext, contextKey, middleEllipsis, rangeLabel, type ContextItem } from "./contextModel";
import { ImagePreview, imageSrc } from "./ImagePreview";
import styles from "./Composer.module.css";
import { isImeKey } from "@/platform/ime";

const MAX_PROMPT_HEIGHT = 280;
const MAX_ITEMS = 12;

type Item = { kind: "file"; path: string; rel: string; dir?: boolean } | { kind: "command"; command: AgentCommand };

export interface ComposerProps {
  /** Store key of the draft. */
  id: string;
  placeholder: string;
  /** Directory `@` references resolve in (the task's worktree, or the project root). */
  root: string;
  /** The project root the file index covers. */
  projectRoot: string;
  commands: readonly AgentCommand[];
  /** Sent messages, newest first. */
  history: readonly string[];
  /** Settings; Shift+Tab cycles the mode one. */
  config: readonly AgentConfigOption[];
  onConfig?: (option: string, value: string) => void;
  /** `now`: ⌘↵ (send even while the agent works, interrupting it). */
  onSubmit: (now: boolean) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Left of the bottom row: agent / model / mode pickers. */
  toolbar?: ReactNode;
  /** Put `toolbar` in its own row under the frame instead of inside it (narrow tool window). */
  toolbarBelow?: boolean;
  /** Right of the bottom row: send / stop buttons. */
  actions?: ReactNode;
  className?: string;
}

export function Composer(props: ComposerProps) {
  const { id, root, projectRoot } = props;
  const tx = useTx();
  const draft = useAgents((s) => s.composers.get(id));
  const text = draft?.text ?? "";
  const images = draft?.images ?? [];
  const context = draft?.context ?? [];
  const [picking, setPicking] = useState(false);
  const plusRef = useRef<HTMLButtonElement>(null);
  // How many characters a chip shows: what the box's width leaves after its icon and ×.
  const [chipChars, setChipChars] = useState(36);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const fit = () => setChipChars(Math.max(12, Math.min(44, Math.floor((el.clientWidth - 80) / 7.5))));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [preview, setPreview] = useState<AgentImage | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [files, setFiles] = useState<Item[]>([]);
  const [active, setActive] = useState(0);
  const recalled = useRef<{ index: number; stash: string }>({ index: -1, stash: "" });

  useEffect(() => {
    if (props.autoFocus) ref.current?.focus();
  }, [props.autoFocus]);

  const focus = useAgents((s) => (s.focus?.key === id ? s.focus.seq : 0));
  useEffect(() => {
    const el = ref.current;
    if (!focus || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.scrollTop = el.scrollHeight;
  }, [focus]);

  // Grow with the text, up to a limit.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_PROMPT_HEIGHT)}px`;
  }, [text]);

  // `@` completion: project file search, mapped into the task's directory.
  useEffect(() => {
    if (completion?.kind !== "file") return;
    let alive = true;
    const query = completion.query;
    const timer = setTimeout(() => {
      if (isPathQuery(query)) {
        // Outside the index: list the directory typed so far.
        const typed = /(^|\/)\.\.?$/.test(query) ? `${query}/` : query;
        const dirPart = typed.slice(0, typed.lastIndexOf("/") + 1);
        const last = typed.slice(dirPart.length);
        call(commands.pathCompletions(`${typed.startsWith("/") ? "" : root}/_`, typed))
          .then((found) => {
            if (!alive) return;
            setFiles(
              found
                .filter((f) => f.name.toLowerCase().startsWith(last.toLowerCase()))
                .slice(0, MAX_ITEMS)
                .map((f) => {
                  const rel = `${dirPart}${f.name}`;
                  return { kind: "file", rel, dir: f.dir, path: resolveTyped(root, rel) };
                }),
            );
          })
          .catch(() => alive && setFiles([]));
        return;
      }
      call(commands.findFiles(query, MAX_ITEMS))
        .then((found) => {
          if (!alive) return;
          setFiles(
            found.map((f) => ({
              kind: "file",
              rel: f.relPath,
              path: root === projectRoot ? f.path : `${root}/${f.relPath}`,
            })),
          );
        })
        .catch(() => alive && setFiles([]));
    }, 60);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [completion?.kind, completion?.query, root, projectRoot]);

  const items: Item[] = useMemo(() => {
    if (!completion) return [];
    if (completion.kind === "file") return files;
    return matchCommands(props.commands, completion.query)
      .slice(0, MAX_ITEMS)
      .map((command) => ({ kind: "command", command }));
  }, [completion, files, props.commands]);
  const open = !!completion && items.length > 0;

  const setText = (value: string, caret?: number, restoreSelection = true) => {
    updateComposer(id, { text: value });
    const c = caret ?? value.length;
    setCompletion(completionAt(value, c));
    setActive(0);
    if (caret !== undefined && restoreSelection) {
      requestAnimationFrame(() => {
        ref.current?.focus();
        ref.current?.setSelectionRange(caret, caret);
      });
    }
  };

  const accept = (item: Item | undefined) => {
    if (!item || !completion) return;
    if (item.kind === "file" && item.dir) {
      // Descend: keep completing inside the folder.
      const insert = `${mentionOf(item.rel)}/`;
      setText(text.slice(0, completion.from) + insert + text.slice(completion.to), completion.from + insert.length);
      return;
    }
    if (item.kind === "file") {
      const mention = mentionOf(item.rel);
      const next = applyCompletion(text, completion, mention);
      const current = composerDraft(id);
      updateComposer(id, { files: [...current.files, { path: item.path, rel: item.rel } satisfies FileRef] });
      setText(next.text, next.caret);
    } else {
      const next = applyCompletion(text, completion, `/${item.command.name}`);
      setText(next.text, next.caret);
    }
    setCompletion(null);
  };

  const addImages = (list: AgentImage[]) => {
    if (list.length) updateComposer(id, { images: [...composerDraft(id).images, ...list] });
  };
  const addItems = (items: ContextItem[]) => {
    if (items.length) updateComposer(id, { context: addContext(composerDraft(id).context ?? [], items) });
  };
  const removeItem = (item: ContextItem) =>
    updateComposer(id, {
      context: (composerDraft(id).context ?? []).filter((c) => contextKey(c) !== contextKey(item)),
    });

  const readImageFiles = (picked: Iterable<File>) => {
    for (const file of picked) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > MAX_IMAGE_BYTES) {
        notifications().notify({ level: "warning", title: "Image too large", body: tx`${file.name} is over 5 MB.` });
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const image = typeof reader.result === "string" ? imageFromDataUrl(reader.result, file.name || "image") : null;
        if (image) addImages([image]);
      };
      reader.readAsDataURL(file);
    }
  };

  // Files dropped from the OS onto the box: images are attached, other files referenced.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview()
        .onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type !== "drop" || !p.paths.length) return;
          const box = boxRef.current?.getBoundingClientRect();
          const { x, y } = nativeDropPoint(p.position);
          if (!box || x < box.left || x > box.right || y < box.top || y > box.bottom) return;
          const refs: FileRef[] = [];
          for (const path of p.paths) {
            if (IMAGE_EXTENSIONS.test(path)) {
              void invokeLocal<string>("fs_read_image", { path }).then((url) => {
                const image = imageFromDataUrl(url, basename(path));
                if (image) addImages([image]);
              });
            } else {
              refs.push({ path, rel: path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path });
            }
          }
          if (refs.length) {
            const current = composerDraft(id);
            const mentions = refs.map((r) => mentionOf(r.rel)).join(" ");
            const glue = current.text && !/\s$/.test(current.text) ? " " : "";
            updateComposer(id, { text: `${current.text}${glue}${mentions} `, files: [...current.files, ...refs] });
          }
        })
        .then((u) => {
          if (disposed) u();
          else unlisten = u;
        }),
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-subscribe only when the target changes
  }, [id, root]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeKey(e.nativeEvent)) return;
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setActive((a) => (a + d + items.length) % items.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        accept(items[active]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setCompletion(null);
        return;
      }
    }
    // Backspace in an empty box takes the last chip back (an image first, as shown last).
    if (e.key === "Backspace" && !text && (context.length || images.length)) {
      e.preventDefault();
      if (context.length) removeItem(context[context.length - 1]!);
      else updateComposer(id, { images: images.slice(0, -1) });
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!props.disabled) props.onSubmit(e.metaKey || e.ctrlKey);
      recalled.current = { index: -1, stash: "" };
      return;
    }
    if (e.key === "Tab" && e.shiftKey) {
      const mode = modeOption(props.config);
      const value = mode && nextValue(mode);
      if (mode && value && props.onConfig) {
        e.preventDefault();
        props.onConfig(mode.id, value);
      }
      return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.altKey && !e.metaKey) {
      const dir = e.key === "ArrowUp" ? -1 : 1;
      const el = e.currentTarget;
      const r = recalled.current;
      // Only from an empty box or one showing a recalled message, with the caret on the edge line.
      const fresh = r.index === -1 ? text === "" : text === props.history[r.index];
      if (!fresh || !atEdgeLine(text, el.selectionStart, dir)) return;
      const next = recall(props.history, r.index, dir);
      if (next === null) return;
      e.preventDefault();
      if (r.index === -1) r.stash = text;
      r.index = next;
      const value = next === -1 ? r.stash : props.history[next]!;
      setText(value, value.length);
      setCompletion(null);
    }
  };

  const below = !!props.toolbarBelow;
  const frame = (
    <div
      ref={boxRef}
      className={clsx(styles.composer, !below && props.className)}
      {...OWNS_FILE_DROP}
      onClick={() => ref.current?.focus()}
    >
      {open && (
        // Above the box, as wide as it, growing upwards: it stays put while the text changes.
        <Popup
          open
          anchor={boxRef}
          placement="top-start"
          offset={6}
          flip={false}
          matchWidth
          autoFocus={false}
          restoreFocus={false}
          closeOnOutsideClick={false}
          onClose={() => setCompletion(null)}
          className={styles.popup}
          role="listbox"
          aria-label={tx(completion.kind === "file" ? "Files" : "Commands")}
        >
          <div className={styles.items}>
            {items.map((item, i) => (
              <div
                key={item.kind === "file" ? item.path : item.command.name}
                role="option"
                aria-selected={i === active}
                className={clsx(styles.item, i === active && styles.active)}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(item);
                }}
              >
                {item.kind === "file" ? (
                  <>
                    <Icon name={item.dir ? "folder" : fileIconName(basename(item.rel))} size={16} />
                    <span className={styles.itemName}>{basename(item.rel)}</span>
                    <span className={styles.itemDetail}>{item.rel}</span>
                  </>
                ) : (
                  <>
                    <span className={styles.itemName}>/{item.command.name}</span>
                    {item.command.hint && <span className={styles.itemHint}>{item.command.hint}</span>}
                    <span className={styles.itemDetail}>{item.command.description}</span>
                  </>
                )}
              </div>
            ))}
          </div>
        </Popup>
      )}
      {(images.length > 0 || context.length > 0) && (
        <div className={styles.chips} onClick={(e) => e.stopPropagation()}>
          {images.map((img, i) => (
            <Chip
              key={`image:${i}`}
              chars={chipChars}
              icon={<img className={styles.chipThumb} src={imageSrc(img)} alt="" />}
              label={img.name ?? tx("Image")}
              title={tx("Preview")}
              onOpen={() => setPreview(img)}
              onRemove={() => updateComposer(id, { images: images.filter((_, j) => j !== i) })}
            />
          ))}
          {context.map((item) => (
            <ContextChip key={contextKey(item)} item={item} chars={chipChars} onRemove={() => removeItem(item)} />
          ))}
          <ImagePreview image={preview} onClose={() => setPreview(null)} />
        </div>
      )}
      <textarea
        ref={ref}
        className={styles.textarea}
        rows={2}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        value={text}
        aria-label={tx("Message")}
        placeholder={tx(props.placeholder)}
        onChange={(e) => setText(e.target.value, e.target.selectionStart, false)}
        onSelect={(e) => setCompletion(completionAt(e.currentTarget.value, e.currentTarget.selectionStart))}
        onBlur={() => setCompletion(null)}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          const pasted = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
          if (pasted.length) {
            e.preventDefault();
            readImageFiles(pasted);
          }
        }}
      />
      <div className={styles.bar} onClick={(e) => e.stopPropagation()}>
        {!below && <div className={styles.toolbar}>{props.toolbar}</div>}
        <div className={styles.actions}>
          <IconButton
            ref={plusRef}
            icon="plus"
            title="Add Context"
            size="small"
            iconSize={16}
            aria-haspopup="dialog"
            aria-expanded={picking}
            onClick={() => setPicking((v) => !v)}
          />
          <ContextPicker
            open={picking}
            anchor={plusRef}
            onClose={() => {
              setPicking(false);
              ref.current?.focus();
            }}
            root={root}
            projectRoot={projectRoot}
            commands={props.commands}
            onAdd={addItems}
            onImages={addImages}
            onBrowse={() => imageInput.current?.click()}
          />
          <input
            ref={imageInput}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => {
              readImageFiles(e.target.files ?? []);
              e.target.value = "";
            }}
          />
          <span className={styles.spacer} />
          {props.actions}
        </div>
      </div>
    </div>
  );
  if (!below) return frame;
  return (
    <div className={clsx(styles.stack, props.className)}>
      {frame}
      <div className={clsx(styles.toolbar, styles.belowBar)}>{props.toolbar}</div>
    </div>
  );
}

/** A chip above the text: what goes with the message. Clicking opens it; × takes it back. */
function Chip({
  icon,
  label,
  title,
  chars,
  onOpen,
  onRemove,
}: {
  icon: ReactNode;
  label: string;
  /** Characters the label may take; longer ones are cut in the middle. */
  chars: number;
  title?: string;
  onOpen?: () => void;
  onRemove: () => void;
}) {
  const tx = useTx();
  return (
    <span className={styles.chip} title={title ?? label}>
      <button type="button" className={styles.chipMain} onClick={onOpen} disabled={!onOpen} tabIndex={onOpen ? 0 : -1}>
        <span className={styles.chipIcon}>{icon}</span>
        {/* Cut in the middle: a long name keeps its start and its end (extension, lines). */}
        <span className={styles.chipLabel}>{middleEllipsis(label, chars)}</span>
      </button>
      <button type="button" className={styles.chipRemove} aria-label={tx`Remove ${label}`} onClick={onRemove}>
        <Icon name="close" size={12} />
      </button>
    </span>
  );
}

function ContextChip({ item, chars, onRemove }: { item: ContextItem; chars: number; onRemove: () => void }) {
  switch (item.kind) {
    case "file":
      return (
        <Chip
          chars={chars}
          icon={item.dir ? <Icon name="folder" size={16} /> : <FileIcon path={item.path} size={16} />}
          label={item.lines ? rangeLabel(item.rel, item.lines) : basename(item.rel) || item.rel}
          title={item.lines ? `${item.rel}:${item.lines.from}-${item.lines.to}` : item.rel}
          onOpen={
            item.dir
              ? undefined
              : () =>
                  void editorService().openFile(item.path, {
                    focus: true,
                    // A selection opens selected again (0-based lines; through the end of its last).
                    ...(item.lines
                      ? { selection: { line: item.lines.from - 1, col: 0, endLine: item.lines.to, endCol: 0 } }
                      : {}),
                  })
          }
          onRemove={onRemove}
        />
      );
    case "commit":
      return (
        <Chip
          chars={chars}
          icon={<Icon name="commit" size={16} />}
          label={`${item.shortId} ${item.summary}`}
          title={`${item.id}\n${item.author}`}
          onRemove={onRemove}
        />
      );
    case "skill":
      return (
        <Chip
          chars={chars}
          icon={<Icon name="skill" size={16} />}
          label={`/${item.name}`}
          title={item.description}
          onRemove={onRemove}
        />
      );
    case "note":
      return (
        <Chip
          chars={chars}
          icon={<Icon name="commit" size={16} />}
          label={item.label}
          title={item.text}
          onRemove={onRemove}
        />
      );
  }
}
