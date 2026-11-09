import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTOSTART_DELAY_SECONDS, autostartAction, autostartTaskName, buildAutostartTaskXml, createAutostartService, encodeTaskXml, currentWindowsUser } from "../src/runtime-autostart.js";

/**
 * the sign-in task. It must be the current user's own (no system task, no service), need no administrator rights, and run a short command that
 * starts the background Runtime, not the Runtime itself. What is asked of Windows is one XML text and one schtasks command line; both are pinned here.
 */
const roots: string[] = [], USER = "PC\\me", TASK = (label: string, user = USER): string => autostartTaskName(label, user);
const scratch = (): string => { const root = mkdtempSync(join(tmpdir(), "agend-runtime-autostart-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) { if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe test path"); rmSync(root, { recursive: true, force: true }); } });
// Paths are built with join() so the same checks hold wherever the tests run; on Windows they are the usual C:\\Users\\... forms.
const BASE = join(sep, "Users", "me", "AppData", "Local", "agend-runtime");
const CLI = join(BASE, "1.2.3+abcd1234", "dist", "runtime-cli.js"), NODE = join(sep, "Program Files", "nodejs", "node.exe"), PROFILE = join(sep, "Users", "me", ".agend-runtime");
const SHIM = join(BASE, "bin", "agend-runtime.cmd"), ZIP_CLI = join(sep, "zip", "dist", "runtime-cli.js");

describe("what the task runs", () => {
  it("runs the installer's shim when there is one, so signing in after an update starts the update", () => {
    expect(autostartAction({ cliPath: CLI, execPath: NODE, profile: PROFILE, shimExists: path => path === SHIM })).toEqual({ command: SHIM, args: `start --profile "${PROFILE}"` });
  });
  it("runs this node and this script when the layout is not a managed install (a ZIP)", () => {
    expect(autostartAction({ cliPath: ZIP_CLI, execPath: NODE, profile: PROFILE, shimExists: () => false })).toEqual({ command: NODE, args: `"${ZIP_CLI}" start --profile "${PROFILE}"` });
  });
  it("only ever runs `start` for one profile folder: no pairing code, token, credential or server address", () => {
    const action = autostartAction({ cliPath: CLI, execPath: NODE, profile: PROFILE, shimExists: path => path === SHIM });
    expect(action.args).toMatch(/^start --profile "[^"]+"$/); expect(action.args).not.toMatch(/--server|--enroll|--code|credential|token/i);
  });
  it("refuses a path a scheduled task or a batch file would misread, with a way out, instead of writing a task that does something else", () => {
    for (const bad of ["/a&b/p", "/100%/p", "/a^b", "/x\"y", "/a|b", "/a\nb"]) expect(() => autostartAction({ cliPath: CLI, execPath: NODE, profile: bad, shimExists: path => path === SHIM }), bad).toThrow(/cannot carry safely/);
  });
  it("gives the program path itself (the shim, or this node) the same character check as every other path", () => {
    for (const bad of ["/100%/agend", "/a&b/agend", "/x^y", "/a\"b", "/a|b", "/a<b", "/a\nb"]) {
      const shim = join(bad, "bin", "agend-runtime.cmd"), cli = join(bad, "1.2.3+abcd1234", "dist", "runtime-cli.js");
      expect(() => autostartAction({ cliPath: cli, execPath: NODE, profile: PROFILE, shimExists: path => path === shim }), `shim ${bad}`).toThrow(/cannot carry safely/);
      expect(() => autostartAction({ cliPath: ZIP_CLI, execPath: join(bad, "node.exe"), profile: PROFILE, shimExists: () => false }), `node ${bad}`).toThrow(/cannot carry safely/);
    }
    expect(autostartAction({ cliPath: CLI, execPath: join(sep, "Program Files", "my node", "node.exe"), profile: PROFILE, shimExists: () => false }).command).toContain("my node");   // spaces are fine
  });
  it("names the task after the profile, and only a safe name", () => {
    expect(TASK("default")).toMatch(/^AgEnD Runtime - [a-f0-9]{8} - default$/); expect(TASK("fleet.example.test-8445")).toMatch(/^AgEnD Runtime - [a-f0-9]{8} - fleet\.example\.test-8445$/);
    // Task names are unique on the computer: another Windows account gets another name for the same profile, the same account (any case) always the same one.
    expect(TASK("default", "PC\\alice")).not.toBe(TASK("default", "PC\\bob")); expect(TASK("default", "PC\\Alice")).toBe(TASK("default", "pc\\alice"));
    expect(() => autostartTaskName("default", "")).toThrow(/user name/);
    for (const bad of ["", "a b", "a\\b", "a/b", "..\\x", "x".repeat(200)]) expect(() => autostartTaskName(bad), bad).toThrow();
  });
});

