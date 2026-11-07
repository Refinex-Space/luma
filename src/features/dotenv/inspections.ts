/**
 * The DotEnv inspections of the JetBrains plugin, over the parsed file. Each has its own
 * producer (Settings › Editor › Inspections › DotEnv) and, where the plugin has one, a
 * quick fix as a text edit.
 */
import { tx } from "@/platform/i18n";
import { DOTENV_PRODUCERS } from "@/platform/inspections";
import { parseDotEnv, type DotEnvFile, type DotEnvProperty } from "./syntax";

export const DOTENV_INSPECTIONS = DOTENV_PRODUCERS;

export type DotEnvInspection = (typeof DOTENV_INSPECTIONS)[keyof typeof DOTENV_INSPECTIONS];

export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

export interface DotEnvProblem {
  producer: DotEnvInspection;
  from: number;
  to: number;
  message: string;
  severity: "error" | "warning";
  fix?: { label: string; edits: TextEdit[] };
}

/** Lines of `text` with their offsets. */
function lines(text: string): Array<{ n: number; from: number; text: string }> {
  const out = [];
  let from = 0;
  let n = 0;
  for (const raw of text.split("\n")) {
    out.push({ n: n++, from, text: raw.replace(/\r$/, "") });
    from += raw.length + 1;
  }
  return out;
}

/** The quote a fix adds: the one most quoted values of the file use (single on a tie, as the plugin). */
function preferredQuote(file: DotEnvFile): string {
  let double = 0;
  let single = 0;
  for (const p of file.properties)
    if (p.value?.quote === '"') double++;
    else if (p.value?.quote === "'") single++;
  return double > single ? '"' : "'";
}

function keyProblems(p: DotEnvProperty): DotEnvProblem[] {
  const out: DotEnvProblem[] = [];
  const { from, to } = p.keySpan;
  if (!/^[A-Za-z_-]/.test(p.key))
    out.push({
      producer: DOTENV_INSPECTIONS.leadingCharacter,
      from,
      to,
      severity: "warning",
      message: tx("Invalid first character for a key. Only A-Z and '_' are allowed."),
    });
  if (p.key.includes("-"))
    out.push({
      producer: DOTENV_INSPECTIONS.incorrectDelimiter,
      from,
      to,
      severity: "warning",
      message: tx("Expected: '_' Found: '-'"),
      fix: { label: tx("Replace delimiter"), edits: [{ from, to, insert: p.key.replaceAll("-", "_") }] },
    });
  if (/[a-z]/.test(p.key))
    out.push({
      producer: DOTENV_INSPECTIONS.lowercaseKey,
      from,
      to,
      severity: "warning",
      message: tx("Key uses lowercase characters. Only uppercase characters are allowed."),
      fix: { label: tx("Change to uppercase"), edits: [{ from, to, insert: p.key.toUpperCase() }] },
    });
  return out;
}

