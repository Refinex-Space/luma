/**
 * Environment › Show Values (Requires Restart): Spring Boot 3+ masks every value of the env
 * endpoint; showing them restarts the application with
 * `management.endpoint.env.show-values=always` in the configuration's Override configuration
 * properties (over JMX no user is authorized, so `when_authorized` would still mask them).
 */
import { tx } from "@/platform/i18n";
import type { RunConfig } from "@/platform/ipc";
import { confirm } from "@/workbench/messages";
import { notifications } from "@/workbench/contributions";
import { formParams, typeFor, withParams } from "@/features/run/types";
import { saveUserConfigs, startRun, useRun } from "@/features/run/store";
import type { LiveSession } from "./store";

const SHOW = "management.endpoint.env.show-values";

/** Override configuration properties with `show-values` set (`null`: removed). */
export function withShowValues(text: string, value: string | null): string {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim() && !new RegExp(`^\\s*${SHOW.replace(/\./g, "\\.")}\\s*[=:]`).test(l));
  if (value !== null) lines.push(`${SHOW}=${value}`);
  return lines.join("\n");
}

export async function showValues(session: LiveSession, show: boolean) {
  const state = useRun.getState();
  const config = state.configs.find((c) => c.id === session.configId);
  const running = state.sessions.find((s) => `run:${s.id}` === session.key);
  if (!config || !running) return;
  const ok = await confirm({
    title: show ? tx("Show Values") : tx("Hide Values"),
    message: show
      ? tx(
          "Showing values restarts the application and adds management.endpoint.env.show-values=always to its Override configuration properties.",
        )
      : tx(
          "Hiding values restarts the application and removes management.endpoint.env.show-values from its Override configuration properties.",
        ),
    ok: tx("Restart"),
  });
  if (!ok) return;
  const type = typeFor(config.kind);
  const params = formParams(config, type);
  if (!type || !params) {
    notifications().notify({
      group: "spring-boot",
      level: "warning",
      title: tx("The configuration cannot be edited in its form"),
    });
    return;
  }
  const next: RunConfig = withParams(
    config,
    { ...params, overrideProperties: withShowValues(params.overrideProperties ?? "", show ? "always" : null) },
    type,
  );
  // A detected configuration becomes a user one (it now differs from what detection makes).
  const user = state.configs.filter((c) => !c.detected && c.id !== config.id);
  await saveUserConfigs([...user, next], config.detected ? [config.id] : []);
  await startRun(next, running.id);
}
