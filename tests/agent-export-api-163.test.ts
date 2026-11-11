/** AGEND-163: the two routes behind Export and Load template — admin only, computed from the saved config, nothing written. */
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { handleWebRequest } from "../src/web-api.js";
import { loadFleetConfigSource, loadRawFleetConfigSource } from "../src/config.js";
import { fake } from "./helpers/fake-secrets-163.js";

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); } });

async function rig() {
  const token = "a".repeat(48), sessions = new WebSessionStore();
  const admin = sessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: tokenEpoch(token) });
  const before = { instances: { coder: { working_directory: "/w", channel_id: "discord", description: "Reviews", systemPrompt: "# Role", tags: ["a"] } } };
  // The route reads the agent's own saved settings (rawInstanceConfig), as FleetManager gives them; `fleetConfig` is the merged one.
  const ctx: any = { webToken: token, webSessions: sessions, fleetConfig: structuredClone(before), rawInstanceConfig: (n: string) => (Object.hasOwn(before.instances, n) ? structuredClone((before.instances as any)[n]) : undefined), logger: { error() {}, info() {}, warn() {}, debug() {} } };
  const s = createServer((req, res) => { handleWebRequest(req, res, new URL(req.url!, `http://${req.headers.host}`), ctx); });
  servers.push(s); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const base = `http://127.0.0.1:${(s.address() as any).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", cookie: `agend_session=${admin.sessionId}`, origin: base, "x-agend-csrf": csrfTokenFor(admin.sessionId), ...headers } });
  const as = (sessionId: string) => (path: string, body: unknown) => fetch(base + path, { method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", cookie: `agend_session=${sessionId}`, origin: base, "x-agend-csrf": csrfTokenFor(sessionId) } });
  return { ctx, before, post, base, sessions, token, as };
}

it("build: the saved agent's file, without the excluded fields; parse: what a file would fill", async () => {
  const r = await rig();
  const built = await (await r.post("/ui/agent-export/build", { instance: "coder", include: ["identity", "systemPrompt"] })).json();
  expect(built.text).toContain("agend_export: 1");
  expect(built.text).not.toContain("discord");
  const read = await (await r.post("/ui/agent-export/parse", { text: built.text })).json();
  expect(read).toMatchObject({ ok: true, fill: { description: "Reviews", systemPrompt: "# Role", tags: ["a"] } });
  expect(r.ctx.fleetConfig).toEqual(r.before);
});

it("build: a secret withholds the text; bad requests and unknown agents are refused", async () => {
  const r = await rig();
  r.ctx.rawInstanceConfig = () => ({ ...r.before.instances.coder, systemPrompt: `key ${fake.anthropicKey()}` });
  const blocked = await (await r.post("/ui/agent-export/build", { instance: "coder", include: ["systemPrompt"] })).json();
  expect(blocked.text).toBeNull();
  expect(blocked.findings).toEqual([{ field: "systemPrompt", line: 1, kind: "api_key" }]);
  expect(JSON.stringify(blocked)).not.toContain("abcdefghij");
  expect((await r.post("/ui/agent-export/build", { instance: "nobody", include: [] })).status).toBe(404);
  expect((await r.post("/ui/agent-export/build", { instance: "__proto__", include: [] })).status).toBe(404);
  expect((await r.post("/ui/agent-export/build", { instance: "constructor", include: [] })).status).toBe(404);
  expect((await r.post("/ui/agent-export/build", { instance: "coder", include: "all" })).status).toBe(400);
  expect((await r.post("/ui/agent-export/parse", [])).status).toBe(400);
  expect(await (await r.post("/ui/agent-export/parse", { text: 5 })).json()).toEqual({ ok: false, error: "empty" });
});

it("only the admin session may use them (no cookie, a bad CSRF token, a guest or a read-only session are refused)", async () => {
  const r = await rig();
  expect((await r.post("/ui/agent-export/parse", { text: "x" }, { cookie: "" })).status).toBeGreaterThanOrEqual(400);
  expect((await r.post("/ui/agent-export/parse", { text: "x" }, { "x-agend-csrf": "nope" })).status).toBeGreaterThanOrEqual(400);
  // A real session of a lower tier, with a valid cookie and CSRF token: the guest's and the read-only tier's.
  const guest = r.sessions.create({ tier: "guest", surface: "local", label: "g", tokenEpoch: tokenEpoch(r.token), owner: { adapterId: "telegram", userId: "7" } });
  const read = r.sessions.create({ tier: "read", surface: "local", label: "r", tokenEpoch: tokenEpoch(r.token) });
  for (const who of [guest, read]) for (const path of ["/ui/agent-export/parse", "/ui/agent-export/build"]) {
    expect((await r.as(who.sessionId)(path, { text: "agend_export: 1", instance: "coder", include: [] })).status, `${who.record.tier} ${path}`).toBeGreaterThanOrEqual(403);
  }
});

it("build writes only what the agent itself saved, not the fleet's defaults merged into the running config (AGEND-163 review)", async () => {
  const r = await rig();
  const yamlText = `defaults:
  backend: codex
  model: gpt-5
  log_level: debug
  tool_set: coordinator
  systemPrompt: Fleet-wide house rules for every agent.
instances:
  dev:
    working_directory: /tmp/agx-dev
    description: My dev agent
`;
  // What the running fleet holds (loadFleetConfigSource merges the defaults into every instance) and what fleet.yaml says.
  const merged = loadFleetConfigSource(yamlText) as any, raw = loadRawFleetConfigSource(yamlText) as any;
  expect(merged.instances.dev.systemPrompt).toBe("Fleet-wide house rules for every agent.");      // the premise: they differ
  expect(raw.instances.dev.systemPrompt).toBeUndefined();
  r.ctx.fleetConfig = merged;
  r.ctx.rawInstanceConfig = (n: string) => (Object.hasOwn(raw.instances, n) ? raw.instances[n] : undefined);
  const built = await (await r.post("/ui/agent-export/build", { instance: "dev", include: ["identity", "systemPrompt", "runtime", "behavior"] })).json();
  expect(built.text).toContain("description: My dev agent");
  for (const word of ["house rules", "codex", "gpt-5", "debug", "coordinator", "behavior", "tool_progress", "auto_pause_after"]) expect(built.text, word).not.toContain(word);
  expect(built.empty).toBe(false);
  // An agent that sets nothing of its own is empty, however much the fleet's defaults give it.
  raw.instances.dev = { working_directory: "/tmp/agx-dev" };
  const none = await (await r.post("/ui/agent-export/build", { instance: "dev", include: ["identity", "systemPrompt", "runtime", "behavior"] })).json();
  expect(none.empty).toBe(true);
  // No way to read the agent's own settings, or the agent is not in fleet.yaml: refused, never the merged copy.
  r.ctx.rawInstanceConfig = undefined;
  expect((await r.post("/ui/agent-export/build", { instance: "dev", include: ["identity"] })).status).toBe(404);
  r.ctx.rawInstanceConfig = () => undefined;
  expect((await r.post("/ui/agent-export/build", { instance: "dev", include: ["identity"] })).status).toBe(404);
});
