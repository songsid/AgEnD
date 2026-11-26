import { afterEach, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import type { ContactPermissions } from "../src/contact-auth-types.js";
const global = globalThis as any, realFetch = global.fetch;
const pages: AppPage[] = [];
afterEach(async () => { for (const p of pages.splice(0).reverse()) { await p.unmount(); p.restore(); } global.fetch = realFetch; });
const admin = { platform: "host" as const, adapterId: "host", userId: "operator", label: "Fleet admin" };
function fixture(kind: "none" | "human" | "mixed" | "unknown" = "unknown"): ContactPermissions {
  return { instance: "worker", revision: 4, classicRoom: false, mode: "legacy", approvers: [admin], eligibleApprovers: [admin], inheritedApprovers: true,
    nativeGuard: { state: "not-covered", backend: "codex" }, roomTools: { publicRead: true, allowedMcpTools: [], wouldDisable: [] },
    canManage: true, canSetMode: false, suggestRestricted: false, grants: [], history: [], originState: {
      kind, people: kind === "none" ? [] : [{ ...admin, label: "Room member", userId: "fake-member" }], chain: kind === "none" ? [] : ["room", "worker"],
      receiptCount: kind === "none" ? 0 : 3, revision: 7, generation: "fake-generation", canClear: kind !== "none",
      lastCleared: { actor: admin, at: "2026-11-19T09:00:00Z" } } };
}
async function rig(input = fixture(), allow = true, conflict = false) {
  let data = input;
  const calls: any[] = [], confirms: string[] = [];
  global.fetch = async (url: string, options: any = {}) => {
    const method = options.method ?? "GET", body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, method, body });
    if (method === "POST") {
      if (conflict) { data = { ...data, originState: { ...data.originState!, revision: 8 } }; return { ok: false, status: 409, json: async () => ({ error: "conflict" }) }; }
      data = { ...data, originState: { ...data.originState!, kind: "human", people: [admin], receiptCount: 0, revision: 8 } };
    }
    return { ok: true, status: 200, json: async () => data };
  };
  const pg = page({ url: "http://127.0.0.1:19300/ui/fleet/agent/worker?cat=permissions" }); pages.push(pg);
  global.confirm = (message: string) => { confirms.push(message); return allow; };
  const { appStore } = await import("/assets/app-store.js") as any;
  const subscriptions = new Map<string, (data: any) => void>();
  appStore.set({ instances: [{ name: "worker" }], streamOn: (name: string, fn: any) => { subscriptions.set(name, fn); return () => subscriptions.delete(name); } });
  const { ContactPermissionsPanel } = await import("/ui/js/contact-permissions.js") as any;
  await pg.mount(h(ContactPermissionsPanel, { name: "worker" })); await settle(4);
  return { pg, calls, confirms, click: async () => { fire(pg.root.querySelector(".contact-origin-clear"), "click"); await settle(8); },
    frame: async (name: string, event: any) => { subscriptions.get(name)?.(event); await settle(4); } };
}
it.each(["none", "human", "mixed", "unknown"] as const)("shows %s on an ordinary worker, with people/hops and last clear from the audit", async kind => {
  const r = await rig(fixture(kind));
  expect(r.pg.root.querySelector(".contact-origin")).toBeTruthy();
  expect(r.pg.root.querySelector(".contact-origin-state")?.textContent?.trim()).toBe(({ none: "No retained origin", human: "One known person", mixed: "Multiple known people", unknown: "Unknown origin" })[kind]);
  expect(r.pg.root.querySelector(".contact-origin-last")?.textContent).toContain("Fleet admin");
  expect(!!r.pg.root.querySelector(".contact-origin-clear")).toBe(kind !== "none");
  if (kind !== "none") {
    expect(r.pg.root.querySelector(".contact-origin-people")?.textContent).toContain("Room member");
    expect(r.pg.root.querySelector(".contact-origin-chain")?.textContent).toContain("room → worker");
  }
});
it.each(["en", "zh-TW"] as const)("explicit confirm and snapshot-only POST in %s; success shows administrator ownership", async locale => {
  const { setLang } = await import("/assets/app-i18n.js") as any;
  setLang(locale, { store: false });
  try {
    const r = await rig(); await r.click();
    expect(r.confirms).toHaveLength(1);
    expect(r.confirms[0]).toContain(locale === "en" ? "Earlier text is not erased" : "先前文字不會刪除");
    expect(r.calls.filter(call => call.method === "POST")).toEqual([{ url: "/ui/api/instances/worker/contact-permissions/origin-clear", method: "POST",
      body: { revision: 4, originRevision: 7, generation: "fake-generation" } }]);
    expect(r.pg.root.querySelector(".contact-origin-people")?.textContent).toContain("Fleet admin");
    expect(r.pg.root.querySelector(".contact-origin-state")?.textContent).toContain(locale === "en" ? "One known person" : "一位已知提問者");
  } finally { setLang("en", { store: false }); }
});
it("cancel sends nothing; a non-manager sees state but no clear control", async () => {
  const r = await rig(fixture(), false); await r.click(); expect(r.calls).toHaveLength(1);
  const data = fixture(); data.originState!.canClear = false; data.canManage = false;
  const readOnly = await rig(data);
  expect(readOnly.pg.root.querySelector(".contact-origin")).toBeTruthy(); expect(readOnly.pg.root.querySelector(".contact-origin-clear")).toBeNull();
});
// M-3818: a viewer without the clear control is told who has it — the agent's managing admins and the host operator.
it.each(["en", "zh-TW"] as const)("a non-manager is told who can clear it (%s); a manager and an empty origin are not", async locale => {
  const { setLang } = await import("/assets/app-i18n.js") as any;
  setLang(locale, { store: false });
  try {
    const manager = await rig(fixture("mixed"));
    expect(manager.pg.root.querySelector(".contact-origin-who")).toBeNull();
    const named = fixture("mixed"); named.originState!.canClear = false; named.canManage = false;
    named.eligibleApprovers = [admin, { platform: "discord", adapterId: "discord", userId: "fake-1", label: "Admin One" }, { platform: "discord", adapterId: "discord", userId: "fake-2", label: "" }];
    const who = (await rig(named)).pg.root.querySelector(".contact-origin-who")?.textContent?.trim();
    expect(who).toBe(locale === "en" ? "Only this agent's managing admins (Admin One, fake-2) or the verified host operator can clear it."
      : "只有管理這個 Agent 的管理員（Admin One, fake-2）或已驗證的主機操作者能清除。");
    const hostOnly = fixture("unknown"); hostOnly.originState!.canClear = false; hostOnly.canManage = false;
    expect((await rig(hostOnly)).pg.root.querySelector(".contact-origin-who")?.textContent?.trim())
      .toBe(locale === "en" ? "Only the verified host operator can clear it." : "只有已驗證的主機操作者能清除。");
    const empty = fixture("none"); empty.canManage = false;
    expect((await rig(empty)).pg.root.querySelector(".contact-origin-who")).toBeNull();
  } finally { setLang("en", { store: false }); }
});
it("conflict refreshes rather than clearing newer input, and origin-only SSE/message frames refresh", async () => {
  const r = await rig(fixture(), true, true); await r.click();
  expect(r.calls.map(call => call.method)).toEqual(["GET", "POST", "GET"]);
  await r.frame("contact-auth", { instance: "worker", revision: 4, originRevision: 9 });
  await r.frame("message", { instance: "worker" });
  expect(r.calls.map(call => call.method)).toEqual(["GET", "POST", "GET", "GET", "GET"]);
});
