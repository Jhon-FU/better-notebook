param(
  [ValidateRange(1, 65535)][int]$Port = 8712,
  [string]$DataDirectory = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'storage.ps1')
. (Join-Path $PSScriptRoot 'startup.ps1')
if (-not $DataDirectory) { $DataDirectory = $root }
$DataDirectory = [System.IO.Path]::GetFullPath($DataDirectory)
if (-not [System.IO.Directory]::Exists($DataDirectory)) { throw 'Notebook data directory does not exist.' }
$health = @{
  app = 'better-notebook'; protocol = 1; root = $root; dataDirectory = $DataDirectory; pid = $PID
  build = Get-NotebookBuildId -Root $root
} | ConvertTo-Json -Compress
$notesPath = Join-Path $DataDirectory 'notes.json'
$staticFiles = @{
  '/' = @('notebook.html', 'text/html; charset=utf-8')
  '/notebook.html' = @('notebook.html', 'text/html; charset=utf-8')
  '/index.html' = @('notebook.html', 'text/html; charset=utf-8')
  '/src/styles/notebook.css' = @('src/styles/notebook.css', 'text/css; charset=utf-8')
  '/src/js/app.js' = @('src/js/app.js', 'text/javascript; charset=utf-8')
  '/src/js/editor-sync.js' = @('src/js/editor-sync.js', 'text/javascript; charset=utf-8')
  '/src/js/history.js' = @('src/js/history.js', 'text/javascript; charset=utf-8')
  '/src/js/note-format.js' = @('src/js/note-format.js', 'text/javascript; charset=utf-8')
  '/src/js/recovery.js' = @('src/js/recovery.js', 'text/javascript; charset=utf-8')
  '/icon.ico' = @('icon.ico', 'image/x-icon')
  '/favicon.ico' = @('icon.ico', 'image/x-icon')
}
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)

try {
  $listener.Start()
} catch {
  Write-Error "Notebook server could not bind to port $Port." -ErrorAction Continue
  exit 1
}

$utf8 = New-Object System.Text.UTF8Encoding($false)

function Send-Response($stream, [int]$status, [string]$contentType, [byte[]]$body) {
  $head = "HTTP/1.1 $status`r`nContent-Type: $contentType`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
  $headBytes = [System.Text.Encoding]::ASCII.GetBytes($head)
  $stream.Write($headBytes, 0, $headBytes.Length)
  $stream.Write($body, 0, $body.Length)
  $stream.Flush()
}

function Send-Text($stream, [int]$status, [string]$contentType, [string]$text) {
  Send-Response $stream $status $contentType ($utf8.GetBytes($text))
}

while ($true) {
  try {
    $client = $listener.AcceptTcpClient()
  } catch {
    continue
  }
  try {
    $stream = $client.GetStream()
    $stream.ReadTimeout = 8000
    $received = New-Object System.Collections.Generic.List[byte]
    $buf = New-Object byte[] 16384
    $headText = ''
    $headerEnd = -1

    while ($true) {
      $n = $stream.Read($buf, 0, $buf.Length)
      if ($n -le 0) { break }
      for ($i = 0; $i -lt $n; $i++) { $received.Add($buf[$i]) }
      $headText = [System.Text.Encoding]::ASCII.GetString($received.ToArray())
      $headerEnd = $headText.IndexOf("`r`n`r`n")
      if ($headerEnd -ge 0) { break }
      if ($received.Count -gt 262144) { break }
    }

    if ($headerEnd -lt 0) { $client.Close(); continue }

    $head = $headText.Substring(0, $headerEnd)
    $firstLine = ($head -split "`r`n")[0]
    $parts = $firstLine -split ' '
    $method = ''
    $path = ''
    if ($parts.Count -ge 2) { $method = $parts[0]; $path = $parts[1] }

    $contentLength = 0
    foreach ($line in ($head -split "`r`n")) {
      if ($line -match '^Content-Length:\s*(\d+)') { $contentLength = [int]$matches[1] }
    }

    $needed = $headerEnd + 4 + $contentLength
    while ($received.Count -lt $needed) {
      $n = $stream.Read($buf, 0, $buf.Length)
      if ($n -le 0) { break }
      for ($i = 0; $i -lt $n; $i++) { $received.Add($buf[$i]) }
    }

    $body = ''
    if ($received.Count -lt $needed) {
      Send-Text $stream 400 'application/json' '{"error":"incomplete body"}'
      continue
    }
    if ($contentLength -gt 0) {
      $bodyBytes = New-Object byte[] $contentLength
      $all = $received.ToArray()
      [Array]::Copy($all, ($headerEnd + 4), $bodyBytes, 0, $contentLength)
      $body = $utf8.GetString($bodyBytes)
    }

    if ($path -eq '/health' -and $method -eq 'GET') {
      Send-Text $stream 200 'application/json; charset=utf-8' $health
    } elseif ($staticFiles.ContainsKey($path) -and $method -eq 'GET') {
      $asset = $staticFiles[$path]
      $assetPath = Join-Path $root $asset[0]
      if (Test-Path -LiteralPath $assetPath) {
        Send-Response $stream 200 $asset[1] ([System.IO.File]::ReadAllBytes($assetPath))
      } else {
        Send-Text $stream 404 'text/plain; charset=utf-8' 'asset not found'
      }
    } elseif ($path -eq '/notes.json' -and $method -eq 'GET') {
      if (Test-Path $notesPath) {
        Send-Text $stream 200 'application/json; charset=utf-8' ([System.IO.File]::ReadAllText($notesPath, $utf8))
      } else {
        Send-Text $stream 404 'application/json' '{}'
      }
    } elseif ($path -eq '/notes.json' -and ($method -eq 'POST' -or $method -eq 'PUT')) {
      try {
        $parsed = $body | ConvertFrom-Json
        if ($null -eq $parsed -or $parsed.version -ne 1 -or $parsed.items -isnot [System.Array]) { throw 'Invalid notebook' }
      } catch {
        Send-Text $stream 400 'application/json' '{"error":"bad json"}'
        $client.Close()
        continue
      }
      try {
        Write-NotebookAtomically -Path $notesPath -Content $body
        Send-Text $stream 200 'application/json' '{"ok":true}'
      } catch {
        Send-Text $stream 500 'application/json' '{"error":"notebook write failed; original file preserved"}'
      }
    } else {
      Send-Text $stream 404 'text/plain; charset=utf-8' 'not found'
    }
  } catch {
    # Ignore individual request errors and keep serving.
  } finally {
    try { $client.Close() } catch {}
  }
}
