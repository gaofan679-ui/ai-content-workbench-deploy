param(
  [Parameter(Mandatory = $true)][string]$TargetVersion,
  [Parameter(Mandatory = $true)][string]$FirstInstallUrl,
  [Parameter(Mandatory = $true)][string]$FirstInstallTicketUrl,
  [Parameter(Mandatory = $true)][string]$FirstInstallSha256,
  [Parameter(Mandatory = $true)][string]$UpgradeUrl,
  [Parameter(Mandatory = $true)][string]$UpgradeTicketUrl,
  [Parameter(Mandatory = $true)][string]$RecoveryTicketUrl,
  [Parameter(Mandatory = $true)][string]$UpgradeSha256,
  [Parameter(Mandatory = $true)][string]$BaselineUrl,
  [Parameter(Mandatory = $true)][string]$BaselineSha256,
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
  if ($Expected -notmatch '^[a-f0-9]{64}$') {
    throw "Expected SHA-256 is invalid."
  }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) {
    throw "Package SHA-256 mismatch."
  }
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
      if (Test-Path -LiteralPath $Destination) {
        Remove-Item -LiteralPath $Destination -Force
      }
      if ($attempt -lt 3) { Start-Sleep -Seconds (3 * $attempt) }
    }
  }
  throw "Package download or verification failed after bounded retries: $($lastError.Exception.Message)"
}

function Expand-VerifiedPackage {
  param([string]$Archive, [string]$Destination)
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force
  $roots = @(Get-ChildItem -LiteralPath $Destination -Directory)
  if ($roots.Count -ne 1) {
    throw "Package must contain exactly one root directory."
  }
  $payload = Join-Path $roots[0].FullName "系统文件_无需打开"
  if (-not (Test-Path -LiteralPath $payload -PathType Container)) {
    throw "Package payload directory is missing."
  }
  return $roots[0].FullName
}

function Stop-GateProcesses {
  $listenerIds = @()
  foreach ($line in @(& netstat.exe -ano -p tcp)) {
    if ($line -match '^\s*TCP\s+\S+:(3000|4318)\s+\S+\s+LISTENING\s+(\d+)\s*$') {
      $listenerIds += [int]$Matches[2]
    }
  }
  foreach ($processId in @($listenerIds | Sort-Object -Unique)) {
    if ($processId -ne $PID) {
      Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Seconds 2
}

function Wait-Workbench {
  param([int]$Seconds = 90)
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:3000" -TimeoutSec 5
      if ($response.StatusCode -eq 200) { return }
    } catch {}
    Start-Sleep -Milliseconds 800
  } while ((Get-Date) -lt $deadline)
  throw "Installed web workbench did not answer on the local port."
}

