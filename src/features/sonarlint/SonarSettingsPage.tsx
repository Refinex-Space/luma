/**
 * Settings › Tools › SonarQube for IDE: the analysis engine (download, update,
 * remove; the runtimes it runs on), the on/off switch, the rules (activation and
 * parameters, with each rule's description) and what is analyzed. Settings are
 * staged in the dialog and written on Apply / OK; downloads run right away.
 */
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import type { SonarLintSettings, SonarRule, SonarRuleDescription } from "@/bindings";
import {
  Button,
  Checkbox,
  EmptyState,
  Icon,
  Input,
  List,
  ProgressBar,
  SearchField,
  Select,
  Spinner,
  T,
  Tabs,
  tooltipAttrs,
} from "@/ui";
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { tx } from "@/platform/i18n";
import { useSettingsForm } from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";
import { RuleDescription } from "./RuleDescription";
import {
  cancelInstall,
  ENGINE_SIZE,
  installEngine,
  isActive,
  phaseTitle,
  ready,
  sonarPrefs,
  type RuleOverrides,
  type SonarPrefs,
  refreshStatus,
  removeEngine,
  setEnabled,
  useSonar,
  withActivation,
  withParameter,
} from "./store";
import styles from "./Sonar.module.css";

type RuleFilter = "all" | "active" | "inactive" | "changed";
type Row = { section: string; count: number } | { rule: SonarRule };

const FILTERS: { value: RuleFilter; label: string }[] = [
  { value: "all", label: "All rules" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "changed", label: "Changed" },
];

const LICENSE_NOTE =
  "SonarQube for IDE is SonarSource's analysis engine, downloaded from Open VSX on demand: the language server is LGPL-3.0, the analyzers are licensed by SonarSource under SSALv1.";

function Engine() {
  const status = useSonar((s) => s.status);
  const job = useSonar((s) => s.job);
  const error = useSonar((s) => s.installError ?? s.error);
  const runtimes = [
    status?.java && `Java ${status.java.version}`,
    status?.node
      ? `Node.js ${status.node.version}`
      : tx("Node.js not found: JavaScript, TypeScript and CSS are skipped"),
  ].filter(Boolean);
  return (
    <section className={styles.engine} aria-label={tx("Analysis engine")}>
      <Icon name="toolwindow-inspection" size={32} />
      <div className={styles.engineText}>
        <div className={styles.engineTitle}>
          <span>SonarQube for IDE</span>
          {status?.version && <span className={styles.muted}>{status.version}</span>}
          <span className={styles.info} {...tooltipAttrs(tx(LICENSE_NOTE))} aria-label={tx(LICENSE_NOTE)}>
            <Icon name="info" size={14} />
          </span>
        </div>
        {job ? (
          <div className={styles.engineJob}>
            <span className={styles.jobLine}>
              <span>{phaseTitle(job.phase)}</span>
              {job.fraction != null && <span className={styles.muted}>{Math.floor(job.fraction * 100)}%</span>}
              {job.detail && <span className={styles.muted}>{job.detail}</span>}
            </span>
            <ProgressBar value={job.fraction ?? undefined} aria-label={phaseTitle(job.phase)} />
          </div>
        ) : status === null ? (
          <span className={styles.muted}>
            <T>Checking…</T>
          </span>
        ) : status.installed ? (
          <span className={clsx(styles.muted, !status.java && styles.warning)}>
            {status.java ? runtimes.join(" · ") : tx("Java 21 or newer is required: Repair downloads one")}
          </span>
        ) : (
          <span className={styles.muted}>{tx`Not downloaded (about ${ENGINE_SIZE})`}</span>
        )}
        {error && !job && <span className={styles.error}>{error}</span>}
      </div>
      <div className={styles.engineActions}>
        {job ? (
          <Button size="small" onClick={cancelInstall}>
            Cancel
          </Button>
        ) : status?.installed ? (
          <>
            <Button size="small" onClick={() => void installEngine()}>
              {status.java ? "Update" : "Repair"}
            </Button>
            <Button
              size="small"
              variant="secondary"
              onClick={() =>
                void confirm({
                  title: tx("Remove SonarQube for IDE?"),
                  message: tx("The analysis engine is deleted and code is no longer analyzed by it."),
                  ok: tx("Remove"),
                  icon: "warning",
                }).then((ok) => {
                  if (ok) void removeEngine();
                })
              }
            >
              Remove
            </Button>
          </>
        ) : (
          <Button size="small" variant="primary" disabled={status === null} onClick={() => void installEngine()}>
            Download
          </Button>
        )}
      </div>
    </section>
  );
}

const descriptions = new Map<string, Promise<SonarRuleDescription>>();

