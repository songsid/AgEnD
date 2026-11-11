param([Parameter(Mandatory=$true)][string]$Directory, [switch]$RuntimeProfile)
$ErrorActionPreference = 'Stop'
# Existing Runtime profiles are verification-only: a parent DACL rewrite can alter unrelated descendants.
# The creation overload supplies the private DACL to newly created directories, not after their creation.
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
function New-PrivateAcl {
 $value = New-Object Security.AccessControl.DirectorySecurity
 $value.SetAccessRuleProtection($true,$false)
 $value.SetOwner($user)
 foreach ($sid in @($user,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
  $value.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
 }
 return $value
}
if ($RuntimeProfile) {
 $allowed = @($user.Value,'S-1-5-18','S-1-5-32-544') # Local administrators already control this Windows user; ordinary users are never allowed.
 $watch = [Diagnostics.Stopwatch]::StartNew()
 function Real-Entry($entry) {
  if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Runtime profile contains a reparse point' }
 }
 function Private-Entry($entry) {
  Real-Entry $entry
  $security = $entry.GetAccessControl([Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner)
  $owner = $security.GetOwner([Security.Principal.SecurityIdentifier]).Value
  # Elevated Windows writes may use the Administrators default owner. That principal is already trusted by the DACL policy.
  if ($owner -notin $allowed) { throw 'Runtime profile has a different owner' }
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($security.GetSecurityDescriptorBinaryForm(),0)
  if (-not ($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -or $null -eq $raw.DiscretionaryAcl) { throw 'Runtime profile has no private DACL' }
  foreach ($rule in $security.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
   if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Value -notin $allowed) { throw 'Runtime profile is shared with another Windows principal' }
  }
 }
 # A checked private leaf is insufficient if another account can replace an ancestor after this check.
 $ancestorAllowed = @($allowed)
 try { $ancestorAllowed += ([Security.Principal.NTAccount]::new('NT SERVICE','TrustedInstaller')).Translate([Security.Principal.SecurityIdentifier]).Value } catch { }
 $namespaceWrite = [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership -bor [Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor 0x50000000 # Unmapped GENERIC_ALL / GENERIC_WRITE are mutable too.
 function Stable-Ancestor($entry) {
  Real-Entry $entry
  $security = $entry.GetAccessControl([Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner)
  if ($security.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $ancestorAllowed) { throw 'Runtime profile ancestor has an untrusted owner' }
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($security.GetSecurityDescriptorBinaryForm(),0)
  if (-not ($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -or $null -eq $raw.DiscretionaryAcl) { throw 'Runtime profile ancestor has no private namespace ACL' }
  foreach ($rule in $security.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
   if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and -not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and $rule.IdentityReference.Value -notin $ancestorAllowed -and ($rule.FileSystemRights -band $namespaceWrite)) { throw 'Runtime profile ancestor can be replaced by another principal' }
  }
 }
 $full = [IO.Path]::GetFullPath($Directory)
 $missing = [Collections.Generic.Stack[string]]::new()
 for ($path = $full; -not (Test-Path -LiteralPath $path); $path = [IO.Path]::GetDirectoryName($path)) {
  if (-not $path) { throw 'Runtime profile has no real parent' }
  $missing.Push($path)
 }
 for ($walk = Get-Item -LiteralPath $path -Force; $walk; $walk = $walk.Parent) { if ($walk -isnot [IO.DirectoryInfo]) { throw 'Runtime profile parent is not a directory' }; Stable-Ancestor $walk }
 while ($missing.Count -gt 0) {
  $created = [IO.DirectoryInfo]::new($missing.Pop())
  $created.Create((New-PrivateAcl))
  Private-Entry (Get-Item -LiteralPath $created.FullName -Force)
 }
 $root = Get-Item -LiteralPath $full -Force
 if (-not $root.PSIsContainer) { throw 'Runtime profile is not a directory' }
 $pending = [Collections.Generic.Stack[object]]::new(); $pending.Push($root); $count = 0
 while ($pending.Count -gt 0) {
  $entry = $pending.Pop(); $count++
  if ($count -gt 20000 -or $watch.ElapsedMilliseconds -gt 25000) { throw 'Runtime profile privacy check exceeded its limit' }
  Private-Entry $entry
  if ($entry.Attributes -band [IO.FileAttributes]::Directory) {
   foreach ($child in $entry.EnumerateFileSystemInfos()) {
    if ($count + $pending.Count -ge 20000 -or $watch.ElapsedMilliseconds -gt 25000) { throw 'Runtime profile privacy check exceeded its limit' }
    $pending.Push($child)
   }
  }
 }
 return
}
$entry = Get-Item -LiteralPath $Directory -Force
if (-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Pane profile must be a real directory' }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-PrivateAcl
$ownedDirectory = [IO.DirectoryInfo]::new($Directory)
if ($ownedDirectory.GetAccessControl([Security.AccessControl.AccessControlSections]::Owner).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'Pane profile has a different owner' }
$ownedDirectory.SetAccessControl($acl)
