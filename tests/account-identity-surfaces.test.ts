/**
 * Where an account (e-mail and plan) may appear: administrator pages only (the Runtime page, the agent's Claude-account picker, Settings → Agents).
 * Everything else that tells about an agent, a computer or a notice stays free of it: guest payloads, the public link and gateway, agent-facing tools
 * (`describe_instance`, `list_instances`, fleet status) and Needs-you. Two kinds of check: which source files can even mention it, and what the
 * fleet's own outward serializers say when a computer does carry one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";

const walk = (dir: string, out: string[] = []): string[] => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) { if (!["node_modules", "vendor"].includes(entry.name)) walk(path, out); } else if (/\.(ts|js)$/.test(entry.name)) out.push(path); } return out; };
const src = resolve("src"), files = walk(src).map(path => ({ name: path.slice(src.length + 1), text: readFileSync(path, "utf8") }));
const mentioning = (pattern: RegExp): string[] => files.filter(file => pattern.test(file.text)).map(file => file.name).sort();

describe("which source files can mention an account at all", () => {
  it("the e-mail is validated and read in the shared parser, the Runtime's CLI output and the UI helper, and nowhere else", () => {
    expect(mentioning(/maskedEmail/)).toEqual(["claude-auth-status.ts", "runtime-cli.ts", "runtime-credential-profiles.ts", "ui/account-identity.js"]);
  });
  it("a computer's reported profiles (with their accounts) are read by the Runtime, the coordinator that stores them, the route that redacts them for everyone but a local administrator, the admin Runtime page and the account picker only", () => {
    // The managed controller supplies the existing private profile root to RuntimeClient; it serializes no accounts.
    // machine-accounts.ts (#3190 Part 3c) reads what the computers reported and hands it to the Accounts view, which only the local admin session reaches.
    expect(mentioning(/credentialProfiles/)).toEqual(["fleet-manager.ts", "machine-accounts.ts", "runtime-cli.ts", "runtime-client.ts", "runtime-coordinator.ts", "runtime-credential-profiles.ts", "runtime-update-controller.ts", "ui/credential-profile-select.js", "ui/panel-runtimes.js", "windows-cli-api.ts", "windows-cli.ts"]);
  });
  it("the host's sign-in accounts are read by the auth check, the fleet that caches them and the admin-only route", () => {
    expect(mentioning(/checkAuthIdentity|refreshSignInIdentities|signInIdentit/)).toEqual(["fleet-manager.ts", "login-flows.ts", "web-api.ts"]);
  });
  it("the Hub (the company hub's code) and every public or guest surface never mention an account", () => {
    const hub = files.filter(file => file.name.startsWith("hub/"));
    expect(hub.length).toBeGreaterThan(0);
    for (const file of hub) expect(file.text, file.name).not.toMatch(/maskedEmail|AccountIdentity|claude-auth-status|signInIdentit/);
  });
  it("no line that reads an address also logs it, throws it, audits it or sends it to a notice or a chat reply", () => {
    const sinks = /\b(logger|log|console|audit|notice|notify|reply|sendText|sendMessage)\b|new (Runtime)?(Protocol)?Error\(|throw /i;
    const offenders: string[] = [];
    for (const file of files) file.text.split("\n").forEach((line, index) => { if (/maskedEmail|redactedEmail|identityLabel/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line) && sinks.test(line)) offenders.push(`${file.name}:${index + 1}`); });
    expect(offenders).toEqual([]);
  });
  it.each(["outbound-handlers.ts", "needs-you.ts", "web-guest-access.ts", "public-web-gateway.ts", "web-status.ts", "instance-lifecycle.ts", "daemon.ts"])("%s (an agent tool, a notice, a guest or public surface) does not touch any of it", name => {
    const file = files.find(candidate => candidate.name === name);
    if (!file) return;     // a file that does not exist cannot leak
    expect(file.text).not.toMatch(/maskedEmail|credentialProfiles|AccountIdentity|signInIdentit|checkAuthIdentity|claude-auth-status/);
  });
});

describe("what the fleet's outward serializers say when a computer carries an account", () => {
  const dirs: string[] = [];
  afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  it("General's computer list and the fleet status have none of it", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-identity-surfaces-")); dirs.push(dir);
    const fm = new FleetManager(dir) as any, machineId = "22345678-1234-4321-abcd-123456789012";
    fm.fleetConfig = { defaults: {}, instances: { "windows-agent": { runtime: "windows", machine_id: machineId, backend: "claude-code", working_directory: "C:\\w", general_topic: true, backend_options: { "claude-code": { credential_profile: "work" } } } } };
    const identity = { maskedEmail: "alice.fixture@example.com", plan: "team" };
    fm.runtimeHub = { listMachines: () => [{ id: machineId, name: "Desk", status: "online", platform: "win32",
      inventory: { home: "C:\\U", probedAt: 1, clis: [{ id: "claude-code", runnable: true, version: "2.1.316", authenticated: true, identity }], credentialProfiles: { default: "work", profiles: [{ name: "work", loggedIn: true, identity }] } } }],
      paneTransportEpoch: () => "epoch", machine: () => ({ status: "online" }) };
    fm.fleetConfig.instances["windows-agent"].native_agent_id = "12345678-1234-4321-abcd-123456789012";
    const outputs: string[] = [JSON.stringify(fm.generalLocations())];
    outputs.push(JSON.stringify(fm.getUiStatus()));
    for (const out of outputs) { expect(out.length).toBeGreaterThan(2); expect(out).not.toMatch(/alice\.fixture|bob\.fixture|maskedEmail|"identity"|credentialProfiles/); }
  });
});
