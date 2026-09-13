param(
  [Parameter(Mandatory = $true)][string]$Workspace,
  [Parameter(Mandatory = $true)][string]$Evidence,
  [string]$PayloadRoot = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'Disposable GitHub Windows runner only.' }
$Harness = $PSScriptRoot
$ManifestPath = Join-Path $Harness 'overlay-manifest.json'
$Manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$WebRoot = Join-Path $Workspace '系统文件_无需打开\tools\web-workbench'
$PackageJson = Join-Path $WebRoot 'package.json'
if (-not (Test-Path -LiteralPath $PackageJson)) { throw 'Installed web workbench is missing.' }
$packageHash = (Get-FileHash -LiteralPath $PackageJson -Algorithm SHA256).Hash.ToLowerInvariant()
if ($packageHash -ne [string]$Manifest.compatibility.package_json_sha256) { throw 'Installed workbench baseline is incompatible.' }
if (Test-Path -LiteralPath $Evidence) { throw 'Overlay evidence directory already exists.' }
New-Item -ItemType Directory -Path $Evidence | Out-Null

$payloadArchive = Join-Path $Harness ([string]$Manifest.payload_archive.archive)
if (-not (Test-Path -LiteralPath $payloadArchive -PathType Leaf)) { throw 'Candidate payload archive is missing.' }
$payloadArchiveHash = (Get-FileHash -LiteralPath $payloadArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($payloadArchiveHash -ne [string]$Manifest.payload_archive.sha256) { throw 'Candidate payload archive hash mismatch.' }
if ([string]::IsNullOrWhiteSpace($PayloadRoot)) {
  $payloadExtractRoot = Join-Path $Evidence '_candidate-payload'
  New-Item -ItemType Directory -Path $payloadExtractRoot | Out-Null
  & tar.exe -xzf $payloadArchive -C $payloadExtractRoot
  if ($LASTEXITCODE -ne 0) { throw 'Candidate payload archive extraction failed.' }
  $Payload = Join-Path $payloadExtractRoot 'payload'
} else {
  $Payload = $PayloadRoot
}
if (-not (Test-Path -LiteralPath $Payload -PathType Container)) { throw 'Candidate payload root is missing after extraction.' }
$payloadFiles = @(Get-ChildItem -LiteralPath $Payload -Recurse -File)
if ($payloadFiles.Count -ne [int]$Manifest.payload_archive.file_count) { throw 'Candidate payload file count mismatch.' }

$stop = Join-Path $WebRoot 'service\windows\stop-services.ps1'
if (Test-Path -LiteralPath $stop) { & $stop -WebRoot $WebRoot }

$overlayRecords = @()
foreach ($file in $Manifest.files) {
  $source = Join-Path $Payload ([string]$file.source)
  $target = Join-Path $Workspace ([string]$file.destination)
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Candidate file missing: $source" }
  $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($sourceHash -ne [string]$file.sha256) { throw "Candidate file hash mismatch: $source expected=$($file.sha256) actual=$sourceHash" }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  if (Test-Path -LiteralPath $target -PathType Leaf) {
    $backupName = ([string]$file.destination -replace '[^A-Za-z0-9._-]', '_') + '.baseline'
    Copy-Item -LiteralPath $target -Destination (Join-Path $Evidence $backupName)
  }
  Copy-Item -LiteralPath $source -Destination $target -Force
  if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sourceHash) { throw "Overlay readback failed: $target" }
  $overlayRecords += @{ destination = [string]$file.destination; sha256 = $sourceHash }
}

$dist = Join-Path $WebRoot 'dist'
$distArchive = Join-Path $Harness ([string]$Manifest.dist.archive)
$distArchiveHash = (Get-FileHash -LiteralPath $distArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($distArchiveHash -ne [string]$Manifest.dist.archive_sha256) { throw 'Candidate dist archive hash mismatch.' }
if (Test-Path -LiteralPath $dist) { Remove-Item -LiteralPath $dist -Recurse -Force }
$distExtractRoot = Join-Path $Evidence '_candidate-dist'
New-Item -ItemType Directory -Path $distExtractRoot | Out-Null
# Windows tar can misdecode non-ASCII -C paths. Extract only into the ASCII
# runner/evidence path, then let PowerShell copy into the Chinese workbench path.
& tar.exe -xzf $distArchive -C $distExtractRoot
if ($LASTEXITCODE -ne 0) { throw "Candidate dist archive extraction failed with exit code $LASTEXITCODE." }
$stagedDist = Join-Path $distExtractRoot 'dist'
if (-not (Test-Path -LiteralPath (Join-Path $stagedDist 'server\index.js'))) { throw 'Candidate staged dist is incomplete.' }
Copy-Item -LiteralPath $stagedDist -Destination $WebRoot -Recurse -Force
if (-not (Test-Path -LiteralPath (Join-Path $dist 'server\index.js'))) { throw 'Candidate dist copy into workbench failed.' }
$distFiles = @(Get-ChildItem -LiteralPath $dist -Recurse -File)
if ($distFiles.Count -ne [int]$Manifest.dist.file_count) { throw 'Candidate dist file count mismatch.' }
foreach ($entry in $Manifest.dist.critical_sha256.PSObject.Properties) {
  $criticalPath = Join-Path $WebRoot $entry.Name
  $criticalHash = (Get-FileHash -LiteralPath $criticalPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($criticalHash -ne [string]$entry.Value) { throw "Candidate dist critical hash mismatch: $($entry.Name)" }
}

$start = Join-Path $WebRoot 'service\windows\start-services.ps1'
& $start -WebRoot $WebRoot -WorkbenchRoot $Workspace
$front = $null
$runtime = $null
$deadline = (Get-Date).AddSeconds(90)
do {
  try {
    $front = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000' -TimeoutSec 5
    $runtime = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4318/health' -TimeoutSec 5
    if ($front.StatusCode -eq 200 -and $runtime.StatusCode -eq 200) { break }
  } catch {}
  Start-Sleep -Milliseconds 800
} while ((Get-Date) -lt $deadline)
if ($null -eq $front -or $null -eq $runtime -or $front.StatusCode -ne 200 -or $runtime.StatusCode -ne 200) { throw 'Candidate services did not become healthy.' }

@{
  kind = 'unpublished_candidate_overlay_on_disposable_runner'
  candidate_id = [string]$Manifest.candidate_id
  files = $overlayRecords
  payload_archive_sha256 = $payloadArchiveHash
  dist_archive_sha256 = $distArchiveHash
  service_restart = 'passed'
  formal_release_acceptance = $false
} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Evidence 'overlay-receipt.json') -Encoding UTF8
