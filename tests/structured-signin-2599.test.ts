import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { StructuredSignIn, structuredSignInPrompt, structuredSignInSupported,
  type StructuredBackend, type SignInAction, type StructuredSignInTransport } from "../src/structured-signin.js";
import { LoginWindowLock } from "../src/login-window-lock.js";
import { LOGIN_FLOWS } from "../src/login-flows.js";
import { dashboardSignInSupported } from "../src/web-backend-login.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const KIRO = fixture("kiro-2.33.0-audit/login-menu-2.33.0.pane.txt");
const CLAUDE = fixture("claude-2.1.308-onboarding-login-method.pane.txt");
const CODEX = "Follow these steps to sign in with ChatGPT using device code authorization:\nhttps://auth.openai.com/codex/device\nTEST-CODE\n";
const CLAUDE_CODE = "Browser didn't open? Use the url below to sign in\nhttps://claude.com/cai/oauth/authorize?state=test\nPaste code here if prompted >\n";
const all: StructuredSignIn[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(async () => { await Promise.all(all.splice(0).map(session => session.cancel())); vi.clearAllTimers(); vi.useRealTimers(); });

function defer<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function harness(backend: StructuredBackend = "codex", lock = new LoginWindowLock()) {
  const owner = {}, other = {};
  const state = { pane: backend === "codex" ? CODEX : backend === "kiro-cli" ? KIRO : CLAUDE_CODE, current: true, alive: true, elapsed: 0 };
  const transport = {
    start: vi.fn<StructuredSignInTransport["start"]>().mockResolvedValue(undefined),
    capture: vi.fn(async () => state.pane),
    status: vi.fn(async () => ({ alive: state.alive, exitCode: 0 })),
    write: vi.fn<StructuredSignInTransport["write"]>().mockResolvedValue(undefined),
    close: vi.fn<StructuredSignInTransport["close"]>().mockResolvedValue(undefined),
  };
  const checkAuth = vi.fn(async () => "invalid" as "valid" | "invalid" | "unknown");
  const changed = vi.fn();
  const session = new StructuredSignIn(backend, owner, { transport, lock, current: () => state.current, now: () => Date.now() + state.elapsed, checkAuth, changed });
  all.push(session);
  const view = () => session.view(owner);
  const act = (action: SignInAction, revision = view().revision) => session.action(owner, session.id, revision, action);
  return { owner, other, state, transport, checkAuth, changed, session, lock, view, act };
}

describe("#2599 structured login: parser", () => {
  it("supports only the three approved dedicated login commands; agy is still remote-unsupported", () => {
    expect(["kiro-cli", "claude-code", "codex"].map(structuredSignInSupported)).toEqual([true, true, true]);
    for (const backend of ["antigravity", "grok", "codex login; sh", "CLAUDE", "toString"]) expect(structuredSignInSupported(backend)).toBe(false);
    expect(() => harness("antigravity" as StructuredBackend)).toThrow("structured_signin_unsupported");
    expect(LOGIN_FLOWS.antigravity.remoteLogin).toBe("unsupported");
    expect(dashboardSignInSupported("antigravity")).toBe(false);
  });
  it("uses the captured Kiro menu, its current highlight, and the captured Claude account menu", () => {
    expect(structuredSignInPrompt("kiro-cli", KIRO)).toEqual({ phase: "method", choices: ["builder_id", "google", "github", "organization"], selected: 0 });
    expect(structuredSignInPrompt("claude-code", CLAUDE)).toEqual({ phase: "method", choices: ["subscription", "console", "third_party"], selected: 0 });
    expect(structuredSignInPrompt("kiro-cli", KIRO.replace("❯ Use with Builder ID", "  Use with Builder ID").replace("  Use with GitHub", "❯ Use with GitHub"))).toMatchObject({ selected: 2 });
  });
  it.each([KIRO.replace("Use with GitHub", "Other provider"), KIRO + "\nAgent task >\n", KIRO.replace("❯", " "), KIRO.replace("  Use with Google", "❯ Use with Google")])("unknown or non-current menu is never guessed", pane => {
    expect(structuredSignInPrompt("kiro-cli", pane)).toMatchObject({ phase: "failed", reason: "unsupported_prompt" });
  });
  it("Codex exposes only its device URL paired with a code; lookalikes are not links", () => {
    expect(structuredSignInPrompt("codex", CODEX)).toEqual({ phase: "authorization", url: "https://auth.openai.com/codex/device", code: "TEST-CODE" });
    for (const pane of [CODEX.replace("TEST-CODE", ""), CODEX.replace("auth.openai.com/", "auth.openai.com.evil.test/"), "https://127.0.0.1:1455/auth/callback\nTEST-CODE"]) {
      expect(structuredSignInPrompt("codex", pane)).toEqual({ phase: "waiting" });
    }
  });
  it("Claude's code field requires the live bottom prompt; no URL is linked on an untrusted host", () => {
    expect(structuredSignInPrompt("claude-code", CLAUDE_CODE)).toEqual({ phase: "code", url: "https://claude.com/cai/oauth/authorize?state=test" });
    expect(structuredSignInPrompt("claude-code", CLAUDE_CODE + "Now do my task\n").phase).not.toBe("code");
    expect(structuredSignInPrompt("claude-code", CLAUDE_CODE.replace("claude.com/", "claude.com.evil.test/"))).toEqual({ phase: "code", url: null });
  });
  it.each(["\x1b[2J", "x".repeat(65537), "\0"])("rejects raw control/oversized output without returning it", pane => {
    expect(structuredSignInPrompt("codex", pane)).toEqual({ phase: "failed", reason: "unsupported_prompt" });
  });
});

describe("#2599 structured login: commands and named controls", () => {
  it.each(["kiro-cli", "claude-code", "codex"] as const)("%s starts only its fixed login argv, never an agent or shell", async backend => {
    const h = harness(backend);
    await h.session.start();
    expect(h.transport.start).toHaveBeenCalledOnce();
    const launch = h.transport.start.mock.calls[0]![0];
    expect(launch.argv.join(" ")).toBe(LOGIN_FLOWS[backend]!.command);
    expect(launch.logoutArgv).toBeUndefined();
    await h.session.start();
    expect(h.transport.start).toHaveBeenCalledOnce();
  });
  it("valid credentials are reused without starting or logging out; explicit Kiro re-login has fixed logout argv", async () => {
    const h = harness("kiro-cli"); h.checkAuth.mockResolvedValue("valid");
    await h.session.start();
    expect(h.view().phase).toBe("done");
    expect(h.transport.start).not.toHaveBeenCalled();
    const r = harness("kiro-cli"); r.checkAuth.mockResolvedValue("valid");
    await r.session.start(true);
    expect(r.transport.start.mock.calls[0]![0]).toEqual({ argv: ["kiro-cli", "login"], logoutArgv: ["kiro-cli", "logout"] });
  });
  it("maps Kiro's named choice from the observed cursor; one submit cannot be replayed at the new revision", async () => {
    const h = harness("kiro-cli"); await h.session.start();
    const revision = h.view().revision;
    expect(await h.act({ kind: "method", choice: "github" }, revision)).toBe("accepted");
    expect(h.transport.write).toHaveBeenCalledWith("\x1b[B\x1b[B\r", expect.any(AbortSignal));
    expect(h.view().canAct).toBe(false);
    expect(await h.act({ kind: "method", choice: "github" }, revision)).toBe("stale");
    expect(await h.act({ kind: "method", choice: "github" })).toBe("stale");
    expect(h.transport.write).toHaveBeenCalledOnce();
  });
  it.each([false, true])("our own highlight redraw cannot re-arm an answered method (blank capture: %s)", async blank => {
    const h = harness("kiro-cli"); await h.session.start();
    expect(await h.act({ kind: "method", choice: "github" })).toBe("accepted");
    if (blank) { h.state.pane = ""; await h.session.poll(); }
    h.state.pane = KIRO.replace("❯ Use with Builder ID", "  Use with Builder ID").replace("  Use with GitHub", "❯ Use with GitHub");
    await h.session.poll();
    expect(h.view().canAct).toBe(false);
    expect(await h.act({ kind: "method", choice: "github" })).toBe("stale");
    expect(h.transport.write).toHaveBeenCalledOnce();
    h.state.pane = "? Enter Start URL ›"; await h.session.poll();
    expect(h.view().canAct).toBe(true);
    expect(await h.act({ kind: "start_url", value: "https://org.awsapps.com/start" })).toBe("accepted");
    expect(h.transport.write).toHaveBeenCalledTimes(2);
  });
  it("Claude offers only subscription/console, not the enterprise task/configuration route", async () => {
    const h = harness("claude-code"); h.state.pane = CLAUDE; await h.session.start();
    expect(h.view().choices).toEqual(["subscription", "console"]);
    expect(await h.act({ kind: "method", choice: "third_party" })).toBe("invalid");
    expect(await h.act({ kind: "method", choice: "console" })).toBe("accepted");
    expect(h.transport.write.mock.calls[0]![0]).toBe("\x1b[B\r");
  });
  it("organization fields submit only to their matching prompt, replacing safe prefilled values", async () => {
    const h = harness("kiro-cli"); h.state.pane = "? Enter Start URL › https://old.awsapps.com/start"; await h.session.start();
    expect(await h.act({ kind: "region", value: "us-east-1" })).toBe("invalid");
    for (const value of ["http://org.awsapps.com/start", "https://awsapps.com.evil.test/start", "https://user@org.awsapps.com/start", "https://org.awsapps.com/start?x=y", "https://org.awsapps.com/other"]) {
      expect(await h.act({ kind: "start_url", value })).toBe("invalid");
    }
    expect(await h.act({ kind: "start_url", value: "https://org.awsapps.com/start" })).toBe("accepted");
    expect(h.transport.write.mock.calls[0]![0]).toBe("\x15https://org.awsapps.com/start\r");
    h.state.pane = "? Enter Region › us-east-1"; await h.session.poll();
    expect(await h.act({ kind: "region", value: "us-east-1;whoami" })).toBe("invalid");
    expect(await h.act({ kind: "region", value: "eu-west-2" })).toBe("accepted");
    expect(h.transport.write.mock.calls[1]![0]).toBe("\x15eu-west-2\r");
  });
  it("code input is literal, bounded, one-use and never included in audit events/views", async () => {
    const h = harness("claude-code"); await h.session.start();
    for (const value of ["", "abc\ndef", "abc\x1bdef", "$(touch/tmp/pwn)", "x".repeat(4097)]) expect(await h.act({ kind: "code", value })).toBe("invalid");
    const secret = ["synthetic", "authorization", "code"].join("_") + "#synthetic_state";
    expect(await h.act({ kind: "code", value: secret })).toBe("accepted");
    expect(h.transport.write.mock.calls[0]![0]).toBe("\x15" + secret + "\r");
    expect(JSON.stringify(h.changed.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(h.view())).not.toContain(secret);
    expect(JSON.stringify(h.session.view(h.other))).not.toContain("https:");
    expect(await h.act({ kind: "code", value: secret })).toBe("stale");
  });
  it("malformed runtime actions are refused without terminating a valid attempt", async () => {
    const h = harness("claude-code"); await h.session.start();
    for (const action of [null, {}, { kind: "shell", value: "whoami" }, { kind: "code", value: 123 }]) expect(await h.act(action as SignInAction)).toBe("invalid");
    expect(h.transport.write).not.toHaveBeenCalled(); expect(h.view().phase).toBe("code");
  });
});

describe("#2599 structured login: authority, episode and cleanup", () => {
  it("shares the existing login/install reservation, held before the async auth probe", async () => {
    const h = harness(); const probe = defer<"invalid">(); h.checkAuth.mockReturnValue(probe.promise);
    const starting = h.session.start();
    expect(h.lock.isHeld).toBe(true);
    const second = harness("claude-code", h.lock); await second.session.start();
    expect(second.transport.start).not.toHaveBeenCalled();
    expect(h.lock.current?.backend).toBe("codex");
    probe.resolve("invalid"); await starting;
  });
  it("wrong owner, attempt id and revision never write", async () => {
    const h = harness("claude-code"); await h.session.start(); const v = h.view();
    expect(await h.session.action(h.other, v.id, v.revision, { kind: "code", value: "test" })).toBe("stale");
    expect(await h.session.action(h.owner, "other-attempt", v.revision, { kind: "code", value: "test" })).toBe("stale");
    expect(await h.act({ kind: "code", value: "test" }, v.revision - 1)).toBe("stale");
    expect(h.transport.write).not.toHaveBeenCalled();
  });
  it("a fresh pre-input capture changing the prompt invalidates the cached action", async () => {
    const h = harness("claude-code"); await h.session.start(); const revision = h.view().revision;
    h.state.pane = CLAUDE;
    expect(await h.act({ kind: "code", value: "test" }, revision)).toBe("stale");
    expect(h.transport.write).not.toHaveBeenCalled();
    expect(h.view().phase).toBe("method");
  });
  it("authority revoked during capture or initial auth probe cannot send input or start a child", async () => {
    const h = harness("claude-code"); await h.session.start();
    const capture = defer<string>(); h.transport.capture.mockReturnValueOnce(capture.promise);
    const sending = h.act({ kind: "code", value: "test" }); await Promise.resolve();
    h.state.current = false; capture.resolve(CLAUDE_CODE);
    expect(await sending).toBe("stale");
    expect(h.transport.write).not.toHaveBeenCalled(); expect(h.view().reason).toBe("revoked");
    const before = harness(); const probe = defer<"invalid">(); before.checkAuth.mockReturnValue(probe.promise);
    const starting = before.session.start(); before.state.current = false; probe.resolve("invalid"); await starting;
    expect(before.transport.start).not.toHaveBeenCalled(); expect(before.lock.isHeld).toBe(false);
  });
  it("successful text or exit0 alone is not completion; a separate probe must pass", async () => {
    for (const text of ["Successfully logged in", "Goodbye"]) {
      const h = harness(); await h.session.start(); h.state.pane = text; h.state.alive = false;
      await h.session.poll();
      expect(h.view()).toMatchObject({ phase: "failed", reason: "auth_unconfirmed" });
    }
  });
  it("completion waits for confirmed teardown and does not release the shared slot early", async () => {
    const h = harness(); await h.session.start(); h.checkAuth.mockResolvedValue("valid"); h.state.pane = "Successfully logged in";
    const close = defer(); h.transport.close.mockReturnValue(close.promise);
    const ending = h.session.poll();
    await vi.waitFor(() => expect(h.transport.close).toHaveBeenCalled());
    expect(h.view().phase).not.toBe("done"); expect(h.lock.isHeld).toBe(true);
    close.resolve(); await ending;
    expect(h.view()).toMatchObject({ phase: "done" }); expect(h.lock.isHeld).toBe(false);
    expect(JSON.stringify(h.view())).not.toContain("TEST-CODE");
  });
  it("cleanup failure retains the writer reservation and reports only a safe reason", async () => {
    const h = harness(); await h.session.start(); h.transport.close.mockRejectedValue(new Error("secret vendor detail"));
    await h.session.cancel();
    expect(h.view()).toMatchObject({ phase: "failed", reason: "cleanup_failed" });
    expect(h.lock.isHeld).toBe(true); expect(JSON.stringify(h.changed.mock.calls)).not.toContain("secret vendor");
  });
  it("cancellation racing late transport startup joins cleanup, hides hints, and never publishes a new run", async () => {
    const h = harness(); const created = defer(); h.transport.start.mockReturnValue(created.promise);
    const starting = h.session.start(); await vi.waitFor(() => expect(h.transport.start).toHaveBeenCalled());
    const cancelled = h.session.cancel(); expect(h.transport.start.mock.calls[0]![1].aborted).toBe(true);
    expect(h.lock.isHeld).toBe(true); created.resolve(); await Promise.all([starting, cancelled]);
    expect(h.transport.close).toHaveBeenCalledOnce(); expect(h.transport.capture).not.toHaveBeenCalled();
    expect(h.view()).toMatchObject({ phase: "failed", reason: "cancelled" }); expect(h.lock.isHeld).toBe(false);
  });
  it("even a synchronous transport start failure closes potentially created resources", async () => {
    const h = harness(); h.transport.start.mockImplementation(() => { throw new Error("start detail"); });
    await h.session.start();
    expect(h.transport.close).toHaveBeenCalledOnce(); expect(h.view().reason).toBe("transport_failed");
  });
  it("a cancel from the starting observer is rechecked before invoking the native transport", async () => {
    const h = harness();
    h.changed.mockImplementation(event => { if (event.phase === "starting") void h.session.cancel(); });
    await h.session.start();
    expect(h.transport.start).not.toHaveBeenCalled();
    expect(h.view().reason).toBe("cancelled"); expect(h.lock.isHeld).toBe(false);
  });
  it("ambiguous input failure ends the attempt and is never retried", async () => {
    const h = harness("claude-code"); await h.session.start(); h.transport.write.mockRejectedValue(new Error("ambiguous"));
    expect(await h.act({ kind: "code", value: "synthetic_code" })).toBe("ended");
    expect(await h.act({ kind: "code", value: "synthetic_code" })).toBe("ended");
    expect(h.transport.write).toHaveBeenCalledOnce(); expect(h.view().reason).toBe("transport_failed");
  });
  it("bounds queued actions while an input capture is held", async () => {
    const h = harness("claude-code"); await h.session.start();
    const capture = defer<string>(); h.transport.capture.mockReturnValueOnce(capture.promise);
    const actions = Array.from({ length: 8 }, () => h.act({ kind: "code", value: "synthetic_code" }));
    expect(await h.act({ kind: "code", value: "synthetic_code" })).toBe("busy");
    capture.resolve(CLAUDE_CODE); await Promise.all(actions);
    expect(h.transport.write).toHaveBeenCalledOnce();
  });
  it("rechecks the elapsed deadline after a held capture, before any input, even if its timer has not run", async () => {
    const h = harness("claude-code"); await h.session.start();
    const capture = defer<string>(); h.transport.capture.mockReturnValueOnce(capture.promise);
    const sending = h.act({ kind: "code", value: "synthetic_code" }); await Promise.resolve();
    h.state.elapsed += 10 * 60_000; capture.resolve(CLAUDE_CODE);
    expect(await sending).toBe("stale"); expect(h.transport.write).not.toHaveBeenCalled();
    expect(h.view().reason).toBe("expired"); expect(h.view().url).toBeUndefined();
  });
  it("unknown onboarding fails closed after a bounded redraw grace; auth expiry gets a safe retry reason", async () => {
    const h = harness(); h.state.pane = "Choose an unknown onboarding preference"; await h.session.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.view().reason).toBe("unsupported_prompt"); expect(h.transport.write).not.toHaveBeenCalled();
    const code = harness("claude-code"); await code.session.start(); code.state.pane = "Invalid code. Please make sure the full code was copied.";
    await code.session.poll(); expect(code.view().reason).toBe("provider_rejected");
  });
  it("the absolute TTL expires without extending on polling or exposing provider hints", async () => {
    const h = harness(); await h.session.start();
    expect(h.view().code).toBe("TEST-CODE");
    expect(h.session.view(h.other).code).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.view()).toMatchObject({ phase: "failed", reason: "expired" });
    expect(h.view().code).toBeUndefined(); expect(h.lock.isHeld).toBe(false);
    expect(JSON.stringify(h.changed.mock.calls)).not.toContain("TEST-CODE");
  });
});
