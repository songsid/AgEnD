import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
  it("is safe for `iex` of the downloaded text: ASCII only, no param block, no exit, one wrapping script block", () => {
    expect([...template].every(ch => ch.charCodeAt(0) < 0x80)).toBe(true);
    expect(template).not.toContain("﻿");
    expect(code).not.toMatch(/\bparam\s*\(/i);
    // (the shim's own batch lines say `exit /b`; that is text for cmd.exe inside a string, not a PowerShell exit)
    expect(code.replace(/\$shimText = \([\s\S]*?\) -join "`r`n"/, "")).not.toMatch(/\bexit\b/i);
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
  it("changes the user PATH carefully: never setx, never rewrites the value kind, de-duplicates, and never touches the execution policy", () => {
    expect(code).not.toMatch(/\bsetx\b/i);
    // [Environment]::SetEnvironmentVariable turns a REG_EXPAND_SZ PATH into REG_SZ (measured on Windows PowerShell 5.1 and 7), so the
    // registry value is written back with the kind it had; SetEnvironmentVariable is used only for the throwaway refresh variable.
    expect(code).not.toMatch(/SetEnvironmentVariable\('Path'/i);
    expect(code).toContain("$key.SetValue('Path', $next, $kind)"); expect(code).toContain("$kind = $key.GetValueKind('Path')");
    expect(code).toMatch(/\$e -ieq \$want -or \[Environment\]::ExpandEnvironmentVariables\(\$e\)\.TrimEnd\('\\'\) -ieq \$want\) \{ return \$false \}/);
    expect(code).not.toMatch(/Set-ExecutionPolicy|-ExecutionPolicy|ExecutionPolicy\b/);
  });
  it("pins the exact text of the shim: changing it rewrites a batch file that a running Runtime may be executing (N4)", () => {
    const body = /\$shimText = \(([\s\S]*?)\) -join/.exec(code)![1], text = [...body.matchAll(/'([^']*)'/g)].map(match => match[1]).join("\r\n");
    // If this fails you changed the shim. cmd.exe reads a running batch file a piece at a time, so Set-AgendFile replacing the agend-runtime.cmd of a
    // Runtime that is running can make its window misbehave when it ends. Change the shim only if a bug in it makes installs unusable; then update this
    // hash in the same commit, and say in the docs and the changelog that running Runtimes should be stopped before the install command is run again.
    expect(createHash("sha256").update(text).digest("hex")).toBe("36fcf08973287924389695d1d0d22614812d107b59c2f3d7ca7c69713e8bbd66");
    expect(text).not.toMatch(/\d+\.\d+\.\d+/);   // it names no version
    expect(template).toMatch(/# DO NOT CHANGE \$shimText unless a bug in it makes installs unusable\. cmd\.exe reads a batch file as it runs it/);
  });
  it("does not use an automatic variable as its own, and a failed PATH broadcast is a warning, never 'install failed' (N5)", () => {
    expect(code).not.toMatch(/\$input\b/); expect(code).toContain("$bodyStream = $response.GetResponseStream()");
    // the broadcast is the part after the PATH value was written: both SetEnvironmentVariable calls sit in a try whose catch warns and clears the variable
    const broadcast = /try \{\s+\[Environment\]::SetEnvironmentVariable\('AGEND_RUNTIME_ENV_REFRESH', '1', 'User'\)\s+\[Environment\]::SetEnvironmentVariable\('AGEND_RUNTIME_ENV_REFRESH', \$null, 'User'\)\s+\} catch \{([\s\S]*?)\n        \}\s+return \$true/.exec(code);
    expect(broadcast, "the broadcast is wrapped").not.toBeNull();
    expect(broadcast![1]).toContain("SetEnvironmentVariable('AGEND_RUNTIME_ENV_REFRESH', $null, 'User')"); expect(broadcast![1]).toMatch(/warning: your PATH was updated, but running programs could not be told/);
    expect(broadcast![1]).not.toMatch(/\bthrow\b|install failed/);
  });
  it("never skips or replaces certificate validation, in any form", () => {
    expect(code).not.toMatch(/SkipCertificateCheck|ServerCertificateValidationCallback|CertificatePolicy|ICertificatePolicy|TrustAllCertsPolicy|-k\b|--insecure/i);
    expect(code).toContain("AllowAutoRedirect = $false");
  });
  it("installs under a version folder beside the others, with a shim that never changes and a current.txt that is swapped atomically", () => {
    expect(code).toContain("Join-Path $env:LOCALAPPDATA 'agend-runtime'");
    // the folder names the build as well as the version, so a different build of one version lands beside the old one (N3)
    expect(code).toContain("$folder = $pinnedVersion + '+' + $pinnedSha256.Substring(0, 8)"); expect(code).toContain("$target = Join-Path $root $folder");
    expect(code).toContain("$bin = Join-Path $root 'bin'");
    expect(code).toContain("AGEND_RUNTIME_INSTALL_DIR");
    // the shim text holds no version, so replacing a version cannot change a batch file that is running
    const shim = /\$shimText = \(([\s\S]*?)\) -join/.exec(code)![1];
    expect(shim).not.toMatch(/\$pinnedVersion|\d+\.\d+\.\d+/); expect(shim).toContain('set /p AGEND_RT_VERSION=<"%~dp0current.txt"');
    // a missing current.txt is answered by our message, not by cmd.exe's own (localised) "cannot find the file"
    expect(shim.indexOf('if not exist "%~dp0current.txt" goto :agend_rt_missing')).toBeGreaterThan(-1); expect(shim.indexOf('if not exist "%~dp0current.txt"')).toBeLessThan(shim.indexOf("set /p"));
    expect(shim).toContain('node.exe "%~dp0..\\%AGEND_RT_VERSION%\\dist\\runtime-cli.js" %*'); expect(shim).toContain("exit /b %errorlevel%");
    // the switch: a sibling written whole, then File.Replace (a rename when there is nothing to replace); only the changed file is touched
    expect(code).toContain("[IO.File]::Replace($new, $Path, [NullString]::Value)"); expect(code).toContain("[IO.File]::Move($new, $Path)");
    expect(code).toMatch(/Set-AgendFile \$shim \$shimText\s+Set-AgendFile \$current \$folder/);
    expect(code.indexOf("Set-AgendFile $current $folder")).toBeGreaterThan(code.indexOf("Move-Item -LiteralPath $unpacked -Destination $target"));   // switched only after the new version is whole
  });
  it("fails loudly and leaves earlier installs alone: it deletes only its own staging folder, a temporary sibling and a root it created empty", () => {
    expect(code).toContain("$global:LASTEXITCODE = 1");
    const removals = [...code.matchAll(/Remove-Item -LiteralPath (\$\w+)/g)].map(match => match[1]);
    expect(new Set(removals)).toEqual(new Set(["$OutFile", "$new", "$tmp", "$root"]));
    // an existing version folder is NEVER deleted or replaced, whoever might be running it
    expect(code).not.toMatch(/Remove-Item[^\n]*\$target|Remove-Item[^\n]*\$existing|Remove-Item[^\n]*\$others|Rename-Item|\[IO\.Directory\]::(Delete|Move)/);
    expect(code).toContain("It was left untouched because it may be running");
    // $root only when this run created it and it is still empty; never recursive.
    expect(code).toMatch(/\$createdRoot -and \$root -and \(Test-Path -LiteralPath \$root\) -and -not \(Get-ChildItem -LiteralPath \$root -Force \| Select-Object -First 1\)\) \{ Remove-Item -LiteralPath \$root -Force -ErrorAction/);
    expect(code).toMatch(/\.install-' \+ \[Guid\]::NewGuid/);
  });
});

describe("what the documentation, the page and the changelog promise", () => {
  const read = (file: string): string => readFileSync(file, "utf8");
  const en = read("docs/remote-runtime.md"), zh = read("docs/remote-runtime.zh-TW.md");
  const everything = ["docs/remote-runtime.md", "docs/remote-runtime.zh-TW.md", "src/ui/panel-runtimes.js", "src/ui/runtime-commands.js", "templates/runtime-install/install.ps1",
    "changes/3190-runtime-install-command.md", "changes/3190-runtime-install-command.zh-TW.md"];
  it("never names a way to turn certificate validation off, in the docs, the page, the command, the script or the changelog", () => {
    for (const file of everything) expect(read(file), file).not.toMatch(/SkipCertificateCheck|ServerCertificateValidationCallback|CertificatePolicy|TrustAllCerts|NODE_TLS_REJECT_UNAUTHORIZED|strict-ssl|--insecure|curl[^\n]* -k\b/i);
  });
  it("tells the administrator what to do on a TLS failure, under Constrained Language Mode or AppLocker, and says the execution policy is never changed", () => {
    expect(en).toMatch(/certificate error[\s\S]*trust the AgEnD server's certificate[\s\S]*or use the ZIP/); expect(en).toMatch(/Never turn certificate validation off/);
    // the claim "the command stops under Constrained Language Mode" is true only because no failure reaches iex (B1), and is tested under a real pwsh
    expect(en).toMatch(/Constrained Language Mode or AppLocker\*\* the command \*\*stops without running anything\*\*[\s\S]*Use the ZIP instead/); expect(en).toMatch(/never changes your execution policy/);
    // not claimed: that such policies refuse `iex` themselves. Under ConstrainedLanguage `iex` runs a string in the restricted mode instead (measured), so the only reason the command stops is that the hash cannot be computed.
    for (const text of [en, zh, template, read("src/ui/panel-runtimes.js")]) expect(text).not.toMatch(/iex[^\n]{0,60}(is|are) refused|refused by such policies|這類政策本來也會拒絕|iex. of a downloaded script is refused/i);
    expect(en).toMatch(/the hash cannot be computed there, so the script is never trusted\. Use the ZIP instead/); expect(zh).toMatch(/那裡算不出雜湊，所以腳本不會被信任。請改用 ZIP/);
    expect(en).toMatch(/No failure reaches `iex`/); expect(zh).toMatch(/任何失敗都不會走到 `iex`/);
    expect(zh).toMatch(/憑證錯誤[\s\S]*信任這台 AgEnD 伺服器的憑證[\s\S]*改用 ZIP/); expect(zh).toMatch(/絕對不要以任何開關、回呼或政策關閉憑證驗證/);
    expect(zh).toMatch(/受限語言模式[\s\S]*AppLocker[\s\S]*停下來、什麼都不執行[\s\S]*改用 ZIP/); expect(zh).toMatch(/不會變更你的執行原則/);
  });
  it("says the address comes only from $agend, the reviewed remote-runtime address, and why the command pins the script", () => {
    expect(en).toMatch(/taken \*\*only\*\* from `\$agend`[\s\S]*reviewed remote-runtime address[\s\S]*not the `Host` header/); expect(zh).toMatch(/\*\*只\*\*取自 `\$agend`[\s\S]*審核過的 remote runtime 位址[\s\S]*`Host` 標頭/);
    expect(en).toMatch(/can only prove that the archive matches the script/); expect(en).toMatch(/sends exactly those bytes every time/);
    expect(zh).toMatch(/只能證明「壓縮檔和腳本相符」/); expect(zh).toMatch(/完全相同的位元組/);
  });
  it("explains the PATH choice (never setx; why not SetEnvironmentVariable), side-by-side versions and the version-skew refusal, in both languages", () => {
    for (const text of [en, zh]) { expect(text).toContain("setx"); expect(text).toContain("current.txt"); expect(text).toContain("REG_EXPAND_SZ"); expect(text).toContain("1024"); }
    expect(en).toMatch(/never deleted or replaced, because it may be the Runtime that is running/); expect(en).toMatch(/refuses it clearly/); expect(en).toMatch(/re-run the install command/i);
    expect(zh).toMatch(/永遠不會被刪除或取代/); expect(zh).toMatch(/明確拒絕/); expect(zh).toMatch(/重新執行安裝指令/);
    expect(en).not.toMatch(/Protocol compatibility is diagnostic metadata/);
  });
  it("explains the build-named folders and that clearing old ones is for a later phase, never manual deleting to update (N3)", () => {
    expect(en).toContain("<version>+<build>"); expect(en).toMatch(/different build of the same version number[\s\S]*beside the old ones/); expect(en).toMatch(/Nobody has to delete a folder by hand to update/);
    expect(en).toMatch(/Earlier folders are not removed by this installer[\s\S]*later phase/); expect(en).not.toMatch(/delete that folder yourself, and run the install command again|tells you to close any Runtime window and delete that folder/);
    expect(zh).toContain("<版本>+<build>"); expect(zh).toMatch(/同一個版本號的不同 build/); expect(zh).toMatch(/更新時不需要任何人手動刪資料夾/); expect(zh).toMatch(/這個安裝程式不會移除舊資料夾[\s\S]*之後/);
  });
  it("says a request an address's own limit refuses costs the shared total nothing (N1)", () => {
    expect(en).toMatch(/A client address is asked first: a request its own allowance refuses costs the shared total nothing/); expect(zh).toMatch(/被它自己的額度拒絕的請求不會扣共用的總量/);
  });
  it("documents the caching and burst behaviour of the installer routes", () => {
    for (const text of [en, zh]) { expect(text).toContain("ETag"); expect(text).toContain("If-None-Match"); expect(text).toContain("no-store"); expect(text).toContain("429"); }
  });
  it("names the changelog fragments after the upstream design issue, a pair in both languages", () => {
    expect(existsSync("changes/3190-runtime-install-command.md")).toBe(true); expect(existsSync("changes/3190-runtime-install-command.zh-TW.md")).toBe(true);
    expect(existsSync("changes/15-runtime-install-command.md")).toBe(false); expect(existsSync("changes/15-runtime-install-command.zh-TW.md")).toBe(false);
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