function Assert-InstalledWorkbench {
  param([string]$Workspace, [string]$SkillsHome, [string]$Label)
  $required = @(
    (Join-Path $Workspace "AGENTS.md"),
    (Join-Path $Workspace "00_使用入口.html"),
    (Join-Path $Workspace "01_打开AI内容工作台.bat"),
    (Join-Path $Workspace "02_配置工作台.bat"),
    (Join-Path $Workspace "03_完成全部配置.bat"),
    (Join-Path $Workspace "系统文件_无需打开\config\customer_config.env"),
    (Join-Path $Workspace "系统文件_无需打开\tools\web-workbench\dist\server\index.js"),
    (Join-Path $Workspace "04_使用教程\04_打开使用教程.html")
  )
  foreach ($path in $required) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "$Label required installed file is missing: $path"
    }
  }
  $skillCount = @(Get-ChildItem -LiteralPath $SkillsHome -Directory | Where-Object {
    Test-Path -LiteralPath (Join-Path $_.FullName "SKILL.md") -PathType Leaf
  }).Count
  if ($skillCount -ne 38) {
    throw "$Label installed Skill count is $skillCount, expected 38."
  }
  $jewelrySkill = Join-Path $SkillsHome "xhs-jewelry-visual-remix\SKILL.md"
  $tutorial = Join-Path $Workspace "04_使用教程\docs\00_START_HERE.html"
  if (-not (Test-Path -LiteralPath $jewelrySkill -PathType Leaf) -or
      -not (Test-Path -LiteralPath $tutorial -PathType Leaf)) {
    throw "$Label is missing the jewelry workflow or current tutorial entry."
  }
  $summaries = @(Get-ChildItem -LiteralPath (Join-Path $Workspace "系统文件_无需打开\logs") -Filter "install_summary_*.txt" -File)
  if ($summaries.Count -lt 1) {
    throw "$Label installation summary is missing."
  }

  $receipts = @(Get-ChildItem -LiteralPath (Join-Path $Workspace "系统文件_无需打开\deployment_receipts") -Filter "*.json" -File)
  if ($receipts.Count -lt 1) {
    throw "$Label installed_and_verified receipt is missing."
  }
  $latestReceipt = Get-Content -LiteralPath ($receipts | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$latestReceipt.status -ne "installed_and_verified" -or [string]$latestReceipt.version -ne $TargetVersion) {
    throw "$Label installed receipt identity is invalid."
  }
  Wait-Workbench

  $setupRoot = Join-Path $Workspace "系统文件_无需打开\tools\scripts\workbench-setup"
  $setupStatus = Join-Path $setupRoot "setup_status.py"
  $setupRegistry = Join-Path $setupRoot "customer_setup_registry.json"
  $readinessOutput = Join-Path $EvidenceRoot ("module-readiness-" + ($Label -replace '[^A-Za-z0-9_-]', '-') + ".json")
  if (-not (Test-Path -LiteralPath $setupStatus -PathType Leaf) -or
      -not (Test-Path -LiteralPath $setupRegistry -PathType Leaf)) {
    throw "$Label module-readiness checker is missing."
  }
  & python.exe $setupStatus `
    --workbench $Workspace `
    --skills-home $SkillsHome `
    --registry $setupRegistry `
    --json-output $readinessOutput | Out-Host
  # setup_status may return a non-zero code when optional base tools or
  # customer-owned account configuration are still pending. The release gate
  # must only block on missing managed module files, Skills or tutorials below.
  if (-not (Test-Path -LiteralPath $readinessOutput -PathType Leaf)) {
    throw "$Label module-readiness checker produced no report."
  }
  $readiness = Get-Content -LiteralPath $readinessOutput -Raw -Encoding UTF8 | ConvertFrom-Json
  $blocked = @($readiness.customer_modules | Where-Object { [string]$_.status -like 'blocked_*' })
  if ($blocked.Count -gt 0) {
    $blockedNames = ($blocked | ForEach-Object { [string]$_.label }) -join ', '
    throw "$Label customer module readiness failed: $blockedNames"
  }
  if (@($readiness.customer_modules).Count -ne 6) {
    throw "$Label customer module readiness covered $(@($readiness.customer_modules).Count) modules, expected 6."
  }
}

