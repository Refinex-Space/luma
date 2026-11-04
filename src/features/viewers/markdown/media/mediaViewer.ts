/**
 * The fullscreen viewer for a Markdown image or a rendered Mermaid diagram: one at a time,
 * opened from anywhere (the preview, the live editor's widgets, the context menu). The React
 * view mounts on first use into its own body-level host.
 */
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MediaViewerDialog } from "./MediaViewerDialog";

export type MediaItem =
  /** `src`: a URL the page can show (`data:`, `blob:`, `http(s):`), resolved by the caller. */
  | { kind: "image"; src: string; name: string }
  /** A rendered SVG (a Mermaid diagram); a cleaned copy is shown, the original is untouched. */
  | { kind: "svg"; svg: string; name: string };

export interface MediaViewerOptions {
  /** Called once when this item's viewer closes (also when another item replaces it). */
  onClose?: () => void;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let current: { item: MediaItem; opts: MediaViewerOptions; id: number } | null = null;
let seq = 0;

function render() {
  if (!root) {
    if (!current) return;
    host = document.createElement("div");
    host.dataset.mediaViewer = "";
    document.body.appendChild(host);
    root = createRoot(host);
  }
  root.render(
    current
      ? createElement(MediaViewerDialog, {
          key: current.id,
          item: current.item,
          onClose: closeMediaViewer,
        })
      : null,
  );
}

/** Shows `item`, replacing any item already shown. */
export function openMediaViewer(item: MediaItem, opts: MediaViewerOptions = {}): void {
  const previous = current;
  current = { item, opts, id: ++seq };
  previous?.opts.onClose?.();
  render();
}

/** Closes the viewer; does nothing when it is closed. */
export function closeMediaViewer(): void {
  const previous = current;
  if (!previous) return;
  current = null;
  render();
  previous.opts.onClose?.();
}

export function isMediaViewerOpen(): boolean {
  return current !== null;
}

/** Drops the React root (tests). */
export function disposeMediaViewer(): void {
  current = null;
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
}
