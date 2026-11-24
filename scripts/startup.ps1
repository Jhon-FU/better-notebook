# Shared identity and startup probes. Importing this file has no side effects.
function Get-NotebookBuildId {
  param([Parameter(Mandatory = $true)][string]$Root)
  $files = @('notebook.html', 'icon.ico', 'package.json', 'launcher.ps1', 'server.ps1') |
    ForEach-Object { Join-Path $Root $_ }
  foreach ($folder in @('scripts', 'src')) {
    $files += Get-ChildItem -LiteralPath (Join-Path $Root $folder) -Recurse -File |
      Where-Object { $_.Extension -in @('.ps1', '.js', '.css') } | ForEach-Object { $_.FullName }
  }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $manifest = foreach ($file in ($files | Sort-Object)) {
      $relative = $file.Substring($Root.Length).Replace('\', '/')
      $hash = [BitConverter]::ToString($sha.ComputeHash([System.IO.File]::ReadAllBytes($file)))
      $relative + ':' + $hash
    }
    return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($manifest -join "`n")))).Replace('-', '').ToLowerInvariant()
  } finally { $sha.Dispose() }
}

function Get-NotebookServiceState {
  param([int]$Port, [string]$Root, [string]$Build, [int]$TimeoutMilliseconds = 1000)
  # A short HTTP timeout alone cannot distinguish a refused connection from an
  # accepted connection whose service never sends HTTP. Probe that distinction.
  $socket = [System.Net.Sockets.TcpClient]::new()
  try {
    if (-not $socket.ConnectAsync('127.0.0.1', $Port).Wait([Math]::Min(500, $TimeoutMilliseconds))) {
      return @{ State = 'absent'; Reason = 'no connection accepted' }
    }
  } catch {
    return @{ State = 'absent'; Reason = 'connection refused' }
  } finally { $socket.Close() }
  $response = $null
  try {
    $request = [System.Net.HttpWebRequest]::Create('http://127.0.0.1:' + $Port + '/health')
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = $TimeoutMilliseconds
    $request.ReadWriteTimeout = $TimeoutMilliseconds
    $response = $request.GetResponse()
    if ([int]$response.StatusCode -ne 200) { throw 'Unexpected HTTP status' }
    $reader = [System.IO.StreamReader]::new($response.GetResponseStream(), [Text.Encoding]::UTF8)
    try {
      $buffer = New-Object char[] 8193
      $count = $reader.ReadBlock($buffer, 0, $buffer.Length)
      if ($count -eq 0 -or $count -gt 8192) { throw 'Invalid health response length' }
      $health = (-join $buffer[0..($count - 1)]) | ConvertFrom-Json
    } finally { $reader.Dispose() }
    if ($health.app -cne 'better-notebook' -or $health.protocol -ne 1) {
      return @{ State = 'incompatible'; Reason = 'unrecognized service' }
    }
    if ($health.root -ine $Root -or $health.dataDirectory -ine $Root) {
      return @{ State = 'incompatible'; Reason = 'another notebook directory' }
    }
    if ($health.build -cne $Build) {
      return @{ State = 'incompatible'; Reason = 'outdated notebook service' }
    }
    return @{ State = 'ready'; Reason = '' }
  } catch [System.Net.WebException] {
    if ($_.Exception.Status -eq [System.Net.WebExceptionStatus]::ConnectFailure) {
      return @{ State = 'absent'; Reason = 'connection refused' }
    }
    return @{ State = 'incompatible'; Reason = 'health check failed or timed out' }
  } catch {
    return @{ State = 'incompatible'; Reason = 'invalid health response' }
  } finally {
    if ($null -ne $response) { $response.Close() }
  }
}
