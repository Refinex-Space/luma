/**
 * Settings › Languages & Frameworks › Lombok: the switch, which Lombok jar the Java
 * language server and Delombok use (bundled or the user's), what this project uses, its
 * lombok.config files and the inspections. Settings are staged and written on Apply / OK.
 */
import { useEffect, useId, useMemo } from "react";
import { Button, Icon, Input, T, tooltipAttrs } from "@/ui";
import { executeAction } from "@/platform/actions";
import { call, commands, isTauri } from "@/platform/ipc";
import { useTx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { validateLombok } from "@/platform/lombokSettings";
import { editorService, notifications, useSettingsForm } from "@/workbench/contributions";
import { Row, Section, Toggle } from "@/features/settings/components/Form";
import { refreshStatus, useLombok } from "./store";
import styles from "./Lombok.module.css";

/** What a new root lombok.config says: IDEA's and Lombok's recommended start. */
export const NEW_CONFIG = "config.stopBubbling = true\nlombok.addLombokGeneratedAnnotation = true\n";

const SOURCES: Record<string, string> = {
  bundled: "Bundled with Luma",
  custom: "Chosen below",
  vmArgs: "From the Java language server's VM options",
  cache: "From the Maven / Gradle cache",
};

async function chooseJar(title: string, current: string): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    directory: false,
    multiple: false,
    title,
    defaultPath: current || undefined,
    filters: [{ name: "JAR", extensions: ["jar"] }],
  });
  return (Array.isArray(picked) ? picked[0] : picked) ?? null;
}

function Info({ text }: { text: string }) {
  const tx = useTx();
  return (
    <span className={styles.info} {...tooltipAttrs(tx(text))} aria-label={tx(text)} role="img">
      <Icon name="info" size={14} />
    </span>
  );
}

const shortVersion = (v: string | null | undefined) => (v ?? "").replace(/-luma\.\d+$/, "");

function JarRow({ value, set }: { value: string; set: (v: string) => void }) {
  const tx = useTx();
  const name = useId();
  const status = useLombok((s) => s.status);
  const custom = value !== "";
  return (
    <Row label="Lombok jar" stacked>
      <div className={styles.choices} role="radiogroup" aria-label={tx("Lombok jar")}>
        <label className={styles.choice}>
          <input type="radio" name={name} checked={!custom} onChange={() => set("")} />
          <span>
            <T>Bundled</T>
            {status?.bundledVersion && <span className={styles.muted}> {shortVersion(status.bundledVersion)}</span>}
          </span>
          <Info text="Lombok 1.18.48 with the fixes the Java language server needs (lombok.config lookup, constructors with @SneakyThrows / @NonNull). Your build keeps its own Lombok version." />
        </label>
        <label className={styles.choice}>
          <input
            type="radio"
            name={name}
            checked={custom}
            onChange={() => void chooseJar(tx("Lombok jar"), "").then((p) => p && set(p))}
          />
          <T>Custom:</T>
          <span className={styles.pathField}>
            <Input
              mono
              value={value}
              placeholder="lombok.jar"
              aria-label={tx("Custom Lombok jar")}
              onChange={(e) => set(e.currentTarget.value)}
            />
            <Button
              size="small"
              disabled={!isTauri()}
              onClick={() => void chooseJar(tx("Lombok jar"), value).then((p) => p && set(p))}
            >
              Browse…
            </Button>
          </span>
        </label>
      </div>
    </Row>
  );
}

function ProjectState() {
  const tx = useTx();
  const status = useLombok((s) => s.status);
  if (!status) return null;
  const agent = status.agent;
  return (
    <>
      <Row label="Java language server">
        <div className={styles.inline}>
          {agent ? (
            <>
              <Icon name="success" size={14} className={styles.ok} />
              <span>
                {agent.version ? `Lombok ${shortVersion(agent.version)}` : agent.path.split(/[\\/]/).pop()}
                <span className={styles.muted}> · {tx(SOURCES[agent.source] ?? agent.source)}</span>
              </span>
              <Info text={agent.path} />
            </>
          ) : (
            <span className={styles.muted}>
              <T>Runs without Lombok</T>
            </span>
          )}
        </div>
      </Row>
      {status.problem && (
        <div className={styles.problem} role="status">
          <Icon name="warning" size={14} />
          <span>{status.problem}</span>
        </div>
      )}
      <Row label="This project">
        <span className={status.usesLombok ? undefined : styles.muted}>
          {status.usesLombok ? tx("Uses Lombok") : tx("Doesn't use Lombok")}
        </span>
      </Row>
    </>
  );
}

function ConfigFiles() {
  const tx = useTx();
  const status = useLombok((s) => s.status);
  const root = useProject((s) => s.project?.root ?? null);
  if (!status || !root) return null;
  const open = (rel: string) => void editorService().openFile(`${root}/${rel}`, { focus: true });
  const create = async () => {
    const path = `${root}/lombok.config`;
    try {
      await call(commands.fsCreateFileBytes(path, [...new TextEncoder().encode(NEW_CONFIG)]));
      await refreshStatus();
      await editorService().openFile(path, { focus: true });
    } catch (e) {
      notifications().notify({
        level: "error",
        title: tx("Cannot create lombok.config"),
        body: e instanceof Error ? e.message : String(e),
      });
    }
  };
  return (
    <Row label="lombok.config" stacked>
      {status.configFiles.length ? (
        <ul className={styles.files} aria-label={tx("lombok.config files")}>
          {status.configFiles.map((f) => (
            <li key={f}>
              <button type="button" className={styles.file} onClick={() => open(f)}>
                <Icon name="settings" size={14} />
                {f}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {!status.configFiles.includes("lombok.config") && (
        <div>
          <Button size="small" disabled={!isTauri()} onClick={() => void create()}>
            Create lombok.config
          </Button>
        </div>
      )}
    </Row>
  );
}

export function LombokSettingsPage() {
  const form = useSettingsForm();
  const raw = form.useValue("lombok");
  const prefs = useMemo(() => validateLombok(raw), [raw]);
  useEffect(() => void refreshStatus(), []);
  return (
    <div className={styles.page}>
      <Section title="Lombok">
        <Toggle
          label="Enable Lombok support"
          checked={prefs.enabled}
          onChange={(on) => form.set("lombok.enabled", on)}
        />
        {prefs.enabled && <JarRow value={prefs.agentPath} set={(v) => form.set("lombok.agentPath", v)} />}
      </Section>
      {prefs.enabled && (
        <Section title="Project">
          <ProjectState />
          <ConfigFiles />
          <Row label="Inspections">
            <Button size="small" onClick={() => void executeAction("file.settings", "editor.inspections")}>
              Configure Inspections…
            </Button>
          </Row>
        </Section>
      )}
    </div>
  );
}
