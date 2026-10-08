/**
 * #1405: kiro steers only from its TUI front-ends — typed input while a turn runs is injected into it ("steer", kiro's
 * default) or held for its end ("queue"; Ctrl+S toggles, a per-session setting) — and only on a version whose composer
 * AgEnD has read off a real pane. The legacy UI swallows busy input, so there a steer is an ordinary message after the
 * turn. The mode cannot be pinned at launch without editing ~/.kiro (`chat.defaultInterruptBehavior` lives only in the
 * user's settings file; not a flag, env var or workspace key), so AgEnD reads it off the composer on every delivery and
 * never presses the toggle.
 *
 * Real panes: tests/fixtures/kiro-reply-guard (kiro-cli 2.27.1, `--tui --agent-engine=v2` and `--legacy-ui`). Rows
 * marked TEMPLATE are the real busy pane with its composer row rewritten to another output of tui.js's placeholder
 * function (identical in 2.21.0, 2.27.1 and 2.28.0) — the modes no real pane of ours shows yet.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KIRO_STEER_VERIFIED, KiroBackend, readKiroComposerText, readKiroSteerComposer, type KiroCliCompatibility } from "../src/backend/kiro.js";
import type { CliBackendConfig } from "../src/backend/types.js";
import { setLocale, t } from "../src/locale.js";
import { outboundHandlers, setCrossInstanceRetryForTests } from "../src/outbound-handlers.js";
import { backendSupportsSteer, instanceSupportsSteer } from "../src/steer-capability.js";
import { TopicCommands } from "../src/topic-commands.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "kiro-reply-guard", `${name}.pane.txt`), "utf8");
const TUI_BUSY = fixture("tui-busy");
const TUI_IDLE = fixture("tui-idle");
const LEGACY_BUSY = fixture("legacy-busy");
const LEGACY_IDLE = fixture("legacy-idle");
const COMPOSER = "›  Kiro is working · 0s · Type to steer · Ctrl+S to queue";
/** TEMPLATE: the real busy pane with its composer row replaced. */
const withComposer = (row: string) => {
  expect(TUI_BUSY).toContain(COMPOSER);
  return TUI_BUSY.replace(COMPOSER, row);
};

describe("readKiroSteerComposer — real panes", () => {
  it("the TUI's busy composer reads steer (kiro's default mode); its idle prompt reads idle", () => {
    expect(TUI_BUSY.trimEnd().split("\n").at(-1)).toBe(COMPOSER);
    expect(readKiroSteerComposer(TUI_BUSY)).toBe("steer");
    expect(readKiroSteerComposer(TUI_IDLE)).toBe("idle");      // below it: a right-aligned `/copy to clipboard` hint
  });

  it("the legacy UI has no such composer, busy or idle", () => {
    expect(readKiroSteerComposer(LEGACY_BUSY)).toBeNull();
    expect(readKiroSteerComposer(LEGACY_IDLE)).toBeNull();
  });
});

