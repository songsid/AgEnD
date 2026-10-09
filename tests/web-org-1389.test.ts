/**
 * #1389: the fleet's org chart (Fleet → Org chart, /ui/fleet/org). Presentation only (Discord-first):
 * - The server derives the structure from what exists — fleet.yaml's instances and teams, General (general_topic),
 *   each instance's world and thread — and adds no source of truth (GET /ui/org; no write route).
 * - The page reads it once per opening (a person's navigation) and takes the live state from the app store the
 *   shell keeps from the stream: a state change re-renders the chart, it never re-reads (#1374).
 * - General on top → teams in fleet.yaml's order → their members; the instances in no team after them.
 */
import { EventEmitter } from "node:events";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOrgChart, threadUrl } from "../src/web-org.js";
import { FleetManager } from "../src/fleet-manager.js";
import { handleWebRequest } from "../src/web-api.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { isPassiveWebRead } from "../src/web-auth.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

const GUILD = "111111111111111111", TOPIC = "222222222222222222";

describe("the structure: threadUrl", () => {
  it("Discord: the channel URL; Telegram: the topic link; anything it cannot build is no link", () => {
    expect(threadUrl({ type: "discord", groupId: GUILD }, TOPIC)).toEqual({ platform: "discord", url: `https://discord.com/channels/${GUILD}/${TOPIC}` });
    expect(threadUrl({ type: "telegram", groupId: "-1001234567890" }, "42")).toEqual({ platform: "telegram", url: "https://t.me/c/1234567890/42" });
    expect(threadUrl({ type: "telegram", groupId: "-1001234567890" }, "1")).toBeUndefined();        // General topic: no topic link
    expect(threadUrl({ type: "telegram", groupId: "12345" }, "42")).toBeUndefined();                // not a supergroup
    expect(threadUrl({ type: "discord" }, TOPIC)).toBeUndefined();
    expect(threadUrl({ type: "discord", groupId: GUILD }, "general")).toBeUndefined();
    expect(threadUrl({ type: "discord", groupId: "javascript:alert(1)" }, TOPIC)).toBeUndefined();
    expect(threadUrl({ type: "slack", groupId: GUILD }, TOPIC)).toBeUndefined();
    expect(threadUrl(undefined, TOPIC)).toBeUndefined();
    expect(threadUrl({ type: "discord", groupId: GUILD }, undefined)).toBeUndefined();
  });
});

describe("the structure: buildOrgChart", () => {
  const base = {
    names: ["general", "dev", "rev", "room"],
    instances: {
      general: { description: "  Coordinates the fleet  ", tags: ["lead", 3, " "] },
      dev: { description: "x".repeat(600) },
      rev: {},
      room: { description: "A classic room" },
    },
    teams: { core: { members: ["dev", "rev", "dev", 7, "", "gone"], description: " Core work " }, empty: { members: "nope" }, none: undefined },
    isGeneral: (n: string) => n === "general",
    isClassic: (n: string) => n === "room",
    place: (n: string) => (n === "room" ? undefined : { type: "discord", groupId: GUILD }),
    topic: (n: string) => (n === "dev" ? TOPIC : undefined),
  };
  it("General, teams as configured (deduped, strings only, unknown names kept), descriptions trimmed and capped", () => {
    const org = buildOrgChart(base as any);
    expect(org.general).toEqual(["general"]);
    expect(org.teams).toEqual([{ name: "core", description: "Core work", members: ["dev", "rev", "gone"] }, { name: "empty", members: [] }]);
    expect(org.instances.general).toEqual({ description: "Coordinates the fleet", tags: ["lead"], general: true });
    expect(org.instances.dev!.description).toHaveLength(500);
    expect(org.instances.dev!.description!.endsWith("…")).toBe(true);
    expect(org.instances.dev!.thread).toEqual({ platform: "discord", url: `https://discord.com/channels/${GUILD}/${TOPIC}` });
    expect(org.instances.rev).toEqual({});
    expect(org.instances.room).toEqual({ description: "A classic room", classic: true });
  });
  it("#1467 review: every name is an own key — \"__proto__\" and \"constructor\" included — and survives JSON", () => {
    const org = buildOrgChart({ ...base, names: ["__proto__", "constructor"], instances: JSON.parse('{"__proto__":{"description":"Proto room"}}'),
      teams: undefined, isClassic: (n: string) => n === "__proto__" } as any);
    const wire = JSON.parse(JSON.stringify(org));
    expect(Object.keys(wire.instances)).toEqual(["__proto__", "constructor"]);
    expect(Object.hasOwn(wire.instances, "__proto__")).toBe(true);
    expect(wire.instances["__proto__"]).toEqual({ description: "Proto room", classic: true });
    expect(wire.instances.constructor).toEqual({});                 // not Object's: no description borrowed from it
  });
  it("no teams configured: none", () => {
    expect(buildOrgChart({ ...base, teams: undefined } as any).teams).toEqual([]);
  });
});

