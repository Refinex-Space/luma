/**
 * Usages of an environment variable across the project (`getKeyUsages`): the Find in Files
 * engine lists the lines mentioning the name in files of a language with a usage
 * provider, which keeps the hits those providers read as a usage of the variable; `${NAME}`
 * in `.env` files (hidden, so not searched) comes from the parsed sources.
 */
import type { Location } from "@/bindings";
import { commands, nextRequestId, type LanguageInfo } from "@/platform/ipc";
import { cancelRequest, streamSearch } from "@/features/search/common/textSearch";
import { baseName } from "./providers";
import { nestedReferencesOf } from "./store";
import { USAGE_PROVIDERS, providersFor, usagesInLine } from "./usages";

let languages: Promise<LanguageInfo[]> | null = null;

function languageList(): Promise<LanguageInfo[]> {
  return (languages ??= commands.languages().catch(() => {
    languages = null;
    return [];
  }));
}

/** Language id of `path` by its extension (longest first, like the backend). */
export function languageOf(path: string, infos: readonly LanguageInfo[]): string | null {
  let rest = baseName(path).toLowerCase();
  if (/^(?:dockerfile|containerfile)(?:\..*)?$|\.dockerfile$/.test(rest)) return "dockerfile";
  for (let dot = rest.indexOf("."); dot >= 0; dot = rest.indexOf(".")) {
    rest = rest.slice(dot + 1);
    const info = infos.find((l) => l.extensions.includes(rest));
    if (info) return info.id;
  }
  return null;
}

/** Find in Files masks of every file a usage provider reads. */
export function usageMasks(infos: readonly LanguageInfo[]): string[] {
  const masks = new Set<string>();
  for (const p of USAGE_PROVIDERS) {
    if (p.masks) {
      p.masks.forEach((m) => masks.add(m));
      continue;
    }
    for (const id of p.languages)
      for (const ext of infos.find((l) => l.id === id)?.extensions ?? []) masks.add(`*.${ext}`);
  }
  return [...masks];
}

export async function findEnvUsages(key: string): Promise<Location[]> {
  const infos = await languageList();
  const out: Location[] = [];
  const request = nextRequestId();
  try {
    await streamSearch(
      request,
      {
        pattern: key,
        isRegex: false,
        caseSensitive: true,
        wholeWord: /^\w+$/.test(key),
        include: [usageMasks(infos).join(",")],
        exclude: [],
        scope: { kind: "project" },
        maxMatches: 0,
      },
      (file) => {
        const language = languageOf(file.path, infos);
        if (!language) return;
        const providers = providersFor(language, file.path);
        if (!providers.length) return;
        for (const m of file.matches)
          for (const u of usagesInLine(providers, m.text, m.textOffset))
            if (u.key === key)
              out.push({
                path: file.path,
                range: { start: { line: m.line, col: u.span.from }, end: { line: m.line, col: u.span.to } },
              });
      },
    );
  } catch (e) {
    cancelRequest(request);
    throw e;
  }
  for (const n of await nestedReferencesOf(key))
    out.push({
      path: n.path,
      range: { start: { line: n.line, col: n.col }, end: { line: n.line, col: n.col + n.key.length } },
    });
  return out;
}
