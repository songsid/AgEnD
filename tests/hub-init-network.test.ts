/** Own loopback sockets and scratch files only; no fleet, directory, service or outbound connections. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, Server, type AddressInfo } from "node:net";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkHubInitNetwork, checkHubInitNetworkForHome, type HubInitListeners } from "../src/hub/init/network.js";
import { runHubInitWizard } from "../src/hub/init/wizard.js";
import { createHubInitializer } from "../src/hub/init/initializer.js";
import type { HubInitPlan } from "../src/hub/init/types.js";
import { setLocale } from "../src/locale.js";
import { ht } from "../src/hub/init/text.js";
import { ADMIN, FakeIdentity, fakeDirectory, makeTestCerts, scriptedIO, tempDir } from "./support/hub-init-fixtures.js";

const sockets: Server[] = [], roots: string[] = [];
beforeEach(() => {
  const listen = Server.prototype.listen;
  vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server, ...args: unknown[]) {
    if (!sockets.includes(this)) sockets.push(this);
    return Reflect.apply(listen, this, args) as Server;
  });
});
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks(); setLocale("en");
  for (const server of sockets.splice(0)) if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const home of roots.splice(0)) rmSync(home, { recursive: true, force: true });
});
async function bind(port = 0): Promise<Server> {
  const server = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return server;
}
const portOf = (server: Server) => (server.address() as AddressInfo).port;
const pair = (web: number, member: number): HubInitListeners => ({ webListen: { host: "127.0.0.1", port: web }, memberListen: { host: "127.0.0.1", port: member } });
async function freePair() {
  const a = await bind(), b = await bind(), ports = pair(portOf(a), portOf(b));
  await Promise.all([a, b].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  return ports;
}
const home = () => { const h = tempDir("agend-hub-network-"); roots.push(h); return h; };

describe("Hub listener preflight", () => {
  it("binds both listeners together, closes them, and leaves both endpoints reusable", async () => {
    const listeners = await freePair(), dns = vi.fn();
    expect(await checkHubInitNetwork(listeners, { resolve: dns })).toEqual([]); expect(dns).not.toHaveBeenCalled();
    expect(await checkHubInitNetwork(listeners)).toEqual([]);
    expect(portOf(await bind(listeners.webListen.port))).toBe(listeners.webListen.port);
    expect(portOf(await bind(listeners.memberListen.port))).toBe(listeners.memberListen.port);
  });
  it.each(["web", "member"] as const)("refuses an occupied %s endpoint without closing its owner, and releases an earlier successful bind", async listener => {
    const listeners = await freePair(), input = listeners[`${listener}Listen`], owner = await bind(input.port);
    expect(await checkHubInitNetwork(listeners)).toEqual([{ listener, reason: "occupied" }]); expect(owner.listening).toBe(true);
    const other = listener === "web" ? listeners.memberListen : listeners.webListen;
    expect(portOf(await bind(other.port))).toBe(other.port);
  });
  it("holds the first socket while resolving/binding the second, catching two names for the same endpoint", async () => {
    const listeners = await freePair(); listeners.memberListen = { host: "alias.example.test", port: listeners.webListen.port };
    const resolve = vi.fn(async () => "127.0.0.1");
    expect(await checkHubInitNetwork(listeners, { resolve })).toEqual([{ listener: "member", reason: "occupied" }]);
    expect(resolve).toHaveBeenCalledExactlyOnceWith("alias.example.test");
    expect(portOf(await bind(listeners.webListen.port))).toBe(listeners.webListen.port);
  });
  it("checks that the selected interface really belongs to this host", async () => {
    const listeners = await freePair(); listeners.webListen.host = "192.0.2.171";
    expect(await checkHubInitNetwork(listeners)).toEqual([{ listener: "web", reason: "interface" }]);
  });
  it.each(["0.0.0.0", "::", "0:0:0:0:0:0:0:0", "*", "", "not a host"])("refuses wildcard or invalid interface %j before binding", async host => {
    const listeners = await freePair(); listeners.webListen.host = host;
    const attempted = vi.spyOn(Server.prototype, "listen").mockClear().mockImplementation(() => { throw Object.assign(Error("test forbids wildcard bind"), { code: "EMFILE" }); });
    expect(await checkHubInitNetwork(listeners)).toEqual([{ listener: "web", reason: "invalid" }]);
    expect(attempted).not.toHaveBeenCalled();
  });
  it.each([0, -1, 65536, 1.5])("refuses port %s", async port => {
    const listeners = await freePair(); listeners.webListen.port = port;
    expect(await checkHubInitNetwork(listeners)).toEqual([{ listener: "web", reason: "invalid" }]);
  });
  it("refuses DNS failure, non-IP answers and wildcard resolution without binding", async () => {
    const listeners = await freePair(); listeners.webListen.host = "local.example.test";
    const attempted = vi.spyOn(Server.prototype, "listen").mockClear().mockImplementation(() => { throw Object.assign(Error("test forbids wildcard bind"), { code: "EMFILE" }); });
    expect(await checkHubInitNetwork(listeners, { resolve: async () => { throw Error("SENSITIVE SENTINEL"); } })).toEqual([{ listener: "web", reason: "unresolved" }]);
    for (const answer of ["not-an-IP", "::", "0:0:0:0:0:0:0:0", "0.0.0.0"]) {
      expect(await checkHubInitNetwork(listeners, { resolve: async () => answer })).toEqual([{ listener: "web", reason: "invalid" }]);
    }
    expect(attempted).not.toHaveBeenCalled();
  });
  it("bounds DNS and ignores a late answer instead of opening a late listener", async () => {
    const listeners = await freePair(); listeners.webListen.host = "late.example.test";
    vi.useFakeTimers(); let finish!: (ip: string) => void;
    let completed = false;
    const result = checkHubInitNetwork(listeners, { resolve: () => new Promise<string>(resolve => { finish = resolve; }) }).then(result => { completed = true; return result; });
    await vi.advanceTimersByTimeAsync(2000);
    expect(completed, "DNS deadline must settle the preflight").toBe(true);
    expect(await result).toEqual([{ listener: "web", reason: "unresolved" }]); expect(vi.getTimerCount()).toBe(0);
    finish("127.0.0.1"); await Promise.resolve(); vi.useRealTimers();
    expect(portOf(await bind(listeners.webListen.port))).toBe(listeners.webListen.port);
  });
  it.each([["EACCES", "permission"], ["EPERM", "permission"], ["EMFILE", "unavailable"]] as const)("maps %s to bounded guidance", async (code, reason) => {
    const listeners = await freePair();
    vi.spyOn(Server.prototype, "listen").mockImplementationOnce(() => { throw Object.assign(Error("SENSITIVE SENTINEL"), { code }); });
    expect(await checkHubInitNetwork(listeners)).toEqual([{ listener: "web", reason }]);
  });
  it("withholds success if close cannot confirm cleanup", async () => {
    const listeners = await freePair(), original = Server.prototype.close;
    vi.spyOn(Server.prototype, "close").mockImplementationOnce(function (this: Server, callback?: (err?: Error) => void) {
      return original.call(this, () => callback?.(Error("SENSITIVE SENTINEL")));
    });
    expect(await checkHubInitNetwork(listeners)).toEqual([{ listener: "member", reason: "unavailable" }]);
    expect(await checkHubInitNetwork(listeners)).toEqual([]);
  });
  it("reserves the daemon's default dashboard/preview endpoints before it starts", async () => {
    const h = home();
    for (const port of [19280, 19281]) expect(await checkHubInitNetworkForHome(h, pair(port, port + 2))).toEqual([{ listener: "web", reason: "reserved" }]);
  });
  it("refreshes configured reservations, honors preview off and compares IPv4-mapped loopback", async () => {
    const h = home(), listeners = await freePair(), web = listeners.webListen.port, member = listeners.memberListen.port;
    writeFileSync(join(h, "fleet.yaml"), `health_port: ${web}\nweb:\n  preview_port: ${member}\n`);
    expect(await checkHubInitNetworkForHome(h, listeners)).toEqual([{ listener: "web", reason: "reserved" }]);
    const mapped = { ...listeners, webListen: { host: "::ffff:127.0.0.1", port: web } };
    expect(await checkHubInitNetworkForHome(h, mapped)).toEqual([{ listener: "web", reason: "reserved" }]);
    writeFileSync(join(h, "fleet.yaml"), `health_port: 0\nweb:\n  preview_port: ${member}\n`);
    expect(await checkHubInitNetworkForHome(h, listeners)).toEqual([{ listener: "member", reason: "reserved" }]);
    writeFileSync(join(h, "fleet.yaml"), `health_port: 0\nweb:\n  preview: false\n  preview_port: ${member}\n`);
    expect(await checkHubInitNetworkForHome(h, listeners)).toEqual([]);
  });
});

describe("real default preflight in the init flow", () => {
  it("initializes with two free local endpoints, retains the exact listeners and needs no agent login or service install", async () => {
    const h = home(), certs = makeTestCerts(), listeners = await freePair(); roots.push(certs.dir);
    const identity = new FakeIdentity(), directory = fakeDirectory({ "alice:Dummy-owner-password": { ok: true, person: ADMIN } });
    const io = scriptedIO(["Example Hub", "https://hub.example.test:8443", "", `127.0.0.1:${listeners.webListen.port}`, `127.0.0.1:${listeners.memberListen.port}`,
      certs.cert, certs.key, "corp", "ldaps://directory.example.test", certs.caCert, "y", "2", "DC=example,DC=test", "CN=Reader,DC=example,DC=test",
      { hidden: "Dummy-bind-password" }, "alice", { hidden: "Dummy-owner-password" }, "y", "7", "30", "initialize", "no"]);
    const service = vi.fn(async () => "not requested");
    expect(await runHubInitWizard({ home: h, io: io.io, initializer: createHubInitializer({ home: h, identity, probe: { pidAlive: () => false } }),
      createDirectory: directory.create, readFile: p => readFileSync(p, "utf8"), service: { installed: () => false, install: service } })).toBe("initialized");
    expect(io.remaining()).toBe(0); expect(service).not.toHaveBeenCalled(); expect(identity.provisions).toBe(1);
    const plan = JSON.parse(readFileSync(join(h, "hub/init/operation.json"), "utf8")).plan;
    expect(plan.webListen).toEqual(listeners.webListen); expect(plan.memberListen).toEqual(listeners.memberListen);
    expect(io.text().match(/Both Hub listeners can bind locally/g)).toHaveLength(2);
    expect(portOf(await bind(listeners.webListen.port))).toBe(listeners.webListen.port);
    expect(portOf(await bind(listeners.memberListen.port))).toBe(listeners.memberListen.port);
  });
  it.each(["en", "zh-TW"] as const)("stops before certificates or credentials on a bind failure in %s", async locale => {
    setLocale(locale); const h = home(), listeners = await freePair(), owner = await bind(listeners.memberListen.port);
    const io = scriptedIO(["Example Hub", "https://hub.example.test:8443", "", `127.0.0.1:${listeners.webListen.port}`, `127.0.0.1:${listeners.memberListen.port}`, "q"]);
    const ask = io.io.ask;
    io.io.ask = async q => { expect(q === ht("tls_cert_q"), "bind failure must stop before certificate prompts").toBe(false); return ask(q); };
    const identity = new FakeIdentity(), directory = fakeDirectory({}), read = vi.fn();
    const result = await runHubInitWizard({ home: h, io: io.io, initializer: createHubInitializer({ home: h, identity, probe: { pidAlive: () => false } }),
      createDirectory: directory.create, readFile: read, service: { installed: () => false, install: async () => { throw Error("not requested"); } } });
    expect(result).toBe("cancelled"); expect(io.remaining()).toBe(0); expect(read).not.toHaveBeenCalled();
    expect(identity.provisions).toBe(0); expect(directory.calls).toEqual([]); expect(existsSync(join(h, "hub"))).toBe(false);
    expect(io.text()).toContain(locale === "en" ? "Choose a different port" : "請改用其他埠"); expect(owner.listening).toBe(true);
  });
  it("rechecks after the owner confirms and refuses a newly occupied port without persisting a Hub", async () => {
    const h = home(), certs = makeTestCerts(), listeners = await freePair(); roots.push(certs.dir);
    const identity = new FakeIdentity(), directory = fakeDirectory({ "alice:Dummy-owner-password": { ok: true, person: ADMIN } });
    const io = scriptedIO(["Example Hub", "https://hub.example.test:8443", "", `127.0.0.1:${listeners.webListen.port}`, `127.0.0.1:${listeners.memberListen.port}`,
      certs.cert, certs.key, "corp", "ldaps://directory.example.test", certs.caCert, "y", "2", "DC=example,DC=test", "CN=Reader,DC=example,DC=test",
      { hidden: "Dummy-bind-password" }, "alice", { hidden: "Dummy-owner-password" }, "y", "7", "30", "initialize", "no"]);
    const ask = io.io.ask; let owner: Server | undefined;
    io.io.ask = async q => { const answer = await ask(q); if (q === ht("confirm_q")) owner = await bind(listeners.memberListen.port); return answer; };
    const result = await runHubInitWizard({ home: h, io: io.io, initializer: createHubInitializer({ home: h, identity, probe: { pidAlive: () => false } }),
      createDirectory: directory.create, readFile: p => readFileSync(p, "utf8"), service: { installed: () => false, install: async () => { throw Error("not requested"); } } });
    expect(result).toBe("refused"); expect(io.remaining()).toBe(1); expect(owner?.listening).toBe(true);
    expect(io.text()).toContain("Both Hub listeners can bind locally"); expect(io.text()).toContain("Choose a different port");
    expect(io.text()).not.toContain("Dummy-bind-password"); expect(io.text()).not.toContain("Dummy-owner-password");
    expect(identity.provisions).toBe(0); expect(existsSync(join(h, "fleet.yaml"))).toBe(false); expect(existsSync(join(h, "hub"))).toBe(false);
    expect(portOf(await bind(listeners.webListen.port))).toBe(listeners.webListen.port);
  });
  it("lets the owner correct the listeners before any certificate or directory step", async () => {
    const h = home(), bad = await freePair(), good = await freePair(); await bind(bad.memberListen.port);
    const identity = new FakeIdentity(), directory = fakeDirectory({});
    const io = scriptedIO(["Example Hub", "https://hub.example.test:8443", "", `127.0.0.1:${bad.webListen.port}`, `127.0.0.1:${bad.memberListen.port}`, "r",
      `127.0.0.1:${good.webListen.port}`, `127.0.0.1:${good.memberListen.port}`, ""]);
    expect(await runHubInitWizard({ home: h, io: io.io, initializer: createHubInitializer({ home: h, identity, probe: { pidAlive: () => false } }),
      createDirectory: directory.create, readFile: () => { throw Error("no file requested"); }, service: { installed: () => false, install: async () => "unused" } })).toBe("cancelled");
    expect(io.remaining()).toBe(0); expect(io.text()).toContain("Choose a different port"); expect(io.text()).toContain("Both Hub listeners can bind locally");
    expect(identity.provisions).toBe(0); expect(directory.calls).toEqual([]); expect(existsSync(join(h, "hub"))).toBe(false);
  });
  it("checks saved resume listeners before requesting any service secret, leaving the receipt untouched", async () => {
    const h = home(), listeners = await freePair(), identity = new FakeIdentity(), certs = makeTestCerts(); roots.push(certs.dir);
    const plan: HubInitPlan = { name: "Example Hub", ...listeners, webOrigin: "https://hub.example.test:8443", memberOrigin: "https://hub.example.test:9443",
      webTls: { certFile: certs.cert, keyFile: certs.key }, directory: { realm: "corp", url: "ldaps://directory.example.test", caPem: readFileSync(certs.caCert, "utf8"),
        profile: "openldap", baseDn: "DC=example,DC=test", bindDn: "CN=Reader,DC=example,DC=test" }, bindPasswordRef: "file:hub/secrets/directory-bind",
      administrator: ADMIN.key, retention: { contentDays: 7, eventDays: 30 }, coexistence: "dedicated" };
    const cut = createHubInitializer({ home: h, identity, probe: { pidAlive: () => false }, afterStage: stage => { if (stage === "secret") throw Error("fixture cut"); } });
    const confirmation = await cut.prepareConfirmation(plan, { bindPassword: "Dummy-resume-password" });
    await expect(cut.commit(plan, confirmation.reference)).rejects.toThrow("fixture cut");
    const receipt = join(h, "hub/init/operation.json"), before = readFileSync(receipt);
    await bind(listeners.memberListen.port);
    const initializer = createHubInitializer({ home: h, identity, probe: { pidAlive: () => false } });
    const commit = vi.fn(initializer.commit), directory = fakeDirectory({}), io = scriptedIO(["y"]);
    io.io.askHidden = async () => { expect.fail("resume bind failure must precede every secret prompt"); };
    expect(await runHubInitWizard({ home: h, io: io.io, initializer: { ...initializer, commit }, createDirectory: directory.create,
      readFile: () => { throw Error("not requested"); }, service: { installed: () => false, install: async () => "unused" } })).toBe("refused");
    expect(io.remaining()).toBe(0); expect(commit).not.toHaveBeenCalled(); expect(identity.provisions).toBe(1); expect(directory.calls).toEqual([]);
    expect(readFileSync(receipt)).toEqual(before); expect(existsSync(join(h, "fleet.yaml"))).toBe(false);
    expect(io.text()).toContain("interrupted setup must resume with its saved addresses");
  });
});
