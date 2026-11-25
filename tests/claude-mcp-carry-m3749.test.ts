import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { carryClaudeMcpServers, checkClaudeMcpAtLaunch, claudeMcpNames } from "../src/backend/claude-mcp-carry.js";
import { FleetManager } from "../src/fleet-manager.js";
import { Daemon } from "../src/daemon.js";
import { DeliveryOutbox, SYSTEM_NOTICE_KIND } from "../src/delivery-outbox.js";
import { deriveNeedsYou } from "../src/needs-you.js";
import { getLocale, setLocale } from "../src/locale.js";

// A fake value shaped like a key, to prove an MCP entry's env is copied but never printed.
const SECRET = "fake-mcp-token-0000-not-real";
const originalLocale = getLocale();
let root: string;
let cwd: string;
const cleanup: Array<() => void> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mcp-carry-"));
  cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
});
afterEach(() => {
  setLocale(originalLocale);
  vi.unstubAllEnvs();
  for (const fn of cleanup.splice(0)) fn();
  rmSync(root, { recursive: true, force: true });
});

const profile = (name: string) => { const dir = join(root, "data", "credential-profiles", "claude-code", name); mkdirSync(dir, { recursive: true }); return dir; };
const write = (dir: string, value: unknown) => writeFileSync(join(dir, ".claude.json"), JSON.stringify(value, null, 2), { mode: 0o600 });
const read = (dir: string) => JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"));
const outline = { type: "stdio", command: "outline-mcp", args: ["--serve"], env: { OUTLINE_TOKEN: SECRET } };
const m365 = { type: "http", url: "https://mcp.example.invalid/m365", headers: { Authorization: `Bearer ${SECRET}` } };

