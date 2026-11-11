// drive.mjs: the rig's HTTP hands. Run inside the container as rh.
//   member GET|POST <path> [json]          a member fleet's dashboard API as its signed-in local admin
//                                          (env PORT, default 19280; AGEND_HOME, default ~/.agend)
//   hub <login> GET|POST|PUT <path> [json]  the Hub web API as a directory person (the fake AD's dummy password)
//   policy                                  alice turns group permissions on (CN=Owners: Chat + Connect a fleet, 1 fleet),
//                                          resolve → preview → save in ONE session, as the editor does
//   quickpair <label>                       carol quick-pairs THIS member fleet (PORT/AGEND_HOME): offer → connect →
//                                          fingerprint on both sides → carol confirms → claimed (one Hub session)
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
const [cmd, ...args] = process.argv.slice(2);
const PORT = Number(process.env.PORT ?? 19280), ORIGIN = `http://127.0.0.1:${PORT}`, AH = process.env.AGEND_HOME ?? "/home/rh/.agend";
const call = (mod, opts, body) => new Promise((ok, no) => {
  const r = mod.request(opts, (res) => { let d = ""; res.on("data", (c) => d += c); res.on("end", () => { let j = d; try { j = JSON.parse(d); } catch {} ok({ status: res.statusCode, headers: res.headers, body: j }); }); });
  r.on("error", no); if (body !== undefined) r.write(body); r.end();
});
const local = (method, path, headers = {}, body) => call(http, { host: "127.0.0.1", port: PORT, method, path, headers: { host: `127.0.0.1:${PORT}`, ...headers } }, body);
const out = (x) => console.log(JSON.stringify(x));
async function memberSession() {
  const token = readFileSync(`${AH}/web.token`, "utf8").trim();
  const issued = (await local("POST", "/auth/issue-code", { "X-Agend-Token": token })).body;
  const login = await local("POST", "/auth/login", { origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin" }, JSON.stringify({ code: issued.code }));
  const cookie = (login.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ");
  const session = (await local("GET", "/auth/session", { cookie, origin: ORIGIN })).body;
  return (method, path, json) => local(method, path, { cookie, origin: ORIGIN, "sec-fetch-site": "same-origin", "x-agend-csrf": session.csrf, ...(json ? { "content-type": "application/json" } : {}) }, json);
}
async function hubSession(login) {
  const ca = readFileSync("/opt/acc/hub-ca.pem", "utf8");
  const password = JSON.parse(readFileSync("/opt/acc/users.json", "utf8")).find((u) => u.login === login)?.password ?? "none";
  const origin = "https://hub.example.test:18601";
  const hub = (m, p, headers = {}, body) => call(https, { host: "127.0.0.1", port: 18601, servername: "hub.example.test", ca, method: m, path: p,
    headers: { origin, host: "hub.example.test:18601", "sec-fetch-site": "same-origin", ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}), ...headers } }, body);
  const s = await hub("POST", "/hub/v1/session", {}, JSON.stringify({ login, password }));
  if (s.status !== 200) return { error: { signIn: s.status, body: s.body } };
  const cookie = s.headers["set-cookie"][0].split(";")[0];
  return { features: s.body.features ?? null, req: (m, p, json) => hub(m, p, { cookie, "x-agend-hub-csrf": s.body.csrf }, json) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (cmd === "policy") {
  const h = await hubSession("alice"); if (h.error) { out(h.error); process.exit(1); }
  const before = (await h.req("GET", "/hub/v1/admin/group-policy")).body;
  const resolved = (await h.req("POST", "/hub/v1/admin/group-policy/resolve", JSON.stringify({ dn: "CN=Owners,DC=example,DC=test" }))).body;
  const pol = before.policy ?? {};
  const policy = { realm: pol.realm ?? resolved.realm, generation: pol.generation, revision: pol.revision ?? 0, state: "enabled",
    groups: [{ group: { realm: resolved.realm, objectId: resolved.objectId }, dn: resolved.dn, allow: ["ask_agents", "pair_fleet"], maxFleets: 1 }], denies: [] };
  const preview = await h.req("POST", "/hub/v1/admin/group-policy/preview", JSON.stringify({ policy }));
  const save = preview.body?.previewDigest ? await h.req("PUT", "/hub/v1/admin/group-policy", JSON.stringify({ policy, previewDigest: preview.body.previewDigest })) : null;
  const after = (await h.req("GET", "/hub/v1/admin/group-policy")).body;
  out({ features: h.features, before: { supported: before.supported, binding: before.binding, state: before.policy?.state }, resolved,
    preview: { status: preview.status, ok: preview.body?.ok, code: preview.body?.code, impact: preview.body?.impact }, save: save && { status: save.status, body: save.body },
    after: { state: after.policy?.state, revision: after.policy?.revision, groups: after.policy?.groups?.length } });
} else if (cmd === "quickpair") {
  const { execFileSync } = await import("node:child_process");
  // A web-only fleet's host-authorised web session confirms its own change at once (state "applied"); only a change
  // still waiting for a General / this computer's admin goes through `agend settings confirm`.
  const confirmChange = (r) => { const pc = r?.body?.pending_change; const id = pc?.id; if (!id) return `no pending change (${r?.status} ${JSON.stringify(r?.body).slice(0, 200)})`;
    if (pc.state && pc.state !== "pending") return `already ${pc.state} by the web session`;
    try { return execFileSync("agend", ["settings", "confirm", id, "--yes"], { encoding: "utf8", env: process.env }).trim().split("\n").at(-1); }
    catch (e) { return `confirm refused: ${String(e.stderr ?? e.message).trim()} (state was ${pc.state})`; } };
  const log = {};
  const h = await hubSession("carol"); if (h.error) { out(h.error); process.exit(1); }
  log.welcomeBefore = (await h.req("GET", "/hub/v1/me/welcome")).body?.connect;
  const offer = await h.req("POST", "/hub/v1/quick-pairing", JSON.stringify({ label: args[0] ?? "carol fleet" }));
  log.offer = { status: offer.status, code: offer.body?.code ? "<12 hex>" : offer.body };
  if (!offer.body?.code) { out(log); process.exit(1); }
  const m = await memberSession();
  let conn; for (let i = 0; i < 30; i++) { conn = await m("POST", "/api/hub/member/pairing/connect", JSON.stringify({ address: offer.body.memberOrigin, code: offer.body.code })); if (!JSON.stringify(conn.body).includes("fleet_starting")) break; await sleep(2000); }
  log.connect = confirmChange(conn);
  let digest; for (let i = 0; i < 30 && !digest; i++) { digest = (await m("GET", "/api/hub/member/pairing")).body?.pairing?.fingerprint?.digest; if (!digest) await sleep(1000); }
  log.memberConfirm = confirmChange(await m("POST", "/api/hub/member/pairing/confirm", JSON.stringify({ digest })));
  const att = (await h.req("GET", `/hub/v1/quick-pairing?id=${offer.body.pairingId}`)).body?.attempt;
  log.fingerprintsMatch = !!digest && att?.fingerprint === digest;
  log.carolConfirm = (await h.req("POST", `/hub/v1/pairings/${offer.body.pairingId}/confirm`, JSON.stringify({ fingerprint: att?.fingerprint }))).status;
  let a; for (let i = 0; i < 40; i++) { a = (await h.req("GET", `/hub/v1/quick-pairing?id=${offer.body.pairingId}`)).body?.attempt; if (a?.state === "claimed" && a?.connected) break; await sleep(2000); }
  log.attempt = { state: a?.state, connected: a?.connected, ownerConfirmed: a?.ownerConfirmed, fleet: !!a?.fleetId };
  let p; for (let i = 0; i < 30; i++) { p = (await m("GET", "/api/hub/member/pairing")).body?.pairing; if (p?.state === "paired" && p?.link === "online") break; await sleep(2000); }
  log.member = `${p?.state}/${p?.link}`;
  log.welcomeAfter = (await h.req("GET", "/hub/v1/me/welcome")).body?.connect;
  out(log);
} else if (cmd === "member") {
  const [method, path, json] = args;
  const token = readFileSync(`${AH}/web.token`, "utf8").trim();
  const issued = (await local("POST", "/auth/issue-code", { "X-Agend-Token": token })).body;
  const login = await local("POST", "/auth/login", { origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin" }, JSON.stringify({ code: issued.code }));
  const cookie = (login.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ");
  const session = (await local("GET", "/auth/session", { cookie, origin: ORIGIN })).body;
  const res = await local(method, path, { cookie, origin: ORIGIN, "sec-fetch-site": "same-origin", "x-agend-csrf": session.csrf, ...(json ? { "content-type": "application/json" } : {}) }, json);
  out({ status: res.status, body: res.body });
} else if (cmd === "hub") {
  const [login, method, path, json] = args;
  const ca = readFileSync("/opt/acc/hub-ca.pem", "utf8");
  const password = JSON.parse(readFileSync("/opt/acc/users.json", "utf8")).find((u) => u.login === login)?.password ?? "none";
  const origin = "https://hub.example.test:18601";
  const hub = (m, p, headers = {}, body) => call(https, { host: "127.0.0.1", port: 18601, servername: "hub.example.test", ca, method: m, path: p,
    headers: { origin, host: "hub.example.test:18601", "sec-fetch-site": "same-origin", ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}), ...headers } }, body);
  const s = await hub("POST", "/hub/v1/session", {}, JSON.stringify({ login, password }));
  if (s.status !== 200) { out({ signIn: s.status, body: s.body }); process.exit(1); }
  const cookie = s.headers["set-cookie"][0].split(";")[0];
  const res = await hub(method, path, { cookie, "x-agend-hub-csrf": s.body.csrf }, json);
  out({ status: res.status, body: res.body, ...(path === "/hub/v1/session" ? {} : { features: s.body.features ?? null }) });
}
