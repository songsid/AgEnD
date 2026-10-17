/**
 * #2054: ClassicBot web echo is on by default. The room dialog's Web echo box shows what the fleet will do — an absent
 * `web_echo` follows the fleet-wide `web.echo_to_channel` (default on); any other value echoes only when it is `true`
 * (as ClassicChannelManager reads it) — and turning it on for a group channel no longer asks for a confirmation. The
 * real Settings panel in the mini DOM; fetch is a fake that records what is called (with its body).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { installDom } from "./helpers/mini-dom.js";

const mounted: AppPage[] = [];
let calls: string[] = [];
let room: Record<string, unknown> = {};
let fleetWeb: Record<string, unknown> | undefined;
const KEY = "-1001:telegram";

async function fakeFetch(url: string, init: { method?: string; body?: string } = {}) {
  const m = init.method || "GET";
  calls.push(`${m} ${url}${init.body ? ` ${init.body}` : ""}`);
  const SETTINGS: Record<string, unknown> = {
    "/api/settings/schema": { impacts: {}, order: ["now", "instance", "fleet"] },
    "/api/settings/fleet/raw": { defaults: {}, channels: [], instances: {}, ...(fleetWeb ? { web: fleetWeb } : {}) },
    "/api/settings/classic": { defaults: {}, channels: { [KEY]: { instanceName: "classic-ops-1", name: "ops", adapterId: "telegram", channelId: "-1001", backend: "codex", ...room } } },
    "/api/settings/connections": [], "/api/settings/pending": [],
    "/api/settings/status-emojis": { keys: [], builtins: { discord: {}, telegram: {} }, telegram_allowed: [], suggestions: [] },
    "/api/fleet": { version: "2.3.0", instances: [] }, "/api/profiles": [],
  };
  if (m === "GET" && Object.prototype.hasOwnProperty.call(SETTINGS, url)) return { ok: true, status: 200, json: async () => structuredClone(SETTINGS[url]), text: async () => "" };
  return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "{}" };
}

let S: any, req: any, confirm: any;
let asked: string[] = [];
beforeAll(async () => {
  const base = installDom({ storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fakeFetch;
  // @ts-expect-error — a JS module of the app, with no types
  S = await import("../src/ui/panel-settings.js");
  // @ts-expect-error — a JS module of the app, with no types
  req = await import("../src/ui/settings-request.js");
  confirm = await import("/assets/ui-confirm.js");
  confirm.confirmStore.subscribe((st: { queue: Array<{ id: number; message: string }> }) => {
    for (const q of st.queue) if (!asked.includes(`${q.id}:${q.message}`)) asked.push(`${q.id}:${q.message}`);
  });
  base.restore();
});
afterEach(async () => {
  for (const q of confirm.confirmStore.get().queue) confirm.answerConfirm(q.id, false);
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  req.takeAgentRequest();
  calls = []; room = {}; fleetWeb = undefined;
});

async function openRoom() {
  const pg = page({ url: "http://127.0.0.1:19280/settings/classic", storage: { agend_tour_done: "1" } });
  mounted.push(pg);
  (globalThis as any).fetch = fakeFetch;
  // The app's own confirmation dialog (ui-confirm.js), not window.confirm: no auto-answer (the app harness answers a
  // question only while globalThis.confirm is a function), so a question asked stays in confirmStore's queue.
  (globalThis as any).confirm = undefined; pg.window.confirm = undefined;
  asked = [];
  req.requestAgentSettings("classic-ops-1", "classic");
  await pg.mount(h(S.SettingsPanel, { route: { panel: "settings", section: "classic" }, navKey: "settings:classic|classic-ops-1|en" }));
  await settle(8);
  const dlg = pg.root.querySelector("dialog");
  const check = (label: RegExp) => dlg?.querySelectorAll("label.check").find((l: any) => label.test(l.textContent))?.querySelector("input");
  return { pg, dlg, box: check(/Web echo/), collab: check(/Collaboration/) };
}
const toggle = async (box: any) => { box.checked = !box.checked; box.dispatchEvent(new Event("change")); await settle(2); };
const button = (root: any, label: RegExp) => root.querySelectorAll("button").find((b: any) => label.test(b.textContent.trim()));
/** Stage the dialog, then Apply: the room's PATCH, as sent (null when none went out). */
async function stageAndApply(pg: AppPage, dlg: any) {
  button(dlg, /^Stage change$/).click(); await settle(6);
  const queued = confirm.confirmStore.get().queue.length + asked.length;
  const apply = button(pg.root, /^Apply changes$/);
  if (apply) { apply.click(); await settle(10); }
  const patch = calls.find(c => c.startsWith(`PATCH /api/settings/classic/channels/${encodeURIComponent(KEY)} `));
  return { queued, body: patch ? JSON.parse(patch.slice(patch.indexOf(" {") + 1)) : null };
}

describe("#2054: the ClassicBot room dialog's Web echo box", () => {
  it("shows what the fleet will do: absent follows web.echo_to_channel (default on); otherwise only true is on", async () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown> | undefined, boolean]> = [
      [{}, undefined, true], [{}, { echo_to_channel: true }, true], [{}, { echo_to_channel: false }, false],
      [{ web_echo: false }, undefined, false], [{ web_echo: true }, { echo_to_channel: false }, true],
      // Not booleans (the validator rejects them; the manager reads them as off) — the page must agree.
      [{ web_echo: null }, undefined, false], [{ web_echo: 0 }, undefined, false], [{ web_echo: "yes" }, { echo_to_channel: true }, false],
    ];
    for (const [r, web, want] of cases) {
      room = r; fleetWeb = web;
      const { pg, dlg, box } = await openRoom();
      expect([JSON.stringify(r), JSON.stringify(web ?? null), !!dlg, box?.checked]).toEqual([JSON.stringify(r), JSON.stringify(web ?? null), true, want]);
      await pg.unmount(); pg.restore(); mounted.splice(mounted.indexOf(pg), 1);
    }
  });

  it("turning it on (a group channel, stored off) stages web_echo: true with no confirmation, and Apply sends it", async () => {
    room = { web_echo: false };
    const { pg, dlg, box } = await openRoom();
    expect(box?.checked).toBe(false);
    await toggle(box);
    const { queued, body } = await stageAndApply(pg, dlg);
    expect([queued, body]).toEqual([0, { web_echo: true }]);
  });

  it("turning it off sends web_echo: false; a stored null turned on sends true", async () => {
    for (const [r, want] of [[{}, false], [{ web_echo: null }, true]] as const) {
      room = r;
      const { pg, dlg, box } = await openRoom();
      await toggle(box);
      expect((await stageAndApply(pg, dlg)).body, JSON.stringify(r)).toEqual({ web_echo: want });
      await pg.unmount(); pg.restore(); mounted.splice(mounted.indexOf(pg), 1); calls = [];
    }
  });

  it("an untouched box sends no web_echo when another field changes (an unset room keeps following the fleet)", async () => {
    room = {};
    const { pg, dlg, collab } = await openRoom();
    await toggle(collab);
    const { body } = await stageAndApply(pg, dlg);
    expect(body).toEqual({ collab: true });
  });
});
