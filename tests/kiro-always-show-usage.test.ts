import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { fetchKiroUsage } from "../src/usage/providers.js";

/**
 * Kiro vanished from /usage entirely — not an error row, no row at all.
 *
 * Root cause: fetchAllUsage drops every provider whose status is
 * `no-credentials`, and readKiroToken returned that for BOTH "kiro-cli is not
 * installed" and "installed but no login we recognise". It also only looked at
 * two hardcoded auth_kv keys, so a login stored under any other key read as
 * signed-out. Only the not-installed case should disappear.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.KIRO_CLI_HOME;
});

function kiroHome(rows: Array<[string, unknown]> = []): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-kiro-usage-"));
  dirs.push(dir);
  const db = new Database(join(dir, "data.sqlite3"));
  db.exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
  const insert = db.prepare("INSERT INTO auth_kv (key, value) VALUES (?, ?)");
  for (const [key, value] of rows) insert.run(key, JSON.stringify(value));
  db.close();
  process.env.KIRO_CLI_HOME = dir;
  return dir;
}

describe("Kiro stays on the panel unless kiro-cli is absent", () => {
  it("hides only when there is no kiro-cli data directory", async () => {
    process.env.KIRO_CLI_HOME = join(tmpdir(), "agend-kiro-does-not-exist");
    const r = await fetchKiroUsage();
    // no-credentials is the one status fetchAllUsage filters out.
    expect(r.status).toBe("no-credentials");
  });

  it("shows a signed-out row when installed with no recognisable login", async () => {
    kiroHome();
    const r = await fetchKiroUsage();
    expect(r.status).toBe("ok"); // survives the filter
    expect(r.plan).toBe("Kiro");
    expect(r.hint).toContain("Signed out");
    expect(r.metrics).toEqual([]);
  });

  it("shows a rolled-over row for an expired token instead of disappearing", async () => {
    kiroHome([["kirocli:social:token", {
      access_token: "tok", expires_at: new Date(Date.now() - 60_000).toISOString(),
    }]]);
    const r = await fetchKiroUsage();
    expect(r.status).toBe("ok");
    expect(r.hint).toContain("kiro-cli");
    expect(r.metrics).toEqual([]);
  });

  it("finds a login stored under an unlisted auth_kv key", async () => {
    // The keys are per login type; hardcoding two of them made any other login
    // read as signed-out. Any `%:token` row with an access_token counts.
    kiroHome([["somefuture:sso:token", {
      access_token: "tok", start_url: "https://x.awsapps.com/start/",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    }]]);
    const r = await fetchKiroUsage();
    // Recognised as an Identity Center (Q Pro) login — no network call made.
    expect(r.status).toBe("ok");
    expect(r.plan).toBe("Q Developer Pro");
  });

  it("ignores rows that are not parseable tokens", async () => {
    kiroHome([["codewhisperer:odic:device-registration", { clientId: "x" }]]);
    const r = await fetchKiroUsage();
    expect(r.status).toBe("ok");
    expect(r.hint).toContain("Signed out");
  });
});
