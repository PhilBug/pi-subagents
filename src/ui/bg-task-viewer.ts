/**
 * bg-task-viewer.ts — overlay for one `bg_run` task opened from the fleet list.
 *
 * Shows the task's full command, where it runs and how it stands, above a live
 * tail of its output. Data comes from pi-background-tasks through BgTasksClient;
 * the output is polled once a second while the task runs, as that API asks.
 */

import { type Component, matchesKey, stripTerminalSequences, type TUI, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { BgTask, BgTaskLogs } from "../bg-tasks.js";
import type { Theme } from "./agent-widget.js";
import { formatBgTaskState, formatFleetElapsed } from "./fleet-list.js";
import { createViewerKeys, type ViewerKeybindings } from "./viewer-keys.js";

const POLL_MS = 1000;
/** Share of the screen the command may take before it is cut with "…". */
const MAX_COMMAND_SHARE = 0.4;

export interface BgTaskSource {
  detail(taskId: string): Promise<BgTask>;
  logs(taskId: string): Promise<BgTaskLogs>;
}

export class BgTaskViewer implements Component {
  private logs: BgTaskLogs | undefined;
  private error: string | undefined;
  private scrollTop = 0;
  private follow = true;
  private viewportHeight = 1;
  private maxScroll = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private readonly fullscreen: boolean;
  private readonly keys;

  constructor(
    private tui: Pick<TUI, "requestRender" | "terminal"> & { mode?: string },
    private source: BgTaskSource,
    private task: BgTask,
    private theme: Theme,
    private done: () => void,
    keybindings?: ViewerKeybindings,
  ) {
    this.fullscreen = tui.mode === "fullscreen";
    this.keys = createViewerKeys(keybindings);
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  private async poll(): Promise<void> {
    const wasRunning = this.task.status === "running";
    try {
      const [task, logs] = await Promise.all([this.source.detail(this.task.id), this.source.logs(this.task.id)]);
      if (this.closed) return;
      this.task = task;
      this.logs = logs;
      this.error = undefined;
    } catch (error) {
      if (this.closed) return;
      this.error = error instanceof Error ? error.message : String(error);
    }
    // One last read after the task settles picks up its final output.
    if (!wasRunning && this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.tui.requestRender();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.done();
  }

  dispose(): void {
    this.closed = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) { this.close(); return; }
    if (this.keys.scrollUp(data)) this.scrollBy(-1);
    else if (this.keys.scrollDown(data)) this.scrollBy(1);
    else if (this.keys.pageUp(data)) this.scrollBy(-this.viewportHeight);
    else if (this.keys.pageDown(data)) this.scrollBy(this.viewportHeight);
    else if (matchesKey(data, "home")) { this.follow = false; this.scrollTop = 0; }
    else if (matchesKey(data, "end")) { this.follow = true; }
    else return;
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
    if (!this.fullscreen) return { handled: false };
    // The viewer covers the screen: nothing may fall through to the transcript.
    if (event.type === "wheel") {
      this.scrollBy(event.wheelDelta ?? 0);
      return { handled: true, render: true };
    }
    return { handled: true, render: false };
  }

  private scrollBy(lines: number): void {
    this.scrollTop = Math.max(0, Math.min(this.maxScroll, this.scrollTop + lines));
    this.follow = this.scrollTop >= this.maxScroll;
  }

  render(width: number): string[] {
    const th = this.theme;
    const rows = Math.max(6, this.fullscreen ? this.tui.terminal.rows : Math.floor(this.tui.terminal.rows * 0.7));
    const innerW = Math.max(10, this.fullscreen ? width - 2 : width - 4);
    const row = (content: string) => this.fullscreen
      ? " " + truncateToWidth(content, innerW, "…", true)
      : th.fg("border", "│") + " " + pad(truncateToWidth(content, innerW, "…", true), innerW) + " " + th.fg("border", "│");
    const divider = row(th.fg("dim", "─".repeat(innerW)));

    const header: string[] = [];
    if (!this.fullscreen) header.push(th.fg("border", `╭${"─".repeat(Math.max(0, width - 2))}╮`));
    const t = this.task;
    const icon = t.status === "running" ? th.fg("accent", "●")
      : t.status === "completed" ? th.fg("success", "✓")
      : t.status === "failed" ? th.fg("error", "✗")
      : th.fg("dim", "○");
    const stats = `${formatFleetElapsed((t.endTime ?? Date.now()) - t.startTime)} · ${formatBgTaskState(t)}`;
    header.push(row(`${icon} ${th.fg("muted", "bg")}  ${t.name ?? t.id} ${th.fg("dim", `· ${stats}`)}`));
    if (t.description) header.push(row(th.fg("dim", t.description)));
    header.push(divider);

    // The command, wrapped in full unless it would crowd out the output.
    const commandLines = t.command.split("\n").flatMap((line, i) =>
      wrapTextWithAnsi(`${i === 0 ? "$ " : "  "}${stripTerminalSequences(line)}`, innerW));
    const maxCommand = Math.max(1, Math.floor(rows * MAX_COMMAND_SHARE));
    const shownCommand = commandLines.length > maxCommand
      ? [...commandLines.slice(0, maxCommand - 1), th.fg("dim", `… ${commandLines.length - maxCommand + 1} more lines`)]
      : commandLines;
    for (const line of shownCommand) header.push(row(th.fg("accent", line)));
    const where = [`cwd ${t.cwd}`, t.pid !== undefined ? `pid ${t.pid}` : "", `id ${t.id}`].filter(Boolean).join(" · ");
    header.push(row(th.fg("dim", where)));
    if (t.error) header.push(row(th.fg("error", stripTerminalSequences(t.error))));
    header.push(divider);

    // Output tail. Task output is untrusted: escapes are stripped, not rendered.
    const output: string[] = [];
    if (this.error) output.push(th.fg("error", this.error));
    if (this.logs?.truncated) output.push(th.fg("dim", `… earlier output omitted (${this.logs.totalBytes} bytes total)`));
    const text = this.logs?.text ?? "";
    if (this.logs && text.length === 0) output.push(th.fg("dim", "(no output yet)"));
    for (const line of stripTerminalSequences(text).replace(/\n$/, "").split("\n")) {
      if (text.length > 0) output.push(...wrapTextWithAnsi(line, innerW));
    }

    const footer = [divider];
    const left = th.fg("dim", `${output.length} lines`);
    const right = th.fg("dim", "↑↓ scroll · PgUp/PgDn · End follow · Esc close");
    footer.push(row(left + " ".repeat(Math.max(1, innerW - visibleWidth(left) - visibleWidth(right))) + right));
    if (!this.fullscreen) footer.push(th.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`));

    this.viewportHeight = Math.max(1, rows - header.length - footer.length);
    this.maxScroll = Math.max(0, output.length - this.viewportHeight);
    if (this.follow) this.scrollTop = this.maxScroll;
    this.scrollTop = Math.min(this.scrollTop, this.maxScroll);
    const body = output.slice(this.scrollTop, this.scrollTop + this.viewportHeight);
    while (body.length < this.viewportHeight) body.push("");
    return [...header, ...body.map(row), ...footer];
  }
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}
