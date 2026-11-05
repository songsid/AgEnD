/**
 * #3068: on a network that inspects HTTPS, the Windows installer offers to import into AgEnD's Linux the ONE root the
 * intercepting proxy chains to, when Windows already trusts that exact root — with consent (y/N, default no), its name,
 * SHA-256 fingerprint and store shown. Matched by name AND key identifier (never by name alone), then checked with
 * openssl as the only trust anchor for the presented chain. Imported to /usr/local/share/ca-certificates/agend-org-root-
 * <fp8>.crt + update-ca-certificates; NODE_EXTRA_CA_CERTS goes into AgEnD's .env (other lines kept; another value is
 * never replaced), /etc/profile.d and this run's WSL steps (WSLENV). Never: TLS verification off, every root, no consent.
 *
 * Real certificates are made with openssl here; the installer's own functions are taken from its syntax tree and run in
 * pwsh; every generated bash script runs for real (paths under /usr/local and /etc mapped into a scratch directory).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const INSTALLER = join(ROOT, "website", "public", "install-agend.ps1");
const code = readFileSync(INSTALLER, "utf8").split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
const pwsh = spawnSync("pwsh", ["-NoProfile", "-c", "1"], { encoding: "utf8" }).status === 0;
const openssl = spawnSync("openssl", ["version"], { encoding: "utf8" }).status === 0;
const dirs: string[] = [];
const procs: ChildProcess[] = [];
afterAll(() => {
  for (const p of procs) p.kill("SIGKILL");
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function scratch(): string { const d = mkdtempSync(join(tmpdir(), "agend-3068-")); dirs.push(d); return d; }

describe("static (#3068)", () => {
  it("never turns TLS verification off, never imports every root; consent comes before the import", () => {
    expect(code).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED|strict-ssl|--insecure|curl -k\b|-k https/);
    // The Windows roots are only ever searched, one cert chosen; nothing loops over them to write.
    expect(code.match(/Get-WindowsRootCerts/g)).toHaveLength(2);                 // its definition and the one Find-OrgRoot call
    expect(code).toContain("$found = Find-OrgRoot $chain (Get-WindowsRootCerts)");
    const offer = code.slice(code.indexOf("function Invoke-OrgRootOffer"));
    const ask = offer.indexOf('Read-Host "  要匯入這一張憑證嗎？(y/N)"');
    expect(ask).toBeGreaterThan(offer.indexOf("Get-WslVerifyScript $found.Cert $chain"));
    expect(offer.indexOf("Get-WslOrgCaImportScript")).toBeGreaterThan(ask);
    expect(offer.slice(ask)).toMatch(/^[^\n]+\n\s+if \(\(\[string\]\$answer\) -notmatch '\^\\s\*\[yY\]\\s\*\$'\) \{[^\n]*return \$false \}/);
  });
  it("a previous import is carried into this run's WSL steps before the WSL network gate", () => {
    const restore = code.indexOf("Restore-OrgCaSessionEnv $UBUNTU_DISTRO\nif (-not ((Stage-Done 2) -and (Stage-Done 4))) {");
    expect(restore).toBeGreaterThan(code.indexOf('Write-Ok "WSL 已就緒"'));
  });
  it("the layout fixes: no WSL_CONF_OK sentinel, the log path on its own line, the distro named as such, short certificate lines", () => {
    expect(code).not.toContain("WSL_CONF_OK");
    expect(code).toContain('Write-Host "  安裝紀錄（回報問題時請附上這個檔案）：" -ForegroundColor Yellow\n        Write-Host "    $($script:InstallLog)" -ForegroundColor Yellow');
    expect(code).not.toContain("Linux 版本：");
    expect(code).toContain('Write-Ok "要安裝的 Linux：$UBUNTU_DISTRO"');
    expect(code).toContain('Write-Info "  Node.js 另外要設定 NODE_EXTRA_CA_CERTS，指向這個檔案。"');
  });
});

/** The installer's functions and script-level tables, then the body, run as a script file. */
function ps(body: string, env: Record<string, string> = {}): string {
  const dir = scratch();
  const script = join(dir, "t.ps1");
  writeFileSync(script, `$ErrorActionPreference = 'Stop'
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${INSTALLER}', [ref]$t, [ref]$e)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
foreach ($a in $ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -match '^\\$(NET_|ORG_CA_|AGEND_USER)' }) { . ([scriptblock]::Create($a.Extent.Text)) }
function Write-InstallLog { param($m) }
${body}`);
  const r = spawnSync("pwsh", ["-NoProfile", "-File", script], { encoding: "utf8", timeout: 90_000, env: { ...process.env, TMPDIR: dir, ...env } });
  if (r.error || r.signal || r.status !== 0) throw new Error(`pwsh ended ${r.error ?? r.signal ?? r.status}:\n${r.stdout}${r.stderr}`);
  return r.stdout + r.stderr;
}
function sh(cmd: string, cwd: string): void {
  const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd}\n${r.stderr}`);
}
function bash(script: string, env: Record<string, string> = {}) {
  return spawnSync("/bin/bash", ["-c", script], { encoding: "utf8", timeout: 30_000, env: { PATH: "/usr/bin:/bin", ...env } });
}
async function freePort(): Promise<number> {
  return new Promise(res => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
}

describe.skipIf(!pwsh || !openssl)("with pwsh and openssl: the consented single-root import (#3068)", { timeout: 180_000 }, () => {
  let c: string;              // certificates
  const pem = (n: string) => readFileSync(join(c, `${n}.pem`), "utf8");
  // A PowerShell list of @{ Cert; Store } from PEM files, as Get-WindowsRootCerts returns.
  const store = (...names: string[]) => `@(${names.map(n => `@{ Cert = (ConvertFrom-PemChain ([IO.File]::ReadAllText('${join(c, `${n}.pem`)}')))[0]; Store = 'LocalMachine\\Root' }`).join(", ")})`;
  const chainOf = (...names: string[]) => `(ConvertFrom-PemChain (${names.map(n => `[IO.File]::ReadAllText('${join(c, `${n}.pem`)}')`).join(" + ")}))`;
  const sha256 = (n: string) => spawnSync("bash", ["-c", `openssl x509 -in ${n}.pem -outform DER | sha256sum | cut -c1-64`], { cwd: c, encoding: "utf8" }).stdout.trim();

  beforeAll(() => {
    c = scratch();
    const ec = "-newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes";
    const ca = "-addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign";
    // The inspection root, an impostor with the SAME name and another key, and an unrelated root.
    sh(`openssl req -x509 ${ec} -keyout root.key -out root.pem -days 30 -subj "/O=AgEnD Test/CN=AgEnD Test Inspection Root" ${ca}`, c);
    sh(`openssl req -x509 ${ec} -keyout imp.key -out imp.pem -days 30 -subj "/O=AgEnD Test/CN=AgEnD Test Inspection Root" ${ca}`, c);
    sh(`openssl req -x509 ${ec} -keyout other.key -out other.pem -days 30 -subj "/CN=Some Public Root" ${ca}`, c);
    // A leaf the proxy mints (with the issuer's key identifier), and one minted without it.
    sh(`openssl req ${ec} -keyout leaf.key -out leaf.csr -subj "/CN=localhost"`, c);
    writeFileSync(join(c, "aki.ext"), "subjectAltName=DNS:localhost\nauthorityKeyIdentifier=keyid\nsubjectKeyIdentifier=hash\n");
    writeFileSync(join(c, "noaki.ext"), "subjectAltName=DNS:localhost\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=none\n");
    sh("openssl x509 -req -in leaf.csr -CA root.pem -CAkey root.key -CAcreateserial -out leaf.pem -days 5 -extfile aki.ext", c);
    sh("openssl x509 -req -in leaf.csr -CA root.pem -CAkey root.key -CAcreateserial -out leafnoaki.pem -days 5 -extfile noaki.ext", c);
    // A leaf signed by the unrelated root, and that root in a hashed store only this process's environment points at.
    sh("openssl x509 -req -in leaf.csr -CA other.pem -CAkey other.key -CAcreateserial -out leafother.pem -days 5 -extfile aki.ext", c);
    sh("mkdir -p ambient && cp other.pem ambient/ && openssl rehash ambient", c);
  });

  it("Find-OrgRoot picks the exact root by name AND key identifier; a same-name root with another key, or an expired one, is not it", () => {
    const out = ps(`
