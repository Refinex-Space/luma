import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { emitLocalIdeEvent } from "@/platform/ipc";
import { registerStatusItem, registerToolWindow, type StatusItemContribution } from "./contributions";
import { orderStatusItems, StatusBar, TaskStatus } from "./StatusBar";
import { orderTitleItems } from "./TitleBar";
import { Balloons, NOTIFICATIONS_TOOL_WINDOW, notificationActions, NotificationsToolWindow } from "./Notifications";
import {
  BALLOON_TIMEOUT,
  canSuppress,
  clearNotifications,
  installNotifyEvents,
  STICKY_BALLOON_TIMEOUT,
  notify,
  useNotifications,
} from "./notificationStore";
import { installTaskEvents, useTasks } from "./tasks";
import { ToolWindowLayout } from "./toolwindows/ToolWindows";
import { areaTabs, areaToolsMenu } from "./toolwindows/AreaTabs";
import { hideAllToolWindows, isToolWindowVisible, loadToolWindowLayout, showToolWindow } from "./toolwindows/store";
import { ToolWindowLauncher } from "./toolwindows/Launcher";

const item = (id: string, align: "left" | "right", priority: number): StatusItemContribution => ({
  id,
  align,
  priority,
  component: () => <span>{id}</span>,
});

describe("status bar ordering", () => {
  it("puts higher priorities closer to the window edges", () => {
    const { left, right } = orderStatusItems([
      item("a", "left", 1),
      item("b", "left", 5),
      item("c", "right", 5),
      item("d", "right", 1),
      item("e", "right", 3),
    ]);
    expect(left.map((i) => i.id)).toEqual(["b", "a"]);
    expect(right.map((i) => i.id)).toEqual(["d", "e", "c"]);
  });

  it("renders registered items in order", () => {
    const disposers = [
      registerStatusItem(item("caret", "right", 20)),
      registerStatusItem(item("memory", "right", 60)),
      registerStatusItem(item("crumbs", "left", 0)),
      registerStatusItem(item("encoding", "right", 40)),
    ];
    render(<StatusBar />);
    const ids = [...document.querySelectorAll("[data-status-item]")].map((el) => el.getAttribute("data-status-item"));
    expect(ids).toEqual(["crumbs", "caret", "encoding", "memory"]);
    disposers.forEach((d) => d());
  });

  it("title items sort by priority within each side", () => {
    const C = () => null;
    const { left, right } = orderTitleItems([
      { id: "x", align: "right", priority: 10, component: C },
      { id: "y", align: "right", priority: 0, component: C },
      { id: "z", align: "left", priority: 0, component: C },
    ]);
    expect(left.map((i) => i.id)).toEqual(["z"]);
    expect(right.map((i) => i.id)).toEqual(["y", "x"]);
  });
});

