/**
 * Settings › Tools › Web Browsers and Preview (IDEA's `BrowserSettingsConfigurable` and
 * `BuiltInServerConfigurableUi`): the browser list, the default browser, the editor's browser
 * popup, reload behavior and the built-in server. Edits are staged and written on Apply / OK.
 */
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Button, Checkbox, Dialog, Icon, IconButton, Input, T, tooltipAttrs, type SelectOption } from "@/ui";
import { useTx } from "@/platform/i18n";
import { call, commands, isTauri } from "@/platform/ipc";
import {
  BROWSER_FAMILIES,
  DEFAULT_SERVER_PORT,
  EMPTY_BROWSER_SETTINGS,
  FAMILY_NAMES,
  MAX_SERVER_PORT,
  MIN_SERVER_PORT,
  PREDEFINED_IDS,
  RELOAD_MODES,
  familyPath,
  validateBuiltInServer,
  validateWebBrowsers,
  type BrowserFamily,
  type BrowserSpecificSettings,
  type ConfiguredBrowser,
  type ReloadMode,
} from "@/platform/webBrowserSettings";
import { useSettingsForm } from "@/workbench/contributions";
import { NumberInput, Row, Section, Select, Toggle } from "@/features/settings/components/Form";
import { browserIcon } from "./browsers";
import styles from "./WebSettings.module.css";

const RELOAD_LABELS: Record<ReloadMode, string> = { disabled: "Disabled", onSave: "On Save", onChange: "On Change" };
const RELOAD_OPTIONS: SelectOption<ReloadMode>[] = RELOAD_MODES.map((m) => ({ value: m, label: RELOAD_LABELS[m] }));
const NO_FAMILY = "none";
type FamilyChoice = BrowserFamily | typeof NO_FAMILY;
const FAMILY_OPTIONS: SelectOption<FamilyChoice>[] = [
  { value: NO_FAMILY, label: "Not specified" },
  ...BROWSER_FAMILIES.map((f) => ({ value: f, label: FAMILY_NAMES[f], icon: `browser-${f}` })),
];
const SYSTEM_DEFAULT = "";
const isPredefined = (b: ConfiguredBrowser) => PREDEFINED_IDS.includes(b.id);
const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

async function choosePath(title: string, current: string, directory = false): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory, multiple: false, title, defaultPath: current || undefined });
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

// ---------------------------------------------------------------------------
// The browser list

