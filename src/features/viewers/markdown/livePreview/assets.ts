/**
 * Images of the live preview: a Markdown image source resolved against the document and loaded
 * as a data URL (the CSP blocks file URLs; local files go through the backend). Remote images
 * are not loaded, as in the preview.
 */
import { call, commands } from "@/platform/ipc";
import { resolveLink } from "../render";

const cache = new Map<string, Promise<string>>();
const LIMIT = 96;

function load(path: string): Promise<string> {
  let p = cache.get(path);
  if (!p) {
    p = call(commands.fsReadImage(path));
    p.catch(() => cache.delete(path));
    if (cache.size >= LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(path, p);
  }
  return p;
}

export type ImageSource = { kind: "url"; url: Promise<string> } | { kind: "remote"; url: string } | { kind: "none" };

/** Where the image `src` of the Markdown file `doc` comes from. */
export function imageSource(doc: string, src: string): ImageSource {
  const s = src.trim().replace(/^<|>$/g, "");
  if (/^data:image\//i.test(s)) return { kind: "url", url: Promise.resolve(s) };
  const target = resolveLink(doc, s);
  if (target?.kind === "external") return { kind: "remote", url: target.url };
  if (target?.kind !== "file") return { kind: "none" };
  return { kind: "url", url: load(target.path) };
}

/** Drops cached images (a file changed on disk). */
export function forgetImage(path: string) {
  cache.delete(path);
}