describe("the structure: FleetManager.orgChart", () => {
  const fake = (over: Record<string, unknown> = {}) => ({
    fleetConfig: {
      channel: { type: "discord", id: "main" },
      instances: {
        lead: { general_topic: true, topic_id: TOPIC, description: "General" },
        general: { topic_id: 1234 },
        dev: { topic_id: "333333333333333333", description: "Builds", channel_id: "tg" },
      },
      teams: { web: { members: ["dev", "room"] } },
    },
    classicChannels: { getAll: () => [{ instanceName: "room", description: "Classic", channelId: "444444444444444444" }, { instanceName: "dev", description: "dup" }] },
    worlds: new Map([["main", { type: "discord", groupId: GUILD }], ["tg", { type: "telegram", groupId: "-1009876543210" }]]),
    getInstanceAdapterId(name: string) { return (this as any).fleetConfig.instances[name]?.channel_id ?? "main"; },
    ...over,
  });
  it("the dashboard's names; General by general_topic or the name; each world's link; a ClassicBot room has no link", () => {
    const org = (FleetManager.prototype as any).orgChart.call(fake());
    expect(Object.keys(org.instances)).toEqual(["lead", "general", "dev", "room"]);
    expect(org.general).toEqual(["lead", "general"]);
    expect(org.instances.lead.thread).toEqual({ platform: "discord", url: `https://discord.com/channels/${GUILD}/${TOPIC}` });
    expect(org.instances.general.thread).toBeUndefined();          // 1234 is not a Discord snowflake
    expect(org.instances.dev).toEqual({ description: "Builds", thread: { platform: "telegram", url: "https://t.me/c/9876543210/333333333333333333" } });
    expect(org.instances.room).toEqual({ description: "Classic", classic: true });
    expect(org.teams).toEqual([{ name: "web", members: ["dev", "room"] }]);
  });
  it("#1467 review: a ClassicBot room named \"__proto__\" keeps its metadata on the wire", () => {
    const f = fake({ classicChannels: { getAll: () => [{ instanceName: "__proto__", description: "Proto room", channelId: "444444444444444444" }] } });
    const wire = JSON.parse(JSON.stringify((FleetManager.prototype as any).orgChart.call(f)));
    expect(Object.keys(wire.instances)).toEqual(["lead", "general", "dev", "__proto__"]);
    expect(Object.hasOwn(wire.instances, "__proto__")).toBe(true);
    expect(wire.instances["__proto__"]).toEqual({ description: "Proto room", classic: true });
  });
  it("no world for the instance: no link; no config: an empty chart", () => {
    const org = (FleetManager.prototype as any).orgChart.call(fake({ worlds: new Map() }));
    expect(org.instances.lead.thread).toBeUndefined();
    const none = (FleetManager.prototype as any).orgChart.call(fake({ fleetConfig: null, classicChannels: null }));
    expect(none).toEqual({ general: [], teams: [], instances: {} });
  });
});

describe("the route: GET /ui/org", () => {
  const token = "c".repeat(48);
  function call(method: string, over: Record<string, unknown> = {}) {
    const req = Object.assign(new EventEmitter(), { method, url: "/ui/org", headers: { host: "127.0.0.1:19280", "x-agend-token": token } });
    let status = 0, body = "";
    const res = Object.assign(new EventEmitter(), { setHeader() {}, writeHead: (c: number) => { status = c; }, end: (t = "") => { body = t; } });
    const ctx = { webToken: token, logger: { info() {}, debug() {}, error() {} }, sseClients: new Set(), ...over } as any;
    handleWebRequest(req as never, res as never, new URL("/ui/org", "http://127.0.0.1:19280"), ctx);
    return { status, body: body ? JSON.parse(body) : null };
  }
  it("answers the fleet's chart (signed in), an empty chart without one; no write; on the public link, a read only", () => {
    const chart = { general: ["g"], teams: [], instances: { g: { general: true } } };
    expect(call("GET", { orgChart: () => chart })).toEqual({ status: 200, body: chart });
    expect(call("GET")).toEqual({ status: 200, body: { general: [], teams: [], instances: {} } });
    expect(call("POST", { orgChart: () => chart }).status).not.toBe(200);
    expect(isPublicWebRoute("GET", "/ui/org")).toBe(true);
    for (const m of ["POST", "PUT", "DELETE"]) expect(isPublicWebRoute(m, "/ui/org"), m).toBe(false);
    // Opening the chart is a person's navigation: it counts as use, like the other Fleet tabs (#1374).
    expect(isPassiveWebRead("GET", "/ui/org")).toBe(false);
  });
  it("unsigned: refused", () => {
    const req = Object.assign(new EventEmitter(), { method: "GET", url: "/ui/org", headers: { host: "127.0.0.1:19280" } });
    let status = 0;
    const res = Object.assign(new EventEmitter(), { setHeader() {}, writeHead: (c: number) => { status = c; }, end() {} });
    handleWebRequest(req as never, res as never, new URL("/ui/org", "http://127.0.0.1:19280"),
      { webToken: "c".repeat(48), logger: { info() {}, debug() {}, error() {} }, sseClients: new Set(), orgChart: () => { throw new Error("read"); } } as any);
    expect(status).toBe(401);
  });
});

