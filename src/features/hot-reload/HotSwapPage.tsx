/**
 * Settings › Build, Execution, Deployment › Debugger › HotSwap: IDEA's "Reload classes after
 * compilation" and, while the Hot Reload plugin is on, its engine, JetBrains Runtimes
 * (downloaded here), framework plugins, watched directories and feedback options. Settings
 * are staged in the dialog and written on Apply / OK; downloads run right away.
 */
import { useEffect, useMemo } from "react";
import clsx from "clsx";
import type { HotReloadRuntime } from "@/bindings";
import { Button, Checkbox, Icon, Input, ProgressBar, T, tooltipAttrs } from "@/ui";
import { isTauri } from "@/platform/ipc";
import { useTx } from "@/platform/i18n";
import { useHotReloadPrefs, validateHotReload, type HotReloadPrefs } from "@/platform/hotReloadSettings";
import { useSettingsForm } from "@/workbench/contributions";
import { GlobListEditor, Row, Section, Select, Toggle } from "@/features/settings/components/Form";
import { RadioRow } from "@/features/settings/pages/workflowControls";
import { cancelInstall, installComponents, phaseTitle, refreshStatus, setEnabled, useHotReload } from "./store";
import styles from "./HotReload.module.css";

/** HotswapAgent plugins users turn off most (`disablePlugin` names). */
export const FRAMEWORK_PLUGINS: ReadonlyArray<{ name: string; label: string }> = [
  { name: "Spring", label: "Spring" },
  { name: "SpringBoot", label: "Spring Boot" },
  { name: "MyBatis", label: "MyBatis" },
  { name: "MyBatisPlus", label: "MyBatis-Plus" },
  { name: "Hibernate", label: "Hibernate" },
  { name: "Jackson", label: "Jackson" },
  { name: "Logback", label: "Logback" },
  { name: "Log4j2", label: "Log4j2" },
  { name: "Thymeleaf", label: "Thymeleaf" },
  { name: "FreeMarker", label: "FreeMarker" },
  { name: "Velocity", label: "Velocity" },
  { name: "Tomcat", label: "Tomcat" },
  { name: "Undertow", label: "Undertow" },
  { name: "Jetty", label: "Jetty" },
];

const LOG_LEVELS = [
  { value: "error", label: "Error" },
  { value: "warning", label: "Warning" },
  { value: "reload", label: "Reload" },
  { value: "info", label: "Info" },
  { value: "debug", label: "Debug" },
];

async function chooseFile(title: string, current: string): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: false, multiple: false, title, defaultPath: current || undefined });
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

/** A path field with Browse… (an own HotswapAgent jar, JRebel's agent). */
function PathRow({
  label,
  value,
  placeholder,
  invalid,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  invalid?: boolean;
  onChange: (value: string) => void;
}) {
  const tx = useTx();
  return (
    <Row label={label}>
      <div className={styles.pathField}>
        <Input
          mono
          value={value}
          placeholder={placeholder}
          invalid={invalid}
          aria-label={tx(label)}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
        <Button
          size="small"
          disabled={!isTauri()}
          onClick={() => void chooseFile(tx(label), value).then((p) => p && onChange(p))}
        >
          Browse…
        </Button>
      </div>
    </Row>
  );
}

function RuntimeRow({ runtime }: { runtime: HotReloadRuntime }) {
  const tx = useTx();
  const job = useHotReload((s) => s.job);
  const downloading = !!job && (job.major === runtime.major || job.phase === "prepare");
  const installed = !!runtime.home;
  return (
    <li className={styles.runtime} aria-label={tx`JetBrains Runtime ${runtime.major}`}>
      <Icon name="library" size={16} />
      <span className={styles.runtimeName}>
        <T>JetBrains Runtime</T> {runtime.major}
      </span>
      <span className={styles.runtimeVersion}>
        {runtime.version} {runtime.build}
      </span>
      {runtime.experimental && (
        <span
          className={styles.badge}
          {...tooltipAttrs(tx("Enhanced class redefinition on this runtime is new; crashes were reported."))}
        >
          <T>Experimental</T>
        </span>
      )}
      <span className={styles.runtimeEnd}>
        {downloading && job?.major === runtime.major ? (
          <span className={styles.runtimeJob}>
            <ProgressBar value={job.fraction ?? undefined} aria-label={phaseTitle(job)} />
            <span className={styles.muted}>{job.fraction != null ? `${Math.floor(job.fraction * 100)}%` : ""}</span>
            <Button size="small" onClick={cancelInstall}>
              Cancel
            </Button>
          </span>
        ) : installed ? (
          <span className={styles.installed} {...tooltipAttrs(runtime.home ?? "")}>
            <Icon name="success" size={14} />
            <T>Installed</T>
          </span>
        ) : (
          <Button size="small" disabled={!!job} onClick={() => void installComponents([runtime.major])}>
            Download
          </Button>
        )}
      </span>
    </li>
  );
}

function Runtimes() {
  const status = useHotReload((s) => s.status);
  const error = useHotReload((s) => s.installError);
  const job = useHotReload((s) => s.job);
  if (!status) return null;
  return (
    <Row label="JetBrains Runtimes" stacked>
      {status.platformSupported ? (
        <ul className={styles.runtimes}>
          {status.runtimes.map((r) => (
            <RuntimeRow key={r.major} runtime={r} />
          ))}
        </ul>
      ) : (
        <span className={styles.warning}>
          <T>JetBrains publishes no runtime for this system: only JRebel can hot-reload here.</T>
        </span>
      )}
      {job && job.major === null && job.phase !== "prepare" && <span className={styles.muted}>{phaseTitle(job)}</span>}
      {error && !job && <span className={styles.error}>{error}</span>}
    </Row>
  );
}

