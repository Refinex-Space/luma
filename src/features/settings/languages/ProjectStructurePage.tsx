/**
 * Settings › Project Structure (IDEA's module "Sources" tab): the content
 * root's Sources / Tests / Resources / Test Resources / Excluded folders.
 * Roots detected from build files (`pom.xml`, `build.gradle`, `Cargo.toml`,
 * `go.mod`, `pyproject.toml`, `package.json`) apply until the user marks or
 * unmarks the folder (`projectStructure.*`, project scope). Roots drive the
 * project tree icons, package inference for new classes, the "Project
 * Production / Test Files" scopes, and Excluded folders are skipped by the
 * tree, Find in Files and indexing. Content roots besides the project folder
 * (`projectStructure.contentRoots`) are listed in the Project view and searched
 * by Find in Files; "Exclude files" name patterns (`projectStructure.excludeFiles`)
 * are hidden from the tree and skipped by search and indexing.
 */
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import clsx from "clsx";
import { Button, Icon, IconButton, Input, Tree, folderIconName, type FolderKind, T } from "@/ui";
import { call, commands, isTauri, type FileEntry } from "@/platform/ipc";
import { relativePath, useProject } from "@/platform/project";
import {
  PROJECT_STRUCTURE_KEYS,
  effectiveRoots,
  markFolder,
  restoreDetected,
  rootRole,
  unmarkedRoots,
  type FolderListKey,
  type FolderRole,
  type ProjectStructureValid,
} from "@/platform/languageSettings";
import { initProjectRoots, useDetectedRoots } from "@/platform/projectRoots";
import { choosePath } from "./api";
import { tildify, useProjectSetting } from "./components";
import styles from "./Sdk.module.css";
import { tx } from "@/platform/i18n";

interface DirNode {
  path: string;
  name: string;
  /** Project-relative; null outside the project (another content root). */
  rel: string | null;
  /** A content root besides the project folder. */
  contentRoot?: boolean;
}

const inside = (root: string, path: string) => path === root || path.startsWith(root + "/");

const ROLES: Array<{ role: FolderRole; label: string; title: string; kind: FolderKind; cls: string }> = [
  { role: "source", label: "Sources", title: "Source Folders", kind: "source", cls: styles.sourceTitle! },
  { role: "test", label: "Tests", title: "Test Source Folders", kind: "test", cls: styles.testTitle! },
  { role: "resources", label: "Resources", title: "Resource Folders", kind: "resources", cls: styles.resourcesTitle! },
  {
    role: "testResources",
    label: "Test Resources",
    title: "Test Resource Folders",
    kind: "testResources",
    cls: styles.testResourcesTitle!,
  },
  { role: "excluded", label: "Excluded", title: "Excluded Folders", kind: "excluded", cls: styles.excludedTitle! },
];

async function readDirs(root: string, path: string): Promise<DirNode[]> {
  if (!isTauri()) return [];
  const entries: FileEntry[] = await call(commands.fsReadDir(path));
  return entries
    .filter((e) => e.kind === "dir" || (e.kind === "symlink" && e.targetKind === "dir"))
    .filter((e) => e.name !== ".git")
    .map((e) => ({ path: e.path, name: e.name, rel: inside(root, e.path) ? relativePath(root, e.path) : null }));
}

