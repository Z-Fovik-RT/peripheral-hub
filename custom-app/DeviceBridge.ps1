#requires -Version 7.0
param([Parameter(Mandatory)][string]$RequestPath,[Parameter(Mandatory)][string]$ResponsePath)
$ErrorActionPreference='Stop'
$exitCode=0
$operationGate=$null
$gateOwned=$false
try {
    $request=[IO.File]::ReadAllText($RequestPath)|ConvertFrom-Json
    $root=if((Split-Path $PSScriptRoot -Leaf)-eq'custom-app'){Split-Path $PSScriptRoot}else{[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))}
    $native=Join-Path $root 'native'
    Add-Type -Path @((Join-Path $native 'HidInventory.cs'),(Join-Path $native 'HidConfigTransport.cs'),(Join-Path $native 'AulaSettingsCodec.cs'),(Join-Path $native 'AulaConfigurationCodec.cs'),(Join-Path $native 'In9FeatureProtocol.cs'),(Join-Path $native 'AulaReadModels.cs'))
    $deviceId=[string]$request.id
    if($deviceId -notin @('aula-f87-pro','inphic-in9')) { throw 'Unknown configuration device.' }
    # Device IDs are mapped by the trusted main process; no renderer-provided path is used.
    $isAula=$deviceId -like 'aula-*'
    $gateName=if($isAula){'Local\PeripheralHub.HidConfig.Aula-3554-FA09'}else{'Local\PeripheralHub.HidConfig.In9-248A-5B2F'}
    $operationGate=[Threading.Mutex]::new($false,$gateName)
    try {$gateOwned=$operationGate.WaitOne(10000)} catch [Threading.AbandonedMutexException] {$gateOwned=$true}
    if(-not $gateOwned){throw 'Another operation is still using this device.'}
    $stateDir=Join-Path $root 'local-state\device-recovery'
    [IO.Directory]::CreateDirectory($stateDir)|Out-Null
    $containerId=if($isAula){[PeripheralHub.HidConfigTransport]::AulaContainerId()}else{$null}
    $receiverKey=if($isAula){([guid]$containerId).ToString('N')}else{'none'}
    $aulaPsdHex=$null
    function Read-AulaPsdHex([switch]$SingleAttempt) {
        if(-not$isAula){throw 'AULA identity is unavailable for this device.'}
        [byte[]]$identityRaw=if($SingleAttempt){[PeripheralHub.HidConfigTransport]::AulaQuerySelectorOnce(19,5,10,0,6000)}else{[PeripheralHub.HidConfigTransport]::AulaQuery(19,5,10,6000)}
        $identity=[PeripheralHub.AulaReadModels]::ParseIdentity10($identityRaw)
        if(-not$identity.MatchesExpectedPsd){throw 'AULA PSD does not match the verified F87 PRO profile; write and restore are disabled.'}
        return $identity.PsdHex
    }
    $ledger=Join-Path $stateDir ('aula-led-original-'+$receiverKey+'.json')
    $pendingPath=Join-Path $stateDir 'aula-led-pending.json'
    function Read-Recovery([string]$path) {
        $record=[IO.File]::ReadAllText($path)|ConvertFrom-Json
        [byte[]]$payload=[Convert]::FromBase64String([string]$record.payloadBase64)
        [PeripheralHub.AulaSettingsCodec]::Validate($payload)
        if($record.schema-ne3 -or $record.vid-ne'3554' -or $record.pid-ne'FA09' -or $record.containerId-ne$containerId -or $record.psdHex-ne$aulaPsdHex -or $record.sha256-ne[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($payload))){throw 'Keyboard recovery integrity check failed; saved data was not replaced.'}
        return ,$payload
    }
    function Begin-Transaction([byte[]]$before) {
        if(Test-Path -LiteralPath $pendingPath){throw 'An earlier write is unverified. Read and restore the pending snapshot before another change.'}
        [PeripheralHub.AulaSettingsCodec]::Validate($before)
        $record=[ordered]@{schema=3;vid='3554';pid='FA09';containerId=$containerId;psdHex=$aulaPsdHex;savedAt=[datetime]::UtcNow.ToString('o');action=[string]$request.action;setting=[string]$request.setting;payloadBase64=[Convert]::ToBase64String($before);sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($before))}
        $temp=$pendingPath+'.tmp';[IO.File]::WriteAllText($temp,($record|ConvertTo-Json -Depth 4));[IO.File]::Move($temp,$pendingPath,$false)
    }
    function Complete-Transaction {
        # Keep the journal as an archive after verification; only the fixed pending file is moved.
        if(Test-Path -LiteralPath $pendingPath){
            $archive=Join-Path $stateDir ('aula-led-completed-'+[guid]::NewGuid().ToString('N')+'.json')
            [IO.File]::Move($pendingPath,$archive,$false)
        }
    }
    function Read-Aula { return ,[PeripheralHub.HidConfigTransport]::AulaQuery(0x13,0x44,128,6000) }
    function Convert-Aula([byte[]]$bytes) {
        $parsed=[PeripheralHub.AulaSettingsCodec]::ParseLED128($bytes)
        $modes=@()
        foreach($candidate in $parsed.ModeTableCandidates) {
            # The public F87 PRO evidence identifies hardware modes 1..18.
            # Only the installed profile's 14 supported effects are listed here;
            # capability flags separately control which fields can be written.
            if($candidate.HardwareModeId -ge 1 -and $candidate.HardwareModeId -le 18 -and $candidate.HardwareModeId -notin @(6,9,14,18)) {
                $modes += [ordered]@{id=$candidate.HardwareModeId;name=$candidate.NameFromInstalledProfile;hasSpeed=$candidate.HasSpeedControl;hasColor=$candidate.HasColorControl;readOnly=$false}
            }
        }
        $modes += [ordered]@{id=0;name='关闭';hasSpeed=$false;hasColor=$false;readOnly=$false}
        $modes += [ordered]@{id=21;name='自定义模式（只读）';hasSpeed=$false;hasColor=$false;readOnly=$true}
        $active=$parsed.ModeTableCandidates | Where-Object {$_.HardwareModeId -eq $parsed.HardwareModeCandidate} | Select-Object -First 1
        $activeBrightness=$null
        $activeSpeed=$null
        $activeColor=$null
        if($null -ne $active) {
            $activeBrightness=$active.BrightnessCandidate
            $activeSpeed=$active.ReadableSpeed
            $activeColor=$active.ReadableColor
        }
        $warnings=@()
        $canRestore=$false
        $pending=Test-Path -LiteralPath $pendingPath
        if($pending){
            try { Read-Recovery $pendingPath | Out-Null; $canRestore=$true; $warnings+='上次写入未完成验证。新的修改已锁定；恢复会先还原上次操作前的配置。' }
            catch { $warnings+='待恢复记录校验失败；已保留原文件，禁止继续写入。' }
        } elseif(Test-Path -LiteralPath $ledger){
            try { Read-Recovery $ledger | Out-Null; $canRestore=$true }
            catch { $warnings+='首次快照校验失败；已保留原文件，禁止继续写入。' }
        }
        return [ordered]@{
            id=$deviceId;source='hardware';
            settings=[ordered]@{
                brightness=$activeBrightness;modeRaw=$parsed.HardwareModeCandidate;modeName=$parsed.ActiveModeName;
                activeMode=$parsed.HardwareModeCandidate;speed=$activeSpeed;colorIndex=$activeColor;
                sleepCode=$parsed.SleepCodeCandidate;sleepSeconds=$parsed.SleepSecondsFromInstalledProfile;
                debounce=$parsed.DebounceCodeCandidate;signatureValid=$true;supportedModes=$modes;
                sleepOptions=@(foreach($code in @(0,1,2,3,4,6,8,10,20,30,40)){@{code=$code;seconds=($code*30)}})
            };
            capabilities=[ordered]@{
                readable=@('modeRaw','modeName','brightness','speed','colorIndex','sleepCode','sleepSeconds','debounce');
                writable=@(if(-not$pending -and $warnings.Count-eq0){'activeMode';'sleepCode';'debounce';if($active){'brightness';if($active.HasSpeedControl){'speed'};if($active.HasColorControl){'colorIndex'}}})
            };
            canRestore=$canRestore;recoveryPending=$pending;restoreKind=$(if($pending){'pending-operation'}else{'first-snapshot'});warnings=$warnings;readAt=[datetime]::UtcNow.ToString('o')
        }
    }
    function Save-Baseline([byte[]]$bytes) {
        [PeripheralHub.AulaSettingsCodec]::Validate($bytes)
        if(Test-Path -LiteralPath $ledger){
            Read-Recovery $ledger | Out-Null
            return
        }
        $saved=[ordered]@{schema=3;vid='3554';pid='FA09';containerId=$containerId;psdHex=$aulaPsdHex;report=19;command=68;savedAt=[datetime]::UtcNow.ToString('o');payloadBase64=[Convert]::ToBase64String($bytes);sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))}
        $tmp=$ledger+'.tmp';[IO.File]::WriteAllText($tmp,($saved|ConvertTo-Json -Depth 5));[IO.File]::Move($tmp,$ledger,$false)
    }
    function Save-WriteSnapshot([byte[]]$bytes) {
        [PeripheralHub.AulaSettingsCodec]::Validate($bytes)
        $snapshots=Join-Path $stateDir 'aula-led-history'
        [IO.Directory]::CreateDirectory($snapshots)|Out-Null
        $path=Join-Path $snapshots (([datetime]::UtcNow.ToString('yyyyMMddTHHmmssfff'))+'-'+[guid]::NewGuid().ToString('N')+'.json')
        $record=[ordered]@{schema=3;vid='3554';pid='FA09';containerId=$containerId;psdHex=$aulaPsdHex;savedAt=[datetime]::UtcNow.ToString('o');setting=[string]$request.setting;payloadBase64=[Convert]::ToBase64String($bytes);sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))}
        [IO.File]::WriteAllText($path,($record|ConvertTo-Json -Depth 4))
    }
    $readiness=$null
    if($isAula -and [string]$request.action -in @('device-read','device-set','device-restore')) {
        try { $readiness=[PeripheralHub.HidConfigTransport]::AulaReadReadiness(1200) }
        catch {
            # A silent readiness query is inconclusive; retain the strict configuration read path.
            $cause=$_.Exception
            while($cause.InnerException){$cause=$cause.InnerException}
            if($cause -isnot [TimeoutException]){throw}
        }
        if($readiness -eq 0 -and [string]$request.action -ne 'device-read') {
            throw '接收器已回应，但键盘当前未就绪（状态0）。未发送设置写入；请检查键盘电源、2.4G连接或唤醒状态。'
        }
    }
    if($isAula -and ([string]$request.action -in @('device-set','device-restore'))) {
        $aulaPsdHex=Read-AulaPsdHex
    } elseif($isAula -and [string]$request.action -eq 'device-read' -and $readiness -ne 0) {
        try {$aulaPsdHex=Read-AulaPsdHex} catch {
            $cause=$_.Exception
            while($cause.InnerException){$cause=$cause.InnerException}
            if($cause.Message -notmatch 'timed out|timeout|超时'){throw}
            $aulaPsdHex=$null
        }
    }
    switch([string]$request.action) {
        'device-keyboard-identity' {
            if(-not$isAula){throw 'Keyboard identity operation requires AULA target.'}
            $identity=[PeripheralHub.AulaReadModels]::ParseIdentity10([PeripheralHub.HidConfigTransport]::AulaQuery(19,5,10,6000))
            $data=@{family='AULA G5KB';model=$(if($identity.MatchesExpectedPsd){'F87 PRO'}else{$null});firmware=$null;connection='wireless';receiverId=$containerId;identityVerified=$identity.MatchesExpectedPsd;psdHex=$identity.PsdHex;extraHex=$identity.ExtraHex}
        }
        'device-keyboard-snapshot' {
            if(-not$isAula){throw 'Keyboard snapshot operation requires AULA target.'}
            $snapshot=[PeripheralHub.HidConfigTransport]::AulaReadConfigurationSnapshotOnce(30000)
            $psdHex={param($identity) if($null -eq $identity){return $null};[byte[]]$rawIdentity=$identity;if($rawIdentity.Length -lt 6){return $null};return [Convert]::ToHexString([byte[]]$rawIdentity[0..5])}.GetNewClosure()
            $blockResult={param($raw,$complete,$marker) if($null -eq $raw){return @{actualLength=$null;blockComplete=$false;markerPresent=$null;rawContentBase64=$null}};$reportedMarker=if($raw.Length -eq 512){[bool]$marker}else{$null};return @{actualLength=$raw.Length;blockComplete=[bool]$complete;markerPresent=$reportedMarker;rawContentBase64=[Convert]::ToBase64String([byte[]]$raw)}}.GetNewClosure()
            $matrices=@(foreach($block in $snapshot.Matrices){
                $attempted=($null -ne $block.Raw) -or ($null -ne $snapshot.FailedCommand -and $snapshot.FailedCommand -eq 0x41 -and $null -ne $snapshot.FailedSelector -and $snapshot.FailedSelector -eq $block.Layer)
                $converted=& $blockResult $block.Raw $block.BlockComplete $block.MarkerPresent
                [ordered]@{layer=$block.Layer;attempted=$attempted;actualLength=$converted.actualLength;blockComplete=$converted.blockComplete;markerPresent=$converted.markerPresent;rawContentBase64=$converted.rawContentBase64}
            })
            $paletteAttempted=($null -ne $snapshot.Palette.Raw) -or ($null -ne $snapshot.FailedCommand -and $snapshot.FailedCommand -eq 0x49)
            $palette=& $blockResult $snapshot.Palette.Raw $snapshot.Palette.BlockComplete $snapshot.Palette.MarkerPresent
            $finalIdentityQueryExpected=($null -ne $snapshot.FailedCommand -and $snapshot.FailedCommand -eq 0x05 -and @($snapshot.Matrices|Where-Object {$null -ne $_.Raw}).Count -eq 4 -and $null -ne $snapshot.Palette.Raw)
            $identityAfterAttempted=($null -ne $snapshot.IdentityAfter) -or $finalIdentityQueryExpected
            $identityStable=if($null -ne $snapshot.IdentityBefore -and $null -ne $snapshot.IdentityAfter){[bool]$snapshot.IdentityStable}else{$null}
            $data=[ordered]@{
                containerId=$snapshot.ContainerId;instanceId=$snapshot.InstanceId
                identityBeforePsdHex=& $psdHex $snapshot.IdentityBefore
                identityAfterAttempted=$identityAfterAttempted
                identityAfterPsdHex=& $psdHex $snapshot.IdentityAfter
                identityStable=$identityStable;snapshotComplete=[bool]$snapshot.SnapshotComplete;writeBaselineEligible=$false
                matrices=$matrices
                palette=[ordered]@{attempted=$paletteAttempted;actualLength=$palette.actualLength;blockComplete=$palette.blockComplete;markerPresent=$palette.markerPresent;rawContentBase64=$palette.rawContentBase64}
                failedCommand=$(if($null -ne $snapshot.FailedCommand){[int]$snapshot.FailedCommand}else{$null})
                failedSelector=$(if($null -ne $snapshot.FailedSelector){[int]$snapshot.FailedSelector}else{$null})
                failureMessage=$(if($null -ne $snapshot.FailureMessage){([string]$snapshot.FailureMessage).Substring(0,[Math]::Min(2048,([string]$snapshot.FailureMessage).Length))}else{$null});readAt=[datetime]::UtcNow.ToString('o')
            }
        }
        'device-keyboard-matrix' {
            if(-not$isAula-or$request.layer -isnot [long]-and$request.layer -isnot [int]-or$request.layer-lt0-or$request.layer-gt3){throw 'Invalid keyboard matrix layer.'}
            $aulaPsdHex=Read-AulaPsdHex -SingleAttempt
            [byte[]]$raw=[PeripheralHub.HidConfigTransport]::AulaQuerySelectorOnce(19,65,512,[byte]$request.layer,6000)
            $records=@();$markerPresent=$false
            if($raw.Length-eq512){
                $matrix=[PeripheralHub.AulaConfigurationCodec]::ParseMatrix512($raw,[int]$request.layer,$false)
                $markerPresent=$matrix.HasCrcMarker
                $records=@($matrix.Entries|ForEach-Object {
                    $kind=if($_.Kind-in@('keyboard','consumer','empty-or-disabled')){$_.Kind}else{'unknown'}
                    @{index=$_.Index;rawHex=[Convert]::ToHexString($_.Raw);kind=$kind;modifiers=$_.Modifiers;primaryUsage=$_.PrimaryHidUsage;secondaryUsage=$_.SecondaryHidUsage;consumerUsage=$_.ConsumerUsage}
                })
            } else {
                $matrix=[PeripheralHub.AulaReadModels]::ParseMatrix504($raw,[int]$request.layer)
                $records=@($matrix.Entries|ForEach-Object {@{index=$_.Index;rawHex=$_.RawHex;kind=$_.Kind;modifiers=$_.Modifiers;primaryUsage=$_.PrimaryHidUsage;secondaryUsage=$_.SecondaryHidUsage;consumerUsage=$_.ConsumerUsage}})
            }
            $data=@{layer=[int]$request.layer;matrixComplete=$false;blockComplete=($raw.Length-eq512);actualLength=$raw.Length;markerPresent=$markerPresent;rawContentBase64=[Convert]::ToBase64String($raw);writeBaselineEligible=$false;identityVerified=$true;psdHex=$aulaPsdHex;containerId=$containerId;records=$records}
        }
        'device-keyboard-palette' {
            if(-not$isAula-or$request.modeId -isnot [long]-and$request.modeId -isnot [int]-or$request.modeId -notin @(1,2,4,5,7,8,10,11,12,13)){throw 'Invalid or non-palette AULA keyboard mode.'}
            $aulaPsdHex=Read-AulaPsdHex -SingleAttempt
            [byte[]]$raw=[PeripheralHub.HidConfigTransport]::AulaQuerySelectorOnce(19,73,512,0,6000)
            if($raw.Length-eq512){
                $markerPresent=($raw[506]-eq0x5A-and$raw[507]-eq0xA5)
                if($markerPresent){$palette=[PeripheralHub.AulaConfigurationCodec]::ParsePalette512($raw);$colors=$palette.Groups[[int]$request.modeId-1].Colors}
                else{$palette=[PeripheralHub.AulaReadModels]::ParsePalette490([byte[]]$raw[0..489],[int]$request.modeId);$colors=$palette.Colors}
            } else {
                $palette=[PeripheralHub.AulaReadModels]::ParsePalette490($raw,[int]$request.modeId)
                $colors=$palette.Colors
                $markerPresent=$false
            }
            $data=@{modeId=[int]$request.modeId;blockComplete=($raw.Length-eq512);actualLength=$raw.Length;markerPresent=$markerPresent;writeBaselineEligible=$false;identityVerified=$true;psdHex=$aulaPsdHex;containerId=$containerId;rawContentBase64=[Convert]::ToBase64String($raw);colors=@($colors|ForEach-Object {@{r=$_.R;g=$_.G;b=$_.B}})}
        }
        'device-read' {
            if($isAula -and $readiness -eq 0){
                $data=[ordered]@{id=$deviceId;source='hardware-status';connection=[ordered]@{receiverResponded=$true;keyboardReady=$false;rawState=0};settings=@{};capabilities=@{readable=@('connection');writable=@()};canRestore=$false;warnings=@('接收器已回应，但键盘当前未就绪。状态0不能区分休眠、关机或无线断开；没有读取到当前配置。');readAt=[datetime]::UtcNow.ToString('o')}
            }
            elseif($isAula){
                try {$data=Convert-Aula (Read-Aula)}
                catch {
                    $cause=$_.Exception
                    while($cause.InnerException){$cause=$cause.InnerException}
                    if($cause.Message -notmatch 'timed out|timeout|超时'){throw}
                    $recoveryAvailable=$false
                    foreach($candidate in @($pendingPath,$ledger)){
                        if(Test-Path -LiteralPath $candidate){try{$candidateRecord=Get-Content -LiteralPath $candidate -Raw|ConvertFrom-Json;if($candidateRecord.schema -eq 3 -and $candidateRecord.psdHex -eq '03000000010B' -and $candidateRecord.containerId -eq $containerId){$recoveryAvailable=$true;break}}catch{}}
                    }
                    $data=[ordered]@{id=$deviceId;source='hardware-status';connection=[ordered]@{receiverResponded=$true;keyboardReady=$false;rawState=$null};settings=@{};capabilities=@{readable=@('connection');writable=@()};canRestore=$recoveryAvailable;recoveryPending=Test-Path -LiteralPath $pendingPath;restoreKind='first-snapshot';warnings=@('AULA当前配置查询超时；键盘可能正在休眠或无线未就绪。未伪造配置值，唤醒后请重新读取。');readAt=[datetime]::UtcNow.ToString('o')}
                }
            }
            else {
                [byte]$seq=Get-Random -Minimum 1 -Maximum 255
                $query=[PeripheralHub.Analysis.In9FeatureProtocol]::BuildInfoQuery($seq)
                $reply=[PeripheralHub.HidConfigTransport]::In9Exchange($query,$true)
                $info=[PeripheralHub.Analysis.In9FeatureProtocol]::ParseInfo($reply,$seq)
                $data=[ordered]@{id=$deviceId;source='hardware-info';info=[ordered]@{batteryPercent=$info.OfficialDisplayBatteryPercent;sensorName=$info.SensorName;family=$info.Family;charging=$info.IsCharging;activityFlagRaw=$info.ActivityFlagRaw};settings=@{};warnings=@();readAt=[datetime]::UtcNow.ToString('o')}
            }
        }
        'device-set' {
            $setting=[string]$request.setting
            if(-not $isAula -or $setting -notin @('activeMode','brightness','speed','colorIndex','sleepCode','debounce')){throw 'This setting is outside the verified keyboard controls.'}
            $value=$request.value
            if($null -eq $value -or $value -is [string] -or $value -is [bool] -or [double]$value -ne [math]::Truncate([double]$value) -or [double]$value -lt 0 -or [double]$value -gt 255){throw 'Keyboard value must be an integer within the confirmed field range.'}
            [byte[]]$before=Read-Aula
            [PeripheralHub.AulaSettingsCodec]::Validate($before)
            $current=Convert-Aula $before
            if($setting -notin $current.capabilities.writable){throw 'The current keyboard state does not permit this setting; refresh or recover pending changes.'}
            $updated=[PeripheralHub.AulaSettingsCodec]::PatchSetting($before,$setting,[int]$value)
            if([Convert]::ToHexString($before)-ceq[Convert]::ToHexString($updated)){$data=$current;$data.verification='unchanged-hardware-read';break}
            Save-Baseline $before
            Save-WriteSnapshot $before
            Begin-Transaction $before
            try {$readback=[PeripheralHub.HidConfigTransport]::AulaWriteReadLed($updated)}
            catch {
                $originalError=$_.Exception.Message
                try { [PeripheralHub.HidConfigTransport]::AulaWriteReadLed($before)|Out-Null;Complete-Transaction }
                catch {throw ('Apply failed and recovery needs retry. Pending snapshot preserved. '+$originalError+' Recovery: '+$_.Exception.Message)}
                throw ('Apply failed; immediately previous settings restored and verified. '+$originalError)
            }
            Complete-Transaction
            $data=Convert-Aula $readback;$data.verification='hardware-readback-128-bytes'
        }
        'device-restore' {
            if(-not $isAula){throw 'No native recovery entry for this device.'}
            $recoverPending=Test-Path -LiteralPath $pendingPath
            $restorePath=if($recoverPending){$pendingPath}else{$ledger}
            if(-not(Test-Path -LiteralPath $restorePath)){throw 'No saved keyboard snapshot is present.'}
            [byte[]]$baseline=Read-Recovery $restorePath
            $directBaselineRestore=$false
            if(-not$recoverPending){
                try {
                    [byte[]]$before=Read-Aula
                    Save-WriteSnapshot $before
                    Begin-Transaction $before
                } catch {
                    $cause=$_.Exception
                    while($cause.InnerException){$cause=$cause.InnerException}
                    if($cause.Message -notmatch 'timed out|timeout|超时'){throw}
                    $directBaselineRestore=$true
                }
            }
            [byte[]]$readback=[PeripheralHub.HidConfigTransport]::AulaWriteReadLed($baseline)
            Complete-Transaction
            $data=Convert-Aula $readback;$data.verification=$(if($directBaselineRestore){'restored-hardware-readback-128-bytes-direct-baseline'}else{'restored-hardware-readback-128-bytes'})
            $data.restoredFrom=$(if($recoverPending){'pending-operation'}else{'first-snapshot'});if($directBaselineRestore){$data.warnings+=@('恢复前LED128查询超时；已使用当前PSD/ContainerId绑定的schema3基线直接恢复。')}
        }
        default { throw 'Unknown device service action.' }
    }
    $response=@{ok=$true;data=$data}
} catch {$response=@{ok=$false;error=$_.Exception.Message};$exitCode=1}
finally {if($operationGate){if($gateOwned){$operationGate.ReleaseMutex()};$operationGate.Dispose()}}
[IO.File]::WriteAllText($ResponsePath,($response|ConvertTo-Json -Depth 12 -Compress))
exit $exitCode
