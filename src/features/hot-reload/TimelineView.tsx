/**
 * The Hot Reload view of a Run tab / debug session: the runtime and agent at the top, then
 * every reload, newest first (time, what changed, framework actions, duration, problems);
 * a row expands to the classes, beans and files. The start-up comes last.
 */
import { useState } from "react";
import clsx from "clsx";
import { Button, EmptyState, Icon, T } from "@/ui";
import { useTx } from "@/platform/i18n";
import { durationOf, statusOf, type ReloadEntry, type StartupInfo } from "./timeline";
import { durationText, reloadDetails, reloadTitle } from "./format";
import { restartSession, useHotSessions } from "./sessions";
import styles from "./HotReload.module.css";

const statusIcon = (status: "ok" | "warning" | "error") => (status === "ok" ? "hot-reload" : status);

function Group({ title, items, mono }: { title: string; items: readonly string[]; mono?: boolean }) {
  const tx = useTx();
  if (!items.length) return null;
  return (
    <div className={styles.group}>
      <span className={styles.groupTitle}>{tx(title)}</span>
      <ul className={clsx(styles.groupItems, mono && styles.mono)}>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function EntryRow({ entry, sessionKey }: { entry: ReloadEntry; sessionKey: string }) {
  const tx = useTx();
  // A change that needs a restart opens with its Restart button.
  const [open, setOpen] = useState(entry.restartFiles.length > 0);
  const status = statusOf(entry);
  const details = reloadDetails(entry);
  const problem = entry.errors[0] ?? entry.warnings[0];
  const duration = status === "error" ? "" : durationText(durationOf(entry));
  return (
    <li className={clsx(styles.entry, styles[status])}>
      <button type="button" className={styles.entryHead} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} className={styles.chevron} />
        <Icon name={statusIcon(status)} size={14} className={styles.entryIcon} />
        <span className={styles.time}>{entry.time}</span>
        <span className={styles.entryTitle}>{reloadTitle(entry)}</span>
        <span>{entry.hotSwap && <span className={styles.tag}>HotSwap</span>}</span>
        <span className={styles.entryDetails}>{problem ?? details.join(" · ")}</span>
        <span className={styles.duration}>{duration}</span>
      </button>
      {open && (
        <div className={styles.entryBody}>
          {entry.restartFiles.length > 0 && (
            <div className={styles.entryAction}>
              <Button size="small" onClick={() => restartSession(sessionKey)}>
                Restart
              </Button>
            </div>
          )}
          <Group title="Classes" items={entry.classes} mono />
          <Group title="Spring beans added" items={entry.beansAdded} mono />
          <Group title="Spring beans refreshed" items={entry.beansRefreshed.map((b) => b || tx("(unnamed)"))} mono />
          <Group title="Properties" items={entry.properties.map((p) => p || tx("Configuration properties"))} />
          <Group title="MyBatis mappers" items={entry.mappers} />
          <Group title="Needs a restart" items={entry.restartFiles} />
          <Group title="Warnings" items={entry.warnings} />
          <Group title="Errors" items={entry.errors} />
        </div>
      )}
    </li>
  );
}

function StartupRow({ startup }: { startup: StartupInfo }) {
  const tx = useTx();
  const [open, setOpen] = useState(false);
  const warned = startup.warnings.length > 0;
  const plugins = startup.plugins.map((p) => (p.version ? `${p.name} ${p.version}` : p.name)).join(" · ");
  return (
    <li className={clsx(styles.entry, warned && styles.warning)}>
      <button
        type="button"
        className={styles.entryHead}
        aria-expanded={open}
        disabled={!warned}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon
          name={open ? "chevron-down" : "chevron-right"}
          size={12}
          className={clsx(styles.chevron, !warned && styles.hidden)}
        />
        <Icon name={warned ? "warning" : "run"} size={14} className={styles.entryIcon} />
        <span className={styles.time} />
        <span className={styles.entryTitle}>{tx("Started")}</span>
        <span />
        <span className={styles.entryDetails}>{plugins}</span>
        <span className={styles.duration} />
      </button>
      {open && (
        <div className={styles.entryBody}>
          <Group title="Warnings" items={startup.warnings} />
        </div>
      )}
    </li>
  );
}

export function TimelineView({ sessionKey }: { sessionKey: string }) {
  const tx = useTx();
  const session = useHotSessions((s) => s.sessions[sessionKey]);
  if (!session) return <EmptyState title="Not hot-reloading" />;
  const { timeline } = session;
  const agent = timeline.startup.agent;
  const engine = session.engine === "jrebel" ? "JRebel" : agent ? `HotswapAgent ${agent}` : "HotswapAgent";
  const entries = [...timeline.entries].reverse();
  const count = entries.length;
  const started = !!agent || timeline.startup.plugins.length > 0;
  return (
    <div className={styles.timeline} data-version={session.version}>
      <div className={styles.header}>
        <Icon name="hot-reload" size={14} className={styles.bolt} />
        <span className={styles.headerText}>
          {session.runtime} · {engine}
        </span>
        <span className={styles.headerCount}>
          {count > 0 && (count === 1 ? tx`${count} reload` : tx`${count} reloads`)}
        </span>
      </div>
      {entries.length === 0 && !started ? (
        <EmptyState title={session.live ? "Waiting for the application to start" : "No reloads"} />
      ) : (
        <ul className={styles.entries} aria-label={tx("Reloads")}>
          {entries.map((e) => (
            <EntryRow key={e.id} entry={e} sessionKey={sessionKey} />
          ))}
          {started && <StartupRow startup={timeline.startup} />}
          {entries.length === 0 && (
            <li className={styles.waiting}>
              <T>Save a change to reload it</T>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
