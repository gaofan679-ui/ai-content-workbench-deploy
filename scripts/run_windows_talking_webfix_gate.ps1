param(
  [Parameter(Mandatory = $true)][string]$CandidateId,
  [Parameter(Mandatory = $true)][string]$BaselineUrl,
  [Parameter(Mandatory = $true)][string]$BaselineSha256,
  [Parameter(Mandatory = $true)][string]$JewelryUpgradeUrl,
  [Parameter(Mandatory = $true)][string]$JewelryUpgradeSha256,
  [Parameter(Mandatory = $true)][string]$OutputRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'Disposable GitHub Windows runner only.' }
if (-not [string]::IsNullOrWhiteSpace($env:RUNNINGHUB_API_KEY)) { throw 'Provider credentials are forbidden in this gate.' }
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Harness = Join-Path $PSScriptRoot '..\test-harness\talking-webfix'
$EvidenceRoot = Join-Path $OutputRoot 'evidence'
$DownloadRoot = Join-Path $OutputRoot 'downloads'
$PackageRoot = Join-Path $OutputRoot 'packages'
New-Item -ItemType Directory -Force -Path $EvidenceRoot, $DownloadRoot, $PackageRoot | Out-Null
$env:NODE_OPTIONS = '--import=' + ([Uri](Join-Path $Harness 'tests\no-external-network.mjs')).AbsoluteUri
$env:WORKBENCH_SKIP_STARTUP_RECOVERY = '1'
$env:WORKBENCH_CODEX_TASK_BRIDGE = 'disabled'
$env:WORKBENCH_CODEX_DESKTOP_NAVIGATION = 'disabled'
$env:WORKBENCH_VIDEO_MODELS_JSON = '{"models":[{"model_key":"test-only","model_name":"TEST ONLY","duration_min":4,"duration_max":15,"resolutions":["720p"],"ratios":["9:16"],"image_max":9,"video_max":3,"audio_max":3}]}'
$script:ScenarioResults = @()

function Assert-Sha256([string]$Path, [string]$Expected) {
  if ($Expected -notmatch '^[a-fA-F0-9]{64}$') { throw 'Expected SHA-256 is invalid.' }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) { throw "SHA-256 mismatch: $Path" }
}

function Download-Verified([string]$Url, [string]$Destination, [string]$Expected) {
  $last = $null
  foreach ($attempt in 1..3) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination -TimeoutSec 180
      Assert-Sha256 $Destination $Expected
      return
    } catch {
      $last = $_
      if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
      if ($attempt -lt 3) { Start-Sleep -Seconds (3 * $attempt) }
    }
  }
  throw "Download failed after bounded retries: $($last.Exception.Message)"
}

function Expand-OneRoot([string]$Archive, [string]$Destination) {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force
  $roots = @(Get-ChildItem -LiteralPath $Destination -Directory)
  if ($roots.Count -ne 1) { throw 'Package must contain exactly one root directory.' }
  return $roots[0].FullName
}

function Expand-CandidatePayload() {
  $manifestPath = Join-Path $Harness 'overlay-manifest.json'
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $archive = Join-Path $Harness ([string]$manifest.payload_archive.archive)
  Assert-Sha256 $archive ([string]$manifest.payload_archive.sha256)
  $destination = Join-Path $OutputRoot 'candidate-payload'
  New-Item -ItemType Directory -Path $destination | Out-Null
  & tar.exe -xzf $archive -C $destination
  if ($LASTEXITCODE -ne 0) { throw 'Candidate payload archive extraction failed.' }
  $payload = Join-Path $destination 'payload'
  if (-not (Test-Path -LiteralPath $payload -PathType Container)) { throw 'Candidate payload root is missing.' }
  $files = @(Get-ChildItem -LiteralPath $payload -Recurse -File)
  if ($files.Count -ne [int]$manifest.payload_archive.file_count) { throw 'Candidate payload file count mismatch.' }
  return $payload
}

function Stop-ManagedServices([string]$Workspace) {
  $web = Join-Path $Workspace '系统文件_无需打开\tools\web-workbench'
  $stop = Join-Path $web 'service\windows\stop-services.ps1'
  if (Test-Path -LiteralPath $stop) { & $stop -WebRoot $web }
}

function Install-Baseline([string]$Package, [string]$Workspace, [string]$Skills, [string]$Label) {
  $installer = Join-Path $Package '系统文件_无需打开\installer\Install_AI_Content_Workbench.ps1'
  if (-not (Test-Path -LiteralPath $installer)) { throw 'Baseline installer is missing.' }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -WorkspaceRoot $Workspace -CodexSkillsHome $Skills *>&1 |
    Tee-Object -FilePath (Join-Path $EvidenceRoot "$Label-baseline-install.log") | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "$Label baseline installer failed." }
  Stop-ManagedServices $Workspace
}

function Apply-Jewelry([string]$Package, [string]$Workspace, [string]$Skills, [string]$Label) {
  $script = Join-Path $Package '系统文件_无需打开\scripts\jewelry_upgrade.py'
  & python.exe $script --apply --workbench $Workspace --skills-home $Skills --confirm-write YES --skip-service-restart *>&1 |
    Tee-Object -FilePath (Join-Path $EvidenceRoot "$Label-jewelry-upgrade.log") | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "$Label jewelry module upgrade failed." }
}

