/**
 * Spring Boot in Java editors of Boot modules: the Boot inspections (`@ConfigurationProperties`,
 * application setup, early event listeners, Reactor debug hooks, test constructors) with their
 * fixes, and gutter markers from `@ConfigurationProperties` classes and properties to their keys
 * in configuration files ("Usage in Spring Boot configuration files") and from auto-configuration
 * classes to their registrations.
 */
import type { Extension } from "@codemirror/state";
import { editorsFor, type EditorDocContext } from "@/editor/api";
import type { LineMarker } from "@/editor/navigation/lineMarkers";
import { tx } from "@/platform/i18n";
import { SPRING_BOOT_PRODUCERS } from "@/platform/inspections";
import { call, commands, isTauri } from "@/platform/ipc";
import { fixesExtension, inspectionsExtension } from "./config/editor";
import { bootStatus } from "./status";

const JAVA_PRODUCERS = [
  SPRING_BOOT_PRODUCERS.ConfigurationProperties,
  SPRING_BOOT_PRODUCERS.SpringBootApplicationSetup,
  SPRING_BOOT_PRODUCERS.SpringBootReactorHooksOnDebug,
  SPRING_BOOT_PRODUCERS.SpringBootEarlyEventListener,
  SPRING_BOOT_PRODUCERS.SpringBootTestConstructorAutowired,
];

export function javaEditorExtension(ctx: EditorDocContext): Extension {
  if (ctx.language !== "java" || ctx.virtual || ctx.doc < 0 || !isTauri()) return [];
  const path = ctx.path;
  const parts: Extension[] = [
    inspectionsExtension(path, JAVA_PRODUCERS, (text) => call(commands.springBootProblems(path, text, true))),
  ];
  if (!ctx.readOnly) parts.push(fixesExtension(path));
  return parts;
}

/** Gutter markers of a Java file of a Boot module. */
export async function bootMarkers(ctx: EditorDocContext): Promise<LineMarker[]> {
  if (!(await bootStatus(ctx.path))) return [];
  const text = editorsFor(ctx.path)[0]?.view.state.doc.toString();
  if (text === undefined) return [];
  const markers = await call(commands.springBootMarkers(ctx.path, text));
  return markers.map((m): LineMarker => {
    const config = m.kind === "configProperties";
    return {
      kind: config ? "bootConfig" : "bootRegistration",
      line: m.line,
      name: m.name,
      targets: m.targets,
      tooltip: config ? tx("Usage in Spring Boot configuration files") : tx("Navigate to import registration"),
      chooserTitle: config ? tx("Spring Boot Configuration Files") : tx("Choose Registration"),
    };
  });
}
