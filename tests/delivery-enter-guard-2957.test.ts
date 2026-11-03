/**
 * The last delivery Enter gate on a NATIVE Windows pane; no account, CLI, fleet or service is started.
 * Alpha only (S-36): main's beta.5 reverted #2958's composer proof for tmux panes (decision f57474aa); the alpha keeps it
 * for native panes, where #2957 was found. The fixture is a native pane unless a case says otherwise.
 */
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Daemon } from "../src/daemon.js";
import { GrokBackend } from "../src/backend/grok.js";
import { AntigravityBackend } from "../src/backend/antigravity.js";
import { OpenCodeBackend } from "../src/backend/opencode.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";

const pane = (name: string) => readFileSync(join(__dirname, `fixtures/${name}.pane.txt`), "utf8");
const idle = pane("claude-2.1.293-idle-empty");
const pasted = pane("claude-2.1.293-idle-paste-long");
const permission = pane("claude-2.1.316-bash-permission-prompt");
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(screen = permission, native = true) {
  const root = mkdtempSync(join(tmpdir(), "agend-enter-guard-"));
  roots.push(root);
  const backend = new ClaudeCodeBackend(root);
  const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
  const daemon: any = new Daemon("private-proof", {
    working_directory: root, backend: "claude-code", log_level: "silent",
  } as never, root, true, backend, undefined, logger as never);
  const order: string[] = [];
  const tmux = {
    getWindowId: () => "@owned",
    capturePane: vi.fn(async () => { order.push("capture"); return screen; }),
    sendSpecialKey: vi.fn(async (_key?: string) => { order.push("Enter"); return true; }),
    getLastSendSpecialKeyError: () => null,
  };
  daemon.tmux = tmux;
  if (native) daemon.nativePaneLifecycle = {};
  const mark = vi.fn(() => { order.push("durable"); return true; });
  daemon.deliveryOutbox = { markEnterStarted: mark };
  const attempt = { deliveryId: "private-delivery", attemptNo: 1 };
  return { daemon, backend, tmux, mark, attempt, order };
}

