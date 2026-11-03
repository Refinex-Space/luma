/** Change list dialogs: New / Edit Changelist, Move to Another Changelist, delete. */
import { useState } from "react";
import { Checkbox, Dialog, Input, Select, T } from "@/ui";
import { notifications } from "@/workbench/contributions";
import {
  activeList,
  addList,
  checksForList,
  editList,
  moveFiles,
  relOf,
  removeList,
  setActiveList,
  updateChangelists,
  useChangelists,
  validateListName,
} from "./changelists";
import { useCommit } from "./commitStore";
import { confirmDialog, openDialog } from "./dialogs";
import { fileCount } from "./model";
import { useVcs } from "./store";
import styles from "./common.module.css";
import { tx } from "@/platform/i18n";

interface FormValue {
  name: string;
  comment: string;
  active: boolean;
}

function ChangelistForm({
  value,
  onChange,
  error,
  activeDisabled,
}: {
  value: FormValue;
  onChange: (v: FormValue) => void;
  error: string | null;
  activeDisabled?: boolean;
}) {
  return (
    <div className={styles.form}>
      <label className={styles.fieldLabel} htmlFor="lama-cl-name">
        <T>Name:</T>
      </label>
      <Input
        id="lama-cl-name"
        data-autofocus
        value={value.name}
        invalid={!!value.name && !!error}
        onChange={(e) => onChange({ ...value, name: e.target.value })}
      />
      {value.name && error && <div className={styles.error}>{error}</div>}
      <label className={styles.fieldLabel} htmlFor="lama-cl-comment">
        <T>Comment:</T>
      </label>
      <textarea
        id="lama-cl-comment"
        className={styles.textarea}
        rows={3}
        value={value.comment}
        onChange={(e) => onChange({ ...value, comment: e.target.value })}
      />
      <Checkbox
        checked={value.active}
        disabled={activeDisabled}
        onChange={(active) => onChange({ ...value, active })}
        label="Set active"
      />
    </div>
  );
}

/** New Changelist…; `moveRels` are moved into the new list (Move to Another Changelist › New). */
export function newChangelist(moveRels: readonly string[] = []) {
  openDialog((close) => <NewChangelistDialog moveRels={moveRels} onClose={close} />);
}

