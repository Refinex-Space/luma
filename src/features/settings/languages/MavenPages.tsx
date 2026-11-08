/**
 * Build, Execution, Deployment › Build Tools (auto-sync) and its Maven pages, laid out
 * as IDEA's `MavenGeneralUi` / `MavenEnvironmentForm`, `MavenImportingSettingsUi`,
 * `MavenIgnoredFilesUi` and `MavenRunnerUi`. Every option is applied by the backend
 * (`ide-sdk::apply::maven_*`, `ide-build`) to syncs, goals run from the IDE and Build Project.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { call, commands, isTauri, type MavenEnvironment, type MavenProperty } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { Checkbox, Icon, IconButton, Input, type SelectOption, T, tooltipAttrs } from "@/ui";
import { EnvDialog } from "@/features/run/EnvDialog";
import { Row, Section, Select, Toggle } from "../components/Form";
import { useSetting } from "../components/context";
import { Indented, TableEditor } from "../pages/workflowControls";
import { choosePath } from "./api";
import { SdkField, tildify } from "./components";
import styles from "./Sdk.module.css";
import mavenStyles from "./MavenPages.module.css";

const M = "languages.java.maven";

/** An info icon with the option's explanation as tooltip (IDEA's checkbox tooltips / context help). */
function Info({ text }: { text: string }) {
  return (
    <span className={mavenStyles.info} {...tooltipAttrs(tx(text))} aria-label={tx(text)} role="img">
      <Icon name="info" size={14} />
    </span>
  );
}

function BoolOption({ k, label, info, invert }: { k: string; label: string; info?: string; invert?: boolean }) {
  const [value, set] = useSetting<boolean>(k);
  return (
    <div className={mavenStyles.inline}>
      <Toggle label={label} checked={invert ? !value : !!value} onChange={(v) => set(invert ? !v : v)} />
      {info && <Info text={info} />}
    </div>
  );
}