it.each(["initial-submit", "idle-to-busy-retry", "stranded-text-retry"])(
  "%s cannot turn a permission card into an approval", async phase => {
    const f = fixture();
    expect(f.backend.readInputRow(permission)).toBeNull();
    expect(f.daemon.inputTransientGuardGeneration).toBeNull();
    expect(await f.daemon.sendDeliveryEnter(phase, undefined, f.attempt)).toBe(false);
    expect(f.tmux.sendSpecialKey).not.toHaveBeenCalled();
    expect(f.mark).not.toHaveBeenCalled();
  },
);
it.each(["", "CLI still painting its input"])("unknown input %j never receives Enter", async screen => {
  const f = fixture(screen);
  expect(await f.daemon.sendDeliveryEnter("initial-submit", undefined, f.attempt)).toBe(false);
  expect(f.tmux.sendSpecialKey).not.toHaveBeenCalled();
  expect(f.mark).not.toHaveBeenCalled();
});
it("a failed last capture is held before the durable Enter boundary", async () => {
  const f = fixture(pasted);
  f.tmux.capturePane.mockRejectedValue(Error("unreadable"));               // a native read is retried; it never settles
  expect(await f.daemon.sendDeliveryEnter("initial-submit", undefined, f.attempt)).toBe(false);
  expect(f.mark).not.toHaveBeenCalled();
  expect(f.tmux.sendSpecialKey).not.toHaveBeenCalled();
});
it("the real visible composer sends exactly one key, after capture and durable commit", async () => {
  const f = fixture(pasted);
  expect(f.backend.readInputRow(pasted)).not.toBeNull();
  expect(await f.daemon.sendDeliveryEnter("initial-submit", undefined, f.attempt)).toBe(true);
  expect(f.order).toEqual(["capture", "durable", "Enter"]);
  expect(f.tmux.sendSpecialKey).toHaveBeenCalledOnce(); expect(f.tmux.sendSpecialKey.mock.calls[0]![0]).toBe("Enter");
});
it("a readable busy composer remains usable; this gate does not require idle", async () => {
  const f = fixture(pasted);
  vi.spyOn(f.backend, "getBusyPattern").mockReturnValue(/./);
  expect(await f.daemon.sendDeliveryEnter("queue-submit")).toBe(true);
  expect(f.tmux.sendSpecialKey).toHaveBeenCalledOnce();
});
it("a broken structural reader never falls back to a loose ready glyph", async () => {
  const f = fixture(pasted);
  vi.spyOn(f.backend, "readInputRow").mockImplementation(() => { throw Error("reader failure"); });
  expect(await f.daemon.sendDeliveryEnter("initial-submit")).toBe(false);
  expect(f.tmux.sendSpecialKey).not.toHaveBeenCalled();
});
it.each(["pane", "window", "spawn", "fence", "stop", "caller"])(
  "a %s change during the final capture retires the Enter", async kind => {
    const f = fixture(pasted);
    const replacement = { ...f.tmux, sendSpecialKey: vi.fn() };
    let allowed = true;
    f.tmux.capturePane.mockImplementationOnce(async () => {
      if (kind === "pane") f.daemon.tmux = replacement;
      else if (kind === "window") f.tmux.getWindowId = () => "@replacement";
      else if (kind === "spawn") f.daemon.spawnGeneration++;
      else if (kind === "fence") f.daemon.launchFenceEpoch++;
      else if (kind === "stop") f.daemon.deliveryWritesStopping = true;
      else allowed = false;
      return pasted;
    });
    expect(await f.daemon.sendDeliveryEnter("initial-submit", () => allowed, f.attempt)).toBe(false);
    expect(f.tmux.sendSpecialKey).not.toHaveBeenCalled();
    expect(replacement.sendSpecialKey).not.toHaveBeenCalled();
    expect(f.mark).not.toHaveBeenCalled();
  },
);
it("a daemon without a concrete pane cannot authorize Enter", async () => {
  const f = fixture(pasted);
  f.tmux.getWindowId = () => "";
  expect(await f.daemon.sendDeliveryEnter("initial-submit")).toBe(false);
  expect(f.tmux.capturePane).not.toHaveBeenCalled();
  expect(f.tmux.sendSpecialKey).not.toHaveBeenCalled();
});
it("legacy ready glyphs cannot identify the cursor on a numbered card as a composer", async () => {
  const f = fixture();
  f.daemon.backend = { getRuntimeDialogs: () => [], getReadyPattern: () => /❯/ };
  expect(await f.daemon.sendDeliveryEnter("initial-submit")).toBe(false);
  expect(f.tmux.sendSpecialKey).not.toHaveBeenCalled();
});
it("explicit human card answers still walk the verified cursor and confirm the chosen option", async () => {
  const f = fixture();
  let cursor = 0, answered = false;
  const card = f.backend.getRuntimeDialogs().map(dialog => dialog.remoteCard?.(permission)).find(Boolean)!;
  expect(card).toBeTruthy();
  f.tmux.capturePane.mockImplementation(async () => answered ? idle : permission
    .replace(/ ❯ 1\. Yes/, "   1. Yes").replace(new RegExp(`   ${cursor + 1}\\.`), ` ❯ ${cursor + 1}.`));
  f.tmux.sendSpecialKey.mockImplementation(async (key?: string) => {
    if (key === "Down") cursor++;
    else if (key === "Enter") answered = true;
    else throw Error("Unexpected key");
    return true;
  });
  expect(await f.daemon.answerRemoteCard(card.identity, { kind: "option", n: 4 })).toEqual({ outcome: "answered" });
  expect(cursor).toBe(3);
  expect(answered).toBe(true);
  expect(f.mark).not.toHaveBeenCalled();
});

it.each(["delivery", "system"])("%s paste replacement cannot receive the old pane's Enter (native pane; Prism #2989 P2)", async kind => {
  const f = fixture(pasted);
  const replacement = { ...f.tmux, sendSpecialKey: vi.fn(async () => true) };
  Object.assign(f.tmux, {
    pasteBuffer: vi.fn(async () => { f.daemon.tmux = replacement; return true; }),
  });
  const result = kind === "system"
    ? await f.daemon.submitSystemPaste("[from:private-proof] old pane only", "system-proof")
    : await f.daemon.writeMessageToPane("[from:private-proof] old pane only", "@owned", false);
  expect(result).toBe(false);
  expect(f.tmux.sendSpecialKey).not.toHaveBeenCalled();
  expect(replacement.sendSpecialKey).not.toHaveBeenCalled();
});

