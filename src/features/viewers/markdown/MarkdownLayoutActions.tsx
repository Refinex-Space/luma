import { IconButton } from "@/ui";
import { tx } from "@/platform/i18n";
import { toggleOutline, useOutline } from "./DocumentNav";
import { modeOf, useMarkdownModes, type MarkdownMode } from "./modes";
import styles from "./Markdown.module.css";

const LAYOUTS: ReadonlyArray<{ mode: MarkdownMode; action: string; icon: string; title: string }> = [
  { mode: "live", action: "markdown.livePreview", icon: "md-live-preview", title: "Live Preview" },
  { mode: "editor", action: "markdown.editorOnly", icon: "editor-only", title: "Source Only" },
  { mode: "split", action: "markdown.editorAndPreview", icon: "editor-preview", title: "Source and Preview" },
  { mode: "preview", action: "markdown.previewOnly", icon: "preview-only", title: "Preview Only" },
];

export function MarkdownLayoutActions({ path }: { path: string; tabId: string }) {
  const mode = useMarkdownModes((s) => modeOf(s, path));
  const outline = useOutline((s) => s.open);
  return (
    <div className={styles.layoutActions} role="toolbar" aria-label={tx("Markdown editor layout")}>
      {LAYOUTS.map((l) => (
        <IconButton
          key={l.mode}
          icon={l.icon}
          iconSize={16}
          size="small"
          title={l.title}
          action={l.action}
          actionArg={path}
          pressed={mode === l.mode}
        />
      ))}
      <span className={styles.layoutSeparator} aria-hidden />
      <IconButton
        icon="md-outline"
        iconSize={16}
        size="small"
        title={outline ? "Hide Outline" : "Show Outline"}
        pressed={outline}
        onClick={() => toggleOutline()}
      />
    </div>
  );
}