function ChoiceOption<V extends string>({
  k,
  label,
  options,
  info,
}: {
  k: string;
  label: string;
  options: readonly SelectOption<V>[];
  info?: string;
}) {
  const [value, set] = useSetting<V>(k);
  return (
    <Row label={label}>
      <span className={mavenStyles.inline}>
        <Select<V> value={value} options={options} onChange={set} aria-label={label} />
        {info && <Info text={info} />}
      </span>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Build Tools

/** IDEA's `ExternalSystemGroupConfigurable`: "Sync project after changes in the build scripts". */
export function BuildToolsPage() {
  const [mode, setMode] = useSetting<"all" | "selective" | "none">("buildTools.autoReload");
  const [previous, setPrevious] = useState<"all" | "selective">(mode === "all" ? "all" : "selective");
  const enabled = mode !== "none";
  const radio = (value: "all" | "selective", label: string, comment?: string) => (
    <label className={mavenStyles.radio}>
      <input
        type="radio"
        name="auto-reload"
        checked={enabled ? mode === value : previous === value}
        disabled={!enabled}
        onChange={() => {
          setPrevious(value);
          setMode(value);
        }}
      />
      <span>
        <T>{label}</T>
        {comment && (
          <span className={mavenStyles.comment}>
            <T>{comment}</T>
          </span>
        )}
      </span>
    </label>
  );
  return (
    <div className={styles.page}>
      <Section>
        <Toggle
          label="Sync project after changes in the build scripts:"
          checked={enabled}
          onChange={(on) => setMode(on ? previous : "none")}
        />
        <Indented>
          <div
            className={mavenStyles.radios}
            role="radiogroup"
            aria-label={tx("Sync project after changes in the build scripts:")}
          >
            {radio("all", "Any changes")}
            {radio("selective", "External changes", "Changes outside the IDE or from version control.")}
          </div>
        </Indented>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Maven (general)

/** The installation and defaults the backend reports for the current Maven home / settings file. */
function useMavenEnvironment(home: string, userSettings: string): MavenEnvironment | null {
  const [env, setEnv] = useState<MavenEnvironment | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    // Debounced like IDEA's 100 ms recomputation of the defaults.
    const t = setTimeout(() => {
      call(commands.mavenEnvironment(home, userSettings))
        .then((e) => live && setEnv(e))
        .catch(() => live && setEnv(null));
    }, 100);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [home, userSettings]);
  return env;
}

/** "User settings file" / "Local repository" with IDEA's Override checkbox: unchecked shows the default, disabled. */
function OverrideRow({
  label,
  k,
  fallback,
  title,
  file,
}: {
  label: string;
  k: string;
  fallback: string;
  title: string;
  file?: boolean;
}) {
  const [value, set] = useSetting<string>(k);
  const [draft, setDraft] = useState(value);
  const overridden = !!value?.trim();
  const id = useId();
  const [checked, setChecked] = useState(overridden);
  // A value set elsewhere (another scope, Reset) checks the box again.
  const [seen, setSeen] = useState(overridden);
  if (seen !== overridden) {
    setSeen(overridden);
    setChecked(overridden);
  }
  return (
    <Row label={label} htmlFor={id}>
      <span className={styles.pathRow}>
        <Input
          id={id}
          mono
          className={styles.pathInput}
          disabled={!checked}
          value={checked ? value : tildify(fallback)}
          onChange={(e) => {
            setDraft(e.target.value);
            set(e.target.value);
          }}
        />
        <IconButton
          icon="folder-open"
          size="small"
          title="Browse…"
          disabled={!checked}
          onClick={async () => {
            const p = await choosePath({ directory: !file, title, defaultPath: value || fallback || undefined });
            if (p) {
              setDraft(p);
              set(p);
            }
          }}
        />
        <Checkbox
          label={tx("Override")}
          checked={checked}
          onChange={(on) => {
            setChecked(on);
            // Unchecked stores nothing (Maven's default applies); checked restores the last text.
            set(on ? draft || fallback : "");
          }}
        />
      </span>
    </Row>
  );
}

function MavenHomeRow({ env }: { env: MavenEnvironment | null }) {
  const [home, setHome] = useSetting<string>(`${M}.home`);
  const version = env?.version ? tx`(Version: ${env.version})` : null;
  const status = version ?? (!home ? (env?.wrapper ? tx("Use Maven wrapper") : null) : tildify(home));
  return (
    <Row label="Maven home path">
      <div className={mavenStyles.stack}>
        <SdkField
          kind="maven"
          value={home}
          onChange={setHome}
          emptyLabel={env?.wrapper || !isTauri() ? "Use Maven wrapper" : "Maven on PATH"}
          emptyDetail={
            env?.wrapper ? ".mvn/wrapper/maven-wrapper.properties" : env?.home ? tildify(env.home) : undefined
          }
          directory
          browseTitle="Select Maven Home Directory"
          aria-label="Maven home path"
        />
        {status && <span className={mavenStyles.version}>{status}</span>}
      </div>
    </Row>
  );
}

const OUTPUT_LEVELS: SelectOption<string>[] = [
  { value: "debug", label: "Debug" },
  { value: "info", label: "Info" },
  { value: "warn", label: "Warn" },
  { value: "error", label: "Error" },
  { value: "fatal", label: "Fatal" },
  { value: "disabled", label: "Disabled" },
];

const CHECKSUM: SelectOption<string>[] = [
  { value: "noGlobalPolicy", label: "No Global Policy" },
  { value: "fail", label: "Fail" },
  { value: "warn", label: "Warn" },
];

const FAILURE: SelectOption<string>[] = [
  { value: "default", label: "Default" },
  { value: "failFast", label: "Fail Fast" },
  { value: "failAtEnd", label: "Fail At End" },
  { value: "failNever", label: "Fail Never" },
];

function ThreadsRow() {
  const [threads, set] = useSetting<string>(`${M}.threads`);
  const id = useId();
  return (
    <Row label="Thread count" htmlFor={id}>
      <span className={mavenStyles.inline}>
        <Input
          id={id}
          className={mavenStyles.short}
          value={threads ?? ""}
          onChange={(e) => set(e.target.value.trim())}
          {...tooltipAttrs(tx("Thread count, for instance 2.0C where C is core multiplied (option -T)"))}
        />
        <span className={mavenStyles.comment}>
          <T>-T option</T>
        </span>
      </span>
    </Row>
  );
}

function MavenConfigRow({ env }: { env: MavenEnvironment | null }) {
  const [use] = useSetting<boolean>(`${M}.useMavenConfig`);
  return (
    <>
      <BoolOption
        k={`${M}.useMavenConfig`}
        label="Use settings from .mvn/maven.config"
        info="Settings from maven.config file override the IDE Maven UI settings. If this option is enabled, use maven.config to change the settings."
      />
      {use && env?.mavenConfig && (
        <div className={mavenStyles.warning} role="note">
          <Icon name="warning" size={14} />
          <T>This project has .mvn/maven.config: Maven takes its options from there instead of the ones above.</T>
        </div>
      )}
    </>
  );
}

export function MavenPage() {
  const [home] = useSetting<string>(`${M}.home`);
  const [userSettings] = useSetting<string>(`${M}.userSettings`);
  const env = useMavenEnvironment(home ?? "", userSettings ?? "");
  return (
    <div className={styles.page}>
      <Section>
        <BoolOption
          k={`${M}.workOffline`}
          label="Work offline"
          info="Add option --offline to command line when run maven goals"
        />
        <BoolOption
          k={`${M}.nonRecursive`}
          invert
          label="Execute goals recursively"
          info="Add option --non-recursive if this option is not selected"
        />
        <BoolOption
          k={`${M}.printStackTraces`}
          label="Print exception stack traces"
          info="Add option --errors to command line when run maven goals"
        />
        <BoolOption
          k={`${M}.updateSnapshots`}
          label="Always update snapshots"
          info="Forces a check for updated releases and snapshots on remote repositories"
        />
        <ChoiceOption k={`${M}.outputLevel`} label="Output level" options={OUTPUT_LEVELS} />
        <ChoiceOption k={`${M}.checksumPolicy`} label="Checksum policy" options={CHECKSUM} />
        <ChoiceOption k={`${M}.failureBehavior`} label="Multiproject build fail policy" options={FAILURE} />
        <ThreadsRow />
      </Section>
      <Section>
        <MavenHomeRow env={env} />
        <OverrideRow
          label="User settings file"
          k={`${M}.userSettings`}
          fallback={env?.defaultUserSettings ?? "~/.m2/settings.xml"}
          title="Select User Settings File"
          file
        />
        <OverrideRow
          label="Local repository"
          k={`${M}.localRepository`}
          fallback={env?.defaultLocalRepository ?? "~/.m2/repository"}
          title="Select Local Repository"
        />
      </Section>
      <Section>
        <MavenConfigRow env={env} />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Importing

const GENERATED: SelectOption<string>[] = [
  { value: "ignore", label: "Don't detect" },
  { value: "autodetect", label: "Detect automatically" },
  { value: "generatedSourceFolder", label: "target/generated-sources" },
  { value: "subfoldersOfGeneratedSourceFolder", label: 'subdirectories of "target/generated-sources"' },
];

const UPDATE_PHASES: SelectOption<string>[] = [
  "generate-sources",
  "process-sources",
  "generate-resources",
  "process-resources",
  "generate-test-sources",
  "process-test-sources",
  "generate-test-resources",
  "process-test-resources",
].map((p) => ({ value: p, label: p }));

function TextOption({
  k,
  label,
  info,
  placeholder,
}: {
  k: string;
  label: string;
  info?: string;
  placeholder?: string;
}) {
  const [value, set] = useSetting<string>(k);
  const id = useId();
  return (
    <Row label={label} htmlFor={id}>
      <span className={mavenStyles.inline}>
        <Input
          id={id}
          mono
          className={mavenStyles.wide}
          value={value ?? ""}
          placeholder={placeholder}
          onChange={(e) => set(e.target.value)}
        />
        {info && <Info text={info} />}
      </span>
    </Row>
  );
}

function JdkOption({ k, label, info }: { k: string; label: string; info?: string }) {
  const [value, set] = useSetting<string>(k);
  return (
    <Row label={label}>
      <span className={mavenStyles.inline}>
        <SdkField
          kind="jdk"
          value={value}
          onChange={set}
          emptyLabel="Use Project JDK"
          extra={[{ value: "JAVA_HOME", label: "Use JAVA_HOME" }]}
          directory
          browseTitle="Select JDK Home Directory"
          aria-label={label}
        />
        {info && <Info text={info} />}
      </span>
    </Row>
  );
}

function DownloadRow() {
  const [sources, setSources] = useSetting<boolean>(`${M}.importing.downloadSources`);
  const [docs, setDocs] = useSetting<boolean>(`${M}.importing.downloadDocs`);
  return (
    <Row label="Automatically download">
      <span className={mavenStyles.checks}>
        <Checkbox label={tx("Sources")} checked={!!sources} onChange={setSources} />
        <Checkbox label={tx("Documentation")} checked={!!docs} onChange={setDocs} />
      </span>
    </Row>
  );
}

export function MavenImportingPage() {
  return (
    <div className={styles.page}>
      <Section>
        <BoolOption
          k={`${M}.importing.excludeTargetFolder`}
          label="Exclude build directory (%PROJECT_ROOT%/target)"
          info="If you select this options folder /target will be excluded from project during reimport. Compiler output (/target/classes and /target/test-classes) will be excluded anyway"
        />
        <ChoiceOption
          k={`${M}.importing.generatedSourcesFolder`}
          label="Generated sources folders"
          options={GENERATED}
        />
        <ChoiceOption
          k={`${M}.importing.updateFoldersPhase`}
          label="Phase to be used for folders update"
          options={UPDATE_PHASES}
          info="Generate Sources and Update Folders runs this phase to discover the source folders configured via Maven plugins. All test-* phases first generate and compile production sources."
        />
        <DownloadRow />
      </Section>
      <Section>
        <TextOption
          k={`${M}.importing.vmOptions`}
          label="VM options for importer"
          info="Options specified in this field override the ones in .mvn/jvm.config files"
        />
        <JdkOption
          k={`${M}.importing.jdk`}
          label="JDK for importer"
          info="The JDK the sync runs Maven on. This does not affect project SDK configuration."
        />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ignored Files

function useMavenPoms(): string[] | null {
  const [poms, setPoms] = useState<string[] | null>(isTauri() ? null : []);
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    call(commands.buildModel())
      .then((m) => live && setPoms([...new Set((m.maven?.projects ?? []).map((p) => p.pom))].sort()))
      .catch(() => live && setPoms([]));
    return () => {
      live = false;
    };
  }, []);
  return poms;
}

export function MavenIgnoredFilesPage() {
  const [patterns, setPatterns] = useSetting<string[]>(`${M}.ignoredPatterns`);
  const [files, setFiles] = useSetting<string[]>(`${M}.ignoredFiles`);
  const poms = useMavenPoms();
  const [text, setText] = useState(() => (patterns ?? []).join(", "));
  const id = useId();
  const all = useMemo(() => [...new Set([...(poms ?? []), ...(files ?? [])])].sort(), [poms, files]);
  return (
    <div className={styles.page}>
      <Section>
        <Row label="Path patterns (comma-separated, '*' and '?' wildcards allowed)" htmlFor={id} stacked>
          <textarea
            id={id}
            rows={2}
            className={mavenStyles.textarea}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setPatterns(e.target.value.split(/[\s,]+/).filter(Boolean));
            }}
          />
        </Row>
        <Row label="Ignored files" stacked>
          <div className={mavenStyles.list} role="list" aria-label={tx("Ignored files")}>
            {poms === null ? null : all.length === 0 ? (
              <div className={mavenStyles.listEmpty}>
                <T>No Maven files</T>
              </div>
            ) : (
              all.map((pom) => (
                <div key={pom} role="listitem" className={mavenStyles.listItem}>
                  <Checkbox
                    label={<span>{pom}</span>}
                    checked={(files ?? []).includes(pom)}
                    onChange={(on) =>
                      setFiles(on ? [...new Set([...(files ?? []), pom])] : (files ?? []).filter((f) => f !== pom))
                    }
                  />
                </div>
              ))
            )}
          </div>
        </Row>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Runner

function EnvRow() {
  const [env, setEnv] = useSetting<Record<string, string>>(`${M}.runner.env`);
  const [passParent, setPassParent] = useSetting<boolean>(`${M}.runner.passParentEnv`);
  const [open, setOpen] = useState(false);
  const summary = Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(";");
  const id = useId();
  return (
    <Row label="Environment variables" htmlFor={id}>
      <span className={styles.pathRow}>
        <Input
          id={id}
          mono
          readOnly
          className={styles.pathInput}
          value={summary}
          placeholder={tx("Environment variables")}
          onClick={() => setOpen(true)}
        />
        <IconButton icon="folder-open" size="small" title="Edit Environment Variables" onClick={() => setOpen(true)} />
      </span>
      {open && (
        <EnvDialog
          env={env ?? {}}
          includeSystemEnv={passParent ?? true}
          onOk={(next, include) => {
            setEnv(next);
            setPassParent(include);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </Row>
  );
}

function PropertiesTable() {
  const [props, setProps] = useSetting<MavenProperty[]>(`${M}.runner.properties`);
  return (
    <TableEditor
      rows={(props ?? []).map((p) => ({ name: p.name ?? "", value: p.value ?? "" }))}
      columns={[
        { key: "name", title: tx("Name"), mono: true },
        { key: "value", title: tx("Value"), mono: true },
      ]}
      onChange={(rows) => setProps(rows.map((r) => ({ name: r.name ?? "", value: r.value ?? "" })))}
      empty={tx("No properties defined")}
      aria-label={tx("Properties")}
    />
  );
}

export function MavenRunnerPage() {
  return (
    <div className={styles.page}>
      <Section>
        <div className={mavenStyles.inline}>
          {/* Luma has no other builder for Maven projects: Build Project always runs Maven. */}
          <Toggle label="Delegate IDE build/run actions to Maven" checked disabled onChange={() => {}} />
          <Info text="Build Project and the builds before a run always use Maven in Maven projects" />
        </div>
        <TextOption
          k={`${M}.runner.vmOptions`}
          label="VM Options"
          info="Options specified in this field override the ones in .mvn/jvm.config files"
        />
        <JdkOption k={`${M}.runner.jre`} label="JRE" />
        <EnvRow />
      </Section>
      <Section title="Properties">
        <BoolOption k={`${M}.runner.skipTests`} label="Skip Tests" />
        <div className={mavenStyles.table}>
          <PropertiesTable />
        </div>
      </Section>
    </div>
  );
}