it("Grok's own boxed numbered draft remains a composer, not a permission card", async () => {
  const ready = pane("grok-1.0.70-audit/1.0.70-120/02-ready");
  const numbered = ready.replace(/^  │ ❯.*│$/m, "  │ ❯ 1. fix the build │\n  │   2. run the tests │\n  │   3. push │");
  const f = fixture(numbered);
  f.daemon.backend = new GrokBackend(f.daemon.config.working_directory);
  expect(f.daemon.backend.isDeliveryComposerPane(numbered)).toBe(true);
  expect(await f.daemon.sendDeliveryEnter("initial-submit")).toBe(true);
  expect(f.tmux.sendSpecialKey).toHaveBeenCalledOnce(); expect(f.tmux.sendSpecialKey.mock.calls[0]![0]).toBe("Enter");
});
it("Grok's actual approval card cannot borrow the boxed-composer tie-breaker", async () => {
  const approval = pane("grok-1.0.70-audit/1.0.70-approval/20-approval");
  const f = fixture(approval);
  f.daemon.backend = new GrokBackend(f.daemon.config.working_directory);
  expect(f.daemon.backend.isDeliveryComposerPane(approval)).toBe(false);
  expect(await f.daemon.sendDeliveryEnter("initial-submit")).toBe(false);
  expect(f.tmux.sendSpecialKey).not.toHaveBeenCalled();
});
it.each(["antigravity", "opencode"])("%s still submits a numbered draft in its own composer", async backend => {
  const agy = pane("agy-1.3.1-idle-after-reply").replace(/^>$/m, "> 1. fix the build\n  2. run the tests\n  3. push");
  const oc = pane("opencode-1.18.34-ready-after-tool").replace(/  ┃\n  ┃\n  ┃\n/, "  ┃ 1. fix the build\n  ┃ 2. run the tests\n  ┃ 3. push\n");
  const f = fixture(backend === "antigravity" ? agy : oc);
  f.daemon.backend = backend === "antigravity" ? new AntigravityBackend(f.daemon.config.working_directory) : new OpenCodeBackend(f.daemon.config.working_directory);
  expect(await f.daemon.sendDeliveryEnter("initial-submit")).toBe(true);
  expect(f.tmux.sendSpecialKey).toHaveBeenCalledOnce(); expect(f.tmux.sendSpecialKey.mock.calls[0]![0]).toBe("Enter");
});

it("an automatically resolved runtime dialog never borrows a delivery's Enter", async () => {
  const f = fixture("automatic modal\n❯");
  f.daemon.backend = {
    getRuntimeDialogs: () => [{ pattern: /automatic modal/, keys: ["Enter"], description: "automatic modal" }],
    getReadyPattern: () => /❯/,
  };
  expect(await f.daemon.sendDeliveryEnter("initial-submit")).toBe(false);
  expect(f.tmux.sendSpecialKey).not.toHaveBeenCalled();
});
it("Antigravity's real trust card remains held", async () => {
  const f = fixture(pane("agy-1.3.1-trust-dialog"));
  f.daemon.backend = new AntigravityBackend(f.daemon.config.working_directory);
  expect(await f.daemon.sendDeliveryEnter("initial-submit")).toBe(false);
  expect(f.tmux.sendSpecialKey).not.toHaveBeenCalled();
});

it.each(["ordinary multi-line draft", "numbered multi-line draft"])("Grok submits a long %s without borrowing a historical ready glyph", async kind => {
  const ready = pane("grok-1.0.70-audit/1.0.70-120/02-ready");
  const rows = Array.from({ length: 8 }, (_, i) => `  │ ${i === 0 ? "❯" : " "} ${kind === "numbered multi-line draft" ? `${i + 1}. ` : ""}item ${i} │`).join("\n");
  const draft = ready.replace(/^  │ ❯.*│$/m, rows);
  const f = fixture(draft);
  f.daemon.backend = new GrokBackend(f.daemon.config.working_directory);
  expect(await f.daemon.sendDeliveryEnter("initial-submit")).toBe(true);
  expect(f.tmux.sendSpecialKey).toHaveBeenCalledOnce(); expect(f.tmux.sendSpecialKey.mock.calls[0]![0]).toBe("Enter");
});

