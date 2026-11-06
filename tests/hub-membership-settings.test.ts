import { afterEach, describe, expect, it } from "vitest";
import { hubMembershipSettings, parseHubMembership } from "../src/hub-membership-settings.js";
import { isSettingsMutation, prepareSettingsEffect } from "../src/settings-effect.js";
import { setLocale } from "../src/locale.js";
afterEach(() => setLocale("en"));
const path = "/api/settings/hub/membership";
const effect = (before: unknown, body: unknown) => prepareSettingsEffect("PUT", path, body,
  { config: { defaults: {}, instances: {} } as any, classic: {}, hubMembership: () => hubMembershipSettings(before) });
describe("pure Hub membership Settings policy", () => {
  it("defaults only absent state off, uses own keys, and refuses invalid explicit state", () => {
    for (const raw of [{}, { hub_member: {} }, { hub_member: { enabled: false } }, Object.create({ hub_member: { enabled: true } }), { hub_member: Object.create({ enabled: true }) }])
      expect(hubMembershipSettings(raw)).toEqual({ enabled: false });
    expect(hubMembershipSettings({ hub_member: { enabled: true, other: "retained" } })).toEqual({ enabled: true });
    for (const raw of [null, [], "bad", { hub_member: null }, { hub_member: [] }, { hub_member: true }, { hub_member: { enabled: "true" } }, { hub_member: { enabled: null } }])
      expect(() => hubMembershipSettings(raw)).toThrow("invalid_hub_membership");
  });
  it("accepts only one explicit boolean, never a body that changes pairing or sharing", () => {
    for (const enabled of [false, true]) expect(parseHubMembership({ enabled })).toEqual({ enabled });
    for (const body of [null, [], {}, { enabled: "true" }, { enabled: true, hubId: "other" }, { enabled: true, exposures: [] }, Object.create({ enabled: true })])
      expect(() => parseHubMembership(body)).toThrow("invalid_hub_membership");
  });
  it("enabling is an access confirmation; off and unchanged apply without a pending change", () => {
    expect(isSettingsMutation("PUT", path)).toBe(true);
    const on = effect({}, { enabled: true }).diff!;
    expect(on).toMatchObject({ section: "access", affectedConnections: [], authority: { connections: [], primaryGeneral: false, unknown: false } });
    expect(on.summary.join(" ")).toContain("Pairing and sharing an agent are separate");
    expect(effect({ hub_member: { enabled: true } }, { enabled: false }).diff).toBeNull();
    expect(effect({ hub_member: { enabled: true } }, { enabled: true }).diff).toBeNull();
    expect(effect({}, { enabled: false }).diff).toBeNull();
    expect(() => effect({ hub_member: { enabled: "true" } }, { enabled: true })).toThrow("invalid_hub_membership");
    expect(() => prepareSettingsEffect("PUT", path, { enabled: true }, { config: { defaults: {}, instances: {} } as any, classic: {} })).toThrow("unavailable");
  });
  it("localizes the actual confirmation summary", () => {
    setLocale("zh-TW");
    expect(effect({}, { enabled: true }).diff!.summary.join(" ")).toContain("配對與分享代理需另外選擇");
  });
});
