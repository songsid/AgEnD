import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

// A Windows pane's PowerShell permission card must reach the same chat paths a Linux Claude permission reaches:
// Stop clears it through the pane's own key path, and the Needs-you line names the instance the way the web does.
const hooks = vi.hoisted(() => ({
  forbidden: vi.fn((..._args: unknown[]): never => { throw new Error("Forbidden host IO in native permission parity test"); }),
}));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  exec: hooks.forbidden, execFile: hooks.forbidden, execSync: hooks.forbidden,
  execFileSync: hooks.forbidden, spawn: hooks.forbidden, spawnSync: hooks.forbidden, fork: hooks.forbidden,
}));
vi.mock("node:net", async importOriginal => ({
  ...await importOriginal<typeof import("node:net")>(),
  createServer: hooks.forbidden, createConnection: hooks.forbidden, connect: hooks.forbidden,
}));
vi.mock("../src/backend/factory.js", () => ({ createBackend: hooks.forbidden }));

import { Daemon } from "../src/daemon.js";
import { createNativePaneBackend } from "../src/backend/native-pane.js";
import { ClaudePaneDetectors } from "../src/backend/claude-code.js";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";
import { answerRemoteCard, type RemoteCardIo } from "../src/remote-card-answer.js";
import type { RemoteCard, RemoteQuestionCard } from "../src/backend/types.js";
import { renderLiveMessage, deriveNeedsYou, type LiveLine, type NeedsYouItem } from "../src/needs-you.js";
import { presentationState } from "../src/interaction-observation.js";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const windowsCard = fixture("native-pane-claude-windows-shell-card.txt");
const linuxBash = fixture("claude-2.1.312-bash-permission-prompt.pane.txt");
const snapshot = () => ({ sessionId: "11111111-1111-4111-8111-111111111111", contextPercentage: null, statusLineItems: null, resumes: true, cwd: "C:\\work" });
const nativeShellDialog = () => createNativePaneBackend("claude-code", snapshot).getRuntimeDialogs!()
  .find(d => d.description.startsWith("Claude Windows shell permission"))!;
const question = (card: RemoteCard | null | undefined): RemoteQuestionCard => {
  if (!card || card.kind !== "question") throw Error("expected a question card");
  return card;
};
// A status row that changes between polls (a clock, a context gauge) is not a different request.
const repainted = (n: number) => `${windowsCard.replace(/\n$/, "")}\n  ctx ${40 + n}% left\n`;
const dirs: string[] = [];
const logger = pino({ level: "silent" }) as any;

afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("Stop clears a native pane's permission card through the pane's own key path", () => {
  it("a native pane sends Escape keyed on the dialog screen it just read, so the composer proof does not withhold it", async () => {
    const { daemon, sent } = daemonWithPane(true, () => windowsCard);
    await daemon.sendEscape();
    expect(sent).toEqual([["Escape", undefined, { kind: "dialog", screen: windowsCard }]]);
  });

  it("a native pane with an unreadable screen sends nothing (no blind key)", async () => {
    const { daemon, sent } = daemonWithPane(true, () => { throw new Error("capture failed"); });
    await daemon.sendEscape();
    expect(sent).toEqual([]);
  });

  it("the Linux tmux path is unchanged: one plain Escape, no screen proof", async () => {
    const { daemon, sent } = daemonWithPane(false, () => linuxBash);
    await daemon.sendEscape();
    expect(sent).toEqual([["Escape"]]);
  });
});

