import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { highlightTree } from "@lezer/highlight";
import { ensureSyntaxTree } from "@codemirror/language";
import { classHighlighter } from "@lezer/highlight";
import { parseDotEnv, symbolAt, tokenize } from "./syntax";
import { dotenvLanguage } from "./language";
import { composeEnvironment, declarationsIn, dockerfileEnv, isPrimarySource, sourceKind } from "./providers";
import { providersFor, usageAtColumn, usagesInLine } from "./usages";
import { inspectDotEnv, undefinedNested, DOTENV_INSPECTIONS } from "./inspections";
import { parseSource } from "./store";
import { languageOf, usageMasks } from "./search";
import { docKind, envSymbolAt, shortValue } from "./editor";
import type { LanguageInfo } from "@/platform/ipc";

const SAMPLE = `# Application
APP_NAME=AppName
APP_ENV=local
APP_URL=https://app.tes

# Database
DB_CONNECTION=mysql
export DB_HOST=127.0.0.1
DB_PORT: 3306
DB_DATABASE=database # main database name
DB_PASSWORD="asdfsdf#sadfsadf"
DB_URL="mysql://\${DB_HOST}:\${DB_PORT}/x"
CERT='line one
line two'
EMPTY=
ALONE
`;

/** The text of each token of `type`. */
const texts = (text: string, type: string) =>
  tokenize(text)
    .filter((t) => t.type === type)
    .map((t) => text.slice(t.from, t.to));

describe("lexer", () => {
  it("splits properties like the JetBrains lexer", () => {
    expect(texts(SAMPLE, "key")).toEqual([
      "APP_NAME",
      "APP_ENV",
      "APP_URL",
      "DB_CONNECTION",
      "DB_HOST",
      "DB_PORT",
      "DB_DATABASE",
      "DB_PASSWORD",
      "DB_URL",
      "CERT",
      "EMPTY",
      "ALONE",
    ]);
    expect(texts(SAMPLE, "comment")).toEqual(["# Application", "# Database", "# main database name"]);
    expect(texts(SAMPLE, "export")).toEqual(["export "]);
    expect(texts(SAMPLE, "separator")).toEqual(
      Array(11)
        .fill("=")
        .map((s, i) => (i === 5 ? ":" : s)),
    );
    expect(texts(SAMPLE, "nestedKey")).toEqual(["DB_HOST", "DB_PORT"]);
  });

  it("keeps `#` inside quotes and reads the rest after a closing quote as comment", () => {
    expect(texts(`A="x # y" trailing\n`, "comment")).toEqual([" trailing"]);
    expect(texts(`A='x # y'\n`, "value")).toEqual(["x # y"]);
    expect(texts(`A=x#y\n`, "comment")).toEqual(["#y"]);
  });

  it("treats `export` alone as a key", () => {
    expect(texts("export=1\n", "key")).toEqual(["export"]);
    expect(texts("export \n", "export")).toEqual([]);
  });
});

describe("parser", () => {
  const file = parseDotEnv(SAMPLE);
  const prop = (key: string) => file.properties.find((p) => p.key === key)!;

  it("reads keys, values and quotes", () => {
    expect(file.properties.map((p) => [p.key, p.value?.text ?? null])).toEqual([
      ["APP_NAME", "AppName"],
      ["APP_ENV", "local"],
      ["APP_URL", "https://app.tes"],
      ["DB_CONNECTION", "mysql"],
      ["DB_HOST", "127.0.0.1"],
      ["DB_PORT", "3306"],
      ["DB_DATABASE", "database"],
      ["DB_PASSWORD", "asdfsdf#sadfsadf"],
      ["DB_URL", "mysql://${DB_HOST}:${DB_PORT}/x"],
      ["CERT", "line one\nline two"],
      ["EMPTY", null],
      ["ALONE", null],
    ]);
    expect(prop("DB_HOST").exportSpan).not.toBeNull();
    expect(prop("DB_PASSWORD").value?.quote).toBe('"');
    expect(SAMPLE.slice(prop("DB_DATABASE").value!.from, prop("DB_DATABASE").value!.to)).toBe("database");
  });

  it("finds nested variables and multi-line values", () => {
    expect(file.nested.map((n) => [n.key, SAMPLE.slice(n.span.from, n.span.to)])).toEqual([
      ["DB_HOST", "${DB_HOST}"],
      ["DB_PORT", "${DB_PORT}"],
    ]);
    const certLine = SAMPLE.split("\n").findIndex((l) => l.startsWith("CERT"));
    expect([...file.continuationLines]).toEqual([certLine + 1]);
  });

  it("names the symbol at a position", () => {
    const at = (needle: string, offset = 1) => symbolAt(file, SAMPLE.indexOf(needle) + offset);
    expect(at("DB_PORT:")).toMatchObject({ kind: "declaration", key: "DB_PORT" });
    expect(at("${DB_PORT}", 3)).toMatchObject({ kind: "reference", key: "DB_PORT" });
    expect(at("mysql\n")).toBeNull();
  });
});

