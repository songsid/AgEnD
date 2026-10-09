/**
 * The public link's steps as they happen (follow-up to #1512): the install reports where it is, the steps render
 * with their seconds, edits are throttled, and Telegram's /dashboard menu follows them too (its own message edited).
 * Discord's end-to-end runs are in discord-dashboard-ephemeral.test.ts.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: () => { throw Error("No process"); }, execFile: () => { throw Error("No CLI"); }, execFileSync: () => { throw Error("No CLI"); }, execSync: () => { throw Error("No CLI"); }, spawnSync: () => { throw Error("No CLI"); } }));
vi.mock("node:inspector", () => ({ Session: class { constructor() { throw Error("No inspector"); } } }));
vi.mock("../src/backend/index.js", async original => ({ ...await original<typeof import("../src/backend/index.js")>(), createBackend: () => { throw Error("No backend"); } }));
vi.mock("../src/tmux-manager.js", async original => ({ ...await original<typeof import("../src/tmux-manager.js")>(), TmuxManager: new Proxy({}, { get: () => () => { throw Error("No tmux"); } }) }));
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return this; } }) }));
import { CloudflaredInstallError, ensureCloudflared, type CloudflaredInstallProgress } from "../src/tunnel/cloudflared-install.js";
import { PublicLinkProgressTracker, ThrottledMessageEditor, failureOf, renderPublicLinkProgress } from "../src/public-link-progress.js";
import { FleetManager } from "../src/fleet-manager.js";
import { PublicWebLink } from "../src/public-web-link.js";
import { TunnelPurposeLane } from "../src/tunnel/purpose-lane.js";
import { setLocale, t } from "../src/locale.js";

const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-progress-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
beforeEach(() => setLocale("en"));

describe("ensureCloudflared reports where the install is", () => {
  const BODY = Buffer.from("#!/bin/sh\necho 'cloudflared version test'\n".repeat(100));
  const pin = (body: Buffer) => ({ version: "2026.9.3", assets: { "linux-x64": { name: "cloudflared-linux-amd64", sha256: createHash("sha256").update(body).digest("hex"), archive: "binary" as const } } });
  /** The body in three chunks, with or without a Content-Length. */
  const chunked = (body: Buffer, length: boolean) => vi.fn(async () => {
    const parts = [body.subarray(0, 1000), body.subarray(1000, 3000), body.subarray(3000)];
    return new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(new Uint8Array(p)); c.close(); } }),
      { status: 200, headers: length ? { "content-length": String(body.length) } : {} });
  });
  const options = (dataDir: string, extra: Record<string, unknown>) => ({ dataDir, env: { PATH: "/nonexistent" }, platform: "linux" as NodeJS.Platform, arch: "x64", pinnedOnly: true, ...extra });

  it("first run: checked (download needed) → bytes of the Content-Length, chunk by chunk → verifying; then a reuse says only checked", async () => {
    const dataDir = scratch(), seen: CloudflaredInstallProgress[] = [];
    await ensureCloudflared(options(dataDir, { fetchImpl: chunked(BODY, true), pin: pin(BODY), onProgress: (p: CloudflaredInstallProgress) => seen.push(p) }));
    expect(seen).toEqual([
      { phase: "checked", download: true, version: "2026.9.3" },
      { phase: "downloading", received: 0, total: BODY.length },
      { phase: "downloading", received: 1000, total: BODY.length },
      { phase: "downloading", received: 3000, total: BODY.length },
      { phase: "downloading", received: BODY.length, total: BODY.length },
      { phase: "verifying" },
    ]);
    seen.length = 0;
    expect(await ensureCloudflared(options(dataDir, { fetchImpl: chunked(BODY, true), pin: pin(BODY), onProgress: (p: CloudflaredInstallProgress) => seen.push(p) }))).toMatchObject({ source: "agend" });
    expect(seen).toEqual([{ phase: "checked", download: false, version: "2026.9.3" }]);
  });

  it("no Content-Length: the total is unknown (null), the bytes still count", async () => {
    const seen: CloudflaredInstallProgress[] = [];
    await ensureCloudflared(options(scratch(), { fetchImpl: chunked(BODY, false), pin: pin(BODY), onProgress: (p: CloudflaredInstallProgress) => seen.push(p) }));
    expect(seen.filter(p => p.phase === "downloading").map(p => (p as { total: number | null }).total)).toEqual([null, null, null, null]);
  });

  it("a checksum mismatch is reported after verifying began, as the install's own error", async () => {
    const seen: string[] = [];
    const err = await ensureCloudflared(options(scratch(), { fetchImpl: chunked(Buffer.from("evil".repeat(1000)), true), pin: pin(BODY), onProgress: (p: CloudflaredInstallProgress) => seen.push(p.phase) })).catch(e => e);
    expect(err).toBeInstanceOf(CloudflaredInstallError);
    expect(err.kind).toBe("checksum-mismatch");
    expect(seen.at(-1)).toBe("verifying");
  });

  it("a listener that throws cannot break the install", async () => {
    const got = await ensureCloudflared(options(scratch(), { fetchImpl: chunked(BODY, true), pin: pin(BODY), onProgress: () => { throw new Error("display broke"); } }));
    expect(got.source).toBe("downloaded");
  });
});

