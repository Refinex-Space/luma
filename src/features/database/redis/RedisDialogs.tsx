/**
 * The Redis dialogs of the Database tool window: New Key (any type, first value, TTL),
 * Rename Key, Set Time to Live, Filter Keys (a `SCAN MATCH` pattern) and Delete Keys
 * Matching (counted, confirmed). Shown as an overlay from `useRedis().dialog`.
 */
import { useState } from "react";
import { Checkbox, Dialog, Input, Select, T, type SelectOption } from "@/ui";
import { call, commands, type RedisBytes } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import { ErrorBoundary } from "@/workbench/ErrorBoundary";
import { tx } from "@/platform/i18n";
import { withConnection } from "../store";
import { KindChip } from "./KindChip";
import { bytesLabel, splitRedisTarget, textBytes, ttlLabel, type RedisTarget } from "./model";
import {
  closeRedisDialog,
  deleteMatching,
  keyChanged,
  keyRenamed,
  loadKeys,
  openKey,
  redisRun,
  useRedis,
  valueChanged,
  type RedisDialog,
} from "./store";
import db from "../Database.module.css";
import styles from "./Redis.module.css";

type NewKind = "string" | "hash" | "list" | "set" | "zset" | "stream" | "ReJSON-RL";

const KINDS: Array<SelectOption<NewKind>> = [
  { value: "string", label: "String" },
  { value: "hash", label: "Hash" },
  { value: "list", label: "List" },
  { value: "set", label: "Set" },
  { value: "zset", label: "Sorted Set" },
  { value: "stream", label: "Stream" },
  { value: "ReJSON-RL", label: "JSON" },
];

/** The commands creating a key of `kind` with its first value (and TTL). */
export function newKeyCommands(
  kind: NewKind,
  key: string,
  v: { value: string; field: string; score: string },
  ttlSeconds: number | null,
): string[][] {
  const create: string[] = (() => {
    switch (kind) {
      case "string":
        return ["SET", key, v.value];
      case "hash":
        return ["HSET", key, v.field, v.value];
      case "list":
        return ["RPUSH", key, v.value];
      case "set":
        return ["SADD", key, v.value];
      case "zset":
        return ["ZADD", key, v.score, v.value];
      case "stream":
        return ["XADD", key, "*", v.field, v.value];
      case "ReJSON-RL":
        return ["JSON.SET", key, "$", v.value];
    }
  })();
  return ttlSeconds ? [create, ["EXPIRE", key, String(ttlSeconds)]] : [create];
}

