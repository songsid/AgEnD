/**
 * #2054: ClassicBot web echo is on by default. The room dialog's Web echo box shows the effective value — the room's own
 * `web_echo` when set, else the fleet-wide `web.echo_to_channel` (default on) — and turning it on for a group channel no
 * longer asks for a confirmation. The real Settings panel in the mini DOM; fetch is a fake that records what is called.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { installDom } from "./helpers/mini-dom.js";

const mounted: AppPage[] = [];
let calls: string[] = [];
let room: Record<string, unknown> = {};
let fleetWeb: Record<string, unknown> | undefined;

async function fakeFetch(url: string, init: { method?: string; body?: string } = {}) {
  const m = init.method || "GET";
  calls.push(`${m} ${url}${init.body ? ` ${init.body}` : ""}`);
  const SETTINGS: Record<string, unknown> = {
    "/api/settings/schema": { impacts: {}, order: ["now", "instance", "fleet"] },
    "/api/settings/fleet/raw": { defaults: {}, channels: [], instances: {}, ...(fleetWeb ? { web: fleetWeb } : {}) },
    "/api/settings/classic": { defaults: {}, channels: { "-1001:telegram": { instanceName: "classic-ops-1", name: "ops", adapterId: "telegram", channelId: "-1001", backend: "codex", ...room } } },
    "/api/settings/connections": [], "/api/settings/pending": [],
    "/api/settings/status-emojis": { keys: [], builtins: { discord: {}, telegram: {} }, telegram_allowed: [], suggestions: [] },
    "/api/fleet": { version: "2.3.0", instances: [] }, "/api/profiles": [],
  };
  if (m === "GET" && Object.prototype.hasOwnProperty.call(SETTINGS, url)) return { ok: true, status: 200, json: async () => structuredClone(SETTINGS[url]), text: async () => "" };
  return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "{}" };
}

let S: any, req: any;
beforeAll(async () => {
  const base = installDom({ storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fakeFetch;
  // @ts-expect-error — a JS module of the app, with no types
  S = await import("../src/ui/panel-settings.js");
  // @ts-expect-error — a JS module of the app, with no types
  req = await import("../src/ui/settings-request.js");
  base.restore();
});
afterEach(async () => {
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  req.takeAgentRequest();
  calls = []; room = {}; fleetWeb = undefined;
});

async function openRoom() {
  const pg = page({ url: "http://127.0.0.1:19280/settings/classic", storage: { agend_tour_done: "1" } });
  mounted.push(pg);
  (globalThis as any).fetch = fakeFetch;
  let asked = 0;
  (globalThis as any).confirm = () => { asked++; return true; };
  pg.window.confirm = (globalThis as any).confirm;
  req.requestAgentSettings("classic-ops-1", "classic");
  await pg.mount(h(S.SettingsPanel, { route: { panel: "settings", section: "classic" }, navKey: "settings:classic|classic-ops-1|en" }));
  await settle(8);
  const dlg = pg.root.querySelector("dialog");
  const box = dlg?.querySelectorAll("label.check").find((l: any) => /Web echo/.test(l.textContent))?.querySelector("input");
  return { pg, dlg, box, asked: () => asked };
}

describe("#2054: the ClassicBot room dialog's Web echo box", () => {
  it("shows the effective value: unset follows web.echo_to_channel (default on); the room's own value wins", async () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown> | undefined, boolean]> = [
      [{}, undefined, true], [{}, { echo_to_channel: true }, true], [{}, { echo_to_channel: false }, false],
      [{ web_echo: false }, undefined, false], [{ web_echo: true }, { echo_to_channel: false }, true],
    ];
    for (const [r, web, want] of cases) {
      room = r; fleetWeb = web;
      const { pg, dlg, box } = await openRoom();
      expect([JSON.stringify(r), JSON.stringify(web ?? null), !!dlg, box?.checked]).toEqual([JSON.stringify(r), JSON.stringify(web ?? null), true, want]);
      await pg.unmount(); pg.restore(); mounted.splice(mounted.indexOf(pg), 1);
    }
  });

  it("turning it on for a group channel stages the change without asking for a confirmation", async () => {
    room = { web_echo: false };
    const { dlg, box, asked } = await openRoom();
    expect(box?.checked).toBe(false);
    box.checked = true; box.dispatchEvent?.(Object.assign(new Event("change"), {})) ?? box.onchange?.({ target: box });
    await settle(2);
    const stage = dlg.querySelectorAll("button").find((b: any) => /^(Stage|Save|Apply|Done)/.test(b.textContent.trim()));
    expect(stage, "the dialog's stage button").toBeTruthy();
    stage.click(); await settle(6);
    expect(asked()).toBe(0);
  });
});
