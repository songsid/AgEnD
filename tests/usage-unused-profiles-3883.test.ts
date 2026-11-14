import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialProfileStoreHome } from "../src/backend/credential-profile.js";
import { fetchAllUsage, setUsageProvidersForTests } from "../src/usage/providers.js";
import { filterUsageProviders, formatUsageSummary } from "../src/usage/usage-api.js";
import { agentUsage } from "../src/usage/agent-output.js";

let root: string;
const saved = process.env.AGEND_HOME;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "usage-unused-3883-")); process.env.AGEND_HOME = root; });
afterEach(() => { setUsageProvidersForTests(null); rmSync(root, { recursive: true, force: true }); if (saved === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = saved; });
function login(backend: string, profile: string) {
  const home = credentialProfileStoreHome(root, backend, profile);
  mkdirSync(home, { recursive: true });
  if (backend === "kiro-cli") {
    const db = new Database(join(home, "data.sqlite3"));
    db.exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO auth_kv VALUES (?, ?)").run("kirocli:odic:token", JSON.stringify({ access_token: "inert-test-token", expires_at: new Date(Date.now() + 3600000).toISOString(), region: "us-east-1", start_url: "https://view.awsapps.com/start" })); db.close();
  } else writeFileSync(join(home, backend === "codex" ? "auth.json" : ".credentials.json"), JSON.stringify(backend === "codex" ? { tokens: { access_token: "inert-test-token" } } : { claudeAiOauth: { accessToken: "inert-test-token" } }));
}
const metrics = [{ label: "Weekly", type: "percent" as const, used: 100, resetsAt: "2026-12-01T00:00:00Z" }, { label: "Rate limit resets", type: "count" as const, value: 3, unit: "available" }];
describe("#3883 logged-in profiles survive their last agent moving away", () => {
  it.each([["codex", "codex"], ["kiro-cli", "kiro"], ["claude-code", "claude"]])("retains %s windows and reset vouchers through the shared web/chat/tool filter", async (backend, id) => {
    login(backend!, "full");
    setUsageProvidersForTests([{ id: id!, name: id!, fetch: async home => home ? { status: "ok", metrics } : { status: "no-credentials", metrics: [] } }]);
    const binding = { backend, backend_options: { [backend!]: { credential_profile: "full" } } };
    const before = await fetchAllUsage({ instances: { worker: binding } });
    expect(before.providers.find(p => p.profile === "full")?.noAgents).toBeUndefined();
    const after = filterUsageProviders(await fetchAllUsage({ instances: { worker: { backend: "grok" } } }), [], { hostLogins: true });
    expect(after.providers).toHaveLength(1);
    expect(after.providers[0]).toMatchObject({ id: `${id}:full`, profile: "full", noAgents: true, metrics });
    expect(formatUsageSummary(after)).toContain("100%");
    expect(formatUsageSummary(after)).toMatch(/no agents/i);
    const compact = agentUsage(after);
    expect(compact.providers[0]).toMatchObject({ profile: "full", status: "no agents on this profile" });
    const account = compact.providers[0]!;
    expect("windows" in account && account.windows.join(" ")).toContain("Rate limit resets 3 available");
    // Other consumers keep their explicit active-only filter (e.g. platform presence).
    if (id !== "claude") expect(filterUsageProviders(after, []).providers).toEqual([]);
  });
  it("does not grow rows for unused signed-out Codex profile directories", async () => {
    mkdirSync(credentialProfileStoreHome(root, "codex", "empty"), { recursive: true });
    setUsageProvidersForTests([{ id: "codex", name: "Codex", fetch: async home => ({ status: home ? "ok" : "no-credentials", metrics }) }]);
    expect((await fetchAllUsage({ instances: {} })).providers).toEqual([]);
  });
});