function NewChangelistDialog({ moveRels, onClose }: { moveRels: readonly string[]; onClose: () => void }) {
  const state = useChangelists((s) => s.state);
  const [value, setValue] = useState<FormValue>({ name: "", comment: "", active: false });
  const error = validateListName(state, value.name);
  const create = () => {
    if (error) return;
    onClose();
    updateChangelists((s) => {
      const r = addList(s, value.name, { comment: value.comment, makeActive: value.active });
      return moveRels.length ? moveFiles(r.state, moveRels, r.id) : r.state;
    });
  };
  return (
    <Dialog
      open
      title="New Changelist"
      onClose={onClose}
      width={420}
      buttons={[
        { label: "OK", role: "default", disabled: !!error, onClick: create },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <ChangelistForm value={value} onChange={setValue} error={error} />
    </Dialog>
  );
}

export function editChangelist(id: string) {
  const list = useChangelists.getState().state.lists.find((l) => l.id === id);
  if (!list) return;
  openDialog((close) => <EditChangelistDialog id={id} onClose={close} />);
}

function EditChangelistDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const state = useChangelists((s) => s.state);
  const list = state.lists.find((l) => l.id === id);
  const [value, setValue] = useState<FormValue>({
    name: list?.name ?? "",
    comment: list?.comment ?? "",
    active: state.active === id,
  });
  const error = validateListName(state, value.name, id);
  const save = () => {
    if (error) return;
    onClose();
    updateChangelists((s) => {
      const edited = editList(s, id, value.name, value.comment);
      return value.active ? setActiveList(edited, id) : edited;
    });
  };
  return (
    <Dialog
      open
      title="Edit Changelist"
      onClose={onClose}
      width={420}
      buttons={[
        { label: "OK", role: "default", disabled: !!error, onClick: save },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <ChangelistForm value={value} onChange={setValue} error={error} activeDisabled={state.active === id} />
    </Dialog>
  );
}

export async function deleteChangelist(id: string) {
  const state = useChangelists.getState().state;
  const list = state.lists.find((l) => l.id === id);
  if (!list) return;
  if (id === state.active) {
    notifications().notify({
      group: "vcs",
      level: "info",
      title: "The active changelist cannot be deleted",
      body: "Make another changelist active first.",
    });
    return;
  }
  const count = Object.values(state.files ?? {}).filter((l) => l === id).length;
  if (count) {
    const ok = await confirmDialog({
      title: "Delete Changelist",
      message:
        count === 1
          ? tx`Changelist '${list.name}' contains ${count} change. It will be moved to '${activeList(state).name}'. Delete the changelist?`
          : tx`Changelist '${list.name}' contains ${count} changes. They will be moved to '${activeList(state).name}'. Delete the changelist?`,
      okLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
  }
  updateChangelists((s) => removeList(s, id));
}

export function setActiveChangelist(id: string) {
  updateChangelists((s) => setActiveList(s, id));
}

/** Commit… on a change list: include exactly its changes and focus the message. */
export function commitChangelist(id: string) {
  const { status, root } = useVcs.getState();
  const checks = checksForList(status, root ?? "", useChangelists.getState().state, id);
  useCommit.setState((s) => ({ checks, tab: "changes", focusTick: s.focusTick + 1 }));
}

/** Moves files (absolute paths) to a list. */
export function moveToChangelist(paths: readonly string[], id: string) {
  const rels = paths.map(relOf);
  updateChangelists((s) => moveFiles(s, rels, id));
}

/** Move to Another Changelist… (F6 in the Commit tool window). */
export function showMoveToChangelist(paths: readonly string[]) {
  if (!paths.length) {
    notifications().notify({ group: "vcs", level: "info", title: "Select changes to move" });
    return;
  }
  openDialog((close) => <MoveDialog paths={paths} onClose={close} />);
}

function MoveDialog({ paths, onClose }: { paths: readonly string[]; onClose: () => void }) {
  const state = useChangelists((s) => s.state);
  const currentLists = new Set(paths.map((p) => state.files?.[relOf(p)] ?? state.active));
  const others = state.lists.filter((l) => !(currentLists.size === 1 && currentLists.has(l.id)));
  const [mode, setMode] = useState<"existing" | "new">(others.length ? "existing" : "new");
  const [target, setTarget] = useState(others[0]?.id ?? state.active);
  const [value, setValue] = useState<FormValue>({ name: "", comment: "", active: false });
  const error = mode === "new" ? validateListName(state, value.name) : null;
  const move = () => {
    if (error) return;
    onClose();
    const rels = paths.map(relOf);
    if (mode === "new") {
      updateChangelists((s) => {
        const r = addList(s, value.name, { comment: value.comment, makeActive: value.active });
        return moveFiles(r.state, rels, r.id);
      });
    } else {
      updateChangelists((s) => moveFiles(s, rels, target));
    }
  };
  return (
    <Dialog
      open
      title="Move Changes to Another Changelist"
      onClose={onClose}
      width={440}
      buttons={[
        { label: "OK", role: "default", disabled: !!error, onClick: move },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form} role="radiogroup" aria-label={tx("Target changelist")}>
        <div className={styles.hint}>{fileCount(paths.length)}</div>
        <label className={styles.radioRow}>
          <input
            type="radio"
            name="target"
            checked={mode === "existing"}
            disabled={!others.length}
            onChange={() => setMode("existing")}
          />
          <span className={styles.radioText}>
            <T>Existing changelist:</T>
          </span>
        </label>
        <Select
          value={target}
          disabled={mode !== "existing"}
          aria-label="Existing changelist"
          onChange={setTarget}
          options={others.map((l) => ({ value: l.id, label: l.id === state.active ? tx`${l.name} (active)` : l.name }))}
        />
        <label className={styles.radioRow}>
          <input type="radio" name="target" checked={mode === "new"} onChange={() => setMode("new")} />
          <span className={styles.radioText}>
            <T>New changelist:</T>
          </span>
        </label>
      </div>
      {mode === "new" && <ChangelistForm value={value} onChange={setValue} error={error} />}
    </Dialog>
  );
}
