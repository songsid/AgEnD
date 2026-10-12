/**
 * #1685: the dashboard shows host memory pressure while it slows or holds new agents — the status frame's host_memory,
 * on the Fleet page's header — because macOS's routine "elevated" no longer goes to chat. Normal (null) shows nothing.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { installDom } from "./helpers/mini-dom.js";

let fleet: any, store: any;
const mounted: AppPage[] = [];
beforeAll(async () => {
  const base = installDom({ storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = async () => ({ ok: true, status: 200, json: async () => [], text: async () => "[]" });
  // @ts-expect-error — a JS module of the app, with no types
  fleet = await import("../src/ui/panel-fleet.js");
  store = await import("/assets/app-store.js");
  base.restore();
});
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } });

async function fleetPage(hostMemory: unknown, lang = "en") {
  const pg = page({ url: "http://127.0.0.1:19280/ui/fleet/tasks", storage: { agend_tour_done: "1", agend_lang: lang } });
  mounted.push(pg);
  (globalThis as any).fetch = async () => ({ ok: true, status: 200, json: async () => [], text: async () => "[]" });
  (await import("/assets/app-i18n.js")).setLang(lang);
  store.applyStatus({ instances: [], uptime: 1, ...(hostMemory === undefined ? {} : { host_memory: hostMemory }) });
  await pg.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: "fleet:tasks|1|en" }));
  await settle(4);
  return pg;
}
const indicator = (pg: AppPage) => pg.root.querySelector(".panel-head .host-mem");

describe("#1685: the Fleet page shows host memory pressure", () => {
  it.each([
    ["elevated", "warn", "Host memory pressure: elevated — new agents start one at a time, at least 5 s apart"],
    ["critical", "bad", "Host memory pressure: critical — new agents wait for memory to recover"],
  ])("%s: a status line in the header", async (level, dot, text) => {
    const pg = await fleetPage(level);
    expect(indicator(pg)?.textContent).toBe(text);
    expect(indicator(pg)?.querySelector(".dot")?.classList.contains(dot)).toBe(true);
    expect(indicator(pg)?.getAttribute("role")).toBe("status");
  });
  it("normal, absent or anything else: nothing", async () => {
    for (const v of [null, undefined, "normal", "unknown", 2]) {
      const pg = await fleetPage(v);
      expect(indicator(pg) === null, String(v)).toBe(true);
      await pg.unmount(); pg.restore(); mounted.pop();
    }
  });
  it("zh-TW", async () => {
    const pg = await fleetPage("elevated", "zh-TW");
    expect(indicator(pg)?.textContent).toBe("主機記憶體壓力偏高：新的 agent 一次啟動一個，至少間隔 5 秒");
    (await import("/assets/app-i18n.js")).setLang("en");
  });
});
