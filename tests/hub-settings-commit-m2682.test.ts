/**
 * M-2682: the one writer for sealed Hub settings (src/hub/settings-commit.ts) — a Hub rename or clear, resealed with the
 * Hub's own issuer key, committed through a journal with an explicit commit point, and recovered after a crash at any step.
 * Real keys and manifests (provisionHubIdentity / sealHubInitialization / verifyHubInitialization) in a scratch home; the
 * fleet's configuration writer is an in-memory hub.* block (the FleetManager wiring is checked separately).
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { provisionHubIdentity } from "../src/hub/tls.js";
import { sealHubInitialization, verifyHubInitialization } from "../src/hub/initialization.js";
import { hubPlanDigest } from "../src/hub/init/plan-digest.js";
import { createHubSettingsWriter, hubNameInput, HubSettingsError, SETTINGS_JOURNAL, type HubSettingsWriterDeps } from "../src/hub/settings-commit.js";

const MEMBER = "https://hub.example.test:8443";
const ADMIN = { realm: "corp", objectId: "0f1e2d3c-4b5a-4968-8776-655443322110" };
const OTHER = { realm: "corp", objectId: "1f1e2d3c-4b5a-4968-8776-655443322111" };
const actor = (over: Partial<{ sessionId: string; person: typeof ADMIN }> = {}) => ({ person: ADMIN, sessionId: "s1", requestId: "r1", ...over });

let home: string, hub: Record<string, unknown>, initialManifest: string;
const manifestPath = () => join(home, "hub/init-manifest.json");
const verifies = (h = hub) => { try { verifyHubInitialization({ home, hubId: h.hubId as string, memberOrigin: MEMBER, planDigest: hubPlanDigest(h) }); return true; } catch { return false; } };
const leftovers = () => [existsSync(join(home, SETTINGS_JOURNAL)), existsSync(join(home, "hub/settings-staged")) ? readdirSync(join(home, "hub/settings-staged")).length : 0];

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "hub-settings-")); chmodSync(home, 0o700);
  const identity = await provisionHubIdentity({ home, memberOrigin: MEMBER });
  hub = { enabled: true, name: "AgEnD Hub pilot", hubId: identity.hubId, webOrigin: "https://hub.example.test", memberOrigin: MEMBER,
    webListen: { host: "127.0.0.1", port: 8444 }, memberListen: { host: "127.0.0.1", port: 8443 },
    webTls: { certificateFile: "hub/web-tls/cert.pem", keyFile: "hub/web-tls/key.pem" },
    directory: { realm: "corp", url: "ldaps://dc.example.test", baseDn: "DC=example,DC=test", bindDn: "CN=svc", profile: "ad", bindPasswordRef: "agend-hub-secret:bind" },
    administrator: ADMIN, retention: { contentDays: 30, eventDays: 90 }, coexistence: "dedicated", web: { preview_port: 8445 } };
  const committedAt = "2026-11-08T00:00:00.000Z", confirmationId = "c".repeat(32), planDigest = hubPlanDigest(hub);
  const signature = sealHubInitialization({ home, planDigest, confirmationId, committedAt });
  initialManifest = `${JSON.stringify({ v: 1, hubId: identity.hubId, planDigest, committedAt, confirmationId, signature }, null, 2)}\n`;
  writeFileSync(manifestPath(), initialManifest, { mode: 0o600 });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function writer(over: Partial<HubSettingsWriterDeps> = {}) {
  let t = 1_000_000;
  const w = createHubSettingsWriter({ home, now: () => t, readHub: () => structuredClone(hub),
    saveHub: (patches) => { for (const p of patches) { if (p.remove) delete hub[p.path[1]!]; else hub[p.path[1]!] = p.value; } }, ...over });
  return Object.assign(w, { advance: (ms: number) => { t += ms; } });
}

describe("rename and clear, resealed", () => {
  it("a rename writes the new name and a manifest that verifies it; nothing else of hub.* changes; a receipt binds it", () => {
    const before = structuredClone(hub), w = writer();
    const { ref, summary } = w.prepare({ kind: "rename", name: "  Design Hub  " }, actor());
    expect(summary).toEqual({ field: "name", from: "AgEnD Hub pilot", to: "Design Hub" });
    expect(hub.name).toBe("AgEnD Hub pilot");                 // prepare writes nothing
    const done = w.commit(ref, actor(), () => true);
    expect(hub).toEqual({ ...before, name: "Design Hub" });
    expect(verifies()).toBe(true);
    expect(verifies(before)).toBe(false);                      // the old block no longer matches the seal
    const manifest = JSON.parse(readFileSync(manifestPath(), "utf8"));
    const receipt = JSON.parse(readFileSync(join(home, "hub/settings-receipts", `${done.receiptId}.json`), "utf8"));
    expect(receipt).toMatchObject({ v: 1, op: "rename", actor: { kind: "hub-administrator", person: "corp/0f1e2d3c-4b5a-4968-8776-655443322110" },
      requestId: "r1", newDigest: manifest.planDigest });
    const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object"
      ? `{${Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}` : JSON.stringify(v);
    expect(manifest.confirmationId).toBe(createHash("sha256").update(canonical(receipt)).digest("hex").slice(0, 32));
    expect(manifest.confirmationId).not.toBe("c".repeat(32));
    expect(leftovers()).toEqual([false, 0]);
  });
  it("clearing removes the key (never an empty or blank name), and the cleared block verifies", () => {
    const w = writer();
    w.commit(w.prepare({ kind: "rename", name: null }, actor()).ref, actor(), () => true);
    expect(Object.hasOwn(hub, "name")).toBe(false);
    expect(verifies()).toBe(true);
    // and back
    w.commit(w.prepare({ kind: "rename", name: "Team Hub" }, actor()).ref, actor(), () => true);
    expect(hub.name).toBe("Team Hub"); expect(verifies()).toBe(true);
  });
  it("names follow the initializer's rule; a blank string is refused, not taken as a clear", () => {
    expect(hubNameInput(null)).toBeNull();
    expect(hubNameInput(" Ops ")).toBe("Ops");
    for (const bad of ["", "   ", "a\u0007b", "x".repeat(65), 7, undefined]) expect(() => hubNameInput(bad)).toThrow(HubSettingsError);
    expect(hubNameInput("x".repeat(64))).toHaveLength(64);
  });
});

describe("refusals before the commit point leave everything as it was", () => {
  const code = (f: () => unknown) => { try { f(); return "none"; } catch (e) { return (e as HubSettingsError).code; } };
  it("unchanged, expired, reused, another session or person, a session that ended", () => {
    const w = writer();
    expect(code(() => w.prepare({ kind: "rename", name: "AgEnD Hub pilot" }, actor()))).toBe("unchanged");
    const a = w.prepare({ kind: "rename", name: "A" }, actor()); w.advance(5 * 60_000);
    expect(code(() => w.commit(a.ref, actor(), () => true))).toBe("expired");
    const b = w.prepare({ kind: "rename", name: "B" }, actor());
    expect(code(() => w.commit(b.ref, actor({ sessionId: "s2" }), () => true))).toBe("denied");
    expect(code(() => w.commit(b.ref, actor(), () => true))).toBe("expired");   // one use, even after a refusal
    const c = w.prepare({ kind: "rename", name: "C" }, actor());
    expect(code(() => w.commit(c.ref, actor({ person: OTHER }), () => true))).toBe("denied");
    const d = w.prepare({ kind: "rename", name: "D" }, actor());
    expect(code(() => w.commit(d.ref, actor(), () => false))).toBe("denied");
    expect(code(() => w.commit("not-a-ref", actor(), () => true))).toBe("expired");
    expect(hub.name).toBe("AgEnD Hub pilot"); expect(readFileSync(manifestPath(), "utf8")).toBe(initialManifest); expect(leftovers()).toEqual([false, 0]);
  });
  it("stale: another hub.* field or the manifest changed after prepare", () => {
    const w = writer();
    const a = w.prepare({ kind: "rename", name: "A" }, actor());
    hub.retention = { contentDays: 31, eventDays: 90 };
    expect(code(() => w.commit(a.ref, actor(), () => true))).toBe("unavailable");   // the edited block no longer verifies at all
    hub.retention = { contentDays: 30, eventDays: 90 };
    const b = w.prepare({ kind: "rename", name: "B" }, actor());
    writeFileSync(manifestPath(), initialManifest.replace("\n}", ",\n  \"x\": 1\n}").replace(",\n  \"x\": 1", "") + " ", { mode: 0o600 });
    expect(code(() => w.commit(b.ref, actor(), () => true))).toBe("stale");
    expect(hub.name).toBe("AgEnD Hub pilot"); expect(leftovers()).toEqual([false, 0]);
  });
  it("the session ending between staging and the commit point cancels it: staged files removed, nothing in force changed", () => {
    let live = true;
    const w = writer({ step: (s) => { if (s === "staged") live = false; } });
    const a = w.prepare({ kind: "rename", name: "A" }, actor());
    expect(code(() => w.commit(a.ref, actor(), () => live))).toBe("stale");
    expect(hub.name).toBe("AgEnD Hub pilot"); expect(readFileSync(manifestPath(), "utf8")).toBe(initialManifest); expect(leftovers()).toEqual([false, 0]);
  });
  it("a sealed pair that doesn't verify is not renamed", () => {
    hub.name = "edited by hand";
    const w = writer();
    expect(code(() => w.prepare({ kind: "rename", name: "A" }, actor()))).toBe("unavailable");
  });
});

describe("a crash at any step: recover() before the next mount leaves a coherent pair", () => {
  for (const at of ["staged", "committed", "manifest", "config", "done"] as const) {
    it(`stopped after "${at}"`, () => {
      const before = structuredClone(hub);
      const crash = writer({ step: (s) => { if (s === at) throw new Error(`crash at ${s}`); } });
      expect(() => crash.commit(crash.prepare({ kind: "rename", name: "After" }, actor()).ref, actor(), () => true)).toThrow(`crash at ${at}`);
      expect(crash.pending()).toBe(true);
      // A new process: the person's session is long gone; recovery needs none (Cairn: completion isn't re-authorized).
      writer().recover();
      if (at === "staged") { expect(hub).toEqual(before); expect(readFileSync(manifestPath(), "utf8")).toBe(initialManifest); }
      else expect(hub.name).toBe("After");
      expect(verifies()).toBe(true);
      expect(leftovers()).toEqual([false, 0]);
    });
  }
  it("a failed config save past the commit point is finished by the next recover()", () => {
    let refuse = true;
    const w = writer({ saveHub: (patches) => { if (refuse) throw new Error("fleet.yaml refused"); for (const p of patches) if (!p.remove) hub[p.path[1]!] = p.value; } });
    expect(() => w.commit(w.prepare({ kind: "rename", name: "After" }, actor()).ref, actor(), () => true)).toThrow("fleet.yaml refused");
    expect(verifies()).toBe(false);                         // new manifest, old block: the mount would hold until recovery
    expect(w.pending()).toBe(true);
    refuse = false; w.recover();
    expect(hub.name).toBe("After"); expect(verifies()).toBe(true); expect(leftovers()).toEqual([false, 0]);
  });
  it("recovery overwrites nothing it didn't write: an outside change to hub.* or the manifest is refused and left as is", () => {
    const crash = writer({ step: (s) => { if (s === "committed") throw new Error("crash"); } });
    expect(() => crash.commit(crash.prepare({ kind: "rename", name: "After" }, actor()).ref, actor(), () => true)).toThrow("crash");
    hub.retention = { contentDays: 7, eventDays: 90 };       // someone edits fleet.yaml meanwhile
    const w = writer();
    expect(() => w.recover()).toThrow(/hub\.\* changed outside/);
    expect(hub.retention).toEqual({ contentDays: 7, eventDays: 90 }); expect(hub.name).toBe("AgEnD Hub pilot");
    expect(readFileSync(manifestPath(), "utf8")).toBe(initialManifest);   // the manifest is judged first, and not written either
    expect(w.pending()).toBe(true);                          // kept for the person who puts it right

    const other = writer({ step: (s) => { if (s === "committed") throw new Error("crash"); } });
    rmSync(join(home, SETTINGS_JOURNAL)); rmSync(join(home, "hub/settings-staged"), { recursive: true });
    hub.retention = { contentDays: 30, eventDays: 90 };
    expect(() => other.commit(other.prepare({ kind: "rename", name: "After" }, actor()).ref, actor(), () => true)).toThrow("crash");
    writeFileSync(manifestPath(), initialManifest + " ", { mode: 0o600 });
    expect(() => writer().recover()).toThrow(/manifest changed outside/);
    expect(readFileSync(manifestPath(), "utf8")).toBe(initialManifest + " ");
  });
  it("a second commit waits while one is unfinished", () => {
    const crash = writer({ step: (s) => { if (s === "committed") throw new Error("crash"); } });
    expect(() => crash.commit(crash.prepare({ kind: "rename", name: "A" }, actor()).ref, actor(), () => true)).toThrow("crash");
    const w = writer();
    expect(() => w.commit(w.prepare({ kind: "rename", name: "B" }, actor()).ref, actor(), () => true)).toThrow(expect.objectContaining({ code: "busy" }));
  });
});