function Assert-TalkingHeadContract {
  param([string]$Workspace, [string]$SkillsHome)

  $webRoot = Join-Path $Workspace "系统文件_无需打开\tools\web-workbench"
  $runtimeRunner = Join-Path $webRoot "runtime\talking-head-runner.mjs"
  $jobsRoot = Join-Path $webRoot "data\talking-head-jobs"
  $imagePath = Join-Path $EvidenceRoot "talking-head-synthetic-9x16.png"
  if (-not (Test-Path -LiteralPath $runtimeRunner -PathType Leaf)) {
    throw "Installed talking-head runner is missing."
  }

  Add-Type -AssemblyName System.Drawing
  $bitmap = [System.Drawing.Bitmap]::new(360, 640)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.Clear([System.Drawing.Color]::FromArgb(32, 45, 64))
    $bitmap.Save($imagePath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }

  try {
    # Windows PowerShell's MultipartFormDataContent serialization is not
    # accepted consistently by the Next/undici FormData parser. curl.exe uses
    # the same standards-compliant multipart request shape as a browser upload.
    $submitResponsePath = Join-Path $EvidenceRoot "talking-head-submit-response.json"
    $curlArgs = @(
      "--silent", "--show-error",
      "--output", $submitResponsePath,
      "--write-out", "%{http_code}",
      "--request", "POST",
      "--form-string", "mode=native",
      "--form-string", "speech_source=native_natural",
      "--form-string", "script=今天我们用一段完全合成的测试内容，核对网页报价和实际执行器是否保持一致。",
      "--form-string", "native_voice_mode=random",
      "--form-string", "native_run_strategy=economy",
      "--form-string", "native_workflow_variant=production",
      "--form-string", "native_duration_planning=adaptive_6_15_candidate",
      "--form-string", "quality_mode=clear",
      "--form-string", "target_ratio=9:16",
      "--form-string", "camera_continuity=strict_locked",
      "--form", "image=@$imagePath;type=image/png;filename=synthetic-portrait.png",
      "http://127.0.0.1:4318/talking-head/jobs"
    )
    $submitStatus = (& curl.exe @curlArgs | Out-String).Trim()
    $submitText = if (Test-Path -LiteralPath $submitResponsePath -PathType Leaf) {
      Get-Content -LiteralPath $submitResponsePath -Raw -Encoding UTF8
    } else {
      ""
    }
    if ($LASTEXITCODE -ne 0 -or $submitStatus -notmatch '^2\d\d$') {
      throw "Installed talking-head HTTP submit failed: $submitText"
    }
    $submit = $submitText | ConvertFrom-Json
    $job = $submit.job
    if ([string]$job.state -ne "preflight" -or
        [int]$job.duration -ne 7 -or
        [int]$job.measured_duration -ne 7 -or
        [int]$job.budget_limit -ne 137 -or
        [int]$job.estimated_rh_coins -ne 137) {
      throw "Talking-head webpage and executor budget contract did not resolve to 7 seconds / 137 RH coins."
    }
    $preflight = [string]$job.preflight
    foreach ($expected in @("含安全余量约 137 RH币", "本段预算 137 RH币", "未上传素材、未创建任务、未产生费用")) {
      if (-not $preflight.Contains($expected)) {
        throw "Talking-head executor preflight is missing expected evidence: $expected"
      }
    }
    if ([string]$job.generation_configuration.status -ne "missing") {
      throw "Clean Windows install did not report missing RunningHub configuration before submission."
    }

    $startText = (& curl.exe --silent --show-error --request POST --header "Content-Length: 0" "http://127.0.0.1:4318/talking-head/jobs/$($job.id)/start" | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $startText -notmatch "配置|生成通道") {
      throw "Missing generation configuration was not blocked with a friendly message."
    }
    $afterBlockedText = (& curl.exe --silent --show-error --fail-with-body "http://127.0.0.1:4318/talking-head/jobs/$($job.id)" | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
      throw "Blocked talking-head task could not be read back."
    }
    $afterBlocked = $afterBlockedText | ConvertFrom-Json
    if ([string]$afterBlocked.job.state -ne "preflight" -or
        [bool]$afterBlocked.job.paid_submission_started -eq $true -or
        [bool]$afterBlocked.job.external_request_started -eq $true) {
      throw "Missing-configuration gate changed the task or started an external request."
    }

    New-Item -ItemType Directory -Force -Path $jobsRoot | Out-Null
    $failureProbe = Join-Path $EvidenceRoot "talking-head-failure-probe.mjs"
    $probeSource = @'
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
const [runnerPath, jobsRoot] = process.argv.slice(2);
const { recordTalkingPreflightFailure } = await import(pathToFileURL(runnerPath).href);
const id = randomUUID();
const createdAt = new Date().toISOString();
const failed = recordTalkingPreflightFailure(jobsRoot, {
  id,
  mode: "native",
  project_name: "Windows 云端失败任务展示验收",
  state: "preflight",
  duration: 7,
  measured_duration: 7,
  budget_limit: 137,
  estimated_rh_coins: 137,
  created_at: createdAt,
}, new Error("budget guardEstimateRhCoins mismatch"));
process.stdout.write(JSON.stringify(failed));
'@
    [IO.File]::WriteAllText($failureProbe, $probeSource, [Text.UTF8Encoding]::new($false))
    $failureText = & node.exe $failureProbe $runtimeRunner $jobsRoot
    if ($LASTEXITCODE -ne 0) {
      throw "Installed failure-task recorder could not execute."
    }
    $failure = $failureText | ConvertFrom-Json
    $listedText = (& curl.exe --silent --show-error --fail-with-body "http://127.0.0.1:4318/talking-head/jobs" | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
      throw "Talking-head task list could not be read back."
    }
    $listed = $listedText | ConvertFrom-Json
    $visibleFailure = @($listed.jobs | Where-Object { [string]$_.id -eq [string]$failure.id })
    if ($visibleFailure.Count -ne 1 -or
        [string]$visibleFailure[0].state -ne "failed" -or
        [string]$visibleFailure[0].failure_stage -ne "preflight" -or
        [int]$visibleFailure[0].actual_cost_rh_coins -ne 0 -or
        [bool]$visibleFailure[0].external_request_started -ne $false -or
        [string]$visibleFailure[0].error -notmatch "任务已保留在任务中心") {
      throw "Failed talking-head preflight was not persisted for Task Center visibility."
    }

    $clientFiles = @(Get-ChildItem -LiteralPath (Join-Path $webRoot "dist\client") -File -Recurse)
    $friendlyUi = $clientFiles | Select-String -SimpleMatch "任务已保留在任务中心" -Quiet
    if (-not $friendlyUi) {
      throw "Prebuilt Windows client is missing the friendly failed-task message."
    }

    $evidence = [ordered]@{
      status = "passed"
      route = "native_natural/economy/production/clear/9:16/adaptive_6_15_candidate"
      synthetic_duration_seconds = 7
      webpage_budget_rh_coins = 137
      executor_preflight_budget_rh_coins = 137
      http_submit_status = [int]$submitStatus
      failed_task_listed = $true
      failed_task_actual_cost_rh_coins = 0
      missing_configuration_blocked_before_external_request = $true
      paid_calls = 0
      external_uploads = 0
      skills_home = $SkillsHome
    }
    $evidence | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $EvidenceRoot "talking-head-contract.json") -Encoding UTF8
    return $evidence
  } finally {}
}

