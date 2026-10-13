/**
 * #1525: every public-link failure draws on the step it belongs on — a
 * lease-held refusal on ④ (not ①), a request that ends before ⑥ on ⑥
 * (never on the successful ⑤). Fake lane/gateway/installer throughout: no
 * real trycloudflare tunnels (c1c1a427), no fleet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicWebLink } from "../src/public-web-link.js";
import { renderPublicLinkProgress, type PublicLinkProgress } from "../src/public-link-progress.js";
import type { TunnelHandle } from "../src/tunnel/types.js";
import { TunnelPurposeLane } from "../src/tunnel/purpose-lane.js";
import { setLocale, t } from "../src/locale.js";

vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: () => { throw Error("no processes"); }, execFileSync: () => { throw Error("no CLI"); }, execSync: () => { throw Error("no CLI"); } }));
const owner = { adapterId: "owner", userId: "admin", chatId: "G", threadId: "T", binding: {} };
const dirs: string[] = [];
function rig() {
  let now = 0, permitted = true, web: any = {};
  const dir = mkdtempSync(join(tmpdir(), "agend-1525-")); dirs.push(dir);
  const gateway = { listen: vi.fn(async () => new URL("http://127.0.0.1:9999")), setHost: vi.fn(), close: vi.fn(), readinessMarker: "fixture", server: {} };
  const handle: TunnelHandle = { provider: "fake", visibility: "public", baseUrl: "https://sample.trycloudflare.com", pageUrl: "https://sample.trycloudflare.com/signin", pid: 12, identity: "fake", stop: vi.fn(), onUnexpectedExit: () => vi.fn() };
  const manager = { start: vi.fn(async (_provider, context) => { context.onCandidateHost?.("sample.trycloudflare.com"); return { ok: true as const, handle }; }), stop: vi.fn(async () => ({ confirmed: true as const })) };
  const lane = new TunnelPurposeLane(manager);
  const ensure = vi.fn(async (_options: unknown) => ({ path: "/private/pinned", source: "agend" as const }));
  const publicLink = new PublicWebLink({ dataDir: dir, web: () => web, permitted: () => permitted, reserve: id => lane.reserve("dashboard", id),
    createGateway: () => gateway as never, ensure, provider: () => ({ name: "fake" }) as never, revoke: vi.fn(), log: vi.fn(), now: () => now, wallNow: () => 100_000 });
  return { publicLink, lane, manager, gateway, advance: (n: number) => { now += n; }, allow: (v: boolean) => { permitted = v; } };
}
beforeEach(() => { vi.useFakeTimers(); setLocale("en"); });
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.useRealTimers(); vi.restoreAllMocks(); });
const failedLine = (text: string) => text.split("\n").find(l => l.startsWith("❌"));

describe("#1525: failures draw on the step they belong on", () => {
  it("a lease-held refusal draws on ④, never on ①", async () => {
    const h = rig();
    // The lane is someone else's: hold it with a foreign reservation first.
    expect(h.lane.reserve("login", "other")).not.toBeNull();
    const seen: PublicLinkProgress[] = [];
    expect(await h.publicLink.deliver(owner, async () => true, p => { seen.push(p); })).toBe(false);
    const text = renderPublicLinkProgress(seen.at(-1)!, 0);
    expect(failedLine(text)).toContain(`❌ ④ ${t("dashboard.progress.tunnel")}`);
    expect(failedLine(text)).toContain(t("dashboard.progress.fail.lease-held"));
    expect(text).not.toMatch(/❌ ①/);
  });

  it("a request that ends before ⑥ begins draws on ⑥, and ⑤ stays ✅", async () => {
    const h = rig();
    const seen: PublicLinkProgress[] = [];
    // Lose currency exactly when the shared start completes: the completion
    // emission runs synchronously before this request's own ⑥ begins.
    const delivering = h.publicLink.deliver(owner, async () => true, p => {
      seen.push(p);
      if (!p.failed && p.steps.length > 0 && p.steps.every(s => s.endedAt !== undefined)) h.allow(false);
    });
    expect(await delivering).toBe(false);
    const text = renderPublicLinkProgress(seen.at(-1)!, 0);
    expect(failedLine(text)).toContain(`❌ ⑥ ${t("dashboard.progress.deliver")}`);
    expect(failedLine(text)).toContain(t("dashboard.progress.fail.closed"));
    expect(text).toContain(`✅ ⑤ ${t("dashboard.progress.address")}`);
    expect(text).not.toMatch(/❌ ⑤/);
  });

  it("a refused send still draws delivery-failed on ⑥ (no regression)", async () => {
    const h = rig();
    const seen: PublicLinkProgress[] = [];
    expect(await h.publicLink.deliver(owner, async () => false, p => { seen.push(p); })).toBe(false);
    const text = renderPublicLinkProgress(seen.at(-1)!, 0);
    expect(failedLine(text)).toContain(`❌ ⑥ ${t("dashboard.progress.deliver")}`);
    expect(failedLine(text)).toContain(t("dashboard.progress.fail.delivery-failed"));
  });

  it("a gateway failure still draws on ④ with no ⑥ failure (no regression)", async () => {
    const h = rig();
    h.gateway.listen.mockRejectedValueOnce(new Error("no listener"));
    const seen: PublicLinkProgress[] = [];
    expect(await h.publicLink.deliver(owner, async () => true, p => { seen.push(p); })).toBe(false);
    const text = renderPublicLinkProgress(seen.at(-1)!, 0);
    expect(failedLine(text)).toContain(`❌ ④ ${t("dashboard.progress.tunnel")}`);
    expect(failedLine(text)).toContain(t("dashboard.progress.fail.gateway-failed"));
    expect(text).not.toMatch(/❌ ⑥/);
  });
});
