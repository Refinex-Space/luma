/** The New Task page's agent picker. */
import type { AgentProvider } from "@/bindings";
import type { tx as Tx } from "@/platform/i18n";
import type { SelectOption } from "@/ui";

/** Picker entry that opens Settings › Tools › Agents instead of choosing an agent. */
export const ADD_AGENT = "__addAgent__";

/** Installed agents, then More agents…. Registry agents show their version, or the update on offer. */
export function providerOptions(
  providers: readonly AgentProvider[],
  tx: typeof Tx,
  icon: (id: string) => string,
): SelectOption[] {
  const version = (p: AgentProvider) =>
    p.source.kind !== "registry" ? undefined : p.source.update ? tx`${p.source.update} available` : p.source.version;
  return [
    ...providers
      .filter((p) => p.installed)
      .map((p) => ({ value: p.id, label: p.name, icon: icon(p.id), detail: version(p) })),
    { value: ADD_AGENT, label: tx("More agents…") },
  ];
}