describe("M-3749: a switch carries the agent's own MCP servers into the new profile", () => {
  it("local scope for this folder and user scope are merged; the target's other config is untouched; 0600", () => {
    const from = profile("old"), to = profile("new");
    write(from, { mcpServers: { outline }, projects: { [cwd]: { mcpServers: { m365 } }, [join(root, "elsewhere")]: { mcpServers: { other: outline } } } });
    write(to, { oauthAccount: { accountUuid: "fake-account" }, projects: { [cwd]: { hasTrustDialogAccepted: true } } });
    const result = carryClaudeMcpServers({ fromProfileDir: from, toProfileDir: to, workingDirectory: cwd });
    expect(result).toEqual({ carried: true, user: ["outline"], local: ["m365"], keptTarget: [] });
    const after = read(to);
    expect(after.mcpServers).toEqual({ outline });
    expect(after.projects[cwd]).toEqual({ hasTrustDialogAccepted: true, mcpServers: { m365 } });
    expect(after.projects[join(root, "elsewhere")]).toBeUndefined();      // another folder's local servers stay behind
    expect(after.oauthAccount).toEqual({ accountUuid: "fake-account" });
    expect(statSync(join(to, ".claude.json")).mode & 0o777).toBe(0o600);
    expect(read(from).mcpServers).toEqual({ outline });                     // copied, never moved
  });

  it("a fresh profile with no .claude.json yet gets the servers", () => {
    const from = profile("old"), to = profile("fresh");
    write(from, { mcpServers: { outline } });
    expect(carryClaudeMcpServers({ fromProfileDir: from, toProfileDir: to, workingDirectory: cwd })).toEqual({ carried: true, user: ["outline"], local: [], keptTarget: [] });
    expect(read(to).mcpServers).toEqual({ outline });
  });

  it("a name the target already has stays the target's, in either scope", () => {
    const from = profile("old"), to = profile("new");
    const theirs = { type: "stdio", command: "their-outline" };
    write(from, { mcpServers: { outline, extra: outline }, projects: { [cwd]: { mcpServers: { m365 } } } });
    write(to, { mcpServers: { outline: theirs }, projects: { [cwd]: { mcpServers: { m365: theirs } } } });
    expect(carryClaudeMcpServers({ fromProfileDir: from, toProfileDir: to, workingDirectory: cwd }))
      .toEqual({ carried: true, user: ["extra"], local: [], keptTarget: ["m365", "outline"] });
    const after = read(to);
    expect(after.mcpServers).toEqual({ outline: theirs, extra: outline });
    expect(after.projects[cwd].mcpServers).toEqual({ m365: theirs });
  });

  it("the default login is a source too (CLAUDE_CONFIG_DIR's .claude.json), and a realpath spelling of the folder matches", () => {
    const def = join(root, "default-config"); mkdirSync(def);
    vi.stubEnv("CLAUDE_CONFIG_DIR", def);
    const to = profile("new");
    write(def, { projects: { [`${cwd}/`.slice(0, -1)]: { mcpServers: { m365 } } } });
    expect(carryClaudeMcpServers({ fromProfileDir: null, toProfileDir: to, workingDirectory: join(cwd, ".") }))
      .toEqual({ carried: true, user: [], local: ["m365"], keptTarget: [] });
  });

  it("an unreadable target, or one whose lock is held, is left exactly as it was", () => {
    const from = profile("old"), to = profile("new");
    write(from, { mcpServers: { outline } });
    writeFileSync(join(to, ".claude.json"), "{ not json");
    expect(carryClaudeMcpServers({ fromProfileDir: from, toProfileDir: to, workingDirectory: cwd }).carried).toBe(false);
    expect(readFileSync(join(to, ".claude.json"), "utf8")).toBe("{ not json");
    write(to, { mcpServers: {} });
    writeFileSync(join(to, ".claude.json.agend.lock"), JSON.stringify({ pid: process.pid, token: "held" }));
    const locked = carryClaudeMcpServers({ fromProfileDir: from, toProfileDir: to, workingDirectory: cwd });
    expect(locked).toEqual({ carried: false, reason: "the new profile's config is locked or unreadable" });
    expect(read(to).mcpServers).toEqual({});
  }, 20_000);

  it("the switch itself carries them, and its log names servers but never prints an entry", async () => {
    const dataDir = join(root, "data");
    const from = profile("old"), to = profile("new");
    write(from, { mcpServers: { outline }, projects: { [cwd]: { mcpServers: { m365 } } } });
    const instanceDir = join(root, "instance"); mkdirSync(instanceDir);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const fm: any = Object.assign(Object.create(FleetManager.prototype), { dataDir, logger, getInstanceDir: () => instanceDir });
    await fm.switchConversation("agent", { backend: "claude-code", from: "old", to: "new", workingDirectory: cwd });
    expect(read(to).mcpServers).toEqual({ outline });
    expect(read(to).projects[cwd].mcpServers).toEqual({ m365 });
    const logged = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls]);
    expect(logged).toContain("MCP servers carried to the new credential profile");
    expect(logged).toContain("outline");
    expect(logged).toContain("m365");
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain("outline-mcp");
  });
});

