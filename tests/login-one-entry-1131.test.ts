/**
 * #1131: `/login` is the one entry point for "make this CLI work". Its picker
 * offers every backend the fleet could use — installed ones to sign in, the
 * rest to install (then sign in) — and `/install-cli` is gone, so there is one
 * command per bot in a guild's slash menu and nothing to mistype.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { BACKEND_INSTALLATION_INFO } from "../src/instance-lifecycle.js";
import { t } from "../src/locale.js";

function makeFleet(installed: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "agend-login-one-"));
  const notifyAlert = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "g1", threadId: "t1" });
  const sendText = vi.fn().mockResolvedValue({ messageId: "s1" });
  const adapter = { id: "telegram", type: "telegram", notifyAlert, sendText, editMessageRemoveButtons: vi.fn().mockResolvedValue(undefined) } as any;
  const fm = new FleetManager(dir) as any;
  fm.fleetConfig = { defaults: {}, channel: { group_id: "g1" }, instances: {} };
  fm.isFleetAdmin = vi.fn(() => true);
  const have = new Set(installed);
  vi.spyOn(fm, "probeInstalledBackends").mockReturnValue(have);
  vi.spyOn(fm, "isCliInstalled").mockImplementation((b: unknown) => have.has(b as string));
  const install = vi.spyOn(fm, "startInstallSession").mockImplementation(async (b: unknown) => `installing:${b}`);
  const signIn = vi.spyOn(fm, "launchSignIn").mockImplementation(async (b: unknown) => `signing-in:${b}`);
  return { fm, adapter, notifyAlert, sendText, install, signIn };
}
const chat = (a: any, threadId?: string) => ({ adapter: a, adapterId: "telegram", chatId: "g1", threadId, userId: "admin" });
const offered = (notifyAlert: any) => notifyAlert.mock.calls[0][1].choices as Array<{ id: string; label: string }>;

describe("one /login picker for installing and signing in", () => {
  it("offers every installable backend (not gemini-cli) plus the installed ones, each with what a click does", async () => {
    const { fm, adapter, notifyAlert } = makeFleet(["codex"]);
    await fm.promptLoginBackends(chat(adapter, "t1"));
    const choices = offered(notifyAlert);
    const byBackend = new Map(choices.map(c => [c.id.split(":").pop()!, c.label]));
    expect([...byBackend.keys()].sort()).toEqual(Object.keys(BACKEND_INSTALLATION_INFO).filter(b => b !== "gemini-cli").sort());
    expect(byBackend.get("codex")).toBe(`codex · ${t("login.status_installed")} · ${t("login.status_auth")}`);
    expect(byBackend.get("grok")).toBe(`grok · ${t("login.status_not_installed")} · ${t("login.status_install_then_auth")}`);
    // opencode can be installed, but has no sign-in flow.
    expect(byBackend.get("opencode")).toBe(`opencode · ${t("login.status_not_installed")} · ${t("login.status_install")}`);
  });

  it("keeps every callback id inside Telegram's 64-byte callback_data cap", async () => {
    const { fm, adapter, notifyAlert } = makeFleet([]);
    await fm.promptLoginBackends(chat(adapter, "t1"));
    for (const c of offered(notifyAlert)) expect(Buffer.byteLength(c.id, "utf8")).toBeLessThanOrEqual(64);
  });

  it("a click on a missing CLI installs it; on an installed one, signs in", async () => {
    const { fm, adapter, notifyAlert, install, signIn } = makeFleet(["codex"]);
    await fm.promptLoginBackends(chat(adapter, "t1"));
    const pick = (b: string) => offered(notifyAlert).find(c => c.id.endsWith(`:${b}`))!.id;
    await fm.handleLoginBackendSelect({ callbackData: pick("grok"), chatId: "g1", threadId: "t1", messageId: "m1", userId: "admin" }, "telegram", adapter);
    expect(install).toHaveBeenCalledWith("grok", expect.objectContaining({ chatId: "g1", threadId: "t1", userId: "admin" }));
    expect(signIn).not.toHaveBeenCalled();

    notifyAlert.mockClear();
    await fm.promptLoginBackends(chat(adapter, "t1"));
    await fm.handleLoginBackendSelect({ callbackData: pick("codex"), chatId: "g1", threadId: "t1", messageId: "m1", userId: "admin" }, "telegram", adapter);
    expect(signIn).toHaveBeenCalledWith("codex", expect.objectContaining({ chatId: "g1" }), {});
  });

  it("answers in a Telegram General topic (#682 canonical binding)", async () => {
    const { fm, adapter, notifyAlert, install } = makeFleet([]);
    notifyAlert.mockResolvedValue({ messageId: "m1", chatId: "g1", threadId: undefined });
    await fm.promptLoginBackends(chat(adapter, "1"));
    const pick = offered(notifyAlert).find(c => c.id.endsWith(":codex"))!;
    expect(await fm.handleLoginBackendSelect({ callbackData: pick.id, chatId: "g1", threadId: undefined, messageId: "m1", userId: "admin" }, "telegram", adapter)).toBe(true);
    expect(install).toHaveBeenCalledWith("codex", expect.anything());
  });

  it("typed /login <backend> follows the same rule: gemini-cli installs when named, though the picker hides it", async () => {
    const { fm, adapter, install } = makeFleet([]);
    expect(await fm.startLoginSession("gemini-cli", chat(adapter))).toBe("installing:gemini-cli");
    expect(install).toHaveBeenCalledWith("gemini-cli", expect.anything());
  });

  it("a button from an old /install-cli prompt gets the expired-prompt notice and is collapsed", async () => {
    const { fm, adapter } = makeFleet([]);
    for (const callbackData of [`install-select:${"a".repeat(32)}:codex`, `install-login:${"b".repeat(32)}:go`]) {
      const ack = vi.fn();
      await fm.receiveAdapterCallback({ callbackData, chatId: "g1", threadId: "t1", messageId: "old", ack }, "telegram", adapter, () => true);
      expect(ack).toHaveBeenCalledWith(t("buttons.stale_notice"));
    }
    expect(adapter.editMessageRemoveButtons).toHaveBeenCalledTimes(2);
    expect(fm.startInstallSession).not.toHaveBeenCalled();
  });

  it("a configured CLI the picker does not offer says how to install it by name", async () => {
    const { fm, adapter, sendText } = makeFleet([]);
    fm.fleetConfig.instances = { g: { working_directory: "/tmp/g", backend: "gemini-cli" } };
    vi.spyOn(fm, "configuredBackendInstanceNames").mockReturnValue(["g"]);
    vi.spyOn(fm, "backendNameOf").mockReturnValue("gemini-cli");
    await fm.promptLoginBackends(chat(adapter, "t1"));
    expect(String(sendText.mock.calls[0]![1])).toContain(t("login.install_by_name", "gemini-cli"));
  });

  it("every /login records which way it went (flow telemetry)", async () => {
    const { fm, adapter } = makeFleet(["codex"]);
    const insert = vi.fn();
    fm.eventLog = { insert };
    await fm.startLoginSession("codex", chat(adapter));
    await fm.startLoginSession("codex", chat(adapter), { skipAuthCheck: true }); // a confirmation click: not a new /login
    await fm.startLoginSession("grok", chat(adapter));
    await fm.startLoginSession("opencode", chat(adapter));
    expect(insert.mock.calls.map(c => [c[1], c[2].backend, c[2].flow])).toEqual([
      ["login_entry", "codex", "login"],
      ["login_entry", "grok", "install_then_login"],
      ["login_entry", "opencode", "install_only"],
    ]);
    expect(insert.mock.calls[0]![2].requester).toBe("admin");
  });
});
