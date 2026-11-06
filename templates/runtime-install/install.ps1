# AgEnD Runtime for Windows: installs the runner that lets this PC work for an AgEnD fleet.
#
# The AgEnD page (Settings -> Runtime -> Connect a computer) shows the exact command, with your fleet's address filled in:
#
#   $agend = 'https://your-agend-host'; irm "$agend/runtime/install.ps1" | iex
#
# This file is served by that AgEnD server itself, unchanged for everyone who asks and unchanged between requests. The server
# address is the one you typed in $agend: nothing here is looked up from the network, and nothing here is a secret.
#
# It is run with `irm ... | iex`, so it is kept safe for that: ASCII only (Windows PowerShell 5.1 may decode a download as
# the wrong code page), no param block, and no `exit` (under iex it would close the window). Windows PowerShell 5.1 and
# PowerShell 7 both run it. It needs no administrator rights.
#
# What it does, in order:
#   1. Checks that Node.js 22.14 or newer is installed (it never installs software for you).
#   2. Downloads the Runtime archive from $agend, checks its SHA-256 against the value pinned inside this script and, if it
#      does not match, stops before anything is unpacked.
#   3. Unpacks it into %LOCALAPPDATA%\agend-runtime\<version> and puts agend-runtime.cmd in %LOCALAPPDATA%\agend-runtime\bin.
#   4. Adds that bin folder to YOUR user PATH (not the system PATH).
#   5. Prints the command that connects this PC. It does NOT connect and does NOT pair: pairing still needs the one-time
#      code from AgEnD Settings, which you type in the terminal, and your approval in AgEnD.
#
# Optional, set in the same PowerShell window before running it:
#   $env:AGEND_RUNTIME_NO_PATH = '1'              leave PATH alone (the final message then shows the full path to run)
#   $env:AGEND_RUNTIME_INSTALL_DIR = 'D:\agend'   install somewhere other than %LOCALAPPDATA%\agend-runtime
# If it fails it says why, leaves what was installed before untouched, and sets $LASTEXITCODE to 1.
& {
    $ErrorActionPreference = 'Stop'

    # Pinned by the AgEnD server that serves this file: the version and the SHA-256 of the one archive it serves.
    $pinnedVersion = '@@AGEND_RUNTIME_VERSION@@'
    $pinnedSha256 = '@@AGEND_RUNTIME_SHA256@@'
    $maxArchiveBytes = 16MB

    function Write-Step([string]$text) { Write-Host ('AgEnD Runtime: ' + $text) }
    function Write-Problem([string]$text) { Write-Host ('AgEnD Runtime: ' + $text) -ForegroundColor Red }

    # Only an origin: https, or http for this computer itself (an SSH-forwarded port). No path, credentials, query or fragment.
    function Resolve-AgendOrigin($value) {
        if (-not ($value -is [string]) -or $value.Length -eq 0 -or $value.Length -gt 2048 -or $value -match '[\s\x00-\x1f\x7f]') { return '' }
        $uri = $null
        if (-not [Uri]::TryCreate($value, [UriKind]::Absolute, [ref]$uri)) { return '' }
        $local = $uri.Host -in 'localhost', '127.0.0.1', '[::1]', '::1'
        if (-not ($uri.Scheme -eq 'https' -or ($uri.Scheme -eq 'http' -and $local))) { return '' }
        if ($uri.UserInfo -ne '' -or $uri.Query -ne '' -or $uri.Fragment -ne '' -or $uri.AbsolutePath -ne '/') { return '' }
        return $uri.GetLeftPart([UriPartial]::Authority)
    }
    # Node.js satisfying the Runtime's engines: ^22.14.0 || ^23.6.0 || >=24.
    function Test-NodeVersion([string]$text) {
        $m = [regex]::Match($text, '\Av?(\d+)\.(\d+)\.(\d+)')
        if (-not $m.Success) { return $false }
        $major = [int]$m.Groups[1].Value; $minor = [int]$m.Groups[2].Value
        return ($major -ge 24) -or ($major -eq 23 -and $minor -ge 6) -or ($major -eq 22 -and $minor -ge 14)
    }
    # One bounded download: no redirect is followed, and neither the wait nor the size can run on.
    function Save-AgendArchive([string]$Uri, [string]$OutFile, [long]$MaxBytes) {
        $request = [Net.HttpWebRequest]::Create($Uri)
        $request.AllowAutoRedirect = $false; $request.Timeout = 120000; $request.ReadWriteTimeout = 60000; $request.UserAgent = 'agend-runtime-install'
        $response = $null; $input = $null; $output = $null; $done = $false
        try {
            $response = $request.GetResponse()
            if ([int]$response.StatusCode -ne 200) { throw ('The AgEnD server answered ' + [int]$response.StatusCode + ' for the Runtime archive.') }
            if ($response.ContentLength -gt $MaxBytes) { throw 'The Runtime archive is larger than expected; refusing to download it.' }
            $input = $response.GetResponseStream()
            $output = [IO.File]::Open($OutFile, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $buffer = New-Object byte[] 65536; $total = 0
            while (($count = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $total += $count
                if ($total -gt $MaxBytes) { throw 'The Runtime archive is larger than expected; stopped downloading it.' }
                $output.Write($buffer, 0, $count)
            }
            $done = $true
        } finally {
            if ($output) { $output.Dispose() }; if ($input) { $input.Dispose() }; if ($response) { $response.Close() }
            if (-not $done) { Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue }
        }
    }
    # .NET directly, not Get-FileHash: a PowerShell started from another one can inherit a module path that hides that cmdlet.
    function Get-AgendSha256([string]$Path) {
        $stream = [IO.File]::OpenRead($Path)
        try {
            $sha = [Security.Cryptography.SHA256]::Create()
            try { return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() } finally { $sha.Dispose() }
        } finally { $stream.Dispose() }
    }
    # Adds a folder to the USER PATH in the registry, keeping its value kind (a PATH with %VARIABLES% stays expandable).
    function Add-UserPathEntry([string]$Folder) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
        try {
            $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
            if ($key.GetValueNames() -contains 'Path') { $kind = $key.GetValueKind('Path') }
            foreach ($entry in $raw.Split(';')) { if ($entry.Trim().TrimEnd('\') -ieq $Folder.TrimEnd('\')) { return $false } }
            $next = $Folder
            if ($raw.Trim().Length -gt 0) { $next = $raw.TrimEnd(';') + ';' + $Folder }
            $key.SetValue('Path', $next, $kind)
        } finally { $key.Close() }
        # Tell running programs the environment changed: setting and clearing a throwaway user variable makes Windows broadcast it.
        [Environment]::SetEnvironmentVariable('AGEND_RUNTIME_ENV_REFRESH', '1', 'User')
        [Environment]::SetEnvironmentVariable('AGEND_RUNTIME_ENV_REFRESH', $null, 'User')
        return $true
    }

    $tmp = $null
    try {
        try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch { }

        $origin = Resolve-AgendOrigin $agend
        if ($origin -eq '') {
            Write-Problem 'First set $agend to your AgEnD address (https, or http only for this computer), then run the installer, for example:'
            Write-Host '  $agend = ''https://your-agend-host''; irm "$agend/runtime/install.ps1" | iex'
            Write-Host 'The AgEnD page (Settings -> Runtime -> Connect a computer) shows this command with your address already filled in.'
            $global:LASTEXITCODE = 1
            return
        }

        $nodeText = ''
        $node = Get-Command node -ErrorAction SilentlyContinue
        if ($node) { try { $nodeText = ((& $node.Source -v) | Out-String).Trim() } catch { $nodeText = '' } }
        if (-not (Test-NodeVersion $nodeText)) {
            if ($nodeText) { Write-Problem ('Node.js ' + $nodeText + ' is too old. The AgEnD Runtime needs Node.js 22.14 or newer (22.14+, 23.6+ or 24+).') }
            else { Write-Problem 'Node.js was not found. The AgEnD Runtime needs Node.js 22.14 or newer (22.14+, 23.6+ or 24+).' }
            Write-Host 'This installer does not install software for you. Install Node.js yourself, open a new PowerShell window, set $agend and run the command again:'
            Write-Host '  winget install OpenJS.NodeJS.LTS'
            Write-Host 'or download it from https://nodejs.org/'
            $global:LASTEXITCODE = 1
            return
        }

        $root = [string]$env:AGEND_RUNTIME_INSTALL_DIR
        if ($root -ne '') {
            # A folder you chose: it must be a full path on a drive, never a relative, UNC or control-character path.
            if ($root -notmatch '\A[A-Za-z]:[\\/]' -or $root -match '[\x00-\x1f\x7f]') { throw 'AGEND_RUNTIME_INSTALL_DIR must be a full path on a drive, for example D:\agend.' }
        } else {
            if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is not set; set AGEND_RUNTIME_INSTALL_DIR to a folder for the Runtime.' }
            $root = Join-Path $env:LOCALAPPDATA 'agend-runtime'
        }
        $root = [IO.Path]::GetFullPath($root).TrimEnd('\')
        $target = Join-Path $root $pinnedVersion
        $bin = Join-Path $root 'bin'
        $marker = Join-Path $target '.agend-install-sha256'
        $createdRoot = -not (Test-Path -LiteralPath $root)
        $null = New-Item -ItemType Directory -Path $root -Force

        $installed = (Test-Path -LiteralPath $marker) -and (Test-Path -LiteralPath (Join-Path $target 'dist\runtime-cli.js')) `
            -and (([IO.File]::ReadAllText($marker)).Trim() -eq $pinnedSha256)
        if ($installed) {
            Write-Step ('version ' + $pinnedVersion + ' is already installed in ' + $target + '.')
        } else {
            $tmp = Join-Path $root ('.install-' + [Guid]::NewGuid().ToString('N'))
            $null = New-Item -ItemType Directory -Path $tmp
            $archive = Join-Path $tmp 'runtime.zip'
            Write-Step ('downloading version ' + $pinnedVersion + ' from ' + $origin)
            Save-AgendArchive ($origin + '/runtime/v1/bundle/windows.zip') $archive $maxArchiveBytes
            $actual = Get-AgendSha256 $archive
            if ($actual -ne $pinnedSha256) {
                throw ('The downloaded Runtime does not match the checksum pinned in this installer, so nothing was unpacked. Expected ' + $pinnedSha256 + ' but received ' + $actual + '. If AgEnD was just updated, run the command again to fetch the matching installer.')
            }
            Write-Step 'checksum verified; unpacking.'
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $stage = Join-Path $tmp 'unpacked'
            [IO.Compression.ZipFile]::ExtractToDirectory($archive, $stage)
            $unpacked = Join-Path $stage 'agend-runtime'
            if (-not (Test-Path -LiteralPath (Join-Path $unpacked 'dist\runtime-cli.js')) -or -not (Test-Path -LiteralPath (Join-Path $unpacked 'bundle-manifest.json'))) {
                throw 'The Runtime archive does not contain the expected files, so nothing was installed.'
            }
            [IO.File]::WriteAllText((Join-Path $unpacked '.agend-install-sha256'), $pinnedSha256)
            if (Test-Path -LiteralPath $target) {
                try { Remove-Item -LiteralPath $target -Recurse -Force } catch { throw ('Could not replace ' + $target + '. Close any agend-runtime window that uses it and run the command again.') }
            }
            Move-Item -LiteralPath $unpacked -Destination $target
            Write-Step ('installed version ' + $pinnedVersion + ' in ' + $target + '.')
        }

        # agend-runtime.cmd lives in <root>\bin and points at <root>\<version>, so a later version only changes this one file.
        $null = New-Item -ItemType Directory -Path $bin -Force
        $shim = Join-Path $bin 'agend-runtime.cmd'
        $shimTemp = $shim + '.new'
        [IO.File]::WriteAllText($shimTemp, ("@echo off`r`nnode.exe `"%~dp0..\" + $pinnedVersion + "\dist\runtime-cli.js`" %*`r`n"), [Text.Encoding]::ASCII)
        Move-Item -LiteralPath $shimTemp -Destination $shim -Force

        $onPath = $false
        if ([string]$env:AGEND_RUNTIME_NO_PATH -eq '1') {
            Write-Step 'AGEND_RUNTIME_NO_PATH is set; your PATH was not changed.'
        } else {
            if (Add-UserPathEntry $bin) { Write-Step ('added ' + $bin + ' to your user PATH.') } else { Write-Step ($bin + ' is already on your user PATH.') }
            $sessionHas = $false
            foreach ($entry in ([string]$env:Path).Split(';')) { if ($entry.Trim().TrimEnd('\') -ieq $bin) { $sessionHas = $true } }
            if (-not $sessionHas) { $env:Path = ([string]$env:Path).TrimEnd(';') + ';' + $bin }
            $onPath = $true
        }

        Write-Host ''
        Write-Host 'AgEnD Runtime is installed. This computer is not connected yet and nothing has been paired.'
        Write-Host 'Next, connect it. Open Settings -> Runtime -> Connect a computer in AgEnD for the one-time pairing code, then run:'
        Write-Host ''
        if ($onPath) { Write-Host ('  agend-runtime connect --server "' + $origin + '"') }
        else { Write-Host ('  & "' + $shim + '" connect --server "' + $origin + '"') }
        Write-Host ''
        Write-Host 'Type the pairing code when asked, compare the fingerprint with the one AgEnD shows, then approve this computer in AgEnD.'
    } catch {
        Write-Problem ('install failed: ' + $_.Exception.Message)
        $global:LASTEXITCODE = 1
    } finally {
        if ($tmp -and (Test-Path -LiteralPath $tmp)) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
        # A run that installed nothing leaves nothing: the install folder this run created is removed again, but only while it is still empty.
        if ($createdRoot -and $root -and (Test-Path -LiteralPath $root) -and -not (Get-ChildItem -LiteralPath $root -Force | Select-Object -First 1)) { Remove-Item -LiteralPath $root -Force -ErrorAction SilentlyContinue }
    }
}
