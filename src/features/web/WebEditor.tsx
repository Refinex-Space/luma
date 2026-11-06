/**
 * Text editor wrapper of HTML and XML files: the browser popup at the top right (IDEA's
 * floating "open in browser" toolbar, shown as Settings › Tools › Web Browsers and Preview
 * says) and, for HTML, the built-in preview beside the editor. The preview is a page of the
 * built-in server, so it reloads the way "Reload page in built-in preview" says.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { activeBrowsers, useWebBrowserPrefs, type ReloadMode } from "@/platform/webBrowserSettings";
import { FloatingToolbar, IconButton } from "@/ui";
import { browserIcon, isHtmlPath, openInBrowser, useWebPreview, webUrl } from "./browsers";
import styles from "./Web.module.css";
import { tx } from "@/platform/i18n";

export function WebEditor({ path, children }: { path: string; tabId: string; children: ReactNode }) {
  const html = isHtmlPath(path);
  const preview = useWebPreview((s) => html && !!s[path]);
  const prefs = useWebBrowserPrefs();
  const browsers = activeBrowsers(prefs);
  const ref = useRef<HTMLDivElement>(null);
  const popup = (html ? prefs.showHover : prefs.showHoverXml) && (browsers.length > 0 || html);
  return (
    <div className={clsx(styles.split, preview && styles.withPreview)}>
      <div ref={ref} className={styles.editor}>
        {children}
        {popup && (
          <FloatingToolbar targetRef={ref} className={styles.browserBar} hideOnTyping={false} retentionMs={1500}>
            <div className={styles.actions} role="toolbar" aria-label={tx("Open in browser")}>
              {html && (
                <IconButton
                  icon="eye"
                  size="small"
                  iconSize={16}
                  action="web.togglePreview"
                  actionArg={path}
                  pressed={preview}
                  title="Built-in Preview"
                />
              )}
              {browsers.map((b) => (
                <IconButton
                  key={b.id}
                  icon={browserIcon(b)}
                  size="small"
                  iconSize={16}
                  title={b.name}
                  onClick={() => void openInBrowser(path, b.id)}
                />
              ))}
            </div>
          </FloatingToolbar>
        )}
      </div>
      {preview && <WebPreview path={path} reload={prefs.previewReloadMode} />}
    </div>
  );
}

function WebPreview({ path, reload }: { path: string; reload: ReloadMode }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    webUrl(path, reload).then(
      (u) => live && setUrl(u),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [path, reload]);

  if (error) return <div className={clsx(styles.preview, styles.message)}>{error}</div>;
  if (!url) return <div className={styles.preview} />;
  return (
    <iframe
      className={styles.preview}
      title={tx("HTML preview")}
      src={url}
      sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
    />
  );
}