describe("M-3749: a launch reports MCP servers that did not come along", () => {
  it("names missing only after a launch under another config dir; a removal under the same profile is the agent's own", () => {
    const a = profile("old"), b = profile("new");
    const instanceDir = join(root, "instance"); mkdirSync(instanceDir);
    write(a, { mcpServers: { outline }, projects: { [cwd]: { mcpServers: { m365 } } } });
    const at = (dir: string) => checkClaudeMcpAtLaunch({ instanceDir, configDir: dir, jsonPath: join(dir, ".claude.json"), workingDirectory: cwd, now: 1000 });
    expect(at(a)).toBeNull();                                             // first launch: recorded
    write(a, { mcpServers: {}, projects: { [cwd]: { mcpServers: { m365 } } } });
    expect(at(a)).toBeNull();                                             // same profile, removed on purpose
    write(a, { mcpServers: { outline }, projects: { [cwd]: { mcpServers: { m365 } } } });
    expect(at(a)).toBeNull();
    expect(at(b)).toEqual({ names: ["m365", "outline"], fromConfigDir: a, toConfigDir: b, since: 1000 });
    expect(at(b)).toBeNull();                                             // told once; the next launch is clean
    expect(JSON.stringify(JSON.parse(readFileSync(join(instanceDir, "claude-mcp-seen.json"), "utf8")))).not.toContain(SECRET);
  });

  it("a carried switch reports nothing", () => {
    const a = profile("old"), b = profile("new");
    const instanceDir = join(root, "instance"); mkdirSync(instanceDir);
    write(a, { mcpServers: { outline } });
    checkClaudeMcpAtLaunch({ instanceDir, configDir: a, jsonPath: join(a, ".claude.json"), workingDirectory: cwd });
    carryClaudeMcpServers({ fromProfileDir: a, toProfileDir: b, workingDirectory: cwd });
    expect(checkClaudeMcpAtLaunch({ instanceDir, configDir: b, jsonPath: join(b, ".claude.json"), workingDirectory: cwd })).toBeNull();
    expect(claudeMcpNames(join(b, ".claude.json"), cwd)).toEqual({ user: ["outline"], local: [] });
  });

  it("an unreadable config records nothing and reports nothing", () => {
    const a = profile("old");
    const instanceDir = join(root, "instance"); mkdirSync(instanceDir);
    writeFileSync(join(a, ".claude.json"), "{");
    expect(checkClaudeMcpAtLaunch({ instanceDir, configDir: a, jsonPath: join(a, ".claude.json"), workingDirectory: cwd })).toBeNull();
    expect(existsSync(join(instanceDir, "claude-mcp-seen.json"))).toBe(false);
  });

  it("the daemon's launch check emits it; the fleet tells the agent once and Needs you lists it, in EN and zh-TW", () => {
    for (const locale of ["en", "zh-TW"] as const) {
      setLocale(locale);
      const dataDir = join(root, `data-${locale}`);
      const dir = (name: string) => { const d = join(dataDir, "credential-profiles", "claude-code", name); mkdirSync(d, { recursive: true }); return d; };
      const a = dir("old"), b = dir("new");
      write(a, { mcpServers: { outline }, projects: { [cwd]: { mcpServers: { m365 } } } });
      const instanceDir = join(root, `instance-${locale}`); mkdirSync(instanceDir);
      const daemon: any = Object.assign(Object.create(Daemon.prototype), new EventEmitter(), {
        name: "agent", instanceDir, config: { backend: "claude-code", working_directory: cwd }, logger: { warn: vi.fn(), debug: vi.fn() },
      });
      const events: any[] = [];
      daemon.on("mcp_missing", (e: any) => events.push(e));
      vi.stubEnv("AGEND_HOME", dataDir);
      daemon.checkClaudeMcpServers({ backendOptions: { credential_profile: "old" } });
      expect(events).toEqual([]);
      daemon.checkClaudeMcpServers({ backendOptions: { credential_profile: "new" } });
      expect(events).toHaveLength(1);
      expect(events[0].missing.names).toEqual(["m365", "outline"]);
      expect(daemon.mcpMissing().names).toEqual(["m365", "outline"]);

      const outbox = new DeliveryOutbox(join(root, `outbox-${locale}.db`));
      cleanup.push(() => outbox.close());
      const fm: any = Object.assign(Object.create(FleetManager.prototype), { dataDir, deliveryOutbox: outbox, logger: { warn: vi.fn() }, ensureDeliveryOutbox: () => {} });
      fm.onMcpMissing("agent", events[0].missing);
      fm.onMcpMissing("agent", events[0].missing);                     // a repeat of the same set is not told twice
      const notices = outbox.listPending().filter(row => row.kind === SYSTEM_NOTICE_KIND);
      expect(notices).toHaveLength(1);
      expect(notices[0].targetInstance).toBe("agent");
      const text = notices[0].payload.content as string;
      expect(text).toContain("m365, outline");
      expect(text).toContain("old → new");
      expect(text).toContain("claude mcp add -s local");
      expect(text).toContain(locale === "en" ? "MCP servers missing" : "缺少這些 MCP 伺服器");
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(dataDir);

      const items = deriveNeedsYou({ prompts: [], deliveries: [], ownerOf: () => undefined,
        instances: [{ name: "agent", mcpMissing: { names: ["m365", "outline"], from: "old", to: "new", since: 5 } }] });
      expect(items).toEqual([expect.objectContaining({ type: "instance", instance: "agent", reason: "mcp_missing", detail: "m365, outline (old → new)", since: 5 })]);

      daemon.checkClaudeMcpServers({ backendOptions: { credential_profile: "new" } });   // the next launch: nothing missing, the item goes
      expect(events).toHaveLength(2);
      expect(events[1].missing).toBeNull();
      expect(daemon.mcpMissing()).toBeNull();
      vi.unstubAllEnvs();
    }
  });
});
