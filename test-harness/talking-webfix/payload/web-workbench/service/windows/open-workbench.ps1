param(
  [Parameter(Mandatory = $true)][string]$WebRoot,
  [Parameter(Mandatory = $true)][string]$WorkbenchRoot,
  [int]$WaitSeconds = 90
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Test-LocalPort {
  param([int]$Port)
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $result = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    $ok = $result.AsyncWaitHandle.WaitOne(500) -and $client.Connected
    $client.Close()
    return $ok
  } catch { return $false }
}

Write-Host ""
Write-Host "正在打开 AI 内容工作台……" -ForegroundColor Cyan

$startScript = Join-Path $WebRoot "service\windows\start-services.ps1"
if (-not (Test-Path $startScript -PathType Leaf)) {
  throw "工作台启动程序缺失，请重新运行安装或升级。"
}

& $startScript -WebRoot $WebRoot -WorkbenchRoot $WorkbenchRoot

$deadline = (Get-Date).AddSeconds($WaitSeconds)
do {
  if ((Test-LocalPort 4318) -and (Test-LocalPort 3000)) {
    Start-Process "http://127.0.0.1:3000"
    Write-Host "工作台已在浏览器打开。" -ForegroundColor Green
    exit 0
  }
  Start-Sleep -Milliseconds 800
} while ((Get-Date) -lt $deadline)

$logRoot = Join-Path $WorkbenchRoot "系统文件_无需打开\logs\web-workbench"
Write-Host "工作台未能在 $WaitSeconds 秒内启动。" -ForegroundColor Yellow
Write-Host "项目、素材和成果没有被删除或覆盖。"
Write-Host "请把此窗口最后一页截图发给服务人员。运行记录位于：$logRoot"
exit 2