$chain = ${chainOf("leaf")}
$hit = Find-OrgRoot $chain ${store("other", "imp", "root")}
Write-Output ('HIT=' + $hit.Sha256 + '|' + $hit.Store + '|' + $hit.Cert.Subject)
Write-Output ('IMPOSTOR=' + [string]((Find-OrgRoot $chain ${store("imp", "other")}) -eq $null))
Write-Output ('EXPIRED=' + [string]((Find-OrgRoot $chain ${store("root")} ((Get-Date).AddYears(5))) -eq $null))
Write-Output ('SELF=' + (Find-OrgRoot ${chainOf("leaf", "root")} ${store("imp", "root")}).Sha256)
Write-Output ('EMPTY=' + [string]((Find-OrgRoot @() ${store("root")}) -eq $null))
Write-Output ('AKI=' + (Get-CertKeyId $chain[0] 'aki') + ' SKI=' + (Get-CertKeyId (${chainOf("root")})[0] 'ski'))`);
    const fp = sha256("root").toUpperCase();
    expect(out).toContain(`HIT=${fp}|LocalMachine\\Root|CN=AgEnD Test Inspection Root, O=AgEnD Test`);
    expect(out).toContain("IMPOSTOR=True");
    expect(out).toContain("EXPIRED=True");
    expect(out).toContain(`SELF=${fp}`);
    expect(out).toContain("EMPTY=True");
    const ids = /AKI=([0-9A-F]+) SKI=([0-9A-F]+)/.exec(out);
    expect(ids?.[1]).toBe(ids?.[2]);
    expect(ids?.[1]).toMatch(/^[0-9A-F]{40}$/);
  });

  it("the openssl check: the real root verifies the presented chain; a same-name root with another key does not (no name-only match)", () => {
    const out = ps(`
