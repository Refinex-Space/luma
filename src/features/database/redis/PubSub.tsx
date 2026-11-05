/**
 * Redis Pub/Sub of a data source (an editor tab): subscribe to channels and patterns
 * (`news.*`), watch messages arrive live (newest last, filterable, JSON pretty-printed
 * on selection), publish to a channel, and see the server's active channels.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Channel } from "@tauri-apps/api/core";
import { Button, EmptyState, IconButton, Input, T } from "@/ui";
import { call, commands, isCancelled, nextRequestId, type RedisMessage, type RequestId } from "@/platform/ipc";
import type { EditorInput } from "@/workbench/contributions";
import { tx } from "@/platform/i18n";
import { copyText } from "@/ui/selectableText";
import { sourceById, withConnection } from "../store";
import { bytesLabel, redisTarget, textBytes, type RedisInfoRef } from "./model";
import styles from "./PubSub.module.css";

/** Messages kept; older ones drop off the top. */
export const MAX_MESSAGES = 5000;

/** `news.*, alerts` → channels `alerts`, patterns `news.*` (glob characters make a pattern). */
export function subscriptionsOf(text: string): { channels: string[]; patterns: string[] } {
  const names = [...new Set(text.split(/[\s,]+/).filter(Boolean))];
  const glob = /[*?[]/;
  return { channels: names.filter((n) => !glob.test(n)), patterns: names.filter((n) => glob.test(n)) };
}

function pretty(text: string): string {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return text;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return text;
  }
}

interface Shown extends RedisMessage {
  seq: number;
}