// ── The page ──
type Req = { method: string; url: string };
let reqs: Req[] = [];
let org: unknown = {};
const fetchFake = async (url: string, init: any = {}) => {
  reqs.push({ method: init.method || "GET", url });
  return { ok: true, status: 200, json: async () => (url === "/ui/org" ? org : {}) };
};
const ORG = {
  general: ["lead"],
  teams: [
    { name: "web", description: "The web <b>app</b>", members: ["web-dev", "reviewer", "gone"] },
    { name: "ops", members: ["reviewer"] },
  ],
  instances: {
    lead: { description: "Coordinates", general: true, thread: { platform: "discord", url: `https://discord.com/channels/${GUILD}/${TOPIC}` } },
    "web-dev": { description: "Builds the web", thread: { platform: "telegram", url: "https://t.me/c/1/2" } },
    reviewer: {},
    loner: { classic: true },
  },
};
const INSTANCES = [
  { name: "lead", display_name: "Leader", status: "running", backend: "claude-code", model: "opus" },
  { name: "web-dev", status: "running", backend: "codex", model: "gpt-5" },
  { name: "reviewer", display_name: "Prism", status: "paused", backend: "kiro-cli" },
  { name: "loner", status: "crashed", backend: "claude-code" },
  { name: "newbie", status: "running", backend: "muse" },                // listed by the stream, not yet in /ui/org's answer
];

let p: AppPage;
let app: any, fleet: any, O: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  (globalThis as any).fetch = fetchFake;
  app = await import("/assets/app-store.js");
  fleet = await import("/ui/js/panel-fleet.js");
  O = await import("/ui/js/fleet-org.js");
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  vi.useRealTimers();
  await p.unmount();
  reqs = []; org = ORG;
  app.appStore.set({ ready: true, instances: INSTANCES, exec: { lead: "working", "web-dev": "idle", newbie: "stuck" }, awaiting: {}, needs: [] });
});
const mount = (key = "fleet:org|1|en") => p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "org" }, navKey: key }));
const nodes = (scope: any = p.root) => scope.querySelectorAll(".org-node");
const names = (scope: any = p.root) => nodes(scope).map((n: any) => n.querySelector(".org-name").textContent);
const states = (scope: any = p.root) => nodes(scope).map((n: any) => n.querySelector(".org-state").textContent);
const team = (name: string) => p.root.querySelectorAll(".org-team").find((s: any) => s.querySelector("h3").textContent.trim() === name);