it("S-35: on a native pane, a capture refused while output is still arriving is read again (never typed), then Enter is sent once", async () => {
  const f = fixture(idle);
  f.daemon.nativePaneLifecycle = {};
  let refusals = 2;
  f.tmux.capturePane.mockImplementation(async () => { f.order.push("capture"); if (refusals-- > 0) throw Error("Pane changed during capture; observe it again"); return idle; });
  expect(await f.daemon.sendDeliveryEnter("initial-submit", undefined, f.attempt)).toBe(true);
  expect(f.order).toEqual(["capture", "capture", "capture", "durable", "Enter"]);
  expect(f.tmux.sendSpecialKey).toHaveBeenCalledOnce();
});

it("S-35: a native capture that never settles still holds — bounded reads, no Enter, and the log names the reason", async () => {
  const f = fixture(idle); const warns: unknown[][] = [];
  f.daemon.nativePaneLifecycle = {}; f.daemon.logger = { info() {}, error() {}, debug() {}, warn: (...a: unknown[]) => warns.push(a) };
  f.tmux.capturePane.mockImplementation(async () => { f.order.push("capture"); throw Error("Pane changed during capture; observe it again"); });
  expect(await f.daemon.sendDeliveryEnter("initial-submit", undefined, f.attempt)).toBe(false);
  expect(f.order.filter(step => step === "capture")).toHaveLength(5); expect(f.order).not.toContain("Enter"); expect(f.mark).not.toHaveBeenCalled();
  expect(warns.some(([fields]) => (fields as { reason?: string }).reason === "capture_failed")).toBe(true);
});

it("S-36: a tmux (non-native) pane follows main's beta.5 — no capture, no composer proof; the Enter goes after the durable mark", async () => {
  const f = fixture(permission, false);
  expect(await f.daemon.sendDeliveryEnter("initial-submit", undefined, f.attempt)).toBe(true);
  expect(f.order).toEqual(["durable", "Enter"]);
  expect(f.tmux.capturePane).not.toHaveBeenCalled();
});

function positiveRefusal(f: ReturnType<typeof fixture>) {
  Object.assign(f.tmux, {lastInputWasNotSent: () => true,
    getLastSendSpecialKeyError: () => 'Pane changed after observation; input was not sent'});
}
it('native positive zero-input ACK re-observes before a new Enter, without another durable mark', async () => {
  const f=fixture(pasted);positiveRefusal(f);
  f.tmux.sendSpecialKey.mockResolvedValueOnce(false);
  expect(await f.daemon.sendDeliveryEnter('initial-submit',undefined,f.attempt)).toBe(true);
  expect(f.order).toEqual(['capture','durable','capture','Enter']);
  expect(f.tmux.sendSpecialKey).toHaveBeenCalledTimes(2);expect(f.mark).toHaveBeenCalledOnce();
});
it.each(['unknown ACK','lost ACK','other refusal'])('native %s never retries Enter',async kind=>{
  const f=fixture(pasted);positiveRefusal(f);f.tmux.sendSpecialKey.mockResolvedValue(false);
  if(kind==='unknown ACK')Object.assign(f.tmux,{lastInputWasNotSent:()=>false});
  if(kind==='lost ACK')Object.assign(f.tmux,{lastInputWasNotSent:()=>false,getLastSendSpecialKeyError:()=> 'Pane input outcome is unconfirmed; reconnect and inspect before retrying'});
  if(kind==='other refusal')Object.assign(f.tmux,{getLastSendSpecialKeyError:()=> 'Pane input withheld: the intended composer or dialog is not verified'});
  expect(await f.daemon.sendDeliveryEnter('initial-submit',undefined,f.attempt)).toBe(false);
  expect(f.tmux.sendSpecialKey).toHaveBeenCalledOnce();expect(f.tmux.capturePane).toHaveBeenCalledOnce();
});
it.each(['dialog','changed draft','launch'])('native positive refusal followed by %s never sends another Enter',async kind=>{
  const f=fixture(pasted);positiveRefusal(f);
  f.tmux.sendSpecialKey.mockImplementationOnce(async()=>{
    if(kind==='launch')f.daemon.launchFenceEpoch++;
    else f.tmux.capturePane.mockResolvedValue(kind==='dialog'?permission:pasted.replace(/a/g,'z'));
    return false;
  });
  expect(await f.daemon.sendDeliveryEnter('initial-submit',undefined,f.attempt)).toBe(false);
  expect(f.tmux.sendSpecialKey).toHaveBeenCalledOnce();
});
it('native repeated positive refusals stop after five keys and report an input hold',async()=>{
  const f=fixture(pasted);positiveRefusal(f);f.tmux.sendSpecialKey.mockResolvedValue(false);const held=vi.fn();
  expect(await f.daemon.sendDeliveryEnter('initial-submit',undefined,f.attempt,held)).toBe(false);
  expect(f.tmux.sendSpecialKey).toHaveBeenCalledTimes(5);expect(f.tmux.capturePane).toHaveBeenCalledTimes(5);
  expect(f.mark).toHaveBeenCalledOnce();expect(held).toHaveBeenCalledWith('output_changed');
  expect(deriveNeedsYou({prompts:[],deliveries:[],instances:[{name:'private-proof',nativeDeliveryHold:f.daemon.nativeDeliveryHold()}],ownerOf:()=>undefined})).toContainEqual(expect.objectContaining({reason:'delivery_uncertain',instance:'private-proof'}));
  f.tmux.sendSpecialKey.mockResolvedValue(true);expect(await f.daemon.sendDeliveryEnter('initial-submit')).toBe(true);
  expect(f.daemon.nativeDeliveryHold()).toBeNull();
});
it('native positive refusal retry has a two-second deadline even when capture is late',async()=>{
  const f=fixture(pasted);positiveRefusal(f);f.tmux.sendSpecialKey.mockResolvedValueOnce(false);const held=vi.fn();let offset=0;
  const original=performance.now.bind(performance);vi.spyOn(performance,'now').mockImplementation(()=>original()+offset);
  f.tmux.capturePane.mockResolvedValueOnce(pasted).mockImplementationOnce(async()=>{offset=2500;return pasted;});
  expect(await f.daemon.sendDeliveryEnter('initial-submit',undefined,f.attempt,held)).toBe(false);
  expect(f.tmux.sendSpecialKey).toHaveBeenCalledOnce();expect(held).toHaveBeenCalledWith('output_changed');
});

