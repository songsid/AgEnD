import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { parseMemberFrame, parseServerFrame, HUB_OPTIONAL_CAPABILITIES } from "../src/hub/protocol.js";
import { hubWelcomeCapabilities } from "../src/hub/server.js";

const envelope = (type: string, payload: unknown) => JSON.stringify({ v: 1, type, requestId: randomUUID(), linkEpoch: 1, payload });
const catalog = () => ({ revision: "a".repeat(64), enabled: true, requests: false, agents: [
  { instance: "Docs", displayName: "Docs helper", description: "Answers document questions.", avatar: { emoji: "📚", color: "#123456" }, kind: "agent", general: false, shareable: true },
  { instance: "Support", displayName: "Support room", description: "", avatar: null, kind: "classic-room", general: false, shareable: true },
] });
it("accepts a bounded owner catalog without adding to the member hello", () => {
  expect(() => parseMemberFrame(envelope("agent.catalog", catalog()))).not.toThrow();
  expect(HUB_OPTIONAL_CAPABILITIES).not.toContain("agent-catalog-v1");
  expect(HUB_OPTIONAL_CAPABILITIES).not.toContain("exposure-request-v1");
});
it("rejects hidden configuration, duplicate names, oversized rows and an off catalog carrying agents", () => {
  for (const body of [
    { ...catalog(), agents: [{ ...catalog().agents[0], folder: "/private" }] },
    { ...catalog(), agents: [catalog().agents[0], catalog().agents[0]] },
    { ...catalog(), agents: [{ ...catalog().agents[0], description: "a".repeat(513) }] },
    { ...catalog(), enabled: false },
    { ...catalog(), agents: [{ ...catalog().agents[0], shareable: false }] },
  ]) expect(() => parseMemberFrame(envelope("agent.catalog", body))).toThrow();
  expect(() => parseMemberFrame(envelope("agent.catalog", { ...catalog(), enabled: false, requests: false, agents: [] }))).not.toThrow();
});
it("accepts owner-bound requests with a finite lifetime and rejects ambiguous or duplicate actions", () => {
  const body = { by: { realm: "corp", objectId: randomUUID() }, catalogRevision: "a".repeat(64), share: ["Docs"], stop: [], createdAt: 100, expiresAt: 600100 };
  expect(() => parseServerFrame(envelope("exposure.request", body))).not.toThrow();
  for (const changed of [{ share: [] }, { share: ["Docs", "Docs"] }, { expiresAt: 600101 }, { by: { name: "Owner" } }]) {
    expect(() => parseServerFrame(envelope("exposure.request", { ...body, ...changed }))).toThrow();
  }
  expect(() => parseServerFrame(envelope("agent.catalog-refresh", {}))).not.toThrow();
});
it("requires an unambiguous bounded result per row, with a code only on an explicit refusal",()=>{
  expect(()=>parseMemberFrame(envelope("exposure.request-result",{results:[{instance:"Docs",ok:true},{exposureId:randomUUID(),ok:false,code:"stale-list"}]}))).not.toThrow();
  for(const results of [[],[{instance:"Docs",ok:false}],[{instance:"Docs",ok:true,code:"limit"}],[{instance:"Docs",exposureId:randomUUID(),ok:true}],[{instance:"Docs",ok:true},{instance:"Docs",ok:true}]]) {
    expect(()=>parseMemberFrame(envelope("exposure.request-result",{results}))).toThrow();
  }
});
it("does not enlarge an old member's strict welcome with the new offer",()=>{
  const configured=[...HUB_OPTIONAL_CAPABILITIES,"room-ask-v1","room-post-v1","fleet-info-v1","fleet-recommendation-v1","room-context-v1","fleet-update-v1","room-mention-feedback-v1","agent-catalog-v1"];
  const legacy=hubWelcomeCapabilities(configured,[...HUB_OPTIONAL_CAPABILITIES,"room-ask-v1","room-post-v1"]);
  expect(legacy).not.toContain("agent-catalog-v1");expect(legacy.length).toBeLessThanOrEqual(16);
  expect(hubWelcomeCapabilities(configured,[...HUB_OPTIONAL_CAPABILITIES,"fleet-update-v1"])).toContain("agent-catalog-v1");
});
