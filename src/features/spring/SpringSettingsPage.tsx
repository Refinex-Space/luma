/**
 * Settings › Languages & Frameworks › Spring: the switch and the profiles the IDE analyses with
 * (IDEA's "Change Active Spring Profiles", scope Project). Staged and written on Apply / OK.
 */
import { useEffect, useMemo, useState } from "react";
import { Input, T } from "@/ui";
import { useTx } from "@/platform/i18n";
import { validateSpring } from "@/platform/springSettings";
import { useSettingsForm } from "@/workbench/contributions";
import { Row, Section, Toggle } from "@/features/settings/components/Form";
import { useSpringStatus, refreshSpringStatus } from "./status";

const splitProfiles = (text: string) =>
  text
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

function ProjectStatus() {
  const tx = useTx();
  const status = useSpringStatus();
  useEffect(() => void refreshSpringStatus(), []);
  if (!status) return null;
  const versions = [
    status.springVersion ? `Spring ${status.springVersion}` : null,
    status.bootVersion ? `Spring Boot ${status.bootVersion}` : null,
  ].filter(Boolean);
  return (
    <Row label="This project">
      <span>{status.active ? versions.join(" · ") || tx("Uses Spring") : <T>Doesn't use Spring</T>}</span>
    </Row>
  );
}

export function SpringSettingsPage() {
  const tx = useTx();
  const form = useSettingsForm();
  const raw = form.useValue("spring");
  const prefs = useMemo(() => validateSpring(raw), [raw]);
  const joined = prefs.activeProfiles.join(", ");
  const [text, setText] = useState(joined);
  const [seen, setSeen] = useState(joined);
  // Reset elsewhere (Cancel, another scope): show the new list, keep what is being typed otherwise.
  if (joined !== seen) {
    setSeen(joined);
    if (splitProfiles(text).join(", ") !== joined) setText(joined);
  }
  return (
    <>
      <Section title="Spring">
        <Toggle
          label="Enable Spring support"
          checked={prefs.enabled}
          onChange={(on) => form.set("spring.enabled", on)}
        />
        {prefs.enabled && <ProjectStatus />}
      </Section>
      {prefs.enabled && (
        <Section title="Analysis">
          <Toggle
            label="Include library beans"
            checked={prefs.libraryBeans}
            onChange={(on) => form.set("spring.libraryBeans", on)}
          />
          <Row label="Active profiles" htmlFor="spring-active-profiles">
            <Input
              id="spring-active-profiles"
              value={text}
              aria-label={tx("Active profiles")}
              onChange={(e) => {
                setText(e.currentTarget.value);
                form.set("spring.activeProfiles", splitProfiles(e.currentTarget.value));
              }}
            />
          </Row>
        </Section>
      )}
    </>
  );
}