describe("rendering", () => {
  let clock = 0;
  const track = () => new PublicLinkProgressTracker(() => clock, () => {});
  beforeEach(() => { clock = 0; });

  it("while checking: ① and ④–⑥; once installed: ④–⑥ only; a download: all six, with MB of the total", () => {
    const p = track();
    expect(renderPublicLinkProgress(p.snapshot, 0).split("\n").slice(1).map(l => l.split(" ")[1])).toEqual(["①", "④", "⑤", "⑥"]);
    p.installChecked(false, "2026.9.3");
    expect(renderPublicLinkProgress(p.snapshot, 0)).not.toMatch(/[①②③]/);
    const d = track();
    d.installChecked(true, "2026.9.3"); clock = 3_500; d.downloaded(12.34 * 1024 * 1024, 40 * 1024 * 1024);
    const text = renderPublicLinkProgress(d.snapshot, clock);
    expect(text.split("\n").slice(1).map(l => l.split(" ")[1])).toEqual(["①", "②", "③", "④", "⑤", "⑥"]);
    expect(text).toContain("⏳ ② Download cloudflared: 12.3 / 40.0 MB · 3 s");
    expect(text).toContain("▫️ ③ ");
  });

  it("a failure marks its own step with the reason, and the total stops at the failure", () => {
    const p = track();
    p.installChecked(false, "2026.9.3"); p.begin("tunnel"); clock = 7_200; p.fail(failureOf("readiness-failed"));
    const text = renderPublicLinkProgress(p.snapshot, 60_000, t("dashboard.private_failed"));
    expect(text.split("\n")[0]).toBe(t("dashboard.progress.title", 7));
    expect(text).toContain(`❌ ④ ${t("dashboard.progress.tunnel")} · 7 s — ${t("dashboard.progress.fail.unreachable")}`);
    expect(text.endsWith(`\n\n${t("dashboard.private_failed")}`)).toBe(true);
  });

  it("zh-TW: the words and the seconds unit follow the locale", () => {
    setLocale("zh-TW");
    const p = track(); p.installChecked(false, "2026.9.3"); p.begin("tunnel"); clock = 2_000;
    expect(renderPublicLinkProgress(p.snapshot, clock)).toContain("⏳ ④ 啟動 tunnel · 2 秒");
  });

  it.each([["binary-missing", "spawn-failed"], ["no-url", "no-address"], ["timeout", "no-address"], ["readiness-failed", "unreachable"],
    ["checksum-mismatch", "checksum-mismatch"], ["lease-held", "lease-held"], ["something new", "unknown"]])("error kind %s → %s", (kind, reason) => {
    expect(failureOf(kind)).toBe(reason);
    expect(t(`dashboard.progress.fail.${reason}`)).not.toBe(`dashboard.progress.fail.${reason}`);
  });
});