/** Every problem of the file (messages and fix labels translated) except undefined nested variables (they need the project, `undefinedNested`). */
export function inspectDotEnv(text: string, file: DotEnvFile = parseDotEnv(text)): DotEnvProblem[] {
  const out: DotEnvProblem[] = [];

  const firstOf = new Map<string, DotEnvProperty>();
  const reported = new Set<DotEnvProperty>();
  const duplicate = (p: DotEnvProperty) => {
    reported.add(p);
    out.push({
      producer: DOTENV_INSPECTIONS.duplicateKey,
      from: p.keySpan.from,
      to: p.keySpan.to,
      severity: "warning",
      message: tx("Duplicate key"),
    });
  };

  for (const p of file.properties) {
    const first = firstOf.get(p.key);
    if (first) {
      if (!reported.has(first)) duplicate(first);
      duplicate(p);
    } else firstOf.set(p.key, p);

    out.push(...keyProblems(p));

    if (p.separator) {
      const before = text.slice(p.keySpan.to, p.separator.from);
      const after = p.value ? text.slice(p.separator.to, p.value.from) : "";
      if (/[ \t]/.test(before) || /[ \t]/.test(after)) {
        const from = p.keySpan.to;
        const to = p.value ? p.value.from : p.separator.to;
        out.push({
          producer: DOTENV_INSPECTIONS.spaceAroundSeparator,
          from,
          to,
          severity: "warning",
          message: tx("Extra spaces surrounding '='"),
          fix: { label: tx("Remove spaces surrounding '='"), edits: [{ from, to, insert: text[p.separator.from]! }] },
        });
      }
    }

    const v = p.value;
    if (v && !v.quote) {
      if (/\s/.test(v.raw)) {
        const q = preferredQuote(file);
        out.push({
          producer: DOTENV_INSPECTIONS.spaceInsideNonQuoted,
          from: v.from,
          to: v.to,
          severity: "warning",
          message: tx("Space inside is allowed only for quoted values"),
          fix: { label: tx("Add quotes"), edits: [{ from: v.from, to: v.to, insert: `${q}${v.raw}${q}` }] },
        });
      }
      if (v.raw.includes("${"))
        out.push({
          producer: DOTENV_INSPECTIONS.nestedOutsideDoubleQuotes,
          from: v.from,
          to: v.to,
          severity: "error",
          message: tx("Nested variables must not appear outside double quotes"),
          fix: {
            label: tx("Put value inside double quotes"),
            edits: [{ from: v.from, to: v.to, insert: `"${v.raw}"` }],
          },
        });
    }
  }

  for (const n of file.nested)
    if (!n.key)
      out.push({
        producer: DOTENV_INSPECTIONS.emptyNested,
        from: n.span.from,
        to: n.span.to,
        severity: "warning",
        message: tx("Reference to variable is empty"),
      });

  const all = lines(text);
  let blankRun: typeof all = [];
  const flushBlanks = (next: (typeof all)[number] | undefined) => {
    // One empty line between properties is fine; more are reported, all but one removed.
    if (blankRun.length >= 2) {
      const first = blankRun[0]!;
      const from = first.from;
      const to = next ? next.from : text.length;
      out.push({
        producer: DOTENV_INSPECTIONS.extraBlankLine,
        from,
        to: Math.max(from, to - 1),
        severity: "warning",
        message: tx("Only one extra line between properties is allowed"),
        fix: { label: tx("Remove extra blank line"), edits: [{ from, to, insert: next ? "\n" : "" }] },
      });
    }
    blankRun = [];
  };
  for (const l of all) {
    if (file.continuationLines.has(l.n)) {
      flushBlanks(l);
      continue;
    }
    if (!l.text.trim()) {
      // The last line of a file ending in a newline is no line.
      if (l.n === all.length - 1 && l.text === "") continue;
      blankRun.push(l);
      continue;
    }
    flushBlanks(l);
    if (file.quotedLineEnds.has(l.n)) continue;
    const m = /[ \t]+$/.exec(l.text);
    if (m) {
      const from = l.from + m.index;
      const to = l.from + l.text.length;
      out.push({
        producer: DOTENV_INSPECTIONS.trailingWhitespace,
        from,
        to,
        severity: "warning",
        message: tx("Line has trailing whitespace."),
        fix: { label: tx("Remove trailing whitespace"), edits: [{ from, to, insert: "" }] },
      });
    }
  }
  flushBlanks(undefined);

  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

/** Nested variables no source declares (`isDeclared` asks the project; the file's own keys count). */
export async function undefinedNested(
  file: DotEnvFile,
  isDeclared: (key: string) => Promise<boolean>,
): Promise<DotEnvProblem[]> {
  const own = new Set(file.properties.map((p) => p.key));
  const out: DotEnvProblem[] = [];
  for (const n of file.nested) {
    if (!n.key || own.has(n.key) || (await isDeclared(n.key))) continue;
    out.push({
      producer: DOTENV_INSPECTIONS.undefinedNested,
      from: n.keySpan.from,
      to: n.keySpan.to,
      severity: "warning",
      message: tx`Reference to nested variable '${n.key}' is undefined`,
    });
  }
  return out;
}
