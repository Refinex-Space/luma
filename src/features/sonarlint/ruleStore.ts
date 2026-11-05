import { create } from "zustand";
import type { SonarRuleDescription } from "@/bindings";

export const useRuleDialog = create<{ rule: SonarRuleDescription | null }>(() => ({ rule: null }));

export const showRule = (rule: SonarRuleDescription) => useRuleDialog.setState({ rule });
export const closeRule = () => useRuleDialog.setState({ rule: null });
