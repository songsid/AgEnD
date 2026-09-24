import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MuseBackend, museSessionCwd } from "../src/backend/muse.js";
import { createBackend } from "../src/backend/factory.js";
import { KNOWN_BACKENDS } from "../src/config-validator.js";
import { backendSupportsSteer } from "../src/steer-capability.js";
import { PaneStateMachine } from "../src/daemon.js";
import type { CliBackend, CliBackendConfig } from "../src/backend/types.js";

/**
 * Frames captured from live muse 1.3.0 sessions on 2026-09-22, not invented.
 *
 * The thing they establish: the input row `❯` is on screen in BOTH of them. A
 * TUI that keeps its prompt visible while it works makes the ready pattern
 * constant-true, so without a busy marker the daemon can never see the instance
 * as working — no hang detection, and a frozen CLI reported as idle.
 */
const WORKING = [
  "  Muse Code 1.3.0",
  "❯ Write a haiku about tmux. Nothing else.",
  "◇ Thinking (2s · esc to interrupt)",
  "────────────────────────────────────────────",
  "❯",
  "────────────────────────────────────────────",
  "  muse-spark-1.3-contributor · high · /t/c/scratchpad/muse-probe · Launch overrides",
].join("\n");

/**
 * The same session one frame later. Note `◆ Panes split the dark screen`: a
 * FINISHED answer wears the same glyph a working line does, which is why the
 * busy pattern cannot be anchored on the glyph.
 */
const IDLE = [
  "  Muse Code 1.3.0",
  "❯ Write a haiku about tmux. Nothing else.",
  "◆ Panes split the dark screen",
  "  Sessions linger through the night",
  "  Detached, work survives",
  "────────────────────────────────────────────",
  "❯",
  "────────────────────────────────────────────",
  "  muse-spark-1.3-contributor · high · /t/c/scratchpad/muse-probe · Launch overrides",
].join("\n");

/** The screen `--disable-approval` alone gets stuck on, verbatim. */
const TRUST = [
  "Do you trust this workspace?",
  "Workspace: /tmp/scratchpad/muse-probe",
  "Trusting allows project-local skills, rules, hooks, and plugin config to load before the model runs.",
  "Only trust this workspace when you trust its contents.",
  "> 1  Trust and continue",
  "  2  Quit",
  "Use Up/Down or 1/2, then Enter. Esc quits.",
].join("\n");

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function makeBackend() {
  const instanceDir = mkdtempSync(join(tmpdir(), "agend-muse-"));
  dirs.push(instanceDir);
  return { backend: new MuseBackend(instanceDir), instanceDir };
}

function config(over: Partial<CliBackendConfig> = {}): CliBackendConfig {
  return {
    workingDirectory: "/tmp/workspace",
    instanceDir: "/tmp/instance",
    instanceName: "alpha",
    mcpServers: {},
    ...over,
  };
}

describe("MuseBackend busy pattern", () => {
  const { backend } = makeBackend();

  it("separates a working pane from a finished one", () => {
    const ready = backend.getReadyPattern();
    const busy = backend.getBusyPattern();

    // The ready marker alone cannot do it: the input box never leaves.
    expect(ready.test(WORKING)).toBe(true);
    expect(ready.test(IDLE)).toBe(true);

    expect(busy.test(WORKING)).toBe(true);
    expect(busy.test(IDLE)).toBe(false);
  });

  it("matches every phase word and glyph the TUI cycles through", () => {
    const busy = backend.getBusyPattern();
    for (const line of [
      "◇ Thinking (2s · esc to interrupt)",
      "◇ Working (4s · esc to interrupt)",
      "◇ Double checking (6s · esc to interrupt)",
      "◈ Double checking (8s · esc to interrupt)",
      "◆ Double checking (10s · esc to interrupt)",
      "◇ Thinking (1.5s · esc to interrupt)",
    ]) {
      expect(busy.test(line), line).toBe(true);
    }
  });

  it("rejects finished work, including the lines that carry a timer", () => {
    // A false positive on a STABLE pane pins the instance in `working` forever:
    // no auto-pause, the cancel button never retires, and eventually a hang
    // alert about an instance that is simply done.
    const busy = backend.getBusyPattern();
    for (const line of [
      "◆ Panes split the dark screen",                                  // an answer, same glyph
      "◆ Ran command · Write probe file to tmp · ✓ · 1.1s · ctrl+o",    // finished tool, has a timer
      "◆ succeeded",
      "… 20 more lines (use /export to save the full text)",
      "  muse-spark-1.3-contributor · high · /t/c/scratchpad · Launch overrides",
      "❯",
      "I pressed esc to interrupt it earlier",                           // prose naming the hint
    ]) {
      expect(busy.test(line), line).toBe(false);
    }
  });
});

