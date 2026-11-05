import { afterEach, expect, it } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import { registerServiceView, useActiveServiceView } from "@/workbench/contributions";
import { ServicesTabs, useServicesTabsShown } from "./ServicesHost";

const Empty = () => null;
const disposers: Array<() => void> = [];

afterEach(() => {
  act(() => disposers.splice(0).forEach((d) => d()));
  useActiveServiceView.setState({ active: null, used: new Set() });
});

it("lets the tabs stand in for the window title once a second view is in use", () => {
  disposers.push(
    registerServiceView({ id: "tree", title: "Services", icon: "toolwindow-services", order: 0, component: Empty }),
    registerServiceView({ id: "db", title: "Database", icon: "database", order: 20, onUse: true, component: Empty }),
  );
  const shown = renderHook(() => useServicesTabsShown());
  expect(shown.result.current).toBe(false);

  act(() => useActiveServiceView.setState({ active: "db", used: new Set(["db"]) }));
  expect(shown.result.current).toBe(true);
  render(<ServicesTabs />);
  expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Services", "Database"]);
  // The window's own icon precedes them: the tabs carry none.
  expect(screen.getByRole("tablist").querySelector("svg")).toBeNull();
});