function useStructure(): [ProjectStructureValid, (next: ProjectStructureValid) => void] {
  const [sourceRoots, setSource] = useProjectSetting<string[] | undefined>("projectStructure.sourceRoots");
  const [testRoots, setTest] = useProjectSetting<string[] | undefined>("projectStructure.testRoots");
  const [resourceRoots, setResources] = useProjectSetting<string[] | undefined>("projectStructure.resourceRoots");
  const [testResourceRoots, setTestResources] = useProjectSetting<string[] | undefined>(
    "projectStructure.testResourceRoots",
  );
  const [excluded, setExcluded] = useProjectSetting<string[] | undefined>("projectStructure.excluded");
  const [unmarked, setUnmarked] = useProjectSetting<string[] | undefined>("projectStructure.unmarked");
  const [contentRoots, setContentRoots] = useProjectSetting<string[] | undefined>("projectStructure.contentRoots");
  const [excludeFiles, setExcludeFiles] = useProjectSetting<string | undefined>("projectStructure.excludeFiles");
  const ps = useMemo<ProjectStructureValid>(
    () => ({
      sourceRoots: sourceRoots ?? [],
      testRoots: testRoots ?? [],
      resourceRoots: resourceRoots ?? [],
      testResourceRoots: testResourceRoots ?? [],
      excluded: excluded ?? [],
      unmarked: unmarked ?? [],
      contentRoots: contentRoots ?? [],
      excludeFiles: excludeFiles ?? "",
    }),
    [sourceRoots, testRoots, resourceRoots, testResourceRoots, excluded, unmarked, contentRoots, excludeFiles],
  );
  const set = useCallback(
    (next: ProjectStructureValid) => {
      const setters: Record<FolderListKey, (v: string[]) => void> = {
        sourceRoots: setSource,
        testRoots: setTest,
        resourceRoots: setResources,
        testResourceRoots: setTestResources,
        excluded: setExcluded,
        unmarked: setUnmarked,
      };
      for (const k of PROJECT_STRUCTURE_KEYS)
        if (JSON.stringify(next[k]) !== JSON.stringify(ps[k])) setters[k](next[k]);
      if (JSON.stringify(next.contentRoots) !== JSON.stringify(ps.contentRoots)) setContentRoots(next.contentRoots);
      if (next.excludeFiles !== ps.excludeFiles) setExcludeFiles(next.excludeFiles);
    },
    [
      ps,
      setSource,
      setTest,
      setResources,
      setTestResources,
      setExcluded,
      setUnmarked,
      setContentRoots,
      setExcludeFiles,
    ],
  );
  return [ps, set];
}

/** "+ Add Content Root" and the content roots, the project folder first (IDEA's module Sources tab). */
function ContentRoots({ root, list, onChange }: { root: string; list: string[]; onChange: (next: string[]) => void }) {
  const add = async () => {
    const picked = await choosePath({ directory: true, title: "Add Content Root", defaultPath: root });
    if (!picked || inside(root, picked) || list.includes(picked)) return;
    onChange([...list, picked]);
  };
  return (
    <div className={styles.rootGroup}>
      <Button size="small" variant="ghost" icon="plus" onClick={() => void add()}>
        <T>Add Content Root</T>
      </Button>
      <div className={clsx(styles.rootItem, styles.contentRoot)}>
        <span className={styles.rootPath} title={root}>
          {root}
        </span>
      </div>
      {list.map((r) => (
        <div key={r} className={clsx(styles.rootItem, styles.contentRoot)}>
          <span className={styles.rootPath} title={r}>
            {r}
          </span>
          <IconButton
            icon="close"
            size="small"
            iconSize={12}
            title={tx`Remove content root ${r}`}
            onClick={() => onChange(list.filter((x) => x !== r))}
          />
        </div>
      ))}
    </div>
  );
}

