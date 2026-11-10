<#
.SYNOPSIS
    Install dsh-file-explorer into a DeepSeek Harness profile.

.DESCRIPTION
    Links this repository into <profile>/node_modules and adds a loader entry with
    your SSH host and tree root. Restart DSH (or toggle the plugin) afterwards.

.EXAMPLE
    .\install.ps1 -SshHost 203.0.113.10 -SshPort 22 -TreeRoot /srv/data
#>
[CmdletBinding()]
param(
    [string]$ProfileName = "desktop",
    [string]$TreeRoot = "/",
    [string]$SshHost = "",
    [int]$SshPort = 22,
    [string]$SshUser = "root",
    [string]$KeyFile = "$env:USERPROFILE\.ssh\id_rsa",
    [string]$KnownHosts = "$env:USERPROFILE\.ssh\known_hosts",
    [int]$TreePort = 8910,
    [switch]$Copy
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$ProfileName"
if (-not (Test-Path $profileDir)) {
    throw "profile not found: $profileDir"
}
if (-not $SshHost) {
    throw "-SshHost is required, for example -SshHost 10.0.0.5 -SshPort 22 -TreeRoot /srv/data"
}

$nodeModules = Join-Path $profileDir "node_modules"
$scopeDir = Join-Path $nodeModules "@bruce_young"
New-Item -ItemType Directory -Force -Path $scopeDir | Out-Null

$link = Join-Path $scopeDir "dsh-file-explorer"
if (Test-Path $link) {
    $item = Get-Item $link -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        Remove-Item $link -Force
    } else {
        throw "$link already exists as a real directory; move it away first"
    }
}

if ($Copy) {
    Copy-Item -Path $repo -Destination $link -Recurse -Force
    Write-Host "copied package to $link" -ForegroundColor Green
} else {
    New-Item -ItemType Junction -Path $link -Target $repo | Out-Null
    Write-Host "linked $link -> $repo" -ForegroundColor Green
}

function Quote([string]$value) {
    return "'" + ($value -replace "'", "''") + "'"
}

$block = @"
- insert:
    - id: file-explorer
      name: "@bruce_young/dsh-file-explorer"
      config:
        treeRoot: $(Quote $TreeRoot)
        treePort: $TreePort
        ssh:
          host: $(Quote $SshHost)
          port: $SshPort
          user: $(Quote $SshUser)
          keyFile: $(Quote $KeyFile)
          knownHosts: $(Quote $KnownHosts)
"@

$patchFile = Join-Path $profileDir "cordis.patch.yml"
$patch = if (Test-Path $patchFile) { Get-Content $patchFile -Raw } else { "" }
if ($patch -match 'dsh-file-explorer') {
    Write-Host "loader entry already present in $patchFile" -ForegroundColor Yellow
} else {
    if ($patch -and -not $patch.EndsWith("`n")) { $patch += "`n" }
    Set-Content -Path $patchFile -Value ($patch + "`n" + $block + "`n") -Encoding UTF8
    Write-Host "added loader entry to $patchFile" -ForegroundColor Green
}

Write-Host ""
Write-Host "Done. Next steps:" -ForegroundColor Cyan
Write-Host "  1. restart DeepSeek Harness (or disable/enable the plugin entry)"
Write-Host "  2. open the left rail 'Files' entry, or right sidebar + -> 'Files'"
Write-Host "  3. tree starts at $TreeRoot on ${SshUser}@${SshHost}:${SshPort}"