foreach ($pair in @(@('REAL', 'root', 'leaf'), @('IMPOSTOR', 'imp', 'leafnoaki'))) {
  $rootCert = (ConvertFrom-PemChain ([IO.File]::ReadAllText((Join-Path '${c}' ($pair[1] + '.pem')))))[0]
  $chain = ConvertFrom-PemChain ([IO.File]::ReadAllText((Join-Path '${c}' ($pair[2] + '.pem'))))
  [IO.File]::WriteAllText((Join-Path $env:TMPDIR ($pair[0] + '.sh')), (Get-WslVerifyScript $rootCert $chain))
  Write-Output ($pair[0] + '=' + $env:TMPDIR)
}
# Without an AKI, the impostor's name alone matches: only the signature check stands between it and the offer.
Write-Output ('NAMEONLY=' + (Find-OrgRoot ${chainOf("leafnoaki")} ${store("imp")}).Cert.Subject)`);
    const dir = /REAL=(\S+)/.exec(out)![1];
    expect(bash(`bash ${dir}/REAL.sh`).stdout).toBe("VERIFY_OK\n");
    expect(bash(`bash ${dir}/IMPOSTOR.sh`).stdout).toBe("");
    expect(out).toContain("NAMEONLY=CN=AgEnD Test Inspection Root, O=AgEnD Test");
  });

  it("the selected root is the ONLY anchor: a chain that verifies only through an ambient store (CAfile, CApath, CAstore) fails (Prism #3071)", () => {
    // The presented leaf is signed by the unrelated root; the selected root rides along as an untrusted extra.
    const out = ps(`
$rootCert = (ConvertFrom-PemChain ([IO.File]::ReadAllText('${join(c, "root.pem")}')))[0]
$chain = ${chainOf("leafother", "root")}
[IO.File]::WriteAllText((Join-Path $env:TMPDIR 'amb.sh'), (Get-WslVerifyScript $rootCert $chain))
Write-Output ('DIR=' + $env:TMPDIR)`);
    const script = `bash ${/DIR=(\S+)/.exec(out)![1]}/amb.sh`;
    const ambient = join(c, "ambient");
    const PATH = process.env.PATH ?? "/usr/bin:/bin";
    // Control: that store really makes the chain verify for openssl's defaults.
    expect(spawnSync("openssl", ["verify", join(c, "leafother.pem")], { encoding: "utf8", env: { PATH, SSL_CERT_DIR: ambient } }).status).toBe(0);
    for (const env of [{ SSL_CERT_DIR: ambient }, { SSL_CERT_FILE: join(c, "other.pem") }, { SSL_CERT_URI: `file:${ambient}` }]) {
      expect(bash(script, { PATH, ...env }).stdout, JSON.stringify(env)).toBe("");
    }
  });

  it("no scratch directory: the verify and import scripts stop before writing anything", () => {
    const out = ps(`
