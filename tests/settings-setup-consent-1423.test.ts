import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupHost } from "../src/setup-host.js";
import yaml from "js-yaml";
import { noteSettingsWrite } from "../src/settings-transaction.js";
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
  it.each([false, true])("receipt capture failure restores disk/runtime/env, including an existing YAML=%s", async existing => {
    const h = await harness(), path = join(h.dir, "fleet.yaml"), envPath = join(h.dir, ".env");
    const before = "# retain this exact formatting\ninstances: {}\ndefaults: {}\n";
    if (existing) writeFileSync(path, before);
    // A legal baseline becomes too large only after the approved token is added.
    const env = "#" + "x".repeat(524280) + "\n"; expect(Buffer.byteLength(env)).toBe(524282); writeFileSync(envPath, env);
    const pending = await setupHttp(h.port, h.path + "api/settings/quickstart/commit", "POST", setupPayload, h.cookie);
    expect(pending.status).toBe(202);
    const outcome = await decideSetup(h.dir, pending.body.pending_change.id);
    expect(outcome.pending_change.state).toBe("failed");
    expect(readFileSync(envPath, "utf8")).toBe(env);
    expect(existsSync(path)).toBe(existing); if (existing) expect(readFileSync(path, "utf8")).toBe(before);
    const config = (h.host as any).setupContext.fleetConfig;
    expect(config.instances).toEqual({}); expect(config.channels).toBeUndefined();
    expect((await setupHttp(h.port, h.path + "setup/status", "GET", undefined, h.cookie)).body.finish_ready).toBe(false);
    expect((await setupHttp(h.port, h.path + "setup/finish", "POST", undefined, h.cookie)).status).toBe(409); expect(h.spawnFleet).not.toHaveBeenCalled();
    if (!existing) {
      writeFileSync(envPath, "# now within the receipt bound\n");
      const retry = await setupHttp(h.port, h.path + "api/settings/quickstart/commit", "POST", { ...setupPayload, idempotency_key: "after-receipt-failure" }, h.cookie);
      expect(retry.status).toBe(202); expect((await decideSetup(h.dir, retry.body.pending_change.id)).pending_change.state).toBe("applied");
      expect((h.host as any).setupContext.fleetConfig.instances).toHaveProperty("agent-1");
      expect((await setupHttp(h.port, h.path + "setup/status", "GET", undefined, h.cookie)).body.finish_ready).toBe(true);
      expect(h.spawnFleet).not.toHaveBeenCalled();
    }
  });
  it.each(["different bytes", "same-byte revision"])("failed receipt cannot compensate over a newer YAML writer: %s", async kind => {
    const h = await harness(), path = join(h.dir, "fleet.yaml");
    const pending = await setupHttp(h.port, h.path + "api/settings/quickstart/commit", "POST", setupPayload, h.cookie);
    const context = (h.host as any).setupContext; let retained = "";
    context.settingsCommitted = () => {
      const written = readFileSync(path, "utf8"), current = yaml.load(written) as any;
      if (kind === "different bytes") {
        current.defaults.model = "later-writer"; retained = yaml.dump(current); writeFileSync(path, retained);
      } else {
        retained = written; noteSettingsWrite(path, current, current); writeFileSync(path, retained);
      }
      throw new Error("inert receipt failure");
    };
    const outcome = await decideSetup(h.dir, pending.body.pending_change.id);
    expect(outcome.pending_change.state).toBe("failed");
    expect(existsSync(path)).toBe(true); expect(readFileSync(path, "utf8")).toBe(retained); expect(existsSync(join(h.dir, ".env"))).toBe(false);
    expect((await setupHttp(h.port, h.path + "setup/finish", "POST", undefined, h.cookie)).status).toBe(409); expect(h.spawnFleet).not.toHaveBeenCalled();
  });
  it("Setup preflights the resulting YAML receipt bound before replacing the file", async () => {
    const h = await harness(), context = (h.host as any).setupContext;
    context.fleetConfig.defaults.model = "x".repeat(512 * 1024);
    expect(() => context.saveFleetConfig()).toThrow("settings_baseline_too_large");
    expect(existsSync(join(h.dir, "fleet.yaml"))).toBe(false);
  });
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
  it.each(["fleet.yaml", ".env"])("a later %s edit before replay settlement never becomes an approved Setup receipt", async filename => {
    const h = await harness();
    const pending = await setupHttp(h.port, h.path + "api/settings/quickstart/commit", "POST", setupPayload, h.cookie);
    const context = (h.host as any).setupContext;
    vi.spyOn(context.logger, "info").mockImplementation(() => {
      const path = join(h.dir, filename);
      if (filename === ".env") writeFileSync(path, "AGEND_BOT_TOKEN=later-unapproved-token\n");
      else {
        const cfg: any = yaml.load(readFileSync(path, "utf8")); cfg.channels[0].access.allowed_users = ["99"];
        writeFileSync(path, yaml.dump(cfg));
      }
    });
    expect((await decideSetup(h.dir, pending.body.pending_change.id)).pending_change.state).toBe("applied");
    expect((await setupHttp(h.port, h.path + "setup/status", "GET", undefined, h.cookie)).body.finish_ready).toBe(false);
    expect((await setupHttp(h.port, h.path + "setup/finish", "POST", undefined, h.cookie)).status).toBe(409);
    expect(h.spawnFleet).not.toHaveBeenCalled();
  });
  it("same-session reload can discover finish readiness without starting; pending polling remains passive", async () => {
    const h = await harness(), touch = vi.spyOn(h.host as any, "touch");
    expect((await setupHttp(h.port, h.path + "setup/status", "GET", undefined, h.cookie)).body.finish_ready).toBe(false);
    await confirmedSetup(h.dir, h.port, h.path, h.cookie);
    const calls = touch.mock.calls.length;
    expect((await setupHttp(h.port, h.path + "api/settings/pending", "GET", undefined, h.cookie)).body).toEqual([]);
    expect(touch.mock.calls).toHaveLength(calls);
    expect((await setupHttp(h.port, h.path + "setup/status", "GET", undefined, h.cookie)).body.finish_ready).toBe(true);
    expect(touch.mock.calls).toHaveLength(calls + 1); expect(h.spawnFleet).not.toHaveBeenCalled();
    expect((await setupHttp(h.port, h.path + "setup/status", "GET")).status).toBe(401);
    expect((await setupHttp(h.port, h.path + "setup/finish", "POST", undefined, h.cookie)).status).toBe(202);
    await h.host.shutdown(true, "explicit start"); expect(h.spawnFleet).toHaveBeenCalledOnce();
  });
  it("a disk change after the asynchronous readiness check is rejected at actual finish admission", async () => {
    const h = await harness(); await confirmedSetup(h.dir, h.port, h.path, h.cookie);
    const native = (h.host as any).finishReady.bind(h.host); let release!: () => void, checked = false;
    const hold = new Promise<void>(yes => { release = yes; });
    vi.spyOn(h.host as any, "finishReady").mockImplementation(async () => { const result = await native(); checked = true; await hold; return result; });
    const finish = setupHttp(h.port, h.path + "setup/finish", "POST", undefined, h.cookie);
    await vi.waitFor(() => expect(checked).toBe(true)); writeFileSync(join(h.dir, ".env"), "AGEND_BOT_TOKEN=changed-after-check\n"); release();
    expect((await finish).status).toBe(409); expect(h.spawnFleet).not.toHaveBeenCalled();
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
  let result: unknown;
  try { expect(context.signal.aborted).toBe(true); await new Promise(resolve => setImmediate(resolve)); expect((host as any).lock).toBeDefined(); }
  finally { release(); result = await starting; await stopped; }
  expect(result).toBeInstanceOf(Error);
  expect(stop).toHaveBeenCalledOnce(); expect((host as any).lock).toBeUndefined(); expect((host as any).externalHost).toBeNull();
});
