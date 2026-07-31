import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { fetchKiroUsage, kiroAuthKind } from "../src/usage/providers.js";

/**
 * Token shapes below are the REAL ones observed in a kiro-cli auth store:
 * an IAM Identity Center (Q Developer Pro) token carries `start_url`, a
 * free-tier social login carries `provider` + `profile_arn`.
 */
const IDC = {
  access_token: "x", region: "us-east-1",
  start_url: "https://d-906636beb8.awsapps.com/start/",
};
const SOCIAL = {
  access_token: "x", provider: "google",
  profile_arn: "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK",
};
const future = () => new Date(Date.now() + 3_600_000).toISOString();
const past = () => new Date(Date.now() - 3_600_000).toISOString();

describe("kiroAuthKind", () => {
  it("treats an Identity Center token (start_url) as Q Developer Pro", () => {
    expect(kiroAuthKind(IDC)).toBe("q-developer-pro");
  });

  it("treats a social login as Builder ID / free tier", () => {
    expect(kiroAuthKind(SOCIAL)).toBe("builder-id");
  });

  it("does not mistake a blank start_url for a subscription", () => {
    expect(kiroAuthKind({ access_token: "x", start_url: "   " })).toBe("builder-id");
    expect(kiroAuthKind({ access_token: "x" })).toBe("builder-id");
  });
});

describe("fetchKiroUsage (no network on these paths)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kiro-usage-"));
    process.env.KIRO_CLI_HOME = home;
  });
  afterEach(() => {
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

  it("reports Q Developer Pro as a subscription without calling the usage API", async () => {
    seed({ "codewhisperer:odic:token": { ...IDC, expires_at: future() } });
    const r = await fetchKiroUsage();
    expect(r.status).toBe("ok");
    expect(r.plan).toBe("Q Developer Pro");
    expect(r.hint).toMatch(/subscription/i);
    expect(r.metrics).toEqual([]);   // nothing metered → no credit bars
    expect(r.error).toBeUndefined(); // and never a red error
  });

  it("an expired token is a friendly sign-in prompt, not an error", async () => {
    seed({ "kirocli:social:token": { ...SOCIAL, expires_at: past() } });
    const r = await fetchKiroUsage();
    expect(r.status).toBe("no-credentials"); // was "error" → ugly red panel
    expect(r.error).toBeUndefined();
    expect(r.hint).toMatch(/kiro-cli/);
  });

  it("says so when there are no credentials at all", async () => {
    seed({});
    const r = await fetchKiroUsage();
    expect(r.status).toBe("no-credentials");
    expect(r.hint).toMatch(/Log in/i);
  });

  it("prefers the live token when a stale one from another login type remains", async () => {
    // Switching login type leaves the old token behind; picking by key order
    // would report the wrong (expired) account.
    seed({
      "kirocli:social:token": { ...SOCIAL, expires_at: past() },      // stale
      "codewhisperer:odic:token": { ...IDC, expires_at: future() },   // live
    });
    const r = await fetchKiroUsage();
    expect(r.plan).toBe("Q Developer Pro");
    expect(r.status).toBe("ok");
  });
});
