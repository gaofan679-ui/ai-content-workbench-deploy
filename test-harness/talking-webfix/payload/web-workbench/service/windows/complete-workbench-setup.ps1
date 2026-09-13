param(
  [Parameter(Mandatory = $true)][string]$WorkbenchRoot,
  [string]$CodexSkillsHome = ""
)

$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$SystemRoot = Join-Path $WorkbenchRoot "系统文件_无需打开"
$ToolsRoot = Join-Path $SystemRoot "tools"
$ScriptsRoot = Join-Path $ToolsRoot "scripts"
$WebRoot = Join-Path $ToolsRoot "web-workbench"
$ConfigRoot = Join-Path $SystemRoot "config"
$LogsRoot = Join-Path $SystemRoot "logs"
$CodexSkills = if ([string]::IsNullOrWhiteSpace($CodexSkillsHome)) {
  Join-Path (Join-Path $env:USERPROFILE ".codex") "skills"
} else {
  $CodexSkillsHome
}
$ConfigScript = Join-Path $WebRoot "service\windows\configure-workbench.ps1"
$StatusScript = Join-Path $ScriptsRoot "workbench-setup\setup_status.py"
$Registry = Join-Path $ScriptsRoot "workbench-setup\customer_setup_registry.json"
$SocialAsrSetup = Join-Path $ScriptsRoot "workbench-setup\prepare_social_asr_model.py"
$DependencyHelper = Join-Path $ScriptsRoot "..\..\starter\tools\windows_install_dependencies.ps1"
$SmartSetup = Join-Path $ScriptsRoot "smart-editing\setup_caption_alignment_environment.py"
$ConfigPath = Join-Path $ConfigRoot "customer_config.env"
$LibtvInstaller = Join-Path $CodexSkills "libtv-cli\scripts\install-libtv-cli.ps1"
$CompanionDir = Join-Path $WebRoot "browser-companion\chatgpt-web"
$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$StatusOutput = Join-Path $LogsRoot "complete_setup_status_$Timestamp.json"

function Find-Python {
  foreach ($name in @("python", "python3", "py")) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  return ""
}

function Find-Chrome {
  foreach ($path in @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )) {
    if ($path -and (Test-Path $path -PathType Leaf)) { return $path }
  }
  return ""
}

function Set-ConfigValue {
  param([string]$Key, [string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value) -or -not (Test-Path $ConfigPath -PathType Leaf)) { return }
  $content = Get-Content -Raw -LiteralPath $ConfigPath -Encoding UTF8
  $safeValue = $Value.Replace("`r", "").Replace("`n", "")
  $pattern = "(?m)^" + [regex]::Escape($Key) + "=.*$"
  if ($content -match $pattern) {
    $content = [regex]::Replace($content, $pattern, "$Key=$safeValue")
  } else {
    $content = $content.TrimEnd() + "`r`n$Key=$safeValue`r`n"
  }
  Set-Content -LiteralPath $ConfigPath -Value $content -Encoding UTF8
}

New-Item -ItemType Directory -Force -Path $LogsRoot | Out-Null
Write-Host ""
Write-Host "AI 内容工作台｜完成全部配置" -ForegroundColor Cyan
Write-Host "这个入口会连续处理工作台所需的本地工具、密钥、账号登录和网页伴侣。"
Write-Host "密码、验证码、账号登录、扩展启用和付费仍必须由使用者本人确认。"
Write-Host "全程不读取浏览器 Cookie、钥匙串或已保存的密钥内容。"

if (Test-Path $ConfigScript -PathType Leaf) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ConfigScript -WorkbenchRoot $WorkbenchRoot
} else {
  Write-Host "[阻塞] 找不到功能配置向导，请重新运行完整安装或升级。" -ForegroundColor Red
  exit 2
}

$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$env:Path = "$machinePath;$userPath;$env:Path"

if (-not (Get-Command libtv -ErrorAction SilentlyContinue)) {
  Write-Host ""
  Write-Host "正在安装与工作台文档匹配的 LibTV 命令行工具…" -ForegroundColor Cyan
  if (-not (Test-Path $LibtvInstaller -PathType Leaf)) {
    Write-Host "[阻塞] 工作台内缺少 LibTV 安装程序。" -ForegroundColor Red
  } else {
    $env:LIBTV_CLI_VERSION = "1.0.0"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $LibtvInstaller
    $env:Path = "$env:USERPROFILE\.libtv;$env:Path"
  }
}

if (Get-Command libtv -ErrorAction SilentlyContinue) {
  $credentialFile = Join-Path $env:USERPROFILE ".libtv\credentials.json"
  if (-not (Test-Path $credentialFile -PathType Leaf)) {
    Write-Host ""
    $login = Read-Host "LibTV 工具已安装。是否现在打开官方登录？输入 YES 继续，直接回车稍后处理"
    if ($login -eq "YES") {
      & libtv login web --open
    }
  }
}

