import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { registerActions } from "@/platform/actions";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Grid } from "./Grid";

const menu = vi.hoisted(() => vi.fn());
vi.mock("@/ui", async (original) => ({ ...(await original<typeof import("@/ui")>()), showContextMenu: menu }));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 24,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 24, key: index })),
    scrollToIndex: () => {},
  }),
}));

describe("database grid", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    disposers
      .splice(0)
      .reverse()
      .forEach((dispose) => dispose());
  });
  it("drags a rectangle and copies it as TSV through the Windows dispatcher", () => {
    useKeymap.setState({ preset: "intellij-windows", overrides: {} });
    const globalCopy = vi.fn();
    disposers.push(registerActions([{ id: "edit.copy", title: "Copy", run: globalCopy }]), installKeyboardDispatcher());
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(
      <Grid
        columns={[
          { name: "a", type: "text" },
          { name: "b", type: "text" },
        ]}
        rowCount={2}
        value={(r, c) =>
          [
            ["one", "two"],
            ["three", "four"],
          ][r]![c]!
        }
      />,
    );
    const cells = screen.getAllByRole("gridcell");
    fireEvent.mouseDown(cells[0]!, { button: 0 });
    fireEvent.mouseEnter(cells[3]!);
    fireEvent.mouseUp(window);
    fireEvent.keyDown(screen.getByRole("grid"), { key: "c", code: "KeyC", ctrlKey: true });
    expect(writeText).toHaveBeenCalledWith("one\ttwo\nthree\tfour");
    expect(globalCopy).not.toHaveBeenCalled();
  });
  it("pastes a rectangle as pending edits and skips deleted rows", () => {
    const onEdit = vi.fn();
    render(
      <Grid
        columns={[
          { name: "a", type: "text" },
          { name: "b", type: "text" },
        ]}
        rowCount={2}
        value={() => "old"}
        editable
        onEdit={onEdit}
        rowState={(r) => (r === 1 ? "deleted" : null)}
      />,
    );
    fireEvent.mouseDown(screen.getAllByRole("gridcell")[0]!, { button: 0 });
    fireEvent.paste(screen.getByRole("grid"), { clipboardData: { getData: () => "new\tother\nignored\tignored" } });
    expect(onEdit.mock.calls).toEqual([
      [0, 0, "new"],
      [0, 1, "other"],
    ]);
  });

  const cols = [
    { name: "id", type: "int" },
    { name: "status", type: "text" },
  ];
  const data = [
    ["1", "PAID"],
    ["2", null],
  ];
  const value = (r: number, c: number) => data[r]![c] ?? null;

  it("copies one cell as is and a block through the extractor", () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const extract = vi.fn(() => "EXTRACTED");
    render(<Grid columns={cols} rowCount={2} value={value} extract={extract} />);
    const cells = screen.getAllByRole("gridcell");
    fireEvent.mouseDown(cells[1]!, { button: 0 });
    fireEvent.keyDown(screen.getByRole("grid"), { key: "c", metaKey: true });
    expect(writeText).toHaveBeenLastCalledWith("PAID");
    expect(extract).not.toHaveBeenCalled();
    // A row header click selects the whole row.
    fireEvent.mouseDown(screen.getAllByText("2")[0]!.closest("[class]")!, { button: 0 });
    fireEvent.keyDown(screen.getByRole("grid"), { key: "c", metaKey: true });
    expect(extract).toHaveBeenCalledWith([1], [0, 1]);
    expect(writeText).toHaveBeenLastCalledWith("EXTRACTED");
  });

  it("sorts from the header's sort icon and selects the column from the rest of it", () => {
    const onSortChange = vi.fn();
    render(
      <Grid
        columns={cols}
        rowCount={2}
        value={value}
        sort={[{ column: "id", descending: false }]}
        onSortChange={onSortChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sort by status" }));
    expect(onSortChange).toHaveBeenLastCalledWith([{ column: "status", descending: false }]);
    fireEvent.click(screen.getByRole("button", { name: "Sort by status" }), { altKey: true });
    expect(onSortChange).toHaveBeenLastCalledWith([
      { column: "id", descending: false },
      { column: "status", descending: false },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "id: ascending" }));
    expect(onSortChange).toHaveBeenLastCalledWith([{ column: "id", descending: true }]);
    fireEvent.mouseDown(screen.getAllByRole("columnheader")[1]!, { button: 0 });
    const selected = screen.getAllByRole("gridcell").filter((c) => c.getAttribute("aria-selected"));
    expect(selected.map((c) => c.textContent)).toEqual(["PAID", "<null>"]);
  });

  it("offers IDEA's column header menu", () => {
    const onHideColumns = vi.fn();
    const onSortChange = vi.fn();
    render(
      <Grid columns={cols} rowCount={2} value={value} onHideColumns={onHideColumns} onSortChange={onSortChange} />,
    );
    fireEvent.contextMenu(screen.getAllByRole("columnheader")[1]!);
    const items = menu.mock.calls.at(-1)![1] as Array<{ label?: string; kind?: string; run?: () => void }>;
    const labels = items.filter((i) => i.label).map((i) => i.label);
    expect(labels).toEqual(
      expect.arrayContaining(["Copy Column Name", "Hide Column", "Hide Other Columns", "ORDER BY", "Clear Sorting"]),
    );
    items.find((i) => i.label === "Hide Column")!.run!();
    expect(onHideColumns).toHaveBeenCalledWith([1]);
    items.find((i) => i.label === "Descending")!.run!();
    expect(onSortChange).toHaveBeenCalledWith([{ column: "status", descending: true }]);
  });
});
