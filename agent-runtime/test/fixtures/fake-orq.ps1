param([string]$Command,[Parameter(ValueFromRemainingArguments=$true)][string[]]$Rest)
# orq falso para las pruebas del puente: imita ticket start / implement / review y deja ticket.json con métricas.
$o=@{}
for($i=0;$i -lt $Rest.Count;$i++){
  if($Rest[$i] -like '--*'){
    $n=$Rest[$i].Substring(2)
    if($i+1 -lt $Rest.Count -and -not ($Rest[$i+1] -like '--*')){$o[$n]=$Rest[$i+1];$i++}else{$o[$n]=$true}
  }
}
if($Command -eq 'ticket'){$Command='start'}
$id=$o['ticket']; if(-not $id){$id=$o['id']}
$dir=Join-Path $o['repo'] ".orq/tickets/$id"
New-Item -ItemType Directory -Force $dir | Out-Null
$cfg=Get-Content (Join-Path $o['repo'] '.orq/config.json') -Raw | ConvertFrom-Json
$fail=($env:FAKE_ORQ_FAIL_FIRST -eq '1') -and ($id -like '*-a1')
switch($Command){
  'start' {
    $state='PREFLIGHT_OK'; if($o.ContainsKey('review-only')){$state='CHECKPOINTED'}
    @{id=$id;state=$state;metrics=@{phases=@()}} | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $dir 'ticket.json')
    @{exitCode=0;state=$state;message="ok $($cfg.mode)";ticketId=$id} | ConvertTo-Json
    exit 0
  }
  'implement' {
    if($fail){$st='PARTIAL_RECOVERABLE';$ok=$false}else{Add-Content (Join-Path $o['repo'] 'app/caida.py') '# revisado';$st='CHECKPOINTED';$ok=$true}
    $m=@($cfg.allowedModels.claude)[0]
    @{id=$id;state=$st;implementer='claude';metrics=@{phases=@(@{phase='implement';provider='claude';model=$m;tokens=1200;outputTokens=300;durationMs=4000;success=$ok})}} | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $dir 'ticket.json')
    @{exitCode=$(if($ok){0}else{3});state=$st;message="impl $m"} | ConvertTo-Json
    exit 0
  }
  'review' {
    New-Item -ItemType Directory -Force (Join-Path $dir 'reviews') | Out-Null
    @{reviewQuality='degraded';findings=@(@{severity='P2';file='app/caida.py';line=2;finding='Umbral fijo'})} | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $dir 'reviews/consolidation.json')
    Set-Content (Join-Path $dir 'summary.md') '# Informe'
    @{id=$id;state='READY_FOR_HUMAN';implementer='external';metrics=@{phases=@(@{phase='review';providers=@('codex');tokens=900;durationMs=3000})}} | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $dir 'ticket.json')
    @{exitCode=0;state='READY_FOR_HUMAN';message="review $($cfg.mode) $($cfg.providers.codex.reasoningEffort)"} | ConvertTo-Json
    exit 0
  }
}