describe("readKiroSteerComposer — the live run's panes (tests/fixtures/kiro-steer-1405, real account, 2026-10-08)", () => {
  const live = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "kiro-steer-1405", `${name}.pane.txt`), "utf8");
  it("steer, queue and idle on 2.27.1 TUI, 2.27.1 v3 and 2.28.0 TUI — busy, a pending tray above, the turn over", () => {
    for (const v of ["2.27.1-tui", "2.27.1-v3", "2.28.0-tui"]) {
      expect(readKiroSteerComposer(live(`${v}-busy-steer`)), v).toBe("steer");
      expect(readKiroSteerComposer(live(`${v}-steer-pending`)), v).toBe("steer");      // `◇ 1 message queued` above it
      expect(live(`${v}-steer-pending`)).toContain("◇ 1 message queued · ctrl+x expand");
      expect(readKiroSteerComposer(live(`${v}-steer-injected`)), v).toBe("idle");
    }
    expect(readKiroSteerComposer(live("2.27.1-tui-busy-queue"))).toBe("queue");
    expect(readKiroSteerComposer(live("2.28.0-tui-busy-queue"))).toBe("queue");
    expect(readKiroSteerComposer(live("2.27.1-tui-queue-pending"))).toBe("queue");
    expect(readKiroSteerComposer(live("2.27.1-tui-idle"))).toBe("idle");
  });

  it("a multi-line paste is the `›` row plus rows indented two spaces: text, its first line on the `›` row", () => {
    for (const [name, id] of [["2.27.1-tui-steer-in-box", "d"], ["2.27.1-tui-steer-box-after-enter", "d"], ["2.27.1-v3-steer-in-box", "v"],
      ["2.28.0-tui-steer-in-box", "k"], ["2.27.1-tui-queue-in-box", "c"]] as const) {
      expect(readKiroSteerComposer(live(name)), name).toBe("text");
      expect(readKiroComposerText(live(name)), name).toBe(`[agend-delivery-id:probe-1405-${id}]`);
    }
  });

  it("the steer is injected into the same turn as a user message, and the reply carries no `[STEERING : …]` tag", () => {
    const injected = live("2.27.1-tui-steer-injected");
    expect(injected).toMatch(/SLEPT-D\n(?:[ \t]*\n)? {2}› \[agend-delivery-id:probe-1405-d\]/);
    expect(injected).toContain("PROBE-D-DONE EGGPLANT");
    for (const v of ["2.27.1-tui", "2.27.1-v3", "2.28.0-tui"]) expect(live(`${v}-steer-injected`)).not.toContain("[STEERING :");
  });

  it("the trust-all-tools warning has no composer, and AgEnD's startup table answers it", () => {
    const pane = live("2.27.1-tui-trust-all-tools");
    expect(readKiroSteerComposer(pane)).toBeNull();
    const b = new KiroBackend("/tmp/agend-1405-trust", { version: "kiro-cli 2.27.1", supportsLegacyUi: true, supportsTui: true, supportsV3: true,
      agentEngines: ["v1", "v2", "v3"], supportsEffortFlag: true, supportsInstanceAgent: false, source: "version" });
    expect(b.getStartupDialogs().some(d => (d.isActive ? d.isActive(pane) : d.pattern.test(pane)))).toBe(true);
  });
});

describe("readKiroSteerComposer — the placeholder's other outputs (TEMPLATE)", () => {
  it("queue mode, a spec task run, 2.21.0's row without the time, minutes, a rebound toggle key", () => {
    expect(readKiroSteerComposer(withComposer("›  Kiro is working · 12s · Type to queue · Ctrl+S to steer"))).toBe("queue");
    expect(readKiroSteerComposer(withComposer("›  Kiro is working · 3s · Type to queue"))).toBe("queue");
    expect(readKiroSteerComposer(withComposer("›  Kiro is working · Type to steer · Ctrl+S to queue"))).toBe("steer");
    expect(readKiroSteerComposer(withComposer("›  Kiro is working · 1h 2m 5s · Type to steer · Ctrl+S to queue"))).toBe("steer");
    expect(readKiroSteerComposer(withComposer("›  Kiro is working · 4s · Type to steer · Alt+Q to queue"))).toBe("steer");
  });

  it("typed text in the box reads text — positive evidence it holds something", () => {
    expect(readKiroSteerComposer(withComposer("›  [STEERING — mid-task course correction.]"))).toBe("text");
    // a draft that begins with the idle placeholder's words is a draft, not the empty prompt (#1432 review)
    expect(readKiroSteerComposer(withComposer("›  ask a question or describe a task that retrieves my logs"))).toBe("text");
    expect(readKiroSteerComposer(withComposer("›  ask a question or describe a task ↵ and more"))).toBe("text");
  });

  it("the goal, editing, initializing, spec and shell placeholders, the ASCII glyph set, and no composer row are null", () => {
    for (const row of [
      "›  Goal Active: Running · Iteration 2/10 · Ctrl+C to pause",
      "›  Goal Paused: Running · Iteration 2/10 · type to resume · Ctrl+C to cancel",
      "›  Editing queued message 1 · esc to cancel",
      "›  Initializing · type to queue a message",
      "›  describe what \"auth\" should do · esc to cancel",
      "›  running shell command · ctrl+c to cancel",
      "›  Kiro is working . 3s . Type to steer . Ctrl+S to queue",     // ASCII glyphs: never seen live, not read
      "›  ask a question or describe a task enter",
      "›  Kiro is working · 3s · something new",
    ]) expect(readKiroSteerComposer(withComposer(row)), row).toBeNull();
    expect(readKiroSteerComposer(TUI_BUSY.replace(COMPOSER, "│ Allow this action? [y/n]"))).toBeNull();   // no composer row
  });

  it("a placeholder with an indented row below it is not typed text (a placeholder is one row)", () => {
    expect(readKiroSteerComposer(withComposer("›  Kiro is working · 0s · Type to steer · Ctrl+S to queue\n  a stray indented row"))).toBeNull();
    expect(readKiroSteerComposer(withComposer("›  ask a question or describe a task ↵\n  a stray indented row"))).toBeNull();
    expect(readKiroSteerComposer(withComposer("› typed first line\n  typed second line"))).toBe("text");
  });

  it("only the composer's own row counts: an indented transcript row quoting it is not one", () => {
    const quoted = withComposer("  ›  Kiro is working · 0s · Type to steer · Ctrl+S to queue");
    expect(readKiroSteerComposer(quoted)).toBeNull();
    // and a composer that is not at the bottom (output below it) is not the live one
    expect(readKiroSteerComposer(`${TUI_BUSY.trimEnd()}\nsome output row`)).toBeNull();
  });

  it("plan mode's and tangent's idle prompts are idle", () => {
    expect(readKiroSteerComposer(withComposer("›  ask a question or describe a task ↵  ·  exit plan mode: shift+tab"))).toBe("idle");
    expect(readKiroSteerComposer(withComposer("›  ask a question or describe a task · /tangent to go back · /tangent ls to view"))).toBe("idle");
  });
});