function Invoke-PackageInstaller {
  param([string]$PackageRoot, [string]$Workspace, [string]$SkillsHome, [string]$LogName)
  $installer = Join-Path $PackageRoot "系统文件_无需打开\installer\Install_AI_Content_Workbench.ps1"
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "Installer is missing."
  }
  $log = Join-Path $EvidenceRoot $LogName
  Write-Host "Starting package installer: $LogName"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -WorkspaceRoot $Workspace -CodexSkillsHome $SkillsHome *>&1 |
    Tee-Object -FilePath $log
  if ($LASTEXITCODE -ne 0) {
    throw "Installer exited with code $LASTEXITCODE."
  }
  Write-Host "Package installer returned: $LogName"
}

function New-ValidationTicket {
  param(
    [string]$Label,
    [string]$InstallMode,
    [string]$PackageUrl,
    [string]$PackageSha256,
    [long]$PackageSize,
    [string]$PackageRoot,
    [string]$ManifestUrl
  )
  $manifestPath = Join-Path $EvidenceRoot "$Label-manifest.json"
  $ticketPath = Join-Path $EvidenceRoot "$Label-ticket.json"
  $manifest = [ordered]@{
    schema_version = 1
    product_id = "ai-content-workbench"
    module_id = if ($InstallMode -eq "first_install") { "workbench-full-first-install" } else { "workbench-full-cumulative-upgrade" }
    version = $TargetVersion
    release_tag = "workbench-v$TargetVersion"
    release_id = "windows-real-customer-path-$TargetVersion"
    channel = "validation"
    status = "windows_real_customer_path_gate"
    platform = "windows"
    install_mode = $InstallMode
    package_contract = "full_workbench_v1"
    package_file_name = "$Label.zip"
    package_root = $PackageRoot
    package_subdir = "系统文件_无需打开"
    package_size_bytes = $PackageSize
    package_sha256 = $PackageSha256.ToLowerInvariant()
    dependency_profile = "full_prebuilt_web_runtime"
    required_tools = @("python_runtime", "node", "ffmpeg", "ffprobe", "curl")
    environment_preflight_required = $true
    installed_skill_count = 38
  }
  $now = [DateTimeOffset]::UtcNow
  $ticket = [ordered]@{
    schema_version = 1
    ticket_id = "$TargetVersion-$Label"
    customer_id = "github-windows-real-path-$Label"
    issued_at = $now.ToString("o")
    expires_at = $now.AddHours(4).ToString("o")
    product_id = "ai-content-workbench"
    version = $TargetVersion
    platform = "windows"
    install_mode = $InstallMode
    manifest_url = $ManifestUrl
    package_url = $PackageUrl
    package_size_bytes = $PackageSize
    package_sha256 = $PackageSha256.ToLowerInvariant()
  }
  $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
  $ticket | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ticketPath -Encoding UTF8
  return $ticketPath
}

