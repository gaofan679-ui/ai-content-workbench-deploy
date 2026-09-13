param(
  [Parameter(Mandatory = $true)][string]$WebRoot
)

$ErrorActionPreference = "Stop"

function Get-ListeningProcessIds {
  param([int]$Port)
  $ids = @()
  try {
    $ids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
      Select-Object -ExpandProperty OwningProcess -Unique)
  } catch {
    foreach ($line in @(& netstat.exe -ano -p tcp)) {
      if ($line -match "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$") {
        $ids += [int]$Matches[1]
      }
    }
  }
  return @($ids | Sort-Object -Unique)
}

function Stop-ManagedListener {
  param([int]$Port, [string]$ExpectedCommandFragment)
  foreach ($processId in @(Get-ListeningProcessIds -Port $Port)) {
    if ($processId -eq $PID) { continue }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
    if (-not $process) {
      throw "无法确认本地端口 $Port 的占用程序，已安全停止升级。"
    }
    $name = [string]$process.Name
    $commandLine = [string]$process.CommandLine
    $isNode = $name -match '^node(?:\.exe)?$'
    $isManaged = $commandLine.IndexOf($ExpectedCommandFragment, [StringComparison]::OrdinalIgnoreCase) -ge 0
    if (-not $isNode -or -not $isManaged) {
      throw "本地端口 $Port 被其他程序占用，未结束该程序，已安全停止升级。"
    }
    Stop-Process -Id $processId -Force -ErrorAction Stop
  }
}

Stop-ManagedListener -Port 4318 -ExpectedCommandFragment "runtime/server.mjs"
Stop-ManagedListener -Port 3000 -ExpectedCommandFragment "node_modules/vinext/dist/cli.js"

$deadline = (Get-Date).AddSeconds(15)
do {
  $remaining = @()
  $remaining += @(Get-ListeningProcessIds -Port 4318)
  $remaining += @(Get-ListeningProcessIds -Port 3000)
  $remaining = @($remaining | Where-Object { $null -ne $_ } | Sort-Object -Unique)
  if ($remaining.Count -eq 0) {
    Write-Host "旧版网页工作台常驻服务已安全停止。"
    exit 0
  }
  Start-Sleep -Milliseconds 300
} while ((Get-Date) -lt $deadline)

throw "旧版网页工作台常驻服务未在限定时间内退出，已安全停止升级。"
