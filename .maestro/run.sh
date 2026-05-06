#!/bin/bash
# Wrapper that ensures adb is on PATH and Maestro's instrumentation port is
# forwarded before invoking maestro.
# Usage: .maestro/run.sh [maestro args...]
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$PATH:$ANDROID_HOME/platform-tools"

# Stop any stuck Maestro instrumentation from a previous run and ensure the port is forwarded
adb shell am force-stop dev.mobile.maestro.orchestra >/dev/null 2>&1
adb forward tcp:7001 tcp:7001 >/dev/null 2>&1

exec maestro "$@"
