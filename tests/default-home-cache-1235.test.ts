import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userInfo } from "node:os";
import { createHash } from "node:crypto";

vi.mock("node:os", async importOriginal => ({ ...await importOriginal<typeof import("node:os")>(), userInfo: vi.fn() }));
const account = (homedir: string) => ({ homedir, username: "fixture", uid: 123, gid: 123, shell: "/bin/false" });
const lookup = vi.mocked(userInfo);
const suffix = (home: string) => `agend-${createHash("sha256").update(home).digest("hex").slice(0, 6)}`;
beforeEach(() => { vi.resetModules(); lookup.mockReset(); lookup.mockReturnValue(account("/private/verified-user")); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("verified OS home cache", () => {
  it("reads the verified home once across frequent socket and session getters", async () => {
    const p = await import("../src/paths.js"); vi.stubEnv("AGEND_HOME", "/private/fleet");
    for (let i = 0; i < 100; i++) {
      expect(p.getTmuxSocketName()).toBe(suffix("/private/fleet"));
      expect(p.getTmuxSessionName()).toBe(suffix("/private/fleet"));
    }
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("never trusts a moved HOME, and still reacts to AGEND_HOME changes", async () => {
    const p = await import("../src/paths.js");
    expect(p.realDefaultAgendHome()).toBe("/private/verified-user/.agend");
    vi.stubEnv("HOME", "/private/scratch"); vi.stubEnv("AGEND_HOME", "/private/scratch/.agend");
    expect(p.getTmuxSocketName()).toBe(suffix("/private/scratch/.agend"));
    expect(p.isDefaultAgendHome()).toBe(false);
    vi.stubEnv("AGEND_HOME", "/private/verified-user/.agend");
    expect(p.getTmuxSocketName()).toBeNull(); expect(p.getTmuxSessionName()).toBe("agend");
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("does not cache a failed lookup or use HOME as its fallback", async () => {
    const p = await import("../src/paths.js");
    vi.stubEnv("HOME", "/private/scratch"); vi.stubEnv("AGEND_HOME", "/private/scratch/.agend");
    lookup.mockImplementationOnce(() => { throw Error("NSS unavailable"); });
    expect(p.realDefaultAgendHome()).toBeNull();
    expect(p.realDefaultAgendHome()).toBe("/private/verified-user/.agend");
    expect(p.getTmuxSocketName()).toBe(suffix("/private/scratch/.agend"));
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it.skipIf(!process.getuid)("a changed OS user cannot reuse the prior user's verified home", async () => {
    let uid = 123; vi.spyOn(process, "getuid").mockImplementation(() => uid);
    const p = await import("../src/paths.js");
    expect(p.realDefaultAgendHome()).toBe("/private/verified-user/.agend");
    uid = 456; lookup.mockImplementationOnce(() => { throw Error("new UID missing"); });
    expect(p.realDefaultAgendHome()).toBeNull();
    lookup.mockReturnValue(account("/private/second-user"));
    expect(p.realDefaultAgendHome()).toBe("/private/second-user/.agend");
    expect(p.realDefaultAgendHome()).toBe("/private/second-user/.agend");
    expect(lookup).toHaveBeenCalledTimes(3);
  });
});
