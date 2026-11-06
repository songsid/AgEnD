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
 */
export function runtimeInstallCommand(server, scriptSha256) {
  const origin = safeRuntimeOrigin(server);
  if (!origin || typeof scriptSha256 !== "string" || !/^[a-f0-9]{64}$/.test(scriptSha256)) return "";
  return `$agend = '${origin}'; $s = $null; $s = (iwr "$agend/runtime/install.ps1" -UseBasicParsing).Content; `
    + `if (-not $s -or (-join ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($s)) | % { $_.ToString('x2') })) -ne '${scriptSha256}') `
    + `{ throw 'install.ps1 could not be verified against the hash on the AgEnD page; reload the page and copy the command again' }; iex $s`;
}
/** After the install script: agend-runtime is on the user's PATH. The pairing code is typed into the terminal, never here. */
export function runtimeWindowsConnectCommand(server) {
  const origin = safeRuntimeOrigin(server);
  return origin ? `agend-runtime connect --server "${origin}"` : "";
}