describe("muse stuck detection with the busy veto", () => {
  const { backend } = makeBackend();
  const STUCK_MS = 15_000;

  it("reaches stuck on a frozen working pane", () => {
    const machine = new PaneStateMachine(
      backend.getReadyPattern(), STUCK_MS, 0, backend.getBusyPattern(),
    );
    expect(machine.observe(WORKING, 1).state).toBe("working");
    expect(machine.observe(WORKING, STUCK_MS + 1).state).toBe("stuck");
  });

  it("would have called that same frozen pane idle without it", () => {
    const machine = new PaneStateMachine(backend.getReadyPattern(), STUCK_MS, 0);
    expect(machine.observe(WORKING, 1).state).toBe("idle");
    expect(machine.observe(WORKING, STUCK_MS + 1).state).toBe("idle");
  });

  it("still settles to idle once the run ends", () => {
    const machine = new PaneStateMachine(
      backend.getReadyPattern(), STUCK_MS, 0, backend.getBusyPattern(),
    );
    machine.observe(WORKING, 1);
    expect(machine.observe(IDLE, 2).state).toBe("working"); // motion
    expect(machine.observe(IDLE, 3).state).toBe("idle");
  });
});

describe("MuseBackend launch command", () => {
  it("asks for both trust and approval, because either alone stalls", () => {
    // Verified live: `--disable-approval` on its own parks on the trust dialog.
    const { backend } = makeBackend();
    const cmd = backend.buildCommand(config());
    expect(cmd).toContain("--disable-approval");
    expect(cmd).toContain("--trust-workspace");
  });

  it("does not reach for --yolo", () => {
    // --yolo would also switch off the OS sandbox, which was measured to permit
    // everything an agent needs (workspace + tmp writes, proxied network).
    const { backend } = makeBackend();
    expect(backend.buildCommand(config())).not.toContain("--yolo");
  });

  it("drops the unattended flags when permissions are not skipped", () => {
    const { backend } = makeBackend();
    const cmd = backend.buildCommand(config({ skipPermissions: false }));
    expect(cmd).not.toContain("--disable-approval");
    expect(cmd).not.toContain("--trust-workspace");
  });

  it("pins the launcher's update check so it cannot repaint the pane mid-run", () => {
    const { backend } = makeBackend();
    expect(backend.buildCommand(config())).toMatch(/^XDG_CONFIG_HOME='[^']+' MUSE_UPDATE_INTERVAL_SECONDS=\d+ /);
  });

  it("passes the model and the reasoning effort through", () => {
    const { backend } = makeBackend();
    const cmd = backend.buildCommand(config({ model: "muse-spark-1.3", effort: "xhigh" }));
    // Both are shell-quoted: they end up in a command string, and a model name
    // is user-supplied config.
    expect(cmd).toContain("--model 'muse-spark-1.3'");
    expect(cmd).toContain("--reasoning-effort 'xhigh'");
  });

  it("adds the daemon-owned relay base URL only when one was prepared", () => {
    const { backend } = makeBackend();
    const cmd = backend.buildCommand(config({ museBaseUrl: "http://127.0.0.1:43127" }));
    expect(cmd).toContain("--base-url 'http://127.0.0.1:43127'");
    expect(backend.buildCommand(config())).not.toContain("--base-url");
  });

  it("resumes the session it stored, with resume last so root flags precede it", () => {
    const { backend, instanceDir } = makeBackend();
    writeFileSync(join(instanceDir, "session-id"), "01a0c787-ed6b-7050-90a6-ee040d396302\n");
    const cmd = backend.buildCommand(config({ model: "muse-spark-1.3" }));
    expect(cmd).toContain("resume 01a0c787-ed6b-7050-90a6-ee040d396302");
    // `muse [root options] resume <id>` is the form verified against the CLI.
    expect(cmd.indexOf("--model")).toBeLessThan(cmd.indexOf("resume "));
  });

  it("starts clean when the daemon says not to resume", () => {
    const { backend, instanceDir } = makeBackend();
    writeFileSync(join(instanceDir, "session-id"), "01a0c787-ed6b-7050-90a6-ee040d396302\n");
    expect(backend.buildCommand(config({ skipResume: true }))).not.toContain("resume");
  });

  it("refuses a stored session id that is not one", () => {
    // The id is interpolated into a shell command; anything else is dropped.
    const { backend, instanceDir } = makeBackend();
    writeFileSync(join(instanceDir, "session-id"), "$(rm -rf /)\n");
    expect(backend.buildCommand(config())).not.toContain("resume");
  });
});