describe("background tasks", () => {
  it("tracks task events and shows the current task", () => {
    vi.useFakeTimers();
    const uninstall = installTaskEvents();
    const dispose = registerStatusItem({ id: "workbench.tasks", align: "right", priority: 0, component: TaskStatus });
    render(<StatusBar />);
    act(() => {
      emitLocalIdeEvent({
        type: "task",
        id: 6,
        title: "Publish Diagnostics",
        message: null,
        fraction: null,
        done: false,
        cancellable: false,
      });
      emitLocalIdeEvent({
        type: "task",
        id: 7,
        title: "Building index",
        message: null,
        fraction: 0.5,
        done: false,
        cancellable: false,
      });
    });
    expect(screen.queryByText("Building index")).toBeNull();
    act(() => {
      emitLocalIdeEvent({
        type: "task",
        id: 6,
        title: "Publish Diagnostics",
        message: null,
        fraction: 1,
        done: true,
        cancellable: false,
      });
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByText("Publish Diagnostics")).toBeNull();
    expect(screen.getByText("Building index")).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")[0]).toHaveAttribute("aria-valuenow", "50");
    act(() => emitLocalIdeEvent({ type: "indexState", indexing: true, files: 10, symbols: 20 }));
    expect(useTasks.getState().tasks).toHaveLength(2);
    dispose();
    uninstall();
    useTasks.setState({ tasks: [], indexing: null });
    vi.useRealTimers();
  });
});

describe("notifications", () => {
  afterEach(() => {
    clearNotifications();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows balloons; info auto-dismisses, errors stay", () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    render(<Balloons />);
    act(() => {
      notify({ level: "info", title: "Saved" });
      notify({ level: "error", title: "Build failed", actions: [{ label: "Show log", run: () => {} }] });
    });
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Build failed");
    act(() => vi.advanceTimersByTime(BALLOON_TIMEOUT.info! + 10));
    expect(screen.queryByText("Saved")).toBeNull();
    expect(screen.getByText("Build failed")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Show log"));
    expect(screen.queryByText("Build failed")).toBeNull();
    expect(useNotifications.getState().items).toHaveLength(2);
  });

  it("explicitly non-sticky errors fade after the ordinary balloon timeout", () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    render(<Balloons />);
    act(() => void notify({ level: "error", title: "Formatting failed", sticky: false }));
    expect(screen.getByRole("alert")).toHaveTextContent("Formatting failed");
    act(() => vi.advanceTimersByTime(BALLOON_TIMEOUT.info! + 10));
    expect(screen.queryByText("Formatting failed")).toBeNull();
    expect(useNotifications.getState().items[0]).toMatchObject({ sticky: false, balloon: false });
  });

  it("sticky balloons fade into the tool window after 5 minutes, staying unread", () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    render(<Balloons />);
    act(() => void notify({ level: "error", title: "Sync failed" }));
    act(() => vi.advanceTimersByTime(STICKY_BALLOON_TIMEOUT - 1000));
    expect(screen.getByText("Sync failed")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1100));
    expect(screen.queryByText("Sync failed")).toBeNull();
    expect(useNotifications.getState().items[0]).toMatchObject({ title: "Sync failed", read: false, balloon: false });
  });

  it("pauses the balloon timeout while the app window is inactive", () => {
    vi.useFakeTimers();
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    try {
      render(<Balloons />);
      act(() => notify({ level: "info", title: "Indexed" }));
      act(() => vi.advanceTimersByTime(BALLOON_TIMEOUT.info! - 1000));
      hasFocus.mockReturnValue(false);
      act(() => void fireEvent.blur(window));
      act(() => vi.advanceTimersByTime(60_000));
      expect(screen.getByText("Indexed")).toBeInTheDocument();
      hasFocus.mockReturnValue(true);
      act(() => void fireEvent.focus(window));
      act(() => vi.advanceTimersByTime(1100));
      expect(screen.queryByText("Indexed")).toBeNull();
    } finally {
      hasFocus.mockRestore();
    }
  });

  it("replaces notifications with the same key and subscribes to backend notify events", () => {
    const uninstall = installNotifyEvents();
    notify({ level: "warning", title: "LSP missing", key: "lsp" });
    notify({ level: "warning", title: "LSP still missing", key: "lsp" });
    act(() => emitLocalIdeEvent({ type: "notify", level: "info", title: "From backend", body: null }));
    expect(useNotifications.getState().items.map((n) => n.title)).toEqual(["From backend", "LSP still missing"]);
    uninstall();
  });

  it("the Notifications tool window lists history, marks it read and hides balloons", () => {
    const dispose = registerToolWindow({
      id: NOTIFICATIONS_TOOL_WINDOW,
      title: "Notifications",
      icon: "bell",
      anchor: "right",
      component: NotificationsToolWindow,
    });
    loadToolWindowLayout("/notifications");
    render(
      <>
        <Balloons />
        <NotificationsToolWindow />
      </>,
    );
    act(() => void notify({ level: "info", title: "Hello" }));
    expect(screen.getAllByText("Hello")).toHaveLength(2);
    expect(useNotifications.getState().items.every((n) => n.read)).toBe(false);
    act(() => showToolWindow(NOTIFICATIONS_TOOL_WINDOW));
    expect(screen.getAllByText("Hello")).toHaveLength(1);
    expect(useNotifications.getState().items.every((n) => n.read && !n.balloon)).toBe(true);
    dispose();
  });
});

