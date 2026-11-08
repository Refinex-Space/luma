/**
 * Settings › Languages & Frameworks › Spring › Spring Boot: the switch, the configuration files
 * of Boot modules (IDEA's Customize Spring Boot: `spring.config.name` and custom files) and the
 * runtime views. Staged and written on Apply / OK.
 */
import { useMemo } from "react";
import { useTx } from "@/platform/i18n";
import { validateSpringBoot } from "@/platform/springBootSettings";
import { useSettingsForm } from "@/workbench/contributions";
import { GlobListEditor, NumberInput, Row, Section, Toggle } from "@/features/settings/components/Form";

/** Examples, not text: shown as typed. */
const NAME_EXAMPLE = "application";
const FILE_EXAMPLE = "config/custom.yml";

export function SpringBootSettingsPage() {
  const tx = useTx();
  const form = useSettingsForm();
  const raw = form.useValue("springBoot");
  const prefs = useMemo(() => validateSpringBoot(raw), [raw]);
  return (
    <>
      <Section title="Spring Boot">
        <Toggle
          label="Enable Spring Boot support"
          checked={prefs.enabled}
          onChange={(on) => form.set("springBoot.enabled", on)}
        />
      </Section>
      {prefs.enabled && (
        <>
          <Section title="Configuration Files">
            <Row label="File names" stacked>
              <GlobListEditor
                value={prefs.configNames}
                onChange={(v) => form.set("springBoot.configNames", v)}
                placeholder={NAME_EXAMPLE}
                emptyText={tx("Only application")}
                itemLabel={tx("File name")}
                aria-label={tx("Configuration file names")}
              />
            </Row>
            <Row label="Additional files" stacked>
              <GlobListEditor
                value={prefs.configFiles}
                onChange={(v) => form.set("springBoot.configFiles", v)}
                placeholder={FILE_EXAMPLE}
                emptyText={tx("No additional files")}
                itemLabel={tx("File")}
                aria-label={tx("Additional configuration files")}
              />
            </Row>
          </Section>
          <Section title="Run">
            <Toggle
              label="Show runtime beans, health, mappings and environment of running applications"
              checked={prefs.liveData}
              onChange={(on) => form.set("springBoot.liveData", on)}
            />
            <Row label="Refresh health every" htmlFor="spring-boot-health-refresh" disabled={!prefs.liveData}>
              <NumberInput
                id="spring-boot-health-refresh"
                value={prefs.healthRefresh}
                min={1}
                max={3600}
                integer
                unit={tx("seconds")}
                aria-label={tx("Refresh health every")}
                onChange={(v) => form.set("springBoot.healthRefresh", v)}
              />
            </Row>
            <Toggle
              label="Disable launch optimization in new run configurations"
              checked={prefs.disableLaunchOptimization}
              onChange={(on) => form.set("springBoot.disableLaunchOptimization", on)}
            />
          </Section>
        </>
      )}
    </>
  );
}
