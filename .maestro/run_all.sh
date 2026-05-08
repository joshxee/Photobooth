#!/usr/bin/env bash
# Runs every Maestro flow under .maestro/flows/ sequentially and exits non-zero
# on any failure. Skips flows that require Sony hardware unless
# SONY_CAMERA_AVAILABLE=1 is set.
#
# Usage:
#   ./.maestro/run_all.sh
#   SONY_CAMERA_AVAILABLE=1 ./.maestro/run_all.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLOWS_DIR="$SCRIPT_DIR/flows"
RUN="$SCRIPT_DIR/run.sh"

SONY_GATED=(
  "nav_sony_mark2_full_session.yaml"
)

failed=()
ran=0
skipped=()

for flow in "$FLOWS_DIR"/*.yaml; do
  name="$(basename "$flow")"
  gated=0
  for g in "${SONY_GATED[@]}"; do
    if [[ "$name" == "$g" ]]; then gated=1; fi
  done
  if [[ "$gated" -eq 1 && "${SONY_CAMERA_AVAILABLE:-0}" != "1" ]]; then
    skipped+=("$name (SONY_CAMERA_AVAILABLE!=1)")
    continue
  fi
  echo ""
  echo "=== $name ==="
  if "$RUN" test "$flow"; then
    ran=$((ran + 1))
  else
    failed+=("$name")
  fi
done

echo ""
echo "==========================="
echo "ran:     $ran"
echo "skipped: ${#skipped[@]}"
for s in "${skipped[@]}"; do echo "  - $s"; done
echo "failed:  ${#failed[@]}"
for f in "${failed[@]}"; do echo "  - $f"; done

if [[ ${#failed[@]} -gt 0 ]]; then
  exit 1
fi
exit 0
