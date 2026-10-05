param([ValidateSet('server','client')][string]$Mode,[string]$Suffix)
$ErrorActionPreference='Stop'
try {
 Add-Type -Path @((Join-Path $PSScriptRoot 'PrivatePipe.cs'),(Join-Path $PSScriptRoot 'Bridge.cs'))
 [AgentComms.Windows.Bridge]::Run($Mode,$Suffix).GetAwaiter().GetResult()
} catch {
 $errorObject=$_.Exception
 while($errorObject.InnerException){$errorObject=$errorObject.InnerException}
 $code='EIO'
 if($errorObject -is [TimeoutException]){$code='ECONNREFUSED'}
 elseif($errorObject -is [UnauthorizedAccessException]){$code='EACCES'}
 elseif($errorObject -is [ComponentModel.Win32Exception]){
  if($errorObject.NativeErrorCode -in @(2,3)){$code='ENOENT'}
  elseif($errorObject.NativeErrorCode -eq 5){$code='EACCES'}
 }
 [Console]::Out.WriteLine("E`t0`t$code");[Console]::Out.Flush()
 [Console]::Error.WriteLine($errorObject.Message)
 exit 1
}
