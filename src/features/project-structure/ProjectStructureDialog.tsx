/**
 * File › Project Structure… (⌘;): IDEA's dialog. Project Settings (Project, Modules,
 * Libraries, Facets, Artifacts), Platform Settings (SDKs, Global Libraries) and Problems,
 * all derived from the build model and the project's settings; Apply / OK write the draft.
 */
import { Dialog, IconButton, T } from "@/ui";
import { tx } from "@/platform/i18n";
import { useStructureData, useStructureLoading, type StructureData } from "./data";
import { ModulesPage, ProjectPage } from "./ProjectPages";
import { ArtifactsPage, FacetsPage, GlobalLibrariesPage, LibrariesPage, ProblemsPage, SdksPage } from "./PlatformPages";
import {
  applyDraft,
  closeProjectStructure,
  goBack,
  isDirty,
  showPage,
  useProjectStructure,
  type PageId,
} from "./store";
import styles from "./ProjectStructure.module.css";

const GROUPS: ReadonlyArray<{ title: string; pages: ReadonlyArray<{ id: PageId; title: string }> }> = [
  {
    title: "Project Settings",
    pages: [
      { id: "project", title: "Project" },
      { id: "modules", title: "Modules" },
      { id: "libraries", title: "Libraries" },
      { id: "facets", title: "Facets" },
      { id: "artifacts", title: "Artifacts" },
    ],
  },
  {
    title: "Platform Settings",
    pages: [
      { id: "sdks", title: "SDKs" },
      { id: "globalLibraries", title: "Global Libraries" },
    ],
  },
];

function Page({ page, data }: { page: PageId; data: StructureData }) {
  switch (page) {
    case "project":
      return <ProjectPage data={data} />;
    case "modules":
      return <ModulesPage data={data} />;
    case "libraries":
      return <LibrariesPage data={data} />;
    case "facets":
      return <FacetsPage data={data} />;
    case "artifacts":
      return <ArtifactsPage data={data} />;
    case "sdks":
      return <SdksPage data={data} />;
    case "globalLibraries":
      return <GlobalLibrariesPage />;
    case "problems":
      return <ProblemsPage data={data} />;
  }
}

const NAV_ORDER: readonly PageId[] = [...GROUPS.flatMap((g) => g.pages.map((p) => p.id)), "problems"];

/** ↑ / ↓ / Home / End move between the pages, like IDEA's sidebar list. */
function onNavKey(e: React.KeyboardEvent<HTMLElement>, page: PageId) {
  const i = NAV_ORDER.indexOf(page);
  const next =
    e.key === "ArrowDown"
      ? NAV_ORDER[Math.min(NAV_ORDER.length - 1, i + 1)]
      : e.key === "ArrowUp"
        ? NAV_ORDER[Math.max(0, i - 1)]
        : e.key === "Home"
          ? NAV_ORDER[0]
          : e.key === "End"
            ? NAV_ORDER[NAV_ORDER.length - 1]
            : undefined;
  if (!next) return;
  e.preventDefault();
  showPage(next);
  const nav = e.currentTarget;
  requestAnimationFrame(() => nav.querySelector<HTMLElement>(`[data-page="${next}"]`)?.focus());
}

function NavItem({
  id,
  title,
  current,
  badge,
}: {
  id: PageId;
  title: string;
  current: boolean;
  badge?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={styles.navItem}
      data-page={id}
      // One tab stop for the list; the arrows move within it.
      tabIndex={current ? 0 : -1}
      aria-current={current ? "page" : undefined}
      onClick={() => showPage(id)}
    >
      <span className={styles.navLabel}>
        <T>{title}</T>
      </span>
      {badge}
    </button>
  );
}

function ProjectStructureContent() {
  useStructureLoading();
  const data = useStructureData();
  const page = useProjectStructure((s) => s.page);
  const at = useProjectStructure((s) => s.at);
  const length = useProjectStructure((s) => s.history.length);
  const draft = useProjectStructure((s) => s.draft);
  const applying = useProjectStructure((s) => s.applying);
  const error = useProjectStructure((s) => s.error);
  const dirty = isDirty(draft);
  const errors = data.problems.filter((p) => p.severity === "error").length;
  const count = data.problems.length;

  return (
    <Dialog
      open
      title="Project Structure"
      onClose={closeProjectStructure}
      width="min(1100px, calc(100vw - 64px))"
      className={styles.dialog}
      footerStart={error ? <span className={styles.footerError}>{error}</span> : undefined}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "Apply", disabled: !dirty || applying, onClick: () => void applyDraft() },
        {
          label: "OK",
          role: "default",
          disabled: applying,
          onClick: () => void applyDraft().then((ok) => ok && closeProjectStructure()),
        },
      ]}
    >
      <div className={styles.layout}>
        <nav className={styles.sidebar} aria-label={tx("Project Structure")} onKeyDown={(e) => onNavKey(e, page)}>
          <div className={styles.history}>
            <IconButton icon="arrow-left" size="small" title="Back" disabled={at === 0} onClick={() => goBack(-1)} />
            <IconButton
              icon="arrow-right"
              size="small"
              title="Forward"
              disabled={at >= length - 1}
              onClick={() => goBack(1)}
            />
          </div>
          {GROUPS.map((g) => (
            <div key={g.title} role="group" aria-label={tx(g.title)}>
              <div className={styles.navGroup}>
                <T>{g.title}</T>
              </div>
              {g.pages.map((p) => (
                <NavItem key={p.id} id={p.id} title={p.title} current={page === p.id} />
              ))}
            </div>
          ))}
          <div className={styles.navRule} />
          <NavItem
            id="problems"
            title="Problems"
            current={page === "problems"}
            badge={
              count > 0 && (
                <span
                  className={errors ? styles.count : `${styles.count} ${styles.countWarning}`}
                  aria-label={tx`${count} problems`}
                >
                  {count}
                </span>
              )
            }
          />
        </nav>
        <main
          className={styles.main}
          aria-label={tx(GROUPS.flatMap((g) => g.pages).find((p) => p.id === page)?.title ?? "Problems")}
        >
          <Page page={page} data={data} />
        </main>
      </div>
    </Dialog>
  );
}

export function ProjectStructureDialog() {
  return <ProjectStructureContent />;
}
