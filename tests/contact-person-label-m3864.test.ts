// M-3864 R7: Permissions' "Originating people", "Last cleared by" and the history named a web-verified admin by the bare
// account id (111222333) while the rest of the dashboard said their name. The label is their web name now (their own, else
// their chat account's), the id only when none is known; a person is still matched by platform and id.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/backend/index.js", async original => ({ ...await original<typeof import("../src/backend/index.js")>(), createBackend: () => { throw Error("No backend"); } }));
const { FleetManager } = await import("../src/fleet-manager.js");
const { sameContactPerson } = await import("../src/contact-auth-policy.js");

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const fleet = () => { const dir = mkdtempSync(join(tmpdir(), "agend-contact-label-")); dirs.push(dir); return new FleetManager(dir) as any; };

describe("M-3864 R7: a verified admin is named, not numbered", () => {
  it("their chat account's name once they signed in with it; their own web name when they chose one; else the id", () => {
    const fm = fleet();
    expect(fm.contactPersonLabel("tg", "111222333")).toBe("111222333");
    fm.noteWebSignIn({ adapterId: "tg", userId: "111222333", username: "owner" });
    expect(fm.contactPersonLabel("tg", "111222333")).toBe("owner");
    expect(fm.setWebPersonName({ adapterId: "tg", userId: "111222333" }, "Demo admin").ok).toBe(true);
    expect(fm.contactPersonLabel("tg", "111222333")).toBe("Demo admin");
    expect(fm.contactPersonLabel("tg", "999")).toBe("999");
    // Display only: the same person whatever their label says.
    expect(sameContactPerson({ platform: "telegram", adapterId: "tg", userId: "111222333", label: "Demo admin" },
      { platform: "telegram", adapterId: "tg", userId: "111222333", label: "111222333" })).toBe(true);
  });
});
