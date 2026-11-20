#requires -Version 7.0
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'Windows foreground observation requires Windows.'}
$script:root=if((Split-Path $PSScriptRoot -Leaf)-eq'custom-app'){Split-Path $PSScriptRoot}else{[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))}
$script:listener=$null
if(-not('PeripheralHub.WindowsForegroundObserver'-as[type])){Add-Type -Path (Join-Path $script:root 'native\WindowsForegroundObserver.cs')}
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Write-Message($Message){[Console]::Out.WriteLine(($Message|ConvertTo-Json -Depth 8 -Compress));[Console]::Out.Flush()}
function Start-WindowsListener {
 if($script:listener){throw 'Windows foreground listener is already active.'}
 $script:listener=[PeripheralHub.WindowsForegroundObserver]::new()
}
function Stop-WindowsListener {
 if(-not$script:listener){return}
 $script:listener.Stop()
 $drainError=$null
 try{Drain-WindowsEvents}catch{$drainError=$_.Exception}
 $script:listener.Dispose()
 $script:listener=$null
 if($drainError){throw $drainError}
}
function Write-Reconciliation {
 $sample=[PeripheralHub.WindowsForegroundObserver]::ReadCurrent()
 Write-Message @{type='foreground';path=$sample.FilePath;pid=$sample.ProcessId;reconcile=$true}
}
function Drain-WindowsEvents {
 if(-not$script:listener){return}
 $callbackError=$script:listener.TakeError();if($callbackError){throw ('Windows foreground callback failed: '+$callbackError)}
 while($null-ne($item=$script:listener.Dequeue())){
  Write-Message @{type='foreground';path=$item.FilePath;pid=$item.ProcessId;reconcile=$false}
  $callbackError=$script:listener.TakeError();if($callbackError){throw ('Windows foreground callback failed: '+$callbackError)}
 }
}
function Invoke-Command($Command) {
 $keys=@($Command.PSObject.Properties.Name)
 if($keys.Count-ne2-or'command'-cnotin$keys-or'requestId'-cnotin$keys-or$Command.command-isnot[string]-or($Command.requestId-isnot[int]-and$Command.requestId-isnot[long])-or$Command.requestId-le0-or$Command.requestId-gt[int]::MaxValue){throw 'Invalid worker command.'}
 $id=[int]$Command.requestId
 switch -CaseSensitive ($Command.command) {
  'pause' {
   if(-not$script:listener){throw 'Cannot pause an inactive Windows foreground listener.'}
   Drain-WindowsEvents;Write-Reconciliation;Stop-WindowsListener
   Write-Message @{type='paused';requestId=$id}
  }
  'resume' {
   if($script:listener){throw 'Cannot resume an active Windows foreground listener.'}
   Start-WindowsListener
   Write-Message @{type='resumed';requestId=$id}
   Drain-WindowsEvents;Write-Reconciliation;Drain-WindowsEvents
  }
  'stop' {
   if($script:listener){Drain-WindowsEvents;Stop-WindowsListener}
   Write-Message @{type='stopped';requestId=$id}
   return $true
  }
  default {throw 'Unknown worker command.'}
 }
 return $false
}
try{
 Start-WindowsListener
 Write-Message @{type='ready';source='windows-foreground'}
 Drain-WindowsEvents;Write-Reconciliation;Drain-WindowsEvents
 $commandTask=[PeripheralHub.WindowsForegroundObserver]::ReadCommandAsync()
 $stop=$false
 while(-not$stop){
  Drain-WindowsEvents
  if($commandTask.IsCompleted){
   $line=$commandTask.GetAwaiter().GetResult();if($null-eq$line){throw 'Worker command channel closed unexpectedly.'}
   $command=$line|ConvertFrom-Json -ErrorAction Stop
   $stop=Invoke-Command $command
   if(-not$stop){$commandTask=[PeripheralHub.WindowsForegroundObserver]::ReadCommandAsync()}
  }else{Start-Sleep -Milliseconds 10}
 }
}catch{
 try{Write-Message @{type='error';message=$_.Exception.Message}}catch{}
 throw
}finally{
 if($script:listener){try{Stop-WindowsListener}catch{try{Write-Message @{type='error';message=('Worker cleanup failed: '+$_.Exception.Message)}}catch{}}}
}
