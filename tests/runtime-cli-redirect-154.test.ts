import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DOWNLOAD_COMMAND, INSTALLABLE_CLIS, LATEST_UNAUDITED, MANIFEST_COMMAND, installManagedCli, managedCliExecutable, updateManagedCliToLatest, type InstallDeps } from "../src/runtime-cli-install.js";

/**
 * AGEND-154 (Prism P2-2 on #3552): the official-source restriction of the Windows fetches must survive HTTP redirects. `MANIFEST_COMMAND` and `DOWNLOAD_COMMAND` are Windows PowerShell's
 * `Invoke-WebRequest`, which (5.1) follows up to five redirects unless told not to; `parseLatestManifest` only checks the address the manifest NAMES, not where the bytes came from.
 *
 * Two kinds of evidence: (1) a fake PowerShell that behaves like the HTTP layer — it answers by the address in the environment, and what it does at a 3xx depends on the command TEXT it is
 * given (no `-MaximumRedirection 0`: it follows, as PowerShell 5.1's default does; with it: exit 1) — so the Runtime paths are exercised end to end, with the previous command text as the control
 * that goes red; (2) a real PowerShell against a loopback server that really redirects (skipped without `pwsh`; it runs in CI's pwsh partition). The Windows PowerShell 5.1 receipt is the same flow run by hand on a real Windows PowerShell 5.1 (see the PR reply).
 */
const OLD_MANIFEST_COMMAND = MANIFEST_COMMAND.replace(" -MaximumRedirection 0", "").replace(" if ($r.StatusCode -ne 200) { exit 1 };", "");
const OLD_DOWNLOAD_COMMAND = DOWNLOAD_COMMAND.replace(" -MaximumRedirection 0", "");
const sha = (b: Buffer): string => createHash("sha512").update(b).digest("hex");
const GOOGLE = "CN=Google LLC, O=Google LLC, L=Mountain View, S=California, C=US";
const real = INSTALLABLE_CLIS.antigravity;
const URL_OF = (version: string): string => `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-6604829099950080/windows-x64/cli_windows_x64.exe`;
const body153 = Buffer.from("MZ-agy-1.5.3-fixture"), body16 = Buffer.from("MZ-agy-1.6.0-fixture");
const OFFICIAL_MANIFEST = LATEST_UNAUDITED.antigravity.manifest, EVIL = "https://evil.example/anything";
const smallPin = { ...real, bytes: body153.length, sha512: sha(body153), url: URL_OF("1.5.3") };

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agend-redirect-154-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));
const deps = (over: Partial<InstallDeps> = {}): InstallDeps => ({ root: join(home, "cli"), nodePath: join(home, "nowhere", "node.exe"), pins: { antigravity: smallPin }, signerOf: async () => ({ status: "Valid", subject: GOOGLE }), ...over });

/** What the network has: official addresses answer directly or with a redirect; the redirect's target (another origin) serves a perfectly valid-looking answer. */
interface Network { redirect?: Set<string>; manifest?: string; file?: Buffer }
/** A fake PowerShell with an HTTP layer. Returns the requests it made, in order. */
function fakePowerShell(net: Network): { run: NonNullable<InstallDeps["run"]>; requests: string[] } {
  const requests: string[] = [];
  const run: NonNullable<InstallDeps["run"]> = async (_file, args, { env }) => {
    const text = args[args.length - 1] ?? "", url = env.AGEND_DOWNLOAD_URL!;
    const noRedirect = text.includes("-MaximumRedirection 0");
    const isManifest = text.startsWith(MANIFEST_COMMAND.slice(0, 40)) && text.includes("GetString");
    let at = url;
    requests.push(at);
    if (net.redirect?.has(at)) {
      if (noRedirect) return { code: 1, stdout: "" };           // 3xx with no redirect allowed: Invoke-WebRequest throws, the command exits 1
      at = EVIL; requests.push(at);                             // PowerShell 5.1's default: follows (up to five)
    }
    if (isManifest) return { code: 0, stdout: `${net.manifest ?? ""}\r\n` };
    writeFileSync(env.AGEND_DOWNLOAD_FILE!, net.file ?? body16); return { code: 0, stdout: "" };
  };
  return { run, requests };
}
const manifestOf = (version: string, content: Buffer): string => JSON.stringify({ version, url: URL_OF(version), sha512: sha(content) });

