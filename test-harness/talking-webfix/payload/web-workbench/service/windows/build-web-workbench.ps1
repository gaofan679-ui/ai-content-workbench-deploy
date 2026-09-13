param(
  [Parameter(Mandatory = $true)][string]$WebRoot
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $WebRoot -PathType Container)) {
  throw "找不到网页工作台构建目录：$WebRoot"
}

$packagePath = Join-Path $WebRoot "package.json"
$npmrcPath = Join-Path $WebRoot ".npmrc"
if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
  throw "网页工作台缺少 package.json。"
}
if (-not (Test-Path -LiteralPath $npmrcPath -PathType Leaf)) {
  throw "网页工作台缺少依赖安全策略。"
}

$package = Get-Content -Raw -LiteralPath $packagePath -Encoding UTF8 | ConvertFrom-Json
foreach ($scriptName in @("dev:web", "build", "start")) {
  $scriptValue = [string]$package.scripts.$scriptName
  if ([string]::IsNullOrWhiteSpace($scriptValue) -or $scriptValue -match "(?:^|\s|&&)[A-Z_][A-Z0-9_]*=") {
    throw "网页工作台脚本 $scriptName 不兼容 Windows。"
  }
}
if ($package.scripts.build -ne "vinext build" -or $package.scripts.start -ne "vinext start") {
  throw "网页工作台构建或启动命令不符合 Windows 发布合同。"
}
if ($package.allowScripts.'esbuild@0.28.1' -ne $true -or $package.allowScripts.'workerd@1.20260811.1' -ne $true) {
  throw "网页工作台依赖授权清单不完整。"
}
$npmrc = Get-Content -Raw -LiteralPath $npmrcPath -Encoding UTF8
if ($npmrc -notmatch "(?m)^strict-allow-scripts=true\s*$") {
  throw "网页工作台未启用严格依赖脚本授权。"
}

$node = Get-Command node -ErrorAction Stop
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { $npm = Get-Command npm -ErrorAction Stop }
$nodeVersion = & $node.Source -p "process.versions.node"
$parts = $nodeVersion.Split(".")
if ([int]$parts[0] -lt 22 -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -lt 13)) {
  throw "网页工作台需要 Node.js 22.13 或更高版本，当前为 $nodeVersion。"
}

Push-Location $WebRoot
try {
  $installed = $false
  foreach ($registry in @("", "https://registry.npmmirror.com")) {
    $arguments = @("ci", "--no-audit", "--no-fund")
    if ($registry) { $arguments += "--registry=$registry" }
    & $npm.Source @arguments
    if ($LASTEXITCODE -eq 0) {
      $installed = $true
      break
    }
    Write-Host "依赖下载未完成，正在自动换用备用线路重试……" -ForegroundColor Yellow
  }
  if (-not $installed) {
    throw "网页工作台依赖下载失败；已自动尝试两条线路。"
  }

  & $npm.Source run build
  if ($LASTEXITCODE -ne 0) {
    throw "网页工作台构建失败。"
  }

  foreach ($relativePath in @(
    "dist\server\index.js",
    "dist\server\BUILD_ID",
    "dist\client\vinext-client-entry-manifest.json"
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $WebRoot $relativePath) -PathType Leaf)) {
      throw "网页工作台构建结果不完整：$relativePath"
    }
  }
} finally {
  Pop-Location
}

Write-Host "网页工作台依赖安装和构建验收通过。"
