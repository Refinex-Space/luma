/**
 * The problems part of the editor hover, after IDEA's `DaemonTooltipWithActionRenderer`:
 * each problem with its severity, message and origin, Copy and a ⋮ menu at its top right;
 * below them one action row for the most severe problem: its preferred quick fix (⌥⇧↵),
 * More actions… (⌥↵) and the contributed primary action (Fix with Agent).
 */
import { EditorSelection } from "@codemirror/state";
import { closeHoverTooltips, ViewPlugin, type EditorView } from "@codemirror/view";
import { problemActions, type ProblemAction, type ProblemRef } from "@/editor/api";
import { executeAction } from "@/platform/actions";
import { shortcutLabel } from "@/platform/keymap";
import { diagnosticInspection } from "@/platform/inspections";
import { problemControls } from "@/platform/inspectionControls";
import { tx } from "@/platform/i18n";
import { copyText } from "@/ui/selectableText";
import { showContextMenu, useContextMenuStore, type MenuItem } from "@/ui";
import type { PlacedDiagnostic } from "./diagnostics";
import { iconNode } from "./iconMarkup";
import { applyCodeAction, quickFixesAt } from "./intentions";
import { problemLocation, problemRef, problemText } from "./problems";

const SHOW_FIXES_KEY = "luma.problemHover.showQuickFixes";

/** IDEA's "Show Quick-Fixes" toggle of the hover's ⋮ menu (on by default). */
function showFixes(): boolean {
  try {
    return localStorage.getItem(SHOW_FIXES_KEY) !== "false";
  } catch {
    return true;
  }
}

function setShowFixes(on: boolean) {
  try {
    localStorage.setItem(SHOW_FIXES_KEY, String(on));
  } catch {
    // Not persisted (private window): the current card still follows.
  }
}

function button(className: string, label: string, icon: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.appendChild(iconNode(icon, 16));
  // Keep the editor's focus and selection: the click alone acts.
  b.addEventListener("mousedown", (e) => e.preventDefault());
  return b;
}

function link(text: string, shortcut: string | null, run: () => void, icon?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cm-lsp-problem-link";
  if (icon) b.appendChild(iconNode(icon, 14, "cm-lsp-problem-link-icon"));
  const label = document.createElement("span");
  label.className = "cm-lsp-problem-link-text";
  label.textContent = text;
  b.title = text;
  b.appendChild(label);
  if (shortcut) {
    const keys = document.createElement("span");
    keys.className = "cm-lsp-problem-keys";
    keys.textContent = shortcut;
    b.appendChild(keys);
  }
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", run);
  return b;
}

/** Copies, then shows a check on the button for a moment. */
function copyWithFeedback(target: HTMLButtonElement, text: string) {
  void copyText(text).then(() => {
    const copied = tx("Copied");
    const previous = target.title;
    target.classList.add("cm-lsp-problem-copied");
    target.replaceChildren(iconNode("check", 16));
    target.title = copied;
    target.setAttribute("aria-label", copied);
    setTimeout(() => {
      target.classList.remove("cm-lsp-problem-copied");
      target.replaceChildren(iconNode("copy", 16));
      target.title = previous;
      target.setAttribute("aria-label", previous);
    }, 1200);
  });
}

const run = (action: ProblemAction) => () => void Promise.resolve(action.run()).catch((e) => console.error(e));

/** The ⋮ menu of one problem: its actions, copying it, its inspection, the card's options. */
function problemMenu(view: EditorView, problem: ProblemRef, card: HTMLElement): MenuItem[] {
  const actions = problemActions(problem).map((a) => ({
    id: a.id,
    label: a.label,
    icon: a.icon,
    run: () => {
      view.dispatch({ effects: closeHoverTooltips });
      run(a)();
    },
  }));
  const inspection = diagnosticInspection(problem.server ?? problem.source ?? "", { code: problem.code });
  const items: MenuItem[] = [
    ...actions,
    ...(actions.length ? [{ kind: "separator" } as const] : []),
    { id: "problem.copy", label: "Copy Problem", icon: "copy", run: () => void copyText(problemText(problem)) },
    { id: "problem.copyLocation", label: "Copy Location", run: () => void copyText(problemLocation(problem)) },
    { id: "problem.copyMessage", label: "Copy Message", run: () => void copyText(problem.message) },
  ];
  if (inspection) items.push({ kind: "separator" }, ...(problemControls(inspection) as MenuItem[]));
  items.push(
    { kind: "separator" },
    {
      id: "problem.showFixes",
      label: "Show Quick-Fixes",
      checked: showFixes(),
      run: () => {
        setShowFixes(!showFixes());
        card.classList.toggle("cm-lsp-problems-nofixes", !showFixes());
      },
    },
  );
  return items;
}

/**
 * While a problem's ⋮ menu is open the hover stays: the menu lies outside the editor, and
 * CodeMirror closes the hover when the pointer leaves the editor or the tooltip. Those
 * `mouseleave`s are stopped (capture phase) until the menu closes.
 */
let menuOpen = false;

