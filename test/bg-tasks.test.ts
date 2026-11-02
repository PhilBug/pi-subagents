import { describe, expect, it, vi } from "vitest";
import { type BgTask, BgTasksClient } from "../src/bg-tasks.js";
import { BgTaskViewer } from "../src/ui/bg-task-viewer.js";

type Handler = (data: unknown) => void;

/** In-memory EventBus with a scripted pi-background-tasks host on the request channel. */
function fakeHost(opts: { available?: boolean } = {}) {
  const handlers = new Map<string, Set<Handler>>();
  const events = {
    on(channel: string, h: Handler) {
      if (!handlers.has(channel)) handlers.set(channel, new Set());
      handlers.get(channel)!.add(h);
      return () => handlers.get(channel)!.delete(h);
    },
    emit(channel: string, data: unknown) {
      for (const h of handlers.get(channel) ?? []) h(data);
    },
  };
  const state = { available: opts.available ?? true, tasks: [] as Partial<BgTask>[], sequences: [] as number[] };
  events.on("pi-background-tasks:host:request:v1", (raw: any) => {
    const reply = (body: Record<string, unknown>) => queueMicrotask(() =>
      events.emit("pi-background-tasks:host:response:v1", { request_id: raw.request_id, operation: raw.operation, ...body }));
    if (!state.available) { reply({ ok: false, error: { code: "UNAVAILABLE", message: "not ready" } }); return; }
    if (raw.payload.sequence !== undefined) state.sequences.push(raw.payload.sequence);
    if (raw.operation === "subscribe") reply({ ok: true, result: { leaseId: "L1", activationId: "A1" } });
    else if (raw.operation === "list") reply({ ok: true, result: { tasks: state.tasks.map(task => ({ task })) } });
    else reply({ ok: true, result: {} });
  });
  const changed = (kind: string) => events.emit("pi-background-tasks:host:changed:v1", { kind, activationId: "A1" });
  return { events, state, changed };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe("BgTasksClient", () => {
  it("lists tasks after subscribing and re-lists on every change frame", async () => {
    const host = fakeHost();
    host.state.tasks = [{ id: "t1", command: "sleep 5", status: "running", startTime: 1 }];
    const onChange = vi.fn();
    const client = new BgTasksClient(host.events, onChange, "test");
    client.start();
    await flush();
    expect(client.tasks().map(t => t.command)).toEqual(["sleep 5"]);

    host.state.tasks = [{ id: "t1", command: "sleep 5", status: "completed", startTime: 1, endTime: 6, exitCode: 0 }];
    host.changed("changed");
    await flush();
    expect(client.tasks()[0].status).toBe("completed");
    expect(host.state.sequences).toEqual([1, 2]);
    client.dispose();
  });

  it("connects once pi-background-tasks announces it is ready", async () => {
    const host = fakeHost({ available: false });
    const client = new BgTasksClient(host.events, () => {}, "test");
    client.start();
    await flush();
    expect(client.tasks()).toEqual([]);

    host.state.available = true;
    host.state.tasks = [{ id: "t1", command: "make build", status: "running", startTime: 1 }];
    host.changed("ready");
    await flush();
    expect(client.tasks().map(t => t.id)).toEqual(["t1"]);
    client.dispose();
  });
});

describe("BgTaskViewer", () => {
  it("shows the full command and the output with escapes stripped", async () => {
    const task: BgTask = { id: "t1", name: "build", command: "make build", status: "running", cwd: "/repo", startTime: Date.now(), pid: 42 };
    const source = {
      detail: async () => task,
      logs: async () => ({ text: "\x1b[31mcompiling\x1b[0m\ndone\n", truncated: false, totalBytes: 20 }),
    };
    const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
    const tui = { mode: "fullscreen", requestRender: () => {}, terminal: { rows: 20, columns: 80 } } as any;
    const viewer = new BgTaskViewer(tui, source, task, theme as any, () => {});
    await flush();
    const lines = viewer.render(80);
    viewer.dispose();
    expect(lines.some(l => l.includes("$ make build"))).toBe(true);
    expect(lines.some(l => l.includes("cwd /repo · pid 42"))).toBe(true);
    expect(lines.some(l => l.trim() === "compiling")).toBe(true);
    expect(lines.join("\n")).not.toContain("\x1b[31m");
  });
});