describe("the page: General → teams → instances", () => {
  it("the tab is in Fleet's tab bar, between Teams and Config", async () => {
    await mount(); await settle(4);
    expect(p.root.querySelectorAll(".seg-item").map((a: any) => a.getAttribute("href"))).toEqual(["/ui/fleet", "/ui/fleet/schedules", "/ui/fleet/teams", "/ui/fleet/org", "/ui/fleet/config"]);
    expect(p.root.querySelector(".seg-item.active").getAttribute("href")).toBe("/ui/fleet/org");
    expect(p.root.querySelector(".col.col-wide")).not.toBeNull();
  });

  it("General on top; teams in order with their members; then the instances in no team (General not repeated)", async () => {
    await mount(); await settle(4);
    expect(names(p.root.querySelector(".org-top"))).toEqual(["lead"]);
    expect(p.root.querySelectorAll(".org-team h3").map((e: any) => e.textContent.trim())).toEqual(["web", "ops", "Not in a team"]);
    expect(names(team("web"))).toEqual(["web-dev", "reviewer", "gone"]);
    expect(names(team("ops"))).toEqual(["reviewer"]);                         // in two teams: in both
    expect(names(team("Not in a team"))).toEqual(["loner", "newbie"]);
    expect(team("web").querySelector(".org-team-desc").textContent).toBe("The web <b>app</b>");   // text, never markup
    expect(team("web").querySelector(".org-team-desc b")).toBeNull();
  });

  it("each node: display name over the name, what it does, backend + model, its state, its thread and its chat", async () => {
    await mount(); await settle(4);
    const lead = nodes(p.root.querySelector(".org-top"))[0];
    expect(lead.querySelector(".org-alias").textContent).toBe("Leader");
    expect(lead.querySelector(".org-desc").textContent).toBe("Coordinates");
    expect(lead.querySelectorAll(".org-meta .org-chip, .org-meta .org-model").map((e: any) => e.textContent)).toEqual(["claude-code", "opus"]);
    expect(lead.querySelector(".org-state").textContent).toBe("Working");
    const [thread, chat] = lead.querySelectorAll(".org-link");
    expect(thread.getAttribute("href")).toBe(`https://discord.com/channels/${GUILD}/${TOPIC}`);
    expect(thread.getAttribute("target")).toBe("_blank");
    expect(thread.getAttribute("rel")).toBe("noopener noreferrer");
    expect(thread.textContent).toContain("Discord thread");
    expect(chat.getAttribute("href")).toBe("/ui/chat/lead");
    const webDev = nodes(team("web"))[0];
    expect(webDev.querySelector(".org-alias")).toBeNull();
    expect(webDev.querySelector(".org-link").textContent).toContain("Telegram topic");
    // No thread known: only the chat.
    expect(nodes(team("ops"))[0].querySelectorAll(".org-link").map((a: any) => a.getAttribute("href"))).toEqual(["/ui/chat/reviewer"]);
    // A member the fleet no longer lists: shown as such, nothing to open.
    const gone = nodes(team("web"))[2];
    expect(gone.querySelector(".org-state").textContent).toBe("Not in the fleet");
    expect(gone.querySelectorAll("a")).toHaveLength(0);
    expect(nodes(team("Not in a team"))[0].querySelector(".org-meta").textContent).toContain("ClassicBot room");
  });

  it("states: working / idle / paused / crashed / stuck / needs you, and the counts per team and in all", async () => {
    await mount(); await settle(4);
    expect(states(team("web"))).toEqual(["Idle", "Paused", "Not in the fleet"]);
    expect(states(team("Not in a team"))).toEqual(["Crashed", "Looks stuck"]);
    expect(p.root.querySelectorAll(".org-head .org-count").map((e: any) => e.textContent.replace(/\s+/g, " ").trim()))
      .toEqual(["1 Crashed", "1 Looks stuck", "1 Working", "1 Idle", "1 Paused"]);
    expect(team("web").querySelectorAll(".org-count").map((e: any) => e.className.replace("org-count ", ""))).toEqual(["st-idle", "st-paused", "st-missing"]);
    expect(p.root.querySelector(".org-head > span").textContent).toBe("5 instances");
    expect(team("web").querySelector(".org-team-sub .muted").textContent).toBe("3 members");
    expect(team("ops").querySelector(".org-team-sub .muted").textContent).toBe("1 member");
  });
});

