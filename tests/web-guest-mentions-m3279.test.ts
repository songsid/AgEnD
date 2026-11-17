import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guestFrameData, guestMessages, type GuestRequest } from "../src/web-guest-access.js";
import { messageMentionNames } from "../src/web-mentions.js";
import type { WebChatMessage } from "../src/web-chat-history.js";
import "../src/ui/chat-render.js";
// @ts-expect-error — the browser's untyped module
import { createMentionIndex } from "../src/ui/chat-mentions.js";

vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, k) => k === "child" ? () => silent : () => {} });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});
const home = mkdtempSync(join(tmpdir(), "agend-guest-mentions-"));
process.env.AGEND_HOME = home;
const { FleetManager } = await import("../src/fleet-manager.js");
const { WEB_SESSION_COOKIE } = await import("../src/web-auth.js");
const { tokenEpoch } = await import("../src/web-session.js");

// Deliberately synthetic Discord-style ids and names; no real account or connection.
const FIRST = "900000000000000001", SECOND = "900000000000000002", HIDDEN = "900000000000000003";
const owner = { adapterId: "discord", userId: "900000000000000099" };
let fm: any, port: number, admin: string, guest: string;
const queried: Array<{ u: string[]; r: string[]; c: string[] }> = [];
function get(path: string, sid: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { cookie: `${WEB_SESSION_COOKIE}=${sid}` } }, res => {
      let data = ""; res.on("data", c => { data += c; }); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
    }); req.on("error", reject); req.end();
  });
}
async function labels(sid: string) {
  const history = await get("/ui/history?instance=agent-alpha", sid);
  const fetches: string[] = [];
  const idx = createMentionIndex(async (path: string) => {
    fetches.push(path); const r = await get(path, sid);
    return { ok: r.status === 200, json: async () => r.body };
  });
  idx.ensure(history.body.messages);
  await vi.waitFor(() => expect(idx.pending()).toBe(0));
  const html = (globalThis as any).AgendChatRender.renderMarkdown(history.body.messages[0].text, { mentions: idx.name });
  return { history, html, fetches };
}
beforeAll(async () => {
  writeFileSync(join(home, "fleet.yaml"), `health_port: 0\ninstances:\n  agent-alpha:\n    working_directory: ${home}\n    backend: codex\n  agent-beta:\n    working_directory: ${home}\n    backend: codex\nweb:\n  guests:\n    enabled: true\n`);
  fm = new FleetManager(home); fm.loadConfig(join(home, "fleet.yaml"));
  const quiet = () => {}; fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, child: () => fm.logger };
  fm.notifyFleetError = () => true;
  fm.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
  fm.getInstanceStatus = () => "running"; fm.guestScope = () => new Set(["agent-alpha"]);
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  port = fm.healthServer.address().port; fm.initializeWebSessions();
  const session = (tier: "admin" | "guest") => fm.webSessions.create({ tier, surface: "local", label: "fixture", tokenEpoch: tokenEpoch(fm.getDashboardAccess().token), ...(tier === "guest" ? { owner } : {}) }).sessionId;
  admin = session("admin"); guest = session("guest");
  for (const [id, name] of [[FIRST, "Avery"], [SECOND, "Blair"], [HIDDEN, "Hidden fixture"]]) fm.seenUsers.record(id, name);
  const read = fm.webMentionNames.bind(fm);
  fm.webMentionNames = (q: { u: string[]; r: string[]; c: string[] }) => { queried.push(q); return read(q); };
  const message = (instance: string, text: string, channel?: true) => fm.emitSseEvent("message", { instance, sender: "Example agent", role: "agent", text, ts: new Date().toISOString(), ...(channel ? { channel } : {}) });
  message("agent-alpha", `Hello <@${FIRST}> and <@!${SECOND}>.`, true);
  message("agent-alpha", `Hidden <@${HIDDEN}>.`);
  message("agent-beta", `Other room <@${HIDDEN}>.`, true);
});
afterAll(async () => {
  await new Promise<void>(r => { fm.healthServer.closeAllConnections?.(); fm.healthServer.close(r); });
  await fm.stopPreviewListener?.(); rmSync(home, { recursive: true, force: true });
});

