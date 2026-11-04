/**
 * The Prompt Library's state: what the user changed, persisted globally (localStorage, exported
 * with the settings like the live templates). Built-in prompts are not stored, only their
 * edits, so improved defaults reach everyone who did not edit them.
 */
import { create } from "zustand";
import type { AgentCommand, AgentConfigChoice } from "@/bindings";
import { loadJson, saveJson } from "@/features/templates/storage";
import { BUILTIN_GROUPS, builtinPrompt, commandName, type Prompt, type PromptGroup } from "./library";

export const PROMPT_LIBRARY_KEY = "luma.promptLibrary.v1";

/** The agent one-off generations (commit messages, pull request descriptions) use. */
export interface GenerationChoice {
  provider: string;
  /** Model, thinking effort…: the session settings to set, by option id. */
  config: AgentConfigChoice[];
}

export interface PromptLibraryState {
  /** Edited built-in prompt texts, by prompt id. */
  edited: Record<string, string>;
  /** Prompts the user added to built-in groups, by group id. */
  added: Record<string, Prompt[]>;
  /** The user's own groups, after the built-in ones. */
  groups: PromptGroup[];
  generation: GenerationChoice | null;
}

const EMPTY: PromptLibraryState = { edited: {}, added: {}, groups: [], generation: null };

export const usePromptLibrary = create<PromptLibraryState>(() => loadJson(PROMPT_LIBRARY_KEY, EMPTY));

function update(patch: (s: PromptLibraryState) => Partial<PromptLibraryState>) {
  usePromptLibrary.setState(patch);
  const { edited, added, groups, generation } = usePromptLibrary.getState();
  saveJson(PROMPT_LIBRARY_KEY, { edited, added, groups, generation });
}

/** Another window (the Settings window) saved: take its state. */
export function syncPromptLibrary(): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === PROMPT_LIBRARY_KEY) usePromptLibrary.setState(loadJson(PROMPT_LIBRARY_KEY, EMPTY));
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

/**
 * The library as shown and used: the built-in groups with their edits and added prompts, then
 * the user's groups.
 *
 * @param s the stored state
 * @returns the groups in order
 */
export function libraryGroups(s: PromptLibraryState): PromptGroup[] {
  const builtins = BUILTIN_GROUPS.map((g) => ({
    ...g,
    prompts: [
      ...g.prompts.map((p) => (s.edited[p.id] !== undefined ? { ...p, text: s.edited[p.id]! } : p)),
      ...(s.added[g.id] ?? []),
    ],
  }));
  return [...builtins, ...s.groups];
}

/** Every prompt of the library, by id. */
export function promptById(id: string, s = usePromptLibrary.getState()): Prompt | undefined {
  for (const g of libraryGroups(s)) {
    const p = g.prompts.find((q) => q.id === id);
    if (p) return p;
  }
  return undefined;
}

/** Whether a built-in prompt differs from what ships. */
export const isEdited = (id: string, s = usePromptLibrary.getState()) =>
  s.edited[id] !== undefined && s.edited[id] !== builtinPrompt(id)?.text;

/**
 * The prompts offered as `/command` in the agent composer, as agent commands.
 *
 * @param s the stored state
 * @returns one command per prompt with a command, its name as the description
 */
export function promptCommands(s: PromptLibraryState): AgentCommand[] {
  return libraryGroups(s).flatMap((g) =>
    g.prompts.flatMap((p) => (p.command ? [{ name: p.command, description: p.name, hint: null }] : [])),
  );
}

