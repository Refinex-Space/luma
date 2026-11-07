/** Whether the open project uses Spring (`spring_status`), refreshed when its build changes. */
import { create } from "zustand";
import { call, commands, isTauri, type SpringStatus } from "@/platform/ipc";
import { useProject } from "@/platform/project";

interface State {
  root: string | null;
  status: SpringStatus | null;
}

const useStatus = create<State>(() => ({ root: null, status: null }));

export const useSpringStatus = () => useStatus((s) => s.status);
export const springStatus = () => useStatus.getState().status;

let seq = 0;

export async function refreshSpringStatus(): Promise<SpringStatus | null> {
  const root = useProject.getState().project?.root ?? null;
  const my = ++seq;
  if (!root || !isTauri()) {
    useStatus.setState({ root, status: null });
    return null;
  }
  try {
    const status = await call(commands.springStatus());
    if (my === seq) useStatus.setState({ root, status });
    return status;
  } catch {
    if (my === seq) useStatus.setState({ root, status: null });
    return null;
  }
}

export function onSpringStatus(listener: (s: SpringStatus | null) => void): () => void {
  return useStatus.subscribe((s, prev) => {
    if (s.status !== prev.status) listener(s.status);
  });
}