$rootCert = (ConvertFrom-PemChain ([IO.File]::ReadAllText('${join(c, "root.pem")}')))[0]
[IO.File]::WriteAllText((Join-Path $env:TMPDIR 'v.sh'), (Get-WslVerifyScript $rootCert ${chainOf("leaf")}))
[IO.File]::WriteAllText((Join-Path $env:TMPDIR 'i.sh'), (Get-WslOrgCaImportScript $rootCert '${"A".repeat(64)}'))
Write-Output ('DIR=' + $env:TMPDIR)`);
    const dir = /DIR=(\S+)/.exec(out)![1];
    const fake = scratch();
    mkdirSync(join(fake, "bin"));
    for (const [name, body] of [["mktemp", "exit 1"], ["base64", `echo "$@" >> ${fake}/writes; exit 0`], ["openssl", `echo "$@" >> ${fake}/writes; exit 0`]]) {
      writeFileSync(join(fake, "bin", name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(fake, "bin", name), 0o755);
    }
    for (const f of ["v.sh", "i.sh"]) {
      const r = bash(`bash ${dir}/${f}`, { PATH: `${join(fake, "bin")}:/usr/bin:/bin` });
      expect(r.status, f).toBe(1);
      expect(r.stdout, f).not.toContain("VERIFY_OK");
      expect(r.stdout, f).not.toContain("CA_IMPORTED");
    }
    expect(existsSync(join(fake, "writes"))).toBe(false);
  });

  it("the chain script reads what a TLS server really presents (openssl s_client)", async () => {
    const port = await freePort();
    const server = spawn("openssl", ["s_server", "-accept", String(port), "-cert", join(c, "leaf.pem"), "-key", join(c, "leaf.key"), "-quiet"], { stdio: "ignore" });
    procs.push(server);
    for (let i = 0; i < 50 && spawnSync("bash", ["-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`]).status !== 0; i++) await new Promise(r => setTimeout(r, 100));
    const out = ps(`[IO.File]::WriteAllText((Join-Path $env:TMPDIR 'chain.sh'), (Get-WslChainScript 'localhost' ${port})); Write-Output ('DIR=' + $env:TMPDIR)`);
    const dir = /DIR=(\S+)/.exec(out)![1];
    let text = "";
    for (let i = 0; i < 30 && !text.includes("BEGIN CERTIFICATE"); i++) {
      text = bash(`bash ${dir}/chain.sh`, { PATH: process.env.PATH ?? "" }).stdout;
      if (!text.includes("BEGIN CERTIFICATE")) await new Promise(r => setTimeout(r, 200));
    }
    writeFileSync(join(dir, "chain.txt"), text);
    const parsed = ps(`$chain = ConvertFrom-PemChain ([IO.File]::ReadAllText('${join(dir, "chain.txt")}')); Write-Output ('N=' + $chain.Count + ' S=' + $chain[0].Subject + ' I=' + $chain[0].Issuer)`);
    expect(parsed).toContain("N=1 S=CN=localhost I=CN=AgEnD Test Inspection Root, O=AgEnD Test");
    // No openssl: says so, imports nothing.
    expect(bash(`. ${dir}/chain.sh`, { PATH: "/nonexistent" }).stdout).toBe("CHAIN_NO_OPENSSL\n");
    expect(() => ps("Get-WslChainScript 'a b;rm -rf /'")).toThrow(/Invalid host name/);
  });

  it("the import script: writes only the fingerprinted cert and runs update-ca-certificates; a wrong fingerprint writes nothing; profile.d is its own script", () => {
    const fp = sha256("root");
    const out = ps(`
$cert = (ConvertFrom-PemChain ([IO.File]::ReadAllText('${join(c, "root.pem")}')))[0]
[IO.File]::WriteAllText((Join-Path $env:TMPDIR 'ok.sh'), (Get-WslOrgCaImportScript $cert '${fp.toUpperCase()}'))
[IO.File]::WriteAllText((Join-Path $env:TMPDIR 'bad.sh'), (Get-WslOrgCaImportScript $cert '${"0".repeat(64)}'))
[IO.File]::WriteAllText((Join-Path $env:TMPDIR 'profile.sh'), (Get-WslOrgCaProfileScript (Get-OrgCaPath '${fp.toUpperCase()}')))
Write-Output ('PATH=' + (Get-OrgCaPath '${fp.toUpperCase()}'))
Write-Output ('DIR=' + $env:TMPDIR)`);
    const dir = /DIR=(\S+)/.exec(out)![1];
    expect(out).toContain(`PATH=/usr/local/share/ca-certificates/agend-org-root-${fp.slice(0, 8)}.crt`);
    const fake = scratch();
    mkdirSync(join(fake, "bin")); mkdirSync(join(fake, "etc", "profile.d"), { recursive: true });
    writeFileSync(join(fake, "bin", "update-ca-certificates"), `#!/bin/sh\necho ran >> ${fake}/updated\necho '1 added, 0 removed; done.'\n`);
    chmodSync(join(fake, "bin", "update-ca-certificates"), 0o755);
    const map = (f: string) => readFileSync(join(dir, f), "utf8").replaceAll("/usr/local/share/ca-certificates", join(fake, "ca")).replaceAll("/etc/profile.d", join(fake, "etc", "profile.d"));
    const env = { PATH: `${join(fake, "bin")}:/usr/bin:/bin` };
    const bad = bash(map("bad.sh"), env);
    expect(bad.status).toBe(3);
    expect(bad.stderr).toContain("certificate fingerprint mismatch");
    expect(existsSync(join(fake, "ca"))).toBe(false);
    expect(existsSync(join(fake, "updated"))).toBe(false);
    const ok = bash(map("ok.sh"), env);
    expect(ok.status, ok.stderr).toBe(0);
    const caFile = join(fake, "ca", `agend-org-root-${fp.slice(0, 8)}.crt`);
    expect(ok.stdout).toContain(`CA_IMPORTED=${caFile}`);
    expect(readFileSync(caFile, "utf8")).toBe(pem("root").replace(/\r\n/g, "\n"));
    expect(statSync(caFile).mode & 0o777).toBe(0o644);
    expect(readFileSync(join(fake, "updated"), "utf8")).toBe("ran\n");
    expect(existsSync(join(fake, "etc", "profile.d", "agend-org-ca.sh"))).toBe(false);          // only after .env agrees
    const prof = bash(map("profile.sh"), env);
    expect(prof.stdout).toBe("PROFILE_OK\n");
    expect(readFileSync(join(fake, "etc", "profile.d", "agend-org-ca.sh"), "utf8")).toBe(`export NODE_EXTRA_CA_CERTS=${join(fake, "ca", `agend-org-root-${fp.slice(0, 8)}.crt`)}\n`);
    expect(() => ps("Get-WslOrgCaProfileScript '/tmp/x.crt'")).toThrow(/Invalid certificate path/);
  });

  it("the .env script: adds the line keeping every other line, never replaces another value, refuses a symlinked .env", () => {
    const ca = "/usr/local/share/ca-certificates/agend-org-root-0123abcd.crt";
    const out = ps(`[IO.File]::WriteAllText((Join-Path $env:TMPDIR 'env.sh'), (Get-WslOrgCaEnvScript '${ca}')); Write-Output ('DIR=' + $env:TMPDIR)`);
    const script = readFileSync(join(/DIR=(\S+)/.exec(out)![1], "env.sh"), "utf8");
    expect(() => ps("Get-WslOrgCaEnvScript '/etc/passwd'")).toThrow(/Invalid certificate path/);

    const fresh = scratch();
    let r = bash(script, { HOME: fresh });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(fresh, ".agend", ".env"), "utf8")).toBe(`NODE_EXTRA_CA_CERTS=${ca}\n`);
    expect(statSync(join(fresh, ".agend", ".env")).mode & 0o777).toBe(0o600);
    expect(statSync(join(fresh, ".agend")).mode & 0o777).toBe(0o700);
    r = bash(script, { HOME: fresh });                                       // again: unchanged
    expect(r.stdout).toBe("ENV_OK\n");
    expect(readFileSync(join(fresh, ".agend", ".env"), "utf8")).toBe(`NODE_EXTRA_CA_CERTS=${ca}\n`);

    const kept = scratch(); mkdirSync(join(kept, "home"), { recursive: true });
    writeFileSync(join(kept, "home", ".env"), "TELEGRAM_BOT_TOKEN=x\n# note\nOTHER=1");   // no final newline; AGEND_HOME honoured
    r = bash(script, { HOME: kept, AGEND_HOME: join(kept, "home") });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(kept, "home", ".env"), "utf8")).toBe(`TELEGRAM_BOT_TOKEN=x\n# note\nOTHER=1\nNODE_EXTRA_CA_CERTS=${ca}\n`);

    for (const line of ['export NODE_EXTRA_CA_CERTS="/etc/ssl/corp.pem"', "NODE_EXTRA_CA_CERTS = '/etc/ssl/corp.pem'"]) {
      const theirs = scratch(); mkdirSync(join(theirs, ".agend"));
      writeFileSync(join(theirs, ".agend", ".env"), `A=1\n${line}\n`);
      r = bash(script, { HOME: theirs });
      expect(r.stdout).toBe("ENV_KEPT=/etc/ssl/corp.pem\n");
      expect(readFileSync(join(theirs, ".agend", ".env"), "utf8")).toBe(`A=1\n${line}\n`);
    }

    const link = scratch(); mkdirSync(join(link, ".agend")); writeFileSync(join(link, "target"), "A=1\n");
    symlinkSync(join(link, "target"), join(link, ".agend", ".env"));
    r = bash(script, { HOME: link });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("refusing symlinked");
    expect(readFileSync(join(link, "target"), "utf8")).toBe("A=1\n");
    expect(lstatSync(join(link, ".agend", ".env")).isSymbolicLink()).toBe(true);
  });

  /** Invoke-OrgRootOffer with WSL stubbed: the chain is the given PEMs, the verify script runs for real. */
  function offer(chain: string[], roots: string[], answer: string, envText = "ENV_OK=/root/.agend/.env", envCode = 0): string {
    const chainFile = join(scratch(), "chain.pem");
    writeFileSync(chainFile, chain.map(pem).join(""));
    return ps(`
$AGEND_USER = 'agenduser'
$env:WSLENV = 'USERPROFILE/p:NODE_EXTRA_CA_CERTS/u'
$script:calls = @()
function Get-WindowsRootCerts { return ${roots.length ? store(...roots) : "@()"} }
function Read-Host { param($p) Write-Host "ASKED: $p"; return '${answer}' }
function Invoke-WslScriptText { param($distro, $user, $script, $timeoutSeconds)
  if ($script -match 'openssl s_client') { $script:calls += "chain:$user"; return @{ Code = 0; Text = [IO.File]::ReadAllText('${chainFile}') } }
  if ($script -match 'openssl verify') { $script:calls += "verify:$user"; $f = Join-Path $env:TMPDIR 'v.sh'; [IO.File]::WriteAllText($f, $script); return @{ Code = 0; Text = (& bash $f) -join "\`n" } }
  if ($script -match 'update-ca-certificates') { $script:calls += "import:$user"; $script:importScript = $script; return @{ Code = 0; Text = "1 added\`nCA_IMPORTED=" + ([regex]::Match($script, '(?m)^f=(\\S+)$').Groups[1].Value) } }
  if ($script -match 'PROFILE_OK') { $script:calls += "profile:$user"; return @{ Code = 0; Text = 'PROFILE_OK' } }
  if ($script -match 'NODE_EXTRA_CA_CERTS=%s') { $script:calls += "env:$user"; return @{ Code = ${envCode}; Text = '${envText}' } }
  throw "unexpected script"
}
$r = Invoke-OrgRootOffer 'AgEnD' 'songsid.github.io'
Write-Output ('RESULT=' + $r)
Write-Output ('CALLS=' + ($script:calls -join ','))
Write-Output ('NODE_EXTRA_CA_CERTS=' + $env:NODE_EXTRA_CA_CERTS)
Write-Output ('WSLENV=' + $env:WSLENV)`, { NODE_EXTRA_CA_CERTS: "" });
  }

  it("the root is in Windows and the person says y: shown (name, fingerprint, store), one cert imported, .env and this run's WSLENV set", () => {
    const fp = sha256("root").toUpperCase();
    const out = offer(["leaf"], ["other", "imp", "root"], "y");
    expect(out).toContain("名稱：CN=AgEnD Test Inspection Root, O=AgEnD Test");
    const pairs = fp.match(/../g)!;
    expect(out).toContain(`SHA-256 指紋：${pairs.slice(0, 16).join(":")}`);
    expect(out).toContain(`                  ${pairs.slice(16).join(":")}`);
    expect(out).toContain("位置：Windows 憑證存放區 LocalMachine\\Root");
    expect(out).toContain("不會關掉憑證檢查，也不會匯入其他憑證。");
    expect(out).toContain("ASKED:   要匯入這一張憑證嗎？(y/N)");
    expect(out).toContain("CALLS=chain:root,verify:root,import:root,env:agenduser,profile:root\n");
    const path = `/usr/local/share/ca-certificates/agend-org-root-${fp.slice(0, 8).toLowerCase()}.crt`;
    expect(out).toContain(`已匯入公司根憑證：CN=AgEnD Test Inspection Root, O=AgEnD Test（SHA-256 ${fp}）`);
    expect(out).toContain("AgEnD 的 .env 已設定 NODE_EXTRA_CA_CERTS");
    expect(out).toContain(`NODE_EXTRA_CA_CERTS=${path}`);
    expect(out).toContain("WSLENV=USERPROFILE/p:NODE_EXTRA_CA_CERTS");                // replaced, not doubled; passed as is
    expect(out).toContain("RESULT=True");
  });

  it("an existing NODE_EXTRA_CA_CERTS elsewhere stays the effective one: no profile.d, no session override; a failed .env write sets neither (Prism #3071)", () => {
    let out = offer(["leaf"], ["root"], "y", "ENV_KEPT=/etc/ssl/corp-bundle.pem");
    expect(out).toContain("CALLS=chain:root,verify:root,import:root,env:agenduser\n");
    expect(out).toContain("沒有改它，也不會用新的憑證蓋過它");
    expect(out).toContain("    /etc/ssl/corp-bundle.pem");
    expect(out).toContain("NODE_EXTRA_CA_CERTS=\n");
    expect(out).toContain("WSLENV=USERPROFILE/p:NODE_EXTRA_CA_CERTS/u\n");                  // untouched
    expect(out).toContain("RESULT=True");                                                     // curl/apt now trust it: check again
    out = offer(["leaf"], ["root"], "y", "refusing symlinked /root/.agend/.env", 1);
    expect(out).toContain("CALLS=chain:root,verify:root,import:root,env:agenduser\n");
    expect(out).toContain("沒能把 NODE_EXTRA_CA_CERTS 寫進 AgEnD 的 .env");
    expect(out).toContain("NODE_EXTRA_CA_CERTS=\n");
  });

  it("consent defaults to no: nothing imported, nothing set", () => {
    for (const answer of ["", "n", "yes please"]) {
      const out = offer(["leaf"], ["root"], answer);
      expect(out).toContain("ASKED:");
      expect(out).toContain("沒有匯入。");
      expect(out).toContain("CALLS=chain:root,verify:root\n");
      expect(out).toContain("NODE_EXTRA_CA_CERTS=\n");
      expect(out).toContain("RESULT=False");
    }
  });

  it("the negative cases: root not in Windows, or only a same-name root that cannot verify — not asked, nothing imported", () => {
    let out = offer(["leaf"], ["other"], "y");
    expect(out).toContain("Windows 信任的根憑證裡沒有同一張，所以不會自動匯入");
    expect(out).toContain("    CN=AgEnD Test Inspection Root, O=AgEnD Test");
    expect(out).not.toContain("ASKED:");
    expect(out).toContain("CALLS=chain:root\n");
    expect(out).toContain("RESULT=False");
    out = offer(["leafnoaki"], ["imp"], "y");
    expect(out).toContain("它驗證不了這個連線出示的憑證，所以不會匯入");
    expect(out).not.toContain("ASKED:");
    expect(out).toContain("CALLS=chain:root,verify:root\n");
    out = offer([], ["root"], "y");
    expect(out).toContain("讀不出這個連線出示的憑證");
    expect(out).toContain("RESULT=False");
  });

  it("Test-WslNetwork: a required host failing TLS offers the import, then checks again; declined or not found keeps the manual text", () => {
    const run = (offered: string) => ps(`
$script:probes = 0
function Get-WslNetResults { param($d) $script:probes++
  $kind = if ($script:probes -eq 1) { 'tls' } else { $null }
  return @(@{ Host = 'songsid.github.io'; Why = 'AgEnD 安裝程式'; Required = $true; Kind = $kind }, @{ Host = 'claude.ai'; Why = 'Claude Code'; Required = $false; Kind = $null }) }
function Invoke-OrgRootOffer { param($d, $h) Write-Host "OFFER $d $h"; return $${offered} }
function Get-WindowsProxy { return $null }
function Read-Host { param($p) Write-Host "ASKED: $p"; return '' }
Write-Output ('OK=' + (Test-WslNetwork 'AgEnD'))
Write-Output ('PROBES=' + $script:probes)`);
    let out = run("true");
    expect(out).toContain("WSL 裡連 songsid.github.io 時，HTTPS 憑證不被信任");
    expect(out).toContain("OFFER AgEnD songsid.github.io");
    expect(out).toContain("重新檢查 WSL 裡的網路連線");
    expect(out).toContain("WSL 裡 的網路連線正常");
    expect(out).toContain("PROBES=2");
    expect(out).toContain("OK=True");
    out = run("false");
    expect(out).toContain("PROBES=1");
    expect(out).toContain("放到 Ubuntu 的 /usr/local/share/ca-certificates/，");
    expect(out).toContain("ASKED:   安裝需要上面這些網站，現在多半會失敗。還是要繼續嗎？(y/N)");
    expect(out).toContain("OK=False");
  });

  it("Restore-OrgCaSessionEnv: a previous import is carried into this run only while AgEnD's .env uses it or sets nothing (Prism #3071)", () => {
    const ca = "/usr/local/share/ca-certificates/agend-org-root-0123abcd.crt";
    const out0 = ps(`[IO.File]::WriteAllText((Join-Path $env:TMPDIR 'r.sh'), (Get-WslOrgCaRestoreScript)); Write-Output ('DIR=' + $env:TMPDIR)`);
    const script = readFileSync(join(/DIR=(\S+)/.exec(out0)![1], "r.sh"), "utf8");
    // The reader, for real: the profile line and the .env's current value.
    const home = scratch(); mkdirSync(join(home, "etc", "profile.d"), { recursive: true }); mkdirSync(join(home, ".agend"));
    writeFileSync(join(home, "etc", "profile.d", "agend-org-ca.sh"), `export NODE_EXTRA_CA_CERTS=${ca}\n`);
    writeFileSync(join(home, ".agend", ".env"), "A=1\nexport NODE_EXTRA_CA_CERTS='/etc/ssl/corp-bundle.pem'\n");
    const read = bash(script.replaceAll("/etc/profile.d", join(home, "etc", "profile.d")), { HOME: home });
    expect(read.stdout).toBe(`export NODE_EXTRA_CA_CERTS=${ca}\nENV=/etc/ssl/corp-bundle.pem\n`);
    const run = (text: string) => ps(`
$AGEND_USER = 'agenduser'
function Invoke-WslScriptText { param($distro, $user, $script, $t) Write-Host ('RUN=' + $distro + ' ' + $user); return @{ Code = 0; Text = "${text}" } }
$env:WSLENV = ''
Restore-OrgCaSessionEnv 'AgEnD'
Write-Output ('NODE_EXTRA_CA_CERTS=' + $env:NODE_EXTRA_CA_CERTS + ' WSLENV=' + $env:WSLENV)`, { NODE_EXTRA_CA_CERTS: "" });
    let out = run(`export NODE_EXTRA_CA_CERTS=${ca}\`nENV=`);
    expect(out).toContain("RUN=AgEnD agenduser");
    expect(out).toContain(`NODE_EXTRA_CA_CERTS=${ca} WSLENV=NODE_EXTRA_CA_CERTS`);
    out = run(`export NODE_EXTRA_CA_CERTS=${ca}\`nENV=${ca}`);
    expect(out).toContain(`NODE_EXTRA_CA_CERTS=${ca} WSLENV=NODE_EXTRA_CA_CERTS`);
    for (const text of [`export NODE_EXTRA_CA_CERTS=${ca}\`nENV=/etc/ssl/corp-bundle.pem`, "ENV=", "export NODE_EXTRA_CA_CERTS=/tmp/evil.crt`nENV="]) {
      expect(run(text)).toContain("NODE_EXTRA_CA_CERTS= WSLENV=\n");
    }
  });
});
