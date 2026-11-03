/**
 * M-2296 quality rule 2: the real Claude Code binary under test (CLAUDE_BIN), launched as AgEnD launches its agents
 * (--dangerously-skip-permissions), idle / busy / just resumed — each time AgEnD's own TmuxManager and Daemon find no
 * blocking dialog (the new file-send detector included), paste a delivery and press its Enter, and the mock API
 * receives the message. Private tmux socket, scratch HOME, synthetic API; no account, fleet or live pane.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pino from "pino";
import { openRig, scrub } from "./rig.mts";
import { TmuxManager } from "../../../src/tmux-manager.js";
import { Daemon } from "../../../src/daemon.js";
import { ClaudeCodeBackend } from "../../../src/backend/claude-code.js";
import { DEFAULT_INSTANCE_CONFIG } from "../../../src/config.js";

const output = resolve(process.argv[2] ?? ".artifacts/cc2317-deliveries");
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
// The mock answers "slow" prompts after 8 s (the CLI is busy meanwhile), everything else at once.
const rig = await openRig(output, prompt => ({ kind: "text", text: `ack: ${prompt.slice(0, 40)}`, delayMs: /SLOW/.test(prompt) ? 8000 : 0 }));
process.env.AGEND_HOME = join(rig.home, "agend");
TmuxManager.setSocketName(rig.socket);
const backend = new ClaudeCodeBackend(join(rig.home, "agend", "instances", "proof"));
const dialogs = backend.getRuntimeDialogs!();
const matching = (pane: string) => dialogs.filter(d => { d.pattern.lastIndex = 0; return d.isActive ? d.isActive(pane) : d.pattern.test(pane); }).map(d => d.description);
const cases: Array<Record<string, unknown>> = [];
let receipt: Record<string, unknown> | undefined;
try {
  await TmuxManager.ensureSession("proof");
  let pane = new TmuxManager("proof", "", { columns: 120, rows: 40 });
  const open = async (args: string[], label: string) => {
    pane = new TmuxManager("proof", "", { columns: 120, rows: 40 });
    await pane.createWindow(rig.runnerCommand(args), rig.cwd, label);
    const end = performance.now() + 60_000;
    while (performance.now() < end) { if (backend.readInputRow(await pane.capturePane()) !== null) return; await sleep(250); }
    writeFileSync(join(output, `failure-${label}.pane.txt`), scrub(await pane.capturePane(), rig)); throw Error(`no composer: ${label}`);
  };
  const daemon = () => {
    const d = new Daemon("proof", { ...DEFAULT_INSTANCE_CONFIG, backend: "claude-code", working_directory: rig.cwd, log_level: "silent" } as never, join(rig.home, "agend", "instances", "proof"), true, backend, undefined, pino({ level: "silent" }));
    (d as unknown as { tmux: TmuxManager }).tmux = pane;
    return d;
  };
  const deliver = async (label: string, text: string, busy: boolean) => {
    const before = await pane.capturePane();
    assert.deepEqual(matching(before), [], `${label}: no runtime dialog on an ordinary screen`);
    const d = daemon() as unknown as { probeBlockingDialog(): Promise<{ state: string }>; sendDeliveryEnter(phase: string): Promise<boolean> };
    assert.equal((await d.probeBlockingDialog()).state, "clear", `${label}: blocking-dialog probe is clear`);
    assert.equal(await pane.pasteBuffer(text), true, `${label}: paste`);
    await sleep(400);
    assert.equal(await d.sendDeliveryEnter("initial-submit"), true, `${label}: delivery Enter sent`);
    const end = performance.now() + (busy ? 45_000 : 20_000);
    while (performance.now() < end && !rig.prompts.some(p => p.includes(text))) await sleep(250);
    assert(rig.prompts.some(p => p.includes(text)), `${label}: the API received the delivered message`);
    writeFileSync(join(output, `${label}.pane.txt`), scrub(before, rig));
    cases.push({ label, dialogsOnScreen: 0, probe: "clear", enterSent: true, receivedByApi: true });
  };
  // 1. idle
  await open(["--dangerously-skip-permissions"], "idle");
  await deliver("idle", "[from:proof] idle delivery ALPHA", false);
  // 2. busy: a slow turn is in flight, and the delivery is queued by the CLI and sent after it
  const end1 = performance.now() + 20_000;
  while (performance.now() < end1 && !/ack: \[from:proof\] idle delivery ALPHA/.test(await pane.capturePane())) await sleep(250);
  assert.equal(await pane.pasteBuffer("[from:proof] SLOW turn BRAVO"), true);
  await sleep(400);
  assert.equal(await (daemon() as unknown as { sendDeliveryEnter(p: string): Promise<boolean> }).sendDeliveryEnter("initial-submit"), true);
  const end2 = performance.now() + 20_000;
  while (performance.now() < end2 && !rig.prompts.some(p => p.includes("BRAVO"))) await sleep(200);
  await sleep(1500);   // the turn is now busy for ~8 s
  const busyPane = await pane.capturePane();
  assert(!/ack: \[from:proof\] SLOW turn BRAVO/.test(busyPane), "the slow turn is still in flight");
  await deliver("busy", "[from:proof] busy delivery CHARLIE", true);
  // 3. just resumed: the CLI exits and AgEnD's resume flag reopens the same conversation
  await sleep(2000);
  await pane.killWindow();
  await sleep(1000);
  await open(["--dangerously-skip-permissions", "--continue"], "resumed");
  await deliver("resumed", "[from:proof] resumed delivery DELTA", false);
  receipt = {
    sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    version: execFileSync(process.env.CLAUDE_BIN!, ["--version"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: rig.home, DISABLE_AUTOUPDATER: "1" } }).trim(),
    privateSocket: rig.socket, localMock: true, realAccount: false, mode: "--dangerously-skip-permissions", cases,
  };
} finally { await rig.close(); }
if (receipt) {
  writeFileSync(join(output, "receipt.json"), JSON.stringify({ ...receipt, passed: true, ownedChildrenExited: true }, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
}
