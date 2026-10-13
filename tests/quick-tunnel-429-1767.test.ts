/**
 * #1767 (live on 2.2.0-beta.5): `/web` failed in 0 s as "Cloudflare gave no public address in time". It was
 * trycloudflare refusing new quick tunnels with HTTP 429 — cloudflared prints `quick tunnel provisioning failed with
 * status 429` and exits — folded into no-url → no-address (the timeout's words), with nothing in daemon.log. And the
 * preview's quick tunnel was asked for FIRST, so under a rate limit it could take the request the link needed.
 *
 * The real CloudflaredProvider (a scripted child, and one real child process), the real failure mapping and texts,
 * the real PublicWebLink + PublicPreview on fake managers.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflaredProvider, exitBeforeUrl, lastOutputLine } from "../src/tunnel/cloudflared.js";
import { TunnelStartError, type TunnelHandle, type TunnelStartContext } from "../src/tunnel/types.js";
import { failureOf, type PublicLinkFailure } from "../src/public-link-progress.js";
import { setLocale, t } from "../src/locale.js";
import { PublicWebLink, logDetail } from "../src/public-web-link.js";
import { TunnelPurposeLane } from "../src/tunnel/purpose-lane.js";
import { PublicPreview, type PublicPreviewGateway } from "../src/public-preview.js";

const dirs: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "agend-1767-")); dirs.push(d); return d; };
afterEach(() => { setLocale("en"); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const RATE_LIMITED = [
  "2026-10-13T05:07:18Z ERR Configuration file /dev/null was empty",
  "2026-10-13T05:07:18Z INF Requesting new quick Tunnel on trycloudflare.com...",
  "quick tunnel provisioning failed with status 429",
].join("\n") + "\n";

class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  pid: number | null = 4242;
  kill(): boolean { return true; }
}
function scripted(child: FakeChild, over: Record<string, unknown> = {}) {
  const bin = join(tempDir(), "cloudflared");
  writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
  return new CloudflaredProvider({ binaryName: bin, env: { PATH: "/nonexistent" }, spawnProcess: (() => child) as never,
    deadlineMs: 60_000, graceMs: 10, probe: () => ({ kind: "gone" }), ...over });
}
const ctx = (over: Partial<TunnelStartContext> = {}): TunnelStartContext => ({ sid: "s".repeat(32), origin: new URL("http://127.0.0.1:45678"),
  pagePath: "/signin", readinessMarker: "m", expiresAt: Date.now() + 600_000, signal: new AbortController().signal, ...over });
const kindOf = async (p: Promise<unknown>) => { try { await p; return "resolved"; } catch (err) { return (err as TunnelStartError).errorKind; } };

describe("#1767: why cloudflared exited before an address — from what it printed", () => {
  it("status 429 → rate-limited; another status → provisioning-failed; anything else → no-url with its last line", () => {
    expect(exitBeforeUrl(RATE_LIMITED)).toMatchObject({ errorKind: "rate-limited" });
    expect(exitBeforeUrl(RATE_LIMITED.replace("429", "503"))).toMatchObject({ errorKind: "provisioning-failed", message: expect.stringContaining("HTTP 503") });
    const other = exitBeforeUrl("INF starting\nERR failed to dial https://region1.v2.argotunnel.com:7844 \u001b[31mboom\u001b[0m\n");
    expect(other).toMatchObject({ errorKind: "no-url" });
    expect(other.message).toContain("failed to dial <url>");
    expect(other.message).not.toMatch(/https?:|\u001b/);
    expect(lastOutputLine("x".repeat(500))).toHaveLength(200);
  });

  it("the provider: a 429 printed just before the exit is rate-limited, also when the exit is reported before the output", async () => {
    for (const exitFirst of [false, true]) {
      const child = new FakeChild();
      const started = performance.now();
      const result = kindOf(scripted(child).start(ctx()));
      await new Promise(r => setTimeout(r, 5));
      if (exitFirst) { child.emit("exit", 1, null); child.stderr.push(RATE_LIMITED); setTimeout(() => child.emit("close"), 20); }
      else { child.stderr.push(RATE_LIMITED); await new Promise(r => setTimeout(r, 5)); child.emit("exit", 1, null); child.emit("close"); }
      expect(await result, `exit ${exitFirst ? "before" : "after"} its output`).toBe("rate-limited");
      expect(performance.now() - started, "no waiting out the 60 s deadline").toBeLessThan(5_000);
    }
  });

  it("a real child that prints the 429 and exits at once: rate-limited in well under a second", async () => {
    const bin = join(tempDir(), "cloudflared");
    writeFileSync(bin, `#!/bin/sh\nprintf '%s' ${JSON.stringify(RATE_LIMITED)} >&2\nexit 1\n`, { mode: 0o755 });
    const started = performance.now();
    const kind = await kindOf(new CloudflaredProvider({ binaryName: bin, env: { PATH: "/usr/bin:/bin" }, deadlineMs: 60_000, graceMs: 50 }).start(ctx()));
    expect(kind).toBe("rate-limited");
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});

describe("#1767: what the person is told — never a timeout before the timeout", () => {
  it("each kind's reason, and only a real timeout says \"in time\" (en and zh-TW)", () => {
    expect(failureOf("rate-limited")).toBe("rate-limited");
    expect(failureOf("provisioning-failed")).toBe("provisioning-failed");
    expect(failureOf("no-url")).toBe("process-exited");
    expect(failureOf("bad-url")).toBe("bad-address");
    expect(failureOf("timeout")).toBe("no-address");
    for (const locale of ["en", "zh-TW"] as const) {
      setLocale(locale);
      for (const kind of ["rate-limited", "provisioning-failed", "no-url", "bad-url"]) {
        const text = t(`dashboard.progress.fail.${failureOf(kind)}`);
        expect(text, `${locale} ${kind}`).not.toMatch(/in time|及時|timed? ?out|逾時/i);
        expect(text).not.toBe(`dashboard.progress.fail.${failureOf(kind)}`);
      }
      expect(t("dashboard.progress.fail.no-address"), `${locale} timeout keeps its words`).toMatch(/in time|及時/);
    }
    setLocale("en");
    expect(t("dashboard.progress.fail.rate-limited")).toMatch(/limiting new temporary links.*LAN link still works/);
  });
});

/** The link and its preview on fake managers; `linkStart` decides the link's tunnel, `previewStart` the preview's. */
function rig(opts: { linkStart: (ctx: TunnelStartContext) => Promise<unknown>; previewResults?: unknown[] }) {
  const order: string[] = [];
  const manager = { start: vi.fn(async (_p: unknown, c: TunnelStartContext) => { order.push("link"); return opts.linkStart(c); }), stop: vi.fn(async () => ({ confirmed: true as const })) };
  const previewManager = { start: vi.fn(async () => { order.push("preview"); return opts.previewResults?.shift() ?? { ok: false, errorKind: "cancelled", message: "x", leaseHeld: false }; }),
    stop: vi.fn(async () => ({ confirmed: true as const })) };
  const lane = new TunnelPurposeLane(manager as never);
  const gateway: PublicPreviewGateway = { server: {} as never, readinessMarker: "pm", bootId: "f".repeat(32), listen: vi.fn(async () => new URL("http://127.0.0.1:9998")), setHost: vi.fn(), close: vi.fn() };
  const logs: Array<[string, string | undefined]> = [];
  const createPreview = vi.fn(({ id, expiresAt, dashboardOrigin, isCurrent }) => { order.push("create preview"); return new PublicPreview({ exposureId: id, expiresAt, dashboardOrigin, isCurrent,
    manager: previewManager as never, provider: () => ({ name: "fake" }) as never, createGateway: () => gateway, log: (e, d) => logs.push([e, d]) }); });
  const link = new PublicWebLink({
    dataDir: "/fixture", web: () => ({}), permitted: () => true, reserve: id => lane.reserve("dashboard", id),
    createGateway: () => ({ listen: vi.fn(async () => new URL("http://127.0.0.1:9999")), setHost: vi.fn(), close: vi.fn(), readinessMarker: "m", server: {} }) as never,
    ensure: vi.fn(async () => ({ path: "/pinned", source: "agend" as const })), provider: () => ({ name: "fake" }) as never,
    revoke: vi.fn(), log: (e, _id, d) => logs.push([e, d]), now: () => 0, wallNow: () => 100_000, createPreview: createPreview as never,
  });
  return { link, order, manager, previewManager, createPreview, logs };
}
const owner = { adapterId: "owner", userId: "admin", chatId: "G", threadId: "T", binding: {} };
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
const handle = (host: string, path: string): TunnelHandle => ({ provider: "fake", visibility: "public", baseUrl: `https://${host}`, pageUrl: `https://${host}${path}`,
  pid: 1, identity: "x", stop: vi.fn(), onUnexpectedExit: () => vi.fn() });

