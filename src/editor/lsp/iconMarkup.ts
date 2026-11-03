/** Design-system icons as DOM nodes for CodeMirror widgets. */
import { iconMarkupOrFallback, type IconName } from "@/ui";

export function iconNode(name: IconName | (string & {}), size = 16, className?: string): HTMLElement {
  const span = document.createElement("span");
  span.className = className ? `cm-lama-icon ${className}` : "cm-lama-icon";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = iconMarkupOrFallback(name, size);
  return span;
}