describe("tool window area tabs", () => {
  it("lists an area's windows as tabs; another tab shows its window", () => {
    const disposers = [
      registerToolWindow({
        id: "terminal",
        title: "Terminal",
        icon: "terminal",
        anchor: "bottom",
        requiresProject: false,
        component: () => <div>shell</div>,
      }),
      registerToolWindow({
        id: "problems",
        title: "Problems",
        icon: "warning",
        anchor: "bottom",
        requiresProject: false,
        component: () => <div>issues</div>,
      }),
    ];
    loadToolWindowLayout("/tabs");
    showToolWindow("terminal");
    render(<ToolWindowLayout editor={<div>editor</div>} />);
    const strip = screen.getByRole("tablist", { name: "Bottom Left" });
    expect(strip).toHaveAttribute("data-area-slot", "bottom");
    const problems = screen.getByRole("tab", { name: "Problems" });
    expect(problems).toHaveAttribute("aria-selected", "false");
    fireEvent.click(problems);
    expect(isToolWindowVisible("problems")).toBe(true);
    expect(isToolWindowVisible("terminal")).toBe(false);
    disposers.forEach((d) => d());
  });

  it("keeps windows used on demand out of the tabs and offers them, and others, in the Tools menu", () => {
    const C = () => null;
    const windows = [
      { id: "project", title: "Project", icon: "folder", anchor: "left" as const, component: C },
      { id: "pr", title: "Pull Requests", icon: "pr", anchor: "left" as const, stripe: "onUse" as const, component: C },
      {
        id: "structure",
        title: "Structure",
        icon: "structure",
        anchor: "left" as const,
        secondary: true,
        component: C,
      },
      { id: "terminal", title: "Terminal", icon: "terminal", anchor: "bottom" as const, component: C },
    ];
    const tabs = areaTabs(windows, "left", "project", {});
    expect(tabs.map((w) => w.id)).toEqual(["project"]);
    const menu = areaToolsMenu(windows, "left", tabs);
    const labels = menu.map((m) => ("label" in m ? m.label : "—"));
    expect(labels).toEqual(["Left Top", "Pull Requests", "—", "Move Here", "Structure", "Terminal"]);
    // Opened once, an on-demand window keeps its tab.
    expect(areaTabs(windows, "left", "project", { pr: true }).map((w) => w.id)).toEqual(["project", "pr"]);
  });
});

describe("status bar launcher", () => {
  it("lists the bottom windows with their badges, opens one, and folds while the bottom area is open", () => {
    const disposers = [
      registerToolWindow({
        id: "terminal",
        title: "Terminal",
        icon: "terminal",
        anchor: "bottom",
        requiresProject: false,
        component: () => <div>shell</div>,
      }),
      registerToolWindow({
        id: "problems",
        title: "Problems",
        icon: "warning",
        anchor: "bottom",
        requiresProject: false,
        component: () => <div>issues</div>,
        useBadge: () => ({ count: 3, tone: "error" }),
      }),
      registerToolWindow({
        id: "project",
        title: "Project",
        icon: "folder",
        anchor: "left",
        requiresProject: false,
        component: () => null,
      }),
    ];
    loadToolWindowLayout("/launcher");
    hideAllToolWindows();
    render(<ToolWindowLauncher />);
    const bar = screen.getByRole("toolbar", { name: "Bottom tool windows" });
    expect(bar).not.toHaveAttribute("data-hidden");
    const buttons = within(bar).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Problems 3", "Terminal"]);
    fireEvent.click(buttons[1]!);
    expect(isToolWindowVisible("terminal")).toBe(true);
    expect(bar).toHaveAttribute("data-hidden");
    disposers.forEach((d) => d());
  });
});

