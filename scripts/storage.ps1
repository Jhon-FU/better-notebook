# Dot-sourced by the local server. All temporary and backup files stay beside
# the notebook, so replacement never falls back to a cross-volume copy.
function Write-NotebookAtomically {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content,
    [ValidateRange(1, 1000)][int]$BackupLimit = 20
  )
  $directory = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($Path))
  $encoding = New-Object System.Text.UTF8Encoding($false)
  if ([System.IO.File]::Exists($Path) -and [System.IO.File]::ReadAllText($Path, $encoding) -ceq $Content) { return }
  $temporary = Join-Path $directory ('notes-' + [guid]::NewGuid().ToString('N') + '.tmp')
  try {
    $bytes = $encoding.GetBytes($Content)
    $file = [System.IO.FileStream]::new($temporary, [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::Write, [System.IO.FileShare]::None, 65536, [System.IO.FileOptions]::WriteThrough)
    try {
      $file.Write($bytes, 0, $bytes.Length)
      $file.Flush($true)
    } finally { $file.Dispose() }

    if ([System.IO.File]::Exists($Path)) {
      $backupDirectory = Join-Path $directory 'backups'
      $null = [System.IO.Directory]::CreateDirectory($backupDirectory)
      $name = 'notes-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffffffZ') + '-' + [guid]::NewGuid().ToString('N') + '.json'
      $backupPath = Join-Path $backupDirectory $name
      # If backup or replacement fails, report failure; never truncate the target.
      [System.IO.File]::Replace($temporary, $Path, $backupPath, $true)
      try {
        $backups = @(Get-ChildItem -LiteralPath $backupDirectory -File |
          Where-Object { $_.Name -cmatch '^notes-\d{8}T\d{13}Z-[0-9a-f]{32}\.json$' } |
          Sort-Object Name -Descending)
        $backups | Select-Object -Skip $BackupLimit | ForEach-Object { Remove-Item -LiteralPath $_.FullName -ErrorAction Stop }
      } catch {
        # Saving succeeded. Failed retention only leaves extra recovery files.
        Write-Warning 'Notebook saved; old backup cleanup failed.'
      }
    } else {
      [System.IO.File]::Move($temporary, $Path)
    }
  } finally {
    if ([System.IO.File]::Exists($temporary)) { [System.IO.File]::Delete($temporary) }
  }
}
