$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot '..\src\SecretFile.cs')
$dir=Join-Path $env:TEMP ('comms-acl-test-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $dir | Out-Null
$file=Join-Path $dir 'test-value.txt'
Set-Content -LiteralPath $file -Value 'disposable-test-value' -NoNewline
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[Security.AccessControl.FileSecurity]::new()
$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'))
[IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($file),$acl)
if([AgentComms.Windows.SecretFile]::Read($file) -ne 'disposable-test-value'){throw 'Private read failed'}
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow'))
[IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($file),$acl)
$rejected=$false
try {[AgentComms.Windows.SecretFile]::Read($file) | Out-Null} catch {$rejected=$true}
if(!$rejected){throw 'Broad ACL accepted'}
# These are newly created disposable test objects, never existing secret files.
Remove-Item -LiteralPath $file
Remove-Item -LiteralPath $dir
'Private secret read and broad-ACL rejection: pass'
