/** Libraries, Facets, Artifacts, SDKs, Global Libraries and Problems. */
import { useCallback, useMemo, useState } from "react";
import clsx from "clsx";
import { Button, EmptyState, Icon, IconButton, T } from "@/ui";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { DOWNLOAD_JDK_ACTION } from "@/platform/jdk";
import type { Sdk, SdkKind } from "@/platform/ipc";
import { tildify, useDetected } from "@/features/settings/languages/components";
import { choosePath } from "@/features/settings/languages/api";
import { DownloadJdkDialog } from "@/features/settings/languages/DownloadJdkDialog";
import { runConfig, useBuild } from "@/features/build-tools/store";
import { gradleTaskConfig, mavenGoalConfig } from "@/features/build-tools/model";
import {
  javaFeature,
  type ArtifactInfo,
  type FacetInfo,
  type LibraryInfo,
  type Problem,
  type ProblemFix,
} from "./model";
import type { StructureData } from "./data";
import { DetailHead, Facts, ItemRow, MasterDetail, PageHead } from "./parts";
import { editDraft, select, showPage, useProjectStructure, type PageId } from "./store";
import styles from "./ProjectStructure.module.css";

const useSelection = (page: PageId) => {
  const selected = useProjectStructure((s) => s.selected[page]);
  const onSelect = useCallback((id: string) => select(page, id), [page]);
  return [selected, onSelect] as const;
};

const LIBRARY_ICON: Record<string, string> = {
  maven: "library",
  gradle: "library",
  nodeModules: "file-npm",
  cargo: "file-cargo",
  goModules: "file-gomod",
  gems: "file-ruby",
};

// ---------------------------------------------------------------------------
// Libraries

export function LibrariesPage({ data }: { data: StructureData }) {
  const [selected, onSelect] = useSelection("libraries");
  return (
    <>
      <div className={clsx(styles.pageBody, styles.flush)}>
        <MasterDetail<LibraryInfo>
          label="Libraries"
          items={data.libraries}
          getKey={(l) => l.id}
          getText={(l) => l.name}
          sectionOf={(l) => l.section}
          renderRow={(l) => <ItemRow icon={LIBRARY_ICON[l.kind] ?? "library"} name={l.name} />}
          selected={selected}
          onSelect={onSelect}
          loading={data.librariesLoading}
          empty={tx("No libraries: the build has not resolved any yet")}
          detail={(l) => (
            <>
              <DetailHead icon={LIBRARY_ICON[l.kind] ?? "library"} title={l.name} />
              <div className={styles.detailBody}>
                <Facts
                  rows={[
                    l.coordinates ? ["Coordinates", <span className={styles.mono}>{l.coordinates}</span>] : null,
                    ["Managed by", l.section],
                    [
                      "Classes",
                      <span className={styles.paths}>
                        {l.paths.map((path) => (
                          <span key={path} className={styles.mono}>
                            {tildify(path)}
                          </span>
                        ))}
                      </span>,
                    ],
                    [
                      "Used by",
                      l.usedBy.length ? (
                        l.usedBy.map((m, i) => (
                          <span key={m}>
                            {i > 0 && ", "}
                            <button type="button" className={styles.link} onClick={() => showModule(data, m)}>
                              {m}
                            </button>
                          </span>
                        ))
                      ) : (
                        <span className={styles.muted}>
                          {l.coordinates ? tx("Transitive") : tx("Not declared by a module directly")}
                        </span>
                      ),
                    ],
                  ]}
                />
              </div>
            </>
          )}
        />
      </div>
    </>
  );
}

function showModule(data: StructureData, name: string) {
  const m = data.modules.find((x) => x.name === name);
  if (m) showPage("modules", m.id);
}

// ---------------------------------------------------------------------------
// Facets

