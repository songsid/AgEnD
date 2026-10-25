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

# Stream only installer-owned downloads; both response wait and byte progress are bounded.
function New-InstallDownloadRequest([string]$Uri) { return [Net.WebRequest]::CreateHttp($Uri) }
function Invoke-InstallDownload([string]$Uri, [string]$OutFile, [int]$TimeoutSec = 120, [double]$NoProgressSeconds = 60) {
    $request = New-InstallDownloadRequest $Uri
    $response = $null; $inputStream = $null; $outputStream = $null; $complete = $false
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $wait = {
        $operation = $args[0]
        $left = [Math]::Min($NoProgressSeconds, $TimeoutSec - $clock.Elapsed.TotalSeconds)
        if ($left -le 0 -or -not $operation.Wait([int][Math]::Max(1, $left * 1000))) { throw 'Download exceeded its operation or no-progress deadline; rerun after checking the network.' }
        return $operation.GetAwaiter().GetResult()
    }
    try {
        $response = & $wait ($request.GetResponseAsync())
        $inputStream = $response.GetResponseStream()
        $outputStream = [IO.File]::Open($OutFile, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $buffer = New-Object byte[] 65536
        while ($true) {
            $count = & $wait ($inputStream.ReadAsync($buffer, 0, $buffer.Length))
            if ($count -eq 0) { break }
            $outputStream.Write($buffer, 0, $count)
        }
        $complete = $true
    } finally {
        $request.Abort()
        if ($outputStream) { $outputStream.Dispose() }; if ($inputStream) { $inputStream.Dispose() }; if ($response) { $response.Dispose() }
        if (-not $complete) { Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue }
    }
}

    function Resolve-AgendInstallVersion([string]$value) {
        if ($value -eq '') { return '' }
        if ($value.Length -gt 128 -or -not [regex]::IsMatch($value, '\A(?:beta|latest|(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)\z')) {
            throw 'AGEND_VERSION must be beta, latest, or an exact semantic version (for example 2.3.2-beta.5).'
        }
        return $value
    }
    $installVersion = Resolve-AgendInstallVersion ([string]$env:AGEND_VERSION)

    # The support files (#2650 item 9). The installer keeps a redacted log of what it showed in
    # %LOCALAPPDATA%\AgEnD\install-logs and a receipt, last.json, with this run's id, its stage, its outcome and the kind of
    # failure. This window cannot see the elevated one, so when it ends badly - a nonzero code, a closed window - it reads
    # the receipt and says which stage stopped and where the log is. What happens before the installer runs (a declined
    # or blocked approval, a removed download) goes to bootstrap.log in the same folder.
    $logDir = $null
    if ($env:LOCALAPPDATA) { $logDir = Join-Path (Join-Path $env:LOCALAPPDATA 'AgEnD') 'install-logs' }
    $runId = [Guid]::NewGuid().ToString('N')
    function Write-BootstrapLog([string]$text) {
        if (-not $logDir) { return }
        try {
            $null = New-Item -ItemType Directory -Path $logDir -Force
            $file = Join-Path $logDir 'bootstrap.log'
            if ((Test-Path -LiteralPath $file) -and (Get-Item -LiteralPath $file).Length -gt 1MB) { Remove-Item -LiteralPath $file -Force }
            [IO.File]::AppendAllText($file, ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + " [$runId] " + $text + "`r`n"))
        } catch { }
    }
    function Show-SupportFile([string]$path) {
        if ($path) { Write-Host "AgEnD: support file (attach it when you report the problem): $path" -ForegroundColor Yellow }
    }
    # This run's receipt, or $null (none, unreadable, or written by another run).
    function Read-InstallReceipt {
        if (-not $logDir) { return $null }
        try {
            $r = [IO.File]::ReadAllText((Join-Path $logDir 'last.json')) | ConvertFrom-Json
            if ([string]$r.run -eq $runId) { return $r }
        } catch { }
        return $null
    }
    # What the elevated launch error was: 'declined' (the UAC prompt was answered No), 'blocked' (a security policy:
    # AppLocker, WDAC, Software Restriction or an administrator's rule), 'quarantined' (antivirus took the file) or 'failed'.
    function Get-LaunchFailure($err) {
        $e = $err.Exception
        while ($e) {
            switch ($e.NativeErrorCode) {
                1223 { return 'declined' }
                { $_ -in 1260, 4551, 786 } { return 'blocked' }
                { $_ -in 225, 226 } { return 'quarantined' }
            }
            $e = $e.InnerException
        }
        return 'failed'
    }

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
        $runIndex = [array]::IndexOf($installerArgs, '-InstallRunId')
        if ($runIndex -ge 0 -and $installerArgs[$runIndex + 1] -match '^[0-9a-f]{32}$') { $versionArg += " -InstallRunId '$($installerArgs[$runIndex + 1])'" }
        $sidIndex = [array]::IndexOf($installerArgs, '-InitiatingSid')
        if ($sidIndex -ge 0 -and $installerArgs[$sidIndex + 1] -match '^S-1-\d+(-\d+)+$') { $versionArg += " -InitiatingSid '$($installerArgs[$sidIndex + 1])'" }
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
                "`$c = `$null; try { & $(& $sq $tmp)$force$versionArg; `$c = `$LASTEXITCODE } catch { Write-Host `$_; `$c = 1 }; if (`$null -eq `$c) { `$c = 0 }",
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
                Write-BootstrapLog ("Windows Terminal launch failed: " + $_.Exception.Message)
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
            return @{ Outcome = (Get-LaunchFailure $_); Code = $null; Error = $_.Exception.Message }
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
            Invoke-InstallDownload -Uri "$base/install-agend.ps1" -OutFile $tmp -TimeoutSec 120
        } catch {
            Write-Host "AgEnD: the download failed: $($_.Exception.Message)" -ForegroundColor Red
            # Say what kind of failure it was (#2650 item 8): a proxy or a company certificate needs IT, not a retry.
            $msg = "$($_.Exception.Message) $($_.Exception.InnerException.Message)"
            if ($msg -match '\(407\)|[Pp]roxy') { Write-Host "A proxy blocked it or wants a sign-in. Check the proxy settings, or ask your IT team." }
            elseif ($msg -match 'SSL|TLS|[Cc]ertificate|trust relationship') { Write-Host "The HTTPS certificate was not trusted: company networks often inspect HTTPS. Ask your IT team; do not turn certificate checks off." }
            elseif ($msg -match 'timed out|[Tt]imeout') { Write-Host "It timed out: the network is slow or a login page (hotel, office) is waiting. Check it, then run the same command again." }
            else { Write-Host "Check your internet connection, then run the same command again." }
            Write-BootstrapLog ("download failed: " + $_.Exception.Message)
            return
        }

        # What arrived must be the installer: UTF-8 with its BOM, and its own admin check (not an error page).
        $bytes = [IO.File]::ReadAllBytes($tmp)
        $text = [Text.Encoding]::UTF8.GetString($bytes)
        $bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
        if ($bytes.Length -lt 1024 -or -not $bom -or $text -notmatch 'function Check-Admin') {
            Write-Host "AgEnD: the downloaded file is not the AgEnD installer ($($bytes.Length) bytes). Nothing was run." -ForegroundColor Red
            Write-Host "Try again later, or download install-agend.ps1 from the install page and run it by hand."
            Write-BootstrapLog ("downloaded file rejected: $($bytes.Length) bytes")
            return
        }
        $validatedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $tmp).Hash

        $installerArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $tmp, '-InstallRunId', $runId)
        if ($installVersion) { $installerArgs += @('-InstallVersion', $installVersion) }
        if ($env:AGEND_INSTALL_FORCE -match '^(1|true|yes)$') { $installerArgs += '-Force' }

        $admin = $false
        if ($onWindows) {
            $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
            $admin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        }

        # Antivirus or a proxy may remove or replace the file after the check above: run only the bytes that were checked.
        $nowHash = $null
        try { $nowHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $tmp -ErrorAction Stop).Hash } catch { }
        if ($nowHash -ne $validatedHash) {
            Write-Host "AgEnD: the downloaded installer was removed or changed before it could run (often antivirus or a security tool). Nothing was installed." -ForegroundColor Red
            Write-Host "Do not turn protection off. Ask your IT team whether install-agend.ps1 from songsid.github.io may run, then run the same command again."
            Write-BootstrapLog 'downloaded installer removed or changed before it ran (quarantine?)'
            Show-SupportFile $(if ($logDir) { Join-Path $logDir 'bootstrap.log' })
            return
        }

        if (-not $onWindows -or $admin) {
            # Already Administrator (or not Windows: tests): run it here, in this window.
            & $shell @installerArgs
            $code = $LASTEXITCODE
        } else {
            Write-Host "AgEnD: the installer needs Administrator rights (it enables WSL). Approve the Windows prompt;"
            Write-Host "it opens in a new window, and this one waits for it."
            # Who started it (#2650 item 5): WSL, the shortcuts and the resume after a restart belong to the account the
            # installer runs as. If the prompt is answered with another administrator's account, the installer sees this SID
            # differ from its own and stops, naming both accounts, instead of installing everything for the other one.
            $sid = $null
            try { $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value } catch { }
            if ($sid -match '^S-1-\d+(-\d+)+$') { $installerArgs += @('-InitiatingSid', $sid) }
            $terminal = 'auto'
            if ($env:AGEND_INSTALL_TERMINAL) { $terminal = $env:AGEND_INSTALL_TERMINAL.Trim().ToLowerInvariant() }
            $result = Start-ElevatedInstaller $shell $installerArgs $tmp $terminal
            if ($result.Outcome -ne 'done' -and $result.Outcome -ne 'closed') {
                Write-BootstrapLog ("elevated launch: " + $result.Outcome + $(if ($result.Error) { ': ' + $result.Error }))
                switch ($result.Outcome) {
                    'declined' {
                        Write-Host "AgEnD: Administrator approval was declined, so nothing was installed." -ForegroundColor Yellow
                        Write-Host "Run the same command again and choose Yes, or open PowerShell as Administrator and paste it there."
                        return
                    }
                    'blocked' {
                        Write-Host "AgEnD: a Windows security policy on this computer blocked the installer ($($result.Error)). Nothing was installed." -ForegroundColor Red
                        Write-Host "This is usually set by your organisation (AppLocker, WDAC or similar). Do not try to turn it off; ask your IT team to allow the AgEnD installer."
                    }
                    'quarantined' {
                        Write-Host "AgEnD: antivirus stopped the installer ($($result.Error)). Nothing was installed." -ForegroundColor Red
                        Write-Host "Do not turn protection off. Ask your IT team whether install-agend.ps1 from songsid.github.io may run, then run the same command again."
                    }
                    default {
                        Write-Host "AgEnD: Windows could not start the installer as Administrator ($($result.Error)). Nothing was installed." -ForegroundColor Red
                        Write-Host "Open PowerShell as Administrator and paste the same command there, or ask your IT team for help."
                    }
                }
                Show-SupportFile $(if ($logDir) { Join-Path $logDir 'bootstrap.log' })
                return
            }
            if ($result.Outcome -eq 'closed') {
                Write-Host "AgEnD: the installer window was closed before it finished." -ForegroundColor Yellow
                Write-Host "Run the same command again: it carries on where it stopped."
                $receipt = Read-InstallReceipt
                if ($receipt) { Write-Host "AgEnD: it was at stage $($receipt.stage)."; Show-SupportFile ([string]$receipt.log) }
                return
            }
            $code = $result.Code
        }
        $receipt = Read-InstallReceipt
        # A receipt that says done is the installer's own word; a stale exit code from its last native command is not.
        if ($receipt -and $receipt.outcome -eq 'done') { $code = 0 }
        if ($code -ne 0) {
            Write-Host "AgEnD: the installer ended with code $code. See its window for why." -ForegroundColor Yellow
            if ($receipt) {
                $why = ''; if ($receipt.failure) { $why = " ($($receipt.failure))" }
                Write-Host "AgEnD: it stopped at stage $($receipt.stage)$why. Running the same command again carries on from there."
                Show-SupportFile ([string]$receipt.log)
            }
        }
        else { Write-Host "AgEnD: the installer finished. If it asked you to restart Windows, run the same command again afterwards." }
    } finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
}
