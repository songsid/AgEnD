# AgEnD Runtime for Windows: installs the runner that lets this PC work for an AgEnD fleet.
#
# Do not type this file's address by hand. The AgEnD page (Settings -> Runtime -> Connect a computer) shows the command to
# copy, with your fleet's address and THIS file's SHA-256 filled in. The command downloads this file, checks the hash shown on
# the page and only then runs it, so what runs is exactly what the page vouches for, whatever the TLS trust decision was.
# The server address is the one the command put in $agend (the reviewed address, never the Host that happened to serve this
# file); nothing here is looked up from the network, and nothing here is a secret. This file is the same bytes for everyone
# and for every request.
#
# It is run by the page's command (`iex` of the downloaded text), so it is kept safe for that: ASCII only (Windows
# PowerShell 5.1 may decode a download as the wrong code page), no param block, and no `exit` (under iex it would close the
# window). Windows PowerShell 5.1 and PowerShell 7 both run it. It needs no administrator rights and never changes your
# execution policy. Under Constrained Language Mode or AppLocker `iex` is refused: use the ZIP from the same page instead.
#
# What it does, in order:
#   1. Checks that Node.js 22.14 or newer is installed (it never installs software for you).
#   2. Downloads the Runtime archive from $agend, checks its SHA-256 against the value pinned inside this script and, if it
#      does not match, stops before anything is unpacked.
#   3. Unpacks it into %LOCALAPPDATA%\agend-runtime\<version>, NEXT TO any version already there. An existing version folder
#      is never deleted or replaced: it may be the Runtime that is running right now.
#   4. Points agend-runtime at the new version: bin\agend-runtime.cmd never changes, and bin\current.txt (the version it
#      starts) is swapped in with an atomic file replace. A Runtime that is already running keeps running its own version.
#   5. Adds the bin folder to YOUR user PATH (not the system PATH).
#   6. Prints the command that connects this PC. It does NOT connect and does NOT pair: pairing still needs the one-time
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
    # Writes a small file by writing a sibling and swapping it in, so a reader (a shim that is starting right now) sees the old or the
    # new content, never half of it. Nothing happens when the file already says this.
    function Set-AgendFile([string]$Path, [string]$Text) {
        if ((Test-Path -LiteralPath $Path) -and ([IO.File]::ReadAllText($Path) -ceq $Text)) { return }
        $new = $Path + '.new'
        [IO.File]::WriteAllText($new, $Text, [Text.Encoding]::ASCII)
        try {
            # [NullString]::Value, not $null: PowerShell turns $null into an empty string for a string parameter, and Replace refuses that.
            if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($new, $Path, [NullString]::Value) } else { [IO.File]::Move($new, $Path) }
        } catch {
            Remove-Item -LiteralPath $new -Force -ErrorAction SilentlyContinue
            throw ('Could not update ' + $Path + ' (' + $_.Exception.Message + '). Close any agend-runtime window that is starting, then run the install command again.')
        }
    }
    # Adds a folder to the USER PATH in the registry, keeping its value kind: [Environment]::SetEnvironmentVariable would turn a
    # REG_EXPAND_SZ PATH into plain REG_SZ and stop its %VARIABLES% entries expanding, and setx truncates at 1024 characters, so
    # neither is used. An entry already there (written out or with %VARIABLES%) is not added again.
    function Add-UserPathEntry([string]$Folder) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
        try {
            $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
            if ($key.GetValueNames() -contains 'Path') { $kind = $key.GetValueKind('Path') }
            $want = $Folder.TrimEnd('\')
            foreach ($entry in $raw.Split(';')) {
                $e = $entry.Trim().TrimEnd('\')
                if ($e -ieq $want -or [Environment]::ExpandEnvironmentVariables($e).TrimEnd('\') -ieq $want) { return $false }
            }
            $next = $Folder
            if ($raw.Trim().Length -gt 0) { $next = $raw.TrimEnd(';') + ';' + $Folder }
            $key.SetValue('Path', $next, $kind)
        } finally { $key.Close() }
        # Tell running programs the environment changed: setting and clearing a throwaway user variable makes Windows broadcast it.
        [Environment]::SetEnvironmentVariable('AGEND_RUNTIME_ENV_REFRESH', '1', 'User')
        [Environment]::SetEnvironmentVariable('AGEND_RUNTIME_ENV_REFRESH', $null, 'User')
        return $true
    }
    # The shim never changes from one version to the next, so replacing a version cannot disturb a batch file that is running.
    # It starts the version named in current.txt, next to it; that one small file is what an install swaps.
    $shimText = ('@echo off', 'setlocal', 'set "AGEND_RT_VERSION="', 'if not exist "%~dp0current.txt" goto :agend_rt_missing', 'set /p AGEND_RT_VERSION=<"%~dp0current.txt"', 'if not defined AGEND_RT_VERSION goto :agend_rt_missing',
        'if not exist "%~dp0..\%AGEND_RT_VERSION%\dist\runtime-cli.js" goto :agend_rt_missing', 'node.exe "%~dp0..\%AGEND_RT_VERSION%\dist\runtime-cli.js" %*',
        'exit /b %errorlevel%', ':agend_rt_missing', 'echo AgEnD Runtime is not installed correctly. Run the install command shown in AgEnD Settings - Runtime - Connect a computer again.>&2',
        'exit /b 1', '') -join "`r`n"

    $tmp = $null
    try {
        try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch { }

        $origin = Resolve-AgendOrigin $agend
        if ($origin -eq '') {
            Write-Problem 'This installer needs $agend set to your AgEnD address (https, or http only for this computer).'
            Write-Host 'Do not run this file by hand: copy the install command from AgEnD (Settings -> Runtime -> Connect a computer -> Windows (PowerShell)).'
            Write-Host 'It sets $agend to your address and checks this installer''s SHA-256 against the one the page shows before it runs anything.'
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

        # An existing folder for this version is never deleted or replaced: it may be the Runtime that is running right now.
        $installed = $false
        if (Test-Path -LiteralPath $target) {
            $existing = ''
            if (Test-Path -LiteralPath $marker) { $existing = ([IO.File]::ReadAllText($marker)).Trim() }
            if ($existing -eq $pinnedSha256 -and (Test-Path -LiteralPath (Join-Path $target 'dist\runtime-cli.js'))) { $installed = $true }
            else { throw ('Version ' + $pinnedVersion + ' is already in ' + $target + ', but it is not this AgEnD''s build or it is incomplete. It was left untouched because it may be running. Close any agend-runtime window, delete that folder yourself, and run the install command again.') }
        }
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
                throw ('The downloaded Runtime does not match the checksum pinned in this installer, so nothing was unpacked. Expected ' + $pinnedSha256 + ' but received ' + $actual + '. If AgEnD was just updated, reload the AgEnD page and copy the install command again.')
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
            # A rename inside the install folder: the version folder appears whole or not at all, beside the versions already there.
            Move-Item -LiteralPath $unpacked -Destination $target
            Write-Step ('installed version ' + $pinnedVersion + ' in ' + $target + '.')
        }

        # Repoint agend-runtime. The shim file is written once and then left alone; current.txt is the atomic switch.
        $null = New-Item -ItemType Directory -Path $bin -Force
        $shim = Join-Path $bin 'agend-runtime.cmd'
        $current = Join-Path $bin 'current.txt'
        $was = ''
        if (Test-Path -LiteralPath $current) { $was = ([IO.File]::ReadAllText($current)).Trim() }
        Set-AgendFile $shim $shimText
        Set-AgendFile $current $pinnedVersion
        if ($was -ne '' -and $was -ne $pinnedVersion) {
            Write-Step ('agend-runtime now starts version ' + $pinnedVersion + ' (it was ' + $was + '). A Runtime that is already running keeps its own version until you stop it with Ctrl+C and start it again with agend-runtime run.')
        }
        $others = @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne $pinnedVersion -and $_.Name -match '\A\d+\.\d+\.\d+([-+][A-Za-z0-9.-]+)?\z' } | ForEach-Object { $_.Name })
        if ($others.Count -gt 0) { Write-Step ('earlier versions are kept where they are (' + ($others -join ', ') + '); delete them yourself when you no longer need them.') }

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
