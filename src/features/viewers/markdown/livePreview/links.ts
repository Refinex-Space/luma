/** Following a link from the live preview: web pages in the browser, files in an editor, `#anchors` in this one. */
import type { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { isTauri } from "@/platform/ipc";
import { maybeEditorService } from "@/workbench/contributions";
import { resolveLink, slugify } from "../render";

function openExternal(url: string) {
  if (isTauri()) void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(url)).catch(() => {});
  else window.open(url, "_blank", "noopener");
}

/** The position of the heading whose GitHub anchor is `anchor`, or -1. */
export function headingPos(view: EditorView, anchor: string): number {
  const want = slugify(anchor);
  const seen = new Map<string, number>();
  let found = -1;
  syntaxTree(view.state).iterate({
    enter(n) {
      if (found >= 0) return false;
      if (!/^(ATX|Setext)Heading\d$/.test(n.name)) return n.name === "Document" || undefined;
      const line = view.state.doc.lineAt(n.from);
      const text = line.text.replace(/^\s{0,3}#{1,6}\s*/, "").replace(/\s+#+\s*$/, "");
      const base = slugify(text);
      const k = seen.get(base) ?? 0;
      seen.set(base, k + 1);
      if ((k ? `${base}-${k}` : base) === want) found = n.from;
      return false;
    },
  });
  return found;
}

/** Opens `href` written in the Markdown file `doc` shown by `view`. */
export function followLink(view: EditorView, doc: string, href: string) {
  const target = resolveLink(doc, href);
  if (!target) return;
  const jump = (anchor: string) => {
    const pos = headingPos(view, anchor);
    if (pos >= 0) view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  };
  if (target.kind === "external") openExternal(target.url);
  else if (target.kind === "anchor") jump(target.id);
  else if (target.path === doc && target.anchor) jump(target.anchor);
  else
    void maybeEditorService()?.openFile(target.path, {
      focus: true,
      ...(target.line !== undefined ? { selection: { line: target.line, col: 0 } } : {}),
    });
}
