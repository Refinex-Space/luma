/** A Mermaid SVG copied for the media viewer, safe to show beside its original. */

const ID_CHARS = /[^\w-]/g;

/**
 * A copy of `svg` safe to show next to its original: scripts, event handlers, external
 * references and imported styles removed; ids suffixed so its own `#refs` (markers, clip
 * paths, scoped styles) resolve to it, not to the original in the page.
 *
 * @returns the cleaned markup and its intrinsic size (from `viewBox`, else width/height), or
 *   null when `svg` is not an SVG
 */
export function cleanSvg(svg: string, suffix: string): { markup: string; width: number; height: number } | null {
  // Parsed as HTML: an SVG copied out of the page (`outerHTML`) is HTML-serialized, and
  // Mermaid's HTML labels (`<br>`, `&nbsp;` in foreignObject) are not well-formed XML.
  // DOMParser documents are inert: nothing in them runs.
  const el = new DOMParser().parseFromString(svg, "text/html").body.querySelector("svg");
  if (!el) return null;
  for (const bad of el.querySelectorAll("script, iframe, object, embed")) bad.remove();
  for (const node of [el, ...el.querySelectorAll("*")]) {
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) node.removeAttribute(attr.name);
      else if ((name === "href" || name === "xlink:href" || name === "src") && !attr.value.trim().startsWith("#"))
        node.removeAttribute(attr.name);
      else if (/url\(\s*['"]?(?!#)/i.test(attr.value)) node.removeAttribute(attr.name);
    }
  }
  for (const style of el.querySelectorAll("style"))
    style.textContent = (style.textContent ?? "")
      .replace(/@import[^;]*;?/gi, "")
      .replace(/url\(\s*(['"]?)(?!#)[^)]*\)/gi, "none");

  const box = (el.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  let width = box.length === 4 && box[2]! > 0 ? box[2]! : parseFloat(el.getAttribute("width") ?? "");
  let height = box.length === 4 && box[3]! > 0 ? box[3]! : parseFloat(el.getAttribute("height") ?? "");
  if (!(width > 0) || !(height > 0)) {
    width = 400;
    height = 300;
  }
  if (!el.getAttribute("viewBox")) el.setAttribute("viewBox", `0 0 ${width} ${height}`);
  el.setAttribute("width", "100%");
  el.setAttribute("height", "100%");
  el.removeAttribute("style");
  el.setAttribute("preserveAspectRatio", "xMidYMid meet");

  let markup = new XMLSerializer().serializeToString(el);
  const ids = [...new Set([...el.querySelectorAll("[id]"), el].map((n) => n.id).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  const tag = `-${suffix.replace(ID_CHARS, "")}`;
  for (const id of ids) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    markup = markup
      .replace(new RegExp(`(\\bid=")${escaped}(")`, "g"), `$1${id}${tag}$2`)
      .replace(new RegExp(`#${escaped}(?![\\w-])`, "g"), `#${id}${tag}`);
  }
  return { markup, width, height };
}