let counter = 0;
const newId = (prefix: string) => `${prefix}.${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Edits a prompt: a built-in one's text, or anything of one's own. */
export function editPrompt(id: string, patch: Partial<Pick<Prompt, "name" | "text" | "command">>) {
  const shipped = builtinPrompt(id);
  if (shipped) {
    if (patch.text === undefined) return;
    const text = patch.text;
    return update((s) => {
      const edited = { ...s.edited };
      if (text === shipped.text) delete edited[id];
      else edited[id] = text;
      return { edited };
    });
  }
  const apply = (list: Prompt[]) => list.map((p) => (p.id === id ? { ...p, ...patch } : p));
  update((s) => ({
    added: Object.fromEntries(Object.entries(s.added).map(([g, list]) => [g, apply(list)])),
    groups: s.groups.map((g) => ({ ...g, prompts: apply(g.prompts) })),
  }));
}

/** Puts every built-in prompt back as it ships (prompts and groups of one's own stay). */
export function resetAllPrompts() {
  update(() => ({ edited: {} }));
}

/** Puts a built-in prompt back as it ships. */
export function resetPrompt(id: string) {
  update((s) => {
    const edited = { ...s.edited };
    delete edited[id];
    return { edited };
  });
}

/** A command name no other prompt uses: `name`, else `name-2`… */
function freeCommand(name: string, s: PromptLibraryState, except?: string): string {
  const taken = new Set(
    libraryGroups(s).flatMap((g) => g.prompts.filter((p) => p.id !== except && p.command).map((p) => p.command!)),
  );
  const base = commandName(name) || "prompt";
  let n = 1;
  let candidate = base;
  while (taken.has(candidate)) candidate = `${base}-${++n}`;
  return candidate;
}

/**
 * Adds a prompt to a group (built-in or one's own).
 *
 * @param groupId the group
 * @param from a prompt to copy (Duplicate), else a new empty one
 * @returns the new prompt's id
 */
export function addPrompt(groupId: string, from?: Prompt): string {
  const s = usePromptLibrary.getState();
  const name = from ? `${from.name} Copy` : "New Prompt";
  const prompt: Prompt = { id: newId("prompt"), name, text: from?.text ?? "", command: freeCommand(name, s) };
  const builtin = BUILTIN_GROUPS.some((g) => g.id === groupId);
  update((st) =>
    builtin
      ? { added: { ...st.added, [groupId]: [...(st.added[groupId] ?? []), prompt] } }
      : { groups: st.groups.map((g) => (g.id === groupId ? { ...g, prompts: [...g.prompts, prompt] } : g)) },
  );
  return prompt.id;
}

/** Adds a group of one's own; returns its id. */
export function addGroup(name = "New Group"): string {
  const group: PromptGroup = { id: newId("group"), name, prompts: [] };
  update((s) => ({ groups: [...s.groups, group] }));
  return group.id;
}

export function renameGroup(id: string, name: string) {
  update((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g)) }));
}

/** Removes a prompt or a group of one's own (built-in ones stay). */
export function removeItem(id: string) {
  update((s) => ({
    groups: s.groups.filter((g) => g.id !== id).map((g) => ({ ...g, prompts: g.prompts.filter((p) => p.id !== id) })),
    added: Object.fromEntries(Object.entries(s.added).map(([g, list]) => [g, list.filter((p) => p.id !== id)])),
  }));
}

/** Moves a prompt of one's own (within its group) or a group of one's own by `dir`. */
export function moveItem(id: string, dir: -1 | 1) {
  const swap = <T extends { id: string }>(list: T[]): T[] => {
    const i = list.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return list;
    const out = [...list];
    [out[i], out[j]] = [out[j]!, out[i]!];
    return out;
  };
  update((s) => ({
    groups: swap(s.groups).map((g) => ({ ...g, prompts: swap(g.prompts) })),
    added: Object.fromEntries(Object.entries(s.added).map(([g, list]) => [g, swap(list)])),
  }));
}

/** Makes `command` unique among the prompts (or clears it when empty). */
export function setCommand(id: string, command: string) {
  const s = usePromptLibrary.getState();
  const name = commandName(command);
  editPrompt(id, { command: name ? freeCommand(name, s, id) : undefined });
}

export function setGeneration(choice: GenerationChoice | null) {
  update(() => ({ generation: choice }));
}