describe("M-3279 mention names belong to permitted messages", () => {
  it("the admin continues resolving the same two names", async () => {
    const r = await labels(admin);
    expect(r.history.status).toBe(200); expect(r.html).toContain("@Avery"); expect(r.html).toContain("@Blair");
    expect(r.fetches).toHaveLength(1);
  });
  it("the guest sees those names without querying the member lookup", async () => {
    const r = await labels(guest);
    expect(r.history.status).toBe(200); expect(r.html).toContain("@Avery"); expect(r.html).toContain("@Blair");
    expect(r.fetches).toEqual([]);
    expect(r.history.body.messages).toHaveLength(1);
    expect(r.history.body.messages[0].mentionNames?.u).toEqual({ [FIRST]: "Avery", [SECOND]: "Blair" });
  });
  it("keeps arbitrary-id lookup and another room closed to guests", async () => {
    expect((await get(`/ui/mentions?u=${HIDDEN}`, guest)).status).toBe(403);
    expect((await get("/ui/history?instance=agent-beta", guest)).status).toBe(404);
  });
  it("polls resolve only visible message ids, never hidden or out-of-scope rows", async () => {
    queried.length = 0;
    const r = await get("/ui/poll", guest);
    expect(r.status).toBe(200); expect(r.body.messages).toHaveLength(1);
    expect(r.body.messages[0].mentionNames?.u).toEqual({ [FIRST]: "Avery", [SECOND]: "Blair" });
    expect(queried.flatMap(q => [...q.u, ...q.r, ...q.c])).not.toContain(HIDDEN);
    expect(JSON.stringify(r.body)).not.toContain("Hidden fixture");
  });
  it("uses the same visible-only labels for live frames and reconnect replay", () => {
    const source = vi.fn(() => ({ u: { [FIRST]: "Avery", [HIDDEN]: "Hidden fixture" } }));
    const scope = new Set(["agent-alpha"]);
    const context: GuestRequest = { owner, mentionNames: source, scope: () => scope, current: () => true };
    const row: WebChatMessage = { boot: "fixture", id: 1, role: "agent", sender: "Example agent", ts: "2026-01-01T00:00:00.000Z", instance: "agent-alpha", text: `<@${FIRST}>`, channel: true };
    const live = guestFrameData("message", row, scope, context) as Record<string, unknown>;
    expect(live.mentionNames).toEqual({ u: { [FIRST]: "Avery" }, r: {}, c: {} });
    expect(guestMessages([row], context, scope)).toEqual([live]);
    source.mockClear();
    expect(guestFrameData("message", { ...row, channel: false }, scope, context)).toBeUndefined();
    expect(guestMessages([{ ...row, instance: "agent-beta" }], context, scope)).toEqual([]);
    expect(source).not.toHaveBeenCalled();
  });
  it("resolves a clicked button's shown label without resolving its private value", () => {
    const source = vi.fn(() => ({ u: { [FIRST]: "Avery", [HIDDEN]: "Hidden fixture" } }));
    const row: WebChatMessage = { boot: "fixture", id: 1, role: "user", sender: "Example person", ts: "2026-01-01T00:00:00.000Z", instance: "agent-alpha", text: `<@${HIDDEN}>`, channel: true, click: { label: `<@${FIRST}>` } };
    const scope = new Set(["agent-alpha"]);
    const [shown] = guestMessages([row], { owner, mentionNames: source, scope: () => scope, current: () => true }, scope);
    expect(shown!.text).toBe(`<@${FIRST}>`);
    expect(shown!.mentionNames).toEqual({ u: { [FIRST]: "Avery" }, r: {}, c: {} });
    expect(source).toHaveBeenCalledExactlyOnceWith({ u: [FIRST], r: [], c: [] });
  });
  it("batches message tokens and keeps only resolved names of those tokens", () => {
    const ids = Array.from({ length: 101 }, (_, i) => String(900000000000001000n + BigInt(i)));
    const source = vi.fn((q: { u: string[]; r: string[]; c: string[] }) => ({ u: Object.fromEntries([...q.u.map(id => [id, "Avery"]), [HIDDEN, "Hidden fixture"]]), r: { [FIRST]: "Example role" }, c: { [SECOND]: "Example channel" } }));
    const names = messageMentionNames(ids.map(id => `<@${id}>`).join(" ") + ` <@&${FIRST}> <#${SECOND}> <@${ids[0]}>`, source);
    expect(source.mock.calls.map(([q]) => q.u.length + q.r.length + q.c.length)).toEqual([100, 3]);
    expect(Object.keys(names!.u)).toEqual(ids);
    expect(names!.r).toEqual({ [FIRST]: "Example role" }); expect(names!.c).toEqual({ [SECOND]: "Example channel" });
    expect(names!.u).not.toHaveProperty(HIDDEN);
    expect(messageMentionNames(`<@${HIDDEN}>`, () => ({}))).toBeUndefined();
  });
  it("the client seeds only tokens it displays and redraws when their labels change", () => {
    const fetch = vi.fn(), changed = vi.fn(), idx = createMentionIndex(fetch);
    idx.subscribe(changed);
    const row = { text: `<@${FIRST}>`, mentionNames: { u: { [FIRST]: " Avery ", [HIDDEN]: "Hidden fixture" } } };
    idx.ensure([row]); idx.ensure([row]);
    expect(idx.name("u", FIRST)).toBe("Avery"); expect(idx.name("u", HIDDEN)).toBeNull();
    expect(fetch).not.toHaveBeenCalled(); expect(changed).toHaveBeenCalledTimes(1);
    idx.ensure([{ ...row, mentionNames: { u: { [FIRST]: "Avery updated" } } }]);
    expect(idx.name("u", FIRST)).toBe("Avery updated"); expect(changed).toHaveBeenCalledTimes(2);
  });
});