describe("the task definition", () => {
  const xml = buildAutostartTaskXml({ label: "default", user: "PC\\me", action: { command: SHIM, args: `start --profile "${PROFILE}"` }, workingDirectory: join(BASE, "1.2.3+abcd1234", "dist") });
  it("is triggered by this user's sign-in, a little after it so the network can come up", () => {
    expect(xml).toContain("<LogonTrigger>"); expect(xml).toContain("<UserId>PC\\me</UserId>"); expect(xml).toContain(`<Delay>PT${AUTOSTART_DELAY_SECONDS}S</Delay>`);
    expect(xml.match(/<Triggers>[\s\S]*<\/Triggers>/)![0].match(/<\w+Trigger>/g)).toEqual(["<LogonTrigger>"]);       // no boot, no idle, no schedule
  });
  it("runs as that user with an ordinary token and least privilege: no administrator rights, no password, not SYSTEM, not a service", () => {
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>"); expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).not.toMatch(/HighestAvailable|S4U|<Password|SYSTEM|LocalService|NetworkService|ServiceAccount|Hidden>true|RunLevel>Highest/i);
  });
  it("does not stack a second copy, does not stop for the battery, and gives the short `start` command a limit", () => {
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"); expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(xml).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>"); expect(xml).toContain("<ExecutionTimeLimit>PT10M</ExecutionTimeLimit>");
  });
  it("holds the command and its arguments as escaped text and says who made it and how to remove it", () => {
    expect(xml).toContain(`<Command>${SHIM}</Command>`); expect(xml).toContain(`<Arguments>start --profile &quot;${PROFILE}&quot;</Arguments>`);
    expect(xml).toMatch(/agend-runtime autostart disable/);
    const tricky = buildAutostartTaskXml({ label: "x", user: "PC\\me", action: { command: "a&b<c>", args: `"'` } });
    expect(tricky).toContain("<Command>a&amp;b&lt;c&gt;</Command>"); expect(tricky).toContain("<Arguments>&quot;&apos;</Arguments>");
  });
  it("refuses a missing or multi-line user name, and is written as UTF-16 with a byte-order mark as schtasks wants it", () => {
    expect(() => buildAutostartTaskXml({ label: "x", user: "", action: { command: "c", args: "" } })).toThrow(); expect(() => buildAutostartTaskXml({ label: "x", user: "a\nb", action: { command: "c", args: "" } })).toThrow();
    const bytes = encodeTaskXml("<a/>"); expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]); expect(bytes.subarray(2).toString("utf16le")).toBe("<a/>");
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>')).toBe(true);
  });
  it("takes the user as DOMAIN\\name, or the plain name without a domain", () => {
    expect(currentWindowsUser({ USERNAME: "me", USERDOMAIN: "PC" })).toBe("PC\\me"); expect(currentWindowsUser({ USERNAME: "me" })).toBe("me");
  });
});