describe("highlighting", () => {
  it("colours keys as keywords, values as strings and comments", () => {
    const state = EditorState.create({ doc: 'export A=b # c\nB="x ${A}"\n', extensions: dotenvLanguage });
    const tree = ensureSyntaxTree(state, state.doc.length, 5000)!;
    const spans: string[] = [];
    highlightTree(tree, classHighlighter, (from, to, cls) =>
      spans.push(`${state.sliceDoc(from, to)}:${cls.replace(/tok-/g, "")}`),
    );
    expect(spans).toEqual([
      "export :comment",
      "A:keyword",
      "=:operator",
      "b :string",
      "# c:comment",
      "B:keyword",
      "=:operator",
      '"x ${:string',
      "A:keyword",
      '}":string',
    ]);
  });
});

describe("declaration providers", () => {
  it("classifies source files", () => {
    expect(sourceKind("/p/.env")).toBe("dotenv");
    expect(sourceKind("/p/.env.example")).toBe("dotenv");
    expect(sourceKind("/p/.env.d.ts")).toBeNull();
    expect(sourceKind("/p/docker-compose.prod.yml")).toBe("compose");
    expect(sourceKind("/p/composer.json")).toBeNull();
    expect(sourceKind("/p/api.Dockerfile")).toBe("dockerfile");
    expect(isPrimarySource("/p/.env", "dotenv")).toBe(true);
    expect(isPrimarySource("/p/.env.example", "dotenv")).toBe(false);
    expect(isPrimarySource("/p/docker-compose.yml", "compose")).toBe(true);
  });

  it("reads docker-compose environment maps and lists", () => {
    const text = `services:
  db:
    image: mysql
    environment:
      MYSQL_ROOT_PASSWORD: "secret" # root
      MYSQL_DATABASE: app
    ports:
      - "3306:3306"
  web:
    environment:
      - APP_ENV=production
      - "QUEUE=redis"
      - DEBUG
`;
    const vars = composeEnvironment(text);
    expect(vars.map((v) => [v.key, v.value])).toEqual([
      ["MYSQL_ROOT_PASSWORD", "secret"],
      ["MYSQL_DATABASE", "app"],
      ["APP_ENV", "production"],
      ["QUEUE", "redis"],
      ["DEBUG", ""],
    ]);
    for (const v of vars) expect(text.slice(v.keySpan.from, v.keySpan.to)).toBe(v.key);
  });

  it("reads Dockerfile ENV in both forms, continued lines included", () => {
    const text = `FROM node:22
ENV NODE_ENV=production PORT="8080"
ENV LEGACY some value
ENV A=1 \\
    B=two
RUN echo $NODE_ENV
`;
    const vars = dockerfileEnv(text);
    expect(vars.map((v) => [v.key, v.value])).toEqual([
      ["NODE_ENV", "production"],
      ["PORT", "8080"],
      ["LEGACY", "some value"],
      ["A", "1"],
      ["B", "two"],
    ]);
    for (const v of vars) expect(text.slice(v.keySpan.from, v.keySpan.to)).toBe(v.key);
    expect(declarationsIn("dotenv", "X=1\n")[0]).toMatchObject({ key: "X", value: "1" });
  });
});

