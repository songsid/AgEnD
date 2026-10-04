import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeBackend } from "../../src/backend/opencode.js";
import {
  OPENCODE_PERMISSION_ENV,
  cachedOpencodeAutoSupport,
  helpAdvertisesAutoFlag,
  looksLikeOpencodeHelp,
  opencodeAlwaysConfirmActive,
  opencodePermissionPromptActive,
  probeOpencodeAutoSupport,
  resetOpencodeAutoSupportCacheForTests,
} from "../../src/backend/opencode-permission.js";

/**
 * Keeping OpenCode's permission prompts away: the launch switch (`--auto` when the binary lists it, else the
 * OPENCODE_PERMISSION env) and, behind it, structural runtime dialogs answering "Allow once". The panes and
 * `--help` outputs are the real ones from OpenCode 1.14.51 / 1.16.2 / 1.17.20 / 1.18.34; nothing here starts OpenCode.
 */
const fixture = (name: string) => readFileSync(join(__dirname, "..", "fixtures", name), "utf8");
const HELP = {
  "1.14.51": fixture("opencode-1.14.51-help.txt"),
  "1.16.2": fixture("opencode-1.16.2-help.txt"),
  "1.17.20": fixture("opencode-1.17.20-help.txt"),
  "1.18.34": fixture("opencode-1.18.34-help.txt"),
};
const PROMPTS = {
  "external directory": "opencode-1.18.34-permission-external-directory.pane.txt",
  "external directory (60 columns, wrapped footer)": "opencode-1.18.34-permission-external-directory-60col.pane.txt",
  "external directory (1.17.20)": "opencode-1.17.20-permission-external-directory.pane.txt",
  "read .env": "opencode-1.18.34-permission-read-env.pane.txt",
  "edit (with a diff)": "opencode-1.18.34-permission-edit.pane.txt",
  "shell command": "opencode-1.18.34-permission-bash.pane.txt",
  "webfetch": "opencode-1.18.34-permission-webfetch.pane.txt",
  "back from Cancel on the Always page": "opencode-1.18.34-permission-after-always-cancel.pane.txt",
};
const ALWAYS = fixture("opencode-1.18.34-permission-always-confirm.pane.txt");
const READY = fixture("opencode-1.18.34-ready-after-tool.pane.txt");
const READY_AUTO = fixture("opencode-1.18.34-ready-after-tool-auto.pane.txt");

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-oc-perm-")); resetOpencodeAutoSupportCacheForTests(); });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

describe("which OpenCode takes --auto: read from its own --help", () => {
  it.each([["1.14.51", false], ["1.16.2", false], ["1.17.20", true], ["1.18.34", true]] as const)("%s → %s", (version, takes) => {
    expect(looksLikeOpencodeHelp(HELP[version])).toBe(true);
    expect(helpAdvertisesAutoFlag(HELP[version])).toBe(takes);
  });

  it("an empty, truncated or foreign output is not OpenCode's help (it proves nothing)", () => {
    for (const text of ["", "opencode: command not found", "Usage: kiro chat [OPTIONS]", "--auto  something else entirely"]) {
      expect(looksLikeOpencodeHelp(text), text).toBe(false);
    }
  });

  it("the flag must be a help ROW, not a word in a description", () => {
    expect(helpAdvertisesAutoFlag("opencode [project]\n  -m, --model  use --auto-complete for models")).toBe(false);
    expect(helpAdvertisesAutoFlag("  -a, --auto   short alias first")).toBe(true);
  });
});

