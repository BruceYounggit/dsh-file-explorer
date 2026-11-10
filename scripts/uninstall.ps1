<#
.SYNOPSIS
    Remove dsh-file-explorer from a DeepSeek Harness profile.
.EXAMPLE
    .\uninstall.ps1
#>
[CmdletBinding()]
param(
    [string]$ProfileName = "desktop"
)

$ErrorActionPreference = "Stop"

$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$ProfileName"
if (-not (Test-Path $profileDir)) {
    throw "profile not found: $profileDir"
}

$link = Join-Path $profileDir "node_modules\@bruce_young\dsh-file-explorer"
if (Test-Path $link) {
    Remove-Item $link -Force
    Write-Host "removed $link" -ForegroundColor Green
}

$patchFile = Join-Path $profileDir "cordis.patch.yml"
if (Test-Path $patchFile) {
    $text = Get-Content $patchFile -Raw
    $pattern = "(?ms)^- insert:\r?\n\s+- id: file-explorer\r?\n.*?(?=^- |\z)"
    if ($text -match $pattern) {
        $text = [regex]::Replace($text, $pattern, "")
        $text = $text.TrimEnd() + "`n"
        Set-Content -Path $patchFile -Value $text -Encoding UTF8
        Write-Host "removed the loader entry from $patchFile" -ForegroundColor Green
    } else {
        Write-Host "no file-explorer entry found in $patchFile" -ForegroundColor Yellow
    }
}

Write-Host "Restart DeepSeek Harness to unload the plugin."
