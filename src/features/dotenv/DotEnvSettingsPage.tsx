/**
 * Settings › Languages & Frameworks › .env files (the plugin's DotEnv settings): the
 * switch, completion in code and whether it shows values, and values hidden in `.env`
 * files. Staged and written on Apply / OK.
 */
import { useMemo } from "react";
import { validateDotEnv } from "@/platform/dotenvSettings";
import { useSettingsForm } from "@/workbench/contributions";
import { Section, Toggle } from "@/features/settings/components/Form";

export function DotEnvSettingsPage() {
  const form = useSettingsForm();
  const raw = form.useValue("dotenv");
  const prefs = useMemo(() => validateDotEnv(raw), [raw]);
  return (
    <>
      <Section title=".env files">
        <Toggle
          label="Enable .env files support"
          checked={prefs.enabled}
          onChange={(on) => form.set("dotenv.enabled", on)}
        />
      </Section>
      {prefs.enabled && (
        <Section title="Environment variables">
          <Toggle
            label="Enable code completion for environment variables"
            checked={prefs.completion}
            onChange={(on) => form.set("dotenv.completion", on)}
          />
          <Toggle
            label="Show values in completion"
            checked={prefs.showValues}
            disabled={!prefs.completion}
            onChange={(on) => form.set("dotenv.showValues", on)}
          />
          <Toggle
            label="Hide values in .env files"
            hint="Values open folded; Expand shows one."
            checked={prefs.hideValues}
            onChange={(on) => form.set("dotenv.hideValues", on)}
          />
        </Section>
      )}
    </>
  );
}
