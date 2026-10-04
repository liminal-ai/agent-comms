param([Parameter(Mandatory=$true)][string]$LiteralPath)
$ErrorActionPreference='Stop'
try {
 $item=Get-Item -LiteralPath $LiteralPath -Force
 if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Secret must be a plain file'}
 Add-Type -Path (Join-Path $PSScriptRoot 'SecretFile.cs')
 [Console]::Out.Write([AgentComms.Windows.SecretFile]::Read($LiteralPath))
} catch {[Console]::Error.WriteLine('Private Windows secret validation/read failed');exit 1}
