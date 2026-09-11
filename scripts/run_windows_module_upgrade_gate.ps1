param(
  [Parameter(Mandatory = $true)][string]$TargetVersion,
  [Parameter(Mandatory = $true)][string]$BaselineUrl,
  [Parameter(Mandatory = $true)][string]$BaselineSha256,
  [Parameter(Mandatory = $true)][string]$UpgradeUrl,
  [Parameter(Mandatory = $true)][string]$UpgradeTicketUrl,
  [Parameter(Mandatory = $true)][string]$UpgradeSha256,
  [Parameter(Mandatory = $true)][string]$OutputRoot
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$EvidenceRoot = Join-Path $OutputRoot "evidence"
$DownloadRoot = Join-Path $OutputRoot "downloads"
$ExtractRoot = Join-Path $OutputRoot "packages"
New-Item -ItemType Directory -Force -Path $EvidenceRoot, $DownloadRoot, $ExtractRoot | Out-Null

function Assert-Sha256 {
  param([string]$Path, [string]$Expected)
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) { throw "Package SHA-256 mismatch." }
}

function Download-Verified {
  param([string]$Url, [string]$Destination, [string]$Expected)
  $lastError = $null
  foreach ($attempt in 1..3) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination -TimeoutSec 180
      Assert-Sha256 -Path $Destination -Expected $Expected
      return
    } catch {
      $lastError = $_
      if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
      if ($attempt -lt 3) { Start-Sleep -Seconds (3 * $attempt) }
    }
  }
  throw "Package download or verification failed: $($lastError.Exception.Message)"
}

function Expand-OneRoot {
  param([string]$Archive, [string]$Destination)
  Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force
  $roots = @(Get-ChildItem -LiteralPath $Destination -Directory)
  if ($roots.Count -ne 1) { throw "Package must contain exactly one root directory." }
  return $roots[0].FullName
}

function Stop-GateProcesses {
  foreach ($line in @(& netstat.exe -ano -p tcp)) {
    if ($line -match '^\s*TCP\s+\S+:(3000|4318)\s+\S+\s+LISTENING\s+(\d+)\s*$') {
      $processId = [int]$Matches[2]
      if ($processId -ne $PID) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }
    }
  }
  Start-Sleep -Seconds 2
}

