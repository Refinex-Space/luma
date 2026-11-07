/** Opening beans and dependency graphs from the tool window, the graph and the gutter. */
import { navigateTo } from "@/editor/lsp/navigation";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands, isTauri, type Location, type SpringBeanInfo } from "@/platform/ipc";
import { editorService } from "@/workbench/contributions";
import { useSpringExplorer } from "./store";

export const GRAPH_KIND = "spring-graph";

/** A dependency graph tab: a context, and the beans it is centred on (whole context when none). */
export interface GraphInput {
  context: string | null;
  roots: string[];
  depth: number;
  title: string;
}

/** A Java file of the project, to reach its language server (the context's application class). */
function projectFile(): string | null {
  const { contexts, contextId } = useSpringExplorer.getState();
  const ctx = contexts.find((c) => c.id === contextId) ?? contexts[0];
  return ctx?.root?.path ?? null;
}

/** Opens a bean's declaration: its source, or a library bean's class file through the language server. */
export async function openBean(b: Pick<SpringBeanInfo, "location" | "handle" | "declaration">) {
  if (b.location) return navigateTo(b.location as Location);
  const path = projectFile();
  if (b.handle && path && isTauri()) {
    const location = await call(commands.springLocateAt(path, b.handle)).catch(() => null);
    if (location) return navigateTo(location);
  }
  void executeAction("editor.showHint", {
    text: tx`Cannot open ${b.declaration}: the Java language server does not know it`,
  });
}

/** Opens the Bean dependency graph of `roots` (one step around them), or of the whole context. */
export function openGraph(input: GraphInput) {
  const key = `${GRAPH_KIND}:${input.context ?? ""}:${input.roots.join(",")}`;
  void editorService().openInput({ kind: GRAPH_KIND, key, data: input });
}
