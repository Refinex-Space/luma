import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { DataSource } from "@/platform/ipc";
import { consoleExtension } from "./console";
import { bindConsole, consoleSource, useDatabase } from "./store";

const mocks = vi.hoisted(() => ({ schemas: vi.fn(), completion: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    call: (value: unknown) => value,
    commands: { ...real.commands, dbSchemas: mocks.schemas, dbCompletion: mocks.completion },
  };
});

const PATH = "/consoles/db/my/console.sql";
const mysql: DataSource = { id: "my", name: "luma-mysql", driver: "mysql", host: "127.0.0.1", database: "" };

let view: EditorView | null = null;

async function mount() {
  await act(async () => {
    view = new EditorView({
      parent: document.body.appendChild(document.createElement("div")),
      state: EditorState.create({
        doc: "select * from orders;",
        extensions: consoleExtension({ doc: 1, path: PATH, language: "sql", uiMode: "SQL", readOnly: false }),
      }),
    });
  });
}

beforeEach(() => {
  mocks.schemas.mockResolvedValue(["luma", "shop"]);
  mocks.completion.mockResolvedValue({ defaultSchema: "", tables: [], foreignKeys: [] });
  useDatabase.setState({ sources: [mysql], loaded: true, consoles: {}, schemas: {}, connected: new Set() });
});

afterEach(() => {
  act(() => view?.destroy());
  view = null;
  document.body.innerHTML = "";
});

it("lets a MySQL console pick the database unqualified names run in", async () => {
  bindConsole(PATH, "my");
  await mount();
  expect(mocks.schemas).toHaveBeenCalledWith("my");
  const picker = await screen.findByRole("button", { name: "Database" });
  expect(picker.textContent).toContain("<database>");

  await act(async () => fireEvent.click(picker));
  await act(async () => fireEvent.click(await screen.findByRole("option", { name: /shop/ })));
  expect(consoleSource(PATH)).toBe("my:shop");
  // The data source picker keeps showing the data source.
  expect(screen.getByRole("button", { name: "Data source" }).textContent).toContain("luma-mysql");
  expect(screen.getByRole("button", { name: "Database" }).textContent).toContain("shop");
});

it("shows the configured database of a MySQL data source as selected", async () => {
  useDatabase.setState({ sources: [{ ...mysql, database: "luma" }] });
  bindConsole(PATH, "my");
  await mount();
  const picker = await screen.findByRole("button", { name: "Database" });
  await vi.waitFor(() => expect(picker.textContent).toContain("luma"));

  await act(async () => fireEvent.click(picker));
  await act(async () => fireEvent.click(await screen.findByRole("option", { name: /shop/ })));
  expect(consoleSource(PATH)).toBe("my:shop");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Database" })));
  await act(async () => fireEvent.click(await screen.findByRole("option", { name: /luma/ })));
  // Back on the configured database: the data source's own target.
  expect(consoleSource(PATH)).toBe("my");
});

it("has no database picker for other drivers", async () => {
  useDatabase.setState({ sources: [{ ...mysql, driver: "sqlite", host: "" }] });
  bindConsole(PATH, "my");
  await mount();
  await screen.findByRole("button", { name: "Data source" });
  expect(screen.queryByRole("button", { name: "Database" })).toBeNull();
  expect(mocks.schemas).not.toHaveBeenCalled();
});
