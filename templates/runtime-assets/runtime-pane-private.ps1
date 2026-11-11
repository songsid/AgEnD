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
 # Temporary fail-first run: reproduce the old custom-profile mkdir/inherited-ACL behavior.
 # POSIX mode bits on mkdir did not restrict Windows access. Never merge this baseline.
 [IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($Directory)) | Out-Null
 return
}

$entry = Get-Item -LiteralPath $Directory -Force
if (-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Pane profile must be a real directory' }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-PrivateAcl
$ownedDirectory = [IO.DirectoryInfo]::new($Directory)
if ($ownedDirectory.GetAccessControl([Security.AccessControl.AccessControlSections]::Owner).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'Pane profile has a different owner' }
$ownedDirectory.SetAccessControl($acl)