function Invoke-CustomerDeployment {
  param([string]$TicketPath, [string]$Workspace, [string]$SkillsHome, [string]$LogName)
  $log = Join-Path $EvidenceRoot $LogName
  $previousStateRoot = $env:AICW_DEPLOYER_STATE_ROOT
  $env:AICW_DEPLOYER_STATE_ROOT = Join-Path $OutputRoot ("deployer-state\" + [IO.Path]::GetFileNameWithoutExtension($TicketPath))
  try {
    Write-Host "Starting unchanged customer deployment path: $LogName"
    & python.exe .\scripts\deploy.py apply `
      --ticket $TicketPath `
      --workbench $Workspace `
      --skills-home $SkillsHome `
      --confirm-write YES *>&1 | Tee-Object -FilePath $log
    if ($LASTEXITCODE -ne 0) {
      $stateEvidence = Join-Path $EvidenceRoot ($LogName + "-deployer-state")
      if (Test-Path -LiteralPath $env:AICW_DEPLOYER_STATE_ROOT -PathType Container) {
        Copy-Item -LiteralPath $env:AICW_DEPLOYER_STATE_ROOT -Destination $stateEvidence -Recurse -Force
      }
      $serviceLogRoot = Join-Path $Workspace "系统文件_无需打开\logs\web-workbench"
      $serviceEvidence = Join-Path $EvidenceRoot ($LogName + "-web-service-logs")
      if (Test-Path -LiteralPath $serviceLogRoot -PathType Container) {
        Copy-Item -LiteralPath $serviceLogRoot -Destination $serviceEvidence -Recurse -Force
      }
      $deploymentLogRoot = Join-Path $Workspace "系统文件_无需打开\logs\deployment"
      $deploymentEvidence = Join-Path $EvidenceRoot ($LogName + "-deployment-logs")
      if (Test-Path -LiteralPath $deploymentLogRoot -PathType Container) {
        Copy-Item -LiteralPath $deploymentLogRoot -Destination $deploymentEvidence -Recurse -Force
      }
      Get-CimInstance Win32_Process |
        Where-Object { $_.Name -match '^node(\.exe)?$' -or $_.Name -match '^powershell(\.exe)?$' } |
        Select-Object Name, ProcessId, ParentProcessId, CommandLine |
        Format-List |
        Out-File -LiteralPath (Join-Path $EvidenceRoot ($LogName + "-processes.txt")) -Encoding utf8
      Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -in @(3000, 4318) } |
        Select-Object LocalAddress, LocalPort, OwningProcess |
        Format-Table -AutoSize |
        Out-File -LiteralPath (Join-Path $EvidenceRoot ($LogName + "-listeners.txt")) -Encoding utf8
      throw "Customer deployment path exited with code $LASTEXITCODE."
    }
  } finally {
    $env:AICW_DEPLOYER_STATE_ROOT = $previousStateRoot
  }
}