describe("creating and removing the task (schtasks.exe, arguments only)", () => {
  /** `results` is keyed by the schtasks verb; "/List" is the task list (`/Query /FO CSV /NH`) and `listing` is its stdout, which is how a missing task is told from a broken schtasks. */
  function service(results: Record<string, number> = {}, listing = "") {
    const calls: string[][] = []; let written: Buffer | undefined, xmlPath: string | undefined;
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "/Create") { xmlPath = args[args.indexOf("/XML") + 1]; written = readFileSync(xmlPath); }
      const key = args[0] === "/Query" && args.includes("/FO") ? "/List" : args[0], code = results[key] ?? (key === "/List" ? 0 : 0);
      return { code, output: code ? "ERROR: Access is denied." : "", ...(key === "/List" && code === 0 ? { raw: listing } : {}) };
    });
    return { calls, run, svc: createAutostartService({ run, user: () => "PC\\me", shimExists: path => path === SHIM }), get written() { return written; }, get xmlPath() { return xmlPath; } };
  }
  it("creates the task for the profile from an XML file, replaces an old one (/F), and needs no elevation switch", async () => {
    const work = scratch(), s = service();
    await s.svc.enable({ label: "default", profile: PROFILE, cliPath: CLI, execPath: NODE, workFolder: work });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toEqual(["/Create", "/TN", TASK("default"), "/XML", join(work, "autostart-task.xml"), "/F"]);
    const flat = s.calls.flat().join(" "); expect(flat).not.toMatch(/\/RU|\/RP|\/RL|\/IT|SYSTEM|HIGHEST|\/SC|\/TR/i);          // no other user, no password, no run level: the XML says who and how
    expect(s.written!.subarray(2).toString("utf16le")).toContain(`<Command>${SHIM}</Command>`);
    expect(s.written!.subarray(2).toString("utf16le")).toContain(`<WorkingDirectory>${PROFILE}</WorkingDirectory>`);   // a folder that stays, not a version folder an update leaves behind
    expect(existsSync(join(work, "autostart-task.xml"))).toBe(false);                                 // the definition is removed again
  });
  it("registers, queries and removes the task of one account and one profile on its own name: another account's, or another profile's, is never touched", async () => {
    const work = scratch(), seen: Array<[string, string]> = [];
    const mk = (user: string) => createAutostartService({ user: () => user, shimExists: () => false, run: async args => { seen.push([user, args.slice(0, 3).join(" ")]); return { code: 0, output: "", raw: "" }; } });
    const alice = mk("PC\\alice"), bob = mk("PC\\bob");
    await alice.enable({ label: "default", profile: PROFILE, cliPath: CLI, execPath: NODE, workFolder: work }); await bob.enable({ label: "default", profile: PROFILE, cliPath: CLI, execPath: NODE, workFolder: work });
    await alice.disable("default");
    const names = (user: string): string[] => seen.filter(row => row[0] === user).map(row => row[1].split(" ").slice(2).join(" ")).filter(Boolean);
    expect(new Set([...names("PC\\alice"), ...names("PC\\bob")]).size).toBe(2);                           // two names, one per account
    expect(names("PC\\alice").every(name => name === TASK("default", "PC\\alice"))).toBe(true); expect(names("PC\\bob").every(name => name === TASK("default", "PC\\bob"))).toBe(true);
    // two profiles of one account: independent names for enable and disable
    seen.length = 0; await alice.enable({ label: "a-1", profile: PROFILE, cliPath: CLI, execPath: NODE, workFolder: work }); await alice.disable("a-2");
    expect(new Set(names("PC\\alice")).size).toBe(2);
  });
  it("explains a refusal in plain words with the next step, and still removes the definition", async () => {
    const work = scratch(), s = service({ "/Create": 1 });
    await expect(s.svc.enable({ label: "default", profile: PROFILE, cliPath: CLI, execPath: NODE, workFolder: work })).rejects.toThrow(new RegExp(`did not create the sign-in task "${TASK("default")}".*Access is denied.*autostart enable.*agend-runtime start`));
    expect(existsSync(join(work, "autostart-task.xml"))).toBe(false);
  });
  it("removes the task by its name only when there is one, and reports whether it did", async () => {
    const s = service();
    expect(await s.svc.disable("default")).toBe(true); expect(s.calls).toEqual([["/Query", "/TN", TASK("default")], ["/Delete", "/TN", TASK("default"), "/F"]]);
    const none = service({ "/Query": 1 }, "\"\\Microsoft\\Windows\\X\",\"N/A\",\"Ready\"\r\n");
    expect(await none.svc.disable("default")).toBe(false);
    expect(none.calls).toEqual([["/Query", "/TN", TASK("default")], ["/Query", "/FO", "CSV", "/NH"]]);   // asked again, with the list, before concluding there is nothing to remove
    expect(none.calls.flat()).not.toContain("/Delete");
    const stuck = service({ "/Delete": 1 }); await expect(stuck.svc.disable("default")).rejects.toThrow(/did not remove the sign-in task.*Task Scheduler/);
  });
  it("asks whether a task exists with its name and nothing else", async () => {
    const s = service(); expect(await s.svc.exists("a-1")).toBe(true); expect(s.calls).toEqual([["/Query", "/TN", TASK("a-1")]]);
    expect(await service({ "/Query": 1 }, "").svc.exists("a-1")).toBe(false);
  });
  it("does not take a broken schtasks for \"no task\": when even the task list fails, it says so (and disable removes nothing and says so)", async () => {
    const broken = service({ "/Query": 1, "/List": 1 });
    await expect(broken.svc.exists("default")).rejects.toThrow(new RegExp(`did not say whether the sign-in task "${TASK("default")}" exists.*Task Scheduler`, "s"));
    await expect(broken.svc.disable("default")).rejects.toThrow(/did not say whether/); expect(broken.calls.flat()).not.toContain("/Delete");
  });
  it("finds the task in the list however Windows words its errors and whatever case the name has, and then removes it", async () => {
    const listed = service({ "/Query": 1 }, `"\\${TASK("default").toUpperCase()}","2026/11/9 上午 12:00:00","就緒"\r\n`+"\"\\Other\",\"N/A\",\"Ready\"\r\n");
    expect(await listed.svc.disable("default")).toBe(true); expect(listed.calls.at(-1)).toEqual(["/Delete", "/TN", TASK("default"), "/F"]);
    // a task whose name only CONTAINS ours is not ours
    const other = service({ "/Query": 1 }, `"\\${TASK("default")}-2","N/A","Ready"\r\n`); expect(await other.svc.exists("default")).toBe(false);
  });
});
