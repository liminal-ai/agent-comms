$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot '..\src\PrivatePipe.cs')
$suffix='http-test-'+[Guid]::NewGuid().ToString('N')
$pipe=[AgentComms.Windows.PrivatePipe]::Create($suffix)
$process=$null
try {
 $accept=$pipe.WaitForConnectionAsync()
 $info=[Diagnostics.ProcessStartInfo]::new((Get-Command node).Source)
 $info.UseShellExecute=$false; $info.CreateNoWindow=$true
 $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
 $info.ArgumentList.Add((Join-Path $PSScriptRoot 'http-client.mjs'))
 $info.ArgumentList.Add('\\.\pipe\'+[AgentComms.Windows.PrivatePipe]::Name($suffix))
 $process=[Diagnostics.Process]::Start($info)
 if(!$accept.Wait(5000)){throw 'Node client connection timeout'}
 $buffer=[byte[]]::new(8192)
 $read=$pipe.ReadAsync($buffer,0,$buffer.Length)
 if(!$read.Wait(5000)){throw 'HTTP request timeout'}
 $request=[Text.Encoding]::UTF8.GetString($buffer,0,$read.Result)
 if(!$request.StartsWith('POST /comms/test HTTP/1.1')){throw 'Unexpected HTTP request'}
 $body='{"ok":true,"probe":"node-http"}'
 $response="HTTP/1.1 200 OK`r`nContent-Type: application/json`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n$body"
 $bytes=[Text.Encoding]::UTF8.GetBytes($response)
 $pipe.Write($bytes,0,$bytes.Length);$pipe.Flush()
 if(!$process.WaitForExit(5000)){throw 'Node client exit timeout'}
 $output=$process.StandardOutput.ReadToEnd();$errors=$process.StandardError.ReadToEnd()
 if($process.ExitCode -ne 0){throw "Node client failed: $errors"}
 $output.Trim()
} finally { $pipe.Dispose(); if($process){if(!$process.HasExited){$process.Kill()};$process.Dispose()} }
