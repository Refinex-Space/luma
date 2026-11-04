/**
 * The composer's "+" menu (IDEA's Add Context): search, project files and folders (browsed
 * like the Project view, with recent files first), files from the computer, a region of the
 * screen, commits and skills, then the recent files. The search field keeps the focus: ↑ / ↓
 * pick, Enter adds or opens, → opens a folder, ← (or Backspace in an empty field) goes back.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import clsx from "clsx";
import type { AgentCommand, AgentImage, Commit } from "@/bindings";
import { FileIcon } from "@/platform/FileIcon";
import { call, commands, isTauri } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { useTx } from "@/platform/i18n";
import { basename } from "@/platform/project";
import { invokeLocal } from "@/platform/tauriCore";
import { notifications } from "@/workbench/contributions";
import { Icon, Popup, Spinner } from "@/ui";
import { IMAGE_EXTENSIONS, imageFromDataUrl } from "./composerModel";
import { commitItem, matchesQuery, skillsFirst, type ContextItem } from "./contextModel";
import styles from "./ContextPicker.module.css";

const MAX_FILES = 40;
const MAX_ENTRIES = 400;
const MAX_COMMITS = 60;
const SEARCH_DELAY = 80;

type Page = { kind: "root" } | { kind: "project"; dir: string | null } | { kind: "commits" } | { kind: "skills" };

type Row =
  | { kind: "header"; label: string }
  | { kind: "separator" }
  | { kind: "note"; label: string }
  | { kind: "page"; page: Page; label: string; icon: string }
  | { kind: "upload" }
  | { kind: "screen" }
  | { kind: "file"; path: string; rel: string; dir: boolean }
  | { kind: "addFolder"; path: string; rel: string }
  | { kind: "commit"; commit: Commit }
  | { kind: "skill"; command: AgentCommand };

const selectable = (r: Row) => r.kind !== "header" && r.kind !== "separator" && r.kind !== "note";

export interface ContextPickerProps {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** The task's directory: chips point into it (a worktree task's own checkout). */
  root: string;
  /** The project root the file index and recent files cover. */
  projectRoot: string;
  commands: readonly AgentCommand[];
  onAdd: (items: ContextItem[]) => void;
  onImages: (images: AgentImage[]) => void;
  /** Without the system file dialog (the browser): pick images with the page's file input. */
  onBrowse: () => void;
}

export function ContextPicker(props: ContextPickerProps) {
  if (!props.open) return null;
  return <PickerPopup {...props} />;
}

