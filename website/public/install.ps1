# AgEnD for Windows: the one-line installer (#1853).
#
#   powershell -ExecutionPolicy ByPass -c "irm https://songsid.github.io/AgEnD/install.ps1 | iex"
#
# This file is run with `irm ... | iex`, so it is kept safe for that: ASCII only (Windows PowerShell 5.1 may decode a
# download as the wrong code page), no param block, and no `exit` (under iex it would close the window). It downloads
# the real installer, install-agend.ps1, to a temporary file - its bytes as served, UTF-8 BOM included, so its
# Chinese prompts display correctly - checks it, and runs it in its own PowerShell as Administrator (it enables WSL):
# one UAC prompt opens it in a new window, in Windows Terminal when it is installed (AGEND_INSTALL_TERMINAL=conhost:
# the classic PowerShell window). -ExecutionPolicy Bypass applies to that one process; the execution policy
# you have set is never changed.
#
# After the reboot WSL asks for, the installer carries on by itself once you log back in (a one-time RunOnce entry
# runs this same line); if it does not, paste the same line again: it resumes where it stopped.
# To run every stage again (install-agend.ps1 -Force), set this first, in the same PowerShell window:
#   $env:AGEND_INSTALL_FORCE = '1'
& {
    $ErrorActionPreference = 'Stop'

    function Resolve-AgendInstallVersion([string]$value) {
        if ($value -eq '') { return '' }
        if ($value.Length -gt 128 -or -not [regex]::IsMatch($value, '\A(?:beta|latest|(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)\z')) {
            throw 'AGEND_VERSION must be beta, latest, or an exact semantic version (for example 2.3.2-beta.5).'
        }
        return $value
    }
    $installVersion = Resolve-AgendInstallVersion ([string]$env:AGEND_VERSION)

    # The elevated window. With Windows Terminal (wt.exe, its app alias) it opens there, not in the old console host,
    # whose fonts and encodings handle Chinese poorly; AGEND_INSTALL_TERMINAL=conhost keeps the old window. wt.exe hands
    # the tab to WindowsTerminal.exe and returns at once, so it cannot report the installer's exit code: a small wrapper
    # (UTF-8 with BOM: the temporary path may hold a non-ASCII user name) runs the installer and writes its code to
    # <tmp>.code, and this window waits for that file. The wrapper first creates <tmp>.started (CreateNew) holding its
    # PID, then looks for <tmp>.cancel: if that tab never starts, this window creates <tmp>.cancel and only falls back
    # when it still sees no <tmp>.started, so the installer never runs twice. A tab closed early leaves .started
    # without .code and a process that is gone, or a .started still empty after a short grace (the wrapper died between
    # creating it and writing its PID). A declined UAC prompt is final; any other wt failure falls back to the
    # old window. Returns @{ Outcome = 'done' | 'declined' | 'closed'; Code }.
    function Start-ElevatedInstaller([string]$shell, [string[]]$installerArgs, [string]$tmp, [string]$terminal, [int]$startTimeoutSec = 90, [int]$claimGraceSec = 10) {
        $versionArg = ''
        $versionIndex = [array]::IndexOf($installerArgs, '-InstallVersion')
        if ($versionIndex -ge 0) {
            $version = Resolve-AgendInstallVersion $installerArgs[$versionIndex + 1]
            $versionArg = " -InstallVersion '$version'"
        }
        $declinedError = { $e = $args[0].Exception; while ($e) { if ($e.NativeErrorCode -eq 1223) { return $true }; $e = $e.InnerException }; return $false }
        $wt = $null
        if ($terminal -ne 'conhost') { $wt = Get-Command -Name 'wt.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 }
        if ($wt) {
            $sq = { "'" + ($args[0] -replace "'", "''") + "'" }
            $done = "$tmp.code"; $started = "$tmp.started"; $cancel = "$tmp.cancel"; $wrapper = "$tmp.wt.ps1"
            $force = ''
            if ($installerArgs -contains '-Force') { $force = ' -Force' }
            $lines = @(
                "`$started = $(& $sq $started); `$cancel = $(& $sq $cancel); `$done = $(& $sq $done)",
                "try { `$f = [IO.File]::Open(`$started, 'CreateNew', 'Write'); `$b = [Text.Encoding]::ASCII.GetBytes([string]`$PID); `$f.Write(`$b, 0, `$b.Length); `$f.Close() } catch { return }",
                "if (Test-Path -LiteralPath `$cancel) { return }",
                "& $(& $sq $tmp)$force$versionArg",
                "`$c = `$LASTEXITCODE; if (`$null -eq `$c) { `$c = 0 }",
                "[IO.File]::WriteAllText(`$done + '.tmp', [string]`$c); Move-Item -LiteralPath (`$done + '.tmp') -Destination `$done -Force"
            )
            $launched = $false
            try {
                [IO.File]::WriteAllText($wrapper, ($lines -join "`r`n"), (New-Object Text.UTF8Encoding $true))
                # wt.exe reads ';' as its own command separator: escaped as '\;'. The shell (AGEND_INSTALL_SHELL may be a path
                # with spaces) and the wrapper path are quoted.
                $path = '"' + ($wrapper -replace ';', '\;') + '"'
                $shellArg = '"' + ($shell -replace ';', '\;') + '"'
                $null = Start-Process -FilePath $wt.Source -ArgumentList @('-w', 'new', $shellArg, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $path) -Verb RunAs
                $launched = $true
            } catch {
                if (& $declinedError $_) { return @{ Outcome = 'declined'; Code = $null } }
                Write-Host "AgEnD: Windows Terminal could not open the installer ($($_.Exception.Message)); using a PowerShell window." -ForegroundColor Yellow
            }
            if ($launched) {
                Write-Host "AgEnD: the installer is running in Windows Terminal. Press Ctrl+C here only to stop waiting; it keeps running there."
                $deadline = (Get-Date).AddSeconds($startTimeoutSec)
                $giveUp = $false; $claimSeen = $null
                # The code, once it is there whole (the wrapper renames it into place); an unreadable one is no code.
                $readCode = { $t = ''; try { $t = [IO.File]::ReadAllText($done).Trim() } catch { }; $v = 0; if ([int]::TryParse($t, [ref]$v)) { return $v }; return $null }
                try {
                    while ($true) {
                        if (Test-Path -LiteralPath $done) { $n = & $readCode; if ($null -ne $n) { return @{ Outcome = 'done'; Code = $n } } }
                        if (Test-Path -LiteralPath $started) {
                            $owner = 0
                            try { $null = [int]::TryParse([IO.File]::ReadAllText($started).Trim(), [ref]$owner) } catch { }
                            if ($owner -gt 0) {
                                if (-not (Get-Process -Id $owner -ErrorAction SilentlyContinue)) {
                                    Start-Sleep -Milliseconds 500
                                    $n = $null; if (Test-Path -LiteralPath $done) { $n = & $readCode }
                                    if ($null -ne $n) { return @{ Outcome = 'done'; Code = $n } }
                                    return @{ Outcome = 'closed'; Code = $null }
                                }
                            } elseif ($null -eq $claimSeen) { $claimSeen = Get-Date }
                            elseif (((Get-Date) - $claimSeen).TotalSeconds -gt $claimGraceSec) { return @{ Outcome = 'closed'; Code = $null } }
                        } elseif ((Get-Date) -gt $deadline) {
                            try { [IO.File]::Open($cancel, 'CreateNew', 'Write').Close() } catch { }
                            if (-not (Test-Path -LiteralPath $started)) { $giveUp = $true; break }
                        }
                        Start-Sleep -Milliseconds 500
                    }
                } finally {
                    if (-not $giveUp) { foreach ($f in @($done, "$done.tmp", $started, $cancel)) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue } }
                }
                Write-Host "AgEnD: the installer did not start in Windows Terminal; using a PowerShell window." -ForegroundColor Yellow
            }
        }
        # Start-Process joins its arguments with spaces: the temporary path is quoted for a user name with spaces.
        $quoted = $installerArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }
        try {
            $proc = Start-Process -FilePath $shell -ArgumentList $quoted -Verb RunAs -Wait -PassThru
            return @{ Outcome = 'done'; Code = $proc.ExitCode }
        } catch {
            return @{ Outcome = 'declined'; Code = $null }
        }
    }

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
        if ($installVersion) { $installerArgs += @('-InstallVersion', $installVersion) }
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
            $terminal = 'auto'
            if ($env:AGEND_INSTALL_TERMINAL) { $terminal = $env:AGEND_INSTALL_TERMINAL.Trim().ToLowerInvariant() }
            $result = Start-ElevatedInstaller $shell $installerArgs $tmp $terminal
            if ($result.Outcome -eq 'declined') {
                Write-Host "AgEnD: Administrator approval was declined, so nothing was installed." -ForegroundColor Yellow
                Write-Host "Run the same command again and choose Yes, or open PowerShell as Administrator and paste it there."
                return
            }
            if ($result.Outcome -eq 'closed') {
                Write-Host "AgEnD: the installer window was closed before it finished." -ForegroundColor Yellow
                Write-Host "Run the same command again: it carries on where it stopped."
                return
            }
            $code = $result.Code
        }
        if ($code -ne 0) { Write-Host "AgEnD: the installer ended with code $code. See its window for why." -ForegroundColor Yellow }
        else { Write-Host "AgEnD: the installer finished. If it asked you to restart Windows, run the same command again afterwards." }
    } finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
}
