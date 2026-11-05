/**
 * A Sonar rule's description, as SonarSource's engine renders it: the rule's
 * name and key, its impacts (or type and severity), then its tabs ("Why is this
 * an issue?", "How can I fix it?", "More info") with framework variants.
 * The HTML is sanitized; links open in the browser.
 */
import { useMemo, useState, type MouseEvent } from "react";
import DOMPurify from "dompurify";
import type { SonarRuleDescription } from "@/bindings";
import { Badge, Select, Tabs, T } from "@/ui";
import { openExternalUrl } from "@/platform/openUrl";
import { tx } from "@/platform/i18n";
import styles from "./Sonar.module.css";

const sanitize = (html: string) =>
  DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "form", "input", "button"] });

const key = (s: string) => s.trim().toUpperCase().replace(/\s+/g, "_");
const words = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");

/** Sonar's enum values (impacts, types, severities, clean code categories) as UI text. */
function label(value: string): string {
  // The engine sends enum keys (`CODE_SMELL`) or display names (`Maintainability`).
  switch (key(value)) {
    case "MAINTAINABILITY":
      return tx("Maintainability");
    case "RELIABILITY":
      return tx("Reliability");
    case "SECURITY":
      return tx("Security");
    case "BLOCKER":
      return tx("Blocker");
    case "HIGH":
      return tx("High");
    case "MEDIUM":
      return tx("Medium");
    case "LOW":
      return tx("Low");
    case "INFO":
      return tx("Info");
    case "CRITICAL":
      return tx("Critical");
    case "MAJOR":
      return tx("Major");
    case "MINOR":
      return tx("Minor");
    case "BUG":
      return tx("Bug");
    case "VULNERABILITY":
      return tx("Vulnerability");
    case "CODE_SMELL":
      return tx("Code smell");
    case "SECURITY_HOTSPOT":
      return tx("Security hotspot");
    case "CONSISTENCY":
      return tx("Consistency");
    case "INTENTIONALITY":
      return tx("Intentionality");
    case "ADAPTABILITY":
      return tx("Adaptability");
    case "RESPONSIBILITY":
      return tx("Responsibility");
    default:
      return words(value);
  }
}

type Tone = "danger" | "warning" | "accent" | "neutral";
const SEVERITY_TONE: Record<string, Tone> = {
  BLOCKER: "danger",
  HIGH: "danger",
  CRITICAL: "danger",
  MEDIUM: "warning",
  MAJOR: "warning",
  LOW: "accent",
  MINOR: "accent",
  INFO: "neutral",
};

function openLink(e: MouseEvent<HTMLDivElement>) {
  const a = (e.target as HTMLElement).closest("a");
  const href = a?.getAttribute("href");
  if (!href) return;
  e.preventDefault();
  if (/^(https?|mailto):/i.test(href)) void openExternalUrl(href);
}

function Html({ html }: { html: string }) {
  const clean = useMemo(() => sanitize(html), [html]);
  return (
    // Sanitized above; links are intercepted.
    <div className={styles.ruleHtml} onClick={openLink} dangerouslySetInnerHTML={{ __html: clean }} />
  );
}

export function RuleFacts({ rule }: { rule: SonarRuleDescription }) {
  return (
    <div className={styles.ruleFacts}>
      {rule.impacts.length > 0
        ? rule.impacts.map((i) => (
            <Badge key={i.quality} tone={SEVERITY_TONE[key(i.severity)] ?? "neutral"}>
              {label(i.quality)} · {label(i.severity)}
            </Badge>
          ))
        : rule.kind && (
            <Badge tone={SEVERITY_TONE[key(rule.severity ?? "")] ?? "neutral"}>
              {label(rule.kind)}
              {rule.severity ? ` · ${label(rule.severity)}` : ""}
            </Badge>
          )}
      {rule.cleanCodeAttribute && (
        <span className={styles.ruleAttribute}>
          {rule.cleanCodeAttribute.includes("_") ? words(rule.cleanCodeAttribute) : rule.cleanCodeAttribute}
          {rule.cleanCodeCategory ? ` · ${label(rule.cleanCodeCategory)}` : ""}
        </span>
      )}
    </div>
  );
}

function TabBody({ tab }: { tab: SonarRuleDescription["tabs"][number] }) {
  const [context, setContext] = useState(tab.defaultContext ?? tab.contexts[0]?.key ?? "");
  if (!tab.contexts.length) return <Html html={tab.html} />;
  const shown = tab.contexts.find((c) => c.key === context) ?? tab.contexts[0]!;
  return (
    <>
      <div className={styles.ruleContext}>
        <Select
          value={shown.key}
          onChange={setContext}
          options={tab.contexts.map((c) => ({ value: c.key, label: c.name }))}
          aria-label={tx("Framework")}
        />
      </div>
      <Html html={shown.html} />
    </>
  );
}

export function RuleDescription({ rule, head = true }: { rule: SonarRuleDescription; head?: boolean }) {
  const [tab, setTab] = useState(0);
  const current = rule.tabs[Math.min(tab, rule.tabs.length - 1)];
  return (
    <article className={styles.rule} aria-label={rule.name}>
      {head && (
        <header className={styles.ruleHead}>
          <h3 className={styles.ruleTitle}>{rule.name}</h3>
          <span className={styles.ruleKey}>{rule.key}</span>
        </header>
      )}
      <RuleFacts rule={rule} />
      {rule.tabs.length > 0 ? (
        <>
          <Tabs
            variant="compact"
            items={rule.tabs.map((t, i) => ({ id: String(i), label: t.title, text: t.title }))}
            activeId={String(Math.min(tab, rule.tabs.length - 1))}
            onSelect={(id) => setTab(Number(id))}
            aria-label={tx("Rule description")}
            className={styles.ruleTabs}
          />
          {current && <TabBody key={`${rule.key}:${tab}`} tab={current} />}
        </>
      ) : (
        <Html html={rule.html} />
      )}
      {rule.parameters.length > 0 && head && (
        <section className={styles.ruleParams}>
          <h4>
            <T>Parameters</T>
          </h4>
          <dl>
            {rule.parameters.map((p) => (
              <div key={p.name}>
                <dt>{p.name}</dt>
                <dd>
                  {p.description}
                  {p.defaultValue && <span className={styles.muted}> ({tx`default: ${p.defaultValue}`})</span>}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </article>
  );
}
