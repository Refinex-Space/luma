import { describe, expect, it } from "vitest";
import type { SonarRule } from "@/bindings";
import { isActive, nextJob, sonarPrefs, withActivation, withParameter, type InstallJob } from "./store";

const rule = (key: string, activeByDefault: boolean): SonarRule => ({
  key,
  name: key,
  language: "Java",
  activeByDefault,
});
const todo = rule("java:S1135", true);
const params = rule("java:S107", false);

describe("SonarQube rule overrides", () => {
  it("fills in the settings' defaults", () => {
    expect(sonarPrefs(undefined)).toEqual({
      enabled: false,
      rules: {},
      testFilePattern: "",
      analysisExcludes: "",
      nodePath: "",
      vmArgs: "",
    });
    expect(sonarPrefs({ rules: { "java:S1": { level: "off" } } }).rules).toEqual({
      "java:S1": { level: "off", parameters: {} },
    });
  });

  it("keeps only activations that differ from Sonar's way", () => {
    const off = withActivation({}, todo, false);
    expect(off).toEqual({ "java:S1135": { level: "off", parameters: {} } });
    expect(isActive(todo, off)).toBe(false);
    expect(withActivation(off, todo, true)).toEqual({});
    expect(isActive(params, {})).toBe(false);
    expect(withActivation({}, params, true)).toEqual({ "java:S107": { level: "on", parameters: {} } });
  });

  it("stores parameters with the rule's activation, dropping the override when back to defaults", () => {
    const set = withParameter({}, todo, "max", " 5 ");
    expect(set).toEqual({ "java:S1135": { level: "on", parameters: { max: "5" } } });
    // Activation back to the default keeps the override while it has parameters.
    expect(withActivation(set, todo, true)).toEqual(set);
    expect(withParameter(set, todo, "max", "")).toEqual({});
    const offWithParam = withParameter(withActivation({}, todo, false), todo, "max", "3");
    expect(offWithParam["java:S1135"]).toEqual({ level: "off", parameters: { max: "3" } });
    expect(withParameter(offWithParam, todo, "max", "")["java:S1135"]).toEqual({ level: "off", parameters: {} });
  });
});

describe("SonarQube download progress", () => {
  it("follows the installer from the engine to the Java runtime", () => {
    const steps: Parameters<typeof nextJob>[1][] = [
      { type: "line", text: "Resolving the latest release…" },
      { type: "line", text: "Downloading SonarSource.sonarlint-vscode-6.2.0.vsix (https://open-vsx.org/…)" },
      { type: "progress", fraction: 0.25, message: "Downloaded 42.1 of 168.3 MB" },
      { type: "line", text: "Connection interrupted after 42.1 MB; resuming…" },
      { type: "progress", fraction: 0.5, message: "Downloaded 84.2 of 168.3 MB" },
      { type: "line", text: "Checksum verified (SHA-256)" },
      { type: "line", text: "Extracting…" },
      { type: "line", text: "Downloading a Java 21 runtime…" },
      { type: "progress", fraction: null, message: "Downloaded 12.0 MB" },
      { type: "line", text: "Extracting…" },
    ];
    let job: InstallJob = { request: 1, phase: "prepare", fraction: null, detail: null };
    const seen = steps.map((e) => {
      job = nextJob(job, e);
      return [job.phase, job.fraction, job.detail];
    });
    expect(seen).toEqual([
      ["prepare", null, null],
      ["engine", 0, null],
      ["engine", 0.25, "42.1 / 168.3 MB"],
      ["engine", 0.25, "Connection interrupted, resuming…"],
      ["engine", 0.5, "84.2 / 168.3 MB"],
      ["unpack", null, null],
      ["unpack", null, null],
      ["java", 0, null],
      ["java", null, "12.0 MB"],
      ["javaUnpack", null, null],
    ]);
  });
});
