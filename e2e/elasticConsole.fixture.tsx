/** Mounts the Elasticsearch console's editor extensions on an editor of its own (browser mode has no backend to tell a `.es` file's language). */
import { autocompletion, type CompletionContext, type CompletionSource } from "@codemirror/autocomplete";
import { syntaxHighlighting } from "@codemirror/language";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { lumaHighlightStyle } from "../src/editor/core/cm/highlight";
import { lumaTheme } from "../src/editor/core/cm/theme";
import { esConsoleExtension, executeEsRequests } from "../src/features/database/elastic/EsConsole";
import { esLanguageDescription } from "../src/features/database/elastic/console/language";

export async function mountEsConsole(text: string): Promise<void> {
  const path = "/consoles/db/logs/console.es";
  const support = await esLanguageDescription.load();
  const host = document.createElement("div");
  host.setAttribute("data-es-console", "");
  host.style.cssText =
    "position:fixed;left:260px;top:60px;width:900px;height:380px;z-index:50;display:flex;flex-direction:column;border:1px solid var(--border);background:var(--bg-editor)";
  document.body.appendChild(host);
  const contributed = (ctx: CompletionContext) =>
    ctx.state.languageDataAt<CompletionSource>("lumaCompletion", ctx.pos)[0]?.(ctx) ?? null;
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: text,
      extensions: [
        lumaTheme,
        EditorView.theme({ "&": { height: "100%" } }),
        lineNumbers(),
        syntaxHighlighting(lumaHighlightStyle),
        support,
        autocompletion({ override: [contributed] }),
        Prec.high(keymap.of([{ key: "Mod-Enter", run: (v) => (void executeEsRequests(v, path), true) }])),
        esConsoleExtension({ doc: 1, path, language: "elasticsearch", uiMode: "Elasticsearch", readOnly: false }),
      ],
    }),
  });
  view.dom.style.flex = "1";
  view.dom.style.minHeight = "0";
}
