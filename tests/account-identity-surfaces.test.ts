/**
 * Where a masked account (e-mail and plan) may appear: administrator pages only (the Runtime page, the agent's Claude-account picker, Settings → Agents).
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
  it("the masked e-mail is built and read in the shared parser, the Runtime's CLI output and the UI helper, and nowhere else", () => {
    expect(mentioning(/maskedEmail/)).toEqual(["claude-auth-status.ts", "runtime-cli.ts", "runtime-credential-profiles.ts", "ui/account-identity.js"]);
  });
  it("a computer's reported profiles (with their accounts) are read by the Runtime, the coordinator that stores them, the admin Runtime page and the account picker only", () => {
    expect(mentioning(/credentialProfiles/)).toEqual(["fleet-manager.ts", "runtime-cli.ts", "runtime-client.ts", "runtime-coordinator.ts", "runtime-credential-profiles.ts", "ui/credential-profile-select.js", "ui/panel-runtimes.js", "windows-cli.ts"]);
  });
  it("the host's sign-in accounts are read by the auth check, the fleet that caches them and the admin-only route", () => {
    expect(mentioning(/checkAuthIdentity|refreshSignInIdentities|signInIdentit/)).toEqual(["fleet-manager.ts", "login-flows.ts", "web-api.ts"]);
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
    const identity = { maskedEmail: "al***@example.com", plan: "team" };
    fm.runtimeHub = { listMachines: () => [{ id: machineId, name: "Desk", status: "online", platform: "win32",
      inventory: { home: "C:\\U", probedAt: 1, clis: [{ id: "claude-code", runnable: true, version: "2.1.316", authenticated: true, identity }], credentialProfiles: { default: "work", profiles: [{ name: "work", loggedIn: true, identity }] } } }],
      paneTransportEpoch: () => "epoch", machine: () => ({ status: "online" }) };
    fm.fleetConfig.instances["windows-agent"].native_agent_id = "12345678-1234-4321-abcd-123456789012";
    const outputs: string[] = [JSON.stringify(fm.generalLocations())];
    outputs.push(JSON.stringify(fm.getUiStatus()));
    for (const out of outputs) { expect(out.length).toBeGreaterThan(2); expect(out).not.toMatch(/al\*\*\*@|maskedEmail|"identity"|credentialProfiles/); }
  });
});
