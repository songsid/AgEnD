import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { initialGroupPolicy } from "../src/hub/group-policy/model.js";
import { convertGroupPolicy } from "../src/hub/roles/convert.js";
import { personKeyString, sha256 } from "../src/hub/identity.js";
import * as markerParser from "../src/hub/roles/cutover-marker.js";
import { createHubRoleCutoverClockFacts } from "../src/hub/roles/cutover-clock-facts.js";
afterEach(() => vi.restoreAllMocks());
function image() {
  const hubId = randomUUID(), root = { realm: "corp", objectId: randomUUID() }, at = 100;
  const old = initialGroupPolicy("corp", "g1"), oldRaw = JSON.stringify(old);
  const converted = convertGroupPolicy(old, { root, now: at, rolesActive: true });
  const marker = { v: 1, hubId, realm: "corp", generation: "g1", root, at, oldRaw,
    oldDigest: sha256(oldRaw), roleDigest: sha256(JSON.stringify(converted)), fromRevision: old.revision,
    transportRevision: 1, authorizationVersion: 1, inventory: { digest: sha256(JSON.stringify([])), tables: [] }, auditId: randomUUID() };
  return { hubId, root, marker, raw: JSON.stringify(marker) };
}
it("memoizes a full successful decode as exactly six frozen primitive facts", () => {
  const w = image(), parse = vi.spyOn(markerParser, "parseHubRoleCutoverMarker"), memo = createHubRoleCutoverClockFacts();
  const facts = memo.read(w.raw, w.hubId);
  expect(memo.read(w.raw, w.hubId)).toBe(facts); expect(parse).toHaveBeenCalledTimes(1);
  expect(facts).toEqual({ rootKey: personKeyString(w.root), realm: "corp", at: 100, fromRevision: 1, transportRevision: 1, authorizationVersion: 1 });
  expect(Object.keys(facts)).toHaveLength(6); expect(Object.isFrozen(facts)).toBe(true);
  expect(Object.values(facts).every(value => typeof value === "string" || typeof value === "number")).toBe(true);
});
it("does not lend mutable facts or the historical marker graph", () => {
  const w = image(), memo = createHubRoleCutoverClockFacts(), facts = memo.read(w.raw, w.hubId);
  expect(() => { (facts as { realm: string }).realm = "changed"; }).toThrow(TypeError);
  const owned = markerParser.parseHubRoleCutoverMarker(w.raw, w.hubId); owned.marker.root.realm = "changed";
  expect(memo.read(w.raw, w.hubId).realm).toBe("corp");
  expect(markerParser.parseHubRoleCutoverMarker(w.raw, w.hubId).marker.root.realm).toBe("corp");
});
it("keys a hit by hubId as well as the exact raw bytes", () => {
  const w = image(), parse = vi.spyOn(markerParser, "parseHubRoleCutoverMarker"), memo = createHubRoleCutoverClockFacts();
  memo.read(w.raw, w.hubId);
  expect(() => memo.read(w.raw, randomUUID())).toThrow("unavailable");
  expect(memo.read(w.raw, w.hubId).realm).toBe("corp"); expect(parse).toHaveBeenCalledTimes(2);
});
it("refuses malformed same-length raw on every attempt without caching failures or evicting success", () => {
  const w = image(), parse = vi.spyOn(markerParser, "parseHubRoleCutoverMarker"), memo = createHubRoleCutoverClockFacts();
  const facts = memo.read(w.raw, w.hubId), malformed = "[" + w.raw.slice(1);
  expect(malformed.length).toBe(w.raw.length);
  expect(() => memo.read(malformed, w.hubId)).toThrow(); expect(() => memo.read(malformed, w.hubId)).toThrow();
  expect(memo.read(w.raw, w.hubId)).toBe(facts); expect(parse).toHaveBeenCalledTimes(3);
});
it("decodes changed same-length valid bytes and retains only the latest successful slot", () => {
  const w = image(), parse = vi.spyOn(markerParser, "parseHubRoleCutoverMarker"), memo = createHubRoleCutoverClockFacts();
  const changed = JSON.stringify({ ...w.marker, auditId: randomUUID() }); expect(changed.length).toBe(w.raw.length);
  memo.read(w.raw, w.hubId); memo.read(changed, w.hubId); memo.read(w.raw, w.hubId);
  expect(parse).toHaveBeenCalledTimes(3);
});
it("clears the primitive slot on close so the next read is a full-parser miss", () => {
  const w = image(), parse = vi.spyOn(markerParser, "parseHubRoleCutoverMarker"), memo = createHubRoleCutoverClockFacts();
  memo.read(w.raw, w.hubId); memo.close(); memo.read(w.raw, w.hubId); expect(parse).toHaveBeenCalledTimes(2);
});