function Disable-HistoricalWebActivation {
  param([string]$PackageRoot)
  $services = Join-Path $PackageRoot "系统文件_无需打开\web-workbench\service\windows\install-services.ps1"
  if (-not (Test-Path -LiteralPath $services -PathType Leaf)) {
    throw "Historical baseline web activation script is missing."
  }
  $shim = @'
param(
  [string]$WebRoot,
  [string]$BackupRoot,
  [string]$WorkbenchRoot,
  [switch]$SkipBuild
)
Write-Host "Historical baseline payload installed; obsolete service activation skipped for upgrade setup."
'@
  [IO.File]::WriteAllText(
    $services,
    $shim,
    [Text.UTF8Encoding]::new($true)
  )
}

try {
  $firstZip = Join-Path $DownloadRoot "windows-first-install.zip"
  $upgradeZip = Join-Path $DownloadRoot "windows-upgrade.zip"
  $baselineZip = Join-Path $DownloadRoot "windows-historical-baseline.zip"
  Download-Verified -Url $FirstInstallUrl -Destination $firstZip -Expected $FirstInstallSha256
  Download-Verified -Url $UpgradeUrl -Destination $upgradeZip -Expected $UpgradeSha256
  Download-Verified -Url $BaselineUrl -Destination $baselineZip -Expected $BaselineSha256

  $firstPackage = Expand-VerifiedPackage -Archive $firstZip -Destination (Join-Path $ExtractRoot "first")
  $upgradePackage = Expand-VerifiedPackage -Archive $upgradeZip -Destination (Join-Path $ExtractRoot "upgrade")
  $baselinePackage = Expand-VerifiedPackage -Archive $baselineZip -Destination (Join-Path $ExtractRoot "baseline")

  $firstTicket = $FirstInstallTicketUrl
  $upgradeTicket = $UpgradeTicketUrl
  $recoveryTicket = $RecoveryTicketUrl

  $cleanWorkspace = Join-Path $OutputRoot "clean-first-install\AIContentWorkbench"
  $cleanSkills = Join-Path $OutputRoot "clean-first-install\skills"
  Invoke-CustomerDeployment -TicketPath $firstTicket -Workspace $cleanWorkspace -SkillsHome $cleanSkills -LogName "clean-first-install.log"
  Assert-InstalledWorkbench -Workspace $cleanWorkspace -SkillsHome $cleanSkills -Label "clean first install"
  $talkingHeadContract = Assert-TalkingHeadContract -Workspace $cleanWorkspace -SkillsHome $cleanSkills
  Stop-GateProcesses

  $recoveryWorkspace = Join-Path $OutputRoot "interrupted-recovery\AIContentWorkbench"
  $recoverySkills = Join-Path $OutputRoot "interrupted-recovery\skills"
  Disable-HistoricalWebActivation -PackageRoot $baselinePackage
  Invoke-PackageInstaller -PackageRoot $baselinePackage -Workspace $recoveryWorkspace -SkillsHome $recoverySkills -LogName "interrupted-recovery-baseline.log"
  Stop-GateProcesses
  $recoverySentinel = Join-Path $recoveryWorkspace "02_项目工作区\中断恢复验证\keep.txt"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $recoverySentinel) | Out-Null
  Set-Content -LiteralPath $recoverySentinel -Value "preserve-interrupted-install" -Encoding UTF8
  New-Item -ItemType Directory -Force -Path (Join-Path $recoveryWorkspace "系统文件_无需打开\tools\web-workbench") | Out-Null
  Set-Content -LiteralPath (Join-Path $recoveryWorkspace "系统文件_无需打开\tools\web-workbench\partial-install.marker") -Value "simulated interruption" -Encoding UTF8
  Invoke-CustomerDeployment -TicketPath $recoveryTicket -Workspace $recoveryWorkspace -SkillsHome $recoverySkills -LogName "interrupted-recovery.log"
  if (-not (Test-Path -LiteralPath $recoverySentinel -PathType Leaf)) {
    throw "Interrupted recovery removed the customer project sentinel."
  }
  Assert-InstalledWorkbench -Workspace $recoveryWorkspace -SkillsHome $recoverySkills -Label "interrupted recovery"
  Stop-GateProcesses

  $upgradeWorkspace = Join-Path $OutputRoot "historical-upgrade\AIContentWorkbench"
  $upgradeSkills = Join-Path $OutputRoot "historical-upgrade\skills"
  Invoke-PackageInstaller -PackageRoot $baselinePackage -Workspace $upgradeWorkspace -SkillsHome $upgradeSkills -LogName "historical-baseline-install.log"
  Stop-GateProcesses

  $sentinels = @{
    project = Join-Path $upgradeWorkspace "02_项目工作区\云端验收历史项目\keep.txt"
    output = Join-Path $upgradeWorkspace "03_最终成果\云端验收历史成果.txt"
    config = Join-Path $upgradeWorkspace "系统文件_无需打开\config\customer-preservation-sentinel.txt"
  }
  foreach ($entry in $sentinels.GetEnumerator()) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $entry.Value) | Out-Null
    Set-Content -LiteralPath $entry.Value -Value "preserve-$($entry.Key)-v1.7.0" -Encoding UTF8
  }
  $before = @{}
  foreach ($entry in $sentinels.GetEnumerator()) {
    $before[$entry.Key] = (Get-FileHash -LiteralPath $entry.Value -Algorithm SHA256).Hash
  }

  Invoke-CustomerDeployment -TicketPath $upgradeTicket -Workspace $upgradeWorkspace -SkillsHome $upgradeSkills -LogName "historical-upgrade.log"
  foreach ($entry in $sentinels.GetEnumerator()) {
    if (-not (Test-Path -LiteralPath $entry.Value -PathType Leaf)) {
      throw "Historical $($entry.Key) sentinel was removed."
    }
    $after = (Get-FileHash -LiteralPath $entry.Value -Algorithm SHA256).Hash
    if ($after -ne $before[$entry.Key]) {
      throw "Historical $($entry.Key) sentinel changed during upgrade."
    }
  }
  Assert-InstalledWorkbench -Workspace $upgradeWorkspace -SkillsHome $upgradeSkills -Label "historical upgrade"
  Stop-GateProcesses

  $report = [ordered]@{
    schema_version = 1
    product_id = "ai-content-workbench"
    version = $TargetVersion
    platform = "windows"
    status = "pass"
    executed_on_windows = $true
    historical_baseline_setup = "actual_v1.7.0_payload_installed_with_obsolete_service_activation_skipped"
    target_package_execution = "unchanged_customer_deploy_py_apply_path"
    checks = [ordered]@{
      clean_first_install = "installed_and_verified"
      historical_upgrade = "installed_and_verified"
      interrupted_recovery = "installed_and_verified"
      powershell_execution = "passed"
      web_workbench_prebuilt_runtime = "passed"
      web_workbench_launch = "passed"
      post_install_receipt = "passed"
      customer_module_readiness = "passed_six_modules_using_installed_tutorial_layout"
      talking_head_http_submit = "passed_with_7_second_synthetic_material"
      talking_head_budget_parity = "passed_137_rh_coins_webpage_and_executor"
      talking_head_failed_task_visibility = "passed"
      talking_head_missing_configuration_gate = "passed_before_external_request"
      talking_head_paid_calls = [int]$talkingHeadContract.paid_calls
      talking_head_external_uploads = [int]$talkingHeadContract.external_uploads
      historical_project_output_and_config_preservation = "passed"
    }
    package_sha256 = @($FirstInstallSha256.ToLowerInvariant(), $UpgradeSha256.ToLowerInvariant())
  }
  $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputRoot "windows-release-gate.json") -Encoding UTF8
  Write-Host "Windows release gate passed."
} catch {
  Stop-GateProcesses
  $_ | Out-String | Set-Content -LiteralPath (Join-Path $EvidenceRoot "gate-failure.txt") -Encoding UTF8
  throw
}
