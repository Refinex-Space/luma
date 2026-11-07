import { describe, expect, it } from "vitest";
import type { JavaMarker } from "@/platform/ipc";
import { javaLineMarker, markerGroup } from "./lineMarkers";

const target = (owner: string, line: number) => ({
  location: { path: `/p/${owner}.java`, range: { start: { line, col: 13 }, end: { line, col: 18 } } },
  owner,
  abstract: false,
});

describe("javaLineMarker", () => {
  it("titles types and methods by their marker kind and owners", () => {
    const iface: JavaMarker = {
      line: 1,
      col: 17,
      name: "Shape",
      method: false,
      kind: "implemented",
      targets: [target("Square", 3), target("Circle", 1)],
    };
    const m = javaLineMarker(iface);
    expect(m.tooltip).toBe("Is implemented by Circle, Square");
    expect(m.chooserTitle).toBe("Choose Implementation of Shape (2 found)");
    expect(m.targets.map((t) => t.path)).toEqual(["/p/Square.java", "/p/Circle.java"]);
    const sub = javaLineMarker({ ...iface, kind: "overridden" });
    expect(sub.tooltip).toBe("Is subclassed by Circle, Square");
    const overriding = javaLineMarker({
      ...iface,
      name: "area",
      method: true,
      kind: "overriding",
      targets: [target("Base", 4)],
    });
    expect([overriding.tooltip, overriding.chooserTitle]).toEqual([
      "Overrides method in Base",
      "Choose Super Method of area (1 found)",
    ]);
    expect(javaLineMarker({ ...iface, method: true }).tooltip).toBe("Is implemented in Circle, Square");
    expect([markerGroup("overridden"), markerGroup("implementing"), markerGroup("injection")]).toEqual([
      "inheritors",
      "supers",
      "spring",
    ]);
  });
});
