/**
 * Auto-configuration registration files of Boot modules (IDEA's "Spring Boot Imports" file
 * type): `META-INF/spring/*.imports` and `META-INF/spring.factories` — completion of class
 * names, navigation to the classes, and the registration inspection.
 */
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { EditorState, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { CONTRIBUTED_DEFINITION, type ContributedDefinition, type EditorDocContext } from "@/editor/api";
import { showHint } from "@/editor/lsp/hint";
import { navigateTo } from "@/editor/lsp/navigation";
import { tx } from "@/platform/i18n";
import { SPRING_BOOT_PRODUCERS } from "@/platform/inspections";
import { call, commands, isTauri } from "@/platform/ipc";
import { fixesExtension, inspectionsExtension } from "./config/editor";
import { bootStatus } from "./status";

const REGISTRATION = /[\\/]META-INF[\\/](spring[\\/][^\\/]+\.imports|spring\.factories)$/;

export const isRegistrationFile = (path: string) => REGISTRATION.test(path);

function completion(path: string) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    if (!(await bootStatus(path))) return null;
    const res = await call(commands.springBootComplete(path, ctx.state.doc.toString(), ctx.pos, ctx.explicit)).catch(
      () => null,
    );
    if (!res || ctx.aborted) return null;
    return {
      from: res.from,
      options: res.items.map((i) => ({
        label: i.label,
        type: i.kind === "class" ? "class" : "namespace",
        icon: i.kind === "class" ? "symbol-class" : "symbol-package",
      })),
      validFor: res.complete ? /^[\w.$]*$/ : undefined,
    };
  };
}

function definition(path: string): ContributedDefinition {
  return Object.assign(
    (view: EditorView, pos: number) => {
      void (async () => {
        const locations = await call(commands.springBootNavigate(path, view.state.doc.toString(), pos)).catch(() => []);
        if (locations[0]) return navigateTo(locations[0]);
        showHint(view, tx("Cannot find declaration to go to"), { pos });
      })();
      return true;
    },
    {
      covers: (state: EditorState, pos: number) =>
        /[\w$]/.test(state.sliceDoc(pos, pos + 1) || state.sliceDoc(pos - 1, pos)),
    },
  );
}

export function registrationEditorExtension(ctx: EditorDocContext): Extension {
  if (ctx.virtual || ctx.doc < 0 || !isTauri() || !isRegistrationFile(ctx.path)) return [];
  const path = ctx.path;
  const parts: Extension[] = [
    EditorState.languageData.of(() => [
      { lumaCompletion: completion(path), [CONTRIBUTED_DEFINITION]: definition(path) },
    ]),
    inspectionsExtension(path, [SPRING_BOOT_PRODUCERS.SpringBootImports], (text) =>
      call(commands.springBootProblems(path, text, true)),
    ),
  ];
  if (!ctx.readOnly) parts.push(fixesExtension(path));
  return parts;
}

/** `additional-spring-configuration-metadata.json`: the SpringBootAdditionalConfig inspection. */
export function additionalMetadataExtension(ctx: EditorDocContext): Extension {
  if (
    ctx.virtual ||
    ctx.doc < 0 ||
    !isTauri() ||
    !/[\\/]additional-spring-configuration-metadata\.json$/.test(ctx.path)
  )
    return [];
  const path = ctx.path;
  const parts: Extension[] = [
    inspectionsExtension(path, [SPRING_BOOT_PRODUCERS.SpringBootAdditionalConfig], (text) =>
      call(commands.springBootProblems(path, text, true)),
    ),
  ];
  if (!ctx.readOnly) parts.push(fixesExtension(path));
  return parts;
}
