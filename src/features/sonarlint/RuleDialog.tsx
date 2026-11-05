/** The rule description a SonarQube issue's "Show issue details" opens. */
import { Dialog } from "@/ui";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { RuleDescription } from "./RuleDescription";
import { SETTINGS_PAGE } from "./store";
import { closeRule, useRuleDialog } from "./ruleStore";
import styles from "./Sonar.module.css";

export function RuleDialog() {
  const rule = useRuleDialog((s) => s.rule);
  if (!rule) return null;
  return (
    <Dialog
      open
      title={rule.key}
      onClose={closeRule}
      width="min(760px, calc(100vw - 64px))"
      className={styles.ruleDialog}
      aria-label={tx`Rule ${rule.name}`}
      footerStart={
        <button
          type="button"
          className={styles.link}
          onClick={() => {
            closeRule();
            void executeAction("file.settings", SETTINGS_PAGE);
          }}
        >
          {tx("Configure rules…")}
        </button>
      }
      buttons={[{ label: "Close", role: "default", onClick: closeRule }]}
    >
      <div className={styles.ruleDialogBody}>
        <RuleDescription rule={rule} />
      </div>
    </Dialog>
  );
}
