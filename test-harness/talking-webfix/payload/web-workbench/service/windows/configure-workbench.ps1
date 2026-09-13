param(
  [Parameter(Mandatory = $true)][string]$WorkbenchRoot
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$configPath = Join-Path $WorkbenchRoot "系统文件_无需打开\config\customer_config.env"
if (-not (Test-Path $configPath -PathType Leaf)) {
  throw "尚未找到工作台配置文件，请先完成安装。"
}

function Read-SecretValue {
  param([string]$Label)
  $suffix = "（只有使用该功能时需要；已配置或暂不使用可直接回车）"
  Write-Host ""
  Write-Host "$Label$suffix"
  $secure = Read-Host "请粘贴，输入时不显示内容" -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Set-EnvValue {
  param([string]$Key, [string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return }
  $content = Get-Content -Raw -LiteralPath $configPath -Encoding UTF8
  $safeValue = $Value.Replace("`r", "").Replace("`n", "")
  $pattern = "(?m)^" + [regex]::Escape($Key) + "=.*$"
  if ($content -match $pattern) {
    $content = [regex]::Replace($content, $pattern, "$Key=$safeValue")
  } else {
    $content = $content.TrimEnd() + "`r`n$Key=$safeValue`r`n"
  }
  Set-Content -LiteralPath $configPath -Value $content -Encoding UTF8
}

function Read-PlainValue {
  param([string]$Label)
  Write-Host ""
  Write-Host "$Label（可选，可直接回车跳过）"
  return Read-Host "请输入"
}

$backupRoot = Join-Path $WorkbenchRoot "系统文件_无需打开\backups\config"
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
$backup = Join-Path $backupRoot ("customer_config_" + (Get-Date -Format "yyyyMMdd_HHmmss") + ".env")
Copy-Item -LiteralPath $configPath -Destination $backup -Force

Write-Host ""
Write-Host "AI 内容工作台｜功能配置" -ForegroundColor Cyan
Write-Host "本向导覆盖当前工作台所有需配置的功能；只填你实际要用的。"
Write-Host "工作流编号已由工作台管理，不需要客户填写或去平台寻找。"
Write-Host "密钥不会显示在屏幕上，也不要发到聊天里。"

$runninghub = Read-SecretValue "RunningHub 密钥：AI 口播、唱歌、动作迁移和视频生成"
Set-EnvValue "RUNNINGHUB_API_KEY" $runninghub

$ark = Read-SecretValue "火山方舟密钥：爆款重构的参考视频拆解"
Set-EnvValue "VOLCENGINE_ARK_API_KEY" $ark

$tikhub = Read-SecretValue "TikHub 密钥：爆款提取和社媒公开链接读取"
Set-EnvValue "TIKHUB_API_KEY" $tikhub

$optional = Read-Host "是否继续配置扩展功能（素材库、产品锁定、复核和可灵）？输入 YES 继续，直接回车跳过"
if ($optional -eq "YES") {
  $pexels = Read-SecretValue "Pexels 密钥：智能剪辑素材搜索"
  Set-EnvValue "PEXELS_API_KEY" $pexels

  $dashscope = Read-SecretValue "DashScope 密钥：严格产品锁定 Live 图"
  Set-EnvValue "DASHSCOPE_API_KEY" $dashscope

  $gemini = Read-SecretValue "Gemini 密钥：图文复刻或争议片段复核"
  Set-EnvValue "GEMINI_API_KEY" $gemini

  $kling = Read-SecretValue "可灵密钥：明确选择可灵视频生成通道时"
  Set-EnvValue "KLINGAI_API_KEY" $kling
}

$advanced = Read-Host "是否配置飞书任务和结果回传？输入 YES 继续，直接回车跳过"
if ($advanced -eq "YES") {
  $feishuAppId = Read-PlainValue "飞书 App ID"
  Set-EnvValue "FEISHU_APP_ID" $feishuAppId
  $feishuSecret = Read-SecretValue "飞书 App Secret"
  Set-EnvValue "FEISHU_APP_SECRET" $feishuSecret
  $feishuBase = Read-PlainValue "飞书多维表格 Base Token"
  Set-EnvValue "FEISHU_BASE_TOKEN" $feishuBase
  $feishuTable = Read-PlainValue "飞书多维表格 Table ID"
  Set-EnvValue "FEISHU_TABLE_ID" $feishuTable
}

Write-Host ""
Write-Host "配置已保存。" -ForegroundColor Green
Write-Host "已自动备份修改前配置；网页工作台重新启动后生效。"
Write-Host "LibTV 登录、ChatGPT 登录/网页伴侣、字幕模型和本地工具由“03_完成全部配置”继续处理。"
Write-Host "社媒无字幕口播转文字也会在同一入口自动准备，不需要自己填写 Python 路径。"
