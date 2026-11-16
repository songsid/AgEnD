import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedNativeModelCatalog, refreshNativeModelCatalogAfterSignIn } from "../src/native-model-catalog.js";

// A paired computer's sign-in earns one `models.refresh` for the admin who finished it; skipped quietly when it
// cannot be made. (A GET never reaches it: native-model-refresh-api-m2731 pins that.)
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
beforeEach(() => { vi.stubEnv("AGEND_REMOTE_RUNTIME", "1"); vi.stubEnv("AGEND_WINDOWS_CLI", "0"); });
afterEach(() => vi.unstubAllEnvs());

function rig() {
  const machines = new Map([A, B].map(id => [id, { id, platform: "win32", status: "online", generation: 1, approvedAt: 1, bootId: "first", runtimeInfo: { capabilities: ["model-catalog-refresh"] },
    inventory: { clis: [], credentialProfiles: { default: "work", profiles: [{ name: "work", loggedIn: true }] } } }]));
  const call = vi.fn(async (id: string, _op: string, p: any): Promise<any> => ({ cli: p.cli, profile: p.profile || "work", source: "account-api", models: [{ id: `model-${id}`, name: "Signed-in account" }] }));
  const win = (machine_id: string, profile?: string, backend = "claude-code") => ({ runtime: "windows", working_directory: "C:\\w", backend, machine_id, ...(profile ? { backend_options: { [backend]: { credential_profile: profile } } } : {}) });
  const ctx: any = { fleetConfig: { instances: { w: win(A, "work"), other: win(A, "personal"), elsewhere: win(B, "work"), codexOne: win(A, undefined, "codex") } },
    runtimeCoordinator: () => ({ machine: (id: string) => machines.get(id), callAccount: call }) };
  return { ctx, call, machines };
}
const run = (r: ReturnType<typeof rig>, extra: Record<string, unknown> = {}, admin = () => true) =>
  refreshNativeModelCatalogAfterSignIn(r.ctx, { backend: "claude-code", machineId: A, profile: "work", actor: "admin:0123456789abcdef", stillAdmin: admin, ...extra } as never);

describe("the one models.refresh after a computer's sign-in", () => {
  it("asks that computer's Runtime as the admin who finished it, for the agents on that CLI and account and the create dialog's list", async () => {
    const r = rig();
    expect(await run(r)).toBe(true);
    expect(r.call).toHaveBeenCalledTimes(2);
    for (const c of r.call.mock.calls) expect(c).toEqual([A, "models.refresh", { cli: "claude-code", profile: "work", actor: "admin:0123456789abcdef" }, 25000]);
    expect(cachedNativeModelCatalog(r.ctx, { backend: "claude-code", instance: "w" })?.models).toEqual([{ id: `model-${A}`, label: "Signed-in account" }]);
    // not another account's agent, another computer's, or another CLI's
    for (const name of ["other", "elsewhere", "codexOne"]) expect(cachedNativeModelCatalog(r.ctx, { backend: r.ctx.fleetConfig.instances[name].backend, instance: name })).toBeNull();
  });
  it("the default login (no profile) refreshes the agents with no account of their own", async () => {
    const r = rig(); r.ctx.fleetConfig.instances.plain = { runtime: "windows", working_directory: "C:\\w", backend: "claude-code", machine_id: A };
    await run(r, { profile: undefined });
    expect(r.call.mock.calls.map(c => c[2].profile)).toEqual(["", ""]);   // "": the computer's default account, for the agent without one and for the dialog's list
    expect(cachedNativeModelCatalog(r.ctx, { backend: "claude-code", instance: "plain" })).not.toBeNull();
  });
  it("is skipped quietly when the Runtime has no such capability", async () => {
    const r = rig(); r.machines.get(A)!.runtimeInfo.capabilities = [];
    expect(await run(r)).toBe(false); expect(r.call).not.toHaveBeenCalled();
  });
  it("is skipped quietly when the call fails or the computer is offline", async () => {
    const r = rig(); r.call.mockRejectedValue(new Error("runtime unreachable"));
    await expect(run(r)).resolves.toBe(false);
    const off = rig(); off.machines.get(A)!.status = "offline";
    await expect(run(off)).resolves.toBe(false); expect(off.call).not.toHaveBeenCalled();
  });
  it("an answer for another account is dropped, not shown", async () => {
    const r = rig(); r.call.mockResolvedValue({ cli: "claude-code", profile: "someone-else", source: "account-api", models: [{ id: "foreign" }] });
    expect(await run(r)).toBe(false);
    expect(cachedNativeModelCatalog(r.ctx, { backend: "claude-code", instance: "w" })).toBeNull();
  });
  it("stops when the admin session that signed in is gone", async () => {
    const r = rig();
    expect(await run(r, {}, () => false)).toBe(false); expect(r.call).not.toHaveBeenCalled();
  });
  it("a CLI or account without a remote refresh (a named account of a CLI other than Claude Code) is skipped", async () => {
    const r = rig();
    expect(await run(r, { backend: "codex", profile: "work" })).toBe(false);
  });
});
