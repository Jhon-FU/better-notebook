param([ValidateRange(1, 65535)][int]$Port = 8712)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$url = 'http://127.0.0.1:' + $port + '/notebook.html'

$edgeCandidates = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
)
$edge = $null
foreach ($c in $edgeCandidates) {
  if (Test-Path $c) { $edge = $c; break }
}
if (-not $edge) { $edge = (Get-Command msedge -ErrorAction SilentlyContinue).Source }
if (-not $edge) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show('No Edge or Chrome browser found.', 'Lingdong Notes')
  exit 1
}

$running = $false
try {
  $t = [System.Net.Sockets.TcpClient]::new('127.0.0.1', $port)
  $t.Close()
  $running = $true
} catch {}

if (-not $running) {
  $serverPath = Join-Path $PSScriptRoot 'server.ps1'
  Start-Process -WindowStyle Hidden -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $serverPath + '"'),'-Port',$port)
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 200
    try {
      $t = [System.Net.Sockets.TcpClient]::new('127.0.0.1', $port)
      $t.Close()
      $running = $true
      break
    } catch {}
  }
}

if (-not $running) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show('The local notebook server could not start.', 'Lingdong Notes')
  exit 1
}

$profileDir = Join-Path $root 'profile'
Start-Process -FilePath $edge -ArgumentList @('--no-first-run','--no-default-browser-check',('--user-data-dir="' + $profileDir + '"'),('--app=' + $url))
