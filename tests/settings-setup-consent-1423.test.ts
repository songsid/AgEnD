import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupHost } from "../src/setup-host.js";
import { setupHttp, setupPayload, decideSetup, confirmedSetup } from "./helpers/setup-confirmation-1423.js";

const fixtures: { host: SetupHost; dir: string }[] = [];
afterEach(async () => { for (const { host, dir } of fixtures.splice(0)) { await host.shutdown(false, "test cleanup"); rmSync(dir, { recursive: true, force: true }); } vi.restoreAllMocks(); });
async function harness() {
  const dir = mkdtempSync(join(tmpdir(), "agend-test-setup-consent-")), spawnFleet = vi.fn(), logs: string[] = [];
  const host = new SetupHost({ dataDir: dir, configPath: join(dir, "fleet.yaml"), port: 0, spawnFleet, log: message => logs.push(message) });
  fixtures.push({ host, dir });
  const { port, path, code } = await host.start();
  const signed = await setupHttp(port, path + "open", "POST", { code });
  const cookie = String(signed.headers["set-cookie"]).split(";")[0]!;
  return { host, dir, port, path, cookie, spawnFleet, logs };
}
describe("#1423 real no-fleet SetupHost consent", () => {
  it("a pending 202 writes nothing and cannot finish; host confirmation applies once", async () => {
    const h = await harness();
    expect((await setupHttp(h.port, h.path + "setup/finish", "POST", undefined, h.cookie)).status).toBe(409);
    const pending = await setupHttp(h.port, h.path + "api/settings/quickstart/commit", "POST", setupPayload, h.cookie);
    expect(pending.status).toBe(202); expect(existsSync(join(h.dir, ".env"))).toBe(false); expect(existsSync(join(h.dir, "fleet.yaml"))).toBe(false);
    expect((await setupHttp(h.port, h.path + "setup/finish", "POST", undefined, h.cookie)).status).toBe(409);
    const outcome = await decideSetup(h.dir, pending.body.pending_change.id);
    expect(outcome.pending_change.state).toBe("applied"); expect(readFileSync(join(h.dir, ".env"), "utf8")).toContain(setupPayload.token);
    const written = readFileSync(join(h.dir, ".env"), "utf8");
    await expect(decideSetup(h.dir, pending.body.pending_change.id)).rejects.toThrow();
    expect(readFileSync(join(h.dir, ".env"), "utf8")).toBe(written);
    expect(h.spawnFleet).not.toHaveBeenCalled();
    expect(JSON.stringify(pending.body) + JSON.stringify(outcome) + h.logs.join("\n")).not.toContain(setupPayload.token);
    const finish = await setupHttp(h.port, h.path + "setup/finish", "POST", undefined, h.cookie); expect(finish.status).toBe(202);
    await h.host.shutdown(true, "finished"); expect(h.spawnFleet).toHaveBeenCalledOnce();
  });
  it("reject/withdraw does not write and a deliberate new submission can be confirmed", async () => {
    const h = await harness();
    const pending = await setupHttp(h.port, h.path + "api/settings/quickstart/commit", "POST", { ...setupPayload, idempotency_key: "first" }, h.cookie);
    expect((await decideSetup(h.dir, pending.body.pending_change.id, "reject")).pending_change.state).toBe("rejected");
    expect(existsSync(join(h.dir, ".env"))).toBe(false);
    const second = await setupHttp(h.port, h.path + "api/settings/quickstart/commit", "POST", { ...setupPayload, idempotency_key: "second" }, h.cookie);
    expect(second.body.pending_change.id).not.toBe(pending.body.pending_change.id);
    const withdrawn = await setupHttp(h.port, h.path + "api/settings/pending/" + second.body.pending_change.id, "DELETE", undefined, h.cookie);
    expect(withdrawn.body.state).toBe("rejected"); expect(existsSync(join(h.dir, ".env"))).toBe(false);
  });
  it("pending polling is passive, and shutdown disables host confirmation before cleanup", async () => {
    const h = await harness(), touch = vi.spyOn(h.host as any, "touch");
    const pending = await setupHttp(h.port, h.path + "api/settings/quickstart/commit", "POST", setupPayload, h.cookie);
    const calls = touch.mock.calls.length;
    expect((await setupHttp(h.port, h.path + "api/settings/pending/" + pending.body.pending_change.id, "GET", undefined, h.cookie)).status).toBe(200);
    expect(touch.mock.calls).toHaveLength(calls);
    const a = h.host.shutdown(true, "unconfirmed handover"), b = h.host.shutdown(true, "again"); expect(a).toBe(b);
    await a; expect(h.spawnFleet).not.toHaveBeenCalled(); expect(existsSync(join(h.dir, ".env"))).toBe(false);
    await expect(decideSetup(h.dir, pending.body.pending_change.id)).rejects.toThrow();
  });
  it("a confirmed config changed afterwards cannot hand over", async () => {
    const h = await harness(); await confirmedSetup(h.dir, h.port, h.path, h.cookie);
    writeFileSync(join(h.dir, "fleet.yaml"), "instances: {}\ndefaults: {}\n");
    expect((await setupHttp(h.port, h.path + "setup/finish", "POST", undefined, h.cookie)).status).toBe(409);
    expect(h.spawnFleet).not.toHaveBeenCalled();
  });
});

it("shutdown aborts and joins a held tunnel start before releasing its singleton", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agend-test-setup-held-tunnel-")); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), stop = vi.fn(async () => ({ confirmed: true as const })); let context: any;
  const provider: any = { name: "fake", preflight: async () => ({ ok: true, binaryPath: "/inert" }), start: vi.fn(async (ctx: any) => {
    context = ctx; await held; ctx.onCandidateHost?.("late.trycloudflare.com");
    return { provider: "fake", visibility: "public", baseUrl: "https://late.trycloudflare.com", pageUrl: "https://late.trycloudflare.com/page", pid: 4242, identity: "linux:111", stop, onUnexpectedExit: vi.fn() };
  }) };
  const host = new SetupHost({ dataDir: dir, configPath: join(dir, "fleet.yaml"), port: 0, tunnel: true, tunnelProvider: provider, spawnFleet: vi.fn() }); fixtures.push({ host, dir });
  const starting = host.start().catch((err: Error) => err);
  await vi.waitFor(() => expect(provider.start).toHaveBeenCalledOnce()); const stopped = host.shutdown(false, "cancelled");
  expect(context.signal.aborted).toBe(true); await new Promise(resolve => setImmediate(resolve)); expect((host as any).lock).toBeDefined();
  release(); expect(await starting).toBeInstanceOf(Error); await stopped;
  expect(stop).toHaveBeenCalledOnce(); expect((host as any).lock).toBeUndefined(); expect((host as any).externalHost).toBeNull();
});