describe("usage providers", () => {
  const keys = (language: string, line: string, path = "/p/file") =>
    usagesInLine(providersFor(language, path), line).map((u) => [u.key, line.slice(u.span.from, u.span.to)]);

  it("reads the env calls of each language", () => {
    expect(keys("php", `'host' => env('DB_HOST', 'mysql'), getenv("APP") . $_ENV['A'] . $_SERVER["B"]`)).toEqual([
      ["DB_HOST", "DB_HOST"],
      ["APP", "APP"],
      ["A", "A"],
      ["B", "B"],
    ]);
    expect(keys("php", `$app->env('X'); myenv('Y'); Env::get('Z')`)).toEqual([["Z", "Z"]]);
    expect(keys("typescript", "process.env.API_URL ?? process.env['TOKEN'] ?? import.meta.env.VITE_X")).toEqual([
      ["API_URL", "API_URL"],
      ["TOKEN", "TOKEN"],
      ["VITE_X", "VITE_X"],
    ]);
    expect(keys("python", `os.environ["A"], os.environ.get('B'), os.getenv("C"), environ['D']`)).toEqual([
      ["A", "A"],
      ["B", "B"],
      ["C", "C"],
      ["D", "D"],
    ]);
    expect(keys("ruby", `ENV['A'] || ENV.fetch("B")`)).toEqual([
      ["A", "A"],
      ["B", "B"],
    ]);
    expect(keys("go", 'os.Getenv("A"); os.LookupEnv(`B`)')).toEqual([
      ["A", "A"],
      ["B", "B"],
    ]);
    expect(keys("rust", `std::env::var("A"); env!("B"); option_env!("C")`)).toEqual([
      ["A", "A"],
      ["B", "B"],
      ["C", "C"],
    ]);
    expect(keys("java", `System.getenv("A"); System.getProperty("B"); dotenv.get("C")`)).toEqual([
      ["A", "A"],
      ["B", "B"],
      ["C", "C"],
    ]);
    expect(keys("kotlin", `dotenv["A"]`)).toEqual([["A", "A"]]);
    expect(keys("csharp", `Environment.GetEnvironmentVariable("A")`)).toEqual([["A", "A"]]);
  });

  it("reads ${NAME} only in docker-compose files and Dockerfiles", () => {
    expect(keys("yaml", "image: app:${TAG:-latest} $${NOT}", "/p/docker-compose.yml")).toEqual([["TAG", "TAG"]]);
    expect(keys("yaml", "image: app:${TAG}", "/p/config.yml")).toEqual([]);
    expect(keys("dockerfile", "FROM node:${NODE_VERSION}", "/p/Dockerfile")).toEqual([
      ["NODE_VERSION", "NODE_VERSION"],
    ]);
  });

  it("finds a key still being typed for completion", () => {
    const php = providersFor("php", "/p/a.php");
    expect(usageAtColumn(php, "env('')", 5)).toMatchObject({ key: "", span: { from: 5, to: 5 } });
    expect(usageAtColumn(php, "env('DB_')", 8)).toMatchObject({ key: "DB_" });
    expect(usageAtColumn(php, "env('DB_')", 2)).toBeNull();
    const js = providersFor("javascript", "/p/a.js");
    expect(usageAtColumn(js, "process.env.", 12)).toMatchObject({ key: "" });
  });
});

describe("inspections", () => {
  const producers = (text: string) => inspectDotEnv(text).map((p) => [p.producer, text.slice(p.from, p.to)]);
  const fix = (text: string, producer: string) => {
    const p = inspectDotEnv(text).find((p) => p.producer === producer)!;
    let out = text;
    for (const e of [...p.fix!.edits].sort((a, b) => b.from - a.from))
      out = out.slice(0, e.from) + e.insert + out.slice(e.to);
    return out;
  };

  it("reports nothing on a clean file", () => {
    expect(inspectDotEnv('# c\nA=1\n\nB="two words"\nC="${A}"\n')).toEqual([]);
  });

  it("reports the JetBrains DotEnv problems", () => {
    expect(producers("A=1\nA=2\n")).toEqual([
      [DOTENV_INSPECTIONS.duplicateKey, "A"],
      [DOTENV_INSPECTIONS.duplicateKey, "A"],
    ]);
    expect(producers("1A=x\n")).toEqual([[DOTENV_INSPECTIONS.leadingCharacter, "1A"]]);
    expect(producers("MY-KEY=x\n")).toEqual([[DOTENV_INSPECTIONS.incorrectDelimiter, "MY-KEY"]]);
    expect(producers("my_key=x\n")).toEqual([[DOTENV_INSPECTIONS.lowercaseKey, "my_key"]]);
    expect(producers("A = x\n")).toEqual([[DOTENV_INSPECTIONS.spaceAroundSeparator, " = "]]);
    expect(producers("A=two words\n")).toEqual([[DOTENV_INSPECTIONS.spaceInsideNonQuoted, "two words"]]);
    expect(producers("A=x  \n")).toEqual([[DOTENV_INSPECTIONS.trailingWhitespace, "  "]]);
    expect(producers('A="${}"\n')).toEqual([[DOTENV_INSPECTIONS.emptyNested, "${}"]]);
    expect(producers("A=${B}\n")).toEqual([[DOTENV_INSPECTIONS.nestedOutsideDoubleQuotes, "${B}"]]);
    expect(producers("A=1\n\n\n\nB=2\n").map(([p]) => p)).toEqual([DOTENV_INSPECTIONS.extraBlankLine]);
    expect(inspectDotEnv("A=${B}\n")[0]!.severity).toBe("error");
  });

  it("leaves multi-line quoted values alone", () => {
    expect(inspectDotEnv('A="one  \n\n\ntwo"\n')).toEqual([]);
    expect(inspectDotEnv('A="one  \n"\n')).toEqual([]);
  });

  it("fixes what the plugin fixes", () => {
    expect(fix("A=two words\n", DOTENV_INSPECTIONS.spaceInsideNonQuoted)).toBe("A='two words'\n");
    expect(fix('X="a"\nA=two words\n', DOTENV_INSPECTIONS.spaceInsideNonQuoted)).toBe('X="a"\nA="two words"\n');
    expect(fix("A = x\n", DOTENV_INSPECTIONS.spaceAroundSeparator)).toBe("A=x\n");
    expect(fix("A=x  \n", DOTENV_INSPECTIONS.trailingWhitespace)).toBe("A=x\n");
    expect(fix("A=1\n\n\n\nB=2\n", DOTENV_INSPECTIONS.extraBlankLine)).toBe("A=1\n\nB=2\n");
    expect(fix("my-key=1\n", DOTENV_INSPECTIONS.incorrectDelimiter)).toBe("my_key=1\n");
    expect(fix("my_key=1\n", DOTENV_INSPECTIONS.lowercaseKey)).toBe("MY_KEY=1\n");
    expect(fix("A=${B}\n", DOTENV_INSPECTIONS.nestedOutsideDoubleQuotes)).toBe('A="${B}"\n');
  });

  it("reports nested variables nothing declares", async () => {
    const text = 'A=1\nB="${A} ${C} ${D}"\n';
    const problems = await undefinedNested(parseDotEnv(text), async (k) => k === "D");
    expect(problems.map((p) => [p.producer, text.slice(p.from, p.to), p.message])).toEqual([
      [DOTENV_INSPECTIONS.undefinedNested, "C", "Reference to nested variable 'C' is undefined"],
    ]);
  });
});

