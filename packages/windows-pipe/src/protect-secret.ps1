param([Parameter(Mandatory=$true)][string]$LiteralPath)
$ErrorActionPreference='Stop'
# Makes a file the caller just created private: owned by the current user, inheritance off,
# only the current user's access. validate-secret.ps1 then accepts it.
try {
 $full=[IO.Path]::GetFullPath($LiteralPath)
 $item=Get-Item -LiteralPath $full -Force
 if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Secret must be a plain file'}
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
 $acl=[Security.AccessControl.FileSecurity]::new()
 $acl.SetOwner($sid)
 $acl.SetAccessRuleProtection($true,$false)
 $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'))
 [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($full),$acl)
} catch {[Console]::Error.WriteLine('Private Windows secret protection failed');exit 1}
