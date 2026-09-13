param(
  [Parameter(Mandatory = $true)][string]$Workspace,
  [Parameter(Mandatory = $true)][string]$SkillsHome,
  [Parameter(Mandatory = $true)][string]$Evidence,
  [Parameter(Mandatory = $true)][string]$HarnessRoot,
  [Parameter(Mandatory = $true)][string]$TestDependencies
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'Disposable GitHub Windows runner only.' }
if (-not [string]::IsNullOrWhiteSpace($env:RUNNINGHUB_API_KEY)) { throw 'Provider credentials are forbidden in this gate.' }
if (Test-Path -LiteralPath $Evidence) { throw 'Evidence directory already exists.' }
New-Item -ItemType Directory -Path $Evidence | Out-Null

$setup = Join-Path $Workspace '系统文件_无需打开\tools\scripts\workbench-setup\setup_status.py'
$registry = Join-Path (Split-Path -Parent $setup) 'customer_setup_registry.json'
$readiness = Join-Path $Evidence 'installation-readiness-only.json'
& python.exe $setup --workbench $Workspace --skills-home $SkillsHome --registry $registry --json-output $readiness | Out-Host
if (-not (Test-Path -LiteralPath $readiness)) { throw 'Readiness report missing.' }
$data = Get-Content -LiteralPath $readiness -Raw -Encoding UTF8 | ConvertFrom-Json
if (@($data.customer_modules | Where-Object { $_.no_cost_dry_run -ne 'not_run' }).Count -ne 0) { throw 'Readiness checker claimed a business dry-run.' }

$assets = Join-Path $HarnessRoot 'synthetic-fixtures'
& python.exe (Join-Path $HarnessRoot 'tests\create-installed-smoke-spec.py') --workbench $Workspace --evidence $Evidence --assets $assets
if ($LASTEXITCODE -ne 0) { throw 'Smoke fixture setup failed.' }
$env:AICW_TEST_DEPENDENCY_ANCHOR = Join-Path $TestDependencies 'package.json'
& node.exe (Join-Path $HarnessRoot 'tests\browser-smoke.mjs') (Join-Path $Evidence 'browser-spec.json') *>&1 |
  Tee-Object -FilePath (Join-Path $Evidence 'browser-driver.log')
if ($LASTEXITCODE -ne 0) { throw 'Actual browser business smoke failed.' }
$report = Get-Content -LiteralPath (Join-Path $Evidence 'browser-smoke-report.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $report.pass -or $report.platform -ne 'win32' -or $report.responses_mocked) { throw 'Windows browser evidence is invalid.' }