describe("MuseBackend MCP instance isolation", () => {
  it("keeps two Muse instances on their own settings, wrappers, and sockets", () => {
    const root = mkdtempSync(join(process.cwd(), ".agend-muse-isolation-"));
    dirs.push(root);
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(root, "shared-xdg");
    try {
      const sharedMuseDir = join(process.env.XDG_CONFIG_HOME, "muse");
      mkdirSync(sharedMuseDir, { recursive: true });
      const sharedSettingsPath = join(sharedMuseDir, "settings.json");
      const sharedSettings = {
        schema_version: 1,
        model: "muse-spark-1.3",
        mcpServers: {
          "user-server": { type: "stdio", command: "user-mcp", args: [] },
          "agend-agend-old": { type: "stdio", command: "/old/agend-wrapper.sh", args: [] },
        },
      };
      writeFileSync(sharedSettingsPath, JSON.stringify(sharedSettings));
      const sharedAuthPath = join(sharedMuseDir, "auth.json");
      writeFileSync(sharedAuthPath, "test-only-credentials", { mode: 0o600 });

      const instances = ["dev-muse", "reviewer"] as const;
      const launches: Array<{ name: string; instanceDir: string; command: string }> = [];
      for (const name of instances) {
        const instanceDir = join(root, name);
        mkdirSync(instanceDir);
        const backend = new MuseBackend(instanceDir);
        const backendConfig = config({
          instanceDir,
          instanceName: name,
          workingDirectory: join(root, `${name}-worktree`),
          mcpServers: {
            agend: {
              command: "node",
              args: ["/agend/mcp-server.js"],
              env: { AGEND_SOCKET_PATH: join(instanceDir, "channel.sock") },
            },
          },
        });
        backend.writeConfig(backendConfig);
        launches.push({ name, instanceDir, command: backend.buildCommand(backendConfig) });
      }

      // Inspect both launch commands only after the second instance has written
      // its config. A shared settings path would now contain the last writer's
      // socket, even if the first instance's initial write looked correct.
      for (const { name, instanceDir, command } of launches) {
        const effectiveXdg = command.match(/XDG_CONFIG_HOME='([^']+)'/)?.[1] ?? process.env.XDG_CONFIG_HOME;
        const settingsPath = join(effectiveXdg, "muse", "settings.json");
        const isolatedSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(isolatedSettings.model).toBe("muse-spark-1.3");
        expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
        expect(Object.keys(isolatedSettings.mcpServers).sort()).toEqual(["user-server", `agend-agend-${name}`].sort());
        const wrapper = isolatedSettings.mcpServers[`agend-agend-${name}`].command as string;
        expect(wrapper).toBe(join(instanceDir, "mcp-wrapper-agend.sh"));
        expect(readFileSync(wrapper, "utf8")).toContain(`AGEND_SOCKET_PATH='${join(instanceDir, "channel.sock")}'`);
        expect(statSync(wrapper).mode & 0o777).toBe(0o700);
        expect(command).toContain(`XDG_CONFIG_HOME='${join(instanceDir, "muse-xdg")}'`);
        const authLink = join(effectiveXdg, "muse", "auth.json");
        expect(lstatSync(authLink).isSymbolicLink()).toBe(true);
        expect(readlinkSync(authLink)).toBe(sharedAuthPath);
        expect(readlinkSync(join(effectiveXdg, "muse", ".auth.json.lock"))).toBe(join(sharedMuseDir, ".auth.json.lock"));
      }
      expect(JSON.parse(readFileSync(sharedSettingsPath, "utf8"))).toEqual(sharedSettings);
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });
});

