/**
 * TeX math through KaTeX, shared by the Markdown preview and the live editor. KaTeX (and its
 * stylesheet, whose fonts Vite bundles as same-origin assets) loads on first use; results are
 * cached by source, so re-rendering a preview after an edit elsewhere costs nothing.
 */
type Katex = typeof import("katex").default;

let katex: Katex | null = null;
let loading: Promise<void> | null = null;

const CACHE_LIMIT = 256;
/** Rendered HTML by `display flag + source`, least recently used first. */
const cache = new Map<string, string>();

/** Loads KaTeX and its stylesheet, once. */
export function loadKatex(): Promise<void> {
  loading ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([m]) => {
    katex = m.default;
  });
  loading.catch(() => (loading = null));
  return loading;
}

/** Whether `loadKatex` has finished (math renders synchronously from then on). */
export const katexLoaded = () => katex !== null;

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function renderNow(k: Katex, tex: string, display: boolean): string {
  try {
    return k.renderToString(tex, { displayMode: display, throwOnError: true, output: "htmlAndMathml", trust: false });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // The source stays readable; the parse error is its tooltip.
    return `<span class="math-error" title="${escapeHtml(message)}">${escapeHtml(tex)}</span>`;
  }
}

/**
 * `tex` as HTML, or `null` while KaTeX is not loaded yet (call `loadKatex` and render again).
 * Invalid TeX comes back as its source in a `.math-error` span titled with the error.
 */
export function renderMathSync(tex: string, display: boolean): string | null {
  if (!katex) return null;
  const key = `${display ? "D" : "I"}${tex}`;
  let html = cache.get(key);
  if (html !== undefined) {
    // Refresh its place in the LRU order.
    cache.delete(key);
  } else {
    html = renderNow(katex, tex, display);
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  }
  cache.set(key, html);
  return html;
}

/** `tex` as HTML, loading KaTeX first when needed. */
export async function renderMath(tex: string, display: boolean): Promise<string> {
  await loadKatex();
  return renderMathSync(tex, display)!;
}

/**
 * Typesets the `[data-math]` elements under `root` (their text is the TeX source, as
 * `renderMarkdown` emits them). Synchronous once KaTeX is loaded; until then returns a
 * promise settling when they are done (elements detached meanwhile are skipped).
 */
export function renderMathIn(root: ParentNode): Promise<void> | null {
  const nodes = [...root.querySelectorAll<HTMLElement>("[data-math]:not([data-math-state])")];
  if (!nodes.length) return null;
  const apply = () => {
    for (const node of nodes) {
      if (node.dataset.mathState || !node.isConnected) continue;
      const html = renderMathSync(node.textContent ?? "", node.dataset.math === "display");
      if (html === null) continue;
      node.innerHTML = html;
      node.dataset.mathState = "done";
    }
  };
  if (katex) {
    apply();
    return null;
  }
  return loadKatex().then(apply);
}

/** For tests. */
export function resetMathForTests() {
  cache.clear();
  katex = null;
  loading = null;
}
