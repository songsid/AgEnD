param(
 [Parameter(Mandatory=$true)][string]$Archive,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$Sha256,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$Scope
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Real-Directory([string]$Path) {
 $entry = Get-Item -LiteralPath $Path -Force
 if (-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe pane code directory' }
}
function Private-Directory([string]$Path) {
 [IO.Directory]::CreateDirectory($Path) | Out-Null
 Real-Directory $Path
 $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
 $acl = [Security.AccessControl.DirectorySecurity]::new()
 $directory = [IO.DirectoryInfo]::new($Path)
 if ($directory.GetAccessControl([Security.AccessControl.AccessControlSections]::Owner).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'Pane code directory has a different owner' }
 $acl.SetAccessRuleProtection($true,$false)
 foreach ($sid in @($user,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
 }
 $directory.SetAccessControl($acl)
}
if (-not $env:LOCALAPPDATA -or -not [IO.Path]::IsPathRooted($env:LOCALAPPDATA)) { throw 'Windows local application-data directory is unavailable' }
$parent = [IO.Path]::GetFullPath($env:LOCALAPPDATA)
for ($walk = Get-Item -LiteralPath $parent -Force; $walk; $walk = $walk.Parent) { Real-Directory $walk.FullName }
foreach ($leaf in @('AgEnD','p',$Scope.Substring(0,16),'b')) { $parent = Join-Path $parent $leaf; Private-Directory $parent }
$destination = Join-Path $parent $Sha256.Substring(0,16)
$temporary = Join-Path $parent ([Guid]::NewGuid().ToString('N'))
$archiveEntry = Get-Item -LiteralPath $Archive -Force
if ($archiveEntry.PSIsContainer -or ($archiveEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $archiveEntry.Length -gt 8388608) { throw 'Unsafe pane code archive' }
$bytes = [IO.File]::ReadAllBytes($Archive)
$hash = [Security.Cryptography.SHA256]::Create()
function Digest([byte[]]$Value) { return [BitConverter]::ToString($hash.ComputeHash($Value)).Replace('-','').ToLowerInvariant() }
if ((Digest $bytes) -cne $Sha256) { throw 'Pane code archive checksum differs' }
Add-Type -AssemblyName System.IO.Compression
$memory = [IO.MemoryStream]::new($bytes,$false)
$zip = [IO.Compression.ZipArchive]::new($memory,[IO.Compression.ZipArchiveMode]::Read)
$exists = Test-Path -LiteralPath $destination
if ($exists) {
 Real-Directory $destination
 $marker = Get-Item -LiteralPath (Join-Path $destination 'bundle.sha256') -Force
 if ($marker.PSIsContainer -or ($marker.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $marker.Length -ne 64 -or [IO.File]::ReadAllText($marker.FullName) -cne $Sha256) { throw 'Staged pane bundle identity differs' }
} else { Private-Directory $temporary }
try {
 $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
 $total = 0
 if ($zip.Entries.Count -gt 512) { throw 'Pane code archive has too many entries' }
 foreach ($entry in $zip.Entries) {
  if ($entry.FullName -notmatch '^agend-runtime/[A-Za-z0-9_@./-]+$' -or $entry.FullName.Contains('..') -or $entry.FullName.EndsWith('/') -or -not $seen.Add($entry.FullName) -or $entry.Length -gt 2097152) { throw 'Unsafe pane code archive entry' }
  $total += $entry.Length
  if ($total -gt 8388608) { throw 'Pane code archive is too large' }
  $stream = $entry.Open(); $content = [IO.MemoryStream]::new()
  try { $buffer = [byte[]]::new(65536); while (($count = $stream.Read($buffer,0,$buffer.Length)) -gt 0) { if ($content.Length + $count -gt 2097152) { throw 'Pane code entry exceeded its limit' }; $content.Write($buffer,0,$count) }; $data = $content.ToArray() } finally { $stream.Dispose(); $content.Dispose() }
  $base = if ($exists) { $destination } else { $temporary }
  $file = Join-Path $base $entry.FullName.Replace('/','\')
  if ($exists) {
   for ($walk = Get-Item -LiteralPath ([IO.Path]::GetDirectoryName($file)) -Force; $walk.FullName -ne $base; $walk = $walk.Parent) { Real-Directory $walk.FullName }
   $onDisk = Get-Item -LiteralPath $file -Force
   if ($onDisk.PSIsContainer -or ($onDisk.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $onDisk.Length -ne $data.Length -or (Digest ([IO.File]::ReadAllBytes($file))) -cne (Digest $data)) { throw 'Staged pane code changed; no files were overwritten' }
  } else {
   [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file)) | Out-Null
   [IO.File]::WriteAllBytes($file,$data)
  }
 }
 if (-not $seen.Contains('agend-runtime/dist/runtime-pane-stdio.js')) { throw 'Pane relay module is missing' }
 # Verify the complete tree before executing it: unlisted package.json or JS can change Node resolution.
 $base = if ($exists) { $destination } else { $temporary }
 $allowedDirectories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
 foreach ($name in $seen) {
  for ($relative = [IO.Path]::GetDirectoryName($name.Replace('/','\')); $relative; $relative = [IO.Path]::GetDirectoryName($relative)) { [void]$allowedDirectories.Add($relative) }
 }
 $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push($base)
 while ($pending.Count -gt 0) {
  $directory = $pending.Pop()
  foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
   $relative = $item.FullName.Substring($base.Length + 1)
   if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Staged pane code contains an unexpected link' }
   if ($item.PSIsContainer) {
    if (-not $allowedDirectories.Contains($relative)) { throw 'Staged pane code contains an unexpected directory' }
    $pending.Push($item.FullName)
   } elseif (-not $seen.Contains($relative.Replace('\','/')) -and -not ($exists -and $relative -ceq 'bundle.sha256')) { throw 'Staged pane code contains an unexpected file' }
  }
 }
 if (-not $exists) {
  [IO.File]::WriteAllText((Join-Path $temporary 'bundle.sha256'),$Sha256,[Text.Encoding]::ASCII)
  # Antivirus may briefly retain handles to freshly written native prebuilds. Never overwrite a live stage.
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  for (;;) {
   try { [IO.Directory]::Move($temporary,$destination); break }
   catch { if ((Test-Path -LiteralPath $destination) -or [DateTime]::UtcNow -ge $deadline) { throw 'Pane code staging could not be committed; retry after the pending file operation finishes' }; Start-Sleep -Milliseconds 200 }
  }
 }
 $relay = Join-Path $destination 'agend-runtime\dist\runtime-pane-stdio.js'
 $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
 [Console]::Write((@{relay=$relay;node=$node} | ConvertTo-Json -Compress))
} finally {
 $zip.Dispose(); $memory.Dispose(); $hash.Dispose()
 if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
