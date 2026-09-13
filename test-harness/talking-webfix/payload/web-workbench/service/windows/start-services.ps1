param(
  [Parameter(Mandatory = $true)][string]$WebRoot,
  [Parameter(Mandatory = $true)][string]$WorkbenchRoot
)

$ErrorActionPreference = "Stop"
$node = (Get-Command node.exe -ErrorAction SilentlyContinue)
if (-not $node) { $node = (Get-Command node -ErrorAction Stop) }
$env:AI_WORKBENCH_HOME = $WorkbenchRoot
$logRoot = Join-Path $WorkbenchRoot "系统文件_无需打开\logs\web-workbench"
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

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

if (-not (Test-LocalPort 4318)) {
  Start-Process -FilePath $node.Source -ArgumentList @("runtime/server.mjs") -WorkingDirectory $WebRoot -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logRoot "runtime-out.log") `
    -RedirectStandardError (Join-Path $logRoot "runtime-error.log")
}
if (-not (Test-LocalPort 3000)) {
  Start-Process -FilePath $node.Source -ArgumentList @("node_modules/vinext/dist/cli.js", "start", "--host", "127.0.0.1", "--port", "3000") -WorkingDirectory $WebRoot -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logRoot "web-out.log") `
    -RedirectStandardError (Join-Path $logRoot "web-error.log")
}