describe("the native Windows card is the Linux card's chat behaviour", () => {
  it("the shell card is a held, never-auto-answered permission dialog with an identity-bound card", () => {
    const dialog = nativeShellDialog();
    expect(dialog.isActive!(windowsCard)).toBe(true);
    expect(dialog.keys).toEqual([]);
    expect(dialog.holdOnly).toBe(true);
    expect(dialog.blocksDelivery).toBe(true);
    expect(dialog.interactionKind).toBe("permission");
    const card = question(dialog.remoteCard!(windowsCard));
    expect(card.webOnly).toBe(true);
    expect(card.options.map(o => o.n)).toEqual([1, 2, 3]);
  });

  it("the Linux Bash permission dialog keeps the same chat contract (held, permission, web-only card)", () => {
    const dialog = new ClaudePaneDetectors().getRuntimeDialogs!().find(d => d.description === "Claude Bash permission — waiting for a human choice, never auto-approving")!;
    expect(dialog.isActive!(linuxBash)).toBe(true);
    expect(dialog.keys).toEqual([]);
    expect(dialog.interactionKind).toBe("permission");
    expect(question(dialog.remoteCard!(linuxBash)).webOnly).toBe(true);
  });

  it("a changed command is a different card: an old button's identity cannot answer it", async () => {
    const dialog = nativeShellDialog();
    const oldIdentity = question(dialog.remoteCard!(windowsCard)).identity;
    const changed = windowsCard.split("New-Item -ItemType Directory -Name made-by-shell .").join("Remove-Item -Recurse -Force .");
    expect(question(dialog.remoteCard!(changed)).identity).not.toBe(oldIdentity);
    const keys: string[] = [];
    const io: RemoteCardIo = {
      locked: fn => fn(), read: async () => changed,
      key: async k => { keys.push(k); return true; }, paste: async () => true,
      sleep: async () => {}, now: () => 0,
    };
    const outcome = await answerRemoteCard(io, pane => dialog.remoteCard!(pane), oldIdentity, { kind: "option", n: 1 });
    expect(outcome.outcome).toBe("stale");
    expect(keys).toEqual([]);
  });
});

describe("Needs-you lines name the instance the way the web does", () => {
  const item = (instance: string): NeedsYouItem => ({ id: `awaiting:${instance}:-:1`, type: "awaiting_input", instance,
    reason: "permission", detail: "", since: Date.now() - 60_000 });
  const t = (key: string) => key === "needs.live_header" ? "Needs you — {n}" : key;

  it("shows the display name when one is given, and the raw instance name otherwise", () => {
    const lines: LiveLine[] = [{ item: item("windows-6f2a"), title: "needs permission", link: "[topic]", name: "Build Bot" }];
    expect(renderLiveMessage(lines, Date.now(), t).text).toContain("• Build Bot — needs permission");
    expect(renderLiveMessage(lines, Date.now(), t).text).not.toContain("windows-6f2a");
    const raw: LiveLine[] = [{ item: item("linux-agent"), title: "needs permission" }];
    expect(renderLiveMessage(raw, Date.now(), t).text).toContain("• linux-agent — needs permission");
  });
});

function daemonWithPane(native: boolean, pane: () => string) {
  const dir = mkdtempSync(join(tmpdir(), "agend-native-parity-"));
  dirs.push(dir);
  const backend = native ? createNativePaneBackend("claude-code", snapshot) : ({ binaryName: "claude", getCancelKey: () => "Escape", getReadyPattern: () => /^READY$/m } as any);
  const daemon = new Daemon("windows-agent", { backend: "claude-code", working_directory: dir, log_level: "silent",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 } } as any, dir, true, backend as any, undefined, logger) as any;
  const sent: unknown[][] = [];
  daemon.tmux = {
    capturePane: vi.fn(async () => pane()),
    isWindowAlive: vi.fn(async () => true),
    getWindowId: () => "w",
    sendSpecialKey: vi.fn(async (...args: unknown[]) => { sent.push(args); return true; }),
  };
  if (native) daemon.nativePaneLifecycle = {};
  return { daemon, sent };
}

describe("the held permission's identity survives the pane's own repaints (parked clock, interaction episode)", () => {
  it("the native shell dialog identity is the request's, not the whole pane", () => {
    const dialog = nativeShellDialog();
    expect(dialog.requestIdentity?.(repainted(0))).toBe(dialog.requestIdentity?.(repainted(1)));
    expect(dialog.requestIdentity?.(repainted(0))).toBe(question(dialog.remoteCard!(windowsCard)).identity);
  });

  it("a held Windows permission still reports dialog_parked after 60 s while its status row repaints", async () => {
    vi.useFakeTimers();
    const { daemon } = daemonWithPane(true, () => repainted(Math.floor(Date.now() / 5_000) % 50));
    try {
      const parked: unknown[] = [];
      daemon.on("dialog_parked", (e: unknown) => parked.push(e));
      daemon.setProcessStatus?.("running");
      daemon.startErrorMonitor();
      for (let i = 0; i < 18; i++) await vi.advanceTimersByTimeAsync(5_000);
      expect(parked.length).toBe(1);
    } finally {
      clearInterval(daemon.errorMonitorTimer);
      vi.useRealTimers();
    }
  });
});

