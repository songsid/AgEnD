param(
 [Parameter(Mandatory=$true)][string]$PrivacyScript,
 [Parameter(Mandatory=$true)][string]$ScratchParent,
 [string]$SharedScratchParent
)
# Run only in an owned Windows scratch directory. No CLI, account, connection or live Runtime is used.
$ErrorActionPreference = 'Stop'
$script = (Get-Item -LiteralPath $PrivacyScript).FullName
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ([IO.DriveInfo]::new([IO.Path]::GetPathRoot([IO.Path]::GetFullPath($ScratchParent))).DriveFormat -ne 'NTFS') { throw 'This proof requires owned NTFS scratch' }
# Hosted scratch prerequisites are logged separately from the product's bounded, path-free refusal.
for ($ancestor = Get-Item -LiteralPath $ScratchParent -Force; $ancestor; $ancestor = $ancestor.Parent) {
 $security = $ancestor.GetAccessControl()
 Write-Host ("Scratch ancestor " + $ancestor.FullName + " owner=" + $security.GetOwner([Security.Principal.SecurityIdentifier]).Value)
 foreach ($rule in $security.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  Write-Host ("  " + $rule.IdentityReference.Value + " " + $rule.AccessControlType + " " + $rule.FileSystemRights + " " + $rule.InheritanceFlags + " " + $rule.PropagationFlags)
 }
}
$work = Join-Path $ScratchParent ('agend-n7-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($work) | Out-Null
$cases = 0; $negative = $null
function Assert($value,[string]$reason) { if (-not $value) { throw $reason } }
function Sddl($path) { return (Get-Item -LiteralPath $path).GetAccessControl().GetSecurityDescriptorSddlForm('Access,Owner,Group') }
function Refused($path) {
 $failed = $false
 try { & $script -Directory $path -RuntimeProfile } catch { $failed = $true }
 Assert $failed 'A shared profile was admitted'
}
try {
 # A shared parent is deliberate: its ACL must never be rewritten by the profile gate.
 $parent = Join-Path $work 'shared-parent'; [IO.Directory]::CreateDirectory($parent) | Out-Null
 $acl = [Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true,$false)
 foreach ($sid in @($user,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-1-0'))) {
  $rights = if ($sid.Value -eq 'S-1-1-0') { 'ReadAndExecute' } else { 'FullControl' }; $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,$rights,'ContainerInherit,ObjectInherit','None','Allow'))
 }
 ([IO.DirectoryInfo]::new($parent)).SetAccessControl($acl); $parentBefore = Sddl $parent
 $fresh = Join-Path $parent 'fresh'
 & $script -Directory $fresh -RuntimeProfile
 $private = (Get-Item -LiteralPath $fresh).GetAccessControl()
 Assert $private.AreAccessRulesProtected 'New profile still inherits the shared ACL'
 $rules = @($private.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
 Assert ($rules.Count -eq 2) 'New profile did not retain exactly the user and SYSTEM grants'
 foreach ($rule in $rules) { Assert ($rule.IdentityReference.Value -in @($user.Value,'S-1-5-18')) 'New profile grants another principal' }
 Assert ((Sddl $parent) -ceq $parentBefore) 'A parent ACL was changed'; $cases++
 # Reusing the private directory is read-only.
 [IO.File]::WriteAllText((Join-Path $fresh 'connection.json'),'synthetic fixture, not a credential')
 $fileOwner = (Get-Item -LiteralPath (Join-Path $fresh 'connection.json')).GetAccessControl().GetOwner([Security.Principal.SecurityIdentifier]).Value
 Assert ($fileOwner -in @($user.Value,'S-1-5-18','S-1-5-32-544')) 'Synthetic state has an untrusted owner'
 Write-Host ("Private synthetic state owner=" + $fileOwner)
 Assert ([IO.File]::ReadAllText((Join-Path $fresh 'connection.json')) -ceq 'synthetic fixture, not a credential') 'The current user cannot read the private result'
 $before = Sddl $fresh; & $script -Directory $fresh -RuntimeProfile
 Assert ((Sddl $fresh) -ceq $before) 'An existing private ACL was rewritten'; $cases++
 # An existing shared directory, even empty, refuses instead of silently changing its ACL.
 $shared = Join-Path $parent 'existing-shared'; [IO.Directory]::CreateDirectory($shared) | Out-Null
 $before = Sddl $shared; Refused $shared
 Assert ((Sddl $shared) -ceq $before) 'An existing shared ACL was rewritten'; $cases++
 [IO.File]::WriteAllText((Join-Path $shared 'unrelated.txt'),'keep')
 Refused $shared
 Assert ([IO.File]::ReadAllText((Join-Path $shared 'unrelated.txt')) -ceq 'keep') 'Unrelated contents changed'; $cases++
 # A protected parent cannot hide an explicit broad file ACL (bypass-traverse case).
 $file = Join-Path $fresh 'connection.json'; $acl = (Get-Item -LiteralPath $file).GetAccessControl()
 $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow'))
 ([IO.FileInfo]::new($file)).SetAccessControl($acl); $before = Sddl $file; Refused $fresh
 Assert ((Sddl $file) -ceq $before) 'An existing child ACL was rewritten'; $cases++
 $unsafe = Join-Path $work 'replaceable-parent'; [IO.Directory]::CreateDirectory($unsafe) | Out-Null
 $acl = (Get-Item -LiteralPath $unsafe).GetAccessControl()
 $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'DeleteSubdirectoriesAndFiles','Allow'))
 ([IO.DirectoryInfo]::new($unsafe)).SetAccessControl($acl); $before = Sddl $unsafe
 Refused (Join-Path $unsafe 'new-profile')
 Assert (-not (Test-Path -LiteralPath (Join-Path $unsafe 'new-profile'))) 'A profile was created under a replaceable parent'
 Assert ((Sddl $unsafe) -ceq $before) 'An unsafe ancestor ACL was rewritten'; $cases++
 foreach ($generic in @('GA','GW')) {
  $unsafeGeneric = Join-Path $work ('generic-' + $generic); [IO.Directory]::CreateDirectory($unsafeGeneric) | Out-Null
  $genericAcl = [Security.AccessControl.DirectorySecurity]::new()
  $genericAcl.SetSecurityDescriptorSddlForm(('O:' + $user.Value + 'D:P(A;;FA;;;' + $user.Value + ')(A;;FA;;;SY)(A;;' + $generic + ';;;WD)'))
  ([IO.DirectoryInfo]::new($unsafeGeneric)).SetAccessControl($genericAcl); $before = Sddl $unsafeGeneric
  Refused (Join-Path $unsafeGeneric 'new-profile')
  Assert (-not (Test-Path -LiteralPath (Join-Path $unsafeGeneric 'new-profile'))) 'A generic-write/all ancestor was admitted'
  Assert ((Sddl $unsafeGeneric) -ceq $before) 'A generic ancestor ACL changed'; $cases++
 }
 if ($SharedScratchParent) {
  # Hosted RUNNER_TEMP is genuinely shared; refusal here is a separate negative, not the positive fixture's precondition.
  $negative = Join-Path $SharedScratchParent ('agend-n7-shared-' + [Guid]::NewGuid().ToString('N'))
  $before = Sddl $SharedScratchParent; Refused $negative
  Assert (-not (Test-Path -LiteralPath $negative)) 'A profile was created under the shared hosted namespace'
  Assert ((Sddl $SharedScratchParent) -ceq $before) 'The hosted shared parent ACL changed'; $cases++
 }
 Assert ((Sddl $parent) -ceq $parentBefore) 'Parent ACL changed after a refusal'
 @{cases=$cases;result='pass';scope='owned NTFS ACL only; no provider or Runtime'} | ConvertTo-Json -Compress
} finally {
 # Only the GUID directory created above is removed.
 if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
 if ($negative -and (Test-Path -LiteralPath $negative)) { Remove-Item -LiteralPath $negative -Recurse -Force }
}
