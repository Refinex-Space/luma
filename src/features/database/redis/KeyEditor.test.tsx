import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { DataSource, RedisKeyInfo, RedisValuePage } from "@/platform/ipc";
import { useDatabase } from "../store";
import { RedisKeyEditor } from "./KeyEditor";
import { redisKeyInput, textBytes } from "./model";

const mocks = vi.hoisted(() => ({ info: vi.fn(), value: vi.fn(), command: vi.fn(), transaction: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    call: (value: unknown) => value,
    commands: {
      ...real.commands,
      redisKeyInfo: mocks.info,
      redisValue: mocks.value,
      redisCommand: mocks.command,
      redisTransaction: mocks.transaction,
    },
  };
});
vi.mock("./store", () => ({ keyChanged: vi.fn(), deleteKey: vi.fn() }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 24,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 24, key: index })),
    scrollToIndex: () => {},
  }),
}));

const source: DataSource = { id: "r", name: "cache", driver: "redis", host: "127.0.0.1", database: "" };
const TARGET = "r:0";

const info = (p: Partial<RedisKeyInfo>): RedisKeyInfo => ({
  key: textBytes("k"),
  kind: "string",
  ttlMs: -1,
  length: null,
  memory: null,
  encoding: null,
  ...p,
});
const page = (p: Partial<RedisValuePage>): RedisValuePage => ({
  kind: "string",
  columns: [],
  rows: [],
  cursor: null,
  offset: 0,
  total: null,
  value: null,
  truncated: false,
  ...p,
});

async function open() {
  await act(async () => {
    render(<RedisKeyEditor input={redisKeyInput(TARGET, textBytes("k"))} />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useDatabase.setState({ sources: [source], connected: new Set() });
  mocks.command.mockResolvedValue({ kind: "status", text: "OK" });
});

it("shows a string with its metadata and saves it keeping the TTL", async () => {
  mocks.info.mockResolvedValue(info({ length: 5, memory: 56, encoding: "embstr" }));
  mocks.value.mockResolvedValue(page({ value: textBytes("hello"), total: 5 }));
  await open();
  expect(screen.getByText("No limit")).toBeTruthy();
  expect(screen.getByText("embstr")).toBeTruthy();
  const area = screen.getByLabelText("Value of k") as HTMLTextAreaElement;
  expect(area.value).toBe("hello");
  const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(area, { target: { value: "world" } });
  expect(save.disabled).toBe(false);
  await act(async () => fireEvent.click(save));
  expect(mocks.command).toHaveBeenCalledWith(TARGET, [
    textBytes("SET"),
    textBytes("k"),
    textBytes("world"),
    textBytes("KEEPTTL"),
  ]);
  // The value reloads after the write.
  expect(mocks.value).toHaveBeenCalledTimes(2);
});

it("opens JSON strings formatted and saves them compact", async () => {
  mocks.info.mockResolvedValue(info({}));
  mocks.value.mockResolvedValue(page({ value: textBytes('{"a":1}') }));
  await open();
  const area = screen.getByLabelText("Value of k") as HTMLTextAreaElement;
  expect(area.value).toBe('{\n  "a": 1\n}');
  fireEvent.change(area, { target: { value: '{\n  "a": 2\n' } });
  expect(screen.getByRole("alert")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(area, { target: { value: '{\n  "a": 2\n}' } });
  await act(async () => fireEvent.keyDown(area, { key: "s", metaKey: true }));
  expect(mocks.command).toHaveBeenCalledWith(TARGET, [
    textBytes("SET"),
    textBytes("k"),
    textBytes('{"a":2}'),
    textBytes("KEEPTTL"),
  ]);
});

it("shows binary strings as a read-only hex dump", async () => {
  mocks.info.mockResolvedValue(info({}));
  mocks.value.mockResolvedValue(page({ value: { text: "ff00", binary: true } }));
  await open();
  const area = screen.getByLabelText("Value of k") as HTMLTextAreaElement;
  expect(area.value.startsWith("00000000  ff 00")).toBe(true);
  expect(area.readOnly).toBe(true);
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
});

it("tells when the key is gone", async () => {
  mocks.info.mockResolvedValue(info({ kind: "none", ttlMs: -2 }));
  await open();
  expect(screen.getByText("This key no longer exists")).toBeTruthy();
  expect(mocks.value).not.toHaveBeenCalled();
});

it("pages a hash and loads more from the cursor", async () => {
  mocks.info.mockResolvedValue(info({ kind: "hash", length: 3 }));
  mocks.value
    .mockResolvedValueOnce(
      page({
        kind: "hash",
        columns: ["field", "value"],
        rows: [
          [textBytes("a"), textBytes("1")],
          [textBytes("b"), textBytes("2")],
        ],
        cursor: "7",
        total: 3,
      }),
    )
    .mockResolvedValueOnce(
      page({ kind: "hash", columns: ["field", "value"], rows: [[textBytes("c"), textBytes("3")]], total: 3 }),
    );
  await open();
  expect(screen.getByText("2 of 3")).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Load More" })));
  expect(mocks.value).toHaveBeenLastCalledWith(
    TARGET,
    textBytes("k"),
    "hash",
    expect.objectContaining({ cursor: "7" }),
  );
  expect(screen.getByText("3 of 3")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Load More" })).toBeNull();
});
