/**
 * The project's environment variables (the JetBrains plugin's `EnvironmentVariablesApi`
 * over its `DotEnvKeyValuesIndex`): the declaring files come from the backend
 * (`dotenv_files`, which also finds git-ignored `.env` files), are parsed here and kept
 * until their modification time changes; open editors count with their unsaved text.
 * Asked again at most every `STALE_MS`, so typing in code does not hit the disk.
 */
import { editorsFor } from "@/editor/api";
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { dotenvPrefs } from "@/platform/dotenvSettings";
import { declarationsIn, isPrimarySource, sourceKind, type KeyValue, type SourceKind } from "./providers";
import { parseDotEnv, type NestedVariable } from "./syntax";

export interface Declaration extends KeyValue {
  path: string;
  kind: SourceKind;
  primary: boolean;
  /** 0-based line and UTF-16 column of the key. */
  line: number;
  col: number;
}

export interface NestedReference extends NestedVariable {
  path: string;
  line: number;
  col: number;
}

interface ParsedSource {
  path: string;
  mtimeMs: number | null;
  /** The text parsed (to skip re-parsing an unchanged open editor). */
  text: string;
  declarations: Declaration[];
  nested: NestedReference[];
}

const STALE_MS = 2000;

let sources = new Map<string, ParsedSource>();
let listedAt = -Infinity;
let listing: Promise<void> | null = null;
let root: string | null | undefined;

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

function position(starts: readonly number[], offset: number): { line: number; col: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, col: offset - starts[lo]! };
}

export function parseSource(path: string, text: string, mtimeMs: number | null = null): ParsedSource | null {
  const kind = sourceKind(path);
  if (!kind) return null;
  const starts = lineStarts(text);
  const primary = isPrimarySource(path, kind);
  return {
    path,
    mtimeMs,
    text,
    declarations: declarationsIn(kind, text).map((d) => ({
      ...d,
      path,
      kind,
      primary,
      ...position(starts, d.keySpan.from),
    })),
    nested:
      kind === "dotenv"
        ? parseDotEnv(text).nested.map((n) => ({ ...n, path, ...position(starts, n.keySpan.from) }))
        : [],
  };
}

function openText(path: string): string | null {
  return editorsFor(path)[0]?.view.state.doc.toString() ?? null;
}

async function relist(): Promise<void> {
  const listed = await call(commands.dotenvFiles());
  const next = new Map<string, ParsedSource>();
  await Promise.all(
    listed.map(async ({ path, mtimeMs }) => {
      const open = openText(path);
      const known = sources.get(path);
      if (open !== null) {
        const parsed = known?.text === open ? known : parseSource(path, open, mtimeMs);
        if (parsed) next.set(path, parsed);
        return;
      }
      if (known && known.mtimeMs === mtimeMs && mtimeMs !== null) {
        next.set(path, known);
        return;
      }
      try {
        const parsed = parseSource(path, await call(commands.fsReadText(path)), mtimeMs);
        if (parsed) next.set(path, parsed);
      } catch {
        // Unreadable (deleted meanwhile, not UTF-8): no variables from it.
      }
    }),
  );
  sources = next;
  listedAt = performance.now();
}

function resetOnProjectChange() {
  const current = useProject.getState().project?.root ?? null;
  if (current === root) return;
  root = current;
  sources = new Map();
  listedAt = -Infinity;
  listing = null;
}

/** The parsed sources, re-listed when older than `STALE_MS` (or `force`). */
export async function ensureSources(force = false): Promise<ParsedSource[]> {
  resetOnProjectChange();
  if (!isTauri() || !root) return [...sources.values()];
  if (force || performance.now() - listedAt > STALE_MS) {
    listing ??= relist().finally(() => (listing = null));
    try {
      await listing;
    } catch (e) {
      console.debug("[dotenv] listing failed", e);
    }
  }
  return [...sources.values()];
}

/** An open source file changed: its live text replaces what was read. */
export function updateOpenSource(path: string, text: string) {
  const known = sources.get(path);
  if (known?.text === text) return;
  const parsed = parseSource(path, text, known?.mtimeMs ?? null);
  if (parsed) sources.set(path, parsed);
}

/** Forgets what was listed (after the files changed on disk, a new project). */
export function invalidateSources() {
  listedAt = -Infinity;
}

export interface KeyValueEntry {
  key: string;
  /** Empty when values are not shown (Settings › .env files). */
  value: string;
}

/**
 * Every variable once, with the value of its first primary declaration, else of its
 * first secondary one (`getAllKeyValues`).
 */
export async function allKeyValues(): Promise<KeyValueEntry[]> {
  const showValues = dotenvPrefs().showValues;
  const primary = new Map<string, string>();
  const secondary = new Map<string, string>();
  for (const s of await ensureSources())
    for (const d of s.declarations) {
      const map = d.primary ? primary : secondary;
      if (!map.has(d.key)) map.set(d.key, showValues ? d.value : "");
    }
  for (const [k, v] of primary) secondary.set(k, v);
  return [...secondary].map(([key, value]) => ({ key, value }));
}

/** Where `key` is declared: its primary declarations, else its secondary ones (`getKeyDeclarations`). */
export async function declarationsOf(key: string): Promise<Declaration[]> {
  const all = (await ensureSources()).flatMap((s) => s.declarations.filter((d) => d.key === key));
  const primary = all.filter((d) => d.primary);
  return primary.length ? primary : all;
}

/** Whether any source declares `key`. */
export async function isDeclared(key: string): Promise<boolean> {
  return (await ensureSources()).some((s) => s.declarations.some((d) => d.key === key));
}

/** `${key}` inside the values of `.env` files. */
export async function nestedReferencesOf(key: string): Promise<NestedReference[]> {
  return (await ensureSources()).flatMap((s) => s.nested.filter((n) => n.key === key));
}

/** Test hook. */
export function _resetStore() {
  sources = new Map();
  listedAt = -Infinity;
  listing = null;
  root = undefined;
}
