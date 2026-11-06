/** A sealed scratch Hub with real HTTPS/S3/D storage; only directory and member delivery are fakes. */
import { createServer } from "node:net";
import { request } from "node:https";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import yaml from "js-yaml";
import { createHubInitializer } from "../../src/hub/init/initializer.js";
import { hubIdentityProvider } from "../../src/hub/init/identity.js";
import { createHubServerFactory, type HubHttp } from "../../src/hub/compose/server.js";
import { createHubHttp, HUB_HTTP_MIGRATIONS } from "../../src/hub/http/compose.js";
import { hubTxDatabase } from "../../src/hub/db.js";
import type { HubBrowserCertificateControl } from "../../src/hub/browser-certificate.js";
import type { HubDirectory, HubMemberFrame } from "../../src/hub/types.js";
import type { DirectoryPerson } from "../../src/hub/directory/index.js";
import type { HubLinkContext } from "../../src/hub/server.js";
import { ADMIN, makeTestCerts } from "../support/hub-init-fixtures.js";

export interface PreviewBrowser { cookie: string; csrf: string }
export async function hubPreviewRig(opts: { preview?: boolean; start?: boolean } = {}) {
  mkdirSync(".artifacts", { recursive: true });
  const home = mkdtempSync(join(process.cwd(), ".artifacts/hub-preview-")); chmodSync(home, 0o700);
  const certs = makeTestCerts();
  // Keep every reservation until all addresses are chosen: sequential close/probe can return the same port.
  const reservations = await Promise.all(Array.from({ length: 3 }, async () => {
    const server = createServer(); await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); return server;
  }));
  const [memberPort, webPort, previewPort] = reservations.map(s => (s.address() as { port: number }).port) as [number, number, number];
  await Promise.all(reservations.map(s => new Promise<void>(done => s.close(() => done()))));
  const webOrigin = `https://hub.example.test:${webPort}`, previewOrigin = `https://hub.example.test:${previewPort}`;
  const plan = { name: "Preview Hub", webOrigin, memberOrigin: `https://hub.example.test:${memberPort}`,
    webListen: { host: "127.0.0.1", port: webPort }, memberListen: { host: "127.0.0.1", port: memberPort },
    webTls: { certFile: certs.cert, keyFile: certs.key },
    directory: { realm: "corp", url: "ldaps://directory.example.test", baseDn: "dc=example,dc=test", bindDn: "cn=reader,dc=example,dc=test", profile: "openldap" as const },
    bindPasswordRef: "file:hub/secrets/directory-bind", administrator: ADMIN.key,
    retention: { contentDays: 30, eventDays: 180 }, coexistence: "dedicated" as const };
  const init = createHubInitializer({ home, identity: hubIdentityProvider(), probe: { pidAlive: () => false } });
  const confirmation = await init.prepareConfirmation(plan, { bindPassword: "Scratch-" + "x".repeat(20) });
  await init.commit(plan, confirmation.reference);
  const config = (yaml.load(readFileSync(join(home, "fleet.yaml"), "utf8")) as { hub: Record<string, unknown> }).hub;
  if (opts.preview !== false) config.web = { preview_port: previewPort };
  const people = new Map<string, { person: DirectoryPerson; eligible: boolean }>();
  people.set("admin", { person: { ...ADMIN, login: "admin" }, eligible: true });
  for (const login of ["owner", "asker", "other"]) people.set(login, { person: { key: { realm: "corp", objectId: randomUUID() }, login, displayName: login, dn: `uid=${login}`, groups: [] }, eligible: true });
  const directory: HubDirectory = {
    realm: "corp", signIn: async (login, password) => {
      const p = people.get(login);
      return p?.eligible && password === `pw-${login}` ? { ok: true, person: p.person } : { ok: false, reason: "invalid-credentials" };
    },
    checkEligibility: async key => {
      const p = [...people.values()].find(p => p.person.key.objectId === key.objectId && p.person.key.realm === key.realm);
      return p?.eligible ? { eligible: true, person: p.person } : { eligible: false, reason: "disabled" };
    }, close: async () => {},
  };
  let http!: HubHttp, certificate: HubBrowserCertificateControl | null = null, alive = true;
  const webRequests: string[] = [];
  const factory = createHubServerFactory({ home, components: { http: async () => ({ migrations: HUB_HTTP_MIGRATIONS,
    createHubHttp: deps => { const entry = http = createHubHttp(deps, hubTxDatabase); return { ...entry,
      handle: (req, res) => { webRequests.push(req.url ?? ""); return entry.handle(req, res); } }; } }) },
    createDirectory: () => directory, report: () => {}, log: () => {},
    browserCertificateReady: control => { certificate = control; return () => { certificate = null; }; } });
  const service = opts.start === false ? null : await factory(config, () => alive);
  if (service) await service.start();
  const call = (browser: PreviewBrowser | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}, target: "web" | "preview" = "web") => {
    const data = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const origin = target === "web" ? webOrigin : previewOrigin;
    const headers: Record<string, string> = { Host: new URL(origin).host, Origin: webOrigin,
      ...(browser ? { Cookie: browser.cookie, "X-AgEnD-Hub-CSRF": browser.csrf } : {}),
      ...(data ? { "Content-Type": Buffer.isBuffer(body) ? "text/html" : "application/json", "Content-Length": String(data.length) } : {}), ...extra };
    return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; bytes: Buffer; text: string; json: any; fingerprint?: string }>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: target === "web" ? webPort : previewPort, servername: "hub.example.test",
        ca: [readFileSync(certs.caCert), readFileSync(certs.selfSigned)], method, path, headers, agent: false }, res => {
        const parts: Buffer[] = [], fingerprint = (res.socket as import("node:tls").TLSSocket).getPeerCertificate().fingerprint256;
        res.on("data", b => parts.push(Buffer.from(b))); res.on("end", () => {
          const bytes = Buffer.concat(parts), text = bytes.toString("utf8"); let json: any = null; try { json = JSON.parse(text); } catch { /* HTML/binary */ }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes, text, json, fingerprint });
        });
      }); req.on("error", reject); req.end(data);
    });
  };
  const signIn = async (login: string) => {
    const r = await call(null, "POST", "/hub/v1/session", { login, password: `pw-${login}` });
    if (r.status !== 200) throw Error(`sign in failed: ${r.status}`);
    return { cookie: r.headers["set-cookie"]![0]!.split(";")[0]!, csrf: r.json.csrf };
  };
  const htmlWorld = async (html: string) => {
    const owner = await signIn("owner"), asker = await signIn("asker"), other = await signIn("other");
    const ownerKey = people.get("owner")!.person.key, fleetId = randomUUID();
    const link: HubLinkContext = { fleetId, owner: ownerKey, linkEpoch: 1, features: new Set(["welcome-caps-v1", "attachments-v1"]), current: () => alive };
    const frame = <T extends string, P>(type: T, payload: P) => ({ v: 1 as const, type, requestId: randomUUID(), linkEpoch: 1, payload });
    const exposureId = randomUUID();
    await http.receive(frame("exposure.snapshot", { revision: 1, exposures: [{ id: exposureId, fleetId, owner: ownerKey, displayName: "Atlas", revision: 1,
      state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) }] }) as HubMemberFrame & { type: "exposure.snapshot" }, link);
    const grant = (await call(owner, "POST", "/hub/v1/grants", { exposureId, exposureRevision: 1, login: "asker", days: 7 })).json.grant;
    const room = (await call(asker, "POST", "/hub/v1/rooms", { exposureId, grantId: grant.id })).json.room;
    const upload = await call(asker, "POST", `/hub/v1/rooms/${room.id}/files`, Buffer.from(html), { "X-File-Name": "preview.html" });
    if (upload.status !== 200) throw Error(`HTML upload failed: ${upload.status} ${upload.text}`);
    return { owner, asker, other, grant, room, file: upload.json.file, link };
  };
  return { home, config, factory, service, webOrigin, previewOrigin, webPort, previewPort, memberPort, certs, call, signIn, htmlWorld, people, webRequests,
    certificate: () => certificate, fence: () => { alive = false; service?.fence(); },
    close: async () => { alive = false; await service?.close(); rmSync(home, { recursive: true, force: true }); rmSync(certs.dir, { recursive: true, force: true }); } };
}
