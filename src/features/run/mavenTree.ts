/**
 * Maven runs in the Run tool window show IDEA's build tree (`MavenBuildEventProcessor`):
 * the reactor's projects and goals with their compiler messages, beside the console.
 */
import type { RunConfig } from "@/platform/ipc";
import { MavenOutputParser } from "@/features/build/exec/maven";
import { ExecTree, finishedAtHint } from "@/features/build/exec/tree";
import { useProject } from "@/platform/project";
import { runDirectory } from "./navigate";

export interface MavenRunTree {
  tree: ExecTree;
  parser: MavenOutputParser;
}

/** Test runs keep the test tree; other Maven runs get the build tree. */
export function mavenRunTree(config: RunConfig): MavenRunTree | null {
  if (config.kind !== "maven" || config.isTest) return null;
  const tree = new ExecTree(config.name, Date.now(), useProject.getState().project?.root ?? null);
  const cwd = runDirectory(config.cwd);
  const parser = new MavenOutputParser(tree, {
    mode: "run",
    resolvePath: (p) => (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) ? p : `${cwd}/${p}`),
  });
  return { tree, parser };
}

/** The process exited (or never started): closes the tree with IDEA's "At <time>" hint. */
export function finishMavenRunTree(build: MavenRunTree, code: number | null, stopped: boolean) {
  if (!build.tree.root.running) return;
  build.parser.finish(code, stopped);
  build.tree.describe("root", "", finishedAtHint(Date.now()));
}
