/** Actual sealed HTTPS Hub and synthetic LDAPS only; capability is separate from enabled state and authority. */
import { afterEach, describe, expect, it, vi } from "vitest";
const dc = vi.hoisted(() => ({ port: 0 }));
vi.mock("node:tls", async original => { const real = await original<typeof import("node:tls")>(); return { ...real,
  connect: (options: import("node:tls").ConnectionOptions) => real.connect({ ...options, ...(options.host === "127.0.0.1" && options.port === 636 ? { port: dc.port } : {}) }) }; });
import { companyJoinRig } from "./support/hub-company-join-rig.js";
let rig: Awaited<ReturnType<typeof companyJoinRig>> | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; });
describe("B2 session mount capability", () => {
  it("offers the implementation to a signed-in admin even when creation is off; public metadata stays off", async () => {
    const r = rig = await companyJoinRig(port => { dc.port = port; }), admin = await r.signIn("alice");
    expect((await r.call(admin, "GET", "/hub/v1/session")).body.features).toContain("enrolment-code-v1");
    expect((await r.call(null, "GET", "/hub/v1/join/metadata")).body.features).not.toContain("enrolment-code-v1");
    expect((await r.call(admin, "GET", "/hub/v1/admin/enrolment-codes")).body.codes).toEqual([]);
    expect((await r.call(null, "GET", "/hub/v1/session")).body.features).toBeUndefined();
    const other = await r.signIn("dan"); expect((await r.call(other, "GET", "/hub/v1/admin/enrolment-codes")).status).toBe(403);
  });
});
