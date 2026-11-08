/**
 * Quick Documentation of configuration keys and values (hover, the completion side panel):
 * the key, its type and default, description, deprecation and where it is declared.
 */
import type { BootHoverContent, PropertyDoc } from "@/platform/ipc";
import { tx } from "@/platform/i18n";

const code = (s: string) => `\`${s.replace(/`/g, "ˋ")}\``;

/** `a/b/spring-boot-jdbc-4.1.2.jar` → `spring-boot-jdbc-4.1.2.jar`. */
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** `org.springframework.boot.jdbc.DataSourceProperties$Hikari` → `DataSourceProperties.Hikari`. */
function simpleType(fqn: string): string {
  const base = fqn.split("<")[0]!;
  const parts = base.split(".");
  const i = parts.findIndex((p) => /^[A-Z]/.test(p));
  return (i >= 0 ? parts.slice(i).join(".") : parts.at(-1)!).replace(/\$/g, ".");
}

export function propertyDocMarkdown(doc: PropertyDoc): string {
  const lines: string[] = [`**${code(doc.name)}**`];
  const meta: string[] = [];
  if (doc.ty) meta.push(code(doc.ty));
  if (doc.default !== null && doc.default !== "") meta.push(`${tx("Default:")} ${code(doc.default)}`);
  if (doc.kind === "group") meta.push(tx("Group"));
  if (meta.length) lines.push(meta.join(" · "));
  if (doc.description) lines.push(doc.description);
  const d = doc.deprecation;
  if (d) {
    const head =
      d.level === "error" ? tx("No longer supported") : d.since ? tx`Deprecated since ${d.since}` : tx("Deprecated");
    let text = `**${head}**`;
    if (d.level === "error" && d.since) text += ` (${d.since})`;
    if (d.reason) text += `: ${d.reason}`;
    if (d.replacement) text += `. ${tx("Use")} ${code(d.replacement)}`;
    lines.push(`> ${text}`);
  }
  if (doc.values.length) {
    const shown = doc.values.slice(0, 12).map((v) => `${code(v.value)}${v.description ? ` — ${v.description}` : ""}`);
    if (doc.values.length > 12) shown.push("…");
    lines.push(`${tx("Values:")}\n\n${shown.map((s) => `- ${s}`).join("\n")}`);
  }
  const origin: string[] = [];
  if (doc.sourceType) {
    const method = doc.sourceMethod ? `#${doc.sourceMethod.replace(/\(\)$/, "")}` : "";
    origin.push(code(`${simpleType(doc.sourceType)}${method}`));
  }
  const files = [...new Set(doc.origins.map((o) => (o.kind === "source" ? tx("project sources") : fileName(o.path))))];
  if (files.length) origin.push(files.slice(0, 3).join(", ") + (files.length > 3 ? "…" : ""));
  if (origin.length) lines.push(`*${tx("Declared in")}* ${origin.join(" · ")}`);
  return lines.join("\n\n");
}

export function hoverMarkdown(content: BootHoverContent): string {
  switch (content.kind) {
    case "key":
      return propertyDocMarkdown(content.doc);
    case "value": {
      const lines = [`**${code(content.value)}**${content.ty ? ` · ${code(content.ty)}` : ""}`];
      if (content.description) lines.push(content.description);
      return lines.join("\n\n");
    }
    case "placeholder": {
      const rows = content.definitions.slice(0, 8).map((d) => {
        const where = `${fileName(d.path)}:${d.line + 1}`;
        const profile = d.profile ? ` · ${d.profile}` : "";
        return `- ${d.value !== null ? code(d.value) : tx("(no value)")} — ${where}${profile}`;
      });
      return `**${code(content.key)}**\n\n${rows.join("\n")}`;
    }
  }
}
