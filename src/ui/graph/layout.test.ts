import { describe, expect, it } from "vitest";
import { fitTransform, labelPoint, layoutGraph, lerpPoints, roundedPath } from "./layout";

describe("graph layout", () => {
  it("lays a graph out in layers, edges from source to target", async () => {
    const l = await layoutGraph(
      [
        { id: "a", width: 80, height: 28 },
        { id: "b", width: 80, height: 28 },
        { id: "c", width: 80, height: 28 },
      ],
      [
        { id: "a>b", from: "a", to: "b" },
        { id: "a>c", from: "a", to: "c" },
        { id: "x>a", from: "x", to: "a" },
      ],
    );
    const a = l.nodes.get("a")!;
    const b = l.nodes.get("b")!;
    expect(b.y).toBeGreaterThan(a.y + a.height);
    expect([...l.edges.keys()].sort()).toEqual(["a>b", "a>c"]);
    const e = l.edges.get("a>b")!;
    expect(e.points[0]!.y).toBeCloseTo(a.y + a.height, 0);
    expect(e.points.at(-1)!.y).toBeCloseTo(b.y, 0);
    expect(e.label).not.toBeNull();
  });

  it("draws, moves and fits", () => {
    expect(
      roundedPath(
        [
          { x: 0, y: 0 },
          { x: 0, y: 10 },
          { x: 10, y: 10 },
        ],
        4,
      ),
    ).toBe("M0,0 L0,6 Q0,10 4,10 L10,10");
    expect(
      labelPoint([
        { x: 0, y: 0 },
        { x: 0, y: 10 },
        { x: 10, y: 10 },
      ]),
    ).toEqual({ x: 5, y: 10 });
    expect(
      lerpPoints(
        [{ x: 0, y: 0 }],
        [
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ],
        0.5,
      ),
    ).toEqual([
      { x: 5, y: 0 },
      { x: 5, y: 5 },
    ]);
    expect(fitTransform({ width: 200, height: 100 }, { width: 100, height: 100 })).toEqual({ k: 0.5, x: 0, y: 25 });
    expect(fitTransform({ width: 50, height: 50 }, { width: 100, height: 100 }).k).toBe(1);
  });
});
