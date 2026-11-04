/** "Send to Agent": the editor selection or Project view files, as composer chips. */
import { activeEditor } from "@/editor/api";
import { useProject } from "@/platform/project";
import { isVirtualUri } from "@/platform/virtualDocs";
import { call, commands } from "@/platform/ipc";
import { addReferences } from "./store";

/** Whether `path` is a folder (a chip shows it so); a file when that can't be told. */
const isDir = (path: string) =>
  call(commands.fsEntryKind(path))
    .then((k) => k === "dir")
    .catch(() => false);

const relTo = (root: string, path: string) => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null);

/** The active editor's file, with the selected lines when there is a selection. */
export function sendSelection(): boolean {
  const handle = activeEditor();
  const root = useProject.getState().project?.root;
  if (!handle || !root || isVirtualUri(handle.ctx.path)) return false;
  const rel = relTo(root, handle.ctx.path);
  if (!rel) return false;
  const { state } = handle.view;
  const sel = state.selection.main;
  // A selection ending at a line start does not include that line.
  const end = sel.to > sel.from && state.doc.lineAt(sel.to).from === sel.to ? sel.to - 1 : sel.to;
  const lines = sel.empty ? undefined : { from: state.doc.lineAt(sel.from).number, to: state.doc.lineAt(end).number };
  const code = lines ? state.sliceDoc(state.doc.line(lines.from).from, state.doc.line(lines.to).to) : undefined;
  addReferences([{ kind: "file", path: handle.ctx.path, rel, dir: false, lines, code }]);
  return true;
}

/** Files and folders from the Project view. */
export async function sendPaths(paths: readonly string[]): Promise<boolean> {
  const root = useProject.getState().project?.root;
  if (!root) return false;
  const dirs = await Promise.all(paths.map((p) => isDir(p)));
  const refs = paths.flatMap((path, i) => {
    const rel = relTo(root, path);
    return rel ? [{ kind: "file" as const, path, rel, dir: dirs[i]! }] : [];
  });
  if (refs.length) addReferences(refs);
  return refs.length > 0;
}
