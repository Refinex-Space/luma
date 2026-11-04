/**
 * Text editor wrapper of Markdown files: the editor, a live preview, or both
 * side by side, switched from the tab strip or a floating toolbar. The
 * preview follows the editor's scroll position in the split layout.
 */
import {
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { call, commands, isTauri } from "@/platform/ipc";
import { maybeEditorService } from "@/workbench/contributions";
import { editorsFor } from "@/editor/api";
import { highlightInto } from "@/editor/lsp/markdown";
import { copyText, FloatingToolbar, selectableText } from "@/ui";
import { iconMarkup } from "@/ui/icons";
import { BackToTop, MarkdownOutline } from "./DocumentNav";
import { useLiveMarkdown } from "./live";
import { renderMathIn } from "./math";
import { openMediaViewer } from "./media/mediaViewer";
import { hasMermaid, MERMAID_SELECTOR, renderMermaidIn, subscribeTheme, themeKey } from "./mermaid";
import { modeOf, useMarkdownModes } from "./modes";
import { MarkdownLayoutActions } from "./MarkdownLayoutActions";
import { ANCHOR_PREFIX, previewOffsetForLine, renderMarkdown, resolveLink, slugify, toggleTaskSource } from "./render";
import styles from "./Markdown.module.css";
import { tx } from "@/platform/i18n";

/** Loaded local images by absolute path (data URLs), shared by all previews. */
const imageCache = new Map<string, Promise<string>>();
const IMAGE_CACHE_LIMIT = 64;

function imageUrl(path: string): Promise<string> {
  let p = imageCache.get(path);
  if (!p) {
    p = call(commands.fsReadImage(path));
    p.catch(() => imageCache.delete(path));
    if (imageCache.size >= IMAGE_CACHE_LIMIT) imageCache.delete(imageCache.keys().next().value!);
    imageCache.set(path, p);
  }
  return p;
}

function openExternal(url: string) {
  if (isTauri()) void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(url)).catch(() => {});
  else window.open(url, "_blank", "noopener");
}

export function MarkdownEditor({
  path,
  tabId,
  children,
  actionsInTabs = false,
}: {
  path: string;
  tabId: string;
  children: ReactNode;
  actionsInTabs?: boolean;
}) {
  const mode = useMarkdownModes((s) => modeOf(s, path));
  const ref = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className={clsx(styles.split, styles[`mode-${mode}`])}>
      <div ref={main} className={styles.main}>
        <div className={styles.editor}>{children}</div>
        {(mode === "split" || mode === "preview") && <MarkdownPreview path={path} sync={mode === "split"} />}
        <BackToTop path={path} mode={mode} rootRef={main} />
      </div>
      <MarkdownOutline path={path} mode={mode} rootRef={ref} />
      {!actionsInTabs && (
        <FloatingToolbar targetRef={ref}>
          <MarkdownLayoutActions path={path} tabId={tabId} />
        </FloatingToolbar>
      )}
    </div>
  );
}

/** Toggles the task item on 0-based source `line` in an open editor of `path`. */
function toggleTask(path: string, line: number) {
  const editor = editorsFor(path).find((e) => !e.ctx.readOnly);
  if (!editor) return;
  const { view } = editor;
  if (view.state.readOnly || line + 1 > view.state.doc.lines) return;
  const target = view.state.doc.line(line + 1);
  const toggle = toggleTaskSource(target.text);
  if (!toggle) return;
  const at = target.from + toggle.at;
  view.dispatch({ changes: { from: at, to: at + 1, insert: toggle.mark }, userEvent: "input.toggle" });
}

