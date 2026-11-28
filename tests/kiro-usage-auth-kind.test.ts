import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { fetchKiroUsage, kiroAuthKind } from "../src/usage/providers.js";
import { quotaBand } from "../src/hub/member/quota.js";
import { agentUsage } from "../src/usage/agent-output.js";
import { setLocale } from "../src/locale.js";
import { usageText } from "../src/usage/i18n.js";

/** Synthetic auth shapes describe sign-in, never an entitlement. */
const IDC = { access_token: "x", region: "us-east-1", start_url: "https://identity.example.test/start" };
const SOCIAL = { access_token: "x", provider: "google", profile_arn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/fixture" };
const future = () => new Date(Date.now() + 3_600_000).toISOString();
const past = () => new Date(Date.now() - 3_600_000).toISOString();

describe("kiroAuthKind", () => {
  it("treats an Identity Center token (start_url) as an authentication flow", () => {
    expect(kiroAuthKind(IDC)).toBe("identity-center");
  });

  it("treats a social login without inferring a free tier", () => {
    expect(kiroAuthKind(SOCIAL)).toBe("social");
  });

  it("does not mistake a blank start_url for a subscription", () => {
    expect(kiroAuthKind({ access_token: "x", start_url: "   " })).toBe("social");
    expect(kiroAuthKind({ access_token: "x" })).toBe("social");
  });
});

describe("fetchKiroUsage (no network on these paths)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kiro-usage-"));
    process.env.KIRO_CLI_HOME = home;
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected vendor call in offline control"); }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.KIRO_CLI_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  function seed(tokens: Record<string, object>) {
    const db = new Database(join(home, "data.sqlite3"));
    db.exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
    const ins = db.prepare("INSERT INTO auth_kv (key, value) VALUES (?, ?)");
    for (const [k, v] of Object.entries(tokens)) ins.run(k, JSON.stringify(v));
    db.close();
  }

  it("keeps an unbound IAM profile explicitly unmeasurable without guessing the plan", async () => {
    seed({ "codewhisperer:odic:token": { ...IDC, expires_at: future() } });
    const r = await fetchKiroUsage();
    expect(r.status).toBe("ok");
    expect(r.plan).toBe("Kiro");
    expect(r.unlimited).toBeUndefined();
    expect(r.hint).toMatch(/not measurable.*profile/i);
    expect(r.hintI18n).toEqual({ key: "usage.hint.kiro_profile_unknown" });
    expect(r.hint).not.toMatch(/no credit/i);
    expect(r.metrics).toEqual([]);   // unknown remaining balance, no invented percentage
    const payload = { fetchedAt: new Date().toISOString(), providers: [{ id: "kiro", name: "Kiro", ...r }] };
    expect(agentUsage(payload).providers[0]).toMatchObject({ status: r.hint, windows: [] });
    expect(agentUsage(payload, true)).toBe(payload);
    expect(quotaBand(payload.providers[0])).toEqual({ band: "unknown" });
    expect(quotaBand(payload.providers[0], true)).toEqual({ band: "exhausted" });
    try {
      setLocale("zh-TW");
      expect(usageText(r.hint!, r.hintI18n)).toBe("無法測量：目前選取的用量設定檔無法取得或格式無效。");
    } finally { setLocale("en"); }
    expect(r.error).toBeUndefined(); // and never a red error
  });

  it("an expired token is a friendly sign-in prompt, not an error", async () => {
    seed({ "kirocli:social:token": { ...SOCIAL, expires_at: past() } });
    const r = await fetchKiroUsage();
    // Was `no-credentials` — but fetchAllUsage FILTERS that status out, so the
    // whole Kiro row disappeared instead of showing this prompt. `ok` + hint
    // keeps it on screen; still never a red error.
    expect(r.status).toBe("ok");
    expect(r.error).toBeUndefined();
    expect(r.hint).toMatch(/token refreshing/i);
  });

  it("does not mark Builder ID usage as unlimited", async () => {
    seed({ "kirocli:social:token": { ...SOCIAL, expires_at: future() } });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      usageBreakdownList: [{ displayName: "Credits", currentUsage: 1, usageLimit: 10 }],
    }), { status: 200 })) as unknown as typeof fetch;
    try {
      const r = await fetchKiroUsage();
      expect(r.unlimited).not.toBe(true);
      expect(r.metrics.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("stays visible, signed out, when kiro-cli is installed with no login", async () => {
    seed({});
    const r = await fetchKiroUsage();
    // Installed but signed out is actionable state, not absence of the CLI.
    expect(r.status).toBe("ok");
    expect(r.hint).toMatch(/signed out/i);
  });

  it("disappears only when kiro-cli is not installed at all", async () => {
    process.env.KIRO_CLI_HOME = "/tmp/agend-kiro-not-installed-at-all";
    const r = await fetchKiroUsage();
    expect(r.status).toBe("no-credentials"); // the one filtered-out status
    expect(r.hint).toMatch(/Log in/i);
  });

  it("does not choose another login merely because it expires later", async () => {
    // Switching login type leaves the old token behind; picking by key order
    // would report the wrong (expired) account.
    seed({
      "kirocli:social:token": { ...SOCIAL, expires_at: past() },      // stale
      "codewhisperer:odic:token": { ...IDC, expires_at: future() },   // live
    });
    const r = await fetchKiroUsage();
    expect(r.plan).toBe("Kiro");
    expect(r.hint).toMatch(/not measurable.*account/i);
    expect(fetch).not.toHaveBeenCalled();
    expect(r.status).toBe("ok");
  });
});