describe("ThrottledMessageEditor", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const editor = (edit: (text: string) => Promise<void>) => new ThrottledMessageEditor({ edit, now: () => Date.now(), minIntervalMs: 2_000, heartbeatMs: 5_000 });

  it("the first text goes at once; a burst inside the interval becomes one edit carrying the newest", async () => {
    const sent: Array<[string, number]> = []; const start = Date.now();
    const e = editor(async text => { sent.push([text, Date.now() - start]); });
    e.update(() => "a"); await vi.advanceTimersByTimeAsync(0);
    for (const x of ["b", "c", "d"]) { e.update(() => x); await vi.advanceTimersByTimeAsync(300); }
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual([["a", 0], ["d", 2_000]]);
    await e.close();
  });

  it("with nothing new it re-renders every heartbeat (the seconds move), and never sends the same text twice", async () => {
    const sent: string[] = []; let n = 0;
    const e = editor(async text => { sent.push(text); });
    e.update(() => `tick ${Math.floor(n++ / 2)}`);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sent).size).toBe(sent.length);
    await e.close();
  });

  it("close waits for the edit in flight, and nothing is sent after it", async () => {
    let finish!: () => void; const sent: string[] = [];
    const e = editor(text => { sent.push(text); return new Promise<void>(resolve => { finish = resolve; }); });
    e.update(() => "slow"); await vi.advanceTimersByTimeAsync(0);
    let closed = false; const closing = e.close().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(10); expect(closed).toBe(false);
    finish(); await closing; expect(closed).toBe(true);
    e.update(() => "late"); await vi.advanceTimersByTimeAsync(20_000);
    expect(sent).toEqual(["slow"]);
  });

  it("two failed edits in a row stop it (the message or its token is gone)", async () => {
    const edit = vi.fn(async () => { throw new Error("Unknown Message"); });
    const e = editor(edit);
    let i = 0; e.update(() => `x${i++}`);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(edit).toHaveBeenCalledTimes(2);
    await e.close();
  });
});