describe("a held native permission reaches the parked notice (topic and General) through the lifecycle", () => {
  it("dialog_parked from the native daemon is shown through the ledger, with the instance's topic text", async () => {
    vi.useFakeTimers();
    const dataDir = mkdtempSync(join(tmpdir(), "agend-native-parked-"));
    dirs.push(dataDir);
    const showParkedNotice = vi.fn();
    const { daemon } = daemonWithPane(true, () => repainted(Math.floor(Date.now() / 5_000) % 50));
    const ctx = {
      fleetConfig: { defaults: {}, instances: { general: { general_topic: true }, "windows-agent": {} } },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      dataDir, getInstanceDir: (name: string) => join(dataDir, name),
      eventLog: { insert: vi.fn() }, isPlannedRestart: () => false, isClassicInstance: () => false,
      notifyInstanceTopic: vi.fn(() => true), notifyFleetError: vi.fn(), showParkedNotice, resolveParkedNotice: vi.fn(),
    } as unknown as LifecycleContext;
    new InstanceLifecycle(ctx).attachIncidentHandlers("windows-agent", daemon);
    daemon.setProcessStatus?.("running");
    daemon.startErrorMonitor();
    try {
      for (let i = 0; i < 18; i++) await vi.advanceTimersByTimeAsync(5_000);
      expect(showParkedNotice).toHaveBeenCalledTimes(1);
      const [name, topicText, generalText] = showParkedNotice.mock.calls[0]!;
      expect(name).toBe("windows-agent");
      expect(String(topicText)).toContain("Claude");
      expect(String(generalText)).toContain("windows-agent");
    } finally {
      clearInterval(daemon.errorMonitorTimer);
      vi.useRealTimers();
    }
  });
});

describe("fleet-manager's Needs-you context names instances as the web does", () => {
  it("instanceName resolves a configured display name, else the raw instance name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-fm-names-"));
    dirs.push(dir);
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = new FleetManager(dir) as any;
    fm.fleetConfig = { defaults: {}, instances: { "windows-6f2a": { display_name: "Build Bot" }, plain: {} } };
    fm.startNeedsYou();
    try {
      const ctx = fm.needsYou.ctx;
      expect(ctx.instanceName("windows-6f2a")).toBe("Build Bot");
      expect(ctx.instanceName("plain")).toBe("plain");
    } finally {
      fm.needsYou?.stop?.();
    }
  });
});

describe("a repainting Windows permission is listed on the web Needs feed (end to end: daemon -> presentation -> derivation)", () => {
  it("awaiting_input stays on the feed while the status row repaints, and names the permission", async () => {
    vi.useFakeTimers();
    try {
      const { daemon } = daemonWithPane(true, () => repainted(Math.floor(Date.now() / 5_000) % 50));
      daemon.setProcessStatus?.("running");
      daemon.startErrorMonitor();
      for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(5_000);
      const interaction = daemon.getInteractionSnapshot();
      expect(presentationState("working", interaction)).toBe("awaiting_input");
      const items = deriveNeedsYou({ prompts: [], deliveries: [], ownerOf: () => "discord-main",
        instances: [{ name: "windows-agent", state: presentationState("working", interaction) ?? undefined,
          interaction: { kind: interaction.kind, owner: null, episode: interaction.episode, since: interaction.since },
          interactionSummary: "permission" }] });
      const awaiting = items.filter(i => i.type === "awaiting_input");
      expect(awaiting.map(i => i.reason)).toEqual(["permission"]);
      expect(awaiting[0]!.instance).toBe("windows-agent");
      clearInterval(daemon.errorMonitorTimer);
    } finally {
      vi.useRealTimers();
    }
  });
});
