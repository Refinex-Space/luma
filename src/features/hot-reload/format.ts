/** How a reload reads: "3 classes reloaded · 1 bean · 180 ms", translated per count. */
import { tx } from "@/platform/i18n";
import { durationOf, statusOf, type ReloadEntry } from "./timeline";
import { classesText } from "./sessions";

const beansText = (n: number) => (n === 1 ? tx`${n} bean` : tx`${n} beans`);
const mappersText = (n: number) => (n === 1 ? tx`${n} mapper` : tx`${n} mappers`);

export function durationText(ms: number): string {
  if (ms < 1) return "";
  const n = Math.round(ms);
  const seconds = (ms / 1000).toFixed(1);
  return ms < 1000 ? tx`${n} ms` : tx`${seconds} s`;
}

/** The headline: what was reloaded, or what went wrong. */
export function reloadTitle(e: ReloadEntry): string {
  const status = statusOf(e);
  if (status === "error") return tx("Reload failed");
  if (e.restartFiles.length && !e.classes.length) return tx("Restart to apply");
  if (e.classes.length) {
    const classes = classesText(e.classes.length);
    return tx`${classes} reloaded`;
  }
  if (e.properties.length) return tx("Properties reloaded");
  if (e.beansAdded.length + e.beansRefreshed.length) return tx("Spring beans reloaded");
  if (e.mappers.length) return tx("Mappers reloaded");
  return status === "warning" ? tx("Reloaded with warnings") : tx("Reloaded");
}

/** Framework actions after the headline: "1 bean", "application.properties", "UserMapper.xml". */
export function reloadDetails(e: ReloadEntry): string[] {
  const out: string[] = [];
  const beans = e.beansAdded.length + e.beansRefreshed.length;
  if (e.classes.length && beans) out.push(beansText(beans));
  if (e.classes.length || beans) {
    const files = e.properties.filter(Boolean);
    if (files.length) out.push(files.join(", "));
    else if (e.properties.length) out.push(tx("properties"));
  }
  if (e.mappers.length && (e.classes.length || beans || e.properties.length))
    out.push(e.mappers.length === 1 ? e.mappers[0]! : mappersText(e.mappers.length));
  return out;
}

/** One line for the chip and the status bar: headline · details · duration. */
export function reloadSummary(e: ReloadEntry): string {
  const duration = statusOf(e) === "error" ? "" : durationText(durationOf(e));
  return [reloadTitle(e), ...reloadDetails(e), duration].filter(Boolean).join(" · ");
}

/** The first problem of a reload (its warning or error message). */
export const reloadProblem = (e: ReloadEntry): string | null => e.errors[0] ?? e.warnings[0] ?? null;
