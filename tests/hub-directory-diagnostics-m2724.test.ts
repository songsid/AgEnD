/**
 * M-2724 (the pilot Hub on alpha.9): a failed group add left no trace in the Hub's log — only the setup wizard wired the
 * directory's diagnostics. The running Hub now logs which call failed and at which step, never the server's text (it can
 * repeat a DN or a login); ordinary answers are not failures and are not logged. And the resolve route hands the page the
 * step name, so it can say what to try.
 */
import { describe, expect, it, vi } from "vitest";
import { hubDirectoryDiagnostics } from "../src/hub/runtime.js";
import { handleGroupHttp, type GroupHttpDeps } from "../src/hub/group-policy/admin-api.js";

describe("the running Hub's directory diagnostics (M-2724)", () => {
  it("logs a failed call with its op, outcome and step only", () => {
    const log = vi.fn(), sink = hubDirectoryDiagnostics(log);
    sink({ op: "group-lookup", outcome: "unknown", failure: "lookup" });
    sink({ op: "group-membership", outcome: "unknown", failure: "unreachable", error: "Error: CN=Secret,DC=example,DC=test" } as never);
    sink({ op: "sign-in", outcome: "unavailable", error: "InvalidCredentialsError: 80090308 user=someone" });
    expect(log.mock.calls).toEqual([
      ["warn", "Hub directory call failed", { op: "group-lookup", outcome: "unknown", failure: "lookup" }],
      ["warn", "Hub directory call failed", { op: "group-membership", outcome: "unknown", failure: "unreachable" }],
      ["warn", "Hub directory call failed", { op: "sign-in", outcome: "unavailable" }],
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/CN=|someone|8009/);
  });
  it("ordinary answers (wrong password, disabled, not eligible) are not logged", () => {
    const log = vi.fn(), sink = hubDirectoryDiagnostics(log);
    for (const outcome of ["invalid-credentials", "not-eligible", "disabled", "gone", "bad-input"]) sink({ op: "sign-in", outcome });
    expect(log).not.toHaveBeenCalled();
  });
});

describe("POST /hub/v1/admin/group-policy/resolve keeps the step name (M-2724)", () => {
  const call = async (answer: unknown) => {
    let sent: [number, unknown] | null = null;
    const deps = { control: { resolve: async () => answer }, welcome: async () => ({}) } as unknown as GroupHttpDeps;
    await handleGroupHttp(deps, { path: "/hub/v1/admin/group-policy/resolve", method: "POST",
      ctx: { requestId: "r", current: () => true, requireAdmin: async () => ({ kind: "local-host" }) as never, requirePerson: async () => ({ realm: "x", objectId: "y" }) },
      signedIn: () => true, csrf: () => true, body: async () => ({ dn: "CN=G,DC=example,DC=test" }), send: (status, body) => { sent = [status, body]; } });
    return sent;
  };
  it("unknown with a failure: 200 { reason, failure }; other refusals unchanged", async () => {
    expect(await call({ ok: false, reason: "unknown", failure: "service-sign-in" })).toEqual([200, { reason: "unknown", failure: "service-sign-in" }]);
    expect(await call({ ok: false, reason: "unknown" })).toEqual([200, { reason: "unknown" }]);
    expect(await call({ ok: false, reason: "not-found" })).toEqual([200, { reason: "not-found" }]);
  });
});