function NewKeyDialog({ target, prefix }: { target: RedisTarget; prefix: string }) {
  const [kind, setKind] = useState<NewKind>("string");
  const [key, setKey] = useState(prefix);
  const [field, setField] = useState("");
  const [value, setValue] = useState("");
  const [score, setScore] = useState("0");
  const [ttl, setTtl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsField = kind === "hash" || kind === "stream";
  const ttlSeconds = ttl.trim() ? Number(ttl) : null;
  const jsonError = kind === "ReJSON-RL" && value.trim() ? jsonProblem(value) : null;
  const invalid =
    !key.trim() ||
    (needsField && !field.trim()) ||
    (kind === "zset" && !Number.isFinite(Number(score))) ||
    (ttlSeconds !== null && !(Number.isInteger(ttlSeconds) && ttlSeconds > 0)) ||
    (kind === "ReJSON-RL" && (!value.trim() || !!jsonError));
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      // NX semantics: never overwrite a key that exists.
      const exists = await withConnection(target, () =>
        call(commands.redisCommand(target, [textBytes("EXISTS"), textBytes(key)])),
      );
      if (exists.kind === "int" && exists.text !== "0") {
        setError(tx`Key '${key}' already exists.`);
        return;
      }
      const cmds = newKeyCommands(kind, key, { value, field, score }, ttlSeconds).map((c) => c.map(textBytes));
      await withConnection(target, () => call(commands.redisTransaction(target, cmds)));
      closeRedisDialog();
      keyChanged(target);
      openKey(target, textBytes(key));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={closeRedisDialog}
      title={tx`New Key in db${splitRedisTarget(target).db}`}
      width={520}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "Create", role: "default", disabled: busy || invalid, onClick: () => void create() },
      ]}
    >
      <div className={db.form}>
        <span className={db.formLabel}>
          <T>Type:</T>
        </span>
        <div className={db.formRow}>
          <Select aria-label="Key type" value={kind} options={KINDS} onChange={setKind} />
          <KindChip kind={kind} />
        </div>
        <label className={db.formLabel} htmlFor="redis-new-key">
          <T>Key:</T>
        </label>
        <Input
          id="redis-new-key"
          mono
          autoFocus
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onFocus={(e) => e.currentTarget.setSelectionRange(key.length, key.length)}
        />
        {needsField && (
          <>
            <label className={db.formLabel} htmlFor="redis-new-field">
              <T>Field:</T>
            </label>
            <Input id="redis-new-field" mono value={field} onChange={(e) => setField(e.target.value)} />
          </>
        )}
        {kind === "zset" && (
          <>
            <label className={db.formLabel} htmlFor="redis-new-score">
              <T>Score:</T>
            </label>
            <Input
              id="redis-new-score"
              mono
              inputMode="decimal"
              invalid={!Number.isFinite(Number(score))}
              value={score}
              onChange={(e) => setScore(e.target.value)}
            />
          </>
        )}
        <label className={db.formLabel} htmlFor="redis-new-value">
          {kind === "set" || kind === "zset" ? <T>Member:</T> : <T>Value:</T>}
        </label>
        <textarea
          id="redis-new-value"
          className={styles.valueInput}
          spellCheck={false}
          rows={kind === "string" || kind === "ReJSON-RL" ? 5 : 2}
          value={value}
          placeholder={kind === "ReJSON-RL" ? '{"name": "Ada"}' : undefined}
          onChange={(e) => setValue(e.target.value)}
        />
        {jsonError && (
          <>
            <span />
            <span className={styles.error}>{jsonError}</span>
          </>
        )}
        <label className={db.formLabel} htmlFor="redis-new-ttl">
          <T>TTL:</T>
        </label>
        <div className={db.formRow}>
          <Input
            id="redis-new-ttl"
            className={db.portInput}
            inputMode="numeric"
            placeholder={tx("No limit")}
            invalid={ttlSeconds !== null && !(Number.isInteger(ttlSeconds) && ttlSeconds > 0)}
            value={ttl}
            onChange={(e) => setTtl(e.target.value)}
          />
          <span className={db.formHint}>
            <T>seconds</T>
          </span>
        </div>
        {error && (
          <>
            <span />
            <span className={styles.error}>{error}</span>
          </>
        )}
      </div>
    </Dialog>
  );
}

function jsonProblem(text: string): string | null {
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function RenameKeyDialog({ target, keyName }: { target: RedisTarget; keyName: RedisBytes }) {
  const initial = keyName.binary ? "" : keyName.text;
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const changed = !!name.trim() && name !== initial;
  const submit = async () => {
    setBusy(true);
    // RENAMENX: never replace another key.
    const ok = await redisRun(target, [textBytes("RENAMENX"), keyName, textBytes(name)], "Cannot rename the key");
    setBusy(false);
    if (!ok) return;
    closeRedisDialog();
    keyRenamed(target, keyName, textBytes(name));
  };
  return (
    <Dialog
      open
      onClose={closeRedisDialog}
      title="Rename Key"
      width={480}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "Rename", role: "default", disabled: busy || !changed, onClick: () => void submit() },
      ]}
    >
      <div className={db.dialogBody}>
        <label className={db.formLabelLeft} htmlFor="redis-rename">
          {tx`Rename '${bytesLabel(keyName)}' to:`}
        </label>
        <Input
          id="redis-rename"
          mono
          autoFocus
          value={name}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
    </Dialog>
  );
}

