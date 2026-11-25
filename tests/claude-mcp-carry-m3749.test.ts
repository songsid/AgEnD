import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { carryClaudeMcpServers, checkClaudeMcpAtLaunch, claudeMcpNames, dismissClaudeMcpMissing } from "../src/backend/claude-mcp-carry.js";
import { NeedsYouHub, type NeedsYouHubContext } from "../src/needs-you-hub.js";
import { FleetManager } from "../src/fleet-manager.js";
import { Daemon } from "../src/daemon.js";
import { DeliveryOutbox, SYSTEM_NOTICE_KIND } from "../src/delivery-outbox.js";
import { deriveNeedsYou } from "../src/needs-you.js";
import { getLocale, setLocale, t as tr } from "../src/locale.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";

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
    // Another launch is no evidence of recovery: still outstanding, since the same time.
    expect(checkClaudeMcpAtLaunch({ instanceDir, configDir: b, jsonPath: join(b, ".claude.json"), workingDirectory: cwd, now: 2000 }))
      .toEqual({ names: ["m365", "outline"], fromConfigDir: a, toConfigDir: b, since: 1000 });
    write(b, { mcpServers: { outline } });
    expect(at(b)).toEqual({ names: ["m365"], fromConfigDir: a, toConfigDir: b, since: 1000 });   // one is back
    write(b, { mcpServers: { outline }, projects: { [cwd]: { mcpServers: { m365 } } } });
    expect(at(b)).toBeNull();                                             // all back: gone
    write(b, { mcpServers: {} });
    expect(at(b)).toBeNull();                                             // removed later under the same profile: its own choice
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

  it("a person's dismissal forgets the outstanding list; a later switch can report again", () => {
    const a = profile("old"), b = profile("new");
    const instanceDir = join(root, "instance"); mkdirSync(instanceDir);
    write(a, { mcpServers: { outline } });
    const at = (dir: string) => checkClaudeMcpAtLaunch({ instanceDir, configDir: dir, jsonPath: join(dir, ".claude.json"), workingDirectory: cwd, now: 7 });
    at(a);
    expect(at(b)?.names).toEqual(["outline"]);
    dismissClaudeMcpMissing(instanceDir);
    expect(at(b)).toBeNull();
    expect(at(a)).toBeNull();
    expect(at(b)?.names).toEqual(["outline"]);
  });

  it("servers added during the session are what the switch records, so a carry that could not be written is still reported", async () => {
    const dataDir = join(root, "data");
    const a = profile("old"), b = profile("new");
    const instanceDir = join(root, "instance"); mkdirSync(instanceDir);
    write(a, {});
    expect(checkClaudeMcpAtLaunch({ instanceDir, configDir: a, jsonPath: join(a, ".claude.json"), workingDirectory: cwd })).toBeNull();
    write(a, { mcpServers: { outline } });                                    // added while it ran
    write(b, {});
    writeFileSync(join(b, ".claude.json.agend.lock"), JSON.stringify({ pid: process.pid, token: "held" }));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const fm: any = Object.assign(Object.create(FleetManager.prototype), { dataDir, logger, getInstanceDir: () => instanceDir });
    await fm.switchConversation("agent", { backend: "claude-code", from: "old", to: "new", workingDirectory: cwd });
    expect(read(b)).toEqual({});
    expect(JSON.stringify(logger.warn.mock.calls)).toContain("MCP servers not carried to the new credential profile");
    expect(checkClaudeMcpAtLaunch({ instanceDir, configDir: b, jsonPath: join(b, ".claude.json"), workingDirectory: cwd })?.names).toEqual(["outline"]);
  }, 20_000);

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
      expect(text).toContain(locale === "en" ? "(old → new): m365, outline." : "（old → new）後缺少這些 MCP 伺服器：m365、outline。");
      expect(text).toContain("old → new");
      expect(text).toContain("claude mcp add -s local");
      expect(text).toContain(locale === "en" ? "MCP servers missing" : "缺少這些 MCP 伺服器");
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(dataDir);

      const items = deriveNeedsYou({ prompts: [], deliveries: [], ownerOf: () => undefined,
        instances: [{ name: "agent", mcpMissing: { names: ["m365", "outline"], from: "old", to: "new", since: 5 } }] });
      expect(items).toEqual([expect.objectContaining({ type: "instance", instance: "agent", reason: "mcp_missing", detail: "m365, outline (old → new)", since: 5,
        mcpMissing: { names: ["m365", "outline"], from: "old", to: "new" } })]);
      // The chat list's line, in the list's language (zh: full-width 「：」「、」「（）」).
      const hub: any = Object.create(NeedsYouHub.prototype); hub.ctx = { t: (k: string, ...a: unknown[]) => tr(k, ...(a as string[])) };
      expect(hub.lineTitle(items[0])).toBe(locale === "en" ? "MCP servers missing after an AI account switch: m365, outline (old → new)"
        : "切換 AI 帳號後缺少 MCP 伺服器：m365、outline（old → new）");

      daemon.checkClaudeMcpServers({ backendOptions: { credential_profile: "new" } });   // the next launch: still outstanding
      expect(events).toHaveLength(2);
      expect(events[1].missing.names).toEqual(["m365", "outline"]);
      fm.onMcpMissing("agent", events[1].missing);                     // and not told again
      expect(outbox.listPending().filter(row => row.kind === SYSTEM_NOTICE_KIND)).toHaveLength(1);
      // A person's Acknowledge (through the fleet, as Needs you calls it) clears it now and at the next launch.
      fm.lifecycle = { daemons: new Map([["agent", daemon]]) };
      expect(fm.acknowledgeMcpMissing("agent")).toBe(true);
      expect(events).toHaveLength(3);
      expect(events[2].missing).toBeNull();
      expect(daemon.mcpMissing()).toBeNull();
      expect(fm.acknowledgeMcpMissing("agent")).toBe(false);
      daemon.checkClaudeMcpServers({ backendOptions: { credential_profile: "new" } });
      expect(daemon.mcpMissing()).toBeNull();
      vi.unstubAllEnvs();
    }
  });

  it("the lifecycle relays the daemon's event to the fleet and recomputes Needs you", () => {
    const onMcpMissing = vi.fn(), onAttentionChanged = vi.fn();
    const ctx = { fleetConfig: { instances: { agent: { backend: "claude-code" } }, defaults: {} }, logger: { info() {}, warn() {}, error() {}, debug() {} },
      eventLog: null, isPlannedRestart: () => false, notifyInstanceTopic: vi.fn(), webhookEmit: vi.fn(), clearCancelButton: vi.fn(),
      checkModelFailover() {}, restartSingleInstance: async () => {}, getInstanceDir: (n: string) => `/nonexistent/${n}`,
      onMcpMissing, onAttentionChanged } as unknown as LifecycleContext;
    const lc = new InstanceLifecycle(ctx);
    const daemon = new EventEmitter();
    lc.attachIncidentHandlers("agent", daemon as any);
    const missing = { names: ["outline"], fromConfigDir: "/a", toConfigDir: "/b", since: 1 };
    daemon.emit("mcp_missing", { name: "agent", missing });
    daemon.emit("mcp_missing", { name: "agent", missing: null });
    expect(onMcpMissing.mock.calls).toEqual([["agent", missing], ["agent", null]]);
    expect(onAttentionChanged).toHaveBeenCalledTimes(2);
    onMcpMissing.mockImplementation(() => { throw Error("fake-failure"); });
    expect(() => daemon.emit("mcp_missing", { name: "agent", missing })).not.toThrow();
    expect(onAttentionChanged).toHaveBeenCalledTimes(3);
  });

  it("Needs you offers Acknowledge for it in chat and on the web, and the web's goes to the fleet", () => {
    const acked: string[] = [];
    const ctx = { dataDir: root, now: () => 0, mono: () => 0, setTimer: () => 1, clearTimer: () => {}, prompts: () => [],
      instances: () => [{ name: "agent", mcpMissing: { names: ["outline"], from: "old", to: "new", since: 9 } }], deliveries: () => [],
      ownerOf: () => undefined, worlds: () => [], noticeTarget: () => null, instanceTopic: () => undefined, instanceName: (i: string) => i,
      isFleetAdmin: () => false, fleetAdmins: () => [], emitSse: () => {}, acknowledge: () => false,
      acknowledgeMcpMissing: (i: string) => { acked.push(i); return true; }, settings: () => ({ liveMessage: false, dm: false }), stopping: () => false,
      t: (k: string, ...a: string[]) => `${k}${a.length ? `(${a.join(",")})` : ""}`, log: () => {} } as unknown as NeedsYouHubContext;
    const hub = new NeedsYouHub(ctx);
    hub.start();
    const [item] = (hub as any).items;
    expect(item).toMatchObject({ id: "mcp-missing:agent:9", reason: "mcp_missing" });
    const acks = (hub as any).mintAcks("dcA", Symbol("r"), 1, { chatId: "c" }, [item]);
    expect(acks.choices).toEqual([{ id: expect.stringMatching(/:ack$/), label: "needs.ack_button(agent)" }]);
    expect([...(hub as any).acks.values()][0]).toMatchObject({ instance: "agent", mcpMissing: true });
    expect(hub.webAcknowledge("mcp-missing:agent:9", "web:x")).toEqual({ status: 200, message: "needs.ack_done" });
    expect(acked).toEqual(["agent"]);
    expect(hub.webAcknowledge("mcp-missing:other:1", "web:x").status).toBe(409);
    hub.stop?.();
  });
});

