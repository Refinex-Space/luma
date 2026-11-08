/**
 * Maven console output → build event tree. IDEA reads the same events from its Maven
 * spy (`MavenSpyOutputParser`); Luma runs plain Maven, so they come from the log:
 *
 *   [INFO] ---------------< demo:core >---------------   project id
 *   [INFO] Building core 1.0                    [2/3]   version
 *   [INFO] --------------------[ jar ]----------------   packaging → project starts
 *   [INFO] --- compiler:3.13.0:compile (default-compile) @ core ---   mojo starts
 *   [ERROR] /p/App.java:[2,49] cannot find symbol        file message (javac / kotlinc)
 *   [ERROR] Failed to execute goal …:compile (default-compile) on project app: …
 *   Downloading from central: https://…/core-1.0.jar     download node
 *   [INFO] app ...................... SKIPPED            reactor summary
 *
 * Projects are named `group:artifact:packaging:version` and mojos by goal, as IDEA does.
 * In `sync` mode (Reload) there are no project / mojo steps: downloads are grouped
 * under "Downloading plugins" / "Downloading dependencies" and problems under the root.
 */
import { tx } from "@/platform/i18n";
import type { ExecNode, ExecTree, FilePosition, MessageKind } from "./tree";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const LEVEL = /^\[(INFO|WARNING|WARN|ERROR|FATAL|DEBUG)\] ?/;
const PROJECT_HEADER = /^-+< (\S+) >-+$/;
const BUILDING = /^Building (.+?)\s+(\S+?)(?:\s+\[(\d+)\/(\d+)\])?$/;
const PACKAGING = /^-+\[ (\S+) \]-+$/;
const MOJO = /^--- (\S+?):(\S+?):(\S+?) \((\S+?)\) @ (\S+) ---$/;
const MOJO_NO_VERSION = /^--- (\S+?):(\S+?) \((\S+?)\) @ (\S+) ---$/;
const FAILED_GOAL = /^Failed to execute goal (?:(\S+?):(\S+?):(\S+?):(\S+?) \((\S+?)\) )?on project (\S+?): (.*)$/;
const SUMMARY = /^(.+?) \.{2,}\s*(SUCCESS|FAILURE|SKIPPED)(?: \[.*\])?$/;
const DOWNLOAD = /^(Downloading|Downloaded) from ([^:]+): (\S+)/;
const JAVAC = /^(.+?\.(?:java|groovy|scala)):\[(\d+)(?:,(\d+))?\] ?(.*)$/;
const KOTLIN_URI = /^(?:[ew]: )?(file:\/\/\S+?\.kts?):(\d+):(\d+):? (.*)$/;
const KOTLIN_PATH = /^(?:[ew]: )?(\S+?\.kts?): \((\d+), (\d+)\):? (.*)$/;
const POM_POSITION = /@ (?:(\S+?pom\.xml), )?line (\d+), column (\d+)/;
/** Help text Maven prints after a failure. */
const NOISE =
  /^(?:-> \[Help \d+\]|\[Help \d+\] |To see the full stack trace|Re-run Maven using|For more information about the errors|After correcting the problems|\s*mvn <args> -rf|$)/;
/** Repository roots that are not part of the group path of a downloaded artifact. */
const REPO_ROOT = new Set([
  "maven2",
  "maven",
  "m2",
  "repository",
  "repositories",
  "repo",
  "content",
  "groups",
  "nexus",
  "artifactory",
  "api",
  "public",
  "releases",
  "snapshots",
]);

export interface MavenParserOptions {
  /** `run` (goals: project and mojo steps) or `sync` (Reload: downloads and problems only). */
  mode: "run" | "sync";
  /** Resolves a path Maven printed (absolute, or relative to the build directory). */
  resolvePath?: (path: string) => string;
  /** `group:artifact` → its pom.xml (POM problems point there). */
  pomOf?: (groupArtifact: string) => string | undefined;
  /** Reactor summary name → project id, for projects Maven skipped before they started. */
  projectIdOf?: (name: string) => string | undefined;
}