function TtlDialog({ target, keyName }: { target: RedisTarget; keyName: RedisBytes }) {
  const [seconds, setSeconds] = useState("");
  const [persist, setPersist] = useState(false);
  const [busy, setBusy] = useState(false);
  const n = Number(seconds);
  const valid = persist || (Number.isInteger(n) && n > 0);
  const submit = async () => {
    setBusy(true);
    const args = persist ? [textBytes("PERSIST"), keyName] : [textBytes("EXPIRE"), keyName, textBytes(String(n))];
    const ok = await redisRun(target, args, "Cannot set the time to live");
    setBusy(false);
    if (ok) {
      closeRedisDialog();
      valueChanged(target);
      notifications().notify({
        level: "info",
        title: persist
          ? tx`${bytesLabel(keyName)} never expires`
          : tx`${bytesLabel(keyName)} expires in ${ttlLabel(n * 1000)}`,
        key: "redis-ttl",
      });
    }
  };
  return (
    <Dialog
      open
      onClose={closeRedisDialog}
      title="Set Time to Live"
      width={440}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "Apply", role: "default", disabled: busy || !valid, onClick: () => void submit() },
      ]}
    >
      <div className={db.form}>
        <span className={db.formLabel}>
          <T>Key:</T>
        </span>
        <span className={styles.mono}>{bytesLabel(keyName)}</span>
        <label className={db.formLabel} htmlFor="redis-ttl">
          <T>Expire in:</T>
        </label>
        <div className={db.formRow}>
          <Input
            id="redis-ttl"
            className={db.portInput}
            autoFocus
            inputMode="numeric"
            disabled={persist}
            value={seconds}
            onChange={(e) => setSeconds(e.target.value)}
          />
          <span className={db.formHint}>
            <T>seconds</T>
          </span>
        </div>
        <span />
        <Checkbox checked={persist} onChange={setPersist} label="No limit (remove the expiry)" />
      </div>
    </Dialog>
  );
}

function FilterDialog({ target }: { target: RedisTarget }) {
  const current = useRedis.getState().keys[target]?.pattern ?? "*";
  const [pattern, setPattern] = useState(current === "*" ? "" : current);
  const apply = (p: string) => {
    closeRedisDialog();
    void loadKeys(target, { pattern: p.trim() || "*" });
  };
  return (
    <Dialog
      open
      onClose={closeRedisDialog}
      title={tx`Filter Keys of db${splitRedisTarget(target).db}`}
      width={460}
      buttons={[
        { label: "Clear Filter", disabled: current === "*", onClick: () => apply("*") },
        { label: "Cancel", role: "cancel" },
        { label: "Filter", role: "default", onClick: () => apply(pattern) },
      ]}
    >
      <div className={db.dialogBody}>
        <label className={db.formLabelLeft} htmlFor="redis-filter">
          <T>Keys matching (glob: * ? [abc]):</T>
        </label>
        <Input
          id="redis-filter"
          mono
          autoFocus
          placeholder="user:*"
          value={pattern}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setPattern(e.target.value)}
        />
      </div>
    </Dialog>
  );
}

function DeleteMatchingDialog({ target, pattern: initial }: { target: RedisTarget; pattern: string }) {
  const [pattern, setPattern] = useState(initial);
  const [busy, setBusy] = useState(false);
  const everything = /^\**$/.test(pattern.trim());
  const submit = async () => {
    setBusy(true);
    const n = await deleteMatching(target, pattern.trim());
    setBusy(false);
    if (n !== null) closeRedisDialog();
  };
  return (
    <Dialog
      open
      onClose={closeRedisDialog}
      title="Delete Keys Matching"
      width={480}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "Delete", role: "default", disabled: busy || !pattern.trim(), onClick: () => void submit() },
      ]}
    >
      <div className={db.dialogBody}>
        <label className={db.formLabelLeft} htmlFor="redis-delete-pattern">
          {tx`Delete every key of db${splitRedisTarget(target).db} matching:`}
        </label>
        <Input id="redis-delete-pattern" mono autoFocus value={pattern} onChange={(e) => setPattern(e.target.value)} />
        <span className={styles.warning}>
          {everything ? tx("This deletes every key of the database.") : tx("Deleted keys cannot be restored.")}
        </span>
      </div>
    </Dialog>
  );
}

function render(d: RedisDialog) {
  switch (d.kind) {
    case "newKey":
      return <NewKeyDialog key={d.target} target={d.target} prefix={d.prefix} />;
    case "rename":
      return <RenameKeyDialog target={d.target} keyName={d.key} />;
    case "ttl":
      return <TtlDialog target={d.target} keyName={d.key} />;
    case "filter":
      return <FilterDialog target={d.target} />;
    case "deleteMatching":
      return <DeleteMatchingDialog target={d.target} pattern={d.pattern} />;
  }
}

const instances = new WeakMap<object, number>();
let nextInstance = 1;

/** Each dialog opened gets a boundary of its own: one failing never keeps the next from opening. */
export function RedisDialogs() {
  const dialog = useRedis((s) => s.dialog);
  if (!dialog) return null;
  let n = instances.get(dialog);
  if (n === undefined) instances.set(dialog, (n = nextInstance++));
  return (
    <ErrorBoundary key={n} name={`redis dialog ${dialog.kind}`}>
      {render(dialog)}
    </ErrorBoundary>
  );
}
