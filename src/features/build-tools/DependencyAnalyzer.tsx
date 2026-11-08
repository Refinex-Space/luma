/**
 * Dependency Analyzer editor tab: a Maven module's resolved artifacts (flat list or
 * the transitive tree) with conflicts marked, and for the selected artifact every
 * path that brings it in, with Exclude / Jump to Source / Copy Coordinates.
 */
import { useMemo, useState, type MouseEvent } from "react";
import clsx from "clsx";
import { call, commands, type MavenDependency, type MavenProject } from "@/platform/ipc";
import { useTx, useTxTemplate, tx } from "@/platform/i18n";
import { editorService, notifications, type EditorInput } from "@/workbench/contributions";
import {
  Button,
  Checkbox,
  EmptyState,
  Icon,
  IconButton,
  SearchField,
  Select,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Spinner,
  T,
  Tree,
  copyText,
  showContextMenu,
  type MenuItem,
  type SelectOption,
} from "@/ui";
import {
  analyze,
  artifactKey,
  coordinates,
  exclusionFor,
  filterArtifacts,
  filterTree,
  scopesOf,
  sortedUsages,
  statusText,
  usageStatus,
  type AnalyzedArtifact,
  type DependencyTreeNode,
  type DependencyUsage,
} from "./analyzer";
import { syncTool, useAnalyzer, useBuild } from "./store";
import styles from "./DependencyAnalyzer.module.css";

type Mode = "list" | "tree";
type Node =
  | { kind: "artifact"; key: string; artifact: AnalyzedArtifact }
  | { kind: "node"; key: string; node: DependencyTreeNode; children: Node[] };

const ALL_SCOPES = "*";

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

async function jumpToDeclaration(pom: string, d: MavenDependency) {
  try {
    const loc = await call(commands.mavenDependencyDeclaration(pom, { groupId: d.groupId, artifactId: d.artifactId }));
    const { start, end } = loc.range;
    await editorService().openFile(loc.path, {
      focus: true,
      selection: { line: start.line, col: start.col, endLine: end.line, endCol: end.col },
    });
  } catch (e) {
    notifications().notify({
      level: "warning",
      group: "tools",
      title: "Cannot find the declaration",
      body: errorText(e),
    });
  }
}

async function exclude(pom: string, usage: DependencyUsage) {
  const target = exclusionFor(usage);
  if (!target) return;
  const what = `${target.exclusion.groupId}:${target.exclusion.artifactId}`;
  try {
    await call(commands.mavenExcludeDependency(pom, target.dependency, target.exclusion));
  } catch (e) {
    notifications().notify({ level: "error", group: "tools", title: `Cannot exclude ${what}`, body: errorText(e) });
    return;
  }
  await syncTool("maven");
}

function versionLabel(d: MavenDependency) {
  return d.version ?? "";
}

function moduleOptions(projects: readonly MavenProject[]): SelectOption[] {
  return projects
    .filter((p) => p.packaging !== "pom" || p.dependencies.length > 0)
    .map((p) => ({ value: p.pom, label: p.displayName, detail: p.pom, icon: "maven-project" }));
}

function ArtifactRow({ artifact, selected }: { artifact: AnalyzedArtifact; selected: boolean }) {
  const tx = useTx();
  return (
    <span className={styles.row}>
      <Icon name={artifact.conflict ? "warning" : "library"} size={16} className={styles.icon} />
      <span className={clsx(styles.label, artifact.conflict && styles.conflict, selected && styles.selectedLabel)}>
        {artifact.key}
      </span>
      <span className={styles.version}>{artifact.version ?? tx("omitted")}</span>
      {artifact.conflict && (
        <span className={styles.detail}>{artifact.requested.filter((v) => v !== artifact.version).join(", ")}</span>
      )}
      {artifact.scope !== "compile" && <span className={styles.detail}>({artifact.scope})</span>}
    </span>
  );
}

