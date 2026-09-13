param(
  [Parameter(Mandatory = $true)][string]$WebRoot,
  [Parameter(Mandatory = $true)][string]$BackupRoot,
  [Parameter(Mandatory = $true)][string]$WorkbenchRoot,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

if ($SkipBuild) {
  foreach ($relativePath in @(
    "dist\server\index.js",
    "dist\server\BUILD_ID",
    "dist\client\vinext-client-entry-manifest.json"
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $WebRoot $relativePath) -PathType Leaf)) {
      throw "网页工作台预构建结果不完整：$relativePath"
    }
  }
} else {
  & (Join-Path $WebRoot "service\windows\build-web-workbench.ps1") -WebRoot $WebRoot
}

$startup = [Environment]::GetFolderPath("Startup")
if ([string]::IsNullOrWhiteSpace($startup)) {
  throw "Windows 未返回当前用户的开机启动目录。"
}
New-Item -ItemType Directory -Force -Path $startup | Out-Null
$shortcutPath = Join-Path $startup "AI内容工作台.lnk"
$shortcutFallbackPath = Join-Path $startup "AIContentWorkbench.lnk"
New-Item -ItemType Directory -Force -Path (Join-Path $BackupRoot "startup") | Out-Null
foreach ($existingShortcut in @($shortcutPath, $shortcutFallbackPath)) {
  if (Test-Path $existingShortcut) {
    Copy-Item $existingShortcut (Join-Path $BackupRoot "startup\$([IO.Path]::GetFileName($existingShortcut))") -Force
  }
}

$shell = New-Object -ComObject WScript.Shell
$startScript = Join-Path $WebRoot "service\windows\start-services.ps1"
function Write-StartupShortcut {
  param([string]$Path)
  $item = $shell.CreateShortcut($Path)
  $item.TargetPath = "powershell.exe"
  $item.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`" -WebRoot `"$WebRoot`" -WorkbenchRoot `"$WorkbenchRoot`""
  $item.WorkingDirectory = $WebRoot
  $item.Save()
}
try {
  Write-StartupShortcut $shortcutPath
} catch {
  Write-StartupShortcut $shortcutFallbackPath
}

$openScript = Join-Path $WebRoot "service\windows\open-workbench.ps1"
if (-not (Test-Path $openScript -PathType Leaf)) {
  throw "缺少网页工作台打开程序。"
}

function Write-OpenShortcut {
  param([string]$Path)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  $item = $shell.CreateShortcut($Path)
  $item.TargetPath = "powershell.exe"
  $item.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$openScript`" -WebRoot `"$WebRoot`" -WorkbenchRoot `"$WorkbenchRoot`""
  $item.WorkingDirectory = $WebRoot
  $item.Description = "打开 AI 内容工作台"
  $item.Save()
}

function Write-OpenShortcutWithFallback {
  param([string]$Path, [string]$FallbackPath)
  try {
    Write-OpenShortcut $Path
  } catch {
    Write-OpenShortcut $FallbackPath
  }
}

$desktop = [Environment]::GetFolderPath("Desktop")
$programs = [Environment]::GetFolderPath("Programs")
Write-OpenShortcutWithFallback `
  (Join-Path $desktop "AI 内容工作台.lnk") `
  (Join-Path $desktop "AI Content Workbench.lnk")
Write-OpenShortcutWithFallback `
  (Join-Path (Join-Path $programs "AI 内容工作台") "AI 内容工作台.lnk") `
  (Join-Path (Join-Path $programs "AI Content Workbench") "AI Content Workbench.lnk")

Write-Host "网页工作台服务入口已安装，并已创建桌面和开始菜单入口。"
Write-Host "常驻服务将在安装器返回后由部署程序独立启动。"
