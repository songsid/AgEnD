/**
 * M-2267 acceptance (leader xmsg-1793679613589): a REAL private tmux (the isolated socket), a real Daemon and its real
 * TmuxManager, a fake CLI in the pane (prints MOCK_READY, reads lines, answers each submitted line with RECEIVED). The
 * pane is put into copy-mode while a delivery is pending — as a person scrolling it from an attached client would:
 *  - before the paste: the text does not land, no key reaches the pane, the pane stays in copy-mode (never ended for the
 *    person); once the person leaves it, the message is pasted and submitted, once;
 *  - after the paste, before the Enter: the Enter is not swallowed by copy-mode — it waits, and goes once the mode ends.
 * Only the idle/dialog probes are stubbed (the fake CLI has no transcript); every pane write is real tmux.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { MockBackend } from "../src/backend/mock.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { readFileSync } from "node:fs";
import { TmuxManager } from "../src/tmux-manager.js";
import { tmuxBinary } from "../src/tmux-binary.js";

const roots: string[] = [];
let haveTmux = true;
// AgEnD's tmux (the binary TmuxManager runs), so the server this file starts and the reads it makes are one binary.
try { execFileSync(tmuxBinary(), ["-L", "agend-test-availability", "-V"], { stdio: "ignore" }); } catch { haveTmux = false; }
// Its own private socket: another file's real-tmux test ends its server with kill-server.
const socket = `agend-test-copy-mode-${process.pid}`;
TmuxManager.setSocketName(socket);                                           // this file's TmuxManagers: never the live server
const tmux = (...args: string[]) => execFileSync(tmuxBinary(), ["-L", socket, ...args], { encoding: "utf8" });
afterEach(() => {
  vi.restoreAllMocks();
  try { tmux("kill-server"); } catch { /* none */ }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as any;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => boolean, ms: number) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(100); } return fn(); }

