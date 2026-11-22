#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo "Chỉ gỡ được trên macOS." >&2
  exit 1
fi

domain="gui/$(id -u)"
for label in com.atciso.server com.atciso.scan; do
  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    launchctl bootout "$domain/$label"
  fi
  rm -f -- "$HOME/Library/LaunchAgents/$label.plist"
done

echo "Đã gỡ lịch quét và máy chủ ATC Iso."