describe("KiroBackend.supportsSteer — the launch decides (production buildCommand)", () => {
  const dirs: string[] = [];
  let saved: Record<string, string | undefined>;
  const scratch = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
  beforeEach(() => {
    saved = { AGEND_HOME: process.env.AGEND_HOME, KIRO_HOME: process.env.KIRO_HOME };
    process.env.AGEND_HOME = scratch("agend-1405-home-");
    process.env.KIRO_HOME = scratch("agend-1405-kiro-");
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const compat = (version: string | undefined): KiroCliCompatibility => ({
    version, supportsLegacyUi: true, supportsTui: true, supportsV3: true,
    agentEngines: ["v1", "v2", "v3"], supportsEffortFlag: true, supportsInstanceAgent: false, source: "version",
  });
  const config = (kiroUi: CliBackendConfig["kiroUi"]): CliBackendConfig => ({
    workingDirectory: scratch("agend-1405-work-"), instanceDir: scratch("agend-1405-inst-"), instanceName: "w", mcpServers: {}, kiroUi,
  });
  const launched = (version: string | undefined, kiroUi: CliBackendConfig["kiroUi"]) => {
    const b = new KiroBackend(scratch("agend-1405-b-"), compat(version));
    b.buildCommand(config(kiroUi));
    return b;
  };

  it("the front-ends a live run verified steer (2.27.1 TUI and v3, 2.28.0 TUI); they read their composer", () => {
    expect(KIRO_STEER_VERIFIED).toEqual({ "2.27.1": ["tui", "v3"], "2.28.0": ["tui"] });
    for (const [version, ui] of [["kiro-cli 2.27.1", "tui"], ["kiro-cli 2.27.1", "v3"], ["kiro-cli 2.28.0", "tui"]] as const) {
      const b = launched(version, ui);
      expect(b.supportsSteer(), `${version} ${ui}`).toBe(true);
      expect(b.readSteerComposer(TUI_BUSY)).toBe("steer");
    }
  });

  it("the legacy UI, 2.28.0's v3 (not run live), an unlisted version and an undetected one do not", () => {
    expect(launched("kiro-cli 2.27.1", "legacy").supportsSteer()).toBe(false);
    expect(launched("kiro-cli 2.28.0", "v3").supportsSteer()).toBe(false);
    expect(launched("kiro-cli 2.29.0", "tui").supportsSteer()).toBe(false);
    expect(launched("kiro-cli 2.21.0", "tui").supportsSteer()).toBe(false);
    expect(launched(undefined, "tui").supportsSteer()).toBe(false);
  });

  it("before any launch it is the legacy default: no steer, no composer reading", () => {
    const b = new KiroBackend(scratch("agend-1405-b-"), compat("kiro-cli 2.27.1"));
    expect(b.supportsSteer()).toBe(false);
    expect(b.readSteerComposer(TUI_BUSY)).toBeNull();
  });

  it("a legacy launch never reads a composer, even a TUI-shaped row", () => {
    expect(launched("kiro-cli 2.27.1", "legacy").readSteerComposer(TUI_BUSY)).toBeNull();
  });

  it("an inherited key is not a version (Object.hasOwn)", () => {
    expect(launched("kiro-cli 0.0.0 toString", "tui").supportsSteer()).toBe(false);
  });
});

describe("the hub asks the target's running launch (send_to_instance steer:true, /steer)", () => {
  afterEach(() => { setCrossInstanceRetryForTests(null); setLocale("en"); });
  function outboundCtx(launch: boolean | undefined) {
    setCrossInstanceRetryForTests({ retries: 0, intervalMs: 5 });
    return {
      fleetConfig: { defaults: {}, instances: { sender: {}, target: { backend: "kiro-cli" } }, channel: undefined },
      adapter: null,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      instanceIpcClients: new Map([["target", { connected: true, send: vi.fn() }]]),
      sessionRegistry: new Map(),
      lifecycle: { daemons: new Map(), isPaused: vi.fn(() => false) },
      classicChannels: null,
      eventLog: { logActivity: vi.fn(), insert: vi.fn() },
      deliverToInstance: vi.fn(() => new Promise<void>(() => {})),
      notifyInstanceTopic: vi.fn(),
      lastActivityMs: vi.fn(() => 0),
      instanceLaunchSupportsSteer: vi.fn(() => launch),
    } as any;
  }
  async function send(ctx: any) {
    let result: any;
    await outboundHandlers.get("send_to_instance")!(ctx, { instance_name: "target", message: "correction", steer: true },
      r => { result = r; }, { instanceName: "sender", requestId: 1 } as any);
    return result;
  }

  it("a kiro target launched in its TUI on a verified version is steered", async () => {
    const ctx = outboundCtx(true);
    expect(await send(ctx)).toMatchObject({ delivery_mode: "steer" });
    expect(ctx.instanceLaunchSupportsSteer).toHaveBeenCalledWith("target");
    expect(ctx.deliverToInstance).toHaveBeenCalledWith("target", expect.objectContaining({ type: "steer" }),
      { isCrossInstance: true, waitForIdle: false });
  });

  it("a kiro target on the legacy UI or an unverified version — or with no running launch — gets the idle queue", async () => {
    for (const launch of [false, undefined]) {
      const ctx = outboundCtx(launch);
      const result = await send(ctx);
      expect(result).toMatchObject({ delivery_mode: "idle_queue" });
      expect(result.warning).toContain("kiro-cli cannot accept mid-turn input");
      expect(ctx.deliverToInstance.mock.calls.map((c: unknown[]) => (c[1] as { type: string }).type)).toEqual(["fleet_inbound"]);
    }
  });

  function topic(launch: boolean | undefined) {
    const send = vi.fn();
    const ctx = {
      fleetConfig: { defaults: {}, instances: { w: { backend: "kiro-cli" } } },
      classicChannels: null,
      instanceIpcClients: new Map([["w", { connected: true, send }]]),
      instanceLaunchSupportsSteer: vi.fn(() => launch),
    } as any;
    return { commands: new TopicCommands(ctx), send };
  }
  const msg = { chatId: "c", messageId: "m", username: "u", userId: "1", threadId: "t", adapterId: "a", source: "telegram" } as any;

  it("/steer: sent to a TUI launch; refused for this launch on the legacy UI; refused for the backend with no launch", () => {
    const tui = topic(true);
    expect(tui.commands.sendSteer("w", "go left", msg)).toBe(t("steer.sent", "w"));
    expect(tui.send).toHaveBeenCalledWith(expect.objectContaining({ type: "steer", content: "go left" }));
    const legacy = topic(false);
    expect(legacy.commands.sendSteer("w", "go left", msg)).toBe(t("steer.unsupported_launch", "kiro-cli"));
    expect(legacy.send).not.toHaveBeenCalled();
    const none = topic(undefined);
    expect(none.commands.sendSteer("w", "go left", msg)).toBe(t("steer.unsupported", "kiro-cli"));
    expect(none.send).not.toHaveBeenCalled();
  });
});

describe("instanceSupportsSteer — the hub's answer", () => {
  it("the launch's own answer wins; without one, the backend-name table", () => {
    expect(backendSupportsSteer("kiro")).toBe(false);
    expect(instanceSupportsSteer("kiro", true)).toBe(true);
    expect(instanceSupportsSteer("kiro", false)).toBe(false);
    expect(instanceSupportsSteer("kiro", undefined)).toBe(false);        // no running Daemon to ask
    expect(instanceSupportsSteer("claude-code", undefined)).toBe(true);
    expect(instanceSupportsSteer("opencode", undefined)).toBe(false);
  });
});
