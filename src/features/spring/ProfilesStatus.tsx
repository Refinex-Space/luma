/**
 * The active Spring profiles in the status bar (IDEA's Active Profile panel and its
 * "Change Active Spring Profiles" dialog): the profiles the model is analysed with; a click
 * toggles the profiles the project's `@Profile` expressions name, or takes a list.
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useTx } from "@/platform/i18n";
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useSpringPrefs } from "@/platform/springSettings";
import { BarButton, Input, Popup, T } from "@/ui";
import styles from "./ProfilesStatus.module.css";

/** Profile names an expression mentions: `dev & !(cloud | test)` → dev, cloud, test. */
export function profileNames(expression: string): string[] {
  return expression
    .split(/[\s!&|()]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function splitProfiles(text: string): string[] {
  return [
    ...new Set(
      text
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

async function save(profiles: string[]) {
  if (!isTauri()) return;
  const settings = await call(commands.settingsSet("project", "spring.activeProfiles", JSON.stringify(profiles)));
  useProject.setState({ settings });
}

/** Profiles the project's beans name, sorted. */
async function knownProfiles(): Promise<string[]> {
  if (!isTauri()) return [];
  const beans = await call(commands.springBeans(null)).catch(() => []);
  const names = new Set<string>();
  for (const b of beans) for (const p of b.profiles) profileNames(p).forEach((n) => names.add(n));
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function ProfilesStatus() {
  const tx = useTx();
  const { activeProfiles } = useSpringPrefs();
  const [open, setOpen] = useState(false);
  const [known, setKnown] = useState<string[]>([]);
  const [text, setText] = useState("");
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    setText(activeProfiles.join(", "));
    void knownProfiles().then(setKnown);
    // Read when opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const label = activeProfiles.length ? activeProfiles.join(", ") : "default";
  const chips = [...new Set([...known, ...splitProfiles(text)])];
  const current = splitProfiles(text);
  const toggle = (p: string) => {
    const next = current.includes(p) ? current.filter((x) => x !== p) : [...current, p];
    setText(next.join(", "));
    void save(next);
  };
  return (
    <>
      <BarButton
        ref={ref}
        aria-expanded={open}
        aria-label={tx`Active Spring profiles: ${label}`}
        tooltip="Change Active Spring Profiles…"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.label}>{label}</span>
      </BarButton>
      <Popup
        open={open}
        anchor={ref}
        placement="top-end"
        offset={6}
        onClose={() => setOpen(false)}
        aria-label={tx("Change Active Spring Profiles")}
      >
        <div className={styles.panel}>
          <div className={styles.header}>
            <T>Change Active Spring Profiles</T>
          </div>
          <Input
            autoFocus
            value={text}
            aria-label={tx("Profiles")}
            onChange={(e) => setText(e.currentTarget.value)}
            onBlur={() => void save(splitProfiles(text))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void save(splitProfiles(text));
                setOpen(false);
              }
            }}
          />
          {chips.length > 0 && (
            <div className={styles.chips} role="group" aria-label={tx("Profiles")}>
              {chips.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={current.includes(p)}
                  className={clsx(styles.chip, current.includes(p) && styles.on)}
                  onClick={() => toggle(p)}
                >
                  {p}
                </button>
              ))}
            </div>
          )}
        </div>
      </Popup>
    </>
  );
}