describe("the page reads once; the stream moves it (#1374)", () => {
  it("one GET /ui/org on opening, none while it stays open; a state change re-renders from the store", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
    const m = mount(); await vi.advanceTimersByTimeAsync(50); await m;
    expect(reqs).toEqual([{ method: "GET", url: "/ui/org" }]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(reqs).toHaveLength(1);
    vi.useRealTimers();
    // Activity: web-dev starts working.
    app.appStore.set((s: any) => ({ ...s, exec: { ...s.exec, "web-dev": "working" } })); await settle(4);
    expect(states(team("web"))[0]).toBe("Working");
    // A terminal wait, then a Needs you item (#1398's registry over the stream): "Needs you".
    app.appStore.set((s: any) => ({ ...s, awaiting: { "web-dev": "Allow psql?" } })); await settle(4);
    expect(states(team("web"))[0]).toBe("Needs you");
    app.appStore.set((s: any) => ({ ...s, awaiting: {}, needs: [{ id: "delivery:d1", type: "delivery", instance: "reviewer", reason: "delivery_failed" }] })); await settle(4);
    expect(states(team("web"))).toEqual(["Working", "Needs you", "Not in the fleet"]);
    expect(states(team("ops"))).toEqual(["Needs you"]);
    // A new instance in the status frame: it shows (in no team) without a read.
    app.appStore.set((s: any) => ({ ...s, instances: [...s.instances, { name: "late", status: "running", backend: "codex" }] })); await settle(4);
    expect(names(team("Not in a team"))).toEqual(["loner", "newbie", "late"]);
    expect(reqs).toHaveLength(1);
  });

  it("an answer that arrives after the person left the tab is dropped", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    (globalThis as any).fetch = async (url: string, init: any = {}) => { reqs.push({ method: init.method || "GET", url }); await held; return { ok: true, status: 200, json: async () => ORG }; };
    try {
      await mount("fleet:org|1|en"); await settle(2);
      await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "config" }, navKey: "fleet:config|2|en" })); await settle(2);
      release(); await settle(8);
      expect(p.root.querySelector(".org")).toBeNull();
    } finally { (globalThis as any).fetch = fetchFake; }
  });

  it("before the first status frame: a skeleton, not a chart of missing instances; no instances: the empty state", async () => {
    app.appStore.set({ ready: false, instances: [] });
    await mount(); await settle(4);
    expect(reqs).toEqual([{ method: "GET", url: "/ui/org" }]);       // the structure has arrived; the status has not
    expect(p.root.querySelector(".skeleton")).not.toBeNull();
    expect(p.root.querySelector(".empty")).toBeNull();                // not "No instances yet": it just does not know yet
    app.appStore.set({ ready: true, instances: [] }); await settle(4);
    expect(p.root.querySelector(".skeleton")).toBeNull();
    expect(p.root.querySelector(".empty .empty-title").textContent).toBe("No instances yet");
    expect(nodes()).toHaveLength(0);
  });

  it("no teams configured: the instances in no team, and a pointer to Teams", async () => {
    org = { general: ["lead"], teams: [], instances: ORG.instances };
    await mount(); await settle(4);
    expect(p.root.querySelector(".org-note").textContent).toContain("Fleet → Teams");
    expect(names(team("Not in a team"))).toEqual(["web-dev", "reviewer", "loner", "newbie"]);
  });
});

describe("#1467 review: names that are Object.prototype's keys", () => {
  // A control for the page (it reads the answer's own keys, so the server's own-key fix reaches it unchanged).
  it("\"__proto__\" shows its own metadata; \"constructor\", absent from the structure, borrows nothing", async () => {
    org = JSON.parse(JSON.stringify({ general: [], teams: [], instances: {} }).replace('"instances":{}', '"instances":{"__proto__":{"description":"Proto room","classic":true}}'));
    app.appStore.set({ ready: true, instances: [{ name: "__proto__", status: "running", backend: "claude-code" }, { name: "constructor", status: "running", backend: "codex" }],
      exec: {}, awaiting: {}, needs: [] });
    await mount(); await settle(4);
    const [proto, ctor] = nodes(team("Not in a team"));
    expect(proto.querySelector(".org-name").textContent).toBe("__proto__");
    expect(proto.querySelector(".org-desc").textContent).toBe("Proto room");
    expect(proto.querySelector(".org-meta").textContent).toContain("ClassicBot room");
    expect(ctor.querySelector(".org-name").textContent).toBe("constructor");
    expect(ctor.querySelector(".org-desc")).toBeNull();
    expect(ctor.querySelectorAll(".org-link").map((a: any) => a.getAttribute("href"))).toEqual(["/ui/chat/constructor"]);
  });
});

describe("orgState", () => {
  it("needs you first, then the instance's status, then its execution state", () => {
    expect(O.orgState(null, "working", null, 0)).toBe("missing");
    expect(O.orgState({ status: "paused" }, null, "", 0)).toBe("needs");
    expect(O.orgState({ status: "crashed" }, null, null, 2)).toBe("needs");
    expect(O.orgState({ status: "crashed" }, null, null, 0)).toBe("crashed");
    expect(O.orgState({ status: "paused" }, "working", null, 0)).toBe("paused");
    expect(O.orgState({ status: "stopped" }, "working", null, 0)).toBe("stopped");
    expect(O.orgState({ status: "running" }, "stuck", null, 0)).toBe("stuck");
    expect(O.orgState({ status: "running" }, "working", null, 0)).toBe("working");
    expect(O.orgState({ status: "running" }, null, null, 0)).toBe("idle");
  });
});
