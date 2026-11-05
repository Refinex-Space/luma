/** Mounts the Redis console's editor extensions on an editor of its own (browser mode has no backend to tell a `.redis` file's language). */
import { autocompletion, type CompletionContext, type CompletionSource } from "@codemirror/autocomplete";
import { syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { lumaHighlightStyle } from "../src/editor/core/cm/highlight";
import { lumaTheme } from "../src/editor/core/cm/theme";
import { redisConsoleExtension } from "../src/features/database/redis/console/RedisConsole";
import { redisLanguageDescription } from "../src/features/database/redis/console/language";
import { bindConsole } from "../src/features/database/store";

export async function mountRedisConsole(text: string): Promise<void> {
  const path = "/consoles/db/cache/console.redis";
  bindConsole(path, "cache:0");
  const support = await redisLanguageDescription.load();
  const host = document.createElement("div");
  host.setAttribute("data-redis-console", "");
  host.style.cssText =
    "position:fixed;left:260px;top:60px;width:900px;height:420px;z-index:50;border:1px solid var(--border);background:var(--bg-editor)";
  document.body.appendChild(host);
  const contributed = (ctx: CompletionContext) =>
    ctx.state.languageDataAt<CompletionSource>("lumaCompletion", ctx.pos)[0]?.(ctx) ?? null;
  new EditorView({
    parent: host,
    state: EditorState.create({
      doc: text,
      extensions: [
        lumaTheme,
        syntaxHighlighting(lumaHighlightStyle),
        support,
        autocompletion({ override: [contributed] }),
        redisConsoleExtension({ doc: 1, path, language: "redis", uiMode: "Redis", readOnly: false }),
      ],
    }),
  });
}