function PickerPopup({
  anchor,
  onClose,
  root,
  projectRoot,
  commands: agentCommands,
  onAdd,
  onImages,
  onBrowse,
}: ContextPickerProps) {
  const tx = useTx();
  const [stack, setStack] = useState<Page[]>([{ kind: "root" }]);
  const page = stack[stack.length - 1]!;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const data = usePageData(page, query, root, projectRoot);

  // A path in the task's directory for a project-relative one.
  const inRoot = (rel: string, path: string) => (root === projectRoot ? path : `${root}/${rel}`);
  const relOf = (path: string) => (path.startsWith(`${projectRoot}/`) ? path.slice(projectRoot.length + 1) : path);
  const fileRow = (path: string, dir = false): Row => {
    const rel = relOf(path);
    return { kind: "file", path: inRoot(rel, path), rel, dir };
  };

  const { skills, others } = useMemo(() => skillsFirst(agentCommands), [agentCommands]);
  const skillRows = (q: string): Row[] => {
    const match = (c: AgentCommand) => !q || matchesQuery(`${c.name} ${c.description}`, q);
    const s = skills.filter(match);
    const o = others.filter(match);
    return [
      ...(s.length
        ? [{ kind: "header", label: tx("Skills") } as Row, ...s.map((command) => ({ kind: "skill", command }) as Row)]
        : []),
      ...(o.length
        ? [{ kind: "header", label: tx("Commands") } as Row, ...o.map((command) => ({ kind: "skill", command }) as Row)]
        : []),
    ];
  };

  // The system's own region capture: macOS `screencapture`, the Windows Snipping overlay.
  const os = usePlatform((s) => s.os);
  const canScreen = isTauri() && (os === "macos" || os === "windows");
  const rows: Row[] = useMemo(() => {
    const recent = (data.recent ?? []).map((p) => fileRow(p));
    switch (page.kind) {
      case "root": {
        if (query.trim()) {
          const files = (data.found ?? []).map((f) => fileRow(f.path));
          const found: Row[] = [
            ...(files.length ? [{ kind: "header", label: tx("Files") } as Row, ...files] : []),
            ...skillRows(query),
          ];
          return found.length ? found : data.loading ? [] : [{ kind: "note", label: tx("Nothing found") }];
        }
        const nav: Row[] = [
          {
            kind: "page",
            page: { kind: "project", dir: null },
            label: tx("Project Files and Folders"),
            icon: "toolwindow-structure",
          },
          { kind: "upload" },
          ...(canScreen ? [{ kind: "screen" } as Row] : []),
          { kind: "page", page: { kind: "commits" }, label: tx("Commit…"), icon: "commit" },
          ...(agentCommands.length
            ? [{ kind: "page", page: { kind: "skills" }, label: tx("Skills"), icon: "skill" } as Row]
            : []),
        ];
        return recent.length
          ? [...nav, { kind: "separator" }, { kind: "header", label: tx("Recent Files") }, ...recent]
          : nav;
      }
      case "project": {
        if (page.dir === null && query.trim()) {
          const files = (data.found ?? []).map((f) => fileRow(f.path));
          return files.length ? files : data.loading ? [] : [{ kind: "note", label: tx("Nothing found") }];
        }
        const entries = (data.entries ?? [])
          .filter((e) => !query.trim() || matchesQuery(e.name, query))
          .map((e) => fileRow(e.path, e.kind === "dir"));
        if (page.dir === null)
          return [
            ...(recent.length ? [{ kind: "header", label: tx("Recent Files") } as Row, ...recent] : []),
            { kind: "header", label: tx("Project Files and Folders") },
            ...entries,
          ];
        const here = `${projectRoot}/${page.dir}`;
        return [
          ...(query.trim() ? [] : [{ kind: "addFolder", path: inRoot(page.dir, here), rel: page.dir } as Row]),
          ...entries,
          ...(entries.length || data.loading
            ? []
            : [{ kind: "note", label: tx(query.trim() ? "Nothing found" : "Empty folder") } as Row]),
        ];
      }
      case "commits": {
        const found = (data.commits ?? []).map((commit) => ({ kind: "commit", commit }) as Row);
        return found.length ? found : data.loading ? [] : [{ kind: "note", label: tx("No commits") }];
      }
      case "skills": {
        const found = skillRows(query);
        return found.length ? found : [{ kind: "note", label: tx("Nothing found") }];
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- derived from the page's data
  }, [page, query, data, skills, others, canScreen, tx]);

  const picks = rows.flatMap((r, i) => (selectable(r) ? [i] : []));
  const activeRow = picks.length ? picks[Math.min(active, picks.length - 1)]! : -1;

  // Keep the active item in view.
  useEffect(() => {
    list.current?.querySelector(`[data-row="${activeRow}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeRow]);

  // A new page or query starts at its first item.
  const search = (q: string) => {
    setQuery(q);
    setActive(0);
  };
  const go = (next: Page) => {
    setStack((s) => [...s, next]);
    search("");
    input.current?.focus();
  };
  const back = () => {
    if (stack.length < 2) return false;
    setStack((s) => s.slice(0, -1));
    search("");
    return true;
  };
  const add = (items: ContextItem[]) => {
    onAdd(items);
    onClose();
  };

  const upload = async () => {
    onClose();
    if (!isTauri()) return onBrowse();
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: true,
      directory: false,
      title: tx("Upload from Computer"),
      defaultPath: root,
    });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    const files: ContextItem[] = [];
    for (const path of paths) {
      if (IMAGE_EXTENSIONS.test(path)) {
        void invokeLocal<string>("fs_read_image", { path })
          .then((url) => {
            const image = imageFromDataUrl(url, basename(path));
            if (image) onImages([image]);
          })
          .catch((e: unknown) =>
            notifications().notify({ level: "warning", title: "Couldn't attach the image", body: String(e) }),
          );
      } else {
        const rel = relOf(path);
        files.push({
          kind: "file",
          path: path.startsWith(`${projectRoot}/`) ? inRoot(rel, path) : path,
          rel,
          dir: false,
        });
      }
    }
    if (files.length) onAdd(files);
  };

  const screen = async () => {
    onClose();
    try {
      const url = await call(commands.screenCapture());
      const image = url && imageFromDataUrl(url, tx("Screenshot") + ".png");
      if (image) onImages([image]);
    } catch (e) {
      notifications().notify({ level: "warning", title: "Couldn't capture the screen", body: String(e) });
    }
  };

  const activate = (row: Row | undefined, how: "enter" | "right" = "enter") => {
    if (!row) return;
    switch (row.kind) {
      case "page":
        return go(row.page);
      case "upload":
        return void upload();
      case "screen":
        return void screen();
      case "file":
        if (row.dir && (how === "right" || page.kind === "project" || page.kind === "root"))
          return go({ kind: "project", dir: row.rel });
        return add([{ kind: "file", path: row.path, rel: row.rel, dir: row.dir }]);
      case "addFolder":
        return add([{ kind: "file", path: row.path, rel: row.rel, dir: true }]);
      case "commit":
        return add([commitItem(row.commit)]);
      case "skill":
        return add([{ kind: "skill", name: row.command.name, description: row.command.description }]);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const move = (d: number) => {
      e.preventDefault();
      if (picks.length) setActive((a) => (Math.min(a, picks.length - 1) + d + picks.length) % picks.length);
    };
    if (e.key === "ArrowDown") return move(1);
    if (e.key === "ArrowUp") return move(-1);
    if (e.key === "Enter") {
      e.preventDefault();
      return activate(rows[activeRow]);
    }
    const row = rows[activeRow];
    const caretAtEnd = e.currentTarget.selectionStart === query.length;
    if (e.key === "ArrowRight" && caretAtEnd && row && (row.kind === "page" || (row.kind === "file" && row.dir))) {
      e.preventDefault();
      return activate(row, "right");
    }
    if ((e.key === "ArrowLeft" && e.currentTarget.selectionStart === 0) || (e.key === "Backspace" && !query)) {
      if (back()) e.preventDefault();
    }
  };

  const placeholder = page.kind === "root" ? tx("Search for context to add") : tx("Search");
  return (
    <Popup
      open
      anchor={anchor}
      placement="top-start"
      offset={6}
      onClose={onClose}
      className={styles.picker}
      role="dialog"
      aria-label={tx("Add Context")}
    >
      <div className={styles.search}>
        {stack.length > 1 && (
          <button
            type="button"
            className={styles.back}
            aria-label={tx("Back")}
            onClick={() => back() && input.current?.focus()}
          >
            <Icon name="chevron-left" size={16} />
          </button>
        )}
        <Icon name="search" size={16} className={styles.searchIcon} />
        <input
          ref={input}
          data-autofocus
          className={styles.input}
          value={query}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-controls="context-picker-list"
          aria-activedescendant={activeRow >= 0 ? `context-picker-${activeRow}` : undefined}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => search(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {data.loading && <Spinner size={12} />}
      </div>
      <div ref={list} id="context-picker-list" className={styles.list} role="listbox" aria-label={placeholder}>
        {rows.map((row, i) => (
          <RowView
            key={i}
            row={row}
            index={i}
            active={i === activeRow}
            page={page}
            onHover={() => {
              const at = picks.indexOf(i);
              if (at >= 0) setActive(at);
            }}
            onClick={() => activate(row)}
          />
        ))}
      </div>
    </Popup>
  );
}

function RowView({
  row,
  index,
  active,
  page,
  onHover,
  onClick,
}: {
  row: Row;
  index: number;
  active: boolean;
  page: Page;
  onHover: () => void;
  onClick: () => void;
}) {
  const tx = useTx();
  if (row.kind === "header") return <div className={styles.header}>{row.label}</div>;
  if (row.kind === "separator") return <div className={styles.separator} role="separator" />;
  if (row.kind === "note") return <div className={styles.note}>{row.label}</div>;
  let icon: React.ReactNode;
  let name: string;
  let detail: string | null = null;
  let more = false;
  switch (row.kind) {
    case "page":
      icon = <Icon name={row.icon} size={16} />;
      name = row.label;
      more = row.page.kind !== "commits";
      break;
    case "upload":
      icon = <Icon name="folder" size={16} />;
      name = tx("Upload from Computer…");
      break;
    case "screen":
      icon = <Icon name="screen-region" size={16} />;
      name = tx("Context from Screen…");
      break;
    case "file":
      icon = row.dir ? <Icon name="folder" size={16} /> : <FileIcon path={row.path} size={16} />;
      name = basename(row.rel);
      // Where it is; nothing for top-level ones, whose path is their name.
      detail = row.rel !== name ? row.rel : null;
      // Folders open where they are browsed; a search result is added as is.
      more = row.dir && (page.kind === "project" || page.kind === "root");
      break;
    case "addFolder":
      icon = <Icon name="plus" size={16} />;
      name = tx("Add This Folder");
      detail = row.rel;
      break;
    case "commit":
      icon = <Icon name="commit" size={16} />;
      name = row.commit.summary;
      detail = `${row.commit.shortId} · ${row.commit.author}`;
      break;
    case "skill":
      icon = <Icon name="skill" size={16} />;
      name = `/${row.command.name}`;
      detail = row.command.description || null;
      break;
  }
  return (
    <div
      id={`context-picker-${index}`}
      data-row={index}
      role="option"
      aria-selected={active}
      className={clsx(styles.row, active && styles.active)}
      title={detail ?? undefined}
      onMouseMove={onHover}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <span className={styles.icon}>{icon}</span>
      <span className={styles.name}>{name}</span>
      {detail && <span className={styles.detail}>{detail}</span>}
      {more && <Icon name="chevron-right" size={16} className={styles.more} />}
    </div>
  );
}

interface PageData {
  loading: boolean;
  recent?: string[];
  found?: Array<{ path: string }>;
  entries?: Array<{ name: string; path: string; kind: string }>;
  commits?: Commit[];
}

/** What a page lists: fetched when it opens or its query changes (searches debounced). */
function usePageData(page: Page, query: string, root: string, projectRoot: string): PageData {
  const q = query.trim();
  // The data is for one page and query: until the next arrives, the page is loading.
  const key = JSON.stringify([page, q]);
  const [data, setData] = useState<{ key: string; value: Omit<PageData, "loading"> } | null>(null);
  const recent = useRef<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    const set = (value: Omit<PageData, "loading">) => alive && setData({ key, value });
    const recentFiles = async () => {
      if (recent.current) return recent.current;
      const paths = await call(commands.recentFiles()).catch(() => [] as string[]);
      recent.current = paths.filter((p) => p.startsWith(`${projectRoot}/`)).slice(0, 20);
      return recent.current;
    };
    const search = () => call(commands.findFiles(q, MAX_FILES)).catch(() => []);
    const timer = setTimeout(
      async () => {
        switch (page.kind) {
          case "root":
            if (q) set({ found: await search() });
            else set({ recent: (await recentFiles()).slice(0, 8) });
            return;
          case "project": {
            if (page.dir === null && q) return set({ found: await search() });
            const dir = page.dir === null ? root : `${root}/${page.dir}`;
            const entries = await call(commands.fsReadDir(dir)).catch(() => []);
            const sorted = entries
              .filter((e) => !e.excluded)
              .sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || a.name.localeCompare(b.name))
              .slice(0, MAX_ENTRIES)
              // Listed in the task's directory; shown and added relative to the project.
              .map((e) => ({ ...e, path: root === projectRoot ? e.path : e.path.replace(root, projectRoot) }));
            return set({ entries: sorted, recent: page.dir === null ? await recentFiles() : [] });
          }
          case "commits": {
            const commits = await call(
              commands.vcsLog(null, {
                branch: null,
                path: null,
                author: null,
                text: q || null,
                skip: 0,
                limit: MAX_COMMITS,
              }),
            ).catch(() => []);
            return set({ commits });
          }
          case "skills":
            return set({});
        }
      },
      q && page.kind !== "skills" ? SEARCH_DELAY : 0,
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // `key` stands for `page` and `q`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, root, projectRoot]);
  return data?.key === key ? { loading: false, ...data.value } : { loading: true };
}
