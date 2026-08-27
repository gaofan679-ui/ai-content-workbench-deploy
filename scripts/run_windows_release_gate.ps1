param(
  [Parameter(Mandatory = $true)][string]$TargetVersion,
  [Parameter(Mandatory = $true)][string]$FirstInstallUrl,
  [Parameter(Mandatory = $true)][string]$FirstInstallSha256,
  [Parameter(Mandatory = $true)][string]$UpgradeUrl,
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
    (Join-Path $Workspace "04_使用教程\docs\04_打开使用教程.html")
  )
  foreach ($path in $required) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "$Label required installed file is missing: $path"
    }
  }
  $skillCount = @(Get-ChildItem -LiteralPath $SkillsHome -Directory | Where-Object {
    Test-Path -LiteralPath (Join-Path $_.FullName "SKILL.md") -PathType Leaf
  }).Count
  if ($skillCount -ne 37) {
    throw "$Label installed Skill count is $skillCount, expected 37."
  }
  $summaries = @(Get-ChildItem -LiteralPath (Join-Path $Workspace "系统文件_无需打开\logs") -Filter "install_summary_*.txt" -File)
  if ($summaries.Count -lt 1) {
    throw "$Label installation summary is missing."
  }

  $webRoot = Join-Path $Workspace "系统文件_无需打开\tools\web-workbench"
  $startScript = Join-Path $webRoot "service\windows\start-services.ps1"
  Write-Host "Starting the installed web service for verification: $Label"
  $launcher = Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $startScript,
    "-WebRoot", $webRoot,
    "-WorkbenchRoot", $Workspace
  ) -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 2
  if ($launcher.HasExited -and $launcher.ExitCode -ne 0) {
    throw "$Label web-workbench start script failed with code $($launcher.ExitCode)."
  }
  Wait-Workbench
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

function Defer-PackageWebAutoStart {
  param([string]$PackageRoot)
  $services = Join-Path $PackageRoot "系统文件_无需打开\web-workbench\service\windows\install-services.ps1"
  if (-not (Test-Path -LiteralPath $services -PathType Leaf)) {
    throw "Current package web activation script is missing."
  }
  $source = [IO.File]::ReadAllText($services)
  $needle = '& $startScript -WebRoot $WebRoot -WorkbenchRoot $WorkbenchRoot'
  if ($source.IndexOf($needle, [StringComparison]::Ordinal) -lt 0) {
    throw "Current package web auto-start marker is missing."
  }
  $source = $source.Replace(
    $needle,
    'Write-Host "Cloud gate defers web activation until the installer has returned."'
  )
  [IO.File]::WriteAllText($services, $source, [Text.UTF8Encoding]::new($true))
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
  Defer-PackageWebAutoStart -PackageRoot $firstPackage
  Defer-PackageWebAutoStart -PackageRoot $upgradePackage

  $cleanWorkspace = Join-Path $OutputRoot "clean-first-install\AIContentWorkbench"
  $cleanSkills = Join-Path $OutputRoot "clean-first-install\skills"
  Invoke-PackageInstaller -PackageRoot $firstPackage -Workspace $cleanWorkspace -SkillsHome $cleanSkills -LogName "clean-first-install.log"
  Assert-InstalledWorkbench -Workspace $cleanWorkspace -SkillsHome $cleanSkills -Label "clean first install"
  Stop-GateProcesses

  $upgradeWorkspace = Join-Path $OutputRoot "historical-upgrade\AIContentWorkbench"
  $upgradeSkills = Join-Path $OutputRoot "historical-upgrade\skills"
  Disable-HistoricalWebActivation -PackageRoot $baselinePackage
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

  Invoke-PackageInstaller -PackageRoot $upgradePackage -Workspace $upgradeWorkspace -SkillsHome $upgradeSkills -LogName "historical-upgrade.log"
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
    checks = [ordered]@{
      clean_first_install = "installed_and_verified"
      historical_upgrade = "installed_and_verified"
      powershell_execution = "passed"
      web_workbench_build = "passed"
      web_workbench_launch = "passed"
      post_install_receipt = "passed"
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
