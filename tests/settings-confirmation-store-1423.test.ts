import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { SettingsConfirmationStore, SETTINGS_CONFIRMATION_TTL_MS, type SettingsChangeProposal, type SettingsPendingView } from "../src/settings-confirmation.js";

describe("#1423 pending confirmation owner (no fleet or adapter)", () => {
  let now: number, wall: number;
  let audit: Mock<(event: string, fields: Record<string, unknown>) => void>, notify: Mock<(view: SettingsPendingView) => void>;
  let store: SettingsConfirmationStore;
  const stores: SettingsConfirmationStore[] = [];
  beforeEach(() => {
    vi.useFakeTimers(); now = 0; wall = 1_000_000; audit = vi.fn(); notify = vi.fn();
    store = new SettingsConfirmationStore({ now: () => now, wallNow: () => wall, audit, notify }); stores.push(store);
  });
  afterEach(() => { for (const s of stores.splice(0)) s.close(); vi.useRealTimers(); });
  function proposal(overrides: Partial<SettingsChangeProposal> = {}): SettingsChangeProposal {
    return { session: "authenticated-session", key: "apply-key", fingerprint: "immutable-operation-hash", section: "access",
      requestedBy: "session handle", source: "web_session", summary: ["allowed_users count: 0 → 1"], bytes: 10,
      current: () => true, unchanged: async () => true, apply: vi.fn(async () => ({ ok: true, job_id: "apply-job" })), discard: vi.fn(), ...overrides };
  }
  const admin = () => ({ label: "Admin 99", current: () => true });

  it("never executes on proposal or notification; one admin confirm runs the original effect", async () => {
    const p = proposal(); const { view } = store.propose(p); await Promise.resolve();
    expect(view.state).toBe("pending"); expect(p.apply).not.toHaveBeenCalled(); expect(notify).toHaveBeenCalledTimes(1);
    const done = await store.decide(view.id, "confirm", admin());
    expect(p.apply).toHaveBeenCalledTimes(1); expect(done.state).toBe("applied");
    expect(done.outcome?.result).toEqual({ ok: true, job_id: "apply-job" }); expect(p.discard).toHaveBeenCalledTimes(1);
    await expect(store.decide(view.id, "confirm", admin())).rejects.toThrow("confirmation_not_pending");
  });
  it("an unauthorised click leaves the pending operation available for the real admin", async () => {
    const p = proposal(); const { view } = store.propose(p);
    await expect(store.decide(view.id, "confirm", { label: "user", current: () => false })).rejects.toThrow("admin_required");
    expect(p.apply).not.toHaveBeenCalled(); expect(store.get(view.id, p.session)?.state).toBe("pending");
    expect((await store.decide(view.id, "confirm", admin())).state).toBe("applied");
  });
  it("reject and requester withdrawal never execute, release the payload and retire buttons", async () => {
    const p = proposal(); const { view } = store.propose(p); const retire = vi.fn(); store.attachPrompt(view.id, retire);
    expect((await store.decide(view.id, "reject", admin())).state).toBe("rejected");
    expect(retire).toHaveBeenCalledTimes(1); expect(p.discard).toHaveBeenCalledTimes(1); expect(p.apply).not.toHaveBeenCalled();
    const other = proposal({ key: "other" }); const pending = store.propose(other).view;
    expect(store.withdraw(pending.id, "foreign-session")).toBeNull();
    expect(store.withdraw(pending.id, other.session)?.outcome?.reason_code).toBe("withdrawn");
    expect(other.apply).not.toHaveBeenCalled(); expect(other.discard).toHaveBeenCalledTimes(1);
  });
  it("an exact monotonic deadline rejects even when the expiry timer has not run", async () => {
    const p = proposal(); const { view } = store.propose(p); now = SETTINGS_CONFIRMATION_TTL_MS;
    await expect(store.decide(view.id, "confirm", admin())).rejects.toThrow("confirmation_not_pending");
    expect(store.get(view.id, p.session)?.state).toBe("expired"); expect(p.apply).not.toHaveBeenCalled();
    expect(p.discard).toHaveBeenCalledTimes(1); expect(audit.mock.calls.filter(([e]) => e === "expired")).toHaveLength(1);
  });
  it("wall clock jumps never change the pending admission budget", async () => {
    const p = proposal(); const { view } = store.propose(p); wall += 100 * SETTINGS_CONFIRMATION_TTL_MS;
    now = SETTINGS_CONFIRMATION_TTL_MS - 1;
    expect(store.get(view.id, p.session)?.remaining_ms).toBe(1);
    expect((await store.decide(view.id, "confirm", admin())).state).toBe("applied");
  });
  it("a shorter verification lifetime is not extended by the pending operation", async () => {
    const p = proposal({ remainingMs: 123.5 }); const { view } = store.propose(p); now = 123.5;
    await expect(store.decide(view.id, "confirm", admin())).rejects.toThrow("confirmation_not_pending");
    expect(p.apply).not.toHaveBeenCalled();
  });
  it("same-session idempotent retry keeps the id and prompt; changed bytes get a conflict", async () => {
    const p = proposal(); const a = store.propose(p); const b = store.propose(proposal()); await Promise.resolve();
    expect(b.reused).toBe(true); expect(b.view.id).toBe(a.view.id); expect(notify).toHaveBeenCalledTimes(1);
    expect(() => store.propose(proposal({ fingerprint: "different-operation" }))).toThrow("idempotency_key_reused");
    const foreign = store.propose(proposal({ session: "another-session" })); expect(foreign.view.id).not.toBe(a.view.id);
    expect(store.get(a.view.id, "another-session")).toBeNull(); expect(store.list(p.session)).toHaveLength(1);
  });
  it("claims synchronously: a host/chat race cannot start two effects", async () => {
    let release!: (v: boolean) => void;
    const p = proposal({ unchanged: () => new Promise(resolve => { release = resolve; }) });
    const { view } = store.propose(p); const first = store.decide(view.id, "confirm", admin());
    expect(store.get(view.id, p.session)?.state).toBe("applying");
    await expect(store.decide(view.id, "confirm", admin())).rejects.toThrow("confirmation_not_pending");
    release(true); expect((await first).state).toBe("applied"); expect(p.apply).toHaveBeenCalledTimes(1);
  });
  it.each(["session", "admin", "deadline", "configuration"])("drops a stale %s after the fingerprint await", async reason => {
    let session = true, authority = true, release!: (v: boolean) => void;
    const p = proposal({ current: () => session, unchanged: () => new Promise(resolve => { release = resolve; }) });
    const { view } = store.propose(p);
    const result = store.decide(view.id, "confirm", { label: "Admin 99", current: () => authority });
    if (reason === "session") session = false;
    if (reason === "admin") authority = false;
    if (reason === "deadline") now = SETTINGS_CONFIRMATION_TTL_MS;
    release(reason !== "configuration");
    expect((await result).state).toBe("stale"); expect(p.apply).not.toHaveBeenCalled();
  });
  it("shutdown fences pending and claimed operations before a held await returns", async () => {
    let release!: (v: boolean) => void;
    const p = proposal({ unchanged: () => new Promise(resolve => { release = resolve; }) });
    const { view } = store.propose(p); const result = store.decide(view.id, "confirm", admin());
    store.close(); release(true);
    expect((await result).state).toBe("stale"); expect(p.apply).not.toHaveBeenCalled();
    expect(p.discard).toHaveBeenCalledTimes(1); expect(() => store.propose(proposal())).toThrow("request_no_longer_current");
  });
  it("late prompt ACK cannot rearm an expired, withdrawn or stopped proposal", () => {
    const { view } = store.propose(proposal()); now = SETTINGS_CONFIRMATION_TTL_MS;
    const retire = vi.fn(); expect(store.attachPrompt(view.id, retire)).toBe(false); expect(retire).toHaveBeenCalledTimes(1);
    expect(store.get(view.id, "authenticated-session")?.state).toBe("expired");
  });
  it("limits pending count/bytes and never evicts live approvals to make room", () => {
    for (let i = 0; i < 8; i++) store.propose(proposal({ key: String(i) }));
    expect(() => store.propose(proposal({ key: "ninth" }))).toThrow("too_many_pending_changes");
    expect(store.list("authenticated-session")).toHaveLength(8);
    expect(() => store.propose(proposal({ session: "other", bytes: 5 * 1024 * 1024 }))).toThrow("too_many_pending_changes");
  });
  it("views are copied and audit fields contain no secret or operation body", async () => {
    const secret = "private-provider-secret-DO-NOT-SURFACE";
    const p = proposal({ section: "secret", summary: ["PROVIDER_API_KEY: fingerprint 0123456789ab"], apply: vi.fn(async () => { void secret; return { job_id: "safe-job" }; }) });
    const { view } = store.propose(p); (view.summary as string[]).push(secret); view.confirmation.kind = "chat";
    expect(store.get(view.id, p.session)?.summary).not.toContain(secret);
    expect(store.get(view.id, p.session)?.confirmation.kind).toBe("host_cli");
    await store.decide(view.id, "reject", admin());
    expect(JSON.stringify(audit.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(audit.mock.calls)).not.toContain("immutable-operation-hash");
  });
});

it("the final CAS await cannot adopt a newer snapshot as its admission baseline", async () => {
  let revision = 0; const apply = vi.fn(), store = new SettingsConfirmationStore({ audit: vi.fn() });
  try {
    const view = store.propose({ session: "s", key: "racy", bytes: 1, fingerprint: "effect", source: "web_session", section: "access", requestedBy: "browser", summary: ["add F ID 42"], current: () => true,
      snapshot: () => revision, unchanged: async () => { queueMicrotask(() => { revision++; }); return true; }, apply }).view;
    const outcome = await store.decide(view.id, "confirm", { label: "F", current: () => true });
    expect(outcome.state).toBe("stale"); expect(apply).not.toHaveBeenCalled();
  } finally { store.close(); }
});