describe("tool window split areas", () => {
  it("renders both areas of a side with a splitter", () => {
    const disposers = [
      registerToolWindow({
        id: "project",
        title: "Project",
        icon: "folder",
        anchor: "left",
        requiresProject: false,
        component: () => <div>tree</div>,
      }),
      registerToolWindow({
        id: "structure",
        title: "Structure",
        icon: "structure",
        anchor: "left",
        secondary: true,
        requiresProject: false,
        component: () => <div>members</div>,
      }),
    ];
    loadToolWindowLayout("/split");
    const { container, unmount } = render(<ToolWindowLayout editor={<div>editor</div>} />);
    const splitter = container.querySelector('[data-split-handle="left"]')!;
    const grow = (slot: string) => container.querySelector<HTMLElement>(`[data-slot="${slot}"]`)!.style.flexGrow;
    expect(splitter).toHaveAttribute("hidden");
    act(() => showToolWindow("project"));
    // Alone, the area fills its side whatever the stored ratio.
    expect(grow("left")).toBe("1");
    act(() => showToolWindow("structure"));
    expect(Number(grow("left")) + Number(grow("left-split"))).toBeCloseTo(1);
    expect(screen.getByText("tree")).toBeVisible();
    expect(screen.getByText("members")).toBeInTheDocument();
    expect(splitter).not.toHaveAttribute("hidden");
    expect(container.querySelector('[data-slot="left"]')!.nextElementSibling).toBe(splitter);
    expect(container.querySelector('[data-slot="left-split"]')).not.toHaveAttribute("hidden");
    unmount();
    disposers.forEach((d) => d());
  });
});

describe("workbench shell", () => {
  it("renders the welcome view without a project and the frame with one", async () => {
    const { useProject } = await import("@/platform/project");
    const { Workbench } = await import("./Workbench");
    const C = () => <div>project view</div>;
    const dispose = registerToolWindow({
      id: "project",
      title: "Project",
      icon: "folder",
      anchor: "left",
      component: C,
    });
    useProject.setState({ project: null });
    const { unmount } = render(<Workbench />);
    expect(screen.getByRole("button", { name: /Open/ })).toBeInTheDocument();
    act(() =>
      useProject.setState({
        project: { root: "/shell", name: "shell-demo", trusted: true, isGit: false, settings: {} },
      }),
    );
    loadToolWindowLayout("/shell");
    expect(await screen.findByText("shell-demo")).toBeInTheDocument();
    expect(screen.getByText("project view")).toBeInTheDocument();
    expect(screen.getByText("Search Everywhere", { selector: "dt, dt *" })).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe("light");
    unmount();
    dispose();
    useProject.setState({ project: null });
  });
});

describe("Don't Show Again", () => {
  it("is offered for non-error notifications of groups still shown as balloons", async () => {
    const { useProject } = await import("@/platform/project");
    const base = { id: 1, time: 0, read: false, balloon: true, sticky: false, logged: true, title: "x" } as const;
    const own = [{ label: "Open", run: () => {} }];
    expect(notificationActions({ ...base, level: "info", group: "vcs", actions: own }).map((a) => a.label)).toEqual([
      "Open",
      "Don't Show Again",
    ]);
    expect(notificationActions({ ...base, level: "error", group: "vcs" })).toEqual([]);
    useProject.setState({ settings: { notifications: { groups: { vcs: { display: "none" } } } } as never });
    try {
      expect(canSuppress({ level: "warning", group: "vcs" })).toBe(false);
      expect(canSuppress({ level: "warning", group: "run" })).toBe(true);
    } finally {
      useProject.setState({ settings: null });
    }
  });
});
