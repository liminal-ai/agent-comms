$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot '..\src\PrivatePipe.cs')
$suffix='test-'+[Guid]::NewGuid().ToString('N')
$pipe=$null
$client=$null
try {
    $pipe=[AgentComms.Windows.PrivatePipe]::Create($suffix)
    $descriptor=[AgentComms.Windows.PrivatePipe]::Descriptor($pipe)
    $blocked=$false
    try {$duplicate=[AgentComms.Windows.PrivatePipe]::Create($suffix); $duplicate.Dispose()} catch {$blocked=$true}
    if(!$blocked){throw 'Duplicate first instance was not rejected'}
    $accept=$pipe.WaitForConnectionAsync()
    $client=[IO.Pipes.NamedPipeClientStream]::new('.',[AgentComms.Windows.PrivatePipe]::Name($suffix),[IO.Pipes.PipeDirection]::InOut,[IO.Pipes.PipeOptions]::Asynchronous)
    $client.Connect(3000)
    if(!$accept.Wait(3000)){throw 'Accept timed out'}
    $payload=[Text.Encoding]::UTF8.GetBytes('local-private-pipe-test')
    $client.Write($payload,0,$payload.Length)
    $buffer=[byte[]]::new(128)
    $read=$pipe.ReadAsync($buffer,0,$buffer.Length)
    if(!$read.Wait(3000)){throw 'Read timed out'}
    if([Text.Encoding]::UTF8.GetString($buffer,0,$read.Result) -ne 'local-private-pipe-test'){throw 'Payload mismatch'}
    $pipe.Write($payload,0,$payload.Length)
    $reply=$client.ReadAsync($buffer,0,$buffer.Length)
    if(!$reply.Wait(3000)){throw 'Reply timed out'}
    if([Text.Encoding]::UTF8.GetString($buffer,0,$reply.Result) -ne 'local-private-pipe-test'){throw 'Reply mismatch'}
    $client.Dispose(); $client=$null
    $pipe.Dispose(); $pipe=$null
    $pipe=[AgentComms.Windows.PrivatePipe]::Create($suffix)
    $invalid=$false
    try {[AgentComms.Windows.PrivatePipe]::Name('../bad') | Out-Null} catch {$invalid=$true}
    if(!$invalid){throw 'Invalid suffix accepted'}
    [pscustomobject]@{SameUserRoundTrip='pass';DuplicateInstance='rejected';Restart='pass';InvalidName='rejected';SecurityDescriptor=$descriptor;RemoteAndOtherUser='not dynamically tested';Integration='primitive only'} | ConvertTo-Json
} finally {if($client){$client.Dispose()};if($pipe){$pipe.Dispose()}}
