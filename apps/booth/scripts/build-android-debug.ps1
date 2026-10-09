<#
.SYNOPSIS
  Builds the debug APK on Windows WITHOUT needing Developer Mode / symlink rights.

.DESCRIPTION
  `bun x tauri android build` compiles the Rust library, then symlinks it into the Gradle
  project. Windows refuses symlinks unless Developer Mode is on (a system setting this script
  does not touch), so that last step fails. This script runs the CLI anyway (the compile still
  happens), copies the library into jniLibs instead, and runs Gradle with the Rust tasks skipped.

  If you enable Developer Mode (Settings > System > For developers) you do not need this: use
  `bun x tauri android build --apk --debug --ci --target aarch64` directly.

  Note: use `bun x tauri`, not `bun run tauri` / `bun tauri` — `bun run` sets npm_execpath to an
  empty string, which makes the Tauri CLI panic in `android init`.

.PARAMETER NoDev
  Build without the dev capability (no developer panel), i.e. closer to a release build.

.PARAMETER Install
  Install on the connected device afterwards (adb install -r).
#>
param(
  [switch]$NoDev,
  [switch]$Install
)

$ErrorActionPreference = "Stop"
$booth = Resolve-Path (Join-Path $PSScriptRoot "..")
$repo = Resolve-Path (Join-Path $booth "..\..")
$android = Join-Path $booth "src-tauri\gen\android"

$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA "Android\Sdk" }
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
if (-not $env:NDK_HOME) {
  $ndk = Get-ChildItem (Join-Path $sdk "ndk") | Sort-Object Name | Select-Object -Last 1
  $env:NDK_HOME = $ndk.FullName
}
if (-not $env:JAVA_HOME) {
  $jbr = Get-ChildItem "C:\Program Files\JetBrains" -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName "jbr" } | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($jbr) { $env:JAVA_HOME = $jbr } else { throw "Set JAVA_HOME to a JDK 17+." }
}
$env:PATH = "$sdk\platform-tools;$env:PATH"

Push-Location $booth
try {
  $cli = @("x", "tauri", "android", "build", "--apk", "--debug", "--ci", "--target", "aarch64")
  if (-not $NoDev) { $cli += @("--config", "src-tauri/tauri.dev.conf.json") }

  Write-Host "==> Compiling the Rust library (a symlink error at the end is expected without Developer Mode)"
  & bun @cli 2>&1 | Tee-Object -Variable cliOutput | Out-Host
  $so = Join-Path $repo "target\aarch64-linux-android\debug\libphotobooth_lib.so"
  if (-not (Test-Path $so)) { throw "The Rust library was not built; see the output above." }
  if ($LASTEXITCODE -ne 0 -and (($cliOutput | Out-String) -notmatch "symbolic link")) {
    throw "tauri android build failed for a reason other than the symlink step."
  }

  Write-Host "==> Copying the library into jniLibs"
  $jni = Join-Path $android "app\src\main\jniLibs\arm64-v8a"
  New-Item -ItemType Directory -Force -Path $jni | Out-Null
  Copy-Item $so (Join-Path $jni "libphotobooth_lib.so") -Force

  Write-Host "==> Gradle"
  Push-Location $android
  try {
    & .\gradlew.bat --console=plain assembleArm64Debug -x rustBuildArm64Debug -x rustBuildUniversalDebug
    if ($LASTEXITCODE -ne 0) { throw "Gradle failed." }
  } finally { Pop-Location }
} finally { Pop-Location }

$apk = Join-Path $android "app\build\outputs\apk\arm64\debug\app-arm64-debug.apk"
Write-Host "==> APK: $apk"
if ($Install) {
  & (Join-Path $sdk "platform-tools\adb.exe") install -r $apk
}