$chrome = Find-Chrome
if (-not $chrome) {
  $wantChrome = Read-Host "未找到 Chrome。如需 ChatGPT 网页生图伴侣，输入 YES 由 Windows 官方安装渠道安装；否则直接回车"
  if ($wantChrome -eq "YES") {
    $dependencyCandidates = @(
      (Join-Path $WorkbenchRoot "系统文件_无需打开\tools\starter\tools\windows_install_dependencies.ps1"),
      $DependencyHelper
    )
    $helper = $dependencyCandidates | Where-Object { Test-Path $_ -PathType Leaf } | Select-Object -First 1
    if ($helper) {
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helper -AutoApprove -IncludeChrome
      $chrome = Find-Chrome
    } elseif (Get-Command winget -ErrorAction SilentlyContinue) {
      & winget install --id Google.Chrome --exact --accept-package-agreements --accept-source-agreements
      $chrome = Find-Chrome
    }
  }
}

if ($chrome -and (Test-Path (Join-Path $CompanionDir "manifest.json") -PathType Leaf)) {
  $wantCompanion = Read-Host "是否现在启用 ChatGPT 网页生图伴侣？输入 YES 后会打开 Chrome 扩展页和已准备好的扩展文件夹"
  if ($wantCompanion -eq "YES") {
    Start-Process explorer.exe -ArgumentList ('"' + $CompanionDir + '"')
    Start-Process $chrome -ArgumentList "chrome://extensions"
    Write-Host "请在扩展页打开“开发者模式”，点“加载已解压的扩展程序”，选择刚打开的文件夹。"
    Write-Host "这一步会改变浏览器配置，必须由你亲自点击确认；工作台不会读取或复制登录信息。"
  }
}

$python = Find-Python
$smartConfig = Join-Path $ConfigRoot "modules\smart_editing_runtime.json"
$smartReady = $false
$socialAsrReady = $false
$captionPython = ""
if (Test-Path $smartConfig -PathType Leaf) {
  try {
    $smart = Get-Content -Raw -LiteralPath $smartConfig -Encoding UTF8 | ConvertFrom-Json
    $smartReady = ($smart.caption_model_status -eq "ready" -and (Test-Path $smart.caption_python -PathType Leaf))
    $captionPython = [string]$smart.caption_python
    $socialAsrReady = ($smart.social_asr_model_status -eq "ready" -and (Test-Path $captionPython -PathType Leaf))
  } catch { $smartReady = $false }
}
if ((-not $smartReady -or -not $socialAsrReady) -and $python) {
  Write-Host ""
  $caption = Read-Host "精确字幕和社媒无字幕口播转写首次合计约需 1.8GB 本地模型。输入 YES 立即准备，直接回车稍后处理"
  if ($caption -eq "YES") {
    if (-not $smartReady -and (Test-Path $SmartSetup -PathType Leaf)) {
      $venv = Join-Path $ToolsRoot "runtime\caption-alignment-v1"
      $setupOutput = Join-Path $LogsRoot "caption_alignment_setup_$Timestamp"
      & $python $SmartSetup --python $python --venv $venv --config $smartConfig --output-dir $setupOutput --confirm-install YES --prepare-chinese-model
    }
    if (Test-Path $smartConfig -PathType Leaf) {
      try {
        $smart = Get-Content -Raw -LiteralPath $smartConfig -Encoding UTF8 | ConvertFrom-Json
        $captionPython = [string]$smart.caption_python
        $socialAsrReady = ($smart.social_asr_model_status -eq "ready" -and (Test-Path $captionPython -PathType Leaf))
      } catch { $captionPython = "" }
    }
    if (-not $socialAsrReady -and $captionPython -and (Test-Path $SocialAsrSetup -PathType Leaf)) {
      $socialOutput = Join-Path $LogsRoot "social_asr_setup_$Timestamp"
      & $captionPython $SocialAsrSetup --python $captionPython --config $smartConfig --output-dir $socialOutput --confirm-install YES --model small
    }
  }
}
if (Test-Path $smartConfig -PathType Leaf) {
  try {
    $smart = Get-Content -Raw -LiteralPath $smartConfig -Encoding UTF8 | ConvertFrom-Json
    $captionPython = [string]$smart.caption_python
    if ($smart.social_asr_model_status -eq "ready" -and (Test-Path $captionPython -PathType Leaf)) {
      Set-ConfigValue "SOCIAL_COPY_ASR_PYTHON" $captionPython
      Set-ConfigValue "SOCIAL_COPY_ASR_BACKEND" "faster_whisper"
      Set-ConfigValue "SOCIAL_COPY_ASR_MODEL" ([string]$smart.social_asr_model)
    }
  } catch { }
}

if ($python -and (Test-Path $StatusScript -PathType Leaf) -and (Test-Path $Registry -PathType Leaf)) {
  & $python $StatusScript --workbench $WorkbenchRoot --skills-home $CodexSkills --registry $Registry --json-output $StatusOutput
}

$OpenWorkbench = Join-Path $WebRoot "service\windows\open-workbench.ps1"
if (Test-Path $OpenWorkbench -PathType Leaf) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $OpenWorkbench -WebRoot $WebRoot -WorkbenchRoot $WorkbenchRoot
}

Write-Host ""
Write-Host "本轮全量配置已结束。未使用的扩展功能可以保持“待配置”，不影响已配好的功能。" -ForegroundColor Green
Write-Host "工作台已打开；详细检查结果已保存在系统日志中。"