function BrowserTable({
  browsers,
  onChange,
}: {
  browsers: ConfiguredBrowser[];
  onChange: (browsers: ConfiguredBrowser[]) => void;
}) {
  const tx = useTx();
  const [selected, setSelected] = useState<string | null>(browsers[0]?.id ?? null);
  const [editing, setEditing] = useState<ConfiguredBrowser | null>(null);
  const index = browsers.findIndex((b) => b.id === selected);
  const current = index >= 0 ? browsers[index]! : null;

  const update = (id: string, patch: Partial<ConfiguredBrowser>) =>
    onChange(browsers.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const insert = (b: ConfiguredBrowser) => {
    onChange([...browsers, b]);
    setSelected(b.id);
  };
  const add = () =>
    insert({
      id: newId(),
      name: tx("New Browser"),
      family: null,
      path: "",
      active: true,
      settings: { ...EMPTY_BROWSER_SETTINGS },
    });
  const copy = () =>
    current && insert({ ...current, id: newId(), name: tx`${current.name} (copy)`, settings: { ...current.settings } });
  const remove = () => {
    if (!current || isPredefined(current)) return;
    const rest = browsers.filter((b) => b.id !== current.id);
    onChange(rest);
    setSelected(rest[Math.min(index, rest.length - 1)]?.id ?? null);
  };
  const move = (d: -1 | 1) => {
    const j = index + d;
    if (index < 0 || j < 0 || j >= browsers.length) return;
    const next = [...browsers];
    [next[index], next[j]] = [next[j]!, next[index]!];
    onChange(next);
  };
  const editable = !!current?.family && current.family !== "safari";

  return (
    <div className={styles.tableBox}>
      <div className={styles.toolbar} role="toolbar" aria-label={tx("Browser list actions")}>
        <IconButton icon="plus" title="Add" size="small" onClick={add} />
        <IconButton
          icon="minus"
          title={current && isPredefined(current) ? "A predefined browser can be turned off, not removed" : "Remove"}
          size="small"
          disabled={!current || isPredefined(current)}
          onClick={remove}
        />
        <IconButton
          icon="edit"
          title="Edit Browser Settings"
          size="small"
          disabled={!editable}
          onClick={() => current && setEditing(current)}
        />
        <IconButton icon="arrow-up" title="Move Up" size="small" disabled={index <= 0} onClick={() => move(-1)} />
        <IconButton
          icon="arrow-down"
          title="Move Down"
          size="small"
          disabled={index < 0 || index >= browsers.length - 1}
          onClick={() => move(1)}
        />
        <IconButton icon="copy" title="Copy" size="small" disabled={!current} onClick={copy} />
      </div>
      <div className={styles.scroll}>
        <table className={styles.table} aria-label={tx("Browsers")}>
          <colgroup>
            <col className={styles.colActive} />
            <col className={styles.colName} />
            <col className={styles.colFamily} />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th aria-label={tx("Active")} />
              <th>
                <T>Name</T>
              </th>
              <th>
                <T>Family</T>
              </th>
              <th>
                <T>Path</T>
              </th>
            </tr>
          </thead>
          <tbody>
            {browsers.length === 0 && (
              <tr>
                <td colSpan={4} className={styles.empty}>
                  <T>No web browsers configured</T>
                </td>
              </tr>
            )}
            {browsers.map((b) => (
              <tr
                key={b.id}
                aria-selected={b.id === selected}
                className={clsx(b.id === selected && styles.selectedRow)}
                onMouseDown={() => setSelected(b.id)}
                onFocusCapture={() => setSelected(b.id)}
                onDoubleClick={(e) => {
                  if (b.family && b.family !== "safari" && !(e.target as HTMLElement).closest("input,button"))
                    setEditing(b);
                }}
              >
                <td>
                  <Checkbox
                    aria-label={tx`Show ${b.name} in the browser lists`}
                    checked={b.active}
                    onChange={(active) => update(b.id, { active })}
                  />
                </td>
                <td>
                  <Input
                    variant="bare"
                    className={styles.cellInput}
                    value={b.name}
                    aria-label={tx("Name")}
                    onChange={(e) => update(b.id, { name: e.target.value })}
                  />
                </td>
                <td>
                  {isPredefined(b) ? (
                    <span className={styles.family}>
                      {b.family && <Icon name={browserIcon({ family: b.family, name: "" })} size={16} />}
                      {b.family ? FAMILY_NAMES[b.family] : <T>Not specified</T>}
                    </span>
                  ) : (
                    <Select<FamilyChoice>
                      className={styles.cellSelect}
                      value={b.family ?? NO_FAMILY}
                      options={FAMILY_OPTIONS}
                      aria-label={tx("Family")}
                      onChange={(v) => {
                        const family = v === NO_FAMILY ? null : v;
                        update(b.id, {
                          family,
                          settings: { ...EMPTY_BROWSER_SETTINGS },
                          // A new family's usual path, unless one was entered.
                          path: b.path || (family ? familyPath(family) : ""),
                        });
                      }}
                    />
                  )}
                </td>
                <td>
                  <span className={styles.pathCell}>
                    <Input
                      variant="bare"
                      className={styles.cellInput}
                      value={b.path}
                      placeholder={tx("Executable or application")}
                      aria-label={tx`Path of ${b.name}`}
                      onChange={(e) => update(b.id, { path: e.target.value })}
                    />
                    <IconButton
                      icon="folder"
                      title="Browse…"
                      size="small"
                      disabled={!isTauri()}
                      onClick={() =>
                        void choosePath(tx("Select Browser"), b.path).then((p) => p && update(b.id, { path: p }))
                      }
                    />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <BrowserSettingsDialog
          browser={editing}
          onClose={() => setEditing(null)}
          onApply={(settings) => {
            update(editing.id, { settings });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chrome / Firefox settings

function BrowserSettingsDialog({
  browser,
  onClose,
  onApply,
}: {
  browser: ConfiguredBrowser;
  onClose: () => void;
  onApply: (settings: BrowserSpecificSettings) => void;
}) {
  const tx = useTx();
  const [s, setS] = useState<BrowserSpecificSettings>(browser.settings);
  const patch = (p: Partial<BrowserSpecificSettings>) => setS((v) => ({ ...v, ...p }));
  return (
    <Dialog
      open
      onClose={onClose}
      title={tx`${browser.name} Settings`}
      width={520}
      buttons={[
        { label: "OK", role: "default", onClick: () => onApply(s) },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.dialog}>
        {browser.family === "chrome" ? <ChromeSettings s={s} patch={patch} /> : <FirefoxSettings s={s} patch={patch} />}
      </div>
    </Dialog>
  );
}

type SettingsEditor = { s: BrowserSpecificSettings; patch: (p: Partial<BrowserSpecificSettings>) => void };

function ChromeSettings({ s, patch }: SettingsEditor) {
  const tx = useTx();
  const [defaultDir, setDefaultDir] = useState("");
  useEffect(() => {
    if (isTauri()) void commands.webChromeUserDataDir().then(setDefaultDir);
  }, []);
  const dir = s.userDataDir || defaultDir;
  return (
    <>
      <label className={styles.field}>
        <span>
          <T>Command line options:</T>
        </span>
        <Input
          mono
          value={s.commandLineOptions}
          placeholder="--incognito --auto-open-devtools-for-tabs"
          onChange={(e) => patch({ commandLineOptions: e.target.value })}
        />
      </label>
      <Checkbox
        checked={s.useCustomProfile}
        onChange={(useCustomProfile) => patch({ useCustomProfile, userDataDir: s.userDataDir || defaultDir })}
        label={<T>Use custom user data directory:</T>}
      />
      <span className={styles.pathField}>
        <Input
          mono
          value={dir}
          disabled={!s.useCustomProfile}
          aria-label={tx("User data directory")}
          onChange={(e) => patch({ userDataDir: e.target.value })}
        />
        <Button
          size="small"
          disabled={!s.useCustomProfile || !isTauri()}
          onClick={() =>
            void choosePath(tx("Select User Data Directory"), dir, true).then((p) => p && patch({ userDataDir: p }))
          }
        >
          Browse…
        </Button>
      </span>
    </>
  );
}

function FirefoxSettings({ s, patch }: SettingsEditor) {
  const tx = useTx();
  const [profiles, setProfiles] = useState<{ defaultIni: string; names: { name: string; default: boolean }[] }>({
    defaultIni: "",
    names: [],
  });
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    void call(commands.webFirefoxProfiles(s.profilesIniPath || null)).then(
      (r) => live && setProfiles({ defaultIni: r.defaultIniPath ?? "", names: r.profiles }),
      () => live && setProfiles((p) => ({ ...p, names: [] })),
    );
    return () => {
      live = false;
    };
  }, [s.profilesIniPath]);
  const options = useMemo<SelectOption[]>(
    () => profiles.names.map((p) => ({ value: p.name, label: p.name, detail: p.default ? tx("default") : undefined })),
    [profiles.names, tx],
  );
  const chosen = profiles.names.find((p) => p.name === s.profile) ?? profiles.names.find((p) => p.default);
  return (
    <>
      <label className={styles.field}>
        <span>
          <T>{'Path to "profiles.ini":'}</T>
        </span>
        <span className={styles.pathField}>
          <Input
            mono
            value={s.profilesIniPath}
            placeholder={profiles.defaultIni}
            onChange={(e) => patch({ profilesIniPath: e.target.value })}
          />
          <Button
            size="small"
            disabled={!isTauri()}
            onClick={() =>
              void choosePath(tx('Select "profiles.ini" File'), s.profilesIniPath || profiles.defaultIni).then(
                (p) => p && patch({ profilesIniPath: p }),
              )
            }
          >
            Browse…
          </Button>
        </span>
      </label>
      <label className={styles.field}>
        <span>
          <T>Profile:</T>
        </span>
        <Select
          value={chosen?.name ?? ""}
          options={options}
          disabled={options.length === 0}
          aria-label={tx("Firefox profile")}
          onChange={(profile) => patch({ profile })}
        />
      </label>
    </>
  );
}

// ---------------------------------------------------------------------------

export function WebBrowsersSettingsPage() {
  const tx = useTx();
  const form = useSettingsForm();
  const rawBrowsers = form.useValue("webBrowsers");
  const rawServer = form.useValue("builtInServer");
  const prefs = useMemo(() => validateWebBrowsers(rawBrowsers), [rawBrowsers]);
  const server = useMemo(() => validateBuiltInServer(rawServer), [rawServer]);

  const defaults: SelectOption[] = [
    { value: SYSTEM_DEFAULT, label: tx("System default"), icon: "web" },
    ...prefs.browsers
      .filter((b) => b.active && b.path.trim())
      .map((b) => ({ value: b.id, label: b.name, icon: browserIcon(b) })),
  ];
  const defaultChoice = defaults.some((o) => o.value === prefs.defaultBrowser) ? prefs.defaultBrowser : SYSTEM_DEFAULT;
  const externalAllowed = server.port < DEFAULT_SERVER_PORT;

  return (
    <div className={styles.page}>
      <BrowserTable browsers={prefs.browsers} onChange={(browsers) => form.set("webBrowsers.browsers", browsers)} />
      <Row label="Default browser">
        <Select
          value={defaultChoice}
          options={defaults}
          aria-label={tx("Default browser")}
          onChange={(id) => form.set("webBrowsers.defaultBrowser", id)}
        />
      </Row>
      <Section title="Show browser popup in the editor">
        <Toggle
          label="For HTML files"
          checked={prefs.showHover}
          onChange={(on) => form.set("webBrowsers.showHover", on)}
        />
        <Toggle
          label="For XML files"
          checked={prefs.showHoverXml}
          onChange={(on) => form.set("webBrowsers.showHoverXml", on)}
        />
      </Section>
      <Section title="Reload behavior">
        <Row label="Reload page in browser">
          <Select
            value={prefs.serverReloadMode}
            options={RELOAD_OPTIONS}
            aria-label={tx("Reload page in browser")}
            onChange={(m) => form.set("webBrowsers.serverReloadMode", m)}
          />
        </Row>
        <Row label="Reload page in built-in preview">
          <Select
            value={prefs.previewReloadMode}
            options={RELOAD_OPTIONS}
            aria-label={tx("Reload page in built-in preview")}
            onChange={(m) => form.set("webBrowsers.previewReloadMode", m)}
          />
        </Row>
      </Section>
      <Section title="Built-in Server">
        <Row label="Port">
          <span className={styles.inline}>
            <NumberInput
              value={server.port}
              min={MIN_SERVER_PORT}
              max={MAX_SERVER_PORT}
              integer
              aria-label={tx("Port")}
              onChange={(port) => form.set("builtInServer.port", port)}
            />
            <Info text="Use the built-in web server, for example, to preview and debug your applications in a web browser or in the built-in preview. The server is always running and doesn't require any manual configuration." />
          </span>
        </Row>
        <span
          className={styles.toggleWrap}
          {...(externalAllowed
            ? {}
            : tooltipAttrs(tx("Can't be enabled for the default port (port number >= 63342). Change it first.")))}
        >
          <Toggle
            label="Can accept external connections"
            checked={server.availableExternally}
            disabled={!externalAllowed}
            onChange={(on) => form.set("builtInServer.availableExternally", on)}
          />
        </span>
        <Toggle
          label="Allow unsigned requests"
          checked={server.allowUnsignedRequests}
          onChange={(on) => form.set("builtInServer.allowUnsignedRequests", on)}
        />
      </Section>
    </div>
  );
}