function New-PreservationSentinels([string]$Workspace, [string]$Label) {
  $paths = @{
    project = Join-Path $Workspace "02_项目工作区\$Label\keep.txt"
    output = Join-Path $Workspace "03_最终成果\$Label.txt"
    config = Join-Path $Workspace '系统文件_无需打开\config\talking-webfix-preserve.txt'
  }
  $hashes = @{}
  foreach ($entry in $paths.GetEnumerator()) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $entry.Value) | Out-Null
    Set-Content -LiteralPath $entry.Value -Value "preserve-$($entry.Key)-$Label" -Encoding UTF8
    $hashes[$entry.Key] = (Get-FileHash -LiteralPath $entry.Value -Algorithm SHA256).Hash
  }
  return @{ paths = $paths; hashes = $hashes }
}

function Assert-Preservation($Sentinels) {
  foreach ($entry in $Sentinels.paths.GetEnumerator()) {
    if (-not (Test-Path -LiteralPath $entry.Value)) { throw "Preservation sentinel missing: $($entry.Key)" }
    $after = (Get-FileHash -LiteralPath $entry.Value -Algorithm SHA256).Hash
    if ($after -ne $Sentinels.hashes[$entry.Key]) { throw "Preservation sentinel changed: $($entry.Key)" }
  }
}

function Run-Browser([string]$Workspace, [string]$Skills, [string]$Label) {
  $scenarioEvidence = Join-Path $EvidenceRoot $Label
  & (Join-Path $Harness 'run-browser-after-install.ps1') -Workspace $Workspace -SkillsHome $Skills `
    -Evidence $scenarioEvidence -HarnessRoot $Harness -TestDependencies $env:AICW_TEST_DEPENDENCIES_FOLDER
}

function Run-Scenario([string]$Label, [string]$BaselinePackage, [string]$JewelryPackage, [bool]$WithJewelry, [bool]$Interrupted, [bool]$Repeat) {
  $workspace = Join-Path $OutputRoot "$Label\custom-location\AIContentWorkbench"
  $skills = Join-Path $OutputRoot "$Label\codex-skills"
  Install-Baseline $BaselinePackage $workspace $skills $Label
  if ($WithJewelry) { Apply-Jewelry $JewelryPackage $workspace $skills $Label }
  $sentinels = New-PreservationSentinels $workspace $Label
  if ($Interrupted) {
    $partialTarget = Join-Path $workspace '系统文件_无需打开\tools\scripts\workbench-artifacts\skill_artifact_adapter.py'
    Copy-Item -LiteralPath (Join-Path $script:PayloadRoot 'scripts\workbench-artifacts\skill_artifact_adapter.py') -Destination $partialTarget -Force
    Set-Content -LiteralPath (Join-Path $workspace '系统文件_无需打开\talking-webfix.partial') -Value 'simulated interruption' -Encoding UTF8
  }
  & (Join-Path $Harness 'apply-test-overlay.ps1') -Workspace $workspace -Evidence (Join-Path $EvidenceRoot "$Label-overlay") -PayloadRoot $script:PayloadRoot
  Assert-Preservation $sentinels
  Run-Browser $workspace $skills $Label
  if ($Repeat) {
    Stop-ManagedServices $workspace
    & (Join-Path $Harness 'apply-test-overlay.ps1') -Workspace $workspace -Evidence (Join-Path $EvidenceRoot "$Label-overlay-repeat") -PayloadRoot $script:PayloadRoot
    Assert-Preservation $sentinels
    Run-Browser $workspace $skills "$Label-repeat"
  }
  Stop-ManagedServices $workspace
  $script:ScenarioResults += @{ label = $Label; jewelry_already_installed = $WithJewelry; interrupted_resume = $Interrupted; repeat_execution = $Repeat; status = 'pass' }
}

try {
  $baselineZip = Join-Path $DownloadRoot 'v183-rc3-windows-first-install.zip'
  $jewelryZip = Join-Path $DownloadRoot 'jewelry-v050-windows-upgrade.zip'
  Download-Verified $BaselineUrl $baselineZip $BaselineSha256
  Download-Verified $JewelryUpgradeUrl $jewelryZip $JewelryUpgradeSha256
  $baselinePackage = Expand-OneRoot $baselineZip (Join-Path $PackageRoot 'baseline')
  $jewelryPackage = Expand-OneRoot $jewelryZip (Join-Path $PackageRoot 'jewelry')
  $script:PayloadRoot = Expand-CandidatePayload
  Run-Scenario 'rc3-direct' $baselinePackage $jewelryPackage $false $false $false
  Run-Scenario 'rc3-plus-jewelry' $baselinePackage $jewelryPackage $true $false $true
  Run-Scenario 'rc3-interrupted-resume' $baselinePackage $jewelryPackage $false $true $false
  $report = [ordered]@{
    schema_version = 1
    candidate_id = $CandidateId
    platform = 'windows'
    status = 'pass'
    executed_on_windows = $true
    provider_credentials = 'not_supplied'
    external_generation = 'not_executed'
    scenarios = $script:ScenarioResults
  }
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputRoot 'windows-talking-webfix-gate.json') -Encoding UTF8
} catch {
  $_ | Out-String | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'gate-failure.txt') -Encoding UTF8
  throw
}