describe("the fixed text of the two fetches", () => {
  it("both refuse every redirect, and neither runs anything it fetched", () => {
    for (const text of [MANIFEST_COMMAND, DOWNLOAD_COMMAND]) {
      expect(text).toContain("-MaximumRedirection 0");
      expect(text).not.toMatch(/\biex\b|Invoke-Expression|Start-Process|&\s/i);
    }
    expect(MANIFEST_COMMAND).toContain("if ($r.StatusCode -ne 200) { exit 1 }");
  });
});

describe("the Runtime paths with a fake PowerShell that has an HTTP layer", () => {
  it("control: a direct answer from the official source succeeds (manifest read, file downloaded, checked, installed)", async () => {
    const { run, requests } = fakePowerShell({ manifest: manifestOf("1.6.0", body16), file: body16 });
    expect(await updateManagedCliToLatest("antigravity", deps({ run }))).toMatchObject({ version: "1.6.0" });
    expect(requests).toEqual([OFFICIAL_MANIFEST, URL_OF("1.6.0")]);
    expect(managedCliExecutable(join(home, "cli"), "antigravity")).toMatchObject({ version: "1.6.0" });
  });
  it("a manifest address that answers with a redirect to another origin is refused: no manifest is read from there, no download starts, nothing is written", async () => {
    const { run, requests } = fakePowerShell({ redirect: new Set([OFFICIAL_MANIFEST]), manifest: manifestOf("1.6.0", body16), file: body16 });
    await expect(updateManagedCliToLatest("antigravity", deps({ run }))).rejects.toMatchObject({ reason: "install-failed", message: expect.stringContaining("could not be read") });
    expect(requests).toEqual([OFFICIAL_MANIFEST]);                                  // it never went to the other origin, and never asked for the file
    expect(existsSync(join(home, "cli", "antigravity", "current.json"))).toBe(false);
  });
  it("a file address that answers with a redirect to another origin is refused for the latest update and for the pinned install alike: no file lands", async () => {
    const latest = fakePowerShell({ redirect: new Set([URL_OF("1.6.0")]), manifest: manifestOf("1.6.0", body16), file: body16 });
    await expect(updateManagedCliToLatest("antigravity", deps({ run: latest.run }))).rejects.toMatchObject({ reason: "install-failed", message: expect.stringContaining("download could not be completed") });
    expect(latest.requests).toEqual([OFFICIAL_MANIFEST, URL_OF("1.6.0")]);
    const pinned = fakePowerShell({ redirect: new Set([smallPin.url]), file: body153 });
    await expect(installManagedCli("antigravity", deps({ run: pinned.run }))).rejects.toMatchObject({ reason: "install-failed" });
    expect(pinned.requests).toEqual([smallPin.url]);
    expect(existsSync(join(home, "cli", "antigravity", "current.json"))).toBe(false);
    expect(managedCliExecutable(join(home, "cli"), "antigravity")).toBeNull();
  });
  it("control (goes red without the fix): the previous command text FOLLOWS the same redirect, so the same fake network hands the Runtime an off-origin manifest and an off-origin file, and the update goes through", async () => {
    const net = fakePowerShell({ redirect: new Set([OFFICIAL_MANIFEST, URL_OF("1.6.0")]), manifest: manifestOf("1.6.0", body16), file: body16 });
    // the Runtime run with the old command texts: the dependency swaps each fixed command for its previous text, as the code before this change would have sent it
    const old: NonNullable<InstallDeps["run"]> = (file, args, options) => net.run(file, [...args.slice(0, -1), args[args.length - 1] === MANIFEST_COMMAND ? OLD_MANIFEST_COMMAND : args[args.length - 1] === DOWNLOAD_COMMAND ? OLD_DOWNLOAD_COMMAND : args[args.length - 1]!], options);
    expect(await updateManagedCliToLatest("antigravity", deps({ run: old }))).toMatchObject({ version: "1.6.0" });
    expect(net.requests).toEqual([OFFICIAL_MANIFEST, EVIL, URL_OF("1.6.0"), EVIL]);   // two fetches, both handed to another origin
  });
});

