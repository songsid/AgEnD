/**
 * Settings → Shared agent settings has the task board's wake switches, next to "When an assignee stops":
 * `defaults.task_board.comment_wakes`, `progress_wakes` and `leader`.
 *  - drawn in the Advanced drawer, each with one line that says what stays asleep when it is off (English and 繁體中文);
 *  - the leader is a menu of the fleet's agents (and "No leader"); a saved name that is no agent now is kept, said so;
 *  - saving writes `defaults.task_board` whole (the defaults merge replaces it): liveness and any key this page does not know
 *    stay; a switch nobody touched is not written; a key put back to its default goes;
 *  - the server side: the change goes through the same confirmation Settings asks for any task_board value, and the leader's
 *    name is shown in it (it used to be refused outright as an unknown string).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
import { settingsChangeDiff } from "../src/settings-change.js";
import { validateFleetConfig as validateFleet } from "../src/config-validator.js";

const schema = buildSettingsImpactSchema();
let p: AppPage;
let raw: any;
const sent: Array<{ method: string; path: string; body: any }> = [];
const realFetch = (globalThis as any).fetch;
const fleet = () => ({
  defaults: { backend: "codex", model: "gpt-5.5" },
  instances: { "dev-a": { working_directory: "/w/dev" }, "lead-b": { working_directory: "/w/lead", display_name: "Lead" }, general: { working_directory: "/w/g", general_topic: true } },
  channels: [{ id: "main", type: "discord", bot_token_env: "T", group_id: "1" }], web: {},
});
const fakeFetch = async (path: string, init: { method?: string; body?: string } = {}) => {
  const method = init.method ?? "GET";
  if (method !== "GET") sent.push({ method, path, body: init.body ? JSON.parse(init.body) : null });
  const body = (() => {
    if (method !== "GET") return { ok: true };
    if (path === "/api/settings/schema") return schema;
    if (path === "/api/settings/fleet/raw") return raw;
    if (path === "/api/settings/classic") return { defaults: {}, channels: {} };
    if (path === "/api/settings/connections") return [{ id: "main", token_present: true }];
    if (path === "/api/settings/status-emojis") return { keys: [], builtins: { discord: {}, telegram: {} }, telegram_allowed: [], suggestions: [] };
    if (path === "/api/settings/pending") return [];
    if (path === "/api/fleet") return { version: "2.4.0", instances: Object.keys(raw.instances).map((name) => ({ name, status: "running" })) };
    if (path.startsWith("/ui/")) return {};
    return [];
  })();
  return { ok: true, status: 200, json: async () => body };
};
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19284/settings", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fakeFetch;
  const nav = await import("/assets/app-nav.js");
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
beforeEach(async () => {
  raw = fleet(); sent.length = 0; (globalThis as any).confirm = () => true;
  (await import("/assets/app-i18n.js")).setLang("en");
});
afterEach(async () => { await p.unmount(); });

let opened = 0;
const open = async () => {
  const { SettingsPanel } = await import("/ui/js/panel-settings.js");
  await p.mount(h(SettingsPanel, { route: { panel: "settings", section: "agent-defaults" }, navKey: `settings:agent-defaults|${++opened}` }));
  await settle(14);
};
const text = (el: any) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
const $ = (sel: string): any => p.root.querySelector(sel);
const check = async (el: any, on: boolean) => { el.checked = on; fire(el, "change"); await settle(4); };
const choose = async (id: string, value: string) => { const el = $(`#${id}`); el.value = value; fire(el, "change"); await settle(4); };
const bar = () => $(".s-pending");
const save = async () => { bar().querySelectorAll("button").find((b: any) => b.textContent === "Save").click(); await settle(12); };
const written = () => sent.filter((s) => s.path === "/api/settings/fleet/defaults").map((s) => s.body);
const LIVENESS = { enabled: true, quiet_minutes: 60, prompt_minutes: 10, crash_grace_minutes: 5 };

describe("the switches", () => {
  it("are drawn in the Advanced drawer beside 'When an assignee stops': two switches and a menu, each with a line that says what a change means", async () => {
    await open();
    const card = $("#g-wakes");
    expect(card).toBeTruthy();
    expect(!!card.closest("details")).toBe(true);
    expect(card.previousElementSibling?.id ?? card.previousSibling?.id).toBe("g-liveness");
    expect(text(card.querySelector(".s-lab-text"))).toBe("When the task board wakes an agent");
    // Each control is a real control of its kind: a switch for each wake, a menu for the leader.
    expect(["g-wake-comment", "g-wake-progress"].map((id) => [$(`#${id}`).getAttribute("role"), $(`#${id}`).checked])).toEqual([["switch", true], ["switch", true]]);
    expect($("#g-wake-leader").tagName).toBe("SELECT");
    const infos = card.querySelectorAll(".s-info").map(text);
    expect(infos).toHaveLength(4);
    expect(infos[1]).toContain("Off: a comment on a card does not wake its assignee, and @mentioning an agent in a comment wakes nobody");
    expect(infos[2]).toContain("Off: when a card is finished, sent for confirmation, sent back, blocked or handed to someone else, its dispatcher, its watchers and its leader are not woken");
    expect(infos[3]).toContain("No leader: only such a card's dispatcher and watchers hear it");
  });

  it("the leader menu lists No leader, then the fleet's agents by the names the page uses", async () => {
    await open();
    const options = $("#g-wake-leader").querySelectorAll("option").map((o: any) => [o.value, text(o)]);
    expect(options).toEqual([["", "No leader"], ["dev-a", "dev-a"], ["general", "general"], ["lead-b", "Lead"]]);
    expect($("#g-wake-leader").value).toBe("");
  });

  it("an untouched page has nothing to save, and the three carry the 'default' mark (nothing is written for them)", async () => {
    await open();
    expect(bar()).toBeNull();                        // no Save bar: nothing is edited
    expect(written()).toEqual([]);
    expect($("#g-wakes").querySelectorAll(".s-default").length).toBe(1);   // one mark for the card: nobody set any of the three
  });

  it("switching comments off and saving writes it beside liveness; the other two are not written", async () => {
    await open();
    await check($("#g-wake-comment"), false);
    expect(text($("#g-wake-comment").closest("label").querySelector(".s-switch-text"))).toBe("Off");
    await save();
    expect(written()).toHaveLength(1);
    expect(written()[0].task_board).toEqual({ liveness: LIVENESS, comment_wakes: false });
  });

  it("progress and the leader, together: the leader is the agent's name, not its label", async () => {
    await open();
    await check($("#g-wake-progress"), false);
    await choose("g-wake-leader", "lead-b");
    await save();
    expect(written()[0].task_board).toEqual({ liveness: LIVENESS, progress_wakes: false, leader: "lead-b" });
  });

  it("show what is saved, and keep every other key of task_board when one changes", async () => {
    raw.defaults.task_board = { comment_wakes: false, progress_wakes: true, leader: "lead-b", liveness: { quiet_minutes: 30 }, something_newer: { keep: "me" } };
    await open();
    expect([$("#g-wake-comment").checked, $("#g-wake-progress").checked, $("#g-wake-leader").value]).toEqual([false, true, "lead-b"]);
    await check($("#g-wake-progress"), false);
    await save();
    expect(written()[0].task_board).toEqual({
      comment_wakes: false, progress_wakes: false, leader: "lead-b", something_newer: { keep: "me" },
      liveness: { enabled: true, quiet_minutes: 30, prompt_minutes: 10, crash_grace_minutes: 5 },
    });
  });

  it("putting a switch back on: a key the file already had is written true; a key it never had is not written at all", async () => {
    raw.defaults.task_board = { comment_wakes: false };
    await open();
    await check($("#g-wake-comment"), true);
    await check($("#g-wake-progress"), false);
    await check($("#g-wake-progress"), true);          // edited and put back: the same as saved
    await save();
    expect(written()[0].task_board).toEqual({ liveness: LIVENESS, comment_wakes: true });
    expect(Object.keys(written()[0].task_board)).not.toContain("progress_wakes");
  });

  it("choosing No leader takes the key away", async () => {
    raw.defaults.task_board = { leader: "lead-b" };
    await open();
    await choose("g-wake-leader", "");
    await save();
    expect(written()[0].task_board).toEqual({ liveness: LIVENESS });
  });

  it("a saved leader that is no agent of this fleet is shown as such and kept when something else is saved", async () => {
    raw.defaults.task_board = { leader: "gone-agent" };
    await open();
    expect($("#g-wake-leader").value).toBe("gone-agent");
    expect($("#g-wake-leader").querySelectorAll("option").map(text)).toContain("gone-agent (not an agent of this fleet)");
    await check($("#g-wake-comment"), false);
    await save();
    expect(written()[0].task_board).toEqual({ liveness: LIVENESS, leader: "gone-agent", comment_wakes: false });
  });

  it("are in 繁體中文 too: the title, each line and the menu", async () => {
    const { setLang } = await import("/assets/app-i18n.js");
    setLang("zh-TW");
    await open();
    const card = $("#g-wakes");
    expect(text(card.querySelector(".s-lab-text"))).toBe("任務板何時叫醒 Agent");
    const infos = card.querySelectorAll(".s-info").map(text);
    expect(infos[1]).toContain("關掉後：卡片上的留言不會叫醒負責人");
    expect(infos[2]).toContain("派工者、關注者和看板負責人都不會被叫醒");
    // #4367 review: 「訊息」, not 「消息」; and the leader's label is Chinese too.
    expect(infos.join("")).not.toMatch(/消息|leader/i);
    expect(infos[3]).toContain("不指定：這類卡片只有派工者和關注者會收到");
    expect($("#g-wake-leader").querySelectorAll("option").map(text)[0]).toBe("不指定");
    setLang("en");
  });
});

describe("the server side of the same change", () => {
  const change = (tb: unknown, before: unknown = undefined) => settingsChangeDiff({ fleet: { defaults: before === undefined ? {} : { task_board: before } } }, { fleet: { defaults: { task_board: tb } } }, { operation: "defaults" });
  it("the three go through the confirmation Settings asks for any task_board value, and the leader's name is shown in it", () => {
    expect(change({ comment_wakes: false })?.summary.join("\n")).toContain("comment\\_wakes: absent → false");
    expect(change({ progress_wakes: false })?.summary.join("\n")).toContain("progress\\_wakes: absent → false");
    // It threw `unsupported_sensitive_effect` (an unknown string) before.
    expect(change({ leader: "lead-b" })?.summary.join("\n")).toContain("leader: absent → lead-b");
    expect(change({ leader: "dev-a" }, { leader: "lead-b" })?.summary.join("\n")).toContain("leader: lead-b → dev-a");
  });
  it("an unrelated string under task_board is still refused, not shown", () => {
    expect(() => change({ liveness_note: "x" })).toThrow(/unsupported_sensitive_effect/);
  });
  it("the validator takes what the page writes, and still refuses what it never wrote", () => {
    const ok = (tb: unknown) => validateFleet({ defaults: { task_board: tb }, instances: { "lead-b": { working_directory: "/w" } } } as never).errors.filter((e) => e.path.includes("task_board"));
    expect(ok({ comment_wakes: false, progress_wakes: true, leader: "lead-b", liveness: LIVENESS })).toEqual([]);
    expect(ok({ comment_wakes: "no" }).map((e) => e.path)).toEqual(["defaults.task_board.comment_wakes"]);
    expect(ok({ leader: "" }).map((e) => e.path)).toEqual(["defaults.task_board.leader"]);
  });
});