/** `group:artifact:extension:version` of a downloaded file's URL, or null for metadata. */
export function artifactOfUrl(url: string, repo = ""): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }
  const segs = path.split("/").filter(Boolean);
  if (segs.length < 4) return null;
  const file = segs[segs.length - 1]!;
  const version = segs[segs.length - 2]!;
  const artifact = segs[segs.length - 3]!;
  if (!file.startsWith(`${artifact}-`)) return null;
  const rest = file.slice(artifact.length + 1);
  // `artifact-version[-classifier].ext` (snapshot files carry a timestamp instead of SNAPSHOT).
  const base = version.endsWith("-SNAPSHOT") ? version.slice(0, -"-SNAPSHOT".length) : version;
  if (!rest.startsWith(base)) return null;
  const ext = /\.(tar\.gz|tar\.bz2|[^.]+)$/.exec(file)?.[1];
  if (!ext || /^(?:sha1|md5|sha256|sha512|asc)$/.test(ext)) return null;
  let group = segs.slice(0, -3);
  // Drop the repository's own path (`/maven2`, `/repository/maven-public`, `/artifactory/libs-release`).
  while (group.length > 1 && (REPO_ROOT.has(group[0]!.toLowerCase()) || group[0] === repo)) {
    const head = group[0]!.toLowerCase();
    group = group.slice(1);
    if ((head === "repository" || head === "groups" || head === "artifactory") && group.length > 1)
      group = group.slice(1);
  }
  return `${group.join(".")}:${artifact}:${ext}:${version}`;
}

const isPluginArtifact = (coord: string) => {
  const [group = "", artifact = ""] = coord.split(":");
  return (
    /-plugin$|^maven-.*-plugin/.test(artifact) || group === "org.apache.maven.plugins" || group.endsWith(".plugins")
  );
};

export class MavenOutputParser {
  private projectHeader: string | null = null;
  private building: { name: string; version: string } | null = null;
  private project: string | null = null;
  private mojo: string | null = null;
  /** artifactId → project node id. */
  private readonly projects = new Map<string, string>();
  /** Project id → its mojos by goal. */
  private readonly mojos = new Map<string, Map<string, string>>();
  /** The last message, which continuation lines extend. */
  private last: ExecNode | null = null;
  private seq = 0;
  private failedGoalSeen = false;
  /** Skipping the continuation lines of a repeated compiler message. */
  private repeating = false;
  /** Reading the detail lines of the last goal failure, and its node. */
  private details = false;
  private failure: ExecNode | null = null;
  private result: "success" | "failed" | null = null;
  private readonly downloading = new Map<string, string>();

  constructor(
    private readonly tree: ExecTree,
    private readonly options: MavenParserOptions = { mode: "run" },
  ) {}

  /** Feeds one console line (without its line break). */
  feed(raw: string, now = Date.now()) {
    const line = raw.replace(ANSI, "").replace(/\r$/, "");
    const level = LEVEL.exec(line);
    const body = level ? line.slice(level[0].length) : line;
    const kind = level?.[1];

    // Continuation lines of a multi-line message (javac's `symbol:` / `location:` lines).
    if (this.repeating) {
      const cont = level ? (kind === "ERROR" ? body : null) : line;
      if (cont !== null && /^\s+\S/.test(cont)) {
        this.outputTo(line);
        return;
      }
      this.repeating = false;
    }
    if (this.last) {
      const cont = level ? (kind === "ERROR" || kind === "WARNING" ? body : null) : line;
      if (cont !== null && /^\s+\S/.test(cont) && !JAVAC.test(cont.trim())) {
        this.tree.appendDetail(this.last.id, cont.trimEnd());
        this.outputTo(line);
        return;
      }
      this.last = null;
    }
    this.outputTo(line);

    if (this.options.mode === "run" && (!kind || kind === "INFO") && this.structure(body, now)) return;
    const download = DOWNLOAD.exec(body);
    if (download) {
      this.download(download[1] === "Downloaded", download[3]!, download[2]!, now);
      return;
    }
    if (kind === "INFO" && /^BUILD (SUCCESS|FAILURE)$/.test(body)) {
      this.result = body.endsWith("SUCCESS") ? "success" : "failed";
      return;
    }
    if (kind === "ERROR" || kind === "FATAL") this.error(body, now);
    else if (kind === "WARNING" || kind === "WARN") this.warning(body, now);
  }

