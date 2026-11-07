/**
 * The Spring tool window's state: the application contexts, the selected one's beans, the
 * selected bean's detail and the view options. Asked again when the index changes (a saved
 * file) or the Spring model learns more (library beans).
 */
import { create } from "zustand";
import type { SpringBeanDetail, SpringBeanInfo, SpringContextInfo } from "@/platform/ipc";
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { DEFAULT_OPTIONS, type ExplorerOptions } from "./model";

const OPTIONS_KEY = "luma.spring.explorer.v1";

function loadOptions(): ExplorerOptions {
  try {
    const raw = globalThis.localStorage?.getItem(OPTIONS_KEY);
    if (raw) return { ...DEFAULT_OPTIONS, ...(JSON.parse(raw) as Partial<ExplorerOptions>) };
  } catch {
    // A private window or blocked storage: the defaults.
  }
  return DEFAULT_OPTIONS;
}

export interface ExplorerState {
  contexts: SpringContextInfo[];
  /** The selected context (`null`: none detected; every bean is shown). */
  contextId: string | null;
  beans: SpringBeanInfo[];
  loading: boolean;
  /** Loaded once at least (the first load shows a progress line, later ones keep the tree). */
  loaded: boolean;
  error: string | null;
  options: ExplorerOptions;
  filter: string;
  selected: string | null;
  detail: SpringBeanDetail | null;
  /** Bumped when a bean is revealed from elsewhere (the tree scrolls to it). */
  reveal: number;
}

export const useSpringExplorer = create<ExplorerState>(() => ({
  contexts: [],
  contextId: null,
  beans: [],
  loading: false,
  loaded: false,
  error: null,
  options: loadOptions(),
  filter: "",
  selected: null,
  detail: null,
  reveal: 0,
}));

const set = useSpringExplorer.setState;
const get = useSpringExplorer.getState;
let generation = 0;

/** Asks for the contexts and the selected context's beans (and the selected bean's detail). */
export async function refreshExplorer(): Promise<void> {
  if (!isTauri()) return;
  const gen = ++generation;
  set({ loading: true });
  try {
    const contexts = await call(commands.springContexts());
    if (gen !== generation) return;
    const current = get().contextId;
    const contextId = contexts.some((c) => c.id === current) ? current : (contexts[0]?.id ?? null);
    const beans = await call(commands.springBeans(contextId));
    if (gen !== generation) return;
    const selected = beans.some((b) => b.id === get().selected) ? get().selected : null;
    set({ contexts, contextId, beans, selected, loading: false, loaded: true, error: null });
    await loadDetail(selected);
  } catch (e) {
    if (gen === generation) set({ loading: false, loaded: true, error: e instanceof Error ? e.message : String(e) });
  }
}

let detailGeneration = 0;

async function loadDetail(bean: string | null) {
  const gen = ++detailGeneration;
  if (!bean) return set({ detail: null });
  try {
    const detail = await call(commands.springBeanDetail(get().contextId, bean));
    if (gen === detailGeneration) set({ detail });
  } catch {
    if (gen === detailGeneration) set({ detail: null });
  }
}

export function selectContext(id: string) {
  if (get().contextId === id) return;
  set({ contextId: id, selected: null, detail: null });
  void refreshExplorer();
}

export function selectBean(id: string | null) {
  if (get().selected === id) return;
  set({ selected: id });
  void loadDetail(id);
}

export function setExplorerFilter(filter: string) {
  set({ filter });
}

export function setExplorerOptions(patch: Partial<ExplorerOptions>) {
  const options = { ...get().options, ...patch };
  set({ options });
  try {
    globalThis.localStorage?.setItem(OPTIONS_KEY, JSON.stringify(options));
  } catch {
    // Not remembered: fine.
  }
}

/** Selects `bean` (of `context`) in the tool window, showing its group whatever the options. */
export async function revealBean(bean: string, context: string | null) {
  if (context && context !== get().contextId) {
    set({ contextId: context });
    await refreshExplorer();
  } else if (!get().loaded) await refreshExplorer();
  const b = get().beans.find((x) => x.id === bean);
  if (b) {
    const o = get().options;
    if (b.source === "library" && !o.libraries) setExplorerOptions({ libraries: true });
    if (b.source === "framework" && !o.implicit) setExplorerOptions({ implicit: true });
    if (b.test && !o.tests) setExplorerOptions({ tests: true });
  }
  set({ filter: "", selected: bean, reveal: get().reveal + 1 });
  await loadDetail(bean);
}

/** Keeps the tool window current while it is shown. */
export function watchExplorer(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void refreshExplorer(), 400);
  };
  const offs = [
    onIdeEvent("springModelChanged", later),
    onIdeEvent("indexState", (e) => {
      if (!e.indexing) later();
    }),
  ];
  void refreshExplorer();
  return () => {
    clearTimeout(timer);
    offs.forEach((off) => off());
  };
}
