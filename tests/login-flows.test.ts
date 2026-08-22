import { afterEach, describe, expect, it } from "vitest";
import {
  checkAuthStatus,
  extractLoginHint,
  LOGIN_BACKEND_ALIASES,
  LOGIN_FLOWS,
  setAuthCheckRunnerForTests,
} from "../src/login-flows.js";

afterEach(() => setAuthCheckRunnerForTests(null));

describe("LOGIN_FLOWS table", () => {
  it("covers every remotely loggable backend with a command and success pattern", () => {
    expect(Object.keys(LOGIN_FLOWS).sort()).toEqual(
      ["antigravity", "claude-code", "codex", "grok", "kiro-cli"],
    );
    for (const flow of Object.values(LOGIN_FLOWS)) {
      expect(flow.command.length).toBeGreaterThan(0);
      expect(flow.successPattern).toBeInstanceOf(RegExp);
      expect(flow.timeoutMs).toBe(10 * 60 * 1000);
    }
  });

  it("routes every alias to a defined flow", () => {
    for (const target of Object.values(LOGIN_BACKEND_ALIASES)) {
      expect(LOGIN_FLOWS[target]).toBeDefined();
    }
    expect(LOGIN_BACKEND_ALIASES["claude"]).toBe("claude-code");
    expect(LOGIN_BACKEND_ALIASES["kiro"]).toBe("kiro-cli");
    expect(LOGIN_BACKEND_ALIASES["agy"]).toBe("antigravity");
  });

  it("kiro menu matches the CLI's binary-verified selector", () => {
    const menu = LOGIN_FLOWS["kiro-cli"].menu!;
    expect(menu.promptPattern.test("? Select login method ›")).toBe(true);
    expect(menu.options).toEqual(["Builder ID", "Google", "GitHub", "Your Organization"]);
  });

  it("success patterns match the strings the CLIs actually print", () => {
    expect(LOGIN_FLOWS["codex"].successPattern.test("Successfully logged in.")).toBe(true);
    expect(LOGIN_FLOWS["grok"].successPattern.test("Login successful!")).toBe(true);
    expect(LOGIN_FLOWS["kiro-cli"].successPattern.test("Logged in successfully")).toBe(true);
    expect(LOGIN_FLOWS["claude-code"].successPattern.test("Login successful. Press Enter")).toBe(true);
    expect(LOGIN_FLOWS["antigravity"].successPattern.test("  ? for shortcuts")).toBe(true);
  });
});

describe("extractLoginHint", () => {
  it("captures a long joined OAuth URL and strips trailing punctuation", () => {
    const pane = "Open this link:\nhttps://example.com/oauth/authorize?client_id=abc&scope=x%20y&state=zzz.\nWaiting…";
    const hint = extractLoginHint(pane, {});
    expect(hint.url).toBe("https://example.com/oauth/authorize?client_id=abc&scope=x%20y&state=zzz");
    expect(hint.code).toBeNull();
  });

  it("captures the kiro one-time code next to the URL", () => {
    const pane = "Confirm the following code in the browser\nCode: ABCD-1234\nhttps://device.sso.example/start";
    const hint = extractLoginHint(pane, LOGIN_FLOWS["kiro-cli"]);
    expect(hint.url).toBe("https://device.sso.example/start");
    expect(hint.code).toBe("ABCD-1234");
  });

  it("returns nulls before the CLI has printed anything useful", () => {
    expect(extractLoginHint("starting login flow…", {})).toEqual({ url: null, code: null });
  });

  it("parses the live-captured codex 0.149 device-auth screen", () => {
    // Verbatim capture-pane -J output from `codex login --device-auth`.
    const pane = "\nWelcome to Codex [v0.149.0]\nOpenAI's command-line coding agent\n\n"
      + "Follow these steps to sign in with ChatGPT using device code authorization:\n\n"
      + "1. Open this link in your browser and sign in to your account\n"
      + "   https://auth.openai.com/codex/device\n\n"
      + "2. Enter this one-time code (expires in 15 minutes)\n"
      + "   677A-4BGJ6\n\n"
      + "Continue only if you started this login in Codex.";
    expect(extractLoginHint(pane, LOGIN_FLOWS["codex"])).toEqual({
      url: "https://auth.openai.com/codex/device",
      code: "677A-4BGJ6",
    });
  });

  it("captures grok's prefixed code form", () => {
    const hint = extractLoginHint("Visit https://accounts.x.ai/sign-in then enter code: QRST-1234", LOGIN_FLOWS["grok"]);
    expect(hint.code).toBe("QRST-1234");
  });
});

describe("checkAuthStatus", () => {
  it("every flow declares a token-free auth check", () => {
    for (const flow of Object.values(LOGIN_FLOWS)) {
      expect(flow.authCheck?.argv.length).toBeGreaterThan(0);
    }
    // claude exits 0 whether or not it is logged in (live-verified), so its
    // check must also require the loggedIn marker in the output.
    expect(LOGIN_FLOWS["claude-code"].authCheck?.validPattern).toBeDefined();
  });

  it("maps exit 0 to valid and non-zero to invalid", async () => {
    setAuthCheckRunnerForTests(async () => ({ code: 0, output: "Logged in" }));
    expect(await checkAuthStatus(LOGIN_FLOWS["codex"].authCheck!)).toBe("valid");
    setAuthCheckRunnerForTests(async () => ({ code: 1, output: "Not logged in" }));
    expect(await checkAuthStatus(LOGIN_FLOWS["codex"].authCheck!)).toBe("invalid");
  });

  it("claude: exit 0 with loggedIn:false is invalid, loggedIn:true is valid", async () => {
    setAuthCheckRunnerForTests(async () => ({ code: 0, output: '{ "loggedIn": false }' }));
    expect(await checkAuthStatus(LOGIN_FLOWS["claude-code"].authCheck!)).toBe("invalid");
    setAuthCheckRunnerForTests(async () => ({ code: 0, output: '{ "loggedIn": true, "email": "x@y" }' }));
    expect(await checkAuthStatus(LOGIN_FLOWS["claude-code"].authCheck!)).toBe("valid");
  });

  it("timeout kills and runner failures are unknown, not logged-out", async () => {
    setAuthCheckRunnerForTests(async () => ({ code: null, output: "" }));
    expect(await checkAuthStatus(LOGIN_FLOWS["grok"].authCheck!)).toBe("unknown");
    setAuthCheckRunnerForTests(async () => { throw new Error("spawn boom"); });
    expect(await checkAuthStatus(LOGIN_FLOWS["grok"].authCheck!)).toBe("unknown");
  });
});
