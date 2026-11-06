/** A field's type as a small tinted glyph (Kibana's field tokens, IDEA-sized): t, #, calendar, ◐, pin, ip, {}. */
import type { EsField } from "@/platform/ipc";
import type { FieldGroup } from "../model";
import { groupOf } from "./search";
import css from "./Discover.module.css";

const GLYPH: Record<FieldGroup, string> = {
  string: "t",
  number: "#",
  date: "",
  boolean: "",
  geo: "",
  ip: "ip",
  object: "{}",
  binary: "01",
  other: "?",
};

function Svg({ group }: { group: FieldGroup }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round" as const };
  if (group === "date")
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
        <rect x="1" y="1.8" width="8" height="7.2" rx="1.4" {...common} />
        <path d="M1 4.2h8M3.2 0.8v1.8M6.8 0.8v1.8" {...common} />
      </svg>
    );
  if (group === "boolean")
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
        <circle cx="5" cy="5" r="3.8" {...common} />
        <path d="M5 1.2a3.8 3.8 0 0 1 0 7.6z" fill="currentColor" />
      </svg>
    );
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path d="M5 9s3-2.8 3-5a3 3 0 0 0-6 0c0 2.2 3 5 3 5z" {...common} />
      <circle cx="5" cy="4" r="1" fill="currentColor" />
    </svg>
  );
}

export function FieldIcon({ field }: { field: EsField }) {
  const group = groupOf(field);
  const glyph = GLYPH[group];
  return (
    <span className={css.fieldIcon} data-group={group} title={field.types.join(", ")} aria-hidden>
      {glyph ? <span className={glyph.length > 1 ? css.glyphSmall : undefined}>{glyph}</span> : <Svg group={group} />}
    </span>
  );
}