describe("#1767: the link asks first; a failed link spends nothing on a preview; the reason is logged", () => {
  it("rate-limited link: failed with rate-limited (not no-address), its line in daemon.log, and NO preview ever asked for", async () => {
    let failed: PublicLinkFailure | undefined;
    const h = rig({ linkStart: async () => ({ ok: false, errorKind: "rate-limited", message: "Cloudflare refused a new quick tunnel: HTTP 429 (rate limited)", leaseHeld: false }) });
    expect(await h.link.deliver(owner, async () => true, p => { failed = p.failed?.reason ?? failed; })).toBe(false);
    await tick();
    expect(failed).toBe("rate-limited");
    expect(h.createPreview).not.toHaveBeenCalled();
    expect(h.previewManager.start).not.toHaveBeenCalled();
    expect(h.logs).toContainEqual(["startup failed: rate-limited", "Cloudflare refused a new quick tunnel: HTTP 429 (rate limited)"]);
  });

  it("the preview is created only once the link's tunnel has its address — after the link's request", async () => {
    let atRequest: string[] = [];
    const h = rig({
      linkStart: async c => { atRequest = [...h.order]; c.onCandidateHost?.("dash-host.trycloudflare.com"); return { ok: true, handle: handle("dash-host.trycloudflare.com", "/signin") }; },
      previewResults: [{ ok: true, handle: handle("prev-host.trycloudflare.com", "/ready") }],
    });
    expect(await h.link.deliver(owner, async () => true)).toBe(true);
    await tick();
    expect(atRequest, "nothing of the preview exists when the link asks Cloudflare").toEqual(["link"]);
    expect(h.order).toEqual(["link", "create preview", "preview"]);
    expect(h.createPreview).toHaveBeenCalledTimes(1);
    await h.link.close("end");
  });

  it("a link that fails after its address (unreachable) did start a preview — and closes it with the exposure", async () => {
    const h = rig({ linkStart: async c => { c.onCandidateHost?.("dash-host.trycloudflare.com"); return { ok: false, errorKind: "readiness-failed", message: "x", leaseHeld: false }; } });
    expect(await h.link.deliver(owner, async () => true)).toBe(false);
    await tick();
    expect(h.createPreview).toHaveBeenCalledTimes(1);
    expect(h.previewManager.stop).toHaveBeenCalled();
  });

  it("a rate-limited preview: failed with that reason, logged with its line, never retried (#1732 retries only unreachable), the link unaffected", async () => {
    const h = rig({
      linkStart: async c => { c.onCandidateHost?.("dash-host.trycloudflare.com"); return { ok: true, handle: handle("dash-host.trycloudflare.com", "/signin") }; },
      previewResults: [{ ok: false, errorKind: "rate-limited", message: "Cloudflare refused a new quick tunnel: HTTP 429 (rate limited)", leaseHeld: false }],
    });
    expect(await h.link.deliver(owner, async () => true)).toBe(true);
    await tick();
    expect(h.previewManager.start).toHaveBeenCalledTimes(1);
    expect(h.link.previewStatus(h.link.exposureId!)).toEqual({ state: "failed", reason: "rate-limited" });
    expect(h.logs).toContainEqual(["preview rate-limited", "Cloudflare refused a new quick tunnel: HTTP 429 (rate limited)"]);
    expect(h.link.status().state).toBe("open");
    await h.link.close("end");
  });

  it("log details never carry a URL or control characters, and are bounded", () => {
    expect(logDetail("x https://abc.trycloudflare.com/signin y\n\u0007z")).toBe("x <url> y  z");
    expect(logDetail("a".repeat(500))).toHaveLength(300);
    expect(logDetail(undefined)).toBeUndefined();
  });
});
