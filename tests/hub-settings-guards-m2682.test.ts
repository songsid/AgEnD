/**
 * M-2682 (Fable #3426 F1.4, F1.5): two guards around the sealed-settings writer, each pinned on its own.
 * - The mount's parse of hub.* (settingsOf): an absent name mounts (the plain brand); a present one must pass the
 *   initializer's rule, or the Hub refuses with hub-unsealed.
 * - Administration → This Hub's admin gate: a session that is no longer current can't even prepare (the writer itself
 *   checks current() only at commit).
 */
import { describe, expect, it } from "vitest";
import { settingsOf } from "../src/hub/compose/server.js";
import { handleHubSettingsHttp, type HubSettingsHttpRequest } from "../src/hub/settings-api.js";
import type { HubSettingsWriter } from "../src/hub/settings-commit.js";

const block = (over: Record<string, unknown> = {}) => ({ hubId: "4c3b2a19-0e8f-4d7c-9b6a-5f4e3d2c1b0a", name: "Team Hub", webOrigin: "https://hub.example.test", memberOrigin: "https://hub.example.test:8443",
  webListen: { host: "127.0.0.1", port: 8444 }, memberListen: { host: "127.0.0.1", port: 8443 },
  webTls: { certificateFile: "hub/web-tls/cert.pem", keyFile: "hub/web-tls/key.pem" }, administrator: { realm: "corp", objectId: "0f1e2d3c-4b5a-4968-8776-655443322110" },
  retention: { contentDays: 30, eventDays: 90 }, directory: { realm: "corp", url: "ldaps://dc.example.test", baseDn: "DC=example,DC=test", bindPasswordRef: "agend-hub-secret:bind" }, ...over });

describe("settingsOf: hub.name (F1.4)", () => {
  it("an absent name mounts as no name; a valid one as itself", () => {
    const { name: _, ...absent } = block();
    expect(settingsOf(absent).name).toBe("");
    expect(settingsOf(block({ name: "Ops" })).name).toBe("Ops");
    expect(settingsOf(block({ name: "x".repeat(64) })).name).toHaveLength(64);
  });
  it("a present name that the initializer would refuse holds the Hub (hub-unsealed)", () => {
    for (const name of ["", " Padded ", "a\u0007b", "x".repeat(65), 7, null]) {
      expect(() => settingsOf(block({ name }))).toThrow(expect.objectContaining({ code: "hub-unsealed" }));
    }
  });
});

describe("This Hub: a session that is no longer current can't prepare (F1.5)", () => {
  it("prepare answers 403 denied and the writer is never asked", async () => {
    const asked: string[] = [];
    const writer = { prepare() { asked.push("prepare"); return { ref: "r", summary: { field: "name", from: null, to: "x" }, expiresAt: 1 }; },
      commit() { asked.push("commit"); throw new Error("no"); }, recover() {}, pending: () => false } as unknown as HubSettingsWriter;
    let sent: [number, unknown] | null = null;
    const q = (current: boolean): HubSettingsHttpRequest => ({ path: "/hub/v1/admin/hub/name/prepare", method: "POST",
      ctx: { requestId: "r1", current: () => current, requireAdmin: async () => ({ kind: "directory", person: { realm: "corp", objectId: "0f1e2d3c-4b5a-4968-8776-655443322110" }, sessionId: "s1" }) },
      signedIn: () => true, csrf: () => true, body: async () => ({ name: "Ops" }), send: (status, body) => { sent = [status, body]; }, audit: () => {} });
    await handleHubSettingsHttp({ info: { hubId: "h", memberSpkiSha256: "a".repeat(64), issuerKeyId: "k", version: null }, name: "Team Hub", writer }, q(false));
    expect(sent).toEqual([403, { ok: false, code: "denied" }]);
    expect(asked).toEqual([]);
    await handleHubSettingsHttp({ info: { hubId: "h", memberSpkiSha256: "a".repeat(64), issuerKeyId: "k", version: null }, name: "Team Hub", writer }, q(true));
    expect(sent![0]).toBe(200); expect(asked).toEqual(["prepare"]);
  });
});
