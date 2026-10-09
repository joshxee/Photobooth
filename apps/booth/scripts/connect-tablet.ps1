<#
.SYNOPSIS
  Connects adb to the tablet over Wi-Fi, so the tablet can stay cabled to the camera.

.DESCRIPTION
  The camera takes the tablet's only USB-C port and puts the tablet in USB host mode, so the
  tablet cannot also be an adb device for this PC. Android 11+ "Wireless debugging" gets round
  that: adb talks to the tablet over the LAN instead.

  Once per PC (tablet and PC on the same network):
    Tablet: Settings > Additional settings > Developer options > Wireless debugging: on
            (tick "Always allow on this network"), then tap "Pair device with pairing code".
    PC:     pwsh apps/booth/scripts/connect-tablet.ps1 -Pair 123456

  Every other time, run it with no arguments. adb usually reconnects to a paired tablet by itself;
  the script waits for that, connects by hand if it does not happen, and drops duplicate entries.
  The port changes every time Wireless debugging is turned on, so the script never stores one.

.PARAMETER Pair
  The six-digit code from "Pair device with pairing code". The pairing address is found over
  mDNS; pass -Address too if discovery fails.

.PARAMETER Address
  ip:port to use instead of mDNS discovery: the pairing address with -Pair, otherwise the
  address shown at the top of the Wireless debugging screen.
#>
param(
  [string]$Pair,
  [string]$Address
)

$ErrorActionPreference = "Stop"
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA "Android\Sdk" }
$adb = Join-Path $sdk "platform-tools\adb.exe"
if (-not (Test-Path $adb)) { throw "adb not found at $adb" }

function Get-Devices {
  & $adb devices | Select-Object -Skip 1 | Where-Object { $_ -match "^(\S+)\s+device$" } |
    ForEach-Object { ($_ -split "\s+")[0] }
}

# The tablet's services, as "ip:port", newest first. A service shows up for a few seconds after
# it starts, so poll briefly rather than reading the list once.
function Find-Service([string]$type, [int]$seconds = 10) {
  $deadline = (Get-Date).AddSeconds($seconds)
  do {
    $found = & $adb mdns services | Where-Object { $_ -match [regex]::Escape($type) } |
      ForEach-Object { if ($_ -match "(\d+\.\d+\.\d+\.\d+:\d+)") { $Matches[1] } }
    if ($found) { return @($found) }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  return @()
}

& $adb start-server | Out-Null

if ($Pair) {
  $target = if ($Address) { $Address } else { Find-Service "_adb-tls-pairing._tcp" | Select-Object -First 1 }
  if (-not $target) {
    throw "No pairing service found. Keep the 'Pair device with pairing code' dialog open on the tablet, or pass -Address with the ip:port it shows."
  }
  Write-Host "==> Pairing with $target"
  & $adb pair $target $Pair
  if ($LASTEXITCODE -ne 0) { throw "Pairing failed (wrong or expired code?)." }
  $Address = $null  # the pairing port is not the connect port
}

# adb connects to a paired tablet by itself once mDNS sees it, so give that a moment before
# connecting by hand. Connecting by hand as well would list the tablet twice, and every plain
# `adb` command would then fail with "more than one device".
$deadline = (Get-Date).AddSeconds(10)
while (-not (Get-Devices) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }

if (-not (Get-Devices)) {
  $targets = if ($Address) { @($Address) } else { Find-Service "_adb-tls-connect._tcp" }
  if (-not $targets) {
    throw "Tablet not found over mDNS. Check: Wireless debugging is on, tablet and PC are on the same network, and Windows Firewall allows adb. Or pass -Address with the ip:port from the Wireless debugging screen."
  }
  foreach ($t in $targets) {
    Write-Host "==> Connecting to $t"
    & $adb connect $t | Out-Host
  }
}

# Still listed twice (e.g. a manual connect raced the automatic one)? Keep one entry per device,
# preferring the mDNS name, which survives the port changing.
$seen = @{}
foreach ($d in (Get-Devices | Sort-Object { $_ -notmatch "_adb-tls-connect" })) {
  $serial = (& $adb -s $d shell getprop ro.serialno).Trim()
  if ($seen.ContainsKey($serial)) { & $adb disconnect $d | Out-Null } else { $seen[$serial] = $d }
}

$devices = @(Get-Devices)
if ($devices.Count -eq 0) { throw "adb connect did not produce a device. Has this PC been paired? Run with -Pair <code>." }
Write-Host "==> Connected: $($devices -join ', ')"
