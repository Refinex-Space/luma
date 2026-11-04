/**
 * The card a command tag shows on hover (in the composer and in sent messages): the command and
 * what it does. Tags carry `data-command`; the composer's sit in a layer under the textarea, so
 * hits are found by position rather than by the event target.
 */
import { useEffect, useRef, useState } from "react";
import type { AgentCommand } from "@/bindings";
import { Popup } from "@/ui";
import styles from "./Composer.module.css";

const SHOW_DELAY = 450;

interface Hovered {
  name: string;
  rect: DOMRect;
}

/**
 * The command tag under a point, among the tags in `container`.
 *
 * @param container the element holding the tags (`[data-command]`)
 * @param x the pointer's client x
 * @param y the pointer's client y
 * @returns the tag's command and the box of the line it is hit on, or `null`
 */
export function commandAt(container: Element | null, x: number, y: number): Hovered | null {
  if (!container) return null;
  for (const tag of container.querySelectorAll<HTMLElement>("[data-command]")) {
    // A tag broken over two lines has a box per line.
    for (const rect of tag.getClientRects()) {
      if (x >= rect.left && x <= rect.right && y >= rect.top - 2 && y <= rect.bottom + 2)
        return { name: tag.dataset.command!, rect };
    }
  }
  return null;
}

/**
 * Hover state for command tags: `move` reports the pointer and what is under it, `hide` takes
 * the card away (the pointer left, or the user typed: then it stays away until the pointer
 * moves, not on the pointer events a changed layout fires under a still pointer), and `card` is
 * the card to render.
 *
 * @param commands the agent's commands, for their descriptions
 * @param flip whether the card may turn to another side or alignment when it has no room
 *   (sent messages: right-aligned, maybe at the top of the list); the composer's stays above,
 *   moved in to fit
 */
export function useCommandHover(commands: readonly AgentCommand[], flip = false) {
  const [shown, setShown] = useState<Hovered | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<string | null>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const still = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const key = (h: Hovered) => `${h.name}@${Math.round(h.rect.left)},${Math.round(h.rect.top)}`;
  const point = (hit: Hovered | null) => {
    const next = hit ? key(hit) : null;
    if (next === pending.current) return;
    pending.current = next;
    clearTimeout(timer.current);
    if (!hit) return setShown(null);
    // Moving from one tag to the next shows the next at once, like tooltips do.
    if (shown) setShown(hit);
    else timer.current = setTimeout(() => setShown(hit), SHOW_DELAY);
  };
  const hide = () => {
    still.current = last.current;
    point(null);
  };
  const move = (x: number, y: number, hit: Hovered | null) => {
    last.current = { x, y };
    const s = still.current;
    if (s && Math.abs(s.x - x) < 2 && Math.abs(s.y - y) < 2) return;
    still.current = null;
    point(hit);
  };

  const command = shown ? commands.find((c) => c.name === shown.name) : undefined;
  const card = shown && command && (
    <Popup
      open
      anchor={{ getBoundingClientRect: () => shown.rect }}
      placement="top-start"
      offset={6}
      flip={flip}
      autoFocus={false}
      restoreFocus={false}
      closeOnOutsideClick={false}
      onClose={hide}
      role="tooltip"
      className={styles.commandCard}
    >
      <div className={styles.commandCardName}>/{command.name}</div>
      {command.description && <div className={styles.commandCardText}>{command.description}</div>}
      {command.hint && <div className={styles.commandCardHint}>{command.hint}</div>}
    </Popup>
  );
  return { move, hide, card };
}
