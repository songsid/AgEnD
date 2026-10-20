# AgEnD for Windows: the one-line installer (#1853).
#
#   powershell -ExecutionPolicy ByPass -c "irm https://songsid.github.io/AgEnD/install.ps1 | iex"
#
# This file is run with `irm ... | iex`, so it is kept safe for that: ASCII only (Windows PowerShell 5.1 may decode a
# download as the wrong code page), no param block, and no `exit` (under iex it would close the window). It downloads
# the real installer, install-agend.ps1, to a temporary file - its bytes as served, UTF-8 BOM included, so its
# Chinese prompts display correctly - checks it, and runs it in its own PowerShell as Administrator (it enables WSL):
# one UAC prompt opens it in a new window. -ExecutionPolicy Bypass applies to that one process; the execution policy
# you have set is never changed.
#
# After the reboot WSL asks for, the installer carries on by itself once you log back in (a one-time RunOnce entry
# runs this same line); if it does not, paste the same line again: it resumes where it stopped.
# To run every stage again (install-agend.ps1 -Force), set this first, in the same PowerShell window:
#   $env:AGEND_INSTALL_FORCE = '1'
& {
    $ErrorActionPreference = 'Stop'

    # Where install-agend.ps1 comes from. Tests point it at a local server; anything else must be https.
    $base = 'https://songsid.github.io/AgEnD'
    if ($env:AGEND_INSTALL_BASE) { $base = $env:AGEND_INSTALL_BASE.TrimEnd('/') }
    if ($base -notmatch '^https://' -and $base -notmatch '^http://(127\.0\.0\.1|localhost)(:\d+)?(/|$)') {
        Write-Host "AgEnD: refusing to download the installer from $base (https only)." -ForegroundColor Red
        return
    }

    $onWindows = ($PSVersionTable.PSEdition -eq 'Desktop') -or ($IsWindows -eq $true)
    $shell = 'powershell.exe'
    if ($env:AGEND_INSTALL_SHELL) { $shell = $env:AGEND_INSTALL_SHELL }

    # Windows PowerShell 5.1 may still default to TLS 1.0, which GitHub Pages refuses.
    if ($PSVersionTable.PSEdition -eq 'Desktop') {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    }

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('install-agend-' + [Guid]::NewGuid().ToString('N') + '.ps1')
    try {
        Write-Host "AgEnD: downloading the installer from $base/install-agend.ps1 ..."
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "$base/install-agend.ps1" -OutFile $tmp
        } catch {
            Write-Host "AgEnD: the download failed: $($_.Exception.Message)" -ForegroundColor Red
            Write-Host "Check your internet connection, then run the same command again."
            return
        }

        # What arrived must be the installer: UTF-8 with its BOM, and its own admin check (not an error page).
        $bytes = [IO.File]::ReadAllBytes($tmp)
        $text = [Text.Encoding]::UTF8.GetString($bytes)
        $bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
        if ($bytes.Length -lt 1024 -or -not $bom -or $text -notmatch 'function Check-Admin') {
            Write-Host "AgEnD: the downloaded file is not the AgEnD installer ($($bytes.Length) bytes). Nothing was run." -ForegroundColor Red
            Write-Host "Try again later, or download install-agend.ps1 from the install page and run it by hand."
            return
        }

        $installerArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $tmp)
        if ($env:AGEND_INSTALL_FORCE -match '^(1|true|yes)$') { $installerArgs += '-Force' }

        $admin = $false
        if ($onWindows) {
            $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
            $admin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        }

        if (-not $onWindows -or $admin) {
            # Already Administrator (or not Windows: tests): run it here, in this window.
            & $shell @installerArgs
            $code = $LASTEXITCODE
        } else {
            Write-Host "AgEnD: the installer needs Administrator rights (it enables WSL). Approve the Windows prompt;"
            Write-Host "it opens in a new window, and this one waits for it."
            # Start-Process joins its arguments with spaces: the temporary path is quoted for a user name with spaces.
            $quoted = $installerArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }
            try {
                $proc = Start-Process -FilePath $shell -ArgumentList $quoted -Verb RunAs -Wait -PassThru
                $code = $proc.ExitCode
            } catch {
                Write-Host "AgEnD: Administrator approval was declined, so nothing was installed." -ForegroundColor Yellow
                Write-Host "Run the same command again and choose Yes, or open PowerShell as Administrator and paste it there."
                return
            }
        }
        if ($code -ne 0) { Write-Host "AgEnD: the installer ended with code $code. See its window for why." -ForegroundColor Yellow }
        else { Write-Host "AgEnD: the installer finished. If it asked you to restart Windows, run the same command again afterwards." }
    } finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
}