  /** Project / mojo / summary lines (`run` mode); true when the line was one. */
  private structure(body: string, now: number): boolean {
    let m: RegExpExecArray | null;
    if ((m = PROJECT_HEADER.exec(body))) {
      this.projectHeader = m[1]!;
      this.building = null;
      return true;
    }
    if (this.projectHeader && !this.building && (m = BUILDING.exec(body))) {
      this.building = { name: m[1]!, version: m[2]! };
      return true;
    }
    if (this.projectHeader && this.building && (m = PACKAGING.exec(body))) {
      this.startProject(`${this.projectHeader}:${m[1]}:${this.building.version}`, now);
      this.projectHeader = null;
      this.building = null;
      return true;
    }
    if ((m = MOJO.exec(body)) || (m = MOJO_NO_VERSION.exec(body))) {
      const goal = m.length === 6 ? m[3]! : m[2]!;
      const artifact = m[m.length - 1]!;
      this.startMojo(goal, artifact, now);
      return true;
    }
    if ((m = SUMMARY.exec(body)) && m[2] === "SKIPPED") {
      const name = m[1]!.trim();
      const id = this.options.projectIdOf?.(name) ?? name;
      if (!this.tree.get(`p:${id}`)) {
        this.tree.start(`p:${id}`, null, id, now);
        this.tree.finish(`p:${id}`, "skipped", now);
      }
      return true;
    }
    return false;
  }

  private startProject(id: string, now: number) {
    this.endMojo(now);
    if (this.project) this.tree.finish(this.project, "success", now);
    const nodeId = `p:${id}`;
    this.tree.start(nodeId, null, id, now);
    this.project = nodeId;
    this.projects.set(id.split(":")[1] ?? id, nodeId);
    this.mojos.set(nodeId, new Map());
  }

  private startMojo(goal: string, artifact: string, now: number) {
    this.endMojo(now);
    if (!this.project) {
      // A single-module build without a header (old Maven): the project is known by its artifact.
      this.startProject(artifact, now);
    }
    const id = `${this.project}\u0000g${this.seq++}`;
    this.tree.start(id, this.project, goal, now);
    this.mojos.get(this.project!)?.set(goal, id);
    this.mojo = id;
  }

  private endMojo(now: number) {
    this.endDownloads(now);
    if (!this.mojo) return;
    const node = this.tree.get(this.mojo);
    if (node?.running) this.tree.finish(this.mojo, "success", now);
    this.mojo = null;
  }

  /** Where messages and output of the current line go. */
  private get current(): string | null {
    return this.mojo ?? this.project;
  }

  private outputTo(line: string) {
    this.tree.output(this.current, line);
  }

