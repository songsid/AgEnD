import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "agend-pane-port-daemon-")); directories.push(directory);
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const next = { getWindowId: () => "pane-1" };
  const host = { listWindows: vi.fn(async () => [{ id: "pane-1", name: "agent" }]), bind: vi.fn(() => next) };
  const daemon = new Daemon("agent", { working_directory: directory } as any, directory,
    false, undefined, undefined, { child: () => logger } as any, undefined, undefined, undefined, undefined, host as any) as any;
  daemon.tmux = { getWindowId: () => "pane-1" };
  daemon.bindInstanceStateOutputListener = vi.fn();
  return { daemon, host, next };
}
it("uses the injected host and replaces the handle even when recovery keeps the same pane id", async () => {
  const { daemon, host, next } = setup();
  const previous = daemon.tmux;
  expect(await daemon.recoverWindow()).toBe("pane-1");
  expect(host.bind).toHaveBeenCalledOnce();
  expect(daemon.tmux).toBe(next);
  expect(daemon.tmux).not.toBe(previous);
});
it("a late recovery read cannot replace a newer handle with the same id", async () => {
  const { daemon, host } = setup();
  let release!: (value: Array<{ id: string; name: string }>) => void;
  host.listWindows.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const recovery = daemon.recoverWindow();
  const replacement = { getWindowId: () => "pane-1" };
  daemon.tmux = replacement;
  release([{ id: "pane-1", name: "agent" }]);
  expect(await recovery).toBeUndefined();
  expect(host.bind).not.toHaveBeenCalled();
  expect(daemon.tmux).toBe(replacement);
});
