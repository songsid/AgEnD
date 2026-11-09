# AgEnD Runtime for Windows: installs the runner that lets this PC work for an AgEnD fleet.
#
# Do not type this file's address by hand. The AgEnD page (Settings -> Runtime -> Connect a computer) shows the command to
# copy, with your fleet's address and THIS file's SHA-256 filled in. The command downloads this file, checks the hash shown on
# the page and only then runs it, so what runs is exactly what the page vouches for, whatever the TLS trust decision was.
# The server address is the one the command put in $agend (the reviewed address, never the Host that happened to serve this
# file); nothing here is looked up from the network, and nothing here is a secret. $agend is used only as that address, after the
# origin check below, for the download, the receipt, agend-server.json and the connection. This file is the same bytes for everyone
# and for every request.
#
# It is run by the page's command (`iex` of the downloaded text), so it is kept safe for that: ASCII only (Windows
# PowerShell 5.1 may decode a download as the wrong code page), no param block, and no `exit` (under iex it would close the
# window). Windows PowerShell 5.1 and PowerShell 7 both run it. It needs no administrator rights and never changes your
# execution policy. Under Constrained Language Mode or AppLocker the page's command stops before this script is ever run (it cannot compute the hash there): use the ZIP from the same page instead.
#
# What it does, in order:
#   1. Checks that Node.js 22.14 or newer is installed (it never installs software for you).
#   2. Downloads the Runtime archive from $agend, checks its SHA-256 against the value pinned inside this script and, if it
#      does not match, stops before anything is unpacked.
#   3. Unpacks it into %LOCALAPPDATA%\agend-runtime\<version>+<build>, NEXT TO any version already there (the folder names the build,
#      the first 8 characters of the archive's SHA-256, because one version number can cover more than one build). An existing folder
#      is never deleted or replaced: it may be the Runtime that is running right now.
#   4. Points agend-runtime at the new version: bin\agend-runtime.cmd never changes, and bin\current.txt (the version it
#      starts) is swapped in with an atomic file replace. A Runtime that is already running keeps running its own version.
#   5. Adds the bin folder to YOUR user PATH (not the system PATH).
#   6. Leaves a reconnect entry for this AgEnD under <install folder>\connect\<server>: agend-server.json (only the public address, never
#      a credential or a pairing code) and the same connect-agend.bat the ZIP has, so the next connection is a double-click.
#   7. Connects, in this same window, when - and only when - this is an interactive console (stdin and stdout are the console, not
#      -NonInteractive, not the ISE, no usual CI variable such as CI or GITHUB_ACTIONS set) and $agendNoConnect is not set. It runs the Runtime's own `connect --connection-dir`, the logic
#      connect-agend.bat uses: a new profile asks for the one-time pairing code, shows the fingerprint and waits for your approval in
#      AgEnD; a profile already paired to this AgEnD just reconnects; one paired to another AgEnD gets its own profile and that pairing is
#      left alone. The code is typed into the terminal by a person: the Runtime accepts it from nothing else, so this script never sees it.
#      Anywhere else (an AI agent, CI, a pipeline, $agendNoConnect) it only installs, prints the exact command to run next and ends with
#      exit code 0. The Runtime is started after the install lock is released, because a running Runtime needs that lock for updates.
#   7b. With a ONE-TIME TOKEN ($agendEnroll and $agendFingerprint, set by the page's "install command") it connects in ANY window, interactive or
#      not, with no pairing code and no approval step: the token is the authorisation, and it could only come from an administrator's signed-in
#      AgEnD page. The token is checked for its shape before anything is installed, copied out of the variable (which is cleared at once), and
#      handed to the Runtime on its standard input - never on the command line, never in an environment variable, never in a file. The Runtime
#      first checks that the server is the AgEnD whose fingerprint $agendFingerprint names and sends the token only then; the token works once, for 15
#      minutes, and can be revoked on the AgEnD page. A computer already connected to this AgEnD just reconnects and the token is not used.
#      Without a token everything is exactly as in 7. $agendNoConnect (and a repair run) still win: with them nothing is connected and the token is not used.
#
# Optional, set in the same PowerShell window before running it:
#   $agendNoConnect = 1                           install only: do not connect, even in an interactive window (unset it with $null)
#   $agendEnroll = '<token>'; $agendFingerprint = '<64 hex>'   the one-time token and server fingerprint from the page's install command (both are cleared by this script)
#   $env:AGEND_RUNTIME_REPAIR = '1'               keep PATH unchanged; print run with an existing profile, never pairing steps or a connection
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
    # `$agendNoConnect = 1`, set in the same window before the command, means "install only". Empty, 0, false, no and off mean "not set".
    function Test-AgendSwitch($value) {
        if ($null -eq $value) { return $false }
        $text = ([string]$value).Trim()
        return -not ($text -eq '' -or $text -in '0', 'false', 'no', 'off')
    }
    # The one-time install-command token ("agend_enroll_" and 43 URL-safe base64 characters) and the AgEnD server fingerprint (the SHA-256 of its enrollment
    # key, 64 lower-case hex digits). Case-sensitive on purpose. A value that fails is refused before anything is installed, and is never echoed.
    function Test-AgendEnrollToken($value) { return ($value -is [string]) -and ($value -cmatch '\Aagend_enroll_[A-Za-z0-9_-]{43}\z') }
    function Test-AgendFingerprint($value) { return ($value -is [string]) -and ($value -cmatch '\A[a-f0-9]{64}\z') }
    # True only at a real, interactive console. The pairing code is typed by a person and the Runtime reads it from nothing else, so a
    # redirected stdin or stdout (an AI agent, CI, a pipeline), -NonInteractive (any abbreviation of it), the ISE (no console for a child
    # process) and a CI environment variable (CI, GITHUB_ACTIONS, TF_BUILD, ...: an agent on a pseudo-terminal) are all "not interactive". When in
    # doubt it answers false: the cost is one command to run by hand, never a hung window.
    function Test-AgendInteractive {
        try {
            if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) { return $false }
            if ([string]$Host.Name -match 'ISE') { return $false }
            foreach ($arg in [Environment]::GetCommandLineArgs()) { if ($arg -match '\A[-/]noni') { return $false } }
            # An AI agent or CI step that gives PowerShell a pseudo-terminal looks interactive from in here, but nobody is there to type a pairing code. The usual
            # CI variables say so: any of them set (and not 0, false, no or off, the same reading as $agendNoConnect) means "not interactive".
            foreach ($name in 'CI', 'GITHUB_ACTIONS', 'TF_BUILD', 'BUILD_BUILDID', 'JENKINS_URL', 'GITLAB_CI', 'CIRCLECI', 'BUILDKITE', 'TEAMCITY_VERSION') {
                if (Test-AgendSwitch ([Environment]::GetEnvironmentVariable($name))) { return $false }
            }
            return $true
        } catch { return $false }
    }
    # What to do after the install, as one word: repair (never connect), switch ($agendNoConnect), enroll (a valid one-time token: connect with it in
    # any window), noninteractive, noentry (the reconnect entry could not be written) or connect. The order is the order of precedence.
    function Get-AgendConnectMode([bool]$Repair, [bool]$NoConnect, [bool]$Interactive, [bool]$HasEntry, [bool]$HasToken = $false) {
        if ($Repair) { return 'repair' }
        if ($NoConnect) { return 'switch' }
        if ($HasToken) { if ($HasEntry) { return 'enroll' } else { return 'noentry' } }
        if (-not $Interactive) { return 'noninteractive' }
        if (-not $HasEntry) { return 'noentry' }
        return 'connect'
    }
    # One folder per AgEnD address under <install>\connect, so two AgEnDs on one PC never overwrite each other's reconnect entry. The name is
    # only a label (the Runtime picks the profile from the address inside agend-server.json): host, port and 8 hex characters of the address's hash.
    function Get-AgendConnectName([string]$Origin) {
        $uri = [Uri]$Origin
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $hash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Origin))) -replace '-', '').ToLowerInvariant() } finally { $sha.Dispose() }
        return (([string]$uri.Host -replace '[^A-Za-z0-9.-]', '_').ToLowerInvariant() + '-' + $uri.Port + '-' + $hash.Substring(0, 8))
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
        $response = $null; $bodyStream = $null; $output = $null; $done = $false
        try {
            $response = $request.GetResponse()
            if ([int]$response.StatusCode -ne 200) { throw ('The AgEnD server answered ' + [int]$response.StatusCode + ' for the Runtime archive.') }
            if ($response.ContentLength -gt $MaxBytes) { throw 'The Runtime archive is larger than expected; refusing to download it.' }
            $bodyStream = $response.GetResponseStream()
            $output = [IO.File]::Open($OutFile, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $buffer = New-Object byte[] 65536; $total = 0
            while (($count = $bodyStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $total += $count
                if ($total -gt $MaxBytes) { throw 'The Runtime archive is larger than expected; stopped downloading it.' }
                $output.Write($buffer, 0, $count)
            }
            $done = $true
        } finally {
            if ($output) { $output.Dispose() }; if ($bodyStream) { $bodyStream.Dispose() }; if ($response) { $response.Close() }
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
    function Set-AgendFile([string]$Path, [string]$Text, [scriptblock]$BeforeRename = $null) {
        if ((Test-Path -LiteralPath $Path) -and ([IO.File]::ReadAllText($Path) -ceq $Text)) { return }
        $new = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.new'
        [IO.File]::WriteAllText($new, $Text, [Text.Encoding]::ASCII)
        try {
            if ($BeforeRename) { & $BeforeRename }
            # [NullString]::Value, not $null: PowerShell turns $null into an empty string for a string parameter, and Replace refuses that.
            if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($new, $Path, [NullString]::Value) } else { [IO.File]::Move($new, $Path) }
        } catch {
            Remove-Item -LiteralPath $new -Force -ErrorAction SilentlyContinue
            throw ('Could not update ' + $Path + ' (' + $_.Exception.Message + '). Close any agend-runtime window that is starting, then run the install command again.')
        }
    }
    function Assert-AgendDirectory([string]$Path) {
        $entry = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if (-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'The installation directory is unsafe or changed.' }
    }
    function Read-AgendSmallFile([string]$Path, [int]$Limit) {
        try { $entry = Get-Item -LiteralPath $Path -Force -ErrorAction Stop }
        catch [Management.Automation.ItemNotFoundException] { return $null }
        if ($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or [string]$entry.LinkType -ne '' -or $entry.Length -gt $Limit) { throw 'Installation metadata is unsafe or too large.' }
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try {
            $bytes = New-Object byte[] ($Limit + 1); $length = 0
            while ($length -lt $bytes.Length) { $count = $stream.Read($bytes, $length, $bytes.Length - $length); if ($count -eq 0) { break }; $length += $count }
            if ($length -gt $Limit) { throw 'Installation metadata grew beyond its bound.' }
            return ([Text.UTF8Encoding]::new($false, $true)).GetString($bytes, 0, $length)
        } finally { $stream.Dispose() }
    }
    function Get-AgendBootProof {
        $ticks = [string](Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().Ticks
        if ($ticks -notmatch '\A\d{17,20}\z') { throw 'Windows process ownership could not be verified.' }
        $sha = [Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes('agend-windows-boot-v1:' + $ticks))) -replace '-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
    }
    function Test-AgendOwnerRecord($Owner) {
        $keys = @($Owner.PSObject.Properties.Name)
        if ($keys.Count -ne 6 -or @($keys | Where-Object { $_ -cnotin 'version','type','nonce','pid','birth','boot' }).Count -ne 0 -or -not ($Owner.version -is [int] -or $Owner.version -is [long]) -or $Owner.version -ne 1 -or -not ($Owner.type -is [string]) -or -not ($Owner.nonce -is [string]) -or -not ($Owner.birth -is [string]) -or -not ($Owner.boot -is [string]) -or $Owner.type -cnotin 'installer','supervisor' -or
            [string]$Owner.nonce -notmatch '\A[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}\z' -or
            -not ($Owner.pid -is [int] -or $Owner.pid -is [long]) -or $Owner.pid -lt 1 -or [string]$Owner.birth -notmatch '\A\d{17,20}\z' -or [string]$Owner.boot -notmatch '\A[a-f0-9]{64}\z') { throw 'The install lock owner is unconfirmed; use a fresh or separate installation.' }
    }
    function Get-AgendProcessMatch($Owner, [string]$Boot) {
        try { $process = [Diagnostics.Process]::GetProcessById($Owner.pid) }
        catch [ArgumentException] { return 'gone' }
        catch { return 'unknown' }
        try {
            $birth = [string]$process.StartTime.ToUniversalTime().Ticks
            if ($birth -cne [string]$Owner.birth -or $Boot -cne [string]$Owner.boot) { return 'gone' }
            return 'alive'
        } catch { return 'unknown' }
        finally { $process.Dispose() }
    }
    function Read-AgendLock([string]$Path) {
        Assert-AgendDirectory $Path
        $raw = Read-AgendSmallFile (Join-Path $Path 'owner.json') 2048
        if ($null -eq $raw) { throw 'The install lock is incomplete; use a fresh or separate installation.' }
        $owner = $raw | ConvertFrom-Json; Test-AgendOwnerRecord $owner
        return @{ path=$Path; raw=$raw; owner=$owner; birth=[string](Get-Item -LiteralPath $Path -Force).CreationTimeUtc.Ticks }
    }
    function Assert-AgendLock($Lock) {
        $now = Read-AgendLock $Lock.path
        if ($now.birth -cne $Lock.birth -or $now.raw -cne $Lock.raw) { throw 'Installation ownership changed; nothing was switched.' }
    }
    function Remove-AgendLock($Lock) {
        Assert-AgendLock $Lock
        if (@(Get-ChildItem -LiteralPath $Lock.path -Force | Where-Object { $_.Name -cne 'owner.json' }).Count -ne 0) { throw 'Installation cleanup is unconfirmed; its ownership was retained.' }
        [IO.File]::Delete((Join-Path $Lock.path 'owner.json'))
        try { [IO.Directory]::Delete($Lock.path) }
        catch {
            try {
                Assert-AgendDirectory $Lock.path
                if ([string](Get-Item -LiteralPath $Lock.path -Force).CreationTimeUtc.Ticks -ceq $Lock.birth -and $null -eq (Read-AgendSmallFile (Join-Path $Lock.path 'owner.json') 2048)) {
                    [IO.File]::WriteAllText((Join-Path $Lock.path 'owner.json'), $Lock.raw, [Text.UTF8Encoding]::new($false))
                }
            } catch { }
            throw 'Installation cleanup is unconfirmed; inspect or retry this installation.'
        }
    }
    function Enter-AgendInstallLock([string]$Root) {
        Assert-AgendDirectory $Root
        $boot = Get-AgendBootProof; $process = [Diagnostics.Process]::GetCurrentProcess()
        try { $birth = [string]$process.StartTime.ToUniversalTime().Ticks } finally { $process.Dispose() }
        $owner = [pscustomobject][ordered]@{version=1;type='installer';nonce=[Guid]::NewGuid().ToString();pid=[int]$PID;birth=$birth;boot=$boot}
        $raw = $owner | ConvertTo-Json -Compress
        $candidate = Join-Path $Root ('.agend-lock-' + [Guid]::NewGuid().ToString('N')); $null = [IO.Directory]::CreateDirectory($candidate)
        [IO.File]::WriteAllText((Join-Path $candidate 'owner.json'), $raw, [Text.UTF8Encoding]::new($false))
        $created = Read-AgendLock $candidate; $path = Join-Path $Root '.agend-runtime-install.lock'
        try {
            try { [IO.Directory]::Move($candidate, $path); return (Read-AgendLock $path) }
            catch { if (-not [IO.Directory]::Exists($path)) { throw } }
            $previous = Read-AgendLock $path
            if ((Get-AgendProcessMatch $previous.owner $boot) -cne 'gone') { throw 'Another installer or Runtime owns this installation. Retry when it is finished.' }
            # Move an owned empty directory into the election slot: unlike CreateDirectory, Move refuses an existing slot atomically.
            $guard = Join-Path $Root ('.agend-reclaim-' + [Guid]::NewGuid().ToString('N')); $null = [IO.Directory]::CreateDirectory($guard)
            $claim = [Guid]::NewGuid().ToString(); [IO.File]::WriteAllText((Join-Path $guard 'claim.json'), $claim, [Text.Encoding]::ASCII)
            $election = Join-Path $path 'reclaim'; $elected = $false
            try {
                [IO.Directory]::Move($guard, $election); $elected = $true
                Assert-AgendLock $previous
                if (@(Get-ChildItem -LiteralPath $path -Force | Where-Object { $_.Name -cnotin 'owner.json','reclaim' }).Count -ne 0) { throw 'Uncertain installation work remains; ownership was retained.' }
                [IO.File]::Delete((Join-Path $path 'owner.json'))
                [IO.File]::Delete((Join-Path $election 'claim.json')); [IO.Directory]::Delete($election); $elected = $false
                [IO.Directory]::Delete($path)
            } finally {
                $ownedGuard = if ($elected) { $election } else { $guard }
                if ([IO.Directory]::Exists($ownedGuard) -and (Read-AgendSmallFile (Join-Path $ownedGuard 'claim.json') 128) -ceq $claim) {
                    [IO.File]::Delete((Join-Path $ownedGuard 'claim.json')); [IO.Directory]::Delete($ownedGuard)
                }
            }
            [IO.Directory]::Move($candidate, $path); return (Read-AgendLock $path)
        } finally { if ([IO.Directory]::Exists($candidate)) { Remove-AgendLock $created } }
    }
    function Register-AgendInstallOrigin([string]$Root, [string]$Origin, [bool]$Fresh, $Lock) {
        Assert-AgendLock $Lock
        $path = Join-Path $Root '.agend-runtime-install.json'; $raw = Read-AgendSmallFile $path 20000
        if ($null -eq $raw) {
            if (-not $Fresh) { return }
            $receipt = [pscustomobject][ordered]@{version=1;id=[Guid]::NewGuid().ToString();createdAt=[long][Math]::Floor(([DateTime]::UtcNow - [DateTime]'1970-01-01T00:00:00Z').TotalMilliseconds);revision=1;origins=@($Origin);shared=$false}
        } else {
            $receipt = $raw | ConvertFrom-Json; $keys = @($receipt.PSObject.Properties.Name)
            if ($keys.Count -ne 6 -or @($keys | Where-Object { $_ -cnotin 'version','id','createdAt','revision','origins','shared' }).Count -ne 0 -or -not ($receipt.version -is [int] -or $receipt.version -is [long]) -or $receipt.version -ne 1 -or -not ($receipt.id -is [string]) -or
                [string]$receipt.id -notmatch '\A[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}\z' -or
                -not ($receipt.createdAt -is [int] -or $receipt.createdAt -is [long]) -or $receipt.createdAt -lt 1 -or $receipt.createdAt -gt 9007199254740991 -or
                -not ($receipt.revision -is [int] -or $receipt.revision -is [long]) -or $receipt.revision -lt 1 -or $receipt.revision -ge 9007199254740991 -or
                -not ($receipt.origins -is [Array]) -or $receipt.origins.Count -lt 1 -or $receipt.origins.Count -gt 8 -or -not ($receipt.shared -is [bool])) { throw 'The managed-install receipt is unconfirmed; use a fresh or separate installation.' }
            $seen = @{}
            foreach ($entry in $receipt.origins) {
                if (-not ($entry -is [string]) -or (Resolve-AgendOrigin $entry) -cne $entry -or $seen.ContainsKey($entry)) { throw 'The managed-install origins are unconfirmed.' }
                $seen[$entry] = $true
            }
            if ($receipt.origins.Count -gt 1 -and -not $receipt.shared) { throw 'The shared-install receipt is unconfirmed.' }
            if ($receipt.origins -ccontains $Origin) { return }
            if ($receipt.origins.Count -ge 8) { throw 'This installation has too many origins. Use a separate fresh install; pairing is kept.' }
            $receipt.origins = @($receipt.origins) + @($Origin); $receipt.shared = $true; $receipt.revision++
        }
        Set-AgendFile $path ($receipt | ConvertTo-Json -Depth 4 -Compress) { Assert-AgendLock $Lock; if ((Read-AgendSmallFile $path 20000) -cne $raw) { throw 'The managed-install receipt changed; nothing was switched.' } }
    }

    # <root>\connect\<server>\agend-server.json (the public address and nothing else) and connect-agend.bat. Returns that folder.
    # The batch file calls the shim (so it follows current.txt to the newest installed Runtime) and passes its own folder as --connection-dir;
    # the Runtime reads the address from the json and picks the profile the way the ZIP's connect-agend.bat does. `call` re-reads % and ^ in a
    # path, so a folder whose name holds one is refused here rather than written into a batch file that would misread it.
    function Write-AgendConnectEntry([string]$Root, [string]$Origin) {
        if ($Origin -notmatch '\A[A-Za-z0-9.:/\[\]-]+\z') { throw 'the AgEnD address has characters that agend-server.json does not carry' }
        if ($Root -match '[%^]') { throw 'the install folder name contains % or ^, which a batch file cannot carry safely' }
        $parent = Join-Path $Root 'connect'
        $null = New-Item -ItemType Directory -Path $parent -Force; Assert-AgendDirectory $parent
        $folder = Join-Path $parent (Get-AgendConnectName $Origin)
        $null = New-Item -ItemType Directory -Path $folder -Force; Assert-AgendDirectory $folder
        Set-AgendFile (Join-Path $folder 'agend-server.json') ('{' + "`n" + '  "server": "' + $Origin + '"' + "`n" + '}' + "`n")
        Set-AgendFile (Join-Path $folder 'connect-agend.bat') $connectBatText
        return $folder
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
        # Tell running programs the environment changed: setting and clearing a throwaway user variable makes Windows broadcast it. The PATH is
        # already written, so a failure here is only a warning (open terminals learn of it later), never "install failed".
        try {
            [Environment]::SetEnvironmentVariable('AGEND_RUNTIME_ENV_REFRESH', '1', 'User')
            [Environment]::SetEnvironmentVariable('AGEND_RUNTIME_ENV_REFRESH', $null, 'User')
        } catch {
            try { [Environment]::SetEnvironmentVariable('AGEND_RUNTIME_ENV_REFRESH', $null, 'User') } catch { }
            Write-Host ('AgEnD Runtime: warning: your PATH was updated, but running programs could not be told (' + $_.Exception.Message + '). Open a new terminal to see the change.') -ForegroundColor Yellow
        }
        return $true
    }
    # The shim never changes from one version to the next, so replacing a version cannot disturb a batch file that is running.
    # It starts the version named in current.txt, next to it; that one small file is what an install swaps.
    # `setlocal DisableDelayedExpansion` comes before any line that expands a path or an argument: with cmd /V:ON (or the DelayedExpansion registry setting)
    # an unmatched `!` in the install folder, which an accepted AGEND_RUNTIME_INSTALL_DIR can hold, would otherwise be eaten out of %~dp0 and the shim would
    # look in another folder and report an incomplete install. (Changed once for that reason: see the change notice below.)
    # DO NOT CHANGE $shimText unless a bug in it makes installs unusable. cmd.exe reads a batch file as it runs it, a piece at a time, not all at
    # once, so rewriting the agend-runtime.cmd of a Runtime that is running (Set-AgendFile does that whenever this text differs from what is on
    # disk) can make that Runtime's window misbehave when it ends. The text names no version for exactly that reason. If it must change, update the
    # pinned hash in tests/runtime-install-script.test.ts in the same commit, and say in the docs and the changelog that running Runtimes should be
    # stopped before the install command is run again.
    $shimText = ('@echo off', 'setlocal DisableDelayedExpansion', 'set "AGEND_RT_VERSION="', 'if not exist "%~dp0current.txt" goto :agend_rt_missing', 'set /p AGEND_RT_VERSION=<"%~dp0current.txt"', 'if not defined AGEND_RT_VERSION goto :agend_rt_missing',
        'if not exist "%~dp0..\%AGEND_RT_VERSION%\dist\runtime-cli.js" goto :agend_rt_missing', 'node.exe "%~dp0..\%AGEND_RT_VERSION%\dist\runtime-cli.js" %*',
        'exit /b %errorlevel%', ':agend_rt_missing', 'echo AgEnD Runtime is not installed correctly. Run the install command shown in AgEnD Settings - Runtime - Connect a computer again.>&2',
        'exit /b 1', '') -join "`r`n"

    # connect-agend.bat for the reconnect entry: what the ZIP's connect-agend.bat does (connect, then say how it ended and pause), pointed at the
    # installed shim. Like the shim, its text names no version and must not change without a reason: cmd.exe reads a batch file as it runs it, and
    # Set-AgendFile rewrites this file whenever the text differs from what is on disk, which can disturb a window that is running it right now.
    # If it must change, update the pinned hash in tests/runtime-install-script.test.ts in the same commit.
    $connectBatText = ('@echo off', 'setlocal DisableDelayedExpansion', 'if not exist "%~dp0..\..\bin\agend-runtime.cmd" (',
        '  echo AgEnD Runtime is not installed correctly. Run the install command shown in AgEnD Settings - Runtime - Connect a computer again.', '  pause', '  exit /b 1', ')',
        'call "%~dp0..\..\bin\agend-runtime.cmd" connect --connection-dir "%~dp0."', 'set "AGEND_EXIT=%errorlevel%"', 'echo.',
        'if not "%AGEND_EXIT%"=="0" (', '  echo AgEnD Runtime stopped or could not connect. Read the message above for what to do next.', ') else (', '  echo AgEnD Runtime stopped.', ')',
        'pause', '') -join "`r`n"

    $tmp = $null; $installLock = $null
    $doConnect = $false; $connectDir = $null; $cliJs = $null
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

        # the one-time token and server fingerprint the page's command set. They are copied here and cleared from the caller's scope at
        # once (the page's command clears them again afterwards), and checked for their shape before anything is installed: a malformed token is
        # refused with the next step, without being printed. Nothing about the token goes into a file, a log or the command line.
        $enrollToken = $null; $enrollFingerprint = $null
        $rawToken = $agendEnroll; $rawFingerprint = $agendFingerprint
        foreach ($scopeName in 1, 'Global') { foreach ($varName in 'agendEnroll', 'agendFingerprint') { try { Set-Variable -Name $varName -Value $null -Scope $scopeName -ErrorAction Stop } catch { } } }
        # A variable that is not there, or is $null (what the page's command and this script leave behind), is "no token". One that holds anything else, an empty or
        # blank string included, is a token that was meant to be there and is not valid: refused, never quietly turned into the pairing-code route.
        if ($null -ne $rawToken) {
            if (-not (Test-AgendEnrollToken $rawToken)) {
                Write-Problem 'The one-time token in this install command is not valid (it may have been copied incompletely). Nothing was installed.'
                Write-Host 'Open AgEnD Settings -> Runtime -> Connect a computer, generate a new install command there and run it again.'
                $global:LASTEXITCODE = 1
                return
            }
            if (-not (Test-AgendFingerprint $rawFingerprint)) {
                Write-Problem 'The AgEnD server fingerprint in this install command is missing or not valid (it is 64 hexadecimal characters). Nothing was installed.'
                Write-Host 'Open AgEnD Settings -> Runtime -> Connect a computer, generate a new install command there and run it again.'
                $global:LASTEXITCODE = 1
                return
            }
            $enrollToken = [string]$rawToken; $enrollFingerprint = [string]$rawFingerprint
        }
        $rawToken = $null

        $nodeText = ''
        $node = Get-Command node -ErrorAction SilentlyContinue
        $nodeExe = $null
        if ($node) { $nodeExe = $node.Source; try { $nodeText = ((& $node.Source -v) | Out-String).Trim() } catch { $nodeText = '' } }
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
        # The folder names the build as well as the version: one version number often covers more than one build, and a different build must land
        # beside the old one, not on it. The same build finds its own folder again and only repoints agend-runtime.
        $folder = $pinnedVersion + '+' + $pinnedSha256.Substring(0, 8)
        $target = Join-Path $root $folder
        $bin = Join-Path $root 'bin'
        $marker = Join-Path $target '.agend-install-sha256'
        $createdRoot = -not (Test-Path -LiteralPath $root)
        $null = New-Item -ItemType Directory -Path $root -Force
        $installLock = Enter-AgendInstallLock $root
        $freshReceipt = $createdRoot -and @(Get-ChildItem -LiteralPath $root -Force | Where-Object { $_.Name -cne '.agend-runtime-install.lock' }).Count -eq 0
        $current = Join-Path $bin 'current.txt'
        $beforeCurrent = Read-AgendSmallFile $current 90

        # An existing folder is never deleted or replaced: it may be the Runtime that is running right now. A folder with this build's own name that does
        # not hold this build can only be one that was changed by hand or left incomplete, and is left alone too.
        $installed = $false
        if (Test-Path -LiteralPath $target) {
            $existing = ''
            if (Test-Path -LiteralPath $marker) { $existing = ([IO.File]::ReadAllText($marker)).Trim() }
            if ($existing -eq $pinnedSha256 -and (Test-Path -LiteralPath (Join-Path $target 'dist\runtime-cli.js'))) { $installed = $true }
            else { throw ('The folder ' + $target + ' exists but does not hold this build (it was changed or is incomplete). It was left untouched because it may be running. Close any agend-runtime window, move that folder away yourself, and run the install command again.') }
        }
        if ($installed) {
            Write-Step ('version ' + $pinnedVersion + ' (build ' + $pinnedSha256.Substring(0, 8) + ') is already installed in ' + $target + '.')
        } else {
            $tmp = Join-Path $root ('.install-' + [Guid]::NewGuid().ToString('N'))
            $null = New-Item -ItemType Directory -Path $tmp
            $archive = Join-Path $tmp 'runtime.zip'
            Write-Step ('downloading version ' + $pinnedVersion + ' (build ' + $pinnedSha256.Substring(0, 8) + ') from ' + $origin)
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
            Write-Step ('installed version ' + $pinnedVersion + ' (build ' + $pinnedSha256.Substring(0, 8) + ') in ' + $target + '.')
        }

        # Repoint agend-runtime. The shim file is written once and then left alone; current.txt is the atomic switch.
        $null = New-Item -ItemType Directory -Path $bin -Force
        $shim = Join-Path $bin 'agend-runtime.cmd'
        $current = Join-Path $bin 'current.txt'
        $was = ''
        if (Test-Path -LiteralPath $current) { $was = ([IO.File]::ReadAllText($current)).Trim() }
        Register-AgendInstallOrigin $root $origin $freshReceipt $installLock
        Set-AgendFile $shim $shimText
        Set-AgendFile $current $folder { Assert-AgendLock $installLock; if ((Read-AgendSmallFile $current 90) -cne $beforeCurrent) { throw 'The selected Runtime changed during installation; nothing was switched.' } }
        if ($was -ne '' -and $was -ne $folder) {
            Write-Step ('agend-runtime now starts ' + $folder + ' (it was ' + $was + '). A Runtime that is already running keeps its own version until you stop it with Ctrl+C and start it again with agend-runtime run.')
        }
        $others = @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne $folder -and $_.Name -match '\A\d+\.\d+\.\d+([-+][A-Za-z0-9.+-]+)?\z' } | ForEach-Object { $_.Name })
        # Earlier folders are not removed here: one of them may be running. Cleaning them up comes with the update and uninstall commands (phase 2).
        if ($others.Count -gt 0) { Write-Step ('earlier versions are kept where they are (' + ($others -join ', ') + '). This installer never removes a version; clearing old ones comes later, with the update and uninstall commands.') }

        $onPath = $false
        if ([string]$env:AGEND_RUNTIME_NO_PATH -eq '1' -or [string]$env:AGEND_RUNTIME_REPAIR -eq '1') {
            Write-Step 'your PATH was not changed.'
        } else {
            if (Add-UserPathEntry $bin) { Write-Step ('added ' + $bin + ' to your user PATH.') } else { Write-Step ($bin + ' is already on your user PATH.') }
            $sessionHas = $false
            foreach ($entry in ([string]$env:Path).Split(';')) { if ($entry.Trim().TrimEnd('\') -ieq $bin) { $sessionHas = $true } }
            if (-not $sessionHas) { $env:Path = ([string]$env:Path).TrimEnd(';') + ';' + $bin }
            $onPath = $true
        }

        # The reconnect entry: this AgEnD's address and the same connect-agend.bat the ZIP has. A repair run is for a computer that is already
        # paired and writes nothing new beside it. A failure here never fails the install; it only means no automatic connection.
        $repair = [string]$env:AGEND_RUNTIME_REPAIR -eq '1'
        if (-not $repair) {
            try { $connectDir = Write-AgendConnectEntry $root $origin }
            catch { Write-Host ('AgEnD Runtime: warning: the reconnect entry was not written (' + $_.Exception.Message + '). The Runtime is installed; connect with the command shown below.') -ForegroundColor Yellow }
        }
        $connectBat = $null
        if ($connectDir) { $connectBat = Join-Path $connectDir 'connect-agend.bat' }
        $noConnect = Test-AgendSwitch $agendNoConnect
        $mode = Get-AgendConnectMode $repair $noConnect (Test-AgendInteractive) ([bool]$connectDir) ([bool]$enrollToken)

        Write-Host ''
        if ($mode -eq 'repair') {
            Write-Host 'AgEnD Runtime is installed. Keep your existing profile and pairing; PATH was not changed.'
            Write-Host 'Use the same existing profile folder, including any previous --profile or AGEND_RUNTIME_HOME. Run this exact new executable and enter that folder:'
            $literalShim = $shim.Replace("'", "''")
            Write-Host ('  $agendProfile = $null; $agendProfile = Read-Host ''Existing Runtime profile folder (same as before)''; if ($agendProfile) { & ''' + $literalShim + ''' run --profile $agendProfile } else { throw ''Existing Runtime profile folder is required'' }')
        } elseif ($mode -eq 'connect' -or $mode -eq 'enroll') {
            Write-Host 'AgEnD Runtime is installed.'
            Write-Host ('Next time, double-click ' + $connectBat + ' to reconnect this computer.')
            $cliJs = Join-Path $target 'dist\runtime-cli.js'
            $doConnect = $true
        } else {
            Write-Host 'AgEnD Runtime is installed. This computer is not connected yet and nothing has been paired.'
            if ($mode -eq 'noninteractive') { Write-Host 'This window is not an interactive console (a script, a pipeline, CI or an AI agent runs it), so it only installed and did not try to connect.' }
            elseif ($mode -eq 'switch') { Write-Host 'The variable $agendNoConnect is set in this window, so it only installed and did not try to connect. To connect from here by itself next time, run $agendNoConnect = $null first.' }
            else { Write-Host 'The reconnect entry could not be written (see above), so it did not connect by itself.' }
            Write-Host 'Next, connect it from an interactive PowerShell window. Open Settings -> Runtime -> Connect a computer in AgEnD for the one-time pairing code, then run:'
            Write-Host ''
            if ($onPath) { Write-Host ('  agend-runtime connect --server "' + $origin + '"') }
            else { Write-Host ('  & "' + $shim + '" connect --server "' + $origin + '"') }
            Write-Host ''
            Write-Host 'A person types the pairing code when asked, compares the fingerprint with the one AgEnD shows, then approves this computer in AgEnD. The code cannot be put in a command, a variable or a file, so an AI agent or script should stop here and give this command to the person.'
            if ($connectBat) { Write-Host ('Or double-click ' + $connectBat + ' on that computer: it connects, and next time it reconnects without asking for the code.') }
            if ($enrollToken) {
                Write-Host 'The one-time token in this command was NOT used. It stays valid until it expires (15 minutes after it was made) or is revoked on the AgEnD page; running the same command again uses it.'
                if ($mode -eq 'noentry') { $global:LASTEXITCODE = 1 }
            }
        }
    } catch {
        Write-Problem ('install failed: ' + $_.Exception.Message)
        $global:LASTEXITCODE = 1
    } finally {
        if ($tmp -and (Test-Path -LiteralPath $tmp)) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
        if ($installLock) { try { Remove-AgendLock $installLock } catch { Write-Problem 'Installation cleanup is unconfirmed; ownership was retained.'; $global:LASTEXITCODE = 1; $doConnect = $false } }
        # A run that installed nothing leaves nothing: the install folder this run created is removed again, but only while it is still empty.
        if ($createdRoot -and $root -and (Test-Path -LiteralPath $root) -and -not (Get-ChildItem -LiteralPath $root -Force | Select-Object -First 1)) { Remove-Item -LiteralPath $root -Force -ErrorAction SilentlyContinue }
    }

    # Connect in this window, after the install lock is gone (a running Runtime takes that lock to update itself). This is the Runtime's own
    # `connect --connection-dir`, the logic of connect-agend.bat, run by the Node.js that was just checked, in the version that was just installed
    # (the same file the shim starts). A path goes to node.exe as an argument, never through cmd.exe. The Runtime asks for the pairing code itself.
    if ($doConnect) {
        $previousPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            Write-Host ''
            if ($enrollToken) {
                Write-Step ('connecting this computer to ' + $origin + ' with the one-time token from the install command: no pairing code and no approval step. The Runtime stays running in this window until you press Ctrl+C (an AI agent or script that must not wait for it should start this command as its own background process). A computer that is already connected to this AgEnD just reconnects, and the token is not used.')
                # The token goes in on standard input, once: not as an argument (it would show in the process list), not in the environment, not in a file.
                $enrollToken | & $nodeExe $cliJs connect --connection-dir $connectDir --enroll-stdin --server-fingerprint $enrollFingerprint
                $enrollToken = $null
            } else {
                Write-Step ('connecting this computer to ' + $origin + '. If it asks for the one-time pairing code, type the one on the AgEnD page (Settings -> Runtime -> Connect a computer); a computer that is already paired just reconnects. Ctrl+C stops it.')
                & $nodeExe $cliJs connect --connection-dir $connectDir
            }
            $connectExit = $LASTEXITCODE
            Write-Host ''
            if ($connectExit -eq 0) { Write-Step ('stopped. To reconnect, double-click ' + $connectBat) }
            else { Write-Problem ('stopped or could not connect (status ' + $connectExit + '). Read the message above for what to do next, then double-click ' + $connectBat + ' to try again.') }
        } catch {
            Write-Problem ('could not start the connection: ' + $_.Exception.Message)
            Write-Host ('The Runtime is installed. Connect with: double-click ' + $connectBat)
            $global:LASTEXITCODE = 1
        } finally { $ErrorActionPreference = $previousPreference }
    }
}
