import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { DataView, shownData, useGridView, viewMenu, type GridViewModel } from "./DataView";
import { useGridPrefs } from "./gridPrefs";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 24,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 24, key: index })),
    scrollToIndex: () => {},
  }),
}));

const columns = [
  { name: "id", type: "BIGINT", primaryKey: true },
  { name: "status", type: "VARCHAR" },
  { name: "total", type: "DECIMAL" },
];
const rows = [
  ["1", "PAID", "658.00"],
  ["2", "SHIPPED", "2399.00"],
  ["3", "NEW", "1299.00"],
];
const value = (r: number, c: number) => rows[r]![c] ?? null;
const target = { table: "orders", driver: "mysql" as const };

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  useGridPrefs.setState({ extractor: "sql", copyHeader: false });
});

function Harness({ onView }: { onView?: (v: GridViewModel) => void }) {
  const view = useGridView(columns);
  onView?.(view);
  return (
    <DataView
      columns={columns}
      rowCount={rows.length}
      value={value}
      target={target}
      view={view}
      panel={null}
      onPanelChange={() => {}}
      aria-label="Result"
    />
  );
}

const grid = () => screen.getByRole("grid");
const rowHeader = (n: string) =>
  screen.getAllByRole("row").find((r) => r.firstElementChild?.textContent === n)!.firstElementChild!;

it("copies the selected rows as SQL INSERT statements of the shown columns", () => {
  let view!: GridViewModel;
  render(<Harness onView={(v) => (view = v)} />);
  fireEvent.mouseDown(rowHeader("2"), { button: 0 });
  fireEvent.mouseDown(rowHeader("3"), { button: 0, shiftKey: true });
  fireEvent.keyDown(grid(), { key: "c", metaKey: true });
  expect(writeText).toHaveBeenLastCalledWith(
    [
      "INSERT INTO orders (id, status, total) VALUES (2, 'SHIPPED', 2399.00);",
      "INSERT INTO orders (id, status, total) VALUES (3, 'NEW', 1299.00);",
    ].join("\n"),
  );
  // Hidden columns are left out of the grid, Copy and Export.
  act(() => view.update({ hidden: new Set([2]) }));
  expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["id", "status"]);
  fireEvent.mouseDown(rowHeader("1"), { button: 0 });
  fireEvent.keyDown(grid(), { key: "c", metaKey: true });
  expect(writeText).toHaveBeenLastCalledWith("INSERT INTO orders (id, status) VALUES (1, 'PAID');");
  expect(shownData({ ...target, columns, rows }, view).columns.map((c) => c.name)).toEqual(["id", "status"]);
});

it("finds on the current page and filters the rows", () => {
  render(<Harness />);
  fireEvent.mouseDown(screen.getAllByRole("gridcell")[0]!, { button: 0 });
  fireEvent.keyDown(grid(), { key: "f", metaKey: true });
  const field = screen.getByRole("textbox", { name: "Find on current page" });
  fireEvent.change(field, { target: { value: "99" } });
  expect(screen.getByText("1/2")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Filter rows" }));
  // Rows 2 (2399.00) and 3 (1299.00) remain.
  expect(
    screen
      .getAllByRole("row")
      .slice(1)
      .map((r) => r.firstElementChild?.textContent),
  ).toEqual(["2", "3"]);
  fireEvent.keyDown(field, { key: "Escape" });
  expect(screen.queryByRole("search")).toBeNull();
  expect(screen.getAllByRole("row")).toHaveLength(4);
});

it("transposes: one row per column, named by it", () => {
  let view!: GridViewModel;
  render(<Harness onView={(v) => (view = v)} />);
  act(() => view.update({ transposed: true }));
  expect(
    screen
      .getAllByRole("row")
      .slice(1)
      .map((r) => r.firstElementChild?.textContent),
  ).toEqual(["id", "status", "total"]);
  expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["1", "2", "3"]);
});

it("goes to a row and column with ⌘L", () => {
  render(<Harness />);
  fireEvent.mouseDown(screen.getAllByRole("gridcell")[0]!, { button: 0 });
  fireEvent.keyDown(grid(), { key: "l", metaKey: true });
  const field = screen.getByRole("textbox", { name: "Row and column" });
  fireEvent.change(field, { target: { value: "3:status" } });
  fireEvent.submit(field.closest("form")!);
  const selected = screen.getAllByRole("gridcell").filter((c) => c.getAttribute("aria-selected"));
  expect(selected.map((c) => c.textContent)).toEqual(["NEW"]);
});

