/** Status bar: "⚡ Hot Reload" / "⚡ Reloaded 12:03" / a reload's problem, while a hot-reloading session runs. */
import clsx from "clsx";
import { BarButton, Icon } from "@/ui";
import { useTx } from "@/platform/i18n";
import { reloadSummary, reloadTitle } from "./format";
import { showTimeline, useHotSessions, type HotSession } from "./sessions";
import { statusOf } from "./timeline";
import styles from "./HotReload.module.css";

const clock = (at: number) => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** The live session the item is about: the one that reloaded last, else the newest. */
function current(sessions: readonly HotSession[]): HotSession | null {
  const live = sessions.filter((s) => s.live);
  if (!live.length) return null;
  const last = (s: HotSession) => s.timeline.entries[s.timeline.entries.length - 1]?.at ?? 0;
  return [...live].sort((a, b) => last(b) - last(a) || b.startedAt - a.startedAt)[0]!;
}

export function HotReloadStatus() {
  const tx = useTx();
  const sessions = useHotSessions((s) => s.sessions);
  const session = current(Object.values(sessions));
  if (!session) return null;
  const entry = session.timeline.entries[session.timeline.entries.length - 1];
  const status = entry ? statusOf(entry) : "ok";
  const time = entry ? clock(entry.at) : "";
  const text = !entry ? tx("Hot Reload") : status === "ok" ? tx`Reloaded ${time}` : `${reloadTitle(entry)} ${time}`;
  const tooltip = entry ? `${session.name}: ${reloadSummary(entry)}` : session.name;
  return (
    <BarButton
      className={clsx(styles.status, status !== "ok" && styles[status])}
      tooltip={tooltip}
      aria-label={entry ? tx`Hot Reload: ${text}` : text}
      data-hot-reload-status=""
      onClick={() => showTimeline(session.key)}
    >
      <Icon name={status === "ok" ? "hot-reload" : status === "error" ? "error" : "warning"} size={14} />
      <span>{text}</span>
    </BarButton>
  );
}
