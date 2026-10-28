<#
  launch-edge.ps1 — start Edge/Chrome with a CDP port while keeping your login state.

  Chrome 136+ refuses --remote-debugging-port when --user-data-dir is the real
  profile directory, so we point it at a directory junction instead.

  Run: powershell -ExecutionPolicy Bypass -File scripts\launch-edge.ps1
#>
param(
  [int]$Port = 9222,
  [ValidateSet('edge', 'chrome')]
  [string]$Browser = 'edge',
  [string]$Profile = 'Default',
  [string]$StartUrl = 'https://stu.oneclass.cn/plan/index'
)

$ErrorActionPreference = 'Stop'

if ($Browser -eq 'edge') {
  $exe = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  $real = Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data'
  $link = 'C:\edgeLink'
  $proc = 'msedge'
} else {
  $exe = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
  $real = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
  $link = 'C:\chromeLink'
  $proc = 'chrome'
}

if (-not (Test-Path $exe)) { throw "browser not found: $exe" }
if (-not (Test-Path $real)) { throw "profile dir not found: $real" }

if (-not (Test-Path $link)) {
  Write-Host "creating junction $link -> $real"
  New-Item -ItemType Junction -Path $link -Target $real | Out-Null
}

# an already running browser would swallow the flags, so stop it first
Get-Process -Name $proc -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800

$args = @(
  "--user-data-dir=$link",
  "--profile-directory=$Profile",
  "--remote-debugging-port=$Port",
  '--no-first-run',
  '--no-default-browser-check',
  $StartUrl
)

Start-Process -FilePath $exe -ArgumentList $args
Start-Sleep -Seconds 3

try {
  $tabs = Invoke-RestMethod "http://127.0.0.1:$Port/json/list"
  Write-Host "CDP ready on port $Port — $($tabs.Count) targets"
  $tabs | Where-Object { $_.type -eq 'page' } | Select-Object title, url | Format-Table -AutoSize
} catch {
  throw "CDP port $Port not answering — the profile is probably still locked or the browser ignored the flag"
}