describe("Telegram /dashboard: the General menu message follows the steps", () => {
  const after = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  let base = 0;
  beforeEach(() => { vi.useFakeTimers(); base = Date.now(); vi.spyOn(performance, "now").mockImplementation(() => Date.now() - base); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  function rig(ensure: (o: { onProgress?: (p: CloudflaredInstallProgress) => void }) => Promise<{ path: string; source: string }>) {
    const dir = scratch();
    const fm = new FleetManager(dir), s = fm as any;
    const adapter = { id: "owner", type: "telegram", sendText: vi.fn(async (chat: string, _t: string, o?: any) => ({ chatId: chat, threadId: o?.threadId, messageId: "safe" })),
      notifyAlert: vi.fn(async (chat: string, _a: any, o?: any) => ({ chatId: chat, threadId: o?.threadId, messageId: "menu" })),
      sendDirect: vi.fn(async (user: string, _text: string, _o?: unknown) => ({ chatId: user, messageId: "dm" })),
      editMessageRemoveButtons: vi.fn(async (_c: string, _m: string, _text: string, _th?: string) => {}), stop: vi.fn(async () => {}) };
    const owner = { id: "owner", type: "telegram", group_id: "G", bot_token_env: "NONE", access: { mode: "open", allowed_users: ["admin"] } };
    fm.fleetConfig = { defaults: {}, channel: owner, channels: [owner], instances: { general: { working_directory: dir, general_topic: true, topic_id: "T0", channel_id: "owner" } } } as never;
    fm.routing.rebuild(fm.fleetConfig!); s.adapters.set("owner", adapter); s.adapter = adapter;
    s.worlds.set("owner", { adapter, groupId: "G", channelConfig: owner, accessManager: { isAllowed: () => true }, stop: async () => {} });
    s.classicChannels = { isClassicChannel: () => false, hasChannel: () => false };
    writeFileSync(join(dir, "web.token"), "c".repeat(48), { mode: 0o600 }); s.initializeWebSessions();
    vi.spyOn(fm, "getDashboardAccess").mockReturnValue({ ready: true, token: "c".repeat(48) });
    const manager = { start: vi.fn(async (_p: unknown, ctx: any) => { await after(2_000); ctx.onCandidateHost("sample.trycloudflare.com"); await after(3_000);
      return { ok: true as const, handle: { pageUrl: "https://sample.trycloudflare.com/signin", onUnexpectedExit: () => () => {} } }; }), stop: vi.fn(async () => ({ confirmed: true as const })) };
    const lane = new TunnelPurposeLane(manager as never); s.tunnelPurposeLane = lane;
    s.publicWebLink = new PublicWebLink({ dataDir: dir, web: () => fm.fleetConfig!.web, permitted: o => s.publicOwnerCurrent(o), reserve: id => lane.reserve("dashboard", id),
      createGateway: () => ({ listen: async () => new URL("http://127.0.0.1:12345"), setHost: () => {}, close: () => {}, readinessMarker: "stub" }) as never,
      ensure: ensure as never, provider: () => ({}) as never, revoke: id => { s.webLoginCodes.revokeAudience(id); s.webSessions.revokeExposure(id); }, log: () => {} });
    const cleanup = async () => { await s.publicWebLink.close("test end"); for (const e of s.pendingNonceButtons.values()) clearTimeout(e.timer); fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); };
    return { fm, s, adapter, manager, cleanup };
  }

  it("edits the menu in General no more than every 3 s, static words only; the last edit is the steps plus the outcome", async () => {
    const h = rig(async ({ onProgress }) => {
      onProgress?.({ phase: "checked", download: true, version: "2026.9.3" });
      for (let i = 1; i <= 10; i++) { await after(800); onProgress?.({ phase: "downloading", received: i * 4 * 1024 * 1024, total: 40 * 1024 * 1024 }); }
      onProgress?.({ phase: "verifying" }); await after(500);
      return { path: "/pinned", source: "downloaded" };
    });
    await h.s.topicCommands.handleGeneralCommand({ source: "telegram", adapterId: "owner", chatId: "G", threadId: "T0", userId: "admin", username: "admin", text: "/dashboard", messageId: "in", timestamp: new Date() });
    const e = [...h.s.pendingNonceButtons.values()][0] as any;
    const at: number[] = [];
    h.adapter.editMessageRemoveButtons.mockImplementation(async () => { at.push(Date.now()); });
    const click = h.s.dispatchAdapterCallback({ callbackData: `dashboard:${e.nonce}:public`, chatId: e.chatId, threadId: e.threadId, messageId: e.messageId, userId: "admin", ack: vi.fn() }, "owner", h.adapter);
    await vi.advanceTimersByTimeAsync(30_000); await click;
    const calls = h.adapter.editMessageRemoveButtons.mock.calls;
    expect(calls.every(c => c[0] === "G" && c[1] === "menu" && c[3] === "T0"), "the menu message itself").toBe(true);
    for (let i = 1; i < at.length - 1; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(3_000);
    const texts = calls.map(c => c[2]);
    expect(texts.some(x => /⏳ ② Download cloudflared: \d+\.\d \/ 40\.0 MB/.test(x))).toBe(true);
    const final = texts.at(-1)!;
    expect(final).toContain("✅ ② Download cloudflared: 40.0 / 40.0 MB · 8 s");
    expect(final).toContain(`✅ ④ ${t("dashboard.progress.tunnel")} · 2 s`);
    expect(final).toContain(`✅ ⑤ ${t("dashboard.progress.address")} · 3 s`);
    expect(final.endsWith(`\n\n${t("dashboard.private_sent")}`)).toBe(true);
    for (const x of texts) { expect(x).not.toContain("trycloudflare"); expect(x).not.toMatch(/[A-Z0-9]{4}-[A-Z0-9]{4}/); }
    expect(h.adapter.sendDirect.mock.calls[0][1]).toContain("https://sample.trycloudflare.com/signin");
    await h.cleanup();
  });
});
