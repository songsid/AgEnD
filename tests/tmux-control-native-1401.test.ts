/** Private-socket protocol parity only. No fleet or backend CLI. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const fixture = vi.hoisted(() => ({ socket: `agend-test-query-native-${process.pid}`, session: `query-${process.pid} '$HOME; literal` }));
vi.mock("../src/paths.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/paths.js")>(), getTmuxSocketName: () => fixture.socket,
}));
import { TmuxControlClient } from "../src/tmux-control.js";
import { TmuxManager } from "../src/tmux-manager.js";
const exec = promisify(execFile);
const native = (args: string[]) => exec("tmux", ["-L", fixture.socket, ...args], { timeout: 3_000 });
let client: TmuxControlClient;
let manager: TmuxManager;

beforeAll(async () => {
  await native(["new-session", "-d", "-s", fixture.session, "-x", "120", "-y", "12",
    "printf '%s\\n' 'fixture 中文 😀' '%output %9 pane-text' '%end 123 456 1' 'back\\slash'; sleep 30"]);
  TmuxManager.setSocketName(fixture.socket);
  const { stdout } = await native(["list-windows", "-t", fixture.session, "-F", "#{window_id}"]);
  const window = stdout.trim();
  client = new TmuxControlClient(fixture.session); client.start();
  const deadline = performance.now() + 3_000;
  while (!(client as any).attachment?.ready) {
    if (performance.now() >= deadline) throw new Error("private control attach timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await client.registerWindow(window);
  manager = new TmuxManager(fixture.session, window, undefined, client);
});
afterAll(async () => {
  client?.stop();
  await native(["kill-server"]).catch(() => {}); // only this uniquely named private socket
  TmuxManager.setSocketName(null);
});

describe("#1401 native control protocol on an owned private tmux server", () => {
  it("captures bytes identical to execFile, including guards, UTF8, escapes and LF", async () => {
    const expected = (await native(["capture-pane", "-p", "-t", `${fixture.session}:${manager.getWindowId()}`])).stdout;
    expect(expected).toContain("fixture 中文 😀");
    expect(expected).toContain("%output %9 pane-text");
    expect(await manager.capturePane()).toBe(expected);
    const history = (await native(["capture-pane", "-t", `${fixture.session}:${manager.getWindowId()}`, "-p", "-S", "-50"])).stdout;
    expect(await manager.capturePaneWithHistory(50)).toBe(history);
    const joined = (await native(["capture-pane", "-t", `${fixture.session}:${manager.getWindowId()}`, "-p", "-J", "-S", "-50"])).stdout;
    expect(await manager.capturePaneJoined(50)).toBe(joined);
  });

  it("matches window/pane reads and isolates a command failure without retiring", async () => {
    expect(await manager.isWindowAlive()).toBe(true);
    expect(await manager.getPaneStatus()).toEqual({ alive: true });
    const owner = (client as any).attachment;
    await expect(client.read({ kind: "capture", session: fixture.session, window: "@999999" })).rejects.toMatchObject({ kind: "command" });
    expect((client as any).attachment).toBe(owner);
    expect(owner.retired).toBe(false);
    expect(await manager.isWindowAlive()).toBe(true);
  });
});