describe("M-3749 review: target spellings, unreadable targets, the default login", () => {
  it("a read-denied target is left exactly as it was (not treated as empty)", () => {
    if (process.getuid?.() === 0) return;                                  // root reads anything: nothing to deny
    const from = profile("old"), to = profile("new");
    write(from, { mcpServers: { outline } });
    write(to, { oauthAccount: { accountUuid: "fake-account" }, mcpServers: { mine: { command: "x" } } });
    chmodSync(join(to, ".claude.json"), 0o000);
    cleanup.push(() => chmodSync(join(to, ".claude.json"), 0o600));
    expect(carryClaudeMcpServers({ fromProfileDir: from, toProfileDir: to, workingDirectory: cwd }))
      .toEqual({ carried: false, reason: "the new profile's config is locked or unreadable" });
    chmodSync(join(to, ".claude.json"), 0o600);
    expect(read(to)).toEqual({ oauthAccount: { accountUuid: "fake-account" }, mcpServers: { mine: { command: "x" } } });
  });

  it("local servers under another spelling of the folder land in the entry Claude reads; the target's name wins across spellings", () => {
    const link = join(root, "link"); symlinkSync(cwd, link);
    const from = profile("old"), to = profile("new");
    const theirs = { type: "stdio", command: "their-m365" };
    write(from, { projects: { [link]: { mcpServers: { m365, extra: m365 } } } });
    write(to, { projects: { [cwd]: { hasTrustDialogAccepted: true }, [link]: { mcpServers: { m365: theirs } } } });
    expect(carryClaudeMcpServers({ fromProfileDir: from, toProfileDir: to, workingDirectory: link }))
      .toEqual({ carried: true, user: [], local: ["extra"], keptTarget: ["m365"] });
    const after = read(to);
    expect(after.projects[cwd]).toEqual({ hasTrustDialogAccepted: true, mcpServers: { extra: m365 } });
    expect(after.projects[link]).toEqual({ mcpServers: { m365: theirs } });
    // Present means present in the entry Claude reads, not under some alias.
    expect(claudeMcpNames(join(to, ".claude.json"), link)).toEqual({ user: [], local: ["extra"] });
    write(to, { projects: { [link]: { mcpServers: { only: m365 } } } });
    expect(carryClaudeMcpServers({ fromProfileDir: from, toProfileDir: to, workingDirectory: cwd }))
      .toEqual({ carried: true, user: [], local: ["extra", "m365"], keptTarget: [] });
    expect(Object.keys(read(to).projects[cwd].mcpServers).sort()).toEqual(["extra", "m365"]);
  });

  it("a target with the folder only under its symlink spelling keeps the carried and its own servers after the real launch's preTrust", () => {
    vi.stubEnv("AGEND_HOME", join(root, "data"));
    const link = join(root, "link"); symlinkSync(cwd, link);
    const from = profile("old"), to = profile("new");
    const mine = { type: "stdio", command: "their-own" };
    write(from, { projects: { [link]: { mcpServers: { m365 } } } });
    write(to, { oauthAccount: { accountUuid: "fake-account" }, projects: { [link]: { hasTrustDialogAccepted: true, mcpServers: { mine } } } });
    expect(carryClaudeMcpServers({ fromProfileDir: from, toProfileDir: to, workingDirectory: link }))
      .toEqual({ carried: true, user: [], local: ["m365"], keptTarget: [] });
    // The actual launch order: the carry, then preTrust (which adds the real-path entry), then the launch check reads it.
    new ClaudeCodeBackend(join(root, "instance")).preTrust(link, { backendOptions: { credential_profile: "new" } } as any);
    const after = read(to);
    expect(after.projects[cwd]).toEqual({ hasTrustDialogAccepted: true, mcpServers: { mine, m365 } });
    expect(after.projects[link]).toEqual({ hasTrustDialogAccepted: true, mcpServers: { mine } });   // left as it was
    expect(claudeMcpNames(join(to, ".claude.json"), link)).toEqual({ user: [], local: ["m365", "mine"] });
    const instanceDir = join(root, "instance-order"); mkdirSync(instanceDir);
    write(from, { projects: { [link]: { mcpServers: { m365 } } } });
    checkClaudeMcpAtLaunch({ instanceDir, configDir: from, jsonPath: join(from, ".claude.json"), workingDirectory: link });
    expect(checkClaudeMcpAtLaunch({ instanceDir, configDir: to, jsonPath: join(to, ".claude.json"), workingDirectory: link })).toBeNull();
  });

  it("every carried name already in the target's symlink-spelled entry: the seeded real-path entry is still written and stays effective after preTrust", () => {
    vi.stubEnv("AGEND_HOME", join(root, "data"));
    const link = join(root, "link"); symlinkSync(cwd, link);
    const from = profile("old"), to = profile("new");
    const theirs = { type: "stdio", command: "their-m365" };
    write(from, { projects: { [link]: { mcpServers: { m365 } } } });
    write(to, { projects: { [link]: { hasTrustDialogAccepted: true, mcpServers: { m365: theirs } } } });
    expect(carryClaudeMcpServers({ fromProfileDir: from, toProfileDir: to, workingDirectory: link }))
      .toEqual({ carried: true, user: [], local: [], keptTarget: ["m365"] });
    new ClaudeCodeBackend(join(root, "instance")).preTrust(link, { backendOptions: { credential_profile: "new" } } as any);
    expect(read(to).projects[cwd]).toEqual({ hasTrustDialogAccepted: true, mcpServers: { m365: theirs } });
    expect(claudeMcpNames(join(to, ".claude.json"), link)).toEqual({ user: [], local: ["m365"] });
  });

  it("switching back to the default login writes CLAUDE_CONFIG_DIR's .claude.json, or ~/.claude.json with it unset", () => {
    const from = profile("old");
    write(from, { mcpServers: { outline } });
    const home = join(root, "home"); mkdirSync(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "fake-default" } }));
    expect(carryClaudeMcpServers({ fromProfileDir: from, toProfileDir: null, workingDirectory: cwd })).toMatchObject({ carried: true, user: ["outline"] });
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"))).toEqual({ oauthAccount: { accountUuid: "fake-default" }, mcpServers: { outline } });
    const own = join(root, "own-config"); mkdirSync(own);
    vi.stubEnv("CLAUDE_CONFIG_DIR", own);
    expect(carryClaudeMcpServers({ fromProfileDir: from, toProfileDir: null, workingDirectory: cwd })).toMatchObject({ carried: true, user: ["outline"] });
    expect(read(own).mcpServers).toEqual({ outline });
    expect(existsSync(join(own, ".claude.json"))).toBe(true);
  });
});