it("offers Transpose, column visibility and Reset View", () => {
  const { result } = renderHook(() => useGridView(columns));
  const items = viewMenu(result.current, columns);
  expect(items.filter((i) => "label" in i).map((i) => ("label" in i ? i.label : ""))).toEqual([
    "Transpose",
    "Columns",
    "Show All Columns",
    "Coloring",
    "Reset View",
  ]);
});

it("pins columns first and shows an aggregate of the selection", () => {
  let view!: GridViewModel;
  render(<Harness onView={(v) => (view = v)} />);
  act(() => view.update({ pinned: new Set([2]) }));
  expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["total", "id", "status"]);
  expect(screen.getAllByRole("columnheader")[0]!.className).toMatch(/pinned/);
  // total of rows 1–2 (the first shown column now).
  const cells = screen.getAllByRole("gridcell");
  fireEvent.mouseDown(cells[0]!, { button: 0 });
  fireEvent.mouseDown(cells[3]!, { button: 0, shiftKey: true });
  useGridPrefs.setState({ aggregate: "sum" });
  expect(screen.getByRole("button", { name: /Sum: 3057/ })).toBeTruthy();
});

it("tints numbers by their place in the column (heatmap)", () => {
  useGridPrefs.setState({ coloring: "sequential" });
  render(<Harness />);
  const total = screen.getAllByRole("gridcell").filter((_, i) => i % 3 === 2);
  // The column minimum has no tint strength beyond the base; the maximum the most.
  expect(total[0]!.style.getPropertyValue("--cell-tint")).toContain("color-mix");
  expect(total[1]!.style.getPropertyValue("--cell-tint")).toContain("55%");
  // Text columns stay plain.
  expect(screen.getAllByRole("gridcell")[1]!.style.getPropertyValue("--cell-tint")).toBe("");
  useGridPrefs.setState({ coloring: "off" });
});

it("keeps read-only cells closed to editing (expression columns, list indexes)", () => {
  const onEdit = vi.fn();
  function Editable() {
    const view = useGridView(columns);
    return (
      <DataView
        columns={columns}
        rowCount={rows.length}
        value={value}
        target={target}
        view={view}
        panel={null}
        onPanelChange={() => {}}
        editable
        cellEditable={(_, c) => c !== 0}
        onEdit={onEdit}
        aria-label="Result"
      />
    );
  }
  render(<Editable />);
  const cells = screen.getAllByRole("gridcell");
  fireEvent.doubleClick(cells[0]!);
  expect(screen.queryByRole("textbox", { name: /^Edit / })).toBeNull();
  fireEvent.doubleClick(cells[1]!);
  expect(screen.getByRole("textbox", { name: "Edit status" })).toBeTruthy();
});

it("shows a JSON value formatted in the Value panel and writes it back as stored", () => {
  const json = '{"theme":"dark","n":1}';
  const onEdit = vi.fn();
  function JsonHarness() {
    const cols = [
      { name: "field", type: "" },
      { name: "value", type: "" },
    ];
    const view = useGridView(cols);
    return (
      <DataView
        columns={cols}
        rowCount={1}
        value={(_, c) => (c === 0 ? "settings" : json)}
        target={target}
        view={view}
        panel="value"
        onPanelChange={() => {}}
        initialCell={{ row: 0, col: 1 }}
        editable
        onEdit={onEdit}
        aria-label="Result"
      />
    );
  }
  render(<JsonHarness />);
  const text = screen.getByRole("textbox", { name: "Value of value" });
  expect((text as HTMLTextAreaElement).value).toBe('{\n  "theme": "dark",\n  "n": 1\n}');
  // Formatting alone is no change.
  const apply = screen.getByRole("button", { name: "Apply" });
  expect(apply).toHaveProperty("disabled", true);
  fireEvent.change(text, { target: { value: '{\n  "theme": "light",\n  "n": 1\n}' } });
  fireEvent.click(apply);
  expect(onEdit).toHaveBeenCalledWith(0, 1, '{"theme":"light","n":1}');
});

it("highlights the header corner with everything selected, where the header and row numbers meet", () => {
  render(<Harness />);
  const corner = screen.getByTitle("Select All");
  expect(corner.className).not.toMatch(/rowNumberSelected/);
  fireEvent.mouseDown(rowHeader("2"), { button: 0 });
  expect(corner.className).not.toMatch(/rowNumberSelected/);
  fireEvent.mouseDown(corner, { button: 0 });
  expect(corner.className).toMatch(/rowNumberSelected/);
});
