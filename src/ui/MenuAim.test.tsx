import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MenuList, headingFor, inTriangle } from "./Menu";

describe("submenu aiming", () => {
  const sub = { left: 200, right: 400, top: 0, bottom: 300 };

  it("knows a point inside a triangle", () => {
    expect(inTriangle({ x: 1, y: 1 }, { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 4 })).toBe(true);
    expect(inTriangle({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 4 })).toBe(false);
  });

  it("aims at a submenu on the right when moving into the triangle towards its edge", () => {
    // From the parent item, down and to the right over the next item.
    expect(headingFor({ x: 100, y: 20 }, { x: 130, y: 40 }, sub)).toBe(true);
    // Straight down: not towards the submenu.
    expect(headingFor({ x: 100, y: 20 }, { x: 100, y: 60 }, sub)).toBe(false);
    // Back to the left, or not moving at all.
    expect(headingFor({ x: 100, y: 20 }, { x: 80, y: 30 }, sub)).toBe(false);
    expect(headingFor({ x: 100, y: 20 }, { x: 100, y: 20 }, sub)).toBe(false);
  });

  it("aims at a submenu that opened on the left too", () => {
    const left = { left: 0, right: 150, top: 0, bottom: 300 };
    expect(headingFor({ x: 250, y: 20 }, { x: 220, y: 40 }, left)).toBe(true);
    expect(headingFor({ x: 250, y: 20 }, { x: 280, y: 40 }, left)).toBe(false);
  });
});

describe("a menu with a submenu", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps the submenu while the pointer crosses the next item on its way, and switches once it stops", () => {
    vi.useFakeTimers();
    render(
      <MenuList
        items={[
          { label: "Data Source", submenu: [{ label: "MySQL", run: () => {} }] },
          { label: "From File…", run: () => {} },
        ]}
        onDone={() => {}}
      />,
    );
    const source = screen.getByRole("menuitem", { name: /Data Source/ });
    fireEvent.pointerEnter(source, { clientX: 100, clientY: 20 });
    act(() => vi.advanceTimersByTime(150));
    expect(screen.getByRole("menuitem", { name: "MySQL" })).toBeTruthy();
    // The submenu sits to the right of the parent list.
    const lists = screen.getAllByRole("menu");
    vi.spyOn(lists[1]!, "getBoundingClientRect").mockReturnValue({
      left: 200,
      right: 400,
      top: 0,
      bottom: 300,
    } as DOMRect);

    const next = screen.getByRole("menuitem", { name: "From File…" });
    fireEvent.pointerMove(lists[0]!, { clientX: 110, clientY: 26 });
    fireEvent.pointerEnter(next, { clientX: 125, clientY: 36 });
    act(() => vi.advanceTimersByTime(250));
    expect(screen.getByRole("menuitem", { name: "MySQL" })).toBeTruthy();
    expect(source.getAttribute("aria-expanded")).toBe("true");

    // The pointer rests on the next item: it takes over and the submenu closes.
    act(() => vi.advanceTimersByTime(600));
    expect(screen.queryByRole("menuitem", { name: "MySQL" })).toBeNull();
  });

  it("keeps the submenu through a slow crossing and while the pointer rests inside it", () => {
    vi.useFakeTimers();
    render(
      <MenuList
        items={[
          { label: "Data Source", submenu: [{ label: "MySQL", run: () => {} }] },
          { label: "From File…", run: () => {} },
        ]}
        onDone={() => {}}
      />,
    );
    const source = screen.getByRole("menuitem", { name: /Data Source/ });
    fireEvent.pointerEnter(source, { clientX: 100, clientY: 20 });
    act(() => vi.advanceTimersByTime(150));
    const lists = screen.getAllByRole("menu");
    vi.spyOn(lists[1]!, "getBoundingClientRect").mockReturnValue({
      left: 200,
      right: 400,
      top: 0,
      bottom: 300,
    } as DOMRect);
    const next = screen.getByRole("menuitem", { name: "From File…" });
    fireEvent.pointerMove(lists[0]!, { clientX: 110, clientY: 26 });
    fireEvent.pointerEnter(next, { clientX: 120, clientY: 34 });
    // Slowly on towards the submenu: each check finds it still moving that way.
    for (const [x, y] of [
      [140, 40],
      [160, 46],
      [180, 52],
    ]) {
      act(() => vi.advanceTimersByTime(250));
      fireEvent.pointerMove(next, { clientX: x, clientY: y });
    }
    act(() => vi.advanceTimersByTime(250));
    expect(screen.getByRole("menuitem", { name: "MySQL" })).toBeTruthy();
    // Into the submenu, where it rests a while before clicking.
    fireEvent.pointerLeave(next);
    fireEvent.pointerEnter(screen.getByRole("menuitem", { name: "MySQL" }), { clientX: 220, clientY: 60 });
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole("menuitem", { name: "MySQL" })).toBeTruthy();
    expect(source.getAttribute("aria-expanded")).toBe("true");
  });
});