describe("M-3749 review R4: a tab that retains the released app-i18n.js", () => {
  it("still words the item in EN and zh-TW with beta.23's app-i18n.js byte for byte (no raw keys; names and profiles kept)", async () => {
    const { createHash } = await import("node:crypto");
    const { cpSync } = await import("node:fs");
    // v2.4.0-beta.23:src/ui/shared/app-i18n.js, committed byte for byte (CI checks out without tags); its git blob id proves it.
    const released = readFileSync("tests/fixtures/app-i18n-v2.4.0-beta.23.js.txt");
    const blob = createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${released.length}\0`), released])).digest("hex");
    expect(blob).toBe("17adf966de6cce1ae1dd37fef6a641d115c161db");
    const dir = join(root, "assets");
    cpSync("src/ui/shared", dir, { recursive: true });                    // today's modules…
    writeFileSync(join(dir, "app-i18n.js"), released);                    // …with the released app-i18n.js retained
    expect(released.toString()).not.toContain("mcp_missing");               // the control: that release has none of the keys
    const i18n = await import(join(dir, "app-i18n.js"));
    expect(i18n.t("app.needs_mcp_missing_detail")).toBe("app.needs_mcp_missing_detail");   // raw before the consumer loads
    const needs = await import(join(dir, "app-needs.js"));
    const item = { reason: "mcp_missing", detail: "m365, outline (old → new)", mcpMissing: { names: ["m365", "outline"], from: "old", to: "new" } };
    i18n.setLang("en", { store: false });
    expect(needs.reasonText(item)).toBe("MCP servers missing after an AI account switch");
    expect(needs.configDetail(item)).toBe("m365, outline (old → new)");
    i18n.setLang("zh-TW", { store: false });
    expect(needs.reasonText(item)).toBe("切換 AI 帳號後缺少 MCP 伺服器");
    expect(needs.configDetail(item)).toBe("m365、outline（old → new）");
    i18n.setLang("en", { store: false });
  });
});

