import type { RunConfig } from "@/platform/ipc";
import type { RunConfigTypeField } from "@/workbench/contributions";

export type UpdateMode = "resources" | "classes" | "redeploy" | "restart" | "trigger" | "hotswapOrTrigger";

/** Spring Boot DevTools' restart trigger (`spring.devtools.restart.trigger-file`), set when an update mode writes it. */
export const DEVTOOLS_TRIGGER_FILE = ".restartTriggerFile";

/** Whether an update mode restarts the application through DevTools' trigger file. */
export const usesTriggerFile = (mode: string | undefined) => mode === "trigger" || mode === "hotswapOrTrigger";

export const updatePolicyDefaults = { onUpdate: "ask", onDeactivation: "none" };

const incrementalOptions = [
  { value: "resources", label: "Update resources" },
  { value: "classes", label: "Update classes and resources" },
];

export function updatePolicyFields(tomcat: boolean): RunConfigTypeField[] {
  return [
    {
      key: "onUpdate",
      label: "On 'Update' action",
      control: "select",
      options: [
        { value: "ask", label: "Show chooser" },
        ...incrementalOptions,
        ...(tomcat ? [{ value: "redeploy", label: "Redeploy" }] : []),
        ...(tomcat
          ? []
          : [
              { value: "trigger", label: "Update trigger file" },
              { value: "hotswapOrTrigger", label: "Hot swap classes and update trigger file if failed" },
            ]),
        { value: "restart", label: "Restart" },
      ],
    },
    {
      key: "onDeactivation",
      label: "On frame deactivation",
      control: "select",
      options: [{ value: "none", label: "Do nothing" }, ...incrementalOptions],
      hint: "When all project windows lose focus to another application",
    },
  ];
}

export function isUpdatable(config: RunConfig): boolean {
  return !config.target && (config.kind === "tomcat" || config.kind === "spring-boot");
}

export function updateAllowed(config: RunConfig, mode: string): mode is UpdateMode {
  return (
    isUpdatable(config) &&
    (mode === "resources" ||
      mode === "classes" ||
      mode === "restart" ||
      (mode === "redeploy" && config.kind === "tomcat") ||
      (usesTriggerFile(mode) && config.kind === "spring-boot")) &&
    !((mode === "resources" || mode === "classes") && config.kind === "tomcat" && config.params?.deployment === "war")
  );
}