describe("MuseBackend keys and commands", () => {
  const { backend } = makeBackend();

  it("cancels with Escape, never with Ctrl+C", () => {
    // Ctrl+C arms the quit confirmation; using it to cancel would leave every
    // instance one stray keypress from exiting.
    expect(backend.getCancelKey()).toBe("Escape");
    expect(backend.getCancelKey()).not.toBe("C-c");
  });

  it("quits through /quit, and needs Ctrl+C twice if it falls back to the key", () => {
    expect(backend.getQuitCommand()).toBe("/quit");
    expect(backend.getQuitKey()).toBe("C-c");
    expect(backend.getQuitKeyPresses()).toBe(2);
  });

  it("offers the slash commands muse actually has", () => {
    // Live: `/compact` prints "compacted" and the status bar then reads
    // "compacted context"; `/clear` empties the transcript.
    expect(backend.getCompactCommand()).toBe("/compact");
    expect(backend.getClearCommand()).toBe("/clear");
  });

  it("asks for a second Enter on every delivery", () => {
    // An Enter arriving in the same burst as the text is taken as a newline,
    // and the next one then submits the accumulated draft as one message. The
    // retry is safe because a bare Enter is a no-op both at an idle prompt and
    // mid-turn — both verified live.
    expect(backend.requiresDeliveryEnterRetry()).toBe(true);
  });

  it("steers a running turn rather than queueing for the next one", () => {
    // Submitting mid-turn is taken INTO that turn ("steering the running
    // turn"), which is not what supportsQueuedInput describes.
    expect(backendSupportsSteer("muse")).toBe(true);
    // Optional on the interface and deliberately not implemented, so the
    // default applies — read it through the interface, which is where the
    // absence means something.
    expect((backend as CliBackend).supportsQueuedInput?.() ?? false).toBe(false);
  });

  it("changes effort in place, with the levels muse actually took", () => {
    // Verified against a live session by sending the exact string AgEnD pastes
    // (`pasteRawToClassicInstance(name, "/effort " + level)`): low, xhigh, max
    // and high each moved the status bar. muse also accepts none/minimal/ultra,
    // which AgEnD has no canonical level for.
    expect(backend.getEffortStrategy()).toBe("runtime");
    expect(backend.getEffortLevels()).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("switches model by restart, because the in-session command ignores its argument", () => {
    // `/model muse-spark-1.3` does not set the model — muse opens its picker and
    // drops the argument. A "runtime" strategy would paste a command that looks
    // accepted and changes nothing, so the restart path is the only honest one.
    expect(backend.getModelSwitchStrategy()).toBe("restart");
  });

  it("reports no context reading, because muse only shows it inside /status", () => {
    // The persistent status bar carries model, effort and path — no context —
    // so there is nothing a passive reader can see between turns. /ctx answers
    // only while a `/status` panel is still inside the 60 lines AgEnD captures,
    // and that limit is deliberate: injecting `/status` before every reading
    // would drop a panel into the user's transcript each time anyone asked.
    expect(backend.getContextUsage()).toBeNull();
  });

  it("lists the models the picker offers", async () => {
    const models = await backend.listModels();
    expect(models.map(m => m.id)).toContain("muse-spark-1.3");
    expect(models.map(m => m.id)).toContain("muse-spark-1.3-contributor");
  });
});

describe("MuseBackend startup dialogs", () => {
  const { backend } = makeBackend();

  it("answers the trust screen that would otherwise hold the session forever", () => {
    const dialogs = backend.getStartupDialogs();
    const trust = dialogs.find(d => d.pattern.test(TRUST));
    expect(trust, "no dialog matches the captured trust screen").toBeDefined();
    // Option 1 is preselected and the footer says "Up/Down or 1/2, then Enter".
    expect(trust!.keys).toEqual(["1", "Enter"]);
  });

  it("waits out a login screen instead of typing at it", () => {
    const dialogs = backend.getStartupDialogs();
    const login = dialogs.find(d => d.pattern.test("Please run muse login to continue"));
    expect(login, "no dialog matches a login screen").toBeDefined();
    expect(login!.keys).toEqual([]);
  });

  it("leaves a ready pane alone", () => {
    for (const d of backend.getStartupDialogs()) {
      expect(d.pattern.test(IDLE), d.description).toBe(false);
    }
  });
});

describe("muse session lookup", () => {
  it("reads the workspace out of a route_facts record", () => {
    // Verbatim from a live session.jsonl, sequence 4.
    const head = '{"payload_type":"runtime.session.route_facts","payload":{"kind":"route_facts",'
      + '"record":{"cwd":"/home/han/projects/app","local_runtime_command_socket_path":"/x.sock"}}}';
    expect(museSessionCwd(head)).toBe("/home/han/projects/app");
  });

  it("unescapes a path rather than truncating it at the backslash", () => {
    expect(museSessionCwd('{"cwd":"/tmp/a\\"b/c"}')).toBe('/tmp/a"b/c');
  });

  it("returns null when the prefix has not reached route_facts", () => {
    expect(museSessionCwd('{"payload_type":"runtime.session.permission_format_declared"}')).toBeNull();
  });

  it("finds nothing before any session exists for the workspace", () => {
    const { backend } = makeBackend();
    backend.buildCommand(config({ workingDirectory: "/tmp/no-such-workspace-for-muse" }));
    expect(backend.getSessionId()).toBeNull();
  });
});

describe("muse is a backend the fleet can be pointed at", () => {
  it("is built by the factory", () => {
    expect(createBackend("muse", "/tmp/instance")).toBeInstanceOf(MuseBackend);
  });

  it("passes config validation, so fleet.yaml can say backend: muse", () => {
    expect(KNOWN_BACKENDS).toContain("muse");
  });
});
