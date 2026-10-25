/** PW_DIR=<own playwright package> OUT=<own artifact dir> tsx scripts/manual/setup-signin-2599.mts
 * Real scratch SetupHost/browser; every backend and successor is an inert injected stub.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SetupHost } from "../../src/setup-host.js";
import type { StructuredBackend } from "../../src/structured-signin.js";
const out = resolve(process.env.OUT!), pw = createRequire(join(resolve(process.env.PW_DIR!), "package.json"))("playwright");
mkdirSync(out, { recursive: true }); const home = mkdtempSync(join(tmpdir(), "ag2599-"));
const panes: Record<StructuredBackend, string> = {
  "kiro-cli": readFileSync("tests/fixtures/kiro-2.33.0-audit/login-menu-2.33.0.pane.txt", "utf8"),
  "claude-code": readFileSync("tests/fixtures/claude-2.1.308-onboarding-login-method.pane.txt", "utf8"),
  codex: "https://auth.openai.com/codex/device\nTEST-CODE\n",
};
const valid = new Set<string>(), dead = new Set<string>(), starts: string[] = [], writes: { backend: string; bytes: string }[] = [], closed: string[] = [], errors: string[] = [], external: string[] = [], logs: string[] = [];
const host = new SetupHost({ dataDir: home, configPath: join(home, "fleet.yaml"), port: 0,
  backendSignIns: ["kiro-cli", "claude-code", "codex", "antigravity"], spawnFleet: () => { throw Error("forbidden successor"); }, log: s => logs.push(s),
  signInDeps: { installed: async () => ["kiro-cli", "claude-code", "codex", "antigravity"], checkAuth: async b => valid.has(b) ? "valid" : "invalid",
    transport: backend => ({ start: async () => { starts.push(backend); }, capture: async () => panes[backend], status: async () => ({ alive: !dead.has(backend) }),
      write: async bytes => { writes.push({ backend, bytes });
        if (backend === "kiro-cli") {
          if (panes[backend].includes("Select login method")) panes[backend] = "? Enter Start URL ›";
          else if (panes[backend].includes("Enter Start URL")) panes[backend] = "? Enter Region ›";
          else { valid.add(backend); dead.add(backend); panes[backend] = ""; }
        } else if (backend === "claude-code") {
          if (panes[backend].includes("Select login method")) panes[backend] = "Browser didn't open? Use the url below to sign in\nhttps://claude.com/cai/oauth/authorize?state=test\nPaste code here if prompted >\n";
          else { valid.add(backend); dead.add(backend); panes[backend] = ""; }
        }
      }, close: async () => { closed.push(backend); } }),
  },
});
let browser: any;
try {
  const started = await host.start();
  browser = await pw.chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1120, height: 1000 } });
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", async route => {
    const u = new URL(route.request().url());
    if (u.hostname !== "127.0.0.1") { external.push(u.origin); await route.abort(); return; }
    if (u.pathname.endsWith("/api/settings/quickstart/environment")) { await route.fulfill({ json: { backends: ["kiro-cli", "claude-code", "codex"] } }); return; }
    await route.continue();
  });
  await page.goto(`http://127.0.0.1:${started.port}${started.path}`);
  await page.locator("#code").fill(started.code); await page.getByRole("button", { name: "Continue", exact: true }).click();
  const card = (backend: string) => page.locator(`[data-backend="${backend}"]`);
  await card("kiro-cli").getByRole("button", { name: "Sign in", exact: true }).click();
  await card("kiro-cli").getByRole("button", { name: "Your organization", exact: true }).click();
  await card("kiro-cli").getByRole("textbox", { name: "Organization Start URL", exact: true }).fill("https://example.awsapps.com/start");
  await page.screenshot({ path: join(out, "kiro-start-url.png"), fullPage: true });
  await card("kiro-cli").getByRole("button", { name: "Submit start url", exact: true }).click();
  await card("kiro-cli").getByRole("textbox", { name: "AWS region", exact: true }).fill("us-east-1");
  await card("kiro-cli").getByRole("button", { name: "Submit region", exact: true }).click();
  await card("kiro-cli").getByText("Signed in ✓", { exact: true }).waitFor();
  await card("claude-code").getByRole("button", { name: "Sign in", exact: true }).click();
  await card("claude-code").getByRole("button", { name: "Claude subscription", exact: true }).click();
  await card("claude-code").getByLabel("Paste the returned code", { exact: true }).fill("synthetic#code");
  await card("claude-code").getByRole("button", { name: "Submit code", exact: true }).click();
  await card("claude-code").getByText("Signed in ✓", { exact: true }).waitFor();
  await card("codex").getByRole("button", { name: "Sign in", exact: true }).click();
  await card("codex").getByText("TEST-CODE", { exact: true }).waitFor();
  assert.equal(await card("codex").getByRole("link", { name: "Open provider sign-in" }).getAttribute("href"), "https://auth.openai.com/codex/device");
  const before = [...starts]; await page.reload(); await card("codex").getByText("TEST-CODE", { exact: true }).waitFor(); assert.deepEqual(starts, before);
  valid.add("codex"); dead.add("codex"); panes.codex = "";
  await card("codex").getByText("Signed in ✓", { exact: true }).waitFor();
  await card("antigravity").getByRole("button", { name: "Sign in later", exact: true }).click();
  await page.getByText("You can continue setup.", { exact: true }).waitFor();
  await page.screenshot({ path: join(out, "ready.png"), fullPage: true });
  assert.deepEqual(starts, ["kiro-cli", "claude-code", "codex"]); assert.deepEqual(closed, starts);
  assert.equal(writes.length, 5); assert(!logs.join("\n").includes("synthetic#code")); assert(!logs.join("\n").includes("TEST-CODE"));
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  writeFileSync(join(out, "results.json"), JSON.stringify({ passed: 12, starts, inputs: writes.length, closed, errors, external, secretFreeLogs: true, refreshedAttemptKept: true, agyConsoleOnly: true }, null, 2) + "\n");
  console.log("12/12 browser checks PASS (stub transports, no provider/network/fleet)");
} finally { await browser?.close(); await host.shutdown(false, "test cleanup"); rmSync(home, { recursive: true, force: true }); }
