/**
 * The commands Settings -> Runtime -> Connect a computer offers to copy. Pure functions, no DOM and no network, so the page and the tests
 * build exactly the same text.
 *
 * A command only ever contains: the origin the administrator reviewed in step 1 (inert host and port characters, https or loopback
 * http), and, for the install command, the SHA-256 of install.ps1 that the AgEnD server itself reported to this signed-in page. No
 * pairing code, token, credential or flag the page did not choose is ever put in one.
 */

/** The origin, only when it is composed of inert hostname/port characters; "" otherwise. Nothing else is placed in a copyable shell command. */
export function safeRuntimeOrigin(server) {
  try {
    const url = new URL(server);
    const local = ["localhost","127.0.0.1","[::1]"].includes(url.hostname);
    if (!/^([a-z0-9.-]+|\[[a-f0-9:]+\])$/i.test(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || !(url.protocol === "https:" || url.protocol === "http:" && local)) return "";
    return url.origin;
  } catch { return ""; }
}
/** ZIP flow: run from the extracted folder. */
export function runtimeConnectCommand(server) {
  const origin = safeRuntimeOrigin(server);
  return origin ? `.\\agend-runtime.cmd connect --server "${origin}"` : "";
}
/**
 * Windows one-line install. The script and its bundle come from the same server over the same TLS channel, so a hash inside the script
 * cannot vouch for the script. This page is the trust anchor: the command downloads install.ps1, hashes the bytes it received, compares
 * the result with the SHA-256 shown here and runs the text (iex) only when they are equal. A copy that was modified, or fetched from
 * another server, is refused before anything of it runs, whatever the TLS trust decision was. The address is handed to the script by
 * `$agend`: the script reads it from nowhere else. It never skips certificate validation, and says not to.
 *
 * The rule for every step is that NO FAILURE MAY REACH `iex`. In PowerShell a failing method call is only statement-terminating: the
 * statement is skipped and the next one runs. So `if (<check that can fail>) { throw }; iex $s` is fail-OPEN (in ConstrainedLanguage
 * `[Security.Cryptography.SHA256]::Create()` is refused, the `if` is skipped, and the unverified script runs). Here:
 *   - `$s` and `$h` are reset to $null first, so a failed download or a failed hash leaves nothing from an earlier command to act on;
 *   - the hash is computed into `$h` in a statement of its own, so a failure there leaves `$h` null;
 *   - the condition is only `$s -and $h -eq '<hex>'` (no method call that could throw), and `iex` is inside the branch it passes: when
 *     anything above failed, `$h` is null, the condition is false, and the else branch says why and throws. (The message is written with
 *     Write-Host first because under `$ErrorActionPreference = 'SilentlyContinue'` a bare `throw` is swallowed and prints nothing; the
 *     script still does not run, as `iex` is not in that branch.)
 *   - the first statement (TLS 1.2, which Windows PowerShell 5.1 may not offer by default) touches nothing the check depends on: if it
 *     fails, the rest still runs and the rest still refuses.
 * This differs from the shape in the upstream design review (`if (-not $s -or <hash> -ne …) { throw }; iex $s`) for exactly that reason.
 */
export function runtimeInstallCommand(server, scriptSha256) {
  const origin = safeRuntimeOrigin(server);
  if (!origin || typeof scriptSha256 !== "string" || !/^[a-f0-9]{64}$/.test(scriptSha256)) return "";
  return `[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; `
    + `$agend = '${origin}'; $s = $null; $h = $null; `
    + `$s = (iwr "$agend/runtime/install.ps1" -UseBasicParsing).Content; `
    + `$h = (-join ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($s)) | % { $_.ToString('x2') })); `
    + `if ($s -and $h -eq '${scriptSha256}') { iex $s } `
    + `else { Write-Host 'install.ps1 could not be verified against the hash on the AgEnD page (a certificate or download error above is the usual cause: trust this AgEnD certificate, or use the ZIP; otherwise reload the page and copy the command again)' -ForegroundColor Red; throw 'install.ps1 was not run' }`;
}
/** After the install script: agend-runtime is on the user's PATH. The pairing code is typed into the terminal, never here. */
export function runtimeWindowsConnectCommand(server) {
  const origin = safeRuntimeOrigin(server);
  return origin ? `agend-runtime connect --server "${origin}"` : "";
}
