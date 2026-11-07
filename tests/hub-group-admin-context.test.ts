/** Real callback/lifetime fences only: no directory, listener, account or fleet operations. */
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createHubGroupAdminBoundary } from "../src/hub/group-policy/admin-context.js";
import type { GroupAdminContext } from "../src/hub/group-policy/admin-dto.js";
import type { HubActor } from "../src/hub/types.js";

const key = () => ({ realm: "example", objectId: randomUUID() });
function world() {
  const administrator = key(); let server = true, session = true;
  const actor: HubActor = { kind: "directory", person: { ...administrator }, sessionId: randomUUID() };
  const requireAdmin = vi.fn(async (): Promise<HubActor> => actor);
  const ctx: GroupAdminContext = { requestId: randomUUID(), current: () => session, requireAdmin };
  const boundary = createHubGroupAdminBoundary({ administrator, current: () => server });
  return { administrator, actor, requireAdmin, ctx, boundary, serverOff: () => { server = false; }, signOut: () => { session = false; } };
}
function held<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

describe("group-policy administrator context", () => {
  it("authenticates the configured immutable directory administrator and snapshots the returned actor", async () => {
    const w = world(), accepted = await w.boundary.begin(w.ctx);
    expect(accepted.actor).toEqual(w.actor); expect(w.requireAdmin).toHaveBeenCalledOnce();
    (w.actor as { person: { objectId: string } }).person.objectId = randomUUID();
    expect(accepted.actor.person.objectId).toBe(w.administrator.objectId);
    expect(accepted.ctx.requestId).toBe(w.ctx.requestId);
  });
  it.each(["other-person", "local-host"])("refuses %s, even when its callback claims an admin", async kind => {
    const w = world();
    w.requireAdmin.mockResolvedValue(kind === "local-host" ? { kind: "local-host", sessionId: randomUUID(), directoryBinding: w.administrator }
      : { kind: "directory", person: key(), sessionId: randomUUID() });
    await expect(w.boundary.begin(w.ctx)).rejects.toMatchObject({ code: "denied" });
  });
  it("keeps the configured key independent of later caller-owned replacement", async () => {
    const w = world(), gate = held<HubActor>(); w.requireAdmin.mockReturnValueOnce(gate.promise);
    const pending = w.boundary.begin(w.ctx); w.administrator.objectId = randomUUID(); gate.resolve(w.actor);
    await expect(pending).resolves.toHaveProperty("actor.sessionId", w.actor.sessionId);
  });
  it.each(["session", "server", "close"])("withholds a held admin result after %s is fenced", async kind => {
    const w = world(), gate = held<HubActor>(); w.requireAdmin.mockReturnValueOnce(gate.promise);
    const pending = w.boundary.begin(w.ctx);
    if (kind === "session") w.signOut(); else if (kind === "server") w.serverOff(); else w.boundary.close();
    gate.resolve(w.actor); await expect(pending).rejects.toMatchObject({ code: "unavailable" });
  });
  it("captures callbacks before waiting and re-authenticates through those callbacks", async () => {
    const w = world(), gate = held<HubActor>(); w.requireAdmin.mockReturnValueOnce(gate.promise);
    const pending = w.boundary.begin(w.ctx);
    w.ctx.requireAdmin = vi.fn(async () => { throw Error("replacement must not run"); });
    w.ctx.current = () => { throw Error("replacement must not run"); };
    gate.resolve(w.actor); const accepted = await pending;
    await expect(w.boundary.authenticate(accepted.ctx)).resolves.toEqual(w.actor);
    expect(w.requireAdmin).toHaveBeenCalledTimes(2);
    w.signOut(); expect(() => w.boundary.assertCurrent(accepted.ctx)).toThrow();
  });
  it("close is permanent and refuses before invoking a later authentication callback", async () => {
    const w = world(); w.boundary.close();
    await expect(w.boundary.begin(w.ctx)).rejects.toMatchObject({ code: "unavailable" });
    expect(w.requireAdmin).not.toHaveBeenCalled();
  });
  it("does not re-authenticate or assert an uncaptured context", async () => {
    const w = world();
    await expect(w.boundary.authenticate(w.ctx)).rejects.toMatchObject({ code: "unavailable" });
    expect(() => w.boundary.assertCurrent(w.ctx)).toThrow(); expect(w.requireAdmin).not.toHaveBeenCalled();
  });
  it("treats an unreadable current session as unavailable", async () => {
    const w = world(); w.ctx.current = () => { throw Error("private session detail"); };
    await expect(w.boundary.begin(w.ctx)).rejects.toMatchObject({ code: "unavailable" });
    expect(w.requireAdmin).not.toHaveBeenCalled();
  });
});
