/**
 * AGEND-250: the fixes for the upstream review of #3771 (Prism, REQUEST_CHANGES), one describe per item. Every positive control sits next to its negative one, and each negative was run against the
 * original head to see it fail. Fixture strings only; no account, no token, no real `agy`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialProfileHome } from "../src/backend/credential-profile.js";
import { createStructuredSignInTransport } from "../src/structured-signin-transport.js";

const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-250-")); dirs.push(d); return d; };
const savedAgend = process.env.AGEND_HOME, savedGemini = process.env.GEMINI_HOME;
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedAgend === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = savedAgend;
  if (savedGemini === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = savedGemini;
});
const TOKEN = "antigravity-oauth-token";
function world(profiles: string[] = ["work"]) {
  const data = scratch(), gemini = join(scratch(), "gemini");
  mkdirSync(join(gemini, "antigravity-cli"), { recursive: true });
  process.env.GEMINI_HOME = gemini; process.env.AGEND_HOME = data;
  const home = (p: string) => credentialProfileHome(data, "antigravity", p);
  for (const p of profiles) mkdirSync(home(p), { recursive: true, mode: 0o700 });
  return { data, gemini, home };
}

describe("P2-1: the post-login isolation proof is this attempt's, not an old token file (host transport)", () => {
  const rig = (w: ReturnType<typeof world>) => {
    const native = { start: async () => {}, capture: async () => "", paneStatus: async () => ({ alive: false, exitCode: 0 }), sendInput: async () => {}, kill: async () => {} };
    return createStructuredSignInTransport({ native: native as never, env: { HOME: "/home/x", PATH: "/usr/bin" }, backend: "antigravity", dataDir: w.data });
  };
  const OLD = "FIXTURE-EXPIRED-NOT-A-TOKEN";
  it("an expired file left in the folder, untouched by the login (pin ignored, login went to the shared store): `isolated: false`, and the old file is still there", async () => {
    const w = world(), file = join(w.home("work"), TOKEN); writeFileSync(file, OLD);
    const t = rig(w); await t.start({ argv: ["agy", "acp", "--login"], profile: "work" }, new AbortController().signal);
    expect(await t.status()).toMatchObject({ alive: false, exitCode: 0, isolated: false });
    expect(readFileSync(file, "utf8")).toBe(OLD);
    await t.close();
  });
  it("a rewrite of the same bytes (a new modification time) is a write by this attempt", async () => {
    const w = world(), file = join(w.home("work"), TOKEN); writeFileSync(file, OLD);
    const t = rig(w); await t.start({ argv: ["agy", "acp", "--login"], profile: "work" }, new AbortController().signal);
    const later = new Date(Date.now() + 5000); writeFileSync(file, OLD); utimesSync(file, later, later);
    expect(await t.status()).toEqual({ alive: false, exitCode: 0 });
    await t.close();
  });
  it("positive controls: no file before and one after; an old file replaced by the login", async () => {
    for (const seed of [false, true]) {
      const w = world(), file = join(w.home("work"), TOKEN); if (seed) writeFileSync(file, OLD);
      const t = rig(w); await t.start({ argv: ["agy", "acp", "--login"], profile: "work" }, new AbortController().signal);
      writeFileSync(file, "FIXTURE-NEW-NOT-A-TOKEN-AT-ALL");
      expect(await t.status()).toEqual({ alive: false, exitCode: 0 });
      await t.close();
    }
  });
  it("no file at all, or a file that is a directory, is still not isolated", async () => {
    const w = world(); const t = rig(w); await t.start({ argv: ["agy", "acp", "--login"], profile: "work" }, new AbortController().signal);
    expect(await t.status()).toMatchObject({ isolated: false });
    mkdirSync(join(w.home("work"), TOKEN));
    expect(await t.status()).toMatchObject({ isolated: false });
    await t.close();
  });
});
