/** The Agents header's "⋮" menu: where conversations open. */
import type { MenuItem } from "@/ui";
import { setSessionLocation, useAgents } from "./store";

export function useAgentsHeaderMenu(): MenuItem[] {
  const location = useAgents((s) => s.sessionLocation);
  return [
    {
      label: "Chat in Tool Window",
      checked: location === "toolWindow",
      run: () => setSessionLocation("toolWindow"),
    },
    {
      label: "Chat in Editor",
      checked: location === "editor",
      run: () => setSessionLocation("editor"),
    },
  ];
}