describe("probing the binary (asynchronous, once per binary generation)", () => {
  const OK_YES = async () => HELP["1.18.34"];
  const OK_NO = async () => HELP["1.16.2"];

  it("answers yes / no / unknown", async () => {
    expect(await probeOpencodeAutoSupport("/b/yes", OK_YES)).toBe("yes");
    expect(await probeOpencodeAutoSupport("/b/no", OK_NO)).toBe("no");
    expect(await probeOpencodeAutoSupport("/b/broken", async () => { throw new Error("spawn ENOENT"); })).toBe("unknown");
    expect(await probeOpencodeAutoSupport("/b/foreign", async () => "something else")).toBe("unknown");
  });

  it("a probe that returns nothing legible is 'unknown', never 'no'", async () => {
    expect(await probeOpencodeAutoSupport("/b/blank", async () => "")).toBe("unknown");
  });

  it("is asked once per binary and remembered; concurrent callers share one run", async () => {
    const run = vi.fn(OK_YES);
    const [a, b] = await Promise.all([probeOpencodeAutoSupport("/b/x", run), probeOpencodeAutoSupport("/b/x", run)]);
    expect([a, b]).toEqual(["yes", "yes"]);
    await probeOpencodeAutoSupport("/b/x", run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(cachedOpencodeAutoSupport("/b/x")).toBe("yes");
    expect(cachedOpencodeAutoSupport("/b/never-probed")).toBe("unknown");
  });

  it("an 'unknown' is asked again after a minute, a real answer is not", async () => {
    vi.useFakeTimers();
    const flaky = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValue(HELP["1.18.34"]);
    expect(await probeOpencodeAutoSupport("/b/flaky", flaky)).toBe("unknown");
    expect(await probeOpencodeAutoSupport("/b/flaky", flaky)).toBe("unknown");     // within the minute: not asked again
    expect(flaky).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(61_000);
    expect(await probeOpencodeAutoSupport("/b/flaky", flaky)).toBe("yes");
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it("a binary replaced in place is probed again (keyed by its identity, not its path)", async () => {
    const bin = join(dir, "opencode");
    writeFileSync(bin, "#!/bin/sh\n"); chmodSync(bin, 0o755);
    const run = vi.fn().mockResolvedValueOnce(HELP["1.16.2"]).mockResolvedValueOnce(HELP["1.18.34"]);
    expect(await probeOpencodeAutoSupport(bin, run)).toBe("no");
    writeFileSync(bin, "#!/bin/sh\n# upgraded to a bigger file\n");
    expect(await probeOpencodeAutoSupport(bin, run)).toBe("yes");
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("OpenCodeBackend: the launch command", () => {
  function backend(auto?: "yes" | "no" | "unknown"): OpenCodeBackend {
    const b = new OpenCodeBackend(dir);
    const path = (b as unknown as { binaryPath: string }).binaryPath;
    if (auto && auto !== "unknown") void probeOpencodeAutoSupport(path, async () => (auto === "yes" ? HELP["1.18.34"] : HELP["1.16.2"]));
    return b;
  }
  const config = (extra: Record<string, unknown> = {}) => ({ workingDirectory: dir, instanceDir: dir, instanceName: "oc", mcpServers: {}, ...extra }) as never;
  const settled = () => new Promise(resolve => setImmediate(resolve));

  it("a binary that lists --auto gets --auto and not the env", async () => {
    const b = backend("yes"); await settled();
    const cmd = b.buildCommand(config());
    expect(cmd).toMatch(/ --auto(?: |$)/);
    expect(cmd).not.toContain("OPENCODE_PERMISSION");
  });

  it("one that does not list it gets the env form, and no unknown flag (an unknown flag makes OpenCode exit 1)", async () => {
    const b = backend("no"); await settled();
    const cmd = b.buildCommand(config());
    expect(cmd.startsWith(`${OPENCODE_PERMISSION_ENV} `)).toBe(true);
    expect(cmd).not.toContain("--auto");
    expect(OPENCODE_PERMISSION_ENV).toBe(`OPENCODE_PERMISSION='{"external_directory":"allow"}'`);
    expect(JSON.parse(OPENCODE_PERMISSION_ENV.slice("OPENCODE_PERMISSION='".length, -1))).toEqual({ external_directory: "allow" });
  });

  it("an unprobed or unreadable binary gets the env form too — never a flag it may not know", () => {
    const cmd = backend().buildCommand(config());
    expect(cmd).toContain("OPENCODE_PERMISSION");
    expect(cmd).not.toContain("--auto");
  });

  it("skipPermissions: false turns both off", async () => {
    const b = backend("yes"); await settled();
    const cmd = b.buildCommand(config({ skipPermissions: false }));
    expect(cmd).not.toContain("--auto");
    expect(cmd).not.toContain("OPENCODE_PERMISSION");
  });

  it("the session and model flags are still there, after the permission switch", async () => {
    writeFileSync(join(dir, "session-id"), "ses_abc");
    const b = backend("yes"); await settled();
    const cmd = b.buildCommand(config({ model: "mock/mock-model" }));
    expect(cmd).toMatch(/ --auto --session ses_abc --model /);
  });

  it("prepareLaunch asks the binary's own --help, asynchronously, and buildCommand then uses the answer", async () => {
    const script = join(dir, "fake-opencode");
    writeFileSync(script, `#!/bin/sh\ncat <<'EOF'\n${HELP["1.17.20"]}\nEOF\n`);
    chmodSync(script, 0o755);
    const b = new OpenCodeBackend(dir);
    (b as unknown as { binaryPath: string }).binaryPath = script;
    expect(b.buildCommand(config())).toContain("OPENCODE_PERMISSION");           // before the probe: conservative
    await b.prepareLaunch();
    expect(cachedOpencodeAutoSupport(script)).toBe("yes");
    expect(b.buildCommand(config())).toContain(" --auto");
  });

  it("prepareLaunch never throws, whatever the binary does", async () => {
    const b = new OpenCodeBackend(dir);
    (b as unknown as { binaryPath: string }).binaryPath = join(dir, "does-not-exist");
    await expect(b.prepareLaunch()).resolves.toBeUndefined();
    expect(b.buildCommand(config())).toContain("OPENCODE_PERMISSION");
  });
});

describe("the runtime dialogs: structural, Allow once", () => {
  const [permission, always] = new OpenCodeBackend(mkdtempSync(join(tmpdir(), "agend-oc-d-"))).getRuntimeDialogs();

  it.each(Object.entries(PROMPTS))("%s is a live permission prompt", (_name, file) => {
    const pane = fixture(file);
    expect(opencodePermissionPromptActive(pane)).toBe(true);
    expect(permission!.pattern.test(pane)).toBe(true);
    expect(opencodeAlwaysConfirmActive(pane)).toBe(false);
  });

  it("answers with ONE Enter (Allow once is the option OpenCode selects), not Right+Enter (Allow always)", () => {
    expect(permission!.keys).toEqual(["Enter"]);
    expect(permission!.description).toMatch(/Allow once/);
    expect(JSON.stringify(permission!.keys)).not.toContain("Right");
  });

  it("the 'Always allow' page is Cancelled (Right, Enter) back to the prompt — never confirmed", () => {
    expect(opencodeAlwaysConfirmActive(ALWAYS)).toBe(true);
    expect(opencodePermissionPromptActive(ALWAYS)).toBe(false);
    expect(always!.keys).toEqual(["Right", "Enter"]);
    expect(always!.pattern.test(ALWAYS)).toBe(true);
  });

  it("holds delivery and owns stdin while it is up", () => {
    for (const dialog of [permission!, always!]) {
      expect(dialog.blocksDelivery).toBe(true);
      expect(dialog.inputBlocked).toBe(true);
      expect(dialog.isActive).toBeTypeOf("function");
    }
  });

  it("the idle screen is not a dialog", () => {
    for (const pane of [READY, READY_AUTO]) {
      expect(opencodePermissionPromptActive(pane)).toBe(false);
      expect(opencodeAlwaysConfirmActive(pane)).toBe(false);
    }
  });

  it("a transcript that QUOTES the prompt — the idle prompt below it — is not answered", () => {
    const quoted = `${fixture(PROMPTS["external directory"])}\n${READY}`;
    expect(permission!.pattern.test(quoted)).toBe(true);                // the cheap pre-filter still sees the words…
    expect(opencodePermissionPromptActive(quoted)).toBe(false);          // …the structure says it is history
    expect(opencodeAlwaysConfirmActive(`${ALWAYS}\n${READY}`)).toBe(false);
  });

  it("prose is not a dialog: 'Permission required', 'confirm', or the options named in a sentence", () => {
    const prose = [
      "  ┃  The agent said: Permission required before it can proceed. Please confirm.",
      "  ┃  Allow once, Allow always or Reject? Confirm   Cancel — that is what the dialog offers.",
      "     ▣  Build · Mock Model",
    ].join("\n");
    expect(opencodePermissionPromptActive(`${prose}\n${READY}`)).toBe(false);
    expect(opencodePermissionPromptActive(prose)).toBe(false);          // even with no idle prompt: no header + option row structure
    expect(opencodeAlwaysConfirmActive(prose)).toBe(false);
  });

  // Each rule on its own: the others are held satisfied, so a loosened rule cannot hide behind a neighbour.
  const IDLE_TAIL = [
    "  ┃  Ask anything… \"Fix a TODO in the codebase\"",
    "  ┃  Build · Mock Model Mock",
    "  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
    "                                tab agents  ctrl+p commands",
  ].join("\n");
  const OPTIONS_ROW = "  ┃   Allow once   Allow always   Reject  ctrl+f fullscreen  ⇆ select  enter confirm";

  it("the option row alone, among the last lines, with the idle prompt right below it: history, not a dialog", () => {
    const pane = ["  ┃  △ Permission required", "  ┃    ← Access external directory /tmp", OPTIONS_ROW, IDLE_TAIL].join("\n");
    expect(opencodePermissionPromptActive(pane)).toBe(false);                   // the idle prompt is what says so
    expect(opencodePermissionPromptActive(pane.replace(IDLE_TAIL, "  ┃\n  ┃"))).toBe(true);   // the same without it: live
  });

  it("the option row without the header is not the prompt (a tool printing those words)", () => {
    const pane = ["  ⚙ some tool output", "  ┃  choose:", OPTIONS_ROW, "  ┃"].join("\n");
    expect(opencodePermissionPromptActive(pane)).toBe(false);
  });

  it("the header with the options only named in a sentence, at the bottom, is not the prompt", () => {
    const pane = ["  ┃  △ Permission required", "  ┃  the choices were: Allow once, Allow always, Reject", "  ┃  and then enter confirm"].join("\n");
    expect(opencodePermissionPromptActive(pane)).toBe(false);
  });

  it("the Always page with the idle prompt right below it is history too", () => {
    const pane = ["  ┃  △ Always allow", "  ┃  - /tmp/*", "  ┃   Confirm   Cancel   ⇆ select  enter confirm", IDLE_TAIL].join("\n");
    expect(opencodeAlwaysConfirmActive(pane)).toBe(false);
    expect(opencodeAlwaysConfirmActive(pane.replace(IDLE_TAIL, "  ┃\n  ┃"))).toBe(true);
  });

  it("the old viewport-wide /confirm/i dialog is gone", () => {
    const dialogs = new OpenCodeBackend(dir).getRuntimeDialogs();
    expect(dialogs).toHaveLength(2);
    for (const dialog of dialogs) expect(dialog.pattern.test("please confirm this change")).toBe(false);
  });

  it("a prompt scrolled out of the last lines is not live (the agent moved on)", () => {
    const moved = `${fixture(PROMPTS["external directory"])}\n${Array.from({ length: 10 }, (_, i) => `  ┃  agent output line ${i}`).join("\n")}`;
    expect(opencodePermissionPromptActive(moved)).toBe(false);
  });
});
