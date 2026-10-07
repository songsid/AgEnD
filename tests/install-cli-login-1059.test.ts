/**
 * #1059: a CLI installed with /install-cli was reported as verified, then was
 * missing from `/login`. The installer is verified on a fresh login shell
 * (it may only have added its directory to a profile PATH), while `/login`
 * lists what `which` finds on the fleet process's own PATH — and so do new
 * instances when they resolve their binary. After a verified install the
 * binary's directory now joins the fleet's PATH.
 *
 * The login shell and `which` here are real: a throwaway HOME whose
 * .bash_profile adds a directory the fleet process does not have, with a
 * fake `grok` in it, and a fleet PATH narrowed to the system directories so
 * the machine's own CLIs cannot answer for it.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeSessions: Array<{ events: any }> = [];
vi.mock("../src/login-manager.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/login-manager.js")>();
  class FakeLoginSession {
    state = "starting";
    constructor(_flow: any, _tmux: any, public events: any) { fakeSessions.push({ events }); }
    async start() {}
    async cancel() {}
  }
  return { ...real, LoginSession: FakeLoginSession };
});
vi.mock("../src/tmux-manager.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/tmux-manager.js")>();
  class FakeTmux { constructor() {} static async ensureSession() {} }
  return { ...real, TmuxManager: Object.assign(FakeTmux, { ensureSession: async () => {} }) };
});

import { FleetManager } from "../src/fleet-manager.js";
import { checkBinaryInstalled } from "../src/instance-lifecycle.js";
import { resolveBinary } from "../src/backend/types.js";

let root: string;
let home: string;
let profileBin: string;
const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-1059-"));
  home = join(root, "home");
  profileBin = join(home, ".grok", "bin");
  mkdirSync(profileBin, { recursive: true });
  writeFileSync(join(profileBin, "grok"), "#!/bin/sh\necho grok 0.0.0\n");
  chmodSync(join(profileBin, "grok"), 0o755);
  // What an installer does: add its directory to the profile, not to us.
  writeFileSync(join(home, ".bash_profile"), `export PATH="$HOME/.grok/bin:$PATH"\n`);
  process.env.HOME = home;
  process.env.PATH = "/usr/bin:/bin";
  fakeSessions.length = 0;
});
afterEach(() => {
  process.env.PATH = saved.PATH;
  process.env.HOME = saved.HOME;
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fleet() {
  const fm = new FleetManager(join(root, "data"));
  fm.fleetConfig = { defaults: {}, instances: {} } as any;
  const notifyAlert = vi.fn(async (chatId: string, _alert?: unknown) => ({ messageId: "p1", chatId }));
  const sendText = vi.fn().mockResolvedValue({ messageId: "m1" });
  const adapter = { id: "tg", type: "telegram", notifyAlert, sendText, editMessageRemoveButtons: vi.fn() } as any;
  vi.spyOn(fm, "isFleetAdmin").mockReturnValue(true);
  const chat = { adapter, adapterId: "tg", chatId: "chat", threadId: undefined, userId: "admin" };
  const loginChoices = async () => {
    notifyAlert.mockClear();
    await fm.promptLoginBackends(chat);
    return notifyAlert.mock.calls.flatMap(c => ((c[1] as any)?.choices ?? []).map((ch: any) => String(ch.label)));
  };
  return { fm, chat, sendText, loginChoices };
}

describe("a CLI /login installed is offered for sign-in right away (#1059)", () => {
  it("the reported state: only a login shell can see the new binary", () => {
    expect(checkBinaryInstalled("grok")).toBe(false);
  });

  it("after a verified install, /login lists it, `which` finds it and a spawn resolves it", async () => {
    const { fm, chat, sendText, loginChoices } = fleet();
    const grokLabel = async () => (await loginChoices()).find(l => l.startsWith("grok"))!;
    expect(await grokLabel()).toContain("Not installed");
    const signIn = vi.spyOn(fm as any, "launchSignIn").mockResolvedValue("signing in");
    await fm.startInstallSession("grok", chat);
    await fakeSessions[0]!.events.onDone({ ok: true, detail: "clean exit" });
    // The durable completion notice, then the sign-in it leads to (#1131).
    expect(sendText.mock.calls.map(c => String(c[1]))).toEqual([expect.stringMatching(/grok.*verified/), "signing in"]);
    expect(signIn).toHaveBeenCalledWith("grok", expect.anything(), {});
    expect(process.env.PATH!.split(":")[0]).toBe(profileBin);
    expect(checkBinaryInstalled("grok")).toBe(true);
    expect(resolveBinary("grok")).toBe(join(profileBin, "grok"));
    expect(await grokLabel()).toMatch(/Installed.*Auth/);
  });

  it("does not add a directory twice", async () => {
    const { fm, chat } = fleet();
    process.env.PATH = `${profileBin}:/usr/bin:/bin`;
    await fm.startInstallSession("grok", chat).catch(() => {}); // already installed now
    const located = await (fm as any).locateBinaryOnLoginShell("grok");
    (fm as any).adoptBinaryDirectory(located, "grok");
    expect(process.env.PATH).toBe(`${profileBin}:/usr/bin:/bin`);
  });

  it("an installer that left no binary behind is reported and adds nothing", async () => {
    const { fm, chat, sendText, loginChoices } = fleet();
    rmSync(join(profileBin, "grok"));
    await fm.startInstallSession("grok", chat);
    await fakeSessions[0]!.events.onDone({ ok: true, detail: "clean exit" });
    expect(String(sendText.mock.calls.at(-1)![1])).toContain("PATH");
    expect(process.env.PATH).toBe("/usr/bin:/bin");
    expect((await loginChoices()).find(l => l.startsWith("grok"))).toContain("Not installed");
  });
});

describe("every way an install ends is reported, with the next step (#1059)", () => {
  it("a failed installer says so and how to retry", async () => {
    const { fm, chat, sendText } = fleet();
    await fm.startInstallSession("grok", chat);
    await fakeSessions[0]!.events.onDone({ ok: false, detail: "exit 1" });
    const text = String(sendText.mock.calls.at(-1)![1]);
    expect(text).toContain("grok");
    expect(text).toContain("exit 1");
    expect(text).toContain("/login grok");
  });
});

describe("locateBinaryOnLoginShell accepts only a real executable", () => {
  it("an alias or a function the profile defines is not a binary", async () => {
    const { fm } = fleet();
    rmSync(join(profileBin, "grok"));
    writeFileSync(join(home, ".bash_profile"), "alias grok='echo hi'\ngrok2() { :; }\n");
    expect(await (fm as any).locateBinaryOnLoginShell("grok")).toBeNull();
    expect(await (fm as any).locateBinaryOnLoginShell("grok2")).toBeNull();
  });

  it("a file without the execute bit is not a binary", async () => {
    const { fm } = fleet();
    chmodSync(join(profileBin, "grok"), 0o644);
    expect(await (fm as any).locateBinaryOnLoginShell("grok")).toBeNull();
  });
});