function setup(opts: { afterPaste?: string; dialogs?: "claude" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agend-copy-mode-tmux-")); roots.push(root);
  const cli = join(root, "fake-cli.mjs");
  // M-2290: what the CLI paints the moment a paste lands (a card that "appears between the paste and the Enter").
  const after = join(root, "after-paste.txt");
  writeFileSync(after, opts.afterPaste ?? "");
  // As a real CLI does: bracketed paste on, raw input; a pasted text (newlines included) is the box's text, and only a
  // bare Enter outside a paste submits it.
  writeFileSync(cli, `import { readFileSync } from "node:fs";
process.stdin.setRawMode(true); process.stdin.resume();
process.stdout.write("\\x1b[?2004hMOCK_READY\\n");
let box = "", inPaste = false, buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString("utf8");
  for (;;) {
    if (inPaste) { const end = buf.indexOf("\\x1b[201~"); if (end < 0) { box += buf; buf = ""; break; } box += buf.slice(0, end); buf = buf.slice(end + 6); inPaste = false; const card = readFileSync(${JSON.stringify("__AFTER__")}, "utf8"); if (card) process.stdout.write("\\n" + card + "\\n"); continue; }
    const start = buf.indexOf("\\x1b[200~"), cr = buf.indexOf("\\r");
    if (start >= 0 && (cr < 0 || start < cr)) { box += buf.slice(0, start); buf = buf.slice(start + 6); inPaste = true; continue; }
    if (cr >= 0) { box += buf.slice(0, cr); buf = buf.slice(cr + 1); process.stdout.write("RECEIVED " + box.replace(/\\s+/g, " ").slice(-60) + "\\nMOCK_READY\\n"); box = ""; continue; }
    if (buf === "\\x03") process.exit(0);
    box += buf; buf = ""; break;
  }
});
`.replace("__AFTER__", after.replace(/\\/g, "\\\\")));
  TmuxManager.setSocketName(socket);
  tmux("new-session", "-d", "-s", "cmg", "-x", "160", "-y", "20", `node ${cli}; echo FAKE-CLI-EXITED $?; sleep 600`);
  const wid = tmux("list-windows", "-t", "cmg", "-F", "#{window_id}").trim();
  const instanceDir = join(root, "instances", "worker");
  mkdirSync(instanceDir, { recursive: true });
  writeFileSync(join(instanceDir, "window-id"), wid);
  const control = { getObservationResetAt: () => 0, getLastOutputAt: () => undefined, isIdle: () => true, hasOutputSince: () => true, waitUntilIdle: vi.fn(async () => true) };
  const daemon: any = new Daemon("worker", {
    working_directory: root, log_level: "error", backend: "mock",
    restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
    context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
  }, instanceDir, false, new MockBackend(instanceDir) as any, control as any, logger);
  // M-2290: the backend's own runtime dialogs — Claude Code's, for the card cases.
  if (opts.dialogs === "claude") {
    const claude = new ClaudeCodeBackend(instanceDir);
    (daemon.backend as any).getRuntimeDialogs = () => claude.getRuntimeDialogs();
  }
  const real = new TmuxManager("cmg", wid);
  const writes: string[] = [];
  // The real TmuxManager, every write recorded with whether the pane was in a mode at that moment.
  const inMode = () => tmux("display-message", "-p", "-t", "cmg", "#{pane_in_mode}").trim() === "1";
  const pasteBuffer = real.pasteBuffer.bind(real), sendSpecialKey = real.sendSpecialKey.bind(real);
  real.pasteBuffer = (async (text: string, opts?: any) => { writes.push(`paste${inMode() ? " IN MODE" : ""}`); return pasteBuffer(text, opts); }) as any;
  real.sendSpecialKey = (async (key: any, t?: number) => { writes.push(`${key}${inMode() ? " IN MODE" : ""}`); return sendSpecialKey(key, t); }) as any;
  daemon.tmux = real;
  vi.spyOn(daemon, "wake").mockResolvedValue(undefined);
  vi.spyOn(daemon, "waitForInputTransientToClear").mockResolvedValue(true);
  vi.spyOn(daemon, "waitForPaneIdleForDelivery").mockResolvedValue(true);
  vi.spyOn(daemon, "probeInputTransient").mockResolvedValue({ state: "none" });
  vi.spyOn(daemon, "probeBlockingDialog").mockResolvedValue({ state: "clear" });
  vi.spyOn(daemon, "isPaneReadyForDelivery").mockResolvedValue(true);
  const outbox = new DeliveryOutbox(join(root, "delivery-outbox.db"), "manager-test");
  daemon.setDeliveryOutboxPort(outbox);
  const send = (content: string) => {
    const row = outbox.admit({
      operationId: "op", sourceKey: "s:op:w:fleet_inbound", sourceInstance: "source", sourceDaemonBootId: "sb",
      targetInstance: "worker", kind: "fleet_inbound", payload: { type: "fleet_inbound", content, meta: {} },
    }).delivery;
    const claimed = outbox.claimNext("manager-test", () => daemon.bootId, new Set())!;
    daemon.pushChannelMessage(content, {
      delivery_id: row.deliveryId, delivery_attempt: String(claimed.attemptNo), from_instance: "source", correlation_id: "c",
      user: "instance:source", user_id: "instance:source", message_id: "xmsg-copy-mode", chat_id: "chat", thread_id: "", ts: new Date().toISOString(),
    });
    api.last = row.deliveryId;
    return row.deliveryId;
  };
  const screen = () => tmux("capture-pane", "-p", "-t", "cmg");
  const api: any = { daemon, outbox, send, screen, writes, inMode, last: "" };
  return api;
}

describe.skipIf(!haveTmux)("a real pane left in copy-mode while a delivery is pending", () => {
  it("before the paste: nothing lands and no key is sent while it lasts; once the person leaves it, pasted and submitted once", async () => {
    const t = setup();
    await until(() => /MOCK_READY/.test(t.screen()), 10_000);
    tmux("copy-mode", "-t", "cmg");                                            // the person scrolls up in tmux
    t.send("hello from the copy-mode acceptance");
    await sleep(4_000);
    expect(t.writes).toEqual([]);                                              // nothing written: no paste, no key
    expect(t.inMode()).toBe(true);                                             // and the mode is still the person's
    expect(t.screen()).not.toContain("copy-mode acceptance");                  // the text has not landed
    tmux("send-keys", "-t", "cmg", "-X", "cancel");                            // the person leaves copy-mode
    expect(await until(() => /RECEIVED .*xmsg-copy-mode/.test(t.screen()), 15_000)).toBe(true);
    expect(await until(() => t.outbox.get(t.last)?.state === "delivered", 10_000)).toBe(true);
    expect(t.writes.filter((w: string) => w.includes("IN MODE"))).toEqual([]);
    expect(t.writes.filter((w: string) => w.startsWith("paste"))).toHaveLength(1);
    expect(t.screen().match(/RECEIVED /g)).toHaveLength(1);
  }, 40_000);
  it("after the paste, before the Enter: the Enter is not swallowed — it waits for the mode to end, then goes once", async () => {
    const t = setup();
    await until(() => /MOCK_READY/.test(t.screen()), 10_000);
    const real = t.daemon.tmux, paste = real.pasteBuffer;
    real.pasteBuffer = async (text: string, opts?: any) => { const ok = await paste(text, opts); tmux("copy-mode", "-t", "cmg"); return ok; };
    t.send("hello again from the acceptance");
    await until(() => t.writes.some((w: string) => w.startsWith("paste")), 15_000);
    await sleep(4_000);
    expect(t.writes).toEqual(["paste"]);                                       // pasted; no Enter while in the mode
    expect(t.inMode()).toBe(true);
    expect(t.screen()).not.toContain("RECEIVED");
    tmux("send-keys", "-t", "cmg", "-X", "cancel");
    expect(await until(() => /RECEIVED .*xmsg-copy-mode/.test(t.screen()), 15_000)).toBe(true);
    expect(await until(() => t.outbox.get(t.last)?.state === "delivered", 10_000)).toBe(true);
    expect(t.writes.filter((w: string) => w.includes("IN MODE"))).toEqual([]);
    expect(t.screen().match(/RECEIVED /g)).toHaveLength(1);
  }, 40_000);
});

describe.skipIf(!haveTmux)("M-2290: a dialog that paints between the paste and the delivery's Enter", () => {
  // A real Claude Code 2.1.316 dangerous-command card (tests/fixtures), the bottom of it as it paints.
  const CARD = readFileSync(join(process.cwd(), "tests/fixtures/claude-2.1.316-danger-enter-swallowed.pane.txt"), "utf8")
    .split("\n").filter(l => l.trim()).slice(-12).join("\n");
  it("a dialog the backend recognises: the Enter is withheld (it would answer the card), the delivery is uncertain → Needs-you", async () => {
    const t = setup({ afterPaste: CARD, dialogs: "claude" });
    await until(() => /MOCK_READY/.test(t.screen()), 10_000);
    t.send("hello while a card paints");
    expect(await until(() => t.outbox.get(t.last)?.state === "uncertain", 15_000)).toBe(true);
    await sleep(1_000);
    expect(t.writes).toEqual(["paste"]);                                       // pasted — and no Enter at all
    expect(t.screen()).toMatch(/Do you want to proceed\?/);                   // the card is still there, for a person
    expect(t.screen()).not.toContain("RECEIVED");
    expect(String(t.outbox.get(t.last)?.lastError ?? "")).toContain("dialog-on-pane");
  }, 40_000);
  it("an unknown prompt (no recognised dialog): the Enter goes, exactly as before — no composer proof", async () => {
    const t = setup({ afterPaste: "Some other tool asks: continue? [y/N]", dialogs: "claude" });
    await until(() => /MOCK_READY/.test(t.screen()), 10_000);
    t.send("hello past an unknown prompt");
    expect(await until(() => /RECEIVED .*xmsg-copy-mode/.test(t.screen()), 15_000)).toBe(true);
    expect(t.writes).toEqual(["paste", "Enter"]);
  }, 40_000);
});
