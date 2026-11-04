/**
 * Title bar inbox: the agents with tasks waiting for the user, unread or running. The capsule
 * opens the most urgent task in one click; its ▾ lists every such task by what it needs.
 */
import { useRef, useState } from "react";
import clsx from "clsx";
import type { AgentTask } from "@/bindings";
import { tx } from "@/platform/i18n";
import { Icon, Menu, Spinner, T, type MenuItem } from "@/ui";
import { providerIcon } from "./model";
import { openTask, useAgents } from "./store";
import styles from "./Agents.module.css";

const recent = (a: AgentTask, b: AgentTask) => (b.updatedMs ?? 0) - (a.updatedMs ?? 0);

export function AgentsStatus() {
  const tasks = useAgents((s) => s.tasks);
  const unread = useAgents((s) => s.unread);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const list = [...tasks.values()];
  const input = list.filter((t) => t.status === "needsInput").sort(recent);
  const unseen = list.filter((t) => unread.has(t.id) && t.status !== "needsInput").sort(recent);
  const running = list.filter((t) => (t.status === "running" || t.status === "starting") && !unread.has(t.id));
  if (!input.length && !running.length && !unseen.length) return null;
  const target = input[0] ?? unseen[0] ?? running[0]!;
  // One face per agent, the most urgent first.
  const faces = [...new Set([...input, ...unseen, ...running].map((t) => t.provider))].slice(0, 3);
  const group = (label: string, items: AgentTask[]): MenuItem[] =>
    items.length
      ? [
          { kind: "header", label },
          ...items.map((t): MenuItem => ({
            id: t.id,
            label: t.title,
            verbatim: true,
            icon: providerIcon(t.provider),
            run: () => openTask(t.id),
          })),
        ]
      : [];
  const items: MenuItem[] = [
    ...group("Needs Input", input),
    ...group("Unread", unseen),
    ...group("Running", running),
    { kind: "separator" },
    { kind: "action", action: "agents.newTask" },
  ];
  const summary = [
    input.length ? `${input.length} ${tx("needs input")}` : "",
    running.length ? `${running.length} ${tx("running")}` : "",
    unseen.length ? `${unseen.length} ${tx("unread")}` : "",
  ].filter(Boolean);
  return (
    <div ref={ref} className={clsx(styles.inbox, input.length > 0 && styles.inboxWaiting)}>
      <button
        type="button"
        className={styles.inboxMain}
        aria-label={summary.join(", ")}
        onClick={() => openTask(target.id)}
      >
        <span className={styles.inboxFaces} aria-hidden="true">
          {faces.map((p) => (
            <span
              key={p}
              className={clsx(styles.inboxFace, input.some((t) => t.provider === p) && styles.inboxFaceWaiting)}
            >
              <Icon name={providerIcon(p)} size={12} />
            </span>
          ))}
        </span>
        {input.length > 0 ? (
          <span className={styles.statusPart}>
            {input.length} <T>needs input</T>
          </span>
        ) : running.length > 0 ? (
          <span className={styles.statusPart}>
            <Spinner size={10} />
            {running.length} <T>running</T>
          </span>
        ) : (
          <span className={styles.statusPart}>
            <span className={styles.unreadDot} aria-hidden="true" />
            {unseen.length} <T>unread</T>
          </span>
        )}
      </button>
      <button
        type="button"
        className={styles.inboxMore}
        aria-label={tx("Agent tasks")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="chevron-down" size={12} />
      </button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={ref}
        items={items}
        placement="bottom-end"
        aria-label="Agent tasks"
      />
    </div>
  );
}