/** Copy buttons on code blocks and "view larger" buttons on drawn diagrams (once per element). */
function decorate(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>(".code-block").forEach((block) => {
    if (block.querySelector(":scope > .code-copy")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy";
    button.title = tx("Copy");
    button.setAttribute("aria-label", tx("Copy"));
    button.innerHTML = iconMarkup("copy", 14) ?? "";
    block.append(button);
  });
  root.querySelectorAll<HTMLElement>(MERMAID_SELECTOR).forEach((block) => {
    if (block.querySelector(":scope > .diagram-view")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "diagram-view";
    button.title = tx("View Larger");
    button.setAttribute("aria-label", tx("View Larger"));
    button.innerHTML = iconMarkup("maximize", 14) ?? "";
    block.append(button);
  });
}

function MarkdownPreview({ path, sync }: { path: string; sync: boolean }) {
  const text = useLiveMarkdown((s) => s[path]?.text);
  const fontZoom = useLiveMarkdown((s) => s[path]?.fontZoom ?? 0);
  const topLine = useLiveMarkdown((s) => s[path]?.topLine ?? 0);
  const scrollSeq = useLiveMarkdown((s) => s[path]?.scrollSeq ?? 0);
  const deferred = useDeferredValue(text ?? "");
  const html = useMemo(() => renderMarkdown(deferred), [deferred]);
  const ref = useRef<HTMLDivElement>(null);
  const theme = useSyncExternalStore(subscribeTheme, themeKey, () => "");
  const diagrams = useRef<Node[]>([]);
  // Bumped when diagrams or math change the layout after the first paint (scroll sync re-runs).
  const [reflows, setReflows] = useState(0);

  // Mermaid diagrams and math: before paint, so cached ones don't flash their source.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    let live = true;
    const math = renderMathIn(root);
    if (math) void math.then(() => live && setReflows((n) => n + 1));
    decorate(root);
    if (!hasMermaid(root)) return;
    const pass = renderMermaidIn(root, diagrams.current);
    if (pass.async) void pass.done.then(() => live && setReflows((n) => n + 1));
    return () => {
      live = false;
      pass.cancel();
    };
  }, [html, theme]);

  // Images and code highlighting after each render.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let live = true;
    root.querySelectorAll<HTMLImageElement>("img[data-src]").forEach((img) => {
      const src = img.dataset.src ?? "";
      if (/^data:image\//i.test(src)) {
        img.src = src;
        return;
      }
      const target = resolveLink(path, src);
      if (target?.kind !== "file") {
        img.classList.add(styles.blocked!);
        img.title = tx("Remote images are not loaded");
        return;
      }
      imageUrl(target.path).then(
        (url) => live && (img.src = url),
        () => live && img.classList.add(styles.blocked!),
      );
    });
    root.querySelectorAll<HTMLElement>("pre > code").forEach((code) => {
      if (code.closest(MERMAID_SELECTOR)) return;
      const lang = [...code.classList].find((c) => c.startsWith("language-"))?.slice("language-".length) ?? null;
      const src = (code.textContent ?? "").replace(/\n+$/, "");
      code.textContent = src;
      void highlightInto(code, src, lang);
    });
    return () => {
      live = false;
    };
  }, [html, path]);

  // Scroll sync: editor → preview.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !sync) return;
    const blocks = [...root.querySelectorAll<HTMLElement>(":scope > div > [data-line]")].map((el) => ({
      line: Number(el.dataset.line),
      top: el.offsetTop,
    }));
    root.scrollTop = topLine <= 0 ? 0 : previewOffsetForLine(blocks, topLine, root.scrollHeight);
  }, [html, topLine, scrollSeq, sync, reflows]);

  const onClick = (e: MouseEvent) => {
    const target = e.target as Element;
    const checkbox = target.closest<HTMLInputElement>("input.task-checkbox");
    if (checkbox) {
      // The source decides: the box shows the toggled state once the edit is rendered.
      e.preventDefault();
      const line = Number(checkbox.closest<HTMLElement>("[data-task-line]")?.dataset.taskLine);
      if (Number.isInteger(line)) toggleTask(path, line);
      return;
    }
    const copy = target.closest<HTMLButtonElement>("button.code-copy");
    if (copy) {
      const code = copy.parentElement?.querySelector("pre > code")?.textContent ?? "";
      void copyText(code).then(() => {
        copy.dataset.copied = "";
        copy.innerHTML = iconMarkup("check", 14) ?? "";
        copy.title = tx("Copied");
        window.setTimeout(() => {
          delete copy.dataset.copied;
          copy.innerHTML = iconMarkup("copy", 14) ?? "";
          copy.title = tx("Copy");
        }, 1200);
      });
      return;
    }
    const diagram = target.closest<HTMLButtonElement>("button.diagram-view");
    if (diagram) {
      const svg = diagram.parentElement?.querySelector(".mermaid-output svg");
      if (svg) openMediaViewer({ kind: "svg", svg: svg.outerHTML, name: "Mermaid" });
      return;
    }
    const a = target.closest("a");
    if (!a) {
      const img = target.closest("img");
      if (img?.src && !img.classList.contains(styles.blocked!)) {
        const source = img.dataset.src ?? "";
        const name = img.alt || decodeURIComponent(source.slice(source.lastIndexOf("/") + 1)) || tx("Image");
        openMediaViewer({ kind: "image", src: img.src, name });
      }
      return;
    }
    e.preventDefault();
    const link = resolveLink(path, a.getAttribute("href") ?? "");
    if (!link) return;
    const scrollTo = (id: string) =>
      ref.current
        ?.querySelector(`[id="${CSS.escape(ANCHOR_PREFIX + slugify(id))}"]`)
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
    if (link.kind === "external") openExternal(link.url);
    else if (link.kind === "anchor") scrollTo(link.id);
    else if (link.path === path && link.anchor) scrollTo(link.anchor);
    else
      void maybeEditorService()?.openFile(link.path, {
        focus: true,
        ...(link.line !== undefined ? { selection: { line: link.line, col: 0 } } : {}),
      });
  };

  return (
    <div
      ref={ref}
      className={clsx(styles.preview, selectableText)}
      style={{ "--markdown-font-zoom": `${fontZoom}px` } as CSSProperties}
      tabIndex={-1}
      role="document"
      aria-label={tx("Markdown preview")}
      onClick={onClick}
    >
      <div className={styles.page} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
