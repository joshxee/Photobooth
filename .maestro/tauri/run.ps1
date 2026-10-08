<#
.SYNOPSIS
  Runs the Tauri Maestro flows against a connected Android device, one clean app start per flow.

.DESCRIPTION
  Each flow starts from a fresh app (data cleared, so settings.json and permission grants reset)
  that THIS SCRIPT launches over adb; the flows then attach with `launchApp: stopApp: false`.
  Starting the app from adb rather than from Maestro matters on Xiaomi MIUI/HyperOS, which refuses
  to let Maestro's driver app start activities from the background ("Abort background activity
  starts"). Allowing "Display pop-up windows while running in the background" for dev.mobile.maestro
  also fixes that, but the permission is hidden for an app with no launcher icon.

  Needs `adb` and `maestro` on PATH (and JAVA_HOME for maestro). Debug build only: the application id
  is com.jc.photobooth.tauri, which is a different app from the Kotlin booth.

.EXAMPLE
  .maestro\tauri\run.ps1                                  # all flows
  .maestro\tauri\run.ps1 -Flow full_session,back_button   # a subset
#>
param(
  [string[]]$Flow,
  [string]$Device,
  [string]$OutDir = (Join-Path $env:TEMP "maestro-tauri")
)
$ErrorActionPreference = "Continue"
$app = "com.jc.photobooth.tauri"
$activity = "$app/com.jc.photobooth.MainActivity"
$dir = $PSScriptRoot
$adb = if ($Device) { @("-s", $Device) } else { @() }
$mArgs = if ($Device) { @("--device", $Device) } else { @() }

$flows = if ($Flow) { $Flow | ForEach-Object { Join-Path $dir (($_ -replace "\.yaml$", "") + ".yaml") } }
         else { Get-ChildItem $dir -Filter *.yaml | Sort-Object Name | ForEach-Object FullName }

$failed = @()
foreach ($f in $flows) {
  $name = [IO.Path]::GetFileNameWithoutExtension($f)
  Write-Host "=== $name"
  & adb @adb shell pm clear $app | Out-Null
  & adb @adb shell input keyevent KEYCODE_WAKEUP
  & adb @adb shell am start -n $activity | Out-Null
  Start-Sleep -Seconds 3
  & adb @adb shell am force-stop dev.mobile.maestro.orchestra 2>$null
  & adb @adb forward tcp:7001 tcp:7001 | Out-Null
  & maestro @mArgs test $f --test-output-dir (Join-Path $OutDir $name) 2>&1 | Out-Host
  if ($LASTEXITCODE -ne 0) { $failed += $name }
}

if ($failed) { Write-Host "FAILED: $($failed -join ', ')"; exit 1 }
Write-Host "all flows passed"
