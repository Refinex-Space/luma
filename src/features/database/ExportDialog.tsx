/**
 * IDEA's Export Data dialog: extractor (format) and its options on the left,
 * a live preview on the right; copies to the clipboard or writes a file.
 */
import { useEffect, useMemo, useState } from "react";
import { call, commands } from "@/platform/ipc";
import { Checkbox, Dialog, IconButton, Input, Select, T } from "@/ui";
import { notifications } from "@/workbench/contributions";
import {
  DEFAULT_EXPORT_OPTIONS,
  EXPORT_FORMATS,
  exportData,
  extractorOf,
  extractorOptions,
  type ExportData,
  type ExportFormat,
  type ExportOptions,
} from "./export";
import { CodePreview } from "./CodePreview";
import { closeDialog } from "./store";
import styles from "./Database.module.css";
import { tx } from "@/platform/i18n";

const PREVIEW_ROWS = 100;

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${name}`;
}

export function ExportDialog({
  data,
  source,
  initialFormat = "csv",
  loadAll,
}: {
  data: ExportData;
  source: string;
  initialFormat?: ExportFormat;
  /** Re-runs the query for every row (a result with more rows than were fetched). */
  loadAll?: () => Promise<ExportData | null>;
}) {
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [format, setFormat] = useState<ExportFormat>(initialFormat);
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS);
  const ext = EXPORT_FORMATS.find((f) => f.id === format)!.extension;
  const [file, setFile] = useState(`${data.table}.${ext}`);
  const [dir, setDir] = useState<string | null>(null);
  useEffect(() => {
    void import("@tauri-apps/api/path")
      .then((p) => p.homeDir())
      .then((home) => {
        setDir(home);
        setFile((f) => (f.includes("/") || f.includes("\\") ? f : joinPath(home, f)));
      })
      .catch(() => {});
  }, []);
  const changeFormat = (f: ExportFormat) => {
    setFormat(f);
    // The file follows the format's extension.
    const next = EXPORT_FORMATS.find((x) => x.id === f)!.extension;
    setFile((path) => path.replace(/\.[^./\\]*$/, `.${next}`));
  };

  const tabular = extractorOf(format).tabular;
  const effective = tabular ? options : DEFAULT_EXPORT_OPTIONS;
  const preview = useMemo(
    () => exportData(format, { ...data, rows: data.rows.slice(0, PREVIEW_ROWS) }, effective),
    [format, data, effective],
  );
  /** The rows to write: fetched, or all of the query's. */
  const rows = async (): Promise<ExportData | null> => {
    if (!all || !loadAll) return data;
    setBusy(true);
    try {
      return await loadAll();
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof ExportOptions) => (v: boolean) => setOptions((o) => ({ ...o, [k]: v }));

  const browse = async () => {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const f = EXPORT_FORMATS.find((x) => x.id === format)!;
      const path = await save({ defaultPath: file, filters: [{ name: f.label, extensions: [f.extension] }] });
      if (path) setFile(path);
    } catch {
      // No dialog (tests): keep typing the path.
    }
  };

  const toFile = async () => {
    const path = file.trim();
    if (!path) return;
    const target = /^([a-zA-Z]:)?[\\/]/.test(path) || !dir ? path : joinPath(dir, path);
    try {
      const d = await rows();
      if (!d) return;
      await call(commands.dbExportFile(target, exportData(format, d, effective)));
      notifications().notify({
        level: "info",
        title: `${d.rows.length} rows exported`,
        body: target,
        key: "db-export",
      });
      closeDialog();
    } catch (e) {
      notifications().notify({
        level: "error",
        title: "Cannot export data",
        body: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <Dialog
      open
      onClose={closeDialog}
      title="Export Data"
      width={860}
      buttons={[
        { label: "Cancel", role: "cancel" },
        {
          label: "Copy to Clipboard",
          disabled: busy,
          onClick: () =>
            void rows().then((d) => {
              if (!d) return;
              void navigator.clipboard?.writeText(exportData(format, d, effective));
              closeDialog();
            }),
        },
        {
          label: "Export to File",
          role: "default",
          disabled: !file.trim() || busy,
          onClick: () => void toFile(),
        },
      ]}
    >
      <div className={styles.exportDialog}>
        <div className={styles.exportOptions}>
          <span className={styles.formLabel}>
            <T>Source:</T>
          </span>
          <Input readOnly value={source} aria-label="Source" />
          <span className={styles.formLabel}>
            <T>Extractor:</T>
          </span>
          <Select
            aria-label="Extractor"
            value={format}
            options={extractorOptions(data.driver)}
            onChange={(v) => changeFormat(v as ExportFormat)}
          />
          {loadAll && (
            <Checkbox checked={all} onChange={setAll} label={tx`All rows of the query (${data.rows.length} fetched)`} />
          )}
          <Checkbox checked={effective.transpose} disabled={!tabular} onChange={set("transpose")} label="Transpose" />
          <Checkbox
            checked={effective.columnHeader}
            disabled={!tabular}
            onChange={set("columnHeader")}
            label="Add column header"
          />
          <Checkbox
            checked={effective.rowHeader}
            disabled={!tabular}
            onChange={set("rowHeader")}
            label="Add row header"
          />
          <span className={styles.formLabel}>
            <T>Output file:</T>
          </span>
          <div className={styles.formRow}>
            <Input mono aria-label="Output file" value={file} onChange={(e) => setFile(e.target.value)} />
            <IconButton icon="folder" title="Browse…" onClick={() => void browse()} />
          </div>
        </div>
        <div className={styles.exportPreview}>
          <span className={styles.formLabel}>
            <T>Export preview:</T>
          </span>
          <CodePreview
            className={styles.exportPreviewText}
            aria-label="Export preview"
            sql={extractorOf(format).extension === "sql"}
            text={preview + (data.rows.length > PREVIEW_ROWS ? `\n… ${data.rows.length - PREVIEW_ROWS} more rows` : "")}
          />
        </div>
      </div>
    </Dialog>
  );
}