function Plugins({ prefs, set }: { prefs: HotReloadPrefs; set: (key: string, value: unknown) => void }) {
  const disabled = new Set(prefs.disabledPlugins);
  const toggle = (name: string, on: boolean) => {
    const next = new Set(disabled);
    if (on) next.delete(name);
    else next.add(name);
    set("hotReload.disabledPlugins", [...next]);
  };
  return (
    <div className={styles.plugins} role="group">
      {FRAMEWORK_PLUGINS.map((p) => (
        <Checkbox key={p.name} checked={!disabled.has(p.name)} onChange={(on) => toggle(p.name, on)} label={p.label} />
      ))}
    </div>
  );
}

function HotReloadGroup() {
  const tx = useTx();
  const form = useSettingsForm();
  const raw = form.useValue("hotReload");
  const prefs = useMemo(() => validateHotReload(raw), [raw]);
  // Turning the plugin on applies at once (with its download), not on Apply.
  const enabled = useHotReloadPrefs().enabled;
  const status = useHotReload((s) => s.status);
  const job = useHotReload((s) => s.job);
  const set = (key: string, value: unknown) => form.set(key, value);
  useEffect(() => void refreshStatus(), []);

  if (!enabled)
    return (
      <Section title="Hot Reload">
        <div className={styles.disabled}>
          <Icon name="hot-reload" size={16} className={styles.bolt} />
          <span className={styles.disabledText}>
            <T>Hot Reload is off</T>
            <Info text="Reload code, Spring beans and configuration into running applications without restarting them." />
          </span>
          <Button size="small" variant="primary" disabled={!!job} onClick={() => void setEnabled(true)}>
            {job ? tx("Downloading…") : tx("Enable Hot Reload")}
          </Button>
        </div>
      </Section>
    );

  const agent = status?.agent;
  const jrebel = prefs.engine === "jrebel";
  return (
    <>
      <Section title="Hot Reload">
        <Row label="Engine">
          <div className={styles.inline}>
            <Select
              value={prefs.engine}
              options={[
                { value: "hotswapAgent", label: "HotswapAgent" },
                { value: "jrebel", label: "JRebel" },
              ]}
              onChange={(v) => set("hotReload.engine", v)}
              aria-label={tx("Engine")}
            />
            <Info
              text={
                jrebel
                  ? "Your JRebel agent on the project's JDK. JRebel needs its own license."
                  : "HotswapAgent on a JetBrains Runtime: method bodies, new fields and methods, new classes and superclasses, Spring beans and configuration."
              }
            />
          </div>
        </Row>
        {jrebel ? (
          <PathRow
            label="JRebel agent"
            value={prefs.jrebelAgentPath}
            placeholder="libjrebel64.dylib, libjrebel64.so, jrebel64.dll or jrebel.jar"
            invalid={!!prefs.jrebelAgentPath && status?.jrebel?.valid === false}
            onChange={(v) => set("hotReload.jrebelAgentPath", v)}
          />
        ) : (
          <PathRow
            label="Agent JAR"
            value={prefs.agentPath}
            placeholder={
              agent && !agent.custom ? tx`HotswapAgent ${agent.version} (downloaded)` : tx("Downloaded on first use")
            }
            onChange={(v) => set("hotReload.agentPath", v)}
          />
        )}
        {!jrebel && <Runtimes />}
        <Row label="Log level">
          <Select
            value={prefs.logLevel}
            options={LOG_LEVELS}
            onChange={(v) => set("hotReload.logLevel", v)}
            aria-label={tx("Log level")}
          />
        </Row>
        <Toggle
          label="Use hot reload for Spring Boot by default"
          checked={prefs.springBootDefault}
          onChange={(on) => set("hotReload.springBootDefault", on)}
        />
        <Toggle
          label="Turn off Spring Boot DevTools restart"
          checked={prefs.disableDevtoolsRestart}
          onChange={(on) => set("hotReload.disableDevtoolsRestart", on)}
        />
        <Toggle
          label="Show reload results in the editor"
          checked={prefs.editorFeedback}
          onChange={(on) => set("hotReload.editorFeedback", on)}
        />
      </Section>
      {!jrebel && (
        <Section title="Framework Plugins">
          <Plugins prefs={prefs} set={set} />
        </Section>
      )}
      {!jrebel && (
        <Section title="Watched Directories">
          <Row label="Extra class directories" stacked>
            <GlobListEditor
              value={prefs.extraClasspath}
              onChange={(v) => set("hotReload.extraClasspath", v)}
              placeholder="/path/to/other-module/target/classes"
              emptyText="None"
              itemLabel="Directory"
              aria-label={tx("Extra class directories")}
            />
          </Row>
          <Row label="Extra resource directories" stacked>
            <GlobListEditor
              value={prefs.watchResources}
              onChange={(v) => set("hotReload.watchResources", v)}
              placeholder="/path/to/resources"
              emptyText="None"
              itemLabel="Directory"
              aria-label={tx("Extra resource directories")}
            />
          </Row>
        </Section>
      )}
    </>
  );
}

export function HotSwapPage() {
  return (
    <div className={clsx(styles.page)}>
      <Section>
        <RadioRow
          k="debugger.reloadClasses"
          label="Reload classes after compilation"
          choices={[
            { value: "always", label: "Always" },
            { value: "ask", label: "Ask" },
            { value: "never", label: "Never" },
          ]}
        />
      </Section>
      <HotReloadGroup />
    </div>
  );
}
