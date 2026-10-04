import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeBackend } from "../../src/backend/opencode.js";
import {
  cachedOpencodeAutoSupport,
  helpAdvertisesAutoFlag,
  looksLikeOpencodeHelp,
  opencodeAlwaysConfirmActive,
  opencodeAlwaysRequest,
  opencodePermissionRequest,
  opencodePermissionPromptActive,
  probeOpencodeAutoSupport,
  resetOpencodeAutoSupportCacheForTests,
} from "../../src/backend/opencode-permission.js";

/**
 * Keeping OpenCode's permission prompts away: the launch switch (`--auto` when the binary lists it, nothing
 * otherwise) and, behind it, structural runtime dialogs answering "Allow once". The panes and
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
  "external directory (1.16.2)": "opencode-1.16.2-permission-external-directory.pane.txt",
  "external directory (1.14.51)": "opencode-1.14.51-permission-external-directory.pane.txt",
  "read .env": "opencode-1.18.34-permission-read-env.pane.txt",
  "edit (with a diff)": "opencode-1.18.34-permission-edit.pane.txt",
  "shell command": "opencode-1.18.34-permission-bash.pane.txt",
  "webfetch": "opencode-1.18.34-permission-webfetch.pane.txt",
  "back from Cancel on the Always page": "opencode-1.18.34-permission-after-always-cancel.pane.txt",
};
const ALWAYS = fixture("opencode-1.18.34-permission-always-confirm.pane.txt");
const ALWAYS_60 = fixture("opencode-1.18.34-permission-always-confirm-60col.pane.txt");
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

  it("a TRUNCATED OpenCode help is not believed about what it lacks (banner only, empty Options, --help alone)", () => {
    const banner = "opencode [project]           start opencode tui                                          [default]";
    const cuts = [
      banner,
      `${banner}\n\nOptions:\n`,
      `${banner}\n\nOptions:\n  -h, --help          show help      [boolean]\n`,
      HELP["1.16.2"].slice(0, HELP["1.16.2"].indexOf("--agent")),             // cut inside the TUI options, before the end
      HELP["1.18.34"].slice(0, HELP["1.18.34"].indexOf("--prompt")),
    ];
    for (const cut of cuts) expect(looksLikeOpencodeHelp(cut), cut.slice(-60)).toBe(false);
  });

  it.each(["help", "version", "model", "continue", "session", "prompt", "agent"])("a help missing its --%s row is not believed either (each required flag on its own)", flag => {
    const rows = HELP["1.18.34"].split("\n");
    const without = rows.filter(row => !new RegExp(`^\\s*(?:-[A-Za-z0-9],\\s*)?--${flag}(?:[ =<,]|$)`).test(row)).join("\n");
    expect(without).not.toBe(HELP["1.18.34"]);
    expect(looksLikeOpencodeHelp(without)).toBe(false);
  });

  it("the banner and the Options heading are each required on their own", () => {
    expect(looksLikeOpencodeHelp(HELP["1.18.34"].replace(/^.*opencode \[project\].*$/m, ""))).toBe(false);
    expect(looksLikeOpencodeHelp(HELP["1.18.34"].replace(/^Options:\s*$/m, ""))).toBe(false);
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

  it("a truncated help is 'unknown' — and asked again after the minute, not remembered as 'no'", async () => {
    vi.useFakeTimers();
    const cut = HELP["1.18.34"].slice(0, HELP["1.18.34"].indexOf("--model"));
    const run = vi.fn().mockResolvedValueOnce(cut).mockResolvedValue(HELP["1.18.34"]);
    expect(await probeOpencodeAutoSupport("/b/cut", run)).toBe("unknown");
    expect(cachedOpencodeAutoSupport("/b/cut")).toBe("unknown");
    vi.advanceTimersByTime(61_000);
    expect(await probeOpencodeAutoSupport("/b/cut", run)).toBe("yes");
    expect(run).toHaveBeenCalledTimes(2);
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

  it("a binary that lists --auto gets --auto", async () => {
    const b = backend("yes"); await settled();
    const cmd = b.buildCommand(config());
    expect(cmd).toMatch(/ --auto(?: |$)/);
    expect(cmd).not.toContain("OPENCODE_PERMISSION");
  });

  it("one that does not list it gets NOTHING: no unknown flag (OpenCode exits 1) and no env that would override the user's deny", async () => {
    const b = backend("no"); await settled();
    const cmd = b.buildCommand(config());
    expect(cmd).not.toContain("--auto");
    expect(cmd).not.toContain("OPENCODE_PERMISSION");
    expect(cmd.startsWith("OPENCODE")).toBe(false);
  });

  it("an unprobed or unreadable binary gets nothing either — never a flag it may not know", () => {
    const cmd = backend().buildCommand(config());
    expect(cmd).not.toContain("--auto");
    expect(cmd).not.toContain("OPENCODE_PERMISSION");
  });

  it("skipPermissions: false turns --auto off", async () => {
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
    expect(b.buildCommand(config())).not.toContain("--auto");                     // before the probe: conservative
    await b.prepareLaunch();
    expect(cachedOpencodeAutoSupport(script)).toBe("yes");
    expect(b.buildCommand(config())).toContain(" --auto");
  });

  it("prepareLaunch never throws, whatever the binary does", async () => {
    const b = new OpenCodeBackend(dir);
    (b as unknown as { binaryPath: string }).binaryPath = join(dir, "does-not-exist");
    await expect(b.prepareLaunch()).resolves.toBeUndefined();
    expect(b.buildCommand(config())).not.toContain("--auto");
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

  it("the 'Always allow' page is Cancelled with Escape — OpenCode's own cancel, whichever button is highlighted — never confirmed", () => {
    expect(opencodeAlwaysConfirmActive(ALWAYS)).toBe(true);
    expect(opencodePermissionPromptActive(ALWAYS)).toBe(false);
    expect(always!.keys).toEqual(["Escape"]);
    // Right+Enter is Cancel only while Confirm is highlighted: from Cancel, Right wraps to Confirm and Enter grants "always".
    expect(always!.keys).not.toContain("Right");
    expect(always!.keys).not.toContain("Enter");
    expect(always!.pattern.test(ALWAYS)).toBe(true);
  });

  it("the 'Always allow' page at 60 columns (the hints wrapped under a blank line, without ctrl+f) is found too", () => {
    expect(opencodeAlwaysConfirmActive(ALWAYS_60)).toBe(true);
    expect(opencodePermissionPromptActive(ALWAYS_60)).toBe(false);
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

  describe("the pieces must be ONE dialog: whole header line, option row with its hints, in order, with no composer under it", () => {
    const BAR = "  ┃";
    const dialog = (header: string, row: string) => [`${BAR}`, `${BAR}  ${header}`, `${BAR}    ← Access external directory /tmp/x`, `${BAR}`, `${BAR}   ${row}`, `${BAR}                              • OpenCode 1.18.34`].join("\n");
    const ROW = "Allow once   Allow always   Reject  ctrl+f fullscreen  ⇆ select  enter confirm";

    it("the well-formed block is live (the baseline every negative below differs from by one thing)", () => {
      expect(opencodePermissionPromptActive(dialog("△ Permission required", ROW))).toBe(true);
      expect(opencodeAlwaysConfirmActive(dialog("△ Always allow", "Confirm   Cancel                                      ⇆ select  enter confirm"))).toBe(true);
    });

    it("a header that is part of a sentence is not the header", () => {
      expect(opencodePermissionPromptActive(dialog("The documentation says △ Permission required is shown first", ROW))).toBe(false);
      expect(opencodePermissionPromptActive(dialog("△ Permission required before it can proceed", ROW))).toBe(false);
      expect(opencodeAlwaysConfirmActive(dialog("△ Always allow means what it says", "Confirm   Cancel   ⇆ select  enter confirm"))).toBe(false);
    });

    it("…including one that ENDS with the header's own words", () => {
      expect(opencodePermissionPromptActive(dialog("The documentation says △ Permission required", ROW))).toBe(false);
      expect(opencodeAlwaysConfirmActive(dialog("The docs call this △ Always allow", "Confirm   Cancel   ⇆ select  enter confirm"))).toBe(false);
    });

    it("hints that are only half of the dialog's (just 'enter confirm') are not its hints", () => {
      expect(opencodePermissionPromptActive(dialog("△ Permission required", "Allow once   Allow always   Reject  (then enter confirm)"))).toBe(false);
    });

    it("more than a few lines of anything under the option row means the agent moved on", () => {
      const moved = `${dialog("△ Permission required", ROW)}\n${Array.from({ length: 6 }, (_, i) => `${BAR}  agent output ${i}`).join("\n")}`;
      expect(opencodePermissionPromptActive(moved)).toBe(false);
    });

    it("an option row that is part of a sentence is not the option row", () => {
      expect(opencodePermissionPromptActive(dialog("△ Permission required", `The choices are ${ROW}`))).toBe(false);
      expect(opencodeAlwaysConfirmActive(dialog("△ Always allow", "The buttons are Confirm   Cancel   ⇆ select  enter confirm"))).toBe(false);
    });

    it("an option row without the dialog's own hints is not one (a draft that only names the buttons)", () => {
      expect(opencodePermissionPromptActive(dialog("△ Permission required", "Allow once   Allow always   Reject"))).toBe(false);
      expect(opencodeAlwaysConfirmActive(dialog("△ Always allow", "Confirm   Cancel"))).toBe(false);
    });

    it("the options BEFORE the header are not a dialog", () => {
      const reversed = [`${BAR}   ${ROW}`, `${BAR}  △ Permission required`, `${BAR}    ← Access external directory /tmp/x`, `${BAR}`, `${BAR}`].join("\n");
      expect(opencodePermissionPromptActive(reversed)).toBe(false);
    });

    it("a header and a row that are not in one bordered block are not a dialog", () => {
      const parts = ["  △ Permission required", "  the agent kept talking", `  ${ROW}`, "  ┃"].join("\n");
      expect(opencodePermissionPromptActive(parts)).toBe(false);
      const gap = [`${BAR}  △ Permission required`, "  plain text with no bar", `${BAR}   ${ROW}`].join("\n");
      expect(opencodePermissionPromptActive(gap)).toBe(false);
    });

    it("a multi-line DRAFT in the composer that quotes the dialog is not one, idle or busy", () => {
      const idle = `${dialog("△ Permission required", ROW)}\n${READY}`;
      expect(opencodePermissionPromptActive(idle)).toBe(false);
      const busy = [
        `${BAR}  △ Permission required`, `${BAR}    ← Access external directory /tmp/x`, `${BAR}   ${ROW}`,
        `${BAR}  Build · Mock Model Mock`, "  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀", "                         esc interrupt",
      ].join("\n");
      expect(opencodePermissionPromptActive(busy)).toBe(false);
      expect(opencodePermissionPromptActive(busy.replace("esc interrupt", "esc again to interrupt"))).toBe(false);
    });
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

describe("which request the prompt is showing", () => {
  const PROMPT = fixture(PROMPTS["external directory"]);

  it("is the bordered block from the header to the option row, verbatim", () => {
    const identity = opencodePermissionRequest(PROMPT)!;
    expect(identity).toContain("△ Permission required");
    expect(identity).toContain("Access external directory /tmp/ocprobe-ext");
    expect(identity).toContain("Allow once   Allow always   Reject");
    expect(identity).not.toContain("OpenCode 1.18.34");           // the status line under it is not part of the request
  });

  it("does not move with what ticks outside it (a status line, a spinner above), and moves with ANY change inside", () => {
    const base = opencodePermissionRequest(PROMPT);
    expect(opencodePermissionRequest(PROMPT.replace("• OpenCode 1.18.34", "⠋ 12s • OpenCode 1.18.34"))).toBe(base);
    expect(opencodePermissionRequest(`  ⠙ thinking 3s\n${PROMPT}`)).toBe(base);
    for (const [a, b] of [["/tmp/ocprobe-ext/*", "/tmp/ocprobe-ext-2/*"], ["Patterns", "Patterns "], ["ocprobe-ext", "ocprobe-ex1"]] as const) {
      expect(opencodePermissionRequest(PROMPT.replaceAll(a, b)), `${a} → ${b}`).not.toBe(base);
    }
  });

  it("is null when no prompt is live, and for the Always page it names the page's own block", () => {
    expect(opencodePermissionRequest(READY)).toBeNull();
    expect(opencodePermissionRequest(ALWAYS)).toBeNull();
    expect(opencodeAlwaysRequest(PROMPT)).toBeNull();
    expect(opencodeAlwaysRequest(ALWAYS)).toContain("Always allow");
  });

  it("both dialogs carry it", () => {
    for (const dialog of new OpenCodeBackend(dir).getRuntimeDialogs()) expect(dialog.requestIdentity).toBeTypeOf("function");
  });
});