function ExcludeFiles({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const id = useId();
  return (
    <div className={styles.excludeFiles}>
      <label htmlFor={id}>
        <T>Exclude files:</T>
      </label>
      <Input
        id={id}
        className={styles.excludeInput}
        value={value}
        placeholder="*.log;tmp*"
        onChange={(e) => onChange(e.target.value)}
      />
      <div className={styles.excludeHint}>
        <T>Use ; to separate name patterns, * for any number of symbols, ? for one.</T>
      </div>
    </div>
  );
}

/** Stable: the folder reads below re-run when the content roots change. */
const NO_CONTENT_ROOTS: string[] = [];

export interface SourcesEditorProps {
  /** The folder the tree shows (absolute): the project folder, or a module's directory. */
  base: string;
  /** Its display name. */
  name: string;
  ps: ProjectStructureValid;
  onChange: (next: ProjectStructureValid) => void;
  /** Content roots and "Exclude files" (project-wide): shown for the project folder. */
  projectLevel?: boolean;
  /** Project-relative folders of nested modules: their roots are listed with their own module. */
  nested?: readonly string[];
  /** Fills its container's height (the Project Structure dialog) instead of a fixed height. */
  fill?: boolean;
  /** Rows above "Mark as" (the module's language level). */
  top?: ReactNode;
}

/**
 * IDEA's module "Sources" tab: the folder tree with "Mark as" and the marked folders of
 * `base`. Controlled: Settings › Project Structure stages changes in the settings form,
 * the Project Structure dialog in its own draft.
 */
export function SourcesEditor({
  base,
  name,
  ps,
  onChange: setPs,
  projectLevel,
  nested = [],
  fill,
  top,
}: SourcesEditorProps) {
  const root = useProject((s) => s.project?.root ?? null);
  const detected = useDetectedRoots();
  const roots = useMemo(() => effectiveRoots(detected, ps), [detected, ps]);
  useEffect(() => initProjectRoots(), []);
  const [children, setChildren] = useState<Map<string, DirNode[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([base]));
  // Project-relative folder of `base` ("" for the project folder) and the roots it owns.
  const baseRel = root && base !== root ? relativePath(root, base) : "";
  const within = (rel: string, dir: string) => !dir || rel === dir || rel.startsWith(`${dir}/`);
  const own = (rel: string) => within(rel, baseRel) && !nested.some((n) => n !== baseRel && within(rel, n));
  const [selected, setSelected] = useState<DirNode | null>(null);

  const load = useCallback(
    async (node: DirNode) => {
      if (!root) return;
      const dirs = await readDirs(root, node.path);
      setChildren((m) => new Map(m).set(node.path, dirs));
    },
    [root],
  );

  const rootNode = useMemo<DirNode | null>(
    () => (root ? { path: base, name, rel: base !== root ? relativePath(root, base) : "" } : null),
    [root, base, name],
  );
  const contentRoots = projectLevel ? ps.contentRoots : NO_CONTENT_ROOTS;
  const treeRoots = useMemo<DirNode[]>(
    () =>
      rootNode
        ? [
            rootNode,
            ...contentRoots.map((p) => ({
              path: p,
              name: p.slice(p.lastIndexOf("/") + 1) || p,
              rel: null,
              contentRoot: true,
            })),
          ]
        : [],
    [rootNode, contentRoots],
  );
  useEffect(() => {
    if (!root) return;
    let live = true;
    for (const dir of [base, ...contentRoots])
      void readDirs(root, dir)
        .then((dirs) => live && setChildren((m) => new Map(m).set(dir, dirs)))
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [root, base, contentRoots]);

  if (!rootNode)
    return (
      <div className={styles.note}>
        <T>Open a project to configure its folders.</T>
      </div>
    );

  const markable = selected?.rel ?? null;
  const role = markable !== null ? rootRole(roots, markable) : null;
  const mark = (r: FolderRole) => {
    if (markable === null) return;
    setPs(markFolder(ps, markable, role === r ? null : r, detected));
  };
  const unmarkedDetected = unmarkedRoots(detected, ps).filter((r) => own(r.path));
  const restore = () => setPs(restoreDetected(ps, detected));

  const groups = ROLES.map((r) => ({ ...r, list: roots.filter((x) => x.kind === r.role && own(x.path)) })).filter(
    (g) => g.list.length > 0,
  );
  const relToBase = (path: string) =>
    (baseRel && path.startsWith(`${baseRel}/`) ? path.slice(baseRel.length + 1) : path) || ".";

  return (
    <div className={clsx(styles.sourcesEditor, fill && styles.sourcesFill)}>
      {top}
      <div className={styles.markBar} role="toolbar" aria-label={tx("Mark as")}>
        <span className={styles.markLabel}>
          <T>Mark as:</T>
        </span>
        {ROLES.map((r) => (
          <button
            key={r.role}
            type="button"
            className={styles.markButton}
            aria-pressed={role === r.role}
            disabled={markable === null || (!markable && r.role === "excluded")}
            onClick={() => mark(r.role)}
          >
            <Icon name={folderIconName(r.kind)} size={14} />
            {tx(r.label)}
          </button>
        ))}
      </div>
      <div className={styles.structure}>
        <div className={styles.structureTree}>
          <div className={styles.treeScroll}>
            <Tree<DirNode>
              aria-label="Content root"
              roots={treeRoots}
              getKey={(n) => n.path}
              getLabel={(n) => (n.rel === null || n.path === base ? tildify(n.path) : n.name)}
              getChildren={(n) => children.get(n.path)}
              isExpandable={() => true}
              loadChildren={load}
              expanded={expanded}
              onExpandedChange={(set) => setExpanded(set)}
              multiSelect={false}
              selected={selected ? new Set([selected.path]) : new Set()}
              onSelectionChange={(_s, lead) => setSelected(lead)}
              getIcon={(n) => {
                if (n.rel === null) return n.contentRoot ? "module" : folderIconName("plain");
                const r = rootRole(roots, n.rel);
                if (n.path === base && !r) return folderIconName("plain");
                return folderIconName(r ? ROLES.find((x) => x.role === r)!.kind : "plain");
              }}
            />
          </div>
          {projectLevel && <ExcludeFiles value={ps.excludeFiles} onChange={(v) => setPs({ ...ps, excludeFiles: v })} />}
        </div>
        <div className={styles.roots} aria-label={tx("Marked folders")}>
          {projectLevel ? (
            <ContentRoots
              root={rootNode.path}
              list={ps.contentRoots}
              onChange={(next) => setPs({ ...ps, contentRoots: next })}
            />
          ) : (
            <div className={clsx(styles.rootItem, styles.contentRoot)}>
              <span className={styles.rootPath} title={base}>
                {shortPath(base)}
              </span>
            </div>
          )}
          {groups.map((g) => (
            <div key={g.role} className={clsx(styles.rootGroup, g.cls)}>
              <div className={styles.rootTitle}>{tx(g.title)}</div>
              {g.list.map((x) => {
                const shown = relToBase(x.path);
                return (
                  <div
                    key={x.path}
                    className={styles.rootItem}
                    title={x.detectedFrom ? tx`detected from ${x.detectedFrom}` : undefined}
                  >
                    <span className={styles.rootPath}>{shown}</span>
                    <span className={styles.rootLeader} aria-hidden />
                    <IconButton
                      icon="close"
                      size="small"
                      iconSize={12}
                      title={tx`Unmark ${shown}`}
                      onClick={() => setPs(markFolder(ps, x.path, null, detected))}
                    />
                  </div>
                );
              })}
            </div>
          ))}
          {groups.length === 0 && (
            <div className={styles.note}>
              <T>No marked folders</T>
            </div>
          )}
          {unmarkedDetected.length > 0 && (
            <div className={styles.note}>
              {unmarkedDetected.length === 1
                ? tx("1 detected folder is unmarked.")
                : tx`${unmarkedDetected.length} detected folders are unmarked.`}{" "}
              <button type="button" className={styles.linkButton} onClick={restore}>
                <T>Restore detected roots</T>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** `/Users/…/project/module`: the start and the last two folders of a long path. */
function shortPath(path: string): string {
  const p = tildify(path);
  if (p.length <= 36) return p;
  const parts = p.split("/");
  return parts.length > 4 ? `${parts.slice(0, 2).join("/")}/…/${parts.slice(-2).join("/")}` : p;
}

export function ProjectStructurePage() {
  const root = useProject((s) => s.project?.root ?? null);
  const name = useProject((s) => s.project?.name ?? "");
  const [ps, setPs] = useStructure();
  if (!root)
    return (
      <div className={styles.note}>
        <T>Open a project to configure its folders.</T>
      </div>
    );
  return <SourcesEditor base={root} name={name} ps={ps} onChange={setPs} projectLevel />;
}
