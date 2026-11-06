/** Real init composition/files/loopback probes; terminal, directory, identity, PID and managers are inert. */
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo, type Server } from "node:net";
import { ADMIN, FakeIdentity, fakeDirectory, makeTestCerts, scriptedIO } from "./support/hub-init-fixtures.js";
import { setLocale } from "../src/locale.js";

const state = vi.hoisted(() => ({ io: undefined as import("../src/hub/init/prompt.js").WizardIO | undefined,
  create: undefined as typeof import("../src/hub/directory/index.js").createHubDirectory | undefined,
  install: vi.fn(() => "/inert/service"), activate: vi.fn() }));
vi.mock("../src/hub/init/prompt.js", async original => ({ ...await original<typeof import("../src/hub/init/prompt.js")>(), terminalIO: () => state.io }));
vi.mock("../src/hub/directory/index.js", async original => ({ ...await original<typeof import("../src/hub/directory/index.js")>(),
  createHubDirectory: (...args: Parameters<NonNullable<typeof state.create>>) => state.create!(...args) }));
vi.mock("../src/service-installer.js", () => ({ inspectService: () => ({ installed: false }), installService: state.install, activateService: state.activate }));
vi.mock("../src/hub/init/existing-fleet.js", async original => ({ ...await original<typeof import("../src/hub/init/existing-fleet.js")>(), realFleetProbe: () => ({ pidAlive: () => false }) }));
vi.mock("../src/service-drain.js", async original => ({ ...await original<typeof import("../src/service-drain.js")>(),
  captureServiceProcess: (pid: number | null) => () => pid === null }));
import { runHubInitCommand } from "../src/hub/init/cli.js";

let home: string | undefined, certs: ReturnType<typeof makeTestCerts> | undefined;
const sockets: Server[] = [], tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
afterEach(async () => {
  if (tty) Object.defineProperty(process.stdin, "isTTY", tty); else delete (process.stdin as { isTTY?: boolean }).isTTY;
  vi.restoreAllMocks(); vi.unstubAllEnvs(); state.install.mockClear(); state.activate.mockClear(); state.io = undefined; state.create = undefined; setLocale("en");
  for (const s of sockets.splice(0)) if (s.listening) await new Promise<void>(resolve => s.close(() => resolve()));
  if (home) rmSync(home, { recursive: true, force: true }); if (certs) rmSync(certs.dir, { recursive: true, force: true });
});
it.each([false, true])("Hub init service install uses its explicit home/background session and refuses an active PID (active=%s)", async active => {
  setLocale("en"); home = mkdtempSync(join(tmpdir(), "agend-hub-service-cli-")); certs = makeTestCerts();
  vi.stubEnv("AGEND_HOME", home); vi.stubEnv("HOME", home); Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  const reservations = await Promise.all([0, 1].map(async () => {
    const s = createServer(socket => socket.destroy()); sockets.push(s);
    await new Promise<void>((resolve, reject) => { s.once("error", reject); s.listen(0, "127.0.0.1", resolve); });
    return { server: s, port: (s.address() as AddressInfo).port };
  }));
  await Promise.all(reservations.map(s => new Promise<void>(resolve => s.server.close(() => resolve()))));
  const [web, member] = reservations.map(s => s.port);
  if (active) writeFileSync(join(home, "fleet.pid"), "42");
  const io = scriptedIO(["Example Hub", `https://hub.example.test:${web}`, `https://hub.example.test:${member}`, `127.0.0.1:${web}`, `127.0.0.1:${member}`,
    certs.cert, certs.key, "corp", "ldaps://directory.example.test", certs.caCert, "y", "2", "DC=example,DC=test", "CN=Reader,DC=example,DC=test",
    "1", { hidden: "Dummy-service-only" }, "alice", "y", "7", "30", "initialize", "install"]);
  const directory = fakeDirectory({ "alice": { ok: true, person: ADMIN } }); state.io = io.io; state.create = directory.create;
  expect(await runHubInitCommand(new FakeIdentity())).toBe("initialized"); expect(io.remaining()).toBe(0);
  if (active) {
    expect(state.install).not.toHaveBeenCalled(); expect(state.activate).not.toHaveBeenCalled();
    expect(readFileSync(join(home, "fleet.pid"), "utf8")).toBe("42"); expect(io.text()).toContain("Use agend stop");
  } else {
    expect(state.install).toHaveBeenCalledWith(expect.objectContaining({ label: "com.agend.fleet", workingDirectory: home,
      logPath: join(home, "fleet.log"), agendHome: home, launchdSessionType: "Background" }));
    expect(state.activate).toHaveBeenCalledExactlyOnceWith("/inert/service", join(home, "fleet.pid"), { preservePidFile: true });
  }
  expect(io.text()).not.toContain("Dummy-service-only"); expect(io.text()).not.toContain("Dummy-person-only");
});