import {DeliveryOutbox} from '../src/delivery-outbox.js';
import {deriveNeedsYou} from '../src/needs-you.js';
it('exhausted native Enter retries leave a single paste uncertain and visible in Needs-you',async()=>{
 const f=fixture(pasted),d=f.daemon;positiveRefusal(f);f.tmux.sendSpecialKey.mockResolvedValue(false);
 const paste=vi.fn(async()=>true);Object.assign(f.tmux,{pasteBuffer:paste});d.firstDeliveryDelay={consume:()=>0};
 const outbox=new DeliveryOutbox(join(d.config.working_directory,'delivery.db'));
 try{
  const row=outbox.admit({operationId:'refusal',sourceKey:'refusal',sourceInstance:'source',sourceDaemonBootId:'source-boot',targetInstance:'private-proof',kind:'fleet_inbound',payload:{type:'fleet_inbound',content:'payload',meta:{}}}).delivery;
  const attempt=outbox.claimNext('manager',()=>d.bootId,new Set())!;d.setDeliveryOutboxPort(outbox);
  vi.spyOn(d,'wake').mockResolvedValue(undefined);
  vi.spyOn(d,'durableAttemptEvidence').mockResolvedValue({backend:'claude-code',windowId:'@owned',transcriptPath:null,transcriptOffset:null,transcriptSessionId:null,submissionMode:'idle_submit'});
  vi.spyOn(d,'deliverMessage').mockImplementation((formatted,status,opts:any)=>d.writeMessageToPane(formatted,'@owned',false,status,undefined,opts.verdict,opts.durableAttempt));
  d.pushChannelMessage('payload',{delivery_id:row.deliveryId,delivery_attempt:String(attempt.attemptNo),message_id:'refusal',chat_id:'scratch',thread_id:'scratch',adapter_id:'scratch'});
  await d.pasteLock;
  expect(paste).toHaveBeenCalledOnce();expect(f.tmux.sendSpecialKey).toHaveBeenCalledTimes(5);
  expect(outbox.get(row.deliveryId)).toMatchObject({state:'uncertain',attemptNo:1,lastError:'submit-enter:native-input-output_changed'});
  const items=deriveNeedsYou({prompts:[],instances:[],deliveries:outbox.needsAttention('2000-01-01T00:00:00Z').map(row=>({...row,source:row.sourceInstance,target:row.targetInstance,finishedAt:Date.parse(row.finishedAt)})),ownerOf:()=>undefined});
  expect(items).toContainEqual(expect.objectContaining({type:'delivery',reason:'delivery_uncertain',instance:'private-proof'}));
 }finally{outbox.close();}
});
