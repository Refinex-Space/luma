/**
 * Where code reads environment variables (the JetBrains plugin's
 * `EnvironmentVariablesUsagesProvider`s), by language: `getenv('KEY')` / `env('KEY')` /
 * `$_ENV['KEY']` in PHP, `process.env.KEY` in JavaScript, `os.environ['KEY']` in Python,
 * `System.getenv("KEY")` on the JVM and so on, plus `${KEY}` in docker-compose files and
 * Dockerfiles. The same patterns find the variable at the caret (completion, ⌘B) and
 * filter Find in Files hits into usages.
 */
import { isComposeName, isDockerfileName } from "./providers";
import type { Span } from "./syntax";

/** A variable name, possibly still being typed (empty right after the opening quote). */
const KEY = "([A-Za-z0-9_.\\-]*)";
/** A JavaScript member name after `process.env.`. */
const MEMBER = "([A-Za-z0-9_$]*)";
/** No receiver or other identifier before a bare call (`$app->env(`, `.env(`, `myenv(`); no lookbehind (WebKit < 16.4). */
const BARE = "(?:^|[^\\w$>.:])";

const Q = "['\"]";
const QB = "['\"`]";
const DQ = '"';
const call = (fn: string, quote = Q) => `${fn}\\s*\\(\\s*${quote}${KEY}`;
const index = (target: string, quote = Q) => `${target}\\s*\\[\\s*${quote}${KEY}`;

export interface UsageProvider {
  id: string;
  /** Backend language ids of the files this provider reads. */
  languages: readonly string[];
  /** Find in Files masks besides the languages' extensions. */
  masks?: readonly string[];
  /** Only these files of its languages (by name). */
  accepts?: (name: string) => boolean;
  /** Each ends with the key group. */
  patterns: readonly RegExp[];
}

const re = (sources: readonly string[]) => sources.map((s) => new RegExp(s, "g"));

const JVM = re([
  // `System.getenv("KEY")`, `dotenv.getEnv("KEY")` (JetBrains: any getenv / getEnv call).
  `\\b(?:getenv|getEnv)\\s*\\(\\s*${DQ}${KEY}`,
  call("\\bSystem\\.getProperty", DQ),
  // dotenv-java / dotenv-kotlin: `dotenv.get("KEY")`, `dotenv["KEY"]`.
  call("\\b[dD]ot[eE]nv\\.get", DQ),
  index("\\b[dD]ot[eE]nv", DQ),
]);

export const USAGE_PROVIDERS: readonly UsageProvider[] = [
  {
    id: "php",
    languages: ["php"],
    patterns: re([call(`${BARE}(?:getenv|env)`), index("\\$_(?:ENV|SERVER)"), call("\\bEnv::get")]),
  },
  {
    id: "javascript",
    languages: ["javascript", "typescript", "javascriptreact", "typescriptreact", "vue", "svelte"],
    patterns: re([
      `\\bprocess\\.env\\.${MEMBER}`,
      index("\\bprocess\\.env", QB),
      `\\bimport\\.meta\\.env\\.${MEMBER}`,
      index("\\bimport\\.meta\\.env", QB),
      call("\\bDeno\\.env\\.get", QB),
      `\\bBun\\.env\\.${MEMBER}`,
    ]),
  },
  {
    id: "python",
    languages: ["python"],
    patterns: re([
      index("\\b(?:os\\.)?environ"),
      call("\\b(?:os\\.)?environ\\.(?:get|setdefault|pop)"),
      call("\\b(?:os\\.)?getenv"),
    ]),
  },
  {
    id: "ruby",
    languages: ["ruby", "erb"],
    patterns: re([index("\\bENV"), call("\\bENV\\.(?:fetch|key\\?|has_key\\?|include\\?)")]),
  },
  {
    id: "go",
    languages: ["go"],
    patterns: re([call("\\b(?:os|syscall)\\.(?:Getenv|LookupEnv|Setenv|Unsetenv)", '["`]')]),
  },
  {
    id: "rust",
    languages: ["rust"],
    patterns: re([
      call("\\benv::(?:var|var_os|set_var|remove_var)", DQ),
      call("\\b(?:env|option_env)!", DQ),
      call("\\bdotenvy?::var", DQ),
    ]),
  },
  { id: "jvm", languages: ["java", "kotlin", "groovy", "scala"], patterns: JVM },
  {
    id: "csharp",
    languages: ["csharp"],
    patterns: re([call("\\bEnvironment\\.(?:GetEnvironmentVariable|SetEnvironmentVariable)", DQ)]),
  },
  {
    id: "elixir",
    languages: ["elixir"],
    patterns: re([call("\\bSystem\\.(?:get_env|fetch_env!?|put_env)", DQ)]),
  },
  { id: "swift", languages: ["swift"], patterns: re([index("\\bProcessInfo\\.processInfo\\.environment", DQ)]) },
  { id: "dart", languages: ["dart"], patterns: re([index("\\bPlatform\\.environment")]) },
  { id: "lua", languages: ["lua"], patterns: re([call("\\bos\\.getenv")]) },
  {
    id: "compose",
    languages: ["yaml"],
    masks: ["docker-compose*.yml", "docker-compose*.yaml", "compose*.yml", "compose*.yaml"],
    accepts: isComposeName,
    patterns: re([`(?:^|[^$])\\$\\{${KEY}`]),
  },
  {
    id: "dockerfile",
    languages: ["dockerfile"],
    masks: ["Dockerfile", "Dockerfile.*", "*.Dockerfile", "*.dockerfile", "Containerfile"],
    accepts: isDockerfileName,
    patterns: re([`(?:^|[^$])\\$\\{${KEY}`]),
  },
];

const byLanguage = new Map<string, UsageProvider[]>();
for (const p of USAGE_PROVIDERS) for (const l of p.languages) byLanguage.set(l, [...(byLanguage.get(l) ?? []), p]);

/** The usage providers of a file. */
export function providersFor(language: string, path: string): UsageProvider[] {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (byLanguage.get(language) ?? []).filter((p) => !p.accepts || p.accepts(name));
}

export interface KeyUsage {
  key: string;
  /** The key (empty right after an opening quote). */
  span: Span;
}

/** Usages in one line of text (offsets relative to `offset`); `partial` keeps empty keys. */
export function usagesInLine(
  providers: readonly UsageProvider[],
  line: string,
  offset = 0,
  partial = false,
): KeyUsage[] {
  const out: KeyUsage[] = [];
  for (const p of providers)
    for (const pattern of p.patterns) {
      pattern.lastIndex = 0;
      for (let m; (m = pattern.exec(line));) {
        const key = m[m.length - 1] ?? "";
        if (!m[0].length) pattern.lastIndex++;
        if (!key && !partial) continue;
        const to = offset + m.index + m[0].length;
        out.push({ key, span: { from: to - key.length, to } });
      }
    }
  return out.sort((a, b) => a.span.from - b.span.from);
}

/** The usage whose key contains (or ends at) `col` of `line`, if any. */
export function usageAtColumn(providers: readonly UsageProvider[], line: string, col: number): KeyUsage | null {
  return usagesInLine(providers, line, 0, true).find((u) => u.span.from <= col && col <= u.span.to) ?? null;
}
