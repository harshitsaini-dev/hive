<#
  Background dev-server control for Hive.

  start.bat / stop.bat / restart.bat are thin wrappers around this. The real
  work lives here because quoting non-trivial PowerShell inside a .bat file is
  its own category of bug.

  Logs and PID files go to .logs\ (gitignored).
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet('start', 'stop', 'restart', 'status')]
  [string] $Action
)

$ErrorActionPreference = 'Stop'

$Root    = Split-Path -Parent $PSScriptRoot
$LogDir  = Join-Path $Root '.logs'

# npm on Windows is npm.cmd. Start-Process cannot launch the extensionless
# shim — it fails with "not a valid Win32 application".
$Npm = 'npm.cmd'

$Services = @(
  @{ Name = 'server'; Script = 'dev:server'; Url = 'https://localhost:3000/health'; Label = 'API'; Shown = 'https://localhost:3000' }
  @{ Name = 'web';    Script = 'dev:web';    Url = 'https://localhost:5173';       Label = 'Web'; Shown = 'https://localhost:5173' }
)

function Get-PidFile([string] $Name) { Join-Path $LogDir "$Name.pid" }

function Get-RunningPid([string] $Name) {
  $file = Get-PidFile $Name
  if (-not (Test-Path $file)) { return $null }

  $recorded = (Get-Content $file -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not $recorded) { return $null }

  $process = Get-Process -Id ([int] $recorded) -ErrorAction SilentlyContinue
  if (-not $process) {
    # Stale file — the process died without cleaning up.
    Remove-Item $file -ErrorAction SilentlyContinue
    return $null
  }

  return [int] $recorded
}

function Wait-ForUrl([string] $Url, [int] $TimeoutSeconds = 25) {
  # curl.exe rather than Invoke-WebRequest.
  #
  # Windows PowerShell 5.1 runs on .NET Framework, which cannot negotiate
  # TLS 1.3. The server offers it and the handshake dies with a thoroughly
  # misleading "the underlying connection was closed" — the server is fine.
  # curl.exe ships with Windows 10+, speaks modern TLS, and -k sidesteps the
  # question of whether the local CA has been trusted yet.
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

  while ((Get-Date) -lt $deadline) {
    $code = & curl.exe -s -k -o NUL -w '%{http_code}' --max-time 2 $Url 2>$null
    if ($code -eq '200') { return $true }
    Start-Sleep -Milliseconds 600
  }

  return $false
}

function Stop-Hive {
  $stoppedAny = $false

  foreach ($service in $Services) {
    $processId = Get-RunningPid $service.Name
    if ($processId) {
      Write-Host "  stopping $($service.Name) (PID $processId)"
      # /T because npm spawns node as a child; killing only the recorded PID
      # leaves the real server holding the port.
      & taskkill /PID $processId /T /F *> $null
      Remove-Item (Get-PidFile $service.Name) -ErrorAction SilentlyContinue
      $stoppedAny = $true
    }
  }

  # taskkill /T does not reliably reach grandchildren once an intermediate
  # process has already exited, which leaves node holding the port while the
  # PID files say nothing is running. Sweep by port as well.
  #
  # Only processes whose command line points at THIS repository are killed —
  # an unrelated dev server that happens to use port 3000 is reported, not
  # terminated.
  foreach ($port in 3000, 5173) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if (-not $conn) { continue }

    $owner = $conn.OwningProcess | Select-Object -First 1
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction SilentlyContinue
    if (-not $proc) { continue }

    if ($proc.CommandLine -and $proc.CommandLine.Replace('/', '\') -like "*$Root*") {
      Write-Host "  stopping orphan on port $port (PID $owner)"
      & taskkill /PID $owner /T /F *> $null
      $stoppedAny = $true
    } else {
      Write-Host "  port $port held by $($proc.Name) (PID $owner) - not ours, left alone" -ForegroundColor Yellow
    }
  }

  if (-not $stoppedAny) { Write-Host '  nothing was running' -ForegroundColor DarkGray }
}

function Start-Hive {
  $already = $Services | Where-Object { Get-RunningPid $_.Name }
  if ($already) {
    Write-Host "Hive is already running ($($already.Name -join ', '))." -ForegroundColor Yellow
    Write-Host 'Use restart.bat to restart, or stop.bat to stop.'
    return 1
  }

  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

  if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
    Write-Host 'Installing dependencies...'
    & $Npm install
    if ($LASTEXITCODE -ne 0) { return 1 }
  }

  if (-not (Test-Path (Join-Path $Root 'local.db'))) {
    Write-Host 'Creating the local database...'
    & $Npm run db:migrate
    if ($LASTEXITCODE -ne 0) { return 1 }
  }

  foreach ($service in $Services) {
    Write-Host "Starting $($service.Name)..."
    $process = Start-Process -FilePath $Npm `
      -ArgumentList 'run', $service.Script `
      -WorkingDirectory $Root `
      -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $LogDir "$($service.Name).log") `
      -RedirectStandardError  (Join-Path $LogDir "$($service.Name).err.log") `
      -PassThru

    $process.Id | Out-File -Encoding ascii (Get-PidFile $service.Name)
  }

  Write-Host ''
  $failed = $false

  foreach ($service in $Services) {
    if (Wait-ForUrl $service.Url) {
      Write-Host ("  {0,-4} {1}  ready" -f $service.Label, $service.Shown) -ForegroundColor Green
    } else {
      Write-Host ("  {0,-4} did not come up - see .logs\{1}.err.log" -f $service.Label, $service.Name) -ForegroundColor Red
      $failed = $true
    }
  }

  if ($failed) {
    Write-Host ''
    foreach ($service in $Services) {
      $errLog = Join-Path $LogDir "$($service.Name).err.log"
      if ((Test-Path $errLog) -and (Get-Item $errLog).Length -gt 0) {
        Write-Host "--- $($service.Name).err.log ---" -ForegroundColor DarkGray
        Get-Content $errLog -Tail 15
      }
    }
    return 1
  }

  Write-Host ''
  Write-Host 'Hive is running in the background.'
  Write-Host '  logs     .logs\server.log  and  .logs\web.log'
  Write-Host '  stop     stop.bat'
  Write-Host '  restart  restart.bat'
  Write-Host ''
  Write-Host 'Login codes are printed to .logs\server.log (Resend is not configured yet).' -ForegroundColor DarkGray

  return 0
}

function Get-HiveStatus {
  foreach ($service in $Services) {
    $processId = Get-RunningPid $service.Name
    if ($processId) {
      $reachable = Wait-ForUrl $service.Url 2
      $state = if ($reachable) { 'ready' } else { 'starting or unhealthy' }
      Write-Host ("  {0,-6} PID {1,-7} {2}  {3}" -f $service.Name, $processId, $service.Shown, $state)
    } else {
      Write-Host ("  {0,-6} not running" -f $service.Name) -ForegroundColor DarkGray
    }
  }
}

switch ($Action) {
  'start'   { exit (Start-Hive) }
  'stop'    { Stop-Hive; exit 0 }
  'status'  { Get-HiveStatus; exit 0 }
  'restart' {
    Stop-Hive
    # A listening port is not released the instant its process dies.
    Start-Sleep -Milliseconds 1200
    exit (Start-Hive)
  }
}
