/** Structural transport parity, on one private server. No backend CLI or fleet. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const fixture = vi.hoisted(() => ({ socket: `agend-test-pane-port-${process.pid}`, session: `pane-port-${process.pid}` }));
vi.mock("../src/paths.js", async original => ({
  ...await original<typeof import("../src/paths.js")>(), getTmuxSocketName: () => fixture.socket,
}));
import { TmuxManager } from "../src/tmux-manager.js";
import { TmuxControlClient } from "../src/tmux-control.js";
import { TmuxPaneHost } from "../src/tmux-pane-host.js";
import type { Pane, PaneObservation } from "../src/pane-port.js";

const exec = promisify(execFile);
const native = (args: string[]) => exec("tmux", ["-L", fixture.socket, ...args], { timeout: 5_000 });
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const host = new TmuxPaneHost();
const root = mkdtempSync(join(tmpdir(), "agend-pane-port-"));
const script = join(root, "terminal.mjs");
let observation: TmuxControlClient;
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 5_000;
  while (!await check()) {
    if (performance.now() >= deadline) throw new Error("private pane did not reach its asserted state");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
beforeAll(async () => {
  writeFileSync(script, `import fs from 'node:fs';
process.stdin.setRawMode(true);
process.stdout.write('\\x1b[?2004h');
for(let i=0;i<30;i++) process.stdout.write('line '+i+' 中文 😀 %output %9 pane-text\\r\\n');
process.stdout.write('READY\\r\\n');
fs.writeFileSync(process.argv[2], '');
process.stdin.on('data', b=>{ fs.appendFileSync(process.argv[2], b); process.stdout.write('BYTES '+b.length+'\\r\\n'); });
`);
  TmuxManager.setSocketName(fixture.socket);
  await host.ensureSession(fixture.session);
  observation = new TmuxControlClient(fixture.session, 60);
  observation.start();
});
afterAll(async () => {
  observation?.stop();
  await native(["kill-server"]).catch(() => {});
  TmuxManager.setSocketName(null);
  rmSync(root, { recursive: true, force: true });
});

describe.each(["direct", "port"] as const)("#2950 native %s pane", construction => {
  let pane: Pane;
  const input = join(root, `${construction}.input`);
  const make = (id: string, obs?: PaneObservation): Pane => construction === "port"
    ? host.bind(fixture.session, id, { columns: 100, rows: 16 }, obs)
    : new TmuxManager(fixture.session, id, { columns: 100, rows: 16 }, obs as TmuxControlClient | undefined);
  it("preserves fresh handle identity and exact viewport, history and joined bytes", async () => {
    pane = make("");
    const id = await pane.createWindow(`${quote(process.execPath)} ${quote(script)} ${quote(input)}`, root, `port-${construction}`);
    await until(async () => (await pane.capturePane()).includes("READY"));
    const rebound = make(id);
    expect(rebound).not.toBe(pane);
    expect(rebound).toBeInstanceOf(TmuxManager);
    for (const [capture, args] of [
      [() => pane.capturePane(), []],
      [() => pane.capturePaneWithHistory(50), ["-S", "-50"]],
      [() => pane.capturePaneJoined(50), ["-J", "-S", "-50"]],
    ] as const) {
      const expected = (await native(["capture-pane", "-t", `${fixture.session}:${id}`, "-p", ...args])).stdout;
      expect(await capture()).toBe(expected);
      expect(expected).toContain("中文 😀 %output %9 pane-text");
    }
    expect(await pane.getWindowGeometry()).toMatchObject({ columns: 100, rows: 16 });
  });
  it("keeps bracketed literal paste, guard rejection and Enter separate", async () => {
    expect(await pane.getPaneInputMode()).toBe("raw");
    expect(await pane.pasteBuffer("must-not-arrive", { guard: () => false })).toBe(false);
    expect(readFileSync(input, "utf8")).toBe("");
    const text = "中文 'literal' $HOME\nsecond line";
    expect(await pane.pasteBuffer(text)).toBe(true);
    // tmux paste-buffer preserves its existing LF-to-CR terminal translation.
    const terminalText = text.replace(/\n/g, "\r");
    await until(() => readFileSync(input, "utf8").includes(terminalText));
    expect(readFileSync(input, "utf8")).toBe(`\x1b[200~${terminalText}\x1b[201~`);
    expect(await pane.sendSpecialKey("Enter")).toBe(true);
    await until(() => readFileSync(input, "utf8").endsWith("\r"));
  });
  it("preserves observation reads and positively confirmed retirement", async () => {
    const id = pane.getWindowId();
    await observation.registerWindow(id);
    const rebound = make(id, observation);
    expect(await rebound.capturePane()).toBe(await pane.capturePane());
    expect(await host.listWindowsStrict(fixture.session, observation)).toContainEqual({ id, name: `port-${construction}` });
    const output = new Promise<void>(resolve => observation.once(`output:${id}`, () => resolve()));
    expect(await pane.sendKeys("x")).toBe(true);
    await output;
    expect(observation.getLastOutputAt(id)).toBeGreaterThan(0);
    await until(() => observation.isIdle(id));
    expect(await observation.waitUntilIdle(id, 100)).toBe(true);
    expect(await pane.getPaneStatus()).toMatchObject({ alive: true, pid: expect.any(Number) });
    expect(await pane.killWindowConfirmed()).toBe(true);
    observation.unregisterWindow(id);
    expect(await rebound.isWindowAlive()).toBe(false);
  });
});

it("does not let a missing or empty target resolve to the active pane", async () => {
  expect(await host.getPanePid(fixture.session, "")).toBe(null);
  expect(await host.bind(fixture.session, "@999999").isWindowAlive()).toBe(false);
  expect(await host.sessionExistsStrict(fixture.session)).toBe(true);
  expect(await host.listWindowsStrict(fixture.session)).not.toHaveLength(0);
});
