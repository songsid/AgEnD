/** Actual CLI composition; terminal, directory and service boundaries are inert, all files are private scratch. */
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo, type Server } from "node:net";
import { ADMIN, FakeIdentity, fakeDirectory, makeTestCerts, scriptedIO } from "./support/hub-init-fixtures.js";
const state = vi.hoisted(() => ({ io: undefined as undefined | import("../src/hub/init/prompt.js").WizardIO,
  create: undefined as undefined | typeof import("../src/hub/directory/index.js").createHubDirectory,
  install: vi.fn(() => { throw Error("service installation forbidden"); }), activate: vi.fn(() => { throw Error("service activation forbidden"); }) }));
vi.mock("../src/hub/init/prompt.js", async original => ({ ...await original<typeof import("../src/hub/init/prompt.js")>(), terminalIO: () => state.io }));
vi.mock("../src/hub/directory/index.js", async original => ({ ...await original<typeof import("../src/hub/directory/index.js")>(),
  createHubDirectory: (...args: Parameters<NonNullable<typeof state.create>>) => state.create!(...args) }));
vi.mock("../src/service-installer.js", () => ({ inspectService: () => ({ installed: false }), installService: state.install, activateService: state.activate }));
vi.mock("../src/hub/init/existing-fleet.js", async original => ({ ...await original<typeof import("../src/hub/init/existing-fleet.js")>(), realFleetProbe: () => ({ pidAlive: () => false }) }));
import { runHubInitCommand } from "../src/hub/init/cli.js";
let home: string | undefined, certs: ReturnType<typeof makeTestCerts> | undefined;
const sockets: Server[] = [];
const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
afterEach(async () => {
  if (tty) Object.defineProperty(process.stdin, "isTTY", tty); else delete (process.stdin as { isTTY?: boolean }).isTTY;
  vi.restoreAllMocks(); vi.unstubAllEnvs(); state.io = undefined; state.create = undefined;
  for (const server of sockets.splice(0)) if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  if (home) rmSync(home, { recursive: true, force: true }); if (certs) rmSync(certs.dir, { recursive: true, force: true });
});
it("wires private-file selection through the real CLI into the sealed initializer, without a secret argument, directory or service effect", async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "agend-secret-cli-"))); certs = makeTestCerts();
  vi.stubEnv("AGEND_HOME", home); vi.stubEnv("HOME", home); Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  // Keep the production CLI preflight: only these owned loopback endpoints may be bound by this test.
  const reserved = await Promise.all([0, 1].map(async () => {
    const server = createServer(socket => socket.destroy()); sockets.push(server);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    return { server, port: (server.address() as AddressInfo).port };
  }));
  const [webPort, memberPort] = reserved.map(r => r.port);
  await Promise.all(reserved.map(r => new Promise<void>(resolve => r.server.close(() => resolve()))));
  const webOrigin = `https://hub.example.test:${webPort}`, memberOrigin = `https://hub.example.test:${memberPort}`;
  const secret = "Dummy-cli-file-only-秘密\n", person = "Dummy-person-only", path = join(home, "owner-secret"); writeFileSync(path, secret, { mode: 0o600 });
  const io = scriptedIO(["Example Hub", webOrigin, memberOrigin, `127.0.0.1:${webPort}`, `127.0.0.1:${memberPort}`, certs.cert, certs.key,
    "corp", "ldaps://directory.example.test", certs.caCert, "y", "2", "DC=example,DC=test", "CN=Reader,DC=example,DC=test", "2", path,
    "alice", "y", "7", "30", "initialize", "no"]);
  const hidden = io.io.askHidden;
  io.io.askHidden = async question => { expect(question).not.toContain("Service account password"); return hidden(question); };
  const directory = fakeDirectory({ alice: { ok: true, person: ADMIN } }); state.io = io.io; state.create = directory.create;
  const argv = [...process.argv], output = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await runHubInitCommand(new FakeIdentity())).toBe("initialized"); expect(io.remaining()).toBe(0);
  expect(io.text().match(/Both Hub listeners can bind locally/g)).toHaveLength(2);
  const plan = JSON.parse(readFileSync(join(home, "hub/init/operation.json"), "utf8")).plan;
  expect(plan).toMatchObject({ webOrigin, memberOrigin, webListen: { host: "127.0.0.1", port: webPort }, memberListen: { host: "127.0.0.1", port: memberPort } });
  expect(directory.calls).toEqual([{ bindPassword: secret, login: "alice" }]); expect(process.argv).toEqual(argv);
  expect(readFileSync(join(home, "hub/secrets/directory-bind"))).toEqual(Buffer.from(secret)); expect(readFileSync(path)).toEqual(Buffer.from(secret));
  expect(io.text()).not.toContain(secret); expect(JSON.stringify(output.mock.calls)).not.toContain(secret);
  expect(state.install).not.toHaveBeenCalled(); expect(state.activate).not.toHaveBeenCalled();
});
