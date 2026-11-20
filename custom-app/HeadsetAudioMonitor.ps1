#requires -Version 7.0
param([Parameter(Mandatory)][string]$EndpointIdsBase64)
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'Audio monitoring requires Windows.'}
if($EndpointIdsBase64.Length -gt 12000){throw 'Endpoint selection exceeds limit.'}
$ids=@(ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EndpointIdsBase64))))
if($ids.Count -lt 1 -or $ids.Count -gt 2 -or @($ids|Select-Object -Unique).Count -ne $ids.Count){throw 'Select one or two distinct endpoints.'}
foreach($id in $ids){if($id -isnot [string] -or $id -notmatch '^\{0\.0\.[01]\.00000000\}\.\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$'){throw 'Invalid complete endpoint identifier.'}}
$root=if((Split-Path $PSScriptRoot -Leaf)-eq'custom-app'){Split-Path $PSScriptRoot}else{[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))}
Add-Type -Path (Join-Path $root 'native\CoreAudio.cs')
Add-Type -Path (Join-Path $root 'native\AudioExtras.cs')
. (Join-Path $PSScriptRoot 'HeadsetDiagnostics.ps1')
Add-Type -TypeDefinition 'using System;using System.Threading.Tasks;namespace PeripheralHub{public static class AudioMonitorStop{public static Task<string> ReadAsync(){return Task.Run(()=>Console.In.ReadLine());}}}'
$targets=@{}
$identities=@([PeripheralHub.CoreAudio]::ListEndpointIdentities()|Where-Object {$ids -ccontains $_.Id})
$present=@(Get-PnpDevice -PresentOnly -InstanceId 'USB\VID_0E6A&PID_0110&MI_00\*' -ErrorAction Stop)
$nodes=@{}
$getNode={param($instanceId)
 if($nodes.ContainsKey($instanceId)){return $nodes[$instanceId]}
 $parent=Get-PnpDeviceProperty -InstanceId $instanceId -KeyName 'DEVPKEY_Device_Parent' -ErrorAction Stop
 $node=@{instanceId=$instanceId;parentId=[string]$parent.Data};$nodes[$instanceId]=$node;return $node
}.GetNewClosure()
foreach($id in $ids){
 $found=@($identities|Where-Object {$_.Id -ceq $id})
 if($found.Count -ne 1){throw 'Monitor endpoint is not active.'}
 $identity=$found[0];$instanceId=[string]$identity.InstanceId
 if(-not $instanceId){$node=Get-PnpDevice -PresentOnly -InstanceId ('SWD\MMDEVAPI\'+$id) -ErrorAction Stop;$instanceId=[string]$node.InstanceId}
 $chain=Get-HeadsetParentChain -InstanceId $instanceId -GetNode $getNode
 if(-not $chain.target -or @($present|Where-Object {$_.InstanceId -ieq $chain.target.instanceId}).Count -ne 1){throw 'Monitor endpoint is not a present, verified iKF USB audio interface.'}
 $expectedFlow=if($id -match '^\{0\.0\.0\.'){'render'}else{'capture'}
 if($identity.Flow -cne $expectedFlow){throw 'Monitor endpoint direction does not match its identifier.'}
 $targets[$id]=@{flow=$identity.Flow}
}
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::Out.WriteLine((@{type='ready';source='windows-system';endpointIds=$ids}|ConvertTo-Json -Compress))
[Console]::Out.Flush()
$stop=[PeripheralHub.AudioMonitorStop]::ReadAsync()
while(-not $stop.IsCompleted){
 $sampledAt=[datetime]::UtcNow.ToString('o')
 $samples=@(foreach($id in $ids){
  $sample=[ordered]@{endpointId=$id;name=$null;flow=$targets[$id].flow;available=$false;identityVerified=$false;volume=$null;muted=$null;channels=$null;peaks=$null;error=$null}
  try{
   $actual=[PeripheralHub.CoreAudio]::Get($id)
   if($actual.Id -cne $id -or $actual.Flow -cne $targets[$id].flow){throw 'Audio monitor identity changed.'}
   $sample.name=$actual.Name;$sample.available=$true;$sample.identityVerified=$true;$sample.volume=[double]$actual.Volume;$sample.muted=[bool]$actual.Muted
   $errors=[Collections.Generic.List[string]]::new()
   try{$values=@([PeripheralHub.AudioExtras]::GetChannels($id).Levels);if($values.Count -lt 1 -or $values.Count -gt 32){throw 'Invalid channel count.'};$sample.channels=$values}catch{$errors.Add('声道：'+$_.Exception.Message)}
   try{$values=@([PeripheralHub.AudioExtras]::GetPeaks($id));if($values.Count -lt 1 -or $values.Count -gt 32){throw 'Invalid peak count.'};$sample.peaks=$values}catch{$errors.Add('峰值：'+$_.Exception.Message)}
   if($errors.Count){$sample.error=($errors -join '；');if($sample.error.Length -gt 2048){$sample.error=$sample.error.Substring(0,2048)}}
  }catch{$sample.available=$false;$sample.identityVerified=$false;$sample.volume=$null;$sample.muted=$null;$sample.channels=$null;$sample.peaks=$null;$sample.error=$_.Exception.Message;if($sample.error.Length -gt 2048){$sample.error=$sample.error.Substring(0,2048)}}
  $sample
 })
 $event=@{type='sample';source='windows-system';sampledAt=$sampledAt;endpoints=$samples}
 [Console]::Out.WriteLine(($event|ConvertTo-Json -Depth 8 -Compress))
 [Console]::Out.Flush()
 Start-Sleep -Milliseconds 250
}