function useDescription(key: string | undefined) {
  const [state, setState] = useState<{ key: string; rule?: SonarRuleDescription; error?: string } | null>(null);
  useEffect(() => {
    if (!key || !isTauri()) return;
    let live = true;
    let p = descriptions.get(key);
    if (!p) {
      p = call(commands.sonarRuleDescription(key));
      descriptions.set(key, p);
      p.catch(() => descriptions.delete(key));
    }
    p.then(
      (rule) => live && setState({ key, rule }),
      (e: unknown) => live && setState({ key, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [key]);
  return state?.key === key ? state : null;
}

function RuleDetail({
  rule,
  rules,
  onChange,
}: {
  rule: SonarRule;
  rules: RuleOverrides;
  onChange: (rules: RuleOverrides) => void;
}) {
  const loaded = useDescription(rule.key);
  const values = rules[rule.key]?.parameters ?? {};
  return (
    <div className={styles.detail}>
      <header className={styles.detailHead}>
        <h3 className={styles.ruleTitle}>{rule.name}</h3>
        <span className={styles.ruleKey}>{rule.key}</span>
      </header>
      {!loaded ? (
        <div className={styles.loading}>
          <Spinner size={16} />
        </div>
      ) : loaded.error ? (
        <p className={styles.error}>{loaded.error}</p>
      ) : (
        loaded.rule && (
          <>
            {loaded.rule.parameters.length > 0 && (
              <div className={styles.params} role="group" aria-label={tx("Parameters")}>
                {loaded.rule.parameters.map((p) => (
                  <label key={p.name} className={styles.param}>
                    <span className={styles.paramName} {...(p.description ? tooltipAttrs(p.description) : {})}>
                      {p.name}
                    </span>
                    <Input
                      value={values[p.name] ?? ""}
                      placeholder={p.defaultValue ?? ""}
                      onChange={(e) => onChange(withParameter(rules, rule, p.name, e.currentTarget.value))}
                    />
                  </label>
                ))}
              </div>
            )}
            <RuleDescription rule={loaded.rule} head={false} />
          </>
        )
      )}
    </div>
  );
}

function Rules({ settings, onChange }: { settings: SonarPrefs; onChange: (key: string, value: unknown) => void }) {
  const applied = useProject((s) => s.settings?.sonarlint?.enabled ?? false);
  const status = useSonar((s) => s.status);
  const [rules, setRules] = useState<SonarRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RuleFilter>("all");
  const [selected, setSelected] = useState<string | undefined>();
  const running = applied && ready(status);

  useEffect(() => {
    if (!running || !isTauri()) return;
    let live = true;
    call(commands.sonarRules()).then(
      (list) => {
        if (!live) return;
        setRules(list);
        setError(null);
      },
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [running]);

  const overrides = settings.rules;
  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    const shown = (rules ?? []).filter((r) => {
      if (q && !r.name.toLowerCase().includes(q) && !r.key.toLowerCase().includes(q)) return false;
      if (filter === "active") return isActive(r, overrides);
      if (filter === "inactive") return !isActive(r, overrides);
      if (filter === "changed") return r.key in overrides;
      return true;
    });
    const out: Row[] = [];
    const counts = new Map<string, { section: string; count: number }>();
    for (const rule of shown) {
      let section = counts.get(rule.language);
      if (!section) {
        section = { section: rule.language, count: 0 };
        counts.set(rule.language, section);
        out.push(section);
      }
      section.count++;
      out.push({ rule });
    }
    return out;
  }, [rules, query, filter, overrides]);

  if (!running) {
    return (
      <EmptyState
        className={styles.rulesEmpty}
        title={tx("Turn on SonarQube for IDE to browse its rules")}
        actions={
          <Button variant="primary" disabled={!!useSonar.getState().job} onClick={() => void setEnabled(true)}>
            {ready(status) ? "Turn On" : "Download and Turn On"}
          </Button>
        }
      />
    );
  }
  if (error) return <EmptyState className={styles.rulesEmpty} title={error} />;
  if (!rules)
    return (
      <div className={styles.rulesEmpty}>
        <Spinner />
        <span className={styles.muted}>
          <T>Starting the analysis engine…</T>
        </span>
      </div>
    );

  const current = rows.find((r) => "rule" in r && r.rule.key === selected) ?? rows.find((r) => "rule" in r);
  const currentRule = current && "rule" in current ? current.rule : undefined;
  const changed = Object.keys(overrides).length;
  const setRulesValue = (next: RuleOverrides) => onChange("sonarlint.rules", next);

  return (
    <div className={styles.rules}>
      <div className={styles.master}>
        <div className={styles.masterBar}>
          <SearchField
            className={styles.search}
            value={query}
            onChange={setQuery}
            placeholder={tx("Filter by name or key")}
            aria-label={tx("Filter rules")}
          />
          <Select value={filter} onChange={setFilter} options={FILTERS.map((f) => ({ ...f, label: tx(f.label) }))} />
        </div>
        <List<Row>
          className={styles.list}
          aria-label={tx("Rules")}
          items={rows}
          getKey={(r, i) => ("section" in r ? `s:${r.section}:${i}` : r.rule.key)}
          isSection={(r) => "section" in r}
          renderSection={(r) =>
            "section" in r ? (
              <div className={styles.section}>
                <span>{r.section}</span>
                <span className={styles.muted}>{r.count}</span>
              </div>
            ) : null
          }
          renderItem={(r) => {
            if (!("rule" in r)) return null;
            const rule = r.rule;
            const on = isActive(rule, overrides);
            return (
              <span className={clsx(styles.ruleRow, !on && styles.dim)}>
                <span onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={on}
                    onChange={(v) => setRulesValue(withActivation(overrides, rule, v))}
                    aria-label={on ? tx`Deactivate ${rule.name}` : tx`Activate ${rule.name}`}
                  />
                </span>
                <span className={styles.ruleName} title={rule.name}>
                  {rule.name}
                </span>
                {rule.key in overrides && <span className={styles.changed} aria-label={tx("Changed")} />}
              </span>
            );
          }}
          activeIndex={current ? rows.indexOf(current) : undefined}
          onActiveChange={(i) => {
            const r = rows[i];
            if (r && "rule" in r) setSelected(r.rule.key);
          }}
          empty={<div className={styles.muted}>{tx("Nothing matches")}</div>}
        />
        <div className={styles.masterFoot}>
          <span className={styles.muted}>{tx`${rules.length} rules`}</span>
          {changed > 0 && (
            <Button size="small" variant="ghost" onClick={() => setRulesValue({})}>
              {tx`Reset ${changed} changed`}
            </Button>
          )}
        </div>
      </div>
      {currentRule ? (
        <RuleDetail key={currentRule.key} rule={currentRule} rules={overrides} onChange={setRulesValue} />
      ) : (
        <div className={styles.detail} />
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>
        <T>{label}</T>
        {hint && (
          <span className={styles.info} {...tooltipAttrs(tx(hint))} aria-label={tx(hint)}>
            <Icon name="info" size={14} />
          </span>
        )}
      </span>
      {children}
    </label>
  );
}

function Options({ settings, onChange }: { settings: SonarPrefs; onChange: (key: string, value: unknown) => void }) {
  return (
    <div className={styles.options}>
      <Field label="Exclude files" hint="Comma-separated globs, relative to the project: **/generated/**, *.min.js">
        <Input
          value={settings.analysisExcludes}
          placeholder="**/generated/**, **/*.min.js"
          onChange={(e) => onChange("sonarlint.analysisExcludes", e.currentTarget.value)}
        />
      </Field>
      <Field
        label="Test files"
        hint="A glob of test files, analyzed with test rules. Empty: detected by the analyzers."
      >
        <Input
          value={settings.testFilePattern}
          placeholder="{**/test/**,**/*test*,**/*Test*}"
          onChange={(e) => onChange("sonarlint.testFilePattern", e.currentTarget.value)}
        />
      </Field>
      <Field
        label="Node.js"
        hint="Node.js 22.12 or newer analyzes JavaScript, TypeScript and CSS. Empty: the one on PATH."
      >
        <Input
          value={settings.nodePath}
          placeholder={tx("Detected on PATH")}
          onChange={(e) => onChange("sonarlint.nodePath", e.currentTarget.value)}
        />
      </Field>
      <Field label="JVM options" hint="Options of the analysis engine's JVM, e.g. -Xmx2g for very large files.">
        <Input
          value={settings.vmArgs}
          placeholder="-Xmx2g"
          onChange={(e) => onChange("sonarlint.vmArgs", e.currentTarget.value)}
        />
      </Field>
    </div>
  );
}

export function SonarSettingsPage() {
  const form = useSettingsForm();
  const staged = form.useValue("sonarlint") as SonarLintSettings | undefined;
  const settings = useMemo(() => sonarPrefs(staged), [staged]);
  const status = useSonar((s) => s.status);
  const [tab, setTab] = useState<"rules" | "options">("rules");
  useEffect(() => void refreshStatus(), []);
  const onChange = (key: string, value: unknown) => form.set(key, value);

  return (
    <div className={styles.page}>
      <Engine />
      <div className={styles.toggle}>
        <Checkbox
          checked={settings.enabled}
          disabled={!ready(status) && !settings.enabled}
          onChange={(on) => onChange("sonarlint.enabled", on)}
          label={tx("Analyze code with SonarQube for IDE")}
        />
      </div>
      <Tabs
        variant="compact"
        className={styles.tabs}
        items={[
          { id: "rules", label: tx("Rules"), text: tx("Rules") },
          { id: "options", label: tx("Analysis"), text: tx("Analysis") },
        ]}
        activeId={tab}
        onSelect={(id) => setTab(id as "rules" | "options")}
        aria-label={tx("SonarQube for IDE")}
      />
      <div className={styles.body}>
        {tab === "rules" ? (
          <Rules settings={settings} onChange={onChange} />
        ) : (
          <Options settings={settings} onChange={onChange} />
        )}
      </div>
    </div>
  );
}