function TreeRow({ node, conflict, selected }: { node: DependencyTreeNode; conflict: boolean; selected: boolean }) {
  const tx = useTxTemplate();
  const d = node.dependency;
  const status = statusText(usageStatus(d));
  return (
    <span className={clsx(styles.row, d.omitted != null && styles.omitted)}>
      <Icon name={conflict ? "warning" : "library"} size={16} className={styles.icon} />
      <span className={clsx(styles.label, conflict && styles.conflict, selected && styles.selectedLabel)}>
        {artifactKey(d)}
      </span>
      <span className={styles.version}>{versionLabel(d)}</span>
      {d.scope !== "compile" && <span className={styles.detail}>({d.scope})</span>}
      {status && <span className={styles.detail}>{tx(status)}</span>}
    </span>
  );
}

function UsageBlock({ usage, module, pom }: { usage: DependencyUsage; module: MavenProject; pom: string }) {
  const tx = useTxTemplate();
  const status = usageStatus(usage.dependency);
  const text = statusText(status);
  const direct = usage.path[0]!;
  const canExclude = !!exclusionFor(usage);
  return (
    <section className={styles.usage} aria-label={coordinates(usage.dependency)}>
      <div className={styles.usageHeader}>
        <Icon
          name={status.kind === "conflict" ? "warning" : status.kind === "resolved" ? "success" : "info"}
          size={16}
          className={styles.icon}
        />
        <span className={styles.usageVersion}>{status.version}</span>
        <span className={clsx(styles.usageStatus, status.kind === "conflict" && styles.conflict)}>
          {text ? tx(text) : tx("resolved")}
        </span>
        <span className={styles.spacer} />
        {canExclude && (
          <Button size="small" variant="ghost" onClick={() => void exclude(pom, usage)}>
            Exclude
          </Button>
        )}
        <IconButton
          icon="autoscroll-to-source"
          size="small"
          title="Jump to Source"
          onClick={() => void jumpToDeclaration(pom, direct)}
        />
      </div>
      <ol className={styles.path}>
        <li className={styles.step} style={{ paddingLeft: 0 }}>
          <Icon name="maven-project" size={16} className={styles.icon} />
          <span className={styles.stepLabel}>{module.displayName}</span>
        </li>
        {usage.path.map((d, i) => (
          <li key={i} className={styles.step} style={{ paddingLeft: (i + 1) * 16 }}>
            <Icon name="library" size={16} className={styles.icon} />
            <span className={clsx(styles.stepLabel, i === usage.path.length - 1 && styles.stepTarget)}>
              {coordinates(d)}
            </span>
            {d.scope !== "compile" && <span className={styles.detail}>({d.scope})</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function UsagesPane({
  artifact,
  module,
  pom,
}: {
  artifact: AnalyzedArtifact | null;
  module: MavenProject;
  pom: string;
}) {
  if (!artifact) return <EmptyState title="Select a dependency to see its usages" />;
  const usages = sortedUsages(artifact.usages);
  const coords = coordinates({ ...artifact, version: artifact.version });
  return (
    <div className={styles.usages}>
      <div className={styles.usagesHeader}>
        <span className={clsx(styles.usagesTitle, artifact.conflict && styles.conflict)}>{coords}</span>
        <IconButton icon="copy" size="small" title="Copy Coordinates" onClick={() => void copyText(coords)} />
      </div>
      {artifact.conflict && (
        <div className={styles.conflictNote} role="note">
          <Icon name="warning" size={16} />
          <span>
            <T>Versions requested</T>: {artifact.requested.join(", ")}
          </span>
        </div>
      )}
      <div className={styles.usageList} aria-label={tx("Usages")}>
        {usages.map((u, i) => (
          <UsageBlock key={i} usage={u} module={module} pom={pom} />
        ))}
      </div>
    </div>
  );
}

export function DependencyAnalyzer(_props: { input: EditorInput }) {
  const tx = useTx();
  const maven = useBuild((s) => s.model?.maven ?? null);
  const syncing = useBuild((s) => s.syncing.maven);
  const chosen = useAnalyzer((s) => s.pom);
  const [query, setQuery] = useState("");
  // Analyze Dependencies on a dependency of the Maven tool window: that artifact.
  const focus = useAnalyzer((s) => s.focus);
  const [seenFocus, setSeenFocus] = useState(focus?.seq ?? 0);
  if (focus && focus.seq !== seenFocus) {
    setSeenFocus(focus.seq);
    setQuery(focus.text);
  }
  const [conflictsOnly, setConflictsOnly] = useState(false);
  const [scope, setScope] = useState<string>(ALL_SCOPES);
  const [mode, setMode] = useState<Mode>("list");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const options = useMemo(() => moduleOptions(maven?.projects ?? []), [maven]);
  const pom = options.some((o) => o.value === chosen) ? chosen! : (options[0]?.value ?? null);
  const module = maven?.projects.find((p) => p.pom === pom) ?? null;
  const artifacts = useMemo(() => analyze(module?.dependencies ?? []), [module]);
  const conflicted = useMemo(() => new Set(artifacts.filter((a) => a.conflict).map((a) => a.key)), [artifacts]);
  const filter = useMemo(
    () => ({ query, conflictsOnly, scope: scope === ALL_SCOPES ? null : scope }),
    [query, conflictsOnly, scope],
  );
  const listed = useMemo(() => filterArtifacts(artifacts, filter), [artifacts, filter]);
  const tree = useMemo(() => filterTree(module?.dependencies ?? [], filter, conflicted), [module, filter, conflicted]);
  const roots: Node[] = useMemo(() => {
    const toNode = (node: DependencyTreeNode): Node => ({
      kind: "node",
      key: `n:${node.key}`,
      node,
      children: node.children.map(toNode),
    });
    return mode === "list"
      ? listed.map((artifact) => ({ kind: "artifact", key: `a:${artifact.key}`, artifact }))
      : tree.map(toNode);
  }, [mode, listed, tree]);

  // A narrowing filter opens the tree down to its matches until the user expands or collapses.
  const filterId = `${mode}|${filter.query}|${filter.conflictsOnly}|${filter.scope}|${pom}`;
  const [manual, setManual] = useState<{ id: string; keys: Set<string> } | null>(null);
  const expanded = useMemo(() => {
    if (manual?.id === filterId) return manual.keys;
    const keys = new Set<string>();
    if (filter.conflictsOnly || filter.scope != null || filter.query.trim()) {
      const walk = (nodes: readonly Node[]) => {
        for (const n of nodes)
          if (n.kind === "node" && n.children.length) {
            keys.add(n.key);
            walk(n.children);
          }
      };
      walk(roots);
    }
    return keys;
  }, [manual, filterId, filter, roots]);

  const selected = artifacts.find((a) => a.key === selectedKey) ?? null;
  const scopeOptions: SelectOption[] = [
    { value: ALL_SCOPES, label: tx("All scopes") },
    ...scopesOf(artifacts).map((s) => ({ value: s, label: s })),
  ];

  const nodeArtifactKey = (n: Node) => (n.kind === "artifact" ? n.artifact.key : artifactKey(n.node.dependency));
  /** The usage a row stands for: a tree node's own, else the artifact's direct (or first) one. */
  const usageOf = (n: Node): DependencyUsage | undefined => {
    if (n.kind === "node")
      return artifacts
        .find((a) => a.key === nodeArtifactKey(n))
        ?.usages.find((u) => u.dependency === n.node.dependency);
    return n.artifact.usages.find((u) => u.path.length === 1) ?? n.artifact.usages[0];
  };

  const contextMenu = (n: Node | null, _sel: Set<string>, e: MouseEvent) => {
    if (!n || !pom) return;
    e.preventDefault();
    const usage = usageOf(n);
    if (!usage) return;
    const items: MenuItem[] = [
      { label: "Jump to Source", icon: "autoscroll-to-source", run: () => void jumpToDeclaration(pom, usage.path[0]!) },
    ];
    if (exclusionFor(usage)) items.push({ label: "Exclude", run: () => void exclude(pom, usage) });
    items.push({ label: "Copy Coordinates", icon: "copy", run: () => void copyText(coordinates(usage.dependency)) });
    showContextMenu({ x: e.clientX, y: e.clientY }, items);
  };

  if (!maven) return <EmptyState title="No Maven projects" />;

  return (
    <div className={styles.view}>
      <div className={styles.toolbar} role="toolbar" aria-label={tx("Dependency Analyzer")}>
        <Select
          aria-label="Module"
          className={styles.module}
          value={pom}
          options={options}
          onChange={(v) => {
            useAnalyzer.setState({ pom: v });
            setSelectedKey(null);
          }}
        />
        <SearchField
          className={styles.search}
          value={query}
          onChange={setQuery}
          placeholder={tx("Search dependencies")}
          aria-label="Search dependencies"
          clearable
        />
        <Checkbox checked={conflictsOnly} onChange={setConflictsOnly} label="Show conflicts only" />
        <Select aria-label="Scope" className={styles.scope} value={scope} options={scopeOptions} onChange={setScope} />
        <span className={styles.sep} />
        <IconButton
          icon="list"
          size="small"
          iconSize={16}
          title="Show as List"
          pressed={mode === "list"}
          onClick={() => setMode("list")}
        />
        <IconButton
          icon="hierarchy"
          size="small"
          iconSize={16}
          title="Show as Tree"
          pressed={mode === "tree"}
          onClick={() => setMode("tree")}
        />
        <span className={styles.sep} />
        {syncing ? (
          <IconButton icon="stop" size="small" iconSize={16} action="maven.cancelReload" />
        ) : (
          <IconButton icon="refresh" size="small" iconSize={16} action="maven.reload" />
        )}
      </div>
      {syncing ? (
        <div className={styles.banner} role="status">
          <Spinner size={12} />
          <span className={styles.bannerText}>{syncing.message}</span>
        </div>
      ) : maven.stale && maven.syncedAt != null ? (
        <div className={styles.banner}>
          <Icon name="maven-load-changes" size={16} />
          <span className={styles.bannerText}>
            <T>Dependency trees may be out of date</T>
          </span>
          <Button size="small" variant="ghost" onClick={() => void syncTool("maven")}>
            Load Maven Changes
          </Button>
        </div>
      ) : null}
      {maven.syncedAt == null ? (
        <EmptyState
          title="Dependency trees are read when Maven projects are reloaded"
          actions={
            <Button size="small" onClick={() => void syncTool("maven")} disabled={!!syncing}>
              Reload All Maven Projects
            </Button>
          }
        />
      ) : !module || !pom ? (
        <EmptyState title="No Maven modules" />
      ) : (
        <div className={styles.body}>
          <SplitGroup orientation="horizontal" id="maven-dependency-analyzer-split">
            <SplitPanel id="dependencies" minSize={200} className={styles.panel}>
              <Tree<Node>
                aria-label="Dependencies"
                roots={roots}
                getKey={(n) => n.key}
                getLabel={(n) => (n.kind === "artifact" ? n.artifact.key : artifactKey(n.node.dependency))}
                getChildren={(n) => (n.kind === "node" ? n.children : undefined)}
                isExpandable={(n) => n.kind === "node" && n.node.children.length > 0}
                expanded={expanded}
                onExpandedChange={(next) => setManual({ id: filterId, keys: next })}
                onSelectionChange={(_keys, lead) => setSelectedKey(lead ? nodeArtifactKey(lead) : null)}
                renderNode={(n, state) =>
                  n.kind === "artifact" ? (
                    <ArtifactRow artifact={n.artifact} selected={state.selected} />
                  ) : (
                    <TreeRow
                      node={n.node}
                      conflict={conflicted.has(artifactKey(n.node.dependency))}
                      selected={state.selected}
                    />
                  )
                }
                onActivate={(n) => {
                  const usage = usageOf(n);
                  if (usage) void jumpToDeclaration(pom, usage.path[0]!);
                }}
                onContextMenu={contextMenu}
                multiSelect={false}
                empty={<EmptyState title={artifacts.length ? "No dependencies match the filter" : "No dependencies"} />}
              />
            </SplitPanel>
            <SplitHandle />
            <SplitPanel id="usages" minSize={240} className={styles.panel}>
              <UsagesPane artifact={selected} module={module} pom={pom} />
            </SplitPanel>
          </SplitGroup>
        </div>
      )}
    </div>
  );
}