export function RedisPubSub({ input }: { input: EditorInput }) {
  const { id } = input.data as RedisInfoRef;
  const source = sourceById(id);
  const target = redisTarget(id, 0);
  const [subscriptions, setSubscriptions] = useState("");
  const [active, setActive] = useState<{ request: RequestId; text: string } | null>(null);
  const [messages, setMessages] = useState<Shown[]>([]);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState("");
  const [payload, setPayload] = useState("");
  const [published, setPublished] = useState<string | null>(null);
  const [channels, setChannels] = useState<string[] | null>(null);
  const seq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  const stop = () => {
    if (active) void commands.cancelRequest(active.request);
    setActive(null);
  };
  useEffect(() => () => {
    if (active) void commands.cancelRequest(active.request);
  });

  const start = async () => {
    const { channels: chs, patterns } = subscriptionsOf(subscriptions);
    if (!chs.length && !patterns.length) return;
    const request = nextRequestId();
    const ch = new Channel<RedisMessage>();
    let pending: Shown[] = [];
    let frame = 0;
    ch.onmessage = (m) => {
      pending.push({ ...m, seq: seq.current++ });
      // Bursts render once per frame.
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          const batch = pending;
          pending = [];
          setMessages((all) => [...all, ...batch].slice(-MAX_MESSAGES));
        });
    };
    setError(null);
    setActive({ request, text: subscriptions });
    try {
      await withConnection(target, () => call(commands.redisSubscribe(request, target, chs, patterns, ch)));
    } catch (e) {
      if (!isCancelled(e)) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActive((a) => (a?.request === request ? null : a));
    }
  };

  const publish = async () => {
    try {
      const r = await withConnection(target, () =>
        call(commands.redisCommand(target, [textBytes("PUBLISH"), textBytes(channel), textBytes(payload)])),
      );
      setPublished(r.kind === "int" ? tx`Delivered to ${r.text} subscribers` : null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const loadChannels = async () => {
    try {
      const r = await withConnection(target, () =>
        call(commands.redisCommand(target, ["PUBSUB", "CHANNELS", "*"].map(textBytes))),
      );
      setChannels(
        r.kind === "array"
          ? r.items
              .map((i) => (i.kind === "bulk" ? bytesLabel(i.value) : ""))
              .filter(Boolean)
              .sort()
          : [],
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const q = filter.trim().toLowerCase();
  const shown = useMemo(
    () =>
      q
        ? messages.filter((m) => m.channel.text.toLowerCase().includes(q) || m.payload.text.toLowerCase().includes(q))
        : messages,
    [messages, q],
  );
  useEffect(() => {
    const el = listRef.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [shown.length]);
  const current = shown.find((m) => m.seq === selected) ?? null;

  return (
    <div className={styles.page}>
      <div className={styles.bar}>
        <Input
          className={styles.subscriptions}
          mono
          aria-label="Channels and patterns"
          placeholder={tx("Channels or patterns, e.g. orders, news.*")}
          value={subscriptions}
          disabled={!!active}
          onChange={(e) => setSubscriptions(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !active) void start();
          }}
        />
        {active ? (
          <Button size="small" onClick={stop}>
            <T>Unsubscribe</T>
          </Button>
        ) : (
          <Button size="small" variant="primary" disabled={!subscriptions.trim()} onClick={() => void start()}>
            <T>Subscribe</T>
          </Button>
        )}
        {active && <span className={styles.live} aria-label={tx("Listening")} />}
        <span className={styles.spacer} />
        <Input
          className={styles.filter}
          aria-label="Filter messages"
          placeholder={tx("Filter messages")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className={styles.count}>{tx`${shown.length} messages`}</span>
        <IconButton icon="trash" title="Clear Messages" disabled={!messages.length} onClick={() => setMessages([])} />
        <IconButton icon="history" title="Active Channels" onClick={() => void loadChannels()} />
      </div>
      {error && <div className={styles.error}>{error}</div>}
      {channels && (
        <div className={styles.channels}>
          <span className={styles.label}>
            <T>Active channels:</T>
          </span>
          {channels.length ? (
            channels.map((c) => (
              <button key={c} type="button" className={styles.channelChip} onClick={() => setChannel(c)}>
                {c}
              </button>
            ))
          ) : (
            <span className={styles.muted}>
              <T>none</T>
            </span>
          )}
          <IconButton icon="close" title="Hide" size="small" onClick={() => setChannels(null)} />
        </div>
      )}
      <div className={styles.main}>
        <div
          ref={listRef}
          className={styles.list}
          role="log"
          aria-label={tx("Messages")}
          onScroll={(e) => {
            const el = e.currentTarget;
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {!shown.length ? (
            <EmptyState title={active ? "Waiting for messages…" : "No messages"} />
          ) : (
            shown.map((m) => (
              <div
                key={m.seq}
                className={clsx(styles.row, m.seq === selected && styles.selected)}
                onClick={() => setSelected(m.seq)}
              >
                <span className={styles.time}>{new Date(m.time ?? 0).toLocaleTimeString()}</span>
                <span className={styles.channel} title={m.pattern ? tx`matched ${m.pattern}` : undefined}>
                  {bytesLabel(m.channel)}
                </span>
                <span className={styles.payload}>{bytesLabel(m.payload)}</span>
              </div>
            ))
          )}
        </div>
        {current && (
          <aside className={styles.detail} aria-label={tx("Message")}>
            <div className={styles.detailHead}>
              <span className={styles.channel}>{bytesLabel(current.channel)}</span>
              {current.pattern && <span className={styles.muted}>{tx`via ${current.pattern}`}</span>}
              <span className={styles.spacer} />
              <IconButton
                icon="copy"
                title="Copy Message"
                size="small"
                onClick={() => void copyText(current.payload.text)}
              />
              <IconButton icon="close" title="Hide" size="small" onClick={() => setSelected(null)} />
            </div>
            <pre className={styles.detailText}>
              {current.payload.binary ? bytesLabel(current.payload) : pretty(current.payload.text)}
            </pre>
          </aside>
        )}
      </div>
      {!source?.readOnly && (
        <div className={styles.publish}>
          <Input
            className={styles.publishChannel}
            mono
            aria-label="Channel"
            placeholder={tx("Channel")}
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
          />
          <Input
            className={styles.publishMessage}
            mono
            aria-label="Message"
            placeholder={tx("Message")}
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && channel.trim()) void publish();
            }}
          />
          <Button size="small" disabled={!channel.trim()} onClick={() => void publish()}>
            <T>Publish</T>
          </Button>
          {published && <span className={styles.muted}>{published}</span>}
        </div>
      )}
    </div>
  );
}