try {
  $baselineZip = Join-Path $DownloadRoot "windows-baseline.zip"
  $upgradeZip = Join-Path $DownloadRoot "windows-module-upgrade.zip"
  Download-Verified -Url $BaselineUrl -Destination $baselineZip -Expected $BaselineSha256
  Download-Verified -Url $UpgradeUrl -Destination $upgradeZip -Expected $UpgradeSha256
  $baselineRoot = Expand-OneRoot -Archive $baselineZip -Destination (Join-Path $ExtractRoot "baseline")
  $upgradeRoot = Expand-OneRoot -Archive $upgradeZip -Destination (Join-Path $ExtractRoot "upgrade")

  $workspace = Join-Path $OutputRoot "historical-upgrade\AIContentWorkbench"
  $skills = Join-Path $OutputRoot "historical-upgrade\skills"
  $installer = Join-Path $baselineRoot "系统文件_无需打开\installer\Install_AI_Content_Workbench.ps1"
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "Baseline installer is missing." }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -WorkspaceRoot $workspace -CodexSkillsHome $skills *>&1 |
    Tee-Object -FilePath (Join-Path $EvidenceRoot "baseline-install.log")
  if ($LASTEXITCODE -ne 0) { throw "Baseline installer failed with code $LASTEXITCODE." }
  Stop-GateProcesses

  $sentinels = @{
    project = Join-Path $workspace "02_项目工作区\珠宝历史项目\keep.txt"
    material = Join-Path $workspace "01_素材入口\珠宝历史素材.txt"
    output = Join-Path $workspace "03_最终成果\珠宝历史成果.txt"
    config = Join-Path $workspace "系统文件_无需打开\config\customer-preservation-sentinel.txt"
  }
  $before = @{}
  foreach ($entry in $sentinels.GetEnumerator()) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $entry.Value) | Out-Null
    Set-Content -LiteralPath $entry.Value -Value "preserve-$($entry.Key)" -Encoding UTF8
    $before[$entry.Key] = (Get-FileHash -LiteralPath $entry.Value -Algorithm SHA256).Hash
  }

  $env:AICW_DEPLOYER_STATE_ROOT = Join-Path $OutputRoot "deployer-state"
  & python.exe .\scripts\deploy.py apply --ticket $UpgradeTicketUrl --workbench $workspace --skills-home $skills --confirm-write YES *>&1 |
    Tee-Object -FilePath (Join-Path $EvidenceRoot "module-upgrade.log")
  if ($LASTEXITCODE -ne 0) {
    if (Test-Path -LiteralPath $env:AICW_DEPLOYER_STATE_ROOT -PathType Container) {
      Copy-Item -LiteralPath $env:AICW_DEPLOYER_STATE_ROOT -Destination (Join-Path $EvidenceRoot "deployer-state") -Recurse -Force
    }
    throw "Module deployment failed with code $LASTEXITCODE."
  }

  foreach ($entry in $sentinels.GetEnumerator()) {
    if (-not (Test-Path -LiteralPath $entry.Value -PathType Leaf)) { throw "Historical $($entry.Key) sentinel was removed." }
    $after = (Get-FileHash -LiteralPath $entry.Value -Algorithm SHA256).Hash
    if ($after -ne $before[$entry.Key]) { throw "Historical $($entry.Key) sentinel changed." }
  }
  $moduleReceipt = Join-Path $workspace "系统文件_无需打开\config\modules\xhs-jewelry-lightweight-upgrade.json"
  if (-not (Test-Path -LiteralPath $moduleReceipt -PathType Leaf)) { throw "Module receipt is missing." }
  $installed = Get-Content -LiteralPath $moduleReceipt -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$installed.module_id -ne "xhs-jewelry-lightweight-upgrade" -or
      [string]$installed.version -ne $TargetVersion -or
      [string]$installed.post_install_tree_verification -ne "passed") {
    throw "Module receipt identity is invalid."
  }
  $deploymentReceipts = @(Get-ChildItem -LiteralPath (Join-Path $workspace "系统文件_无需打开\deployment_receipts") -Filter "*.json" -File)
  $latest = Get-Content -LiteralPath ($deploymentReceipts | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$latest.status -ne "installed_and_verified" -or [string]$latest.version -ne $TargetVersion) {
    throw "Formal deployment receipt identity is invalid."
  }
  $backupCount = @(Get-ChildItem -LiteralPath (Join-Path $workspace "系统文件_无需打开\backups\module_upgrades") -Directory).Count

  & python.exe .\scripts\deploy.py apply --ticket $UpgradeTicketUrl --workbench $workspace --skills-home $skills --confirm-write YES *>&1 |
    Tee-Object -FilePath (Join-Path $EvidenceRoot "module-repeat.log")
  if ($LASTEXITCODE -ne 0) { throw "Repeated deployment failed with code $LASTEXITCODE." }
  $backupCountAfter = @(Get-ChildItem -LiteralPath (Join-Path $workspace "系统文件_无需打开\backups\module_upgrades") -Directory).Count
  if ($backupCountAfter -ne $backupCount) { throw "Repeated execution created another module backup." }

  $webEntry = Join-Path $workspace "系统文件_无需打开\tools\web-workbench\dist\server\index.js"
  $skillEntry = Join-Path $skills "xhs-jewelry-visual-remix\SKILL.md"
  $tutorial = Join-Path $workspace "04_使用教程\23E_珠宝种草轻量更新.html"
  foreach ($path in @($webEntry, $skillEntry, $tutorial)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Installed component is missing: $path" }
  }

  $report = [ordered]@{
    schema_version = 1
    product_id = "ai-content-workbench"
    module_id = "xhs-jewelry-lightweight-upgrade"
    version = $TargetVersion
    platform = "windows"
    status = "pass"
    executed_on_windows = $true
    checks = [ordered]@{
      historical_upgrade = "installed_and_verified"
      repeat_execution = "no_reinstall"
      existing_projects_materials_outputs_config = "preserved"
      formal_deployment_receipt = "passed"
      prebuilt_web_runtime = "passed"
      jewelry_skill_and_tutorial = "passed"
    }
    package_sha256 = @($UpgradeSha256.ToLowerInvariant())
  }
  $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputRoot "windows-module-upgrade-gate.json") -Encoding UTF8
  Write-Host "Windows module upgrade gate passed."
} catch {
  Stop-GateProcesses
  $_ | Out-String | Set-Content -LiteralPath (Join-Path $EvidenceRoot "gate-failure.txt") -Encoding UTF8
  throw
}
