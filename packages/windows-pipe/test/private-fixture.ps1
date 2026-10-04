param([Parameter(Mandatory=$true)][string]$LiteralPath)
$ErrorActionPreference='Stop'
# Test helper only: mutate only fixture.txt in a freshly allocated temp fixture directory.
$full=[IO.Path]::GetFullPath($LiteralPath)
$parent=[IO.Path]::GetDirectoryName($full)
if([IO.Path]::GetDirectoryName($parent).TrimEnd('\') -ne [IO.Path]::GetTempPath().TrimEnd('\') -or [IO.Path]::GetFileName($parent) -notlike 'comms-private-fixture-*' -or [IO.Path]::GetFileName($full) -ne 'fixture.txt'){throw 'Not a disposable private fixture path'}
$item=Get-Item -LiteralPath $full
if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Fixture must be a plain file'}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[Security.AccessControl.FileSecurity]::new()
$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'))
[IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($full),$acl)