// ── a real PowerShell, a real redirect ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const probe = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8" });
const hasPwsh = probe.status === 0;
describe.skipIf(!hasPwsh)(`a real PowerShell (${hasPwsh ? probe.stdout.trim() : "none"}) against a loopback server that redirects`, () => {
  let server: Server, port = 0; const seen: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(req.url ?? "");
      if (req.url === "/redirect") { res.writeHead(302, { Location: `http://localhost:${port}/other-origin` }); res.end(); return; }
      res.writeHead(200, { "Content-Type": "application/octet-stream" }); res.end(req.url === "/direct" ? "DIRECT-OFFICIAL" : "OTHER-ORIGIN");
    });
    await new Promise<void>(done => server.listen(0, "0.0.0.0", done));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => { server.close(); });
  beforeEach(() => { seen.length = 0; });
  // Asynchronous on purpose: the loopback server lives in this process, so a blocking spawn would starve it.
  const fetchWith = async (command: string, path: string): Promise<{ code: number | null; out: string; file: string | null }> => {
    const dir = mkdtempSync(join(tmpdir(), "agend-redirect-154-pwsh-")), file = join(dir, "got.bin");
    try {
      const env = { ...process.env, AGEND_DOWNLOAD_URL: `http://localhost:${port}${path}`, AGEND_DOWNLOAD_FILE: file };
      const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], { env, stdio: ["ignore", "pipe", "ignore"] });
      let out = ""; child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
      const code = await new Promise<number | null>(done => { const t = setTimeout(() => { child.kill("SIGKILL"); }, 60_000); child.on("close", c => { clearTimeout(t); done(c); }); });
      return { code, out: out.trim(), file: existsSync(file) ? readFileSync(file, "utf8") : null };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  it("the manifest read: the direct official answer is returned; a redirect is refused and the other origin is never asked", async () => {
    expect(await fetchWith(MANIFEST_COMMAND, "/direct")).toMatchObject({ code: 0, out: "DIRECT-OFFICIAL" });
    seen.length = 0;
    expect(await fetchWith(MANIFEST_COMMAND, "/redirect")).toMatchObject({ code: 1, out: "" });
    expect(seen).toEqual(["/redirect"]);
  });
  it("the file download: the direct official answer is saved; a redirect is refused, no byte is saved and the other origin is never asked", async () => {
    expect(await fetchWith(DOWNLOAD_COMMAND, "/direct")).toMatchObject({ code: 0, file: "DIRECT-OFFICIAL" });
    seen.length = 0;
    const refused = await fetchWith(DOWNLOAD_COMMAND, "/redirect");
    expect(refused.code).toBe(1);
    expect(refused.file ?? "").toBe("");                      // Windows PowerShell 5.1 creates the (empty) file before it fails; no byte of the other origin is in it
    expect(seen).toEqual(["/redirect"]);
  });
  it("control (goes red without the fix): the previous command texts follow the same redirect to the other origin", async () => {
    expect(await fetchWith(OLD_MANIFEST_COMMAND, "/redirect")).toMatchObject({ code: 0, out: "OTHER-ORIGIN" });
    expect(await fetchWith(OLD_DOWNLOAD_COMMAND, "/redirect")).toMatchObject({ code: 0, file: "OTHER-ORIGIN" });
    expect(seen).toContain("/other-origin");
  });
});
