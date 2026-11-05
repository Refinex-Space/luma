/** Project Settings › Project and Modules. */
import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import clsx from "clsx";
import { Button, Icon, IconButton, Input, Tabs, T } from "@/ui";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { Row, Section } from "@/features/settings/components/Form";
import { SdkField } from "@/features/settings/languages/components";
import { SourcesEditor } from "@/features/settings/languages/ProjectStructurePage";
import { autoJdk, moduleDependencies, nestedDirs, outputPaths, type ModuleDependency, type ModuleInfo } from "./model";
import type { StructureData } from "./data";
import { ItemRow, MasterDetail, PageHead } from "./parts";
import { editDraft, select, showPage, useProjectStructure } from "./store";
import styles from "./ProjectStructure.module.css";

/** The language level the build sets: one version, the versions per module, or none. */
function languageLevel(modules: readonly ModuleInfo[]): { level: string; from: string | null } {
  const versions = [...new Set(modules.map((m) => m.javaVersion).filter((v): v is number => v !== null))].sort(
    (a, b) => a - b,
  );
  const tool = modules.find((m) => m.kind !== "plain")?.kind;
  const from = tool === "maven" ? "pom.xml" : tool === "gradle" ? "build.gradle" : null;
  if (!versions.length) return { level: tx("SDK default"), from: null };
  const [javaVersion] = versions;
  if (versions.length === 1) return { level: `Java ${javaVersion}`, from };
  return { level: tx`Per module: Java ${versions.join(", ")}`, from };
}