describe("project model", () => {
  it("locates declarations and nested references by line and column", () => {
    const parsed = parseSource("/p/.env", 'A=1\n  B="${A}"\n')!;
    expect(parsed.declarations.map((d) => [d.key, d.line, d.col, d.primary])).toEqual([
      ["A", 0, 0, true],
      ["B", 1, 2, true],
    ]);
    expect(parsed.nested.map((n) => [n.key, n.line, n.col])).toEqual([["A", 1, 7]]);
    expect(parseSource("/p/notes.txt", "A=1")).toBeNull();
  });
});

describe("project search", () => {
  const infos = [
    { id: "php", extensions: ["php"] },
    { id: "typescript", extensions: ["ts", "d.ts"] },
    { id: "yaml", extensions: ["yml", "yaml"] },
  ] as unknown as LanguageInfo[];

  it("maps hits to the languages of their files", () => {
    expect(languageOf("/p/app/Config.php", infos)).toBe("php");
    expect(languageOf("/p/types/env.d.ts", infos)).toBe("typescript");
    expect(languageOf("/p/Dockerfile.dev", infos)).toBe("dockerfile");
    expect(languageOf("/p/README", infos)).toBeNull();
  });

  it("searches only files a usage provider reads", () => {
    const masks = usageMasks(infos);
    expect(masks).toContain("*.php");
    expect(masks).toContain("*.ts");
    expect(masks).toContain("docker-compose*.yml");
    expect(masks).not.toContain("*.yml");
  });
});

describe("editor", () => {
  it("knows which documents it serves", () => {
    expect(docKind({ language: "dotenv", path: "/p/.env" })).toBe("dotenv");
    expect(docKind({ language: "yaml", path: "/p/docker-compose.yml" })).toBe("compose");
    expect(docKind({ language: "php", path: "/p/a.php" })).toBe("code");
    expect(docKind({ language: "markdown", path: "/p/a.md" })).toBeNull();
  });

  it("finds declarations and references in docker-compose files", () => {
    const doc = "services:\n  web:\n    image: app:${TAG}\n    environment:\n      TAG: v1\n";
    const state = EditorState.create({ doc });
    const providers = providersFor("yaml", "/p/docker-compose.yml");
    expect(envSymbolAt("compose", providers, state, doc.indexOf("TAG}"))).toMatchObject({
      kind: "reference",
      key: "TAG",
    });
    expect(envSymbolAt("compose", providers, state, doc.indexOf("TAG: v1"))).toMatchObject({
      kind: "declaration",
      key: "TAG",
    });
  });

  it("shortens long values for the lookup", () => {
    expect(shortValue("a\n  b")).toBe("a b");
    expect(shortValue("x".repeat(80))).toHaveLength(48);
  });
});
