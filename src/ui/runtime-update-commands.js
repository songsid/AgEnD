import { runtimeInstallCommand } from "./runtime-commands.js";

/** Reuse the existing pinned installer; refuse rather than silently reuse an old/shared root. */
export function runtimeFreshInstallCommand(server, scriptSha256) {
  const command = runtimeInstallCommand(server, scriptSha256);
  if (!command) return "";
  return `$agendFresh = $null; $agendFresh = Join-Path $env:LOCALAPPDATA ('agend-runtime-' + [Guid]::NewGuid().ToString('N')); `
    + `if ($agendFresh -and -not (Test-Path -LiteralPath $agendFresh)) { $env:AGEND_RUNTIME_INSTALL_DIR = $agendFresh; `
    + `if ($env:AGEND_RUNTIME_INSTALL_DIR -eq $agendFresh) { ${command} } else { throw 'A fresh Runtime folder could not be selected' } } `
    + `else { throw 'A fresh Runtime folder could not be selected' }`;
}