export const problemMenuKeepsHover = ViewPlugin.define((view) => {
  // On the window, capturing: ahead of the editor's and the tooltip's own listeners in every engine.
  const keep = (e: MouseEvent) => {
    if (menuOpen && e.target instanceof Node && view.dom.contains(e.target)) e.stopImmediatePropagation();
  };
  window.addEventListener("mouseleave", keep, true);
  return { destroy: () => window.removeEventListener("mouseleave", keep, true) };
});

function openMenu(at: HTMLElement, items: MenuItem[]) {
  const r = at.getBoundingClientRect();
  menuOpen = true;
  at.classList.add("cm-lsp-problem-tool-open");
  showContextMenu({ x: r.left, y: r.bottom + 2 }, items);
  const shown = useContextMenuStore.getState().menu;
  const off = useContextMenuStore.subscribe((s) => {
    if (s.menu === shown) return;
    off();
    menuOpen = false;
    at.classList.remove("cm-lsp-problem-tool-open");
  });
}

function problemRow(view: EditorView, placed: PlacedDiagnostic, card: HTMLElement): HTMLElement {
  const d = placed.diagnostic;
  const problem = problemRef(view, placed);
  const row = document.createElement("div");
  row.className = `cm-lsp-diag cm-lsp-diag-${d.severity}`;
  const msg = document.createElement("div");
  msg.className = "cm-lsp-diag-message";
  msg.textContent = d.message;
  // The rule (or the producer when it names none), quiet after the message as in IDEA.
  const origin = problem?.code ?? problem?.source ?? d.source;
  if (origin) {
    const tag = document.createElement("span");
    tag.className = "cm-lsp-diag-source";
    tag.textContent = origin;
    if (problem?.source && problem.code) tag.title = `${problem.source} ${problem.code}`;
    msg.append(" ", tag);
  }
  row.appendChild(msg);
  if (problem) {
    const tools = document.createElement("div");
    tools.className = "cm-lsp-problem-tools";
    const copy = button("cm-lsp-problem-tool", tx("Copy Problem"), "copy");
    copy.addEventListener("click", () => copyWithFeedback(copy, problemText(problem)));
    const more = button("cm-lsp-problem-tool", tx("More"), "more");
    more.setAttribute("aria-haspopup", "menu");
    more.addEventListener("click", () => openMenu(more, problemMenu(view, problem, card)));
    tools.append(copy, more);
    row.appendChild(tools);
  }
  return row;
}

/** IDEA's action row for `placed`: its quick fix once known, More actions…, and primary actions. */
function actionRow(view: EditorView, placed: PlacedDiagnostic): HTMLElement {
  const row = document.createElement("div");
  row.className = "cm-lsp-problem-actions";
  const start = document.createElement("div");
  start.className = "cm-lsp-problem-actions-start";
  const more = link(tx("More actions…"), shortcutLabel("code.showIntentions") ?? null, () => {
    view.dispatch({ selection: EditorSelection.cursor(placed.from), effects: closeHoverTooltips });
    view.focus();
    void executeAction("code.showIntentions");
  });
  start.appendChild(more);
  row.appendChild(start);
  const problem = problemRef(view, placed);
  const primary = problem ? problemActions(problem).filter((a) => a.primary) : [];
  if (primary.length) {
    const end = document.createElement("div");
    end.className = "cm-lsp-problem-actions-end";
    for (const a of primary)
      end.appendChild(
        link(
          tx(a.label),
          null,
          () => {
            view.dispatch({ effects: closeHoverTooltips });
            run(a)();
          },
          a.icon,
        ),
      );
    row.appendChild(end);
  }
  if (placed.diagnostic.severity !== "hint") offerQuickFix(view, start, more, placed.from, placed.to);
  return row;
}

/** The problem's preferred quick fix, inserted before More actions… once the server named one. */
function offerQuickFix(view: EditorView, into: HTMLElement, before: HTMLElement, from: number, to: number) {
  const doc = view.state.doc;
  void quickFixesAt(view, from, to)
    .then(([action]) => {
      if (!action || view.state.doc !== doc || !before.isConnected) return;
      const fix = link(action.title, shortcutLabel("code.applyQuickFix") ?? null, () => {
        view.dispatch({ effects: closeHoverTooltips });
        view.focus();
        void applyCodeAction(view, action);
      });
      fix.classList.add("cm-lsp-problem-fix");
      into.insertBefore(fix, before);
    })
    .catch(() => {});
}

/** The hover's problems: one row each, then the action row of the most severe one. */
export function renderProblems(view: EditorView, diags: PlacedDiagnostic[]): HTMLElement {
  const card = document.createElement("div");
  card.className = "cm-lsp-hover-diagnostics cm-lsp-problems";
  card.classList.toggle("cm-lsp-problems-nofixes", !showFixes());
  const list = document.createElement("div");
  list.className = "cm-lsp-problem-list";
  for (const placed of diags) list.appendChild(problemRow(view, placed, card));
  card.appendChild(list);
  if (diags[0]) card.appendChild(actionRow(view, diags[0]));
  return card;
}
