param([Parameter(Mandatory=$true)][string]$LiteralPath,[Parameter(Mandatory=$true)][ValidateSet('check','protect')][string]$Mode)
$ErrorActionPreference='Stop'
# A directory only the current user can reach: owned by them, inheritance off, and only their
# access, inherited by everything created inside. 'protect' sets that (for an empty or new
# directory); 'check' exits 3 unless it already holds.
try {
 $full=[IO.Path]::GetFullPath($LiteralPath)
 $item=Get-Item -LiteralPath $full -Force
 if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Data directory must be a plain directory'}
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
 if($Mode -eq 'protect'){
  $acl=[Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true,$false)
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
  [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($full),$acl)
 }
 $acl=[IO.FileSystemAclExtensions]::GetAccessControl([IO.DirectoryInfo]::new($full))
 if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){exit 3}
 if(-not $acl.AreAccessRulesProtected){exit 3}
 foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
  if($rule.IdentityReference.Value -ne $sid.Value){exit 3}
 }
} catch {[Console]::Error.WriteLine('Private Windows directory check failed');exit 1}
