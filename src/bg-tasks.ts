/**
 * bg-tasks.ts — read-only client for pi-background-tasks' host EventBus API v1.
 *
 * Lets the fleet list show `bg_run` tasks next to subagents and open their
 * command and output. The other extension is optional: when it is absent or not
 * yet initialized, the task list simply stays empty.
 *
 * Protocol (pi-background-tasks docs/api/eventbus-host-v1.md): `subscribe` grants
 * a lease scoped to one activation of that extension; every later request carries
 * `{leaseId, activationId, sequence}` with a strictly increasing sequence. Change
 * frames are invalidations only — the client re-lists on each one.
 */

import type { EventBus } from "./cross-extension-rpc.js";

const REQUEST_CHANNEL = "pi-background-tasks:host:request:v1";
const RESPONSE_CHANNEL = "pi-background-tasks:host:response:v1";
const CHANGED_CHANNEL = "pi-background-tasks:host:changed:v1";
const REQUEST_SCHEMA = "pi-background-tasks.host-request.v1";
const REQUEST_TIMEOUT_MS = 5000;

export type BgTaskStatus = "running" | "completed" | "failed" | "killed";

/** The task fields the fleet list and viewer use, as the host API reports them. */
export interface BgTask {
  id: string;
  name?: string;
  command: string;
  description?: string;
  status: BgTaskStatus;
  cwd: string;
  startTime: number;
  endTime?: number;
  exitCode?: number | null;
  signal?: string | null;
  pid?: number;
  error?: string;
}

export interface BgTaskLogs {
  text: string;
  /** True when older output exists before `text`. */
  truncated: boolean;
  totalBytes: number;
}

interface Lease {
  leaseId: string;
  activationId: string;
  sequence: number;
}

type Pending = { resolve: (result: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class BgTasksClient {
  private lease: Lease | undefined;
  private cached: BgTask[] = [];
  private pending = new Map<string, Pending>();
  private requestCounter = 0;
  private unsubs: (() => void)[] = [];
  private refreshing: Promise<void> | undefined;
  private connecting: Promise<void> | undefined;
  private refreshAgain = false;
  private closed = false;

  constructor(
    private events: EventBus,
    /** Called after the cached task list changes. */
    private onChange: () => void,
    private clientId = `pi-subagents-fleet-${process.pid}`,
  ) {}

  start(): void {
    this.unsubs.push(this.events.on(RESPONSE_CHANNEL, data => this.handleResponse(data)));
    this.unsubs.push(this.events.on(CHANGED_CHANNEL, data => this.handleChanged(data)));
    void this.connect();
  }

  dispose(): void {
    this.closed = true;
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    const lease = this.lease;
    this.lease = undefined;
    if (lease) this.send("unsubscribe", this.leased(lease, {})).catch(() => {});
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("closed")); }
    this.pending.clear();
    this.cached = [];
  }

  /** Last listed tasks, newest first. */
  tasks(): readonly BgTask[] {
    return this.cached;
  }

  /** The full task (list previews cut `command` at 512 characters). */
  async detail(taskId: string): Promise<BgTask> {
    const result = await this.leasedRequest("detail", { taskId });
    return toTask(result.task.task);
  }

  async logs(taskId: string, maxBytes = 32768): Promise<BgTaskLogs> {
    const result = await this.leasedRequest("logs", { taskId, maxBytes, tail: true });
    return { text: String(result.text ?? ""), truncated: result.windowStart > 0, totalBytes: Number(result.totalBytes ?? 0) };
  }

  // ---- Protocol ----

  private connect(): Promise<void> {
    this.connecting ??= (async () => {
      try {
        const result = await this.send("subscribe", { clientId: this.clientId });
        if (this.closed) return;
        // A repeated subscribe in the same activation returns the same lease, whose
        // sequence must keep rising.
        if (this.lease?.leaseId !== result.leaseId) {
          this.lease = { leaseId: result.leaseId, activationId: result.activationId, sequence: 0 };
        }
        this.refresh();
      } catch {
        // Absent, or not initialized yet: its `ready` frame will bring us back.
      }
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private handleChanged(data: unknown): void {
    if (this.closed || !isRecord(data)) return;
    const activationId = data.activationId;
    if (data.kind === "closed") {
      if (this.lease?.activationId === activationId) {
        this.lease = undefined;
        this.setTasks([]);
      }
      return;
    }
    if (this.lease === undefined || this.lease.activationId !== activationId) {
      this.lease = undefined;
      void this.connect();
      return;
    }
    this.refresh();
  }

  /** Re-list; overlapping triggers collapse into one follow-up list. */
  private refresh(): void {
    if (this.refreshing) { this.refreshAgain = true; return; }
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false;
        try {
          const result = await this.leasedRequest("list", { limit: 50 });
          this.setTasks((result.tasks as any[]).map(view => toTask(view.task)));
        } catch {
          // Keep the last good list; the next change frame retries.
        }
      } while (this.refreshAgain && !this.closed);
    })().finally(() => { this.refreshing = undefined; });
  }

  private setTasks(tasks: BgTask[]): void {
    this.cached = tasks;
    this.onChange();
  }

  private leasedRequest(operation: string, payload: Record<string, unknown>): Promise<any> {
    const lease = this.lease;
    if (!lease) return Promise.reject(new Error("pi-background-tasks is not available"));
    return this.send(operation, this.leased(lease, payload));
  }

  private leased(lease: Lease, payload: Record<string, unknown>): Record<string, unknown> {
    lease.sequence += 1;
    return { ...payload, leaseId: lease.leaseId, activationId: lease.activationId, sequence: lease.sequence };
  }

  private send(operation: string, payload: Record<string, unknown>): Promise<any> {
    const requestId = `${this.clientId}:${++this.requestCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${operation} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      this.events.emit(REQUEST_CHANNEL, { schema_version: REQUEST_SCHEMA, request_id: requestId, operation, payload });
    });
  }

  private handleResponse(data: unknown): void {
    if (!isRecord(data) || typeof data.request_id !== "string") return;
    const pending = this.pending.get(data.request_id);
    if (!pending) return;
    this.pending.delete(data.request_id);
    clearTimeout(pending.timer);
    if (data.ok === true) {
      pending.resolve(data.result);
      return;
    }
    const error = isRecord(data.error) ? data.error : {};
    if (error.code === "LEASE_INVALID" || error.code === "ACTIVATION_MISMATCH") {
      this.lease = undefined;
      if (!this.closed) void this.connect();
    }
    pending.reject(new Error(`${String(error.code ?? "ERROR")}: ${String(error.message ?? "")}`));
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toTask(raw: any): BgTask {
  return {
    id: String(raw.id),
    name: raw.name,
    command: String(raw.command ?? ""),
    description: raw.description,
    status: raw.status,
    cwd: String(raw.cwd ?? ""),
    startTime: Number(raw.startTime),
    endTime: raw.endTime,
    exitCode: raw.exitCode,
    signal: raw.signal,
    pid: raw.pid,
    error: raw.error,
  };
}