  private resolve(path: string): string {
    const p = path.startsWith("file://") ? decodeURIComponent(path.replace(/^file:\/\//, "")) : path;
    return this.options.resolvePath?.(p) ?? p;
  }

  /** A compiler message with a file position, or null. */
  private fileMessage(body: string): { file: FilePosition; text: string } | null {
    let m = JAVAC.exec(body);
    if (m && /[/\\]/.test(m[1]!))
      return {
        file: { path: this.resolve(m[1]!), line: Number(m[2]) - 1, col: m[3] ? Number(m[3]) - 1 : null },
        text: m[4]!.trim(),
      };
    m = KOTLIN_URI.exec(body) ?? KOTLIN_PATH.exec(body);
    if (m)
      return {
        file: { path: this.resolve(m[1]!), line: Number(m[2]) - 1, col: Number(m[3]) - 1 },
        text: m[4]!.trim(),
      };
    return null;
  }

  private error(body: string, now: number) {
    const failed = FAILED_GOAL.exec(body);
    if (failed) {
      this.failedGoalSeen = true;
      this.failGoal(failed[4] ?? null, failed[6]!, failed[7]!, now);
      this.details = true;
      return;
    }
    // The lines after "Failed to execute goal" up to an empty one say why (resolution failures).
    if (this.details) {
      if (!body.trim()) {
        this.details = false;
        return;
      }
      if (this.failure && !JAVAC.test(body) && !NOISE.test(body)) {
        this.tree.appendDetail(this.failure.id, body.trim());
        return;
      }
    }
    const fm = this.fileMessage(body);
    if (fm) {
      // After "Failed to execute goal" Maven repeats the compiler errors: already reported.
      if (this.failedGoalSeen) {
        this.repeating = true;
        return;
      }
      this.add("error", this.current, fm.text, fm.file, now);
      return;
    }
    if (NOISE.test(body) || /^COMPILATION (ERROR|WARNING) :?\s*$/.test(body) || /^\[(ERROR|FATAL)\]\s*$/.test(body))
      return;
    if (this.options.mode === "sync" || !this.project || this.failedGoalSeen) {
      // Problems outside a mojo (POM errors, resolution failures) are shown; output of a
      // running mojo stays in its console, its failure reaches the tree through "Failed to execute goal".
      this.add("error", this.syncParent(), body.replace(/^\[(ERROR|FATAL)\] /, ""), this.pomPosition(body), now);
    }
  }

  private warning(body: string, now: number) {
    const fm = this.fileMessage(body);
    if (fm) {
      this.add("warning", this.current, fm.text, fm.file, now);
      return;
    }
    if (!body.trim() || /^COMPILATION WARNING :?\s*$/.test(body)) return;
    if (this.options.mode === "sync") {
      // Model problems ("'dependencies.dependency.version' … is missing. @ line 12, column 21").
      if (/^Some problems were encountered|^It is highly recommended|^For this reason, future Maven/.test(body)) return;
      this.add("warning", null, body, this.pomPosition(body), now);
      return;
    }
    this.add("warning", this.current, body, null, now);
  }

  private syncParent(): string | null {
    return this.options.mode === "sync" ? null : this.current;
  }

  private pomPosition(body: string): FilePosition | null {
    const m = POM_POSITION.exec(body);
    if (!m) return null;
    let path = m[1] ? this.resolve(m[1]) : undefined;
    if (!path) {
      const id = /for (\S+?:\S+?)(?::\S+)*\s/.exec(body)?.[1];
      path = id ? this.options.pomOf?.(id) : undefined;
    }
    return path ? { path, line: Number(m[2]) - 1, col: Number(m[3]) - 1 } : null;
  }

  private failGoal(goal: string | null, artifact: string, message: string, now: number) {
    const project = this.projects.get(artifact) ?? this.project;
    const mojo = goal && project ? this.mojos.get(project)?.get(goal) : undefined;
    const target = mojo ?? project;
    const text = message.replace(/\s*->\s*\[Help \d+\]\s*$/, "").trim();
    // A compilation failure's errors are already under the mojo; other failures say why.
    this.failure = null;
    if (!/^Compilation failure:?$/.test(text) || !this.tree.get(target ?? "root")?.errors)
      this.failure = this.tree.message(target, "error", text || tx("Failed"), null, now);
    if (mojo) this.tree.finish(mojo, "failed", now);
    if (project) this.tree.finish(project, "failed", now);
    if (project === this.project) {
      this.project = null;
      this.mojo = null;
    }
  }

  private add(severity: MessageKind, parent: string | null, text: string, file: FilePosition | null, now: number) {
    this.last = this.tree.message(parent, severity, text, file, now);
  }

  private download(done: boolean, url: string, repo: string, now: number) {
    const coord = artifactOfUrl(url, repo);
    if (!coord) return;
    const group =
      this.options.mode === "sync"
        ? `root\u0000dl:${isPluginArtifact(coord) ? "plugins" : "dependencies"}`
        : `${this.current ?? "root"}\u0000dl`;
    const groupName =
      this.options.mode === "sync"
        ? isPluginArtifact(coord)
          ? tx("Downloading plugins")
          : tx("Downloading dependencies")
        : tx("dependencies");
    const parent = this.options.mode === "sync" ? null : this.current;
    if (!this.tree.get(group)) {
      this.tree.start(group, parent, groupName, now);
      this.downloading.set(group, group);
    }
    const id = `${group}\u0000${coord}`;
    if (!done) this.tree.start(id, group, coord, now);
    else if (this.tree.get(id)?.running) this.tree.finish(id, "success", now);
  }

  private endDownloads(now: number) {
    for (const group of this.downloading.keys()) {
      const node = this.tree.get(group);
      if (node?.running && !node.children.some((c) => c.running)) this.tree.finish(group, "success", now);
    }
    this.downloading.clear();
  }

  /** The process exited: closes the open steps and the build. */
  finish(exitCode: number | null, cancelled = false, now = Date.now()) {
    this.last = null;
    const ok = !cancelled && exitCode === 0 && this.result !== "failed";
    if (ok) {
      this.endMojo(now);
      if (this.project) this.tree.finish(this.project, "success", now);
    } else if (!cancelled && !this.tree.root.errors && this.result !== "success") {
      this.tree.message(
        null,
        "error",
        exitCode == null ? tx("Build failed") : tx`Process finished with exit code ${exitCode}`,
        null,
        now,
      );
    }
    this.endDownloads(now);
    this.tree.finishBuild(cancelled ? "skipped" : ok ? "success" : "failed", now);
  }
}
