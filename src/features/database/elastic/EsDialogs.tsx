/**
 * Elasticsearch dialogs of the Database tool window: New Index (name, shards, replicas,
 * mappings). Shown by the `database.elasticDialogs` overlay.
 */
import { useMemo, useState } from "react";
import { Dialog, Input, T } from "@/ui";
import { tx } from "@/platform/i18n";
import { ErrorBoundary } from "@/workbench/ErrorBoundary";
import { sourceById } from "../store";
import { closeEsDialog, esJson, loadIndices, openDiscover, useElastic, type EsDialog } from "./store";
import db from "../Database.module.css";
import styles from "./Elastic.module.css";

/** Why `name` cannot name an index (Elasticsearch's rules), or null. */
export function indexNameError(name: string): string | null {
  if (!name) return tx("Enter a name");
  if (name !== name.toLowerCase()) return tx("Index names are lower case");
  if (/[\\/*?"<>| ,#:]/.test(name)) return tx('Index names cannot contain \\ / * ? " < > | , # : or spaces');
  if (/^[-_+]/.test(name)) return tx("Index names cannot start with -, _ or +");
  if (name === "." || name === "..") return tx("Not a valid index name");
  if (new TextEncoder().encode(name).length > 255) return tx("Index names are at most 255 bytes");
  return null;
}

/** The `PUT /<index>` body of the New Index dialog. */
export function createIndexBody(shards: number, replicas: number, mappings: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    settings: { number_of_shards: shards, number_of_replicas: replicas },
  };
  const m = mappings.trim();
  if (m) {
    const parsed = JSON.parse(m) as Record<string, unknown>;
    // `{ "properties": … }` or the whole `{ "mappings": … }` pasted from elsewhere.
    body.mappings = "mappings" in parsed ? parsed.mappings : parsed;
  }
  return body;
}

const MAPPINGS_PLACEHOLDER = `{
  "properties": {
    "@timestamp": { "type": "date" },
    "message": { "type": "text" }
  }
}`;

function CreateIndexDialog({ id }: { id: string }) {
  const [name, setName] = useState("");
  const [shards, setShards] = useState("1");
  const [replicas, setReplicas] = useState("1");
  const [mappings, setMappings] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameError = name ? indexNameError(name) : null;
  const shardsN = Number(shards);
  const replicasN = Number(replicas);
  const numbersOk = Number.isInteger(shardsN) && shardsN >= 1 && Number.isInteger(replicasN) && replicasN >= 0;
  const mappingsError = useMemo(() => {
    if (!mappings.trim()) return null;
    try {
      const v: unknown = JSON.parse(mappings);
      return v && typeof v === "object" && !Array.isArray(v) ? null : tx("Mappings are a JSON object");
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [mappings]);
  const invalid = !name || !!nameError || !numbersOk || !!mappingsError;

  const create = async () => {
    if (invalid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await esJson(id, "PUT", `/${encodeURIComponent(name)}`, createIndexBody(shardsN, replicasN, mappings));
      closeEsDialog();
      await loadIndices(id);
      void openDiscover(id, name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const source = sourceById(id)?.name ?? id;
  return (
    <Dialog
      open
      onClose={closeEsDialog}
      title={tx`New Index in ${source}`}
      width={560}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "Create", role: "default", disabled: busy || invalid, onClick: () => void create() },
      ]}
    >
      <div className={db.form}>
        <label className={db.formLabel} htmlFor="es-index-name">
          <T>Name:</T>
        </label>
        <Input
          id="es-index-name"
          mono
          autoFocus
          value={name}
          invalid={!!nameError}
          placeholder="logs-2026.11"
          onChange={(e) => setName(e.target.value)}
        />
        {nameError && (
          <>
            <span />
            <span className={styles.formError}>{nameError}</span>
          </>
        )}
        <label className={db.formLabel} htmlFor="es-index-shards">
          <T>Shards:</T>
        </label>
        <div className={db.formRow}>
          <Input
            id="es-index-shards"
            className={db.portInput}
            inputMode="numeric"
            value={shards}
            invalid={!(Number.isInteger(shardsN) && shardsN >= 1)}
            onChange={(e) => setShards(e.target.value)}
          />
          <label className={db.formLabel} htmlFor="es-index-replicas">
            <T>Replicas:</T>
          </label>
          <Input
            id="es-index-replicas"
            className={db.portInput}
            inputMode="numeric"
            value={replicas}
            invalid={!(Number.isInteger(replicasN) && replicasN >= 0)}
            onChange={(e) => setReplicas(e.target.value)}
          />
        </div>
        <label className={db.formLabel} htmlFor="es-index-mappings">
          <T>Mappings:</T>
        </label>
        <textarea
          id="es-index-mappings"
          className={styles.jsonInput}
          spellCheck={false}
          rows={9}
          value={mappings}
          placeholder={MAPPINGS_PLACEHOLDER}
          onChange={(e) => setMappings(e.target.value)}
        />
        {mappingsError && (
          <>
            <span />
            <span className={styles.formError}>{mappingsError}</span>
          </>
        )}
        {error && (
          <>
            <span />
            <span className={styles.formError} role="alert">
              {error}
            </span>
          </>
        )}
      </div>
    </Dialog>
  );
}

const instances = new WeakMap<EsDialog, number>();
let nextInstance = 0;

/** The open Elasticsearch dialog; each in its own error boundary (a crash never blocks the next). */
export function EsDialogs() {
  const dialog = useElastic((s) => s.dialog);
  if (!dialog) return null;
  let n = instances.get(dialog);
  if (n === undefined) instances.set(dialog, (n = nextInstance++));
  return (
    <ErrorBoundary key={n} name={`elasticsearch dialog ${dialog.kind}`}>
      <CreateIndexDialog id={dialog.id} />
    </ErrorBoundary>
  );
}
