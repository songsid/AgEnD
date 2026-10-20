/**
 * #2233: FleetManager's side of a dashboard sign-in — who counts as a local admin session, and what is answered before
 * the controller runs (a CLI that is not installed, a removed backend). A FleetManager on a scratch directory, never
 * started; the controller's start is a spy.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { BACKEND_INSTALLATION_INFO } from "../src/instance-lifecycle.js";
import { t } from "../src/locale.js";
import { WebSessionStore, tokenEpoch } from "../src/web-session.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function makeFleet(installed: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "agend-web-login-")); dirs.push(dir);
  const fm = new FleetManager(dir) as any;
  fm.fleetConfig = { defaults: {}, instances: {} };
  const have = new Set(installed);
  vi.spyOn(fm, "isCliInstalled").mockImplementation((b: unknown) => have.has(b as string));
  const start = vi.fn(async (b: string) => `started:${b}`);
  fm.loginController = { start, webAccessToken: vi.fn(), isActiveFor: vi.fn(() => false), isActive: () => false };
  const sessions = new WebSessionStore({});
  fm.webSessions = sessions;
  const token = { value: "fleet-web-token" as string | null };
  Object.defineProperty(fm, "webToken", { get: () => token.value, configurable: true });   // the real one reads <dataDir>/web.token
  return { fm, start, sessions, token };
}
const chat = { adapter: {} as never, adapterId: "web", chatId: "web", userId: "web:x" };

describe("#2233 FleetManager: a dashboard sign-in", () => {
  it("a local admin session of the current token counts; read, guest, gateway, revoked and an older token do not", () => {
    const { fm, sessions, token } = makeFleet([]);
    const make = (tier: "admin" | "read" | "guest", surface: "local" | "gateway" = "local", epoch = tokenEpoch("fleet-web-token")) =>
      sessions.create({ tier, surface, label: "x", tokenEpoch: epoch, ...(surface === "gateway" ? { exposureId: "e".repeat(32) } : {}), ...(tier === "guest" ? { owner: { adapterId: "discord", userId: "g" } } : {}) }).record.handle;
    const admin = make("admin");
    expect(fm.isLocalAdminSession(admin)).toBe(true);
    expect(fm.isLocalAdminSession(make("read"))).toBe(false);
    expect(fm.isLocalAdminSession(make("guest"))).toBe(false);
    expect(fm.isLocalAdminSession(make("admin", "gateway"))).toBe(false);
    expect(fm.isLocalAdminSession(make("admin", "local", tokenEpoch("an-older-token")))).toBe(false);
    expect(fm.isLocalAdminSession("0".repeat(16))).toBe(false);
    sessions.revokeByHandle(admin);
    expect(fm.isLocalAdminSession(admin)).toBe(false);
    token.value = null;
    expect(fm.isLocalAdminSession(make("admin"))).toBe(false);
  });

  it("a CLI that is not installed gets its install command; a removed backend its replacement; an installed one reaches the controller", async () => {
    const { fm, start } = makeFleet(["claude"]);
    expect(await fm.startWebDashboardLogin("codex", chat, {})).toBe(t("login.web_dashboard_not_installed", "codex", BACKEND_INSTALLATION_INFO.codex!.install));
    expect(await fm.startWebDashboardLogin("gemini-cli", chat, {})).toMatch(/gemini-cli was removed/);
    expect(start).not.toHaveBeenCalled();
    vi.spyOn(fm, "isCliInstalled").mockReturnValue(true);
    expect(await fm.startWebDashboardLogin("claude", chat, { skipAuthCheck: true })).toBe("started:claude");
    expect(start).toHaveBeenCalledWith("claude", chat, { skipAuthCheck: true });
  });

  it("the registry's notice is said like a web sign-in's: in General, with the device and the session's short handle", () => {
    const { fm } = makeFleet([]);
    const notify = vi.spyOn(fm, "notifyFleetError").mockImplementation(() => {});
    (fm.webBackendLogins as any).deps.notice({ shown: "claude-code", label: "Chrome on Windows", handle: "0123456789abcdef" });
    expect(notify).toHaveBeenCalledWith(t("login.web_dashboard_notice", "claude-code", "Chrome on Windows", "01234567"));
    fm.webBackendLogins.dispose();
  });
});

describe("#2233 part 2: what the dashboard offers to sign in", () => {
  it("Settings' list: each backend's default login as the snapshot has it, then each credential profile an agent uses (once)", () => {
    const { fm } = makeFleet(["claude", "codex"]);
    fm.fleetConfig = { defaults: {}, instances: {
      a: { working_directory: "/w", backend: "claude-code", backend_options: { "claude-code": { credential_profile: "work" } } },
      b: { working_directory: "/w", backend: "claude-code", backend_options: { "claude-code": { credential_profile: "work" } } },
      c: { working_directory: "/w", backend: "codex" },
    } };
    vi.spyOn(fm, "backendAvailabilityRows").mockReturnValue([
      { backend: "claude-code", state: "usable" }, { backend: "codex", state: "not_signed_in" },
      { backend: "antigravity", state: "not_signed_in" }, { backend: "grok", state: "not_installed" }, { backend: "opencode", state: "usable" },
      { backend: "kiro-cli", state: "too_old" },
    ]);
    expect(fm.backendSignInTargets()).toEqual([
      { backend: "claude-code", state: "usable", signIn: true },
      { backend: "codex", state: "not_signed_in", signIn: true },
      { backend: "antigravity", state: "not_signed_in", signIn: false, hostCommand: "agy" },
      { backend: "grok", state: "not_installed", signIn: false, install: BACKEND_INSTALLATION_INFO.grok!.install },
      { backend: "opencode", state: "usable", signIn: false },
      { backend: "kiro-cli", state: "too_old", signIn: false, update: BACKEND_INSTALLATION_INFO["kiro-cli"]!.install },
      { backend: "claude-code", profile: "work", state: "not_signed_in", signIn: true },
    ]);
  });

  it("a paused-for-sign-in agent's item names its login when the dashboard can sign it in (a claude profile included), else nothing", () => {
    const { fm } = makeFleet([]);
    fm.fleetConfig = { defaults: {}, instances: {
      a: { working_directory: "/w", backend: "claude-code", backend_options: { "claude-code": { credential_profile: "work" } } },
      k: { working_directory: "/w", backend: "kiro-cli", backend_options: { "kiro-cli": { credential_profile: "team" } } },
      g: { working_directory: "/w", backend: "antigravity" },
      x: { working_directory: "/w", backend: "codex" },
    } };
    expect(["a", "k", "g", "x"].map(n => fm.signInFor(n))).toEqual([
      { backend: "claude-code", profile: "work" }, null, null, { backend: "codex" }]);
  });
});