export function FacetsPage({ data }: { data: StructureData }) {
  const [selected, onSelect] = useSelection("facets");
  return (
    <>
      <div className={clsx(styles.pageBody, styles.flush)}>
        <MasterDetail<FacetInfo>
          label="Facets"
          items={data.facets}
          getKey={(f) => f.id}
          getText={(f) => `${f.type.name} ${f.module}`}
          sectionOf={(f) => f.type.name}
          renderRow={(f) => <ItemRow icon={f.type.icon} name={`${f.type.name} (${f.module})`} />}
          selected={selected}
          onSelect={onSelect}
          loading={data.buildLoading && !data.modules.length}
          empty={tx("No frameworks detected")}
          detail={(f) => (
            <>
              <DetailHead icon={f.type.icon} title={f.type.name} sub={f.module} />
              <div className={styles.detailBody}>
                <Facts
                  rows={[
                    [
                      "Module",
                      <button type="button" className={styles.link} onClick={() => showModule(data, f.module)}>
                        {f.module}
                      </button>,
                    ],
                    ["Detected from", <span className={styles.mono}>{f.evidence}</span>],
                  ]}
                />
              </div>
            </>
          )}
        />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Artifacts

function buildArtifact(a: ArtifactInfo) {
  const { model, settings } = useBuild.getState();
  if (a.module.maven && model?.maven)
    runConfig(mavenGoalConfig(a.module.maven, a.build, model.maven, settings.maven), "run");
  else if (a.module.gradle && model?.gradle)
    runConfig(gradleTaskConfig(model.gradle, a.module.gradle, a.build, settings.gradle), "run");
}

export function ArtifactsPage({ data }: { data: StructureData }) {
  const [selected, onSelect] = useSelection("artifacts");
  return (
    <>
      <div className={clsx(styles.pageBody, styles.flush)}>
        <MasterDetail<ArtifactInfo>
          label="Artifacts"
          items={data.artifacts}
          getKey={(a) => a.id}
          getText={(a) => `${a.name} ${a.module.name}`}
          renderRow={(a) => <ItemRow icon="file-archive" name={a.name} />}
          selected={selected}
          onSelect={onSelect}
          loading={data.buildLoading && !data.modules.length}
          empty={tx("No artifacts: modules with jar or war packaging appear here")}
          detail={(a) => (
            <>
              <DetailHead
                icon="file-archive"
                title={a.name}
                sub={tx(a.type)}
                actions={
                  <Button size="small" icon="run" onClick={() => buildArtifact(a)}>
                    <T>Build</T>
                  </Button>
                }
              />
              <div className={styles.detailBody}>
                <Facts
                  rows={[
                    ["Type", tx(a.type)],
                    [
                      "Module",
                      <button type="button" className={styles.link} onClick={() => showPage("modules", a.module.id)}>
                        {a.module.name}
                      </button>,
                    ],
                    ["Output directory", <span className={styles.mono}>{a.outputDir}</span>],
                    ["File", <span className={styles.mono}>{a.file}</span>],
                    [
                      "Built by",
                      <span className={styles.mono}>
                        {a.module.maven ? `mvn ${a.build.join(" ")}` : `gradle ${a.build.join(" ")}`}
                      </span>,
                    ],
                  ]}
                />
              </div>
            </>
          )}
        />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// SDKs

const SDK_KINDS: ReadonlyArray<{ kind: SdkKind; label: string; icon: string }> = [
  { kind: "jdk", label: "JDK", icon: "file-java" },
  { kind: "python", label: "Python", icon: "file-python" },
  { kind: "node", label: "Node.js", icon: "file-js" },
  { kind: "go", label: "Go", icon: "file-go" },
  { kind: "rust", label: "Rust", icon: "file-rust" },
  { kind: "ruby", label: "Ruby", icon: "file-ruby" },
];

interface SdkItem {
  id: string;
  kind: (typeof SDK_KINDS)[number];
  sdk: Sdk;
}

export function SdksPage({ data }: { data: StructureData }) {
  const [selected, onSelect] = useSelection("sdks");
  const [downloading, setDownloading] = useState(false);
  const jdk = useDetected("jdk");
  const python = useDetected("python");
  const node = useDetected("node");
  const go = useDetected("go");
  const rust = useDetected("rust");
  const ruby = useDetected("ruby");
  const detected = useMemo(() => ({ jdk, python, node, go, rust, ruby }), [jdk, python, node, go, rust, ruby]);
  const loading = Object.values(detected).some((d) => d.loading);
  const items = useMemo<SdkItem[]>(() => {
    const out: SdkItem[] = [];
    for (const k of SDK_KINDS) {
      const list = detected[k.kind as keyof typeof detected].list;
      for (const sdk of list) out.push({ id: `${k.kind}:${sdk.path}`, kind: k, sdk });
      // A JDK picked from disk, not found by detection.
      if (k.kind === "jdk" && data.jdkSetting && !list.some((s) => s.path === data.jdkSetting))
        out.push({
          id: `jdk:${data.jdkSetting}`,
          kind: k,
          sdk: {
            path: data.jdkSetting,
            name: tildify(data.jdkSetting),
            version: null,
            source: "custom",
            home: data.jdkSetting,
            extra: null,
          },
        });
    }
    return out;
  }, [detected, data.jdkSetting]);
  const addJdk = async () => {
    const picked = await choosePath({ directory: true, title: "Select JDK Home Directory" });
    if (picked) {
      editDraft({ jdk: picked });
      select("sdks", `jdk:${picked}`);
    }
  };
  return (
    <>
      <div className={clsx(styles.pageBody, styles.flush)}>
        <MasterDetail<SdkItem>
          label="SDKs"
          items={items}
          getKey={(i) => i.id}
          getText={(i) => `${i.sdk.name} ${i.sdk.version ?? ""} ${i.kind.label}`}
          sectionOf={(i) => i.kind.label}
          renderRow={(i) => (
            <ItemRow
              icon={i.kind.icon}
              name={i.sdk.name}
              detail={i.kind.kind === "jdk" && i.sdk.path === data.jdkSetting ? tx("project") : undefined}
            />
          )}
          selected={selected}
          onSelect={onSelect}
          loading={loading && !items.length}
          actions={
            <>
              <IconButton icon="plus" size="small" title="Add JDK from Disk…" onClick={() => void addJdk()} />
              <IconButton icon="import" size="small" title="Download JDK…" onClick={() => setDownloading(true)} />
              <IconButton
                icon="refresh"
                size="small"
                title="Detect again"
                onClick={() => Object.values(detected).forEach((d) => d.refresh())}
              />
            </>
          }
          empty={tx("No SDKs found")}
          detail={(i) => {
            const isJdk = i.kind.kind === "jdk";
            const isProject = isJdk && i.sdk.path === data.jdkSetting;
            const feature = isJdk ? javaFeature(i.sdk.version) : null;
            return (
              <>
                <DetailHead
                  icon={i.kind.icon}
                  title={i.sdk.name}
                  sub={i.kind.label}
                  actions={
                    isJdk && (
                      <Button size="small" disabled={isProject} onClick={() => editDraft({ jdk: i.sdk.path })}>
                        {isProject ? tx("Project SDK") : tx("Use as Project SDK")}
                      </Button>
                    )
                  }
                />
                <div className={styles.detailBody}>
                  <Facts
                    rows={[
                      ["Version", i.sdk.version ?? <span className={styles.muted}>{tx("Unknown")}</span>],
                      feature !== null && ["Java feature version", String(feature)],
                      ["Home", <span className={styles.mono}>{tildify(i.sdk.home ?? i.sdk.path)}</span>],
                      i.sdk.home && i.sdk.home !== i.sdk.path
                        ? ["Executable", <span className={styles.mono}>{tildify(i.sdk.path)}</span>]
                        : null,
                      ["Found by", i.sdk.source],
                      i.sdk.extra
                        ? ["Library sources", <span className={styles.mono}>{tildify(i.sdk.extra)}</span>]
                        : null,
                    ]}
                  />
                </div>
              </>
            );
          }}
        />
      </div>
      {downloading && (
        <DownloadJdkDialog
          onClose={() => setDownloading(false)}
          onDownloaded={(sdk) => {
            setDownloading(false);
            jdk.refresh();
            select("sdks", `jdk:${sdk.path}`);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Global Libraries

export function GlobalLibrariesPage() {
  return (
    <>
      <PageHead title="Global Libraries" />
      <div className={styles.pageBody}>
        <EmptyState title="No global libraries">
          <T>Each project gets its libraries from its build (Maven, Gradle, npm, Cargo, Go modules).</T>{" "}
          <button type="button" className={styles.link} onClick={() => showPage("libraries")}>
            <T>Show project libraries</T>
          </button>
        </EmptyState>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Problems

export function runFix(fix: ProblemFix) {
  if (fix.kind === "reload") void executeAction(`${fix.tool}.reload`);
  else if (fix.kind === "downloadJdk") void executeAction(DOWNLOAD_JDK_ACTION, { version: fix.version });
  else showPage(fix.page as PageId);
}

export function ProblemsPage({ data }: { data: StructureData }) {
  return (
    <>
      <PageHead title="Problems" />
      <div className={styles.pageBody}>
        {data.problems.length === 0 ? (
          <EmptyState title="No problems found" />
        ) : (
          <div className={styles.problems} role="list" aria-label={tx("Problems")}>
            {data.problems.map((p: Problem) => (
              <div key={p.id} className={styles.problem} role="listitem">
                <Icon name={p.severity === "error" ? "error" : "warning"} size={16} />
                <div className={styles.problemText}>
                  <div>{p.message}</div>
                  <div className={styles.problemFixes}>
                    {p.fixes.map((f) => (
                      <button key={f.label} type="button" className={styles.link} onClick={() => runFix(f.fix)}>
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