export function ProjectPage({ data }: { data: StructureData }) {
  const nameId = useId();
  const folder =
    data.project?.root
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "";
  const level = languageLevel(data.modules);
  const tool = data.modules.find((m) => m.kind !== "plain")?.kind;
  return (
    <>
      <PageHead title="Project" note={tx("Defaults for every module; a module's page shows what it uses.")} />
      <div className={styles.pageBody}>
        <Section>
          <Row label="Name" htmlFor={nameId}>
            <Input
              id={nameId}
              className={styles.field}
              value={data.name}
              placeholder={folder}
              onChange={(e) => editDraft({ name: e.target.value })}
            />
          </Row>
          <Row
            label="SDK"
            hint={data.jdkSetting ? undefined : tx("Auto: each module runs on the JDK of its Java version.")}
          >
            <span className={styles.sdkLine}>
              <SdkField
                kind="jdk"
                value={data.jdkSetting}
                onChange={(path) => editDraft({ jdk: path })}
                emptyLabel="Auto"
                emptyDetail="per module, the JDK of its Java version"
                directory
                browseTitle="Select JDK Home Directory"
                aria-label="Project SDK"
              />
              <Button size="small" onClick={() => showPage("sdks", data.jdk ? `jdk:${data.jdk.path}` : undefined)}>
                <T>Edit</T>
              </Button>
            </span>
          </Row>
          <Row label="Language level" hint={level.from ? tx`Set by the build; change it in ${level.from}.` : undefined}>
            <span className={styles.value}>{level.level}</span>
          </Row>
          <Row
            label="Compiler output"
            hint={tool ? tx`Each module's build writes its classes; see the module's Paths tab.` : undefined}
          >
            <span className={clsx(styles.value, !tool && styles.muted)}>
              {tool === "maven"
                ? tx("target/ in each module (Maven)")
                : tool === "gradle"
                  ? tx("build/ in each module (Gradle)")
                  : tx("None: no Java build in this project")}
            </span>
          </Row>
        </Section>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Modules

const moduleIcon = (m: ModuleInfo) =>
  m.kind === "maven"
    ? m.depth === 0
      ? "maven-project"
      : "maven-module"
    : m.kind === "gradle"
      ? m.depth === 0
        ? "gradle-project"
        : "gradle-module"
      : "module";

type ModuleTab = "sources" | "paths" | "dependencies";

export function ModulesPage({ data }: { data: StructureData }) {
  const selected = useProjectStructure((s) => s.selected.modules);
  const onSelect = useCallback((id: string) => select("modules", id), []);
  const [tab, setTab] = useState<ModuleTab>("sources");
  // IDEA's ModulesAlphaComparator: by name, case-insensitively.
  const sortedModules = useMemo(
    () => [...data.modules].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    [data.modules],
  );
  const reload = data.build?.maven ? "maven.reload" : data.build?.gradle ? "gradle.reload" : null;
  return (
    <>
      <div className={clsx(styles.pageBody, styles.flush)}>
        <MasterDetail<ModuleInfo>
          label="Modules"
          items={sortedModules}
          getKey={(m) => m.id}
          getText={(m) => `${m.name} ${m.dir}`}
          renderRow={(m) => <ItemRow icon={moduleIcon(m)} name={m.name} />}
          selected={selected}
          onSelect={onSelect}
          loading={data.buildLoading && !data.modules.length}
          actions={
            reload && (
              <IconButton
                icon="refresh"
                size="small"
                title={reload === "maven.reload" ? "Reload All Maven Projects" : "Reload All Gradle Projects"}
                onClick={() => void executeAction(reload)}
              />
            )
          }
          empty={tx("No modules")}
          detail={(m) => <ModuleDetail data={data} module={m} tab={tab} onTab={setTab} />}
        />
      </div>
    </>
  );
}

function ModuleDetail({
  data,
  module: m,
  tab,
  onTab,
}: {
  data: StructureData;
  module: ModuleInfo;
  tab: ModuleTab;
  onTab: (t: ModuleTab) => void;
}) {
  const root = data.project?.root ?? "";
  const base = m.dir ? `${root}/${m.dir}` : root;
  return (
    <>
      <div className={styles.moduleHead}>
        <Row label="Name" htmlFor={`module-name-${m.id}`}>
          <Input
            id={`module-name-${m.id}`}
            className={styles.wideField}
            value={m.name}
            readOnly
            title={
              m.kind === "maven"
                ? tx("The artifactId in pom.xml")
                : m.kind === "gradle"
                  ? tx("The project name in settings.gradle")
                  : undefined
            }
          />
        </Row>
      </div>
      <Tabs
        className={styles.tabs}
        variant="compact"
        aria-label="Module settings"
        activeId={tab}
        onSelect={(id) => onTab(id as ModuleTab)}
        items={[
          { id: "sources", label: tx("Sources") },
          { id: "paths", label: tx("Paths") },
          { id: "dependencies", label: tx("Dependencies") },
        ]}
        trailing={
          m.maven && (
            <Button
              size="small"
              variant="ghost"
              icon="toolwindow-maven"
              onClick={() => void executeAction("maven.analyzeDependencies")}
            >
              <T>Analyze Dependencies…</T>
            </Button>
          )
        }
      />
      {tab === "sources" ? (
        <div className={clsx(styles.detailBody, styles.fill)}>
          <SourcesEditor
            key={m.id}
            base={base}
            name={m.name}
            ps={data.structure}
            onChange={(next) => editDraft({ structure: next })}
            projectLevel={!m.dir}
            nested={nestedDirs(m, data.modules)}
            fill
            top={
              m.kind !== "plain" && (
                <div className={styles.inlineRow}>
                  <Row
                    label="Language level"
                    hint={tx`Set by the build; change it in ${m.buildFile ?? (m.kind === "maven" ? "pom.xml" : "build.gradle")}.`}
                  >
                    <span className={styles.value}>{m.javaVersion ? `Java ${m.javaVersion}` : tx("SDK default")}</span>
                  </Row>
                </div>
              )
            }
          />
        </div>
      ) : tab === "paths" ? (
        <div className={styles.detailBody}>
          <ModulePaths module={m} root={root} />
        </div>
      ) : (
        <div className={clsx(styles.detailBody, styles.fill)}>
          <ModuleDependencies data={data} module={m} />
        </div>
      )}
    </>
  );
}

function ModulePaths({ module: m, root }: { module: ModuleInfo; root: string }) {
  const out = outputPaths(m);
  if (!out)
    return (
      <p className={styles.muted}>
        {m.maven?.packaging === "pom"
          ? tx("An aggregator (pom packaging): it compiles nothing itself.")
          : tx("No compiler output: this module has no Java build.")}
      </p>
    );
  const abs = (p: string) => (root ? `${root}/${p}` : p);
  return (
    <Section title="Compiler output">
      <Row label="Output directory" hint={undefined}>
        <Input className={styles.wideField} value={abs(out.production)} readOnly mono />
      </Row>
      <Row
        label="Test output directory"
        hint={
          m.kind === "maven"
            ? tx("Maven decides these paths (<build><outputDirectory> in pom.xml).")
            : tx("Gradle decides these paths (sourceSets in build.gradle).")
        }
      >
        <Input className={styles.wideField} value={abs(out.test)} readOnly mono />
      </Row>
    </Section>
  );
}

const DEP_ICON: Record<ModuleDependency["kind"], string> = {
  sdk: "file-java",
  source: "folder-source",
  module: "module",
  library: "library",
};

function ModuleDependencies({ data, module: m }: { data: StructureData; module: ModuleInfo }) {
  const sdk = data.jdk ?? autoJdk(data.jdks.list, m.javaVersion);
  const sdkName = sdk
    ? data.jdk
      ? sdk.name
      : tx`${sdk.name} (Auto)`
    : data.jdks.loading
      ? tx("Detecting…")
      : tx("<No SDK>");
  const deps = moduleDependencies(m, data.modules, sdkName);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const rows: ReactNode[] = [];
  const add = (d: ModuleDependency, depth: number, key: string) => {
    const kids = d.children ?? [];
    const expanded = open.has(key);
    rows.push(
      <tr key={key}>
        <td>
          <span className={styles.cell} style={{ paddingLeft: depth * 16 }}>
            {kids.length ? (
              <button
                type="button"
                className={styles.twisty}
                aria-label={expanded ? tx("Collapse") : tx("Expand")}
                aria-expanded={expanded}
                onClick={() =>
                  setOpen((s) => {
                    const n = new Set(s);
                    if (n.has(key)) n.delete(key);
                    else n.add(key);
                    return n;
                  })
                }
              >
                <Icon name={expanded ? "chevron-down" : "chevron-right"} size={12} />
              </button>
            ) : (
              <span className={styles.twisty} />
            )}
            <Icon name={DEP_ICON[d.kind]} size={16} />
            {d.kind === "module" ? (
              <button type="button" className={styles.link} onClick={() => d.module && select("modules", d.module)}>
                {d.name}
              </button>
            ) : (
              <span title={d.name}>{d.kind === "source" ? tx(d.name) : d.name}</span>
            )}
          </span>
        </td>
        <td className={styles.muted}>{d.scope ? tx(d.scope) : ""}</td>
      </tr>,
    );
    if (expanded) kids.forEach((c, i) => add(c, depth + 1, `${key}/${i}`));
  };
  deps.forEach((d, i) => add(d, 0, String(i)));
  return (
    <>
      <div className={styles.inlineRow}>
        <Row label="Module SDK">
          <span className={styles.sdkLine}>
            <span className={styles.value}>
              <Icon name="file-java" size={16} />
              {data.jdk ? tx`Project SDK ${sdk?.name ?? ""}` : sdkName}
            </span>
            <Button size="small" onClick={() => showPage("project")}>
              <T>Edit</T>
            </Button>
          </span>
        </Row>
      </div>
      <div className={styles.tableScroll}>
        <table className={styles.table} aria-label={tx("Dependencies")}>
          <thead>
            <tr>
              <th>
                <T>Name</T>
              </th>
              <th className={styles.scopeCol}>
                <T>Scope</T>
              </th>
            </tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
      </div>
      {m.kind !== "maven" && (
        <p className={clsx(styles.muted, styles.detailBody)} style={{ flex: "none" }}>
          {m.kind === "gradle"
            ? tx("Gradle resolves this module's libraries; they are listed under Libraries.")
            : tx("Libraries of this folder are listed under Libraries.")}
        </p>
      )}
      {m.kind === "maven" && data.build?.maven?.syncedAt === null && (
        <p className={clsx(styles.muted, styles.detailBody)} style={{ flex: "none" }}>
          <Icon name="info" size={14} /> {tx("Transitive dependencies appear after the Maven project is reloaded.")}
        </p>
      )}
    </>
  );
}
