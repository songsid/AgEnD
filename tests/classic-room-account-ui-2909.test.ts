/**
 * M-2909: the Accounts page's Move takes ClassicBot rooms too.
 * - "Move agents here" lists the CLI's rooms not on the account (under ClassicBot rooms) next to its agents; a chosen room
 *   is staged through the room's own PATCH (stageClassic) with its other backend options kept.
 * - SKEW: an older server sends no `rooms`, and an older Settings page passes no stageClassic: agents only, as before.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";

const CLAUDE = { backend: "claude-code", profiles: true, installed: true, fleetDefault: null,
  agents: [{ name: "dev", profile: "work" }, { name: "ops", profile: null }],
  rooms: [{ key: "123#discord", profile: "work" }, { key: "456#discord", profile: null }],
  rows: [
    { scope: { kind: "host" }, backend: "claude-code", profile: null, state: "usable", signIn: true, usedBy: { agents: ["ops"], classic: ["456#discord"], fleetDefault: true } },
    { scope: { kind: "host" }, backend: "claude-code", profile: "work", state: "usable", signIn: true, usedBy: { agents: ["dev"], classic: ["123#discord"], fleetDefault: false } },
  ] };
let view: any = { clis: [CLAUDE] };
const fetchFake = async (url: string) => ({ ok: true, status: 200, json: async () => (String(url).startsWith("/ui/accounts") ? view : { login: null, targets: [] }) });
let p: AppPage, A: any, S: any, i18n: any, shell: any, D: any, M: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/settings/agents", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  shell = await import("/assets/app-shell.js"); i18n = await import("/assets/app-i18n.js");
  S = await import("/ui/js/backend-signin.js");
  A = await import("/ui/js/accounts-view.js");
  D = await import("/ui/js/settings-dialogs.js");
  M = await import("/ui/js/accounts-manage.js");
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount(); i18n.setLang("en", { store: false }); view = { clis: [CLAUDE] };
  A.accountsStore.set({ loaded: false, failed: false, view: null });
  S.signInStore.set({ loaded: false, login: null, targets: [], structured: null }); shell.shellStore.set({ dialog: null });
});
const ROOMS = { "123#discord": { instanceName: "classic-a", name: "Alpha room", backend_options: { "claude-code": { credential_profile: "work" } } },
  "456#discord": { instanceName: "classic-b", name: "Beta room", backend_options: { codex: { speed: "fast" } } } };
async function mount(props: Record<string, unknown> = {}) {
  const staged: unknown[] = [], rooms: unknown[] = [];
  await p.mount(h(A.AccountsView, { instances: { dev: {}, ops: {} }, stageAgent: (n: string, _i: unknown, patch: unknown) => staged.push([n, patch]), stageDefault: () => {},
    rooms: ROOMS, stageClassic: (room: any, patch: unknown) => rooms.push([room.key, room.instanceName, patch]), ...props }));
  await settle(8);
  return { staged, rooms };
}
const text = (el: any) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const rowOf = (acct: string) => p.root.querySelector(`.s-account-card[data-backend="claude-code"] .s-account-row[data-account="${acct}"]`);
const openMove = async () => { fire([...rowOf("work").querySelectorAll(".s-actions button")].find((b: any) => b.textContent === "Move agents here"), "click"); await settle(6); };

describe("Move takes ClassicBot rooms (M-2909)", () => {
  it("lists the rooms not on the account under their own heading, and stages a chosen one through its PATCH, other options kept", async () => {
    const { staged, rooms } = await mount();
    await openMove();
    expect(text(p.root.querySelector(".s-account-move-head"))).toBe("ClassicBot rooms");
    const roomItems = [...p.root.querySelectorAll(".s-account-move-rooms li")] as any[];
    expect(roomItems.map((li) => [text(li.querySelector("span")), text(li.querySelector("small"))])).toEqual([["Beta room", "now: Default connection"]]);   // Alpha is already on it
    const box = roomItems[0].querySelector("input"); box.checked = true; fire(box, "change"); await settle(4);
    fire([...p.root.querySelectorAll("dialog button, .dlg button")].find((b: any) => b.textContent === "Stage"), "click"); await settle(6);
    expect(rooms).toEqual([["456#discord", "classic-b", { backend_options: { codex: { speed: "fast" }, "claude-code": { credential_profile: "work" } } }]]);
    expect(staged).toEqual([]);
  });
  it("SKEW: an older server (no rooms in the view) or an older Settings page (no stageClassic): agents only, as before", async () => {
    view = { clis: [{ ...CLAUDE, rooms: undefined }] };
    await mount();
    await openMove();
    expect([p.root.querySelector(".s-account-move-rooms"), [...p.root.querySelectorAll(".s-account-move li")].length]).toEqual([null, 1]);
    await p.unmount(); A.accountsStore.set({ loaded: false, failed: false, view: null }); view = { clis: [CLAUDE] };
    await mount({ stageClassic: undefined, rooms: undefined });
    await openMove();
    expect(p.root.querySelector(".s-account-move-rooms")).toBe(null);
  });
});

describe("the room's settings: Runtime & model → Account (M-2909)", () => {
  it("the agents' Account picker; choosing an account stages backend_options with the room's other options kept; unchanged: nothing", async () => {
    A.accountsStore.set({ loaded: true, failed: false, view: { clis: [CLAUDE] } });
    const room = { key: "456#discord", instanceName: "classic-b", name: "Beta room", backend_options: { codex: { speed: "fast" } } };
    const ctx = { fleet: { defaults: {}, instances: {} }, classic: { defaults: {}, channels: { [room.key]: room } }, schema: buildSettingsImpactSchema(),
      classicRuntime: () => ({ status: "running", backend: "claude-code", execution: "running" }), stageClassic: () => {}, staged: new Map(), drafts: new Map() };
    let m: any;
    function Room() { m = D.useClassicForm({ room, ctx }); return h("div", null, h(D.ClassicFields, { m, cat: "runtime" })); }
    await p.mount(h(Room, null));
    await settle(6);
    const sel = p.root.querySelector("#cl-account");
    expect(sel).not.toBe(null);
    expect([...sel.querySelectorAll("option")].map((o: any) => o.value ?? o.getAttribute("value") ?? "")).toEqual(["", "work"]);
    expect(m.pending()).toEqual({});
    sel.value = "work"; fire(sel, "change"); await settle(4);
    expect(m.pending()).toEqual({ backend_options: { codex: { speed: "fast" }, "claude-code": { credential_profile: "work" } } });
    expect(buildSettingsImpactSchema().impacts["classic.backend_options"]).toBe("instance");   // the dialog says: on restart (of this room's agent)
  });
});

describe("Prism on #3691", () => {
  const roomCtx = (room: any) => ({ fleet: { defaults: {}, instances: {} }, classic: { defaults: {}, channels: { [room.key]: room } }, schema: buildSettingsImpactSchema(),
    classicRuntime: () => ({ status: "running", backend: "claude-code", execution: "running" }), stageClassic: () => {}, staged: new Map(), drafts: new Map() });
  async function form(room: any) {
    A.accountsStore.set({ loaded: true, failed: false, view: { clis: [CLAUDE] } });
    let m: any;
    function Room() { m = D.useClassicForm({ room, ctx: roomCtx(room) }); return h("div", null, h(D.ClassicFields, { m, cat: "runtime" })); }
    await p.mount(h(Room, null)); await settle(6);
    return () => m;
  }
  it("P2-1: changing only the backend keeps each CLI's saved account (no overwrite)", async () => {
    const m = await form({ key: "r", instanceName: "classic-r", backend: "claude-code", backend_options: { "claude-code": { credential_profile: "personal" }, codex: { credential_profile: "work" } } });
    expect(m().acct).toBe("personal");
    m().set("backend")("codex"); await settle(4);
    expect([m().acct, m().pending()]).toEqual(["work", { backend: "codex" }]);
  });
  it("P2-1: two unsaved choices, one per backend, stay apart when switching back and forth", async () => {
    const m = await form({ key: "r", instanceName: "classic-r", backend: "claude-code" });
    m().setAcct("new-claude"); await settle(4);
    m().set("backend")("codex"); await settle(4);
    expect(m().acct).toBe("");
    m().setAcct("new-codex"); await settle(4);
    m().set("backend")("claude-code"); await settle(4);
    expect([m().acct, m().pending()]).toEqual(["new-claude", { backend_options: { "claude-code": { credential_profile: "new-claude" }, codex: { credential_profile: "new-codex" } } }]);
  });
  it("P3: a Remove dialog from a view that can't open rooms (an older accounts-view.js) shows no room Move… — only where to change it", async () => {
    const row = { scope: { kind: "host" }, backend: "claude-code", profile: "work", state: "usable", usedBy: { agents: [], classic: ["123#discord"], fleetDefault: false } };
    await p.mount(h(M.RemoveAccountDialog, { cli: CLAUDE, row, label: "Claude Code", onClose: () => {}, onMove: () => {}, onRemoved: () => {} }));
    await settle(6);
    const li = p.document.querySelector(".s-account-inuse li") ?? p.root.querySelector(".s-account-inuse li");
    expect([li.querySelector("button"), text(li.querySelector("small"))]).toEqual([null, "In that room's settings: Runtime & model → Account."]);
  });
});
