import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeBundle } from "../src/runtime-bundle.js";
import { RUNTIME_INSTALL_MAX_SCRIPT_BYTES, RUNTIME_INSTALL_SHA256_TOKEN, RUNTIME_INSTALL_VERSION_TOKEN, RuntimeInstallService, renderRuntimeInstallScript } from "../src/runtime-install.js";

/**
 * install.ps1 is run as `irm <server>/runtime/install.ps1 | iex` on a Windows PC, so what can be pinned on Linux is pinned
 * here by reading the template: the rules that make it safe for iex, what it must never do, and the order that makes its
 * checksum check mean something. Running it for real (PowerShell 5.1 and 7, an isolated install directory, a real pairing)
 * is the end-to-end acceptance run reported on the pull request.
 */
const template = readFileSync("templates/runtime-install/install.ps1", "utf8");
/** The script without comment-only lines, so prose that names a forbidden construct is not mistaken for code. */
const code = template.split("\n").filter(line => !/^\s*#/.test(line)).join("\n");
const bundle: RuntimeBundle = (() => { const bytes = Buffer.from("zip fixture"); return { bytes, filename: "agend-runtime-windows-2.3.5-alpha.7.zip", version: "2.3.5-alpha.7", sha256: createHash("sha256").update(bytes).digest("hex") }; })();
beforeEach(() => vi.stubEnv("AGEND_REMOTE_RUNTIME", "1"));
afterEach(() => vi.unstubAllEnvs());

describe("install.ps1 template", () => {
  it("is safe for `irm | iex`: ASCII only, no param block, no exit, one wrapping script block", () => {
    expect([...template].every(ch => ch.charCodeAt(0) < 0x80)).toBe(true);
    expect(template).not.toContain("﻿");
    expect(code).not.toMatch(/\bparam\s*\(/i);
    expect(code).not.toMatch(/\bexit\b/i);
    expect(code.trimStart().startsWith("& {")).toBe(true);
    expect(code.trimEnd().endsWith("}")).toBe(true);
    expect(Buffer.byteLength(template)).toBeLessThan(RUNTIME_INSTALL_MAX_SCRIPT_BYTES);
  });
  it("has exactly one placeholder each for the pinned version and the pinned checksum, and nothing else the server fills in", () => {
    expect(template.split(RUNTIME_INSTALL_VERSION_TOKEN)).toHaveLength(2);
    expect(template.split(RUNTIME_INSTALL_SHA256_TOKEN)).toHaveLength(2);
    expect(template.match(/@@[A-Z0-9_]+@@/g)!.sort()).toEqual([RUNTIME_INSTALL_SHA256_TOKEN, RUNTIME_INSTALL_VERSION_TOKEN].sort());
    const script = renderRuntimeInstallScript(template, bundle);
    expect(script).toContain(`$pinnedVersion = '${bundle.version}'`); expect(script).toContain(`$pinnedSha256 = '${bundle.sha256}'`);
    expect(script).not.toMatch(/@@/);
  });
  it("takes the server address from the command's $agend, never from the network, and refuses anything but an origin", () => {
    expect(code).toContain("Resolve-AgendOrigin $agend");
    expect(code).toMatch(/\$uri\.Scheme -eq 'https'/); expect(code).toMatch(/\$uri\.Scheme -eq 'http' -and \$local/);
    for (const refused of ["UserInfo", "Query", "Fragment", "AbsolutePath"]) expect(code).toContain(`$uri.${refused}`);
    // The only hosts it will fetch from is that origin; there is no hard-coded server, mirror or fallback.
    const urls = [...code.matchAll(/https?:\/\/[^\s'")]+/g)].map(match => match[0]);
    expect(urls.every(url => /^https:\/\/(your-agend-host|nodejs\.org\/?)$/.test(url))).toBe(true);
    expect(code).not.toMatch(/X-Agend-SHA256/i);
    expect(code).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|Invoke-Expression|DownloadString|DownloadFile/i);
    // `iex` appears only inside a line it prints for the person to run, never as something the script runs.
    expect(code.split("\n").filter(line => /\biex\b/i.test(line)).every(line => line.trimStart().startsWith("Write-Host '"))).toBe(true);
    expect(code).toContain("AllowAutoRedirect = $false");
  });
  it("checks the pinned SHA-256 before it unpacks anything, and unpacks nothing on a mismatch", () => {
    const hash = code.indexOf("$actual = Get-AgendSha256"), compare = code.indexOf("$actual -ne $pinnedSha256"), extract = code.indexOf("ExtractToDirectory");
    expect(hash).toBeGreaterThan(-1); expect(compare).toBeGreaterThan(hash); expect(extract).toBeGreaterThan(compare);
    expect(code.slice(compare, extract)).toMatch(/throw/);
    expect(code.match(/ExtractToDirectory/g)).toHaveLength(1);
    expect(code.indexOf("Save-AgendArchive (")).toBeLessThan(hash);
    expect(code).toContain("[Security.Cryptography.SHA256]::Create()");
  });
  it("checks Node.js before downloading and never installs software", () => {
    expect(code.indexOf("Test-NodeVersion $nodeText")).toBeGreaterThan(-1);
    expect(code.indexOf("Test-NodeVersion $nodeText")).toBeLessThan(code.indexOf("Save-AgendArchive ("));
    // winget is named only in the line that tells the person to run it themselves.
    expect(code.split("\n").filter(line => /winget/i.test(line)).every(line => line.trimStart().startsWith("Write-Host '"))).toBe(true);
    for (const forbidden of [/choco(latey)?\s+install/i, /Start-Process/i, /msiexec/i, /-Verb\s+RunAs/i, /Set-ExecutionPolicy/i, /Invoke-Item/i]) expect(code, String(forbidden)).not.toMatch(forbidden);
    expect(code).toContain("22.14"); expect(code).toMatch(/\$major -eq 23 -and \$minor -ge 6/); expect(code).toMatch(/\$major -ge 24/);
  });
  it("does not connect, pair or contact the pairing endpoints, and carries no credential", () => {
    expect(code).not.toMatch(/\/runtime\/v1\/(pair|claim|rotate|connect)/);
    expect(code).not.toMatch(/runtime-cli\.js['"`]?\s+connect|agend-runtime\.cmd['"`]?\s+connect(?! --server)/);
    expect(code).not.toMatch(/Start-Process|&\s*\$shim|&\s*\$target/);
    expect(code).not.toMatch(/token|secret|password|credential|pairing code\s*=|claimSecret/i);
    // It prints the command; the pairing code is typed into the terminal by the person.
    expect(code).toContain("connect --server");
  });
  it("needs no administrator rights: it writes only under the install folder and the user's own PATH", () => {
    expect(code).toContain("[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)");
    expect(code).not.toMatch(/LocalMachine|HKLM|'Machine'|"Machine"|EnvironmentVariableTarget\]::Machine|System32|ProgramFiles/i);
    expect(code).toMatch(/SetEnvironmentVariable\('AGEND_RUNTIME_ENV_REFRESH', '1', 'User'\)/);
    expect(code).toContain("DoNotExpandEnvironmentNames");
    expect(code).toContain("AGEND_RUNTIME_NO_PATH");
  });
  it("installs under a version folder and points one shim at it, so a later version replaces only the shim", () => {
    expect(code).toContain("Join-Path $env:LOCALAPPDATA 'agend-runtime'");
    expect(code).toContain("$target = Join-Path $root $pinnedVersion");
    expect(code).toContain("$bin = Join-Path $root 'bin'");
    expect(code).toContain('node.exe `"%~dp0..\\" + $pinnedVersion + "\\dist\\runtime-cli.js`" %*');
    expect(code).toContain("AGEND_RUNTIME_INSTALL_DIR");
  });
  it("fails loudly and leaves earlier installs alone: it never deletes anything but its own staging folder and the same version", () => {
    expect(code).toContain("$global:LASTEXITCODE = 1");
    const removals = [...code.matchAll(/Remove-Item -LiteralPath (\$\w+)/g)].map(match => match[1]);
    expect(new Set(removals)).toEqual(new Set(["$OutFile", "$target", "$tmp", "$root"]));
    // $root only when this run created it and it is still empty; never recursive.
    expect(code).toMatch(/\$createdRoot -and \$root -and \(Test-Path -LiteralPath \$root\) -and -not \(Get-ChildItem -LiteralPath \$root -Force \| Select-Object -First 1\)\) \{ Remove-Item -LiteralPath \$root -Force -ErrorAction/);
    expect(code).toMatch(/\.install-' \+ \[Guid\]::NewGuid/);
  });
});

describe("install.ps1 as the server serves it", () => {
  function res(service: RuntimeInstallService, path: string) {
    const req = Readable.from([]) as unknown as IncomingMessage; req.method = "GET"; req.url = path; req.headers = { host: "localhost" };
    Object.defineProperty(req, "socket", { value: { remoteAddress: "127.0.0.1" } });
    let status = 0, body = Buffer.alloc(0);
    const out = new ServerResponse(req); out.writeHead = ((code: number) => { status = code; return out; }) as never; out.end = ((chunk?: Buffer) => { body = Buffer.from(chunk ?? ""); return out; }) as never;
    service.handle(req, out, new URL(path, "http://localhost")); return { status, text: body.toString("utf8") };
  }
  it("ships in the package and is stamped with the bundle it pins, from the real template file", () => {
    const { status, text } = res(new RuntimeInstallService({ bundle: () => bundle }), "/runtime/install.ps1");
    expect(status).toBe(200);
    expect(text).toBe(renderRuntimeInstallScript(template, bundle));
    expect(text).toContain(`'${bundle.sha256}'`);
    expect(JSON.parse(readFileSync("package.json", "utf8")).files).toContain("templates/");
  });
});
