/** What the Project Structure pages show: the build model, roots, libraries and JDKs, merged with the draft. */
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { call, commands, isTauri, type LibraryGroup } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { initProjectRoots, useDetectedRoots } from "@/platform/projectRoots";
import { useDetected } from "@/features/settings/languages/components";
import { loadModel, useBuild } from "@/features/build-tools/store";
import { detectFacets, projectArtifacts, projectJdk, projectLibraries, projectModules, projectProblems } from "./model";
import { savedValues, useProjectStructure } from "./store";

export const useLibraryGroups = create<{ groups: LibraryGroup[] | null; loading: boolean }>(() => ({
  groups: null,
  loading: false,
}));

/** Re-reads the project's library groups (each time the dialog opens). */
export async function loadLibraryGroups() {
  if (!isTauri()) {
    useLibraryGroups.setState({ groups: [], loading: false });
    return;
  }
  useLibraryGroups.setState({ loading: true });
  try {
    useLibraryGroups.setState({ groups: await call(commands.sdkProjectLibraries()), loading: false });
  } catch {
    useLibraryGroups.setState({ groups: [], loading: false });
  }
}

/** Loads what the dialog needs that may not be loaded yet (once per opening). */
export function useStructureLoading() {
  useEffect(() => initProjectRoots(), []);
  useEffect(() => {
    void loadLibraryGroups();
    if (!useBuild.getState().model && !useBuild.getState().loading) void loadModel();
  }, []);
}

export function useStructureData() {
  const project = useProject((s) => s.project);
  const settings = useProject((s) => s.settings);
  const build = useBuild((s) => s.model);
  const buildLoading = useBuild((s) => s.loading);
  const detected = useDetectedRoots();
  const groups = useLibraryGroups((s) => s.groups);
  const libsLoading = useLibraryGroups((s) => s.loading);
  const jdks = useDetected("jdk");
  const draft = useProjectStructure((s) => s.draft);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const saved = useMemo(() => savedValues(), [project, settings]);
  const name = draft.name ?? saved.name;
  const jdkSetting = draft.jdk ?? saved.jdk;
  const structure = draft.structure ?? saved.structure;

  const modules = useMemo(() => projectModules(build, detected, project?.name ?? ""), [build, detected, project?.name]);
  const libraries = useMemo(() => projectLibraries(groups ?? [], modules), [groups, modules]);
  const facets = useMemo(() => detectFacets(modules), [modules]);
  const artifacts = useMemo(() => projectArtifacts(modules), [modules]);
  const jdk = useMemo(() => projectJdk(jdkSetting, jdks.list), [jdkSetting, jdks.list]);
  const problems = useMemo(
    () => projectProblems({ build, modules, jdkSetting, jdks: jdks.loading ? null : jdks.list }),
    [build, modules, jdkSetting, jdks.loading, jdks.list],
  );
  return {
    project,
    build,
    buildLoading,
    detected,
    modules,
    libraries,
    librariesLoading: libsLoading || groups === null,
    facets,
    artifacts,
    jdks,
    jdk,
    jdkSetting,
    name,
    structure,
    problems,
  };
}

export type StructureData = ReturnType<typeof useStructureData>;
