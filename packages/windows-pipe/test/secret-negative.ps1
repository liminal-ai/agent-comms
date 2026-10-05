$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot '..\src\SecretFile.cs')
$dir=Join-Path $env:TEMP ('comms-readonly-acl-test-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $dir | Out-Null
$file=Join-Path $dir 'disposable.txt'
Set-Content -LiteralPath $file -Value 'not-a-real-credential' -NoNewline
$rejected=$false
try {[AgentComms.Windows.SecretFile]::Read($file) | Out-Null} catch {$rejected=$true}
if(!$rejected){throw 'Default broad ACL unexpectedly accepted'}
Remove-Item -LiteralPath $file
Remove-Item -LiteralPath $dir
'Default broad-ACL secret rejection: pass'
