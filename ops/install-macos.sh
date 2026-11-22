#!/bin/bash
set -euo pipefail

path_dirs=()
IFS=: read -r -a inherited_dirs <<< "${PATH:-}"
for dir in ${inherited_dirs[@]+"${inherited_dirs[@]}"}; do
  [[ "$dir" = /* ]] && path_dirs+=("$dir")
done
absolute_path="$(IFS=:; printf '%s' "${path_dirs[*]-}")"
export PATH="${absolute_path:+$absolute_path:}/usr/bin:/bin:/usr/sbin:/sbin"

if [[ "$(uname -s)" != Darwin ]]; then
  echo "Chỉ cài được trên macOS." >&2
  exit 1
fi

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
node_path=
npm_path=
for dir in ${NODE_BIN:+"$(dirname "$NODE_BIN")"} "$HOME/.local/bin" "$HOME/.homebrew/bin" /opt/homebrew/bin ${path_dirs[@]+"${path_dirs[@]}"} /usr/local/bin /usr/bin; do
  if [[ "$dir" = /* && -x "$dir/node" ]] &&
     "$dir/node" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)' &&
     "$dir/node" -e 'require("node:sqlite")' >/dev/null 2>&1; then
    node_path="$dir/node"
    [[ -x "$dir/npm" ]] && npm_path="$dir/npm"
    export PATH="$dir:$PATH"
    break
  fi
done
if [[ -z "$node_path" ]]; then
  echo "Cần cài Node.js từ phiên bản 22.13 trở lên có hỗ trợ SQLite." >&2
  exit 1
fi
[[ -z "$npm_path" && -n "${NPM_BIN:-}" && -x "$NPM_BIN" ]] && npm_path="$NPM_BIN"

if [[ ! -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
  echo "Cần cài Google Chrome vào thư mục Ứng dụng." >&2
  exit 1
fi

cd "$root"
if [[ -d node_modules/playwright-core ]]; then
  echo "Thư viện đã có sẵn."
elif [[ -n "$npm_path" ]]; then
  "$npm_path" ci
else
  echo "Thiếu npm và thiếu thư viện playwright-core." >&2
  exit 1
fi

agent_dir="$HOME/Library/LaunchAgents"
domain="gui/$(id -u)"
log_dir="$HOME/Library/Logs/ATC Iso"
mkdir -p "$agent_dir" "$root/logs" "$log_dir"
log_xml="$(printf '%s' "$log_dir" | sed -e 's/\&/\&amp;/g')"

xml_escape() {
  printf '%s' "$1" | sed -e 's/\&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

root_xml="$(xml_escape "$root")"
node_xml="$(xml_escape "$node_path")"
path_xml="$(xml_escape "$PATH")"

install_agent() {
  local job="$1" schedule="$2"
  local label="com.atciso.$job"
  local plist="$agent_dir/$label.plist"

  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    launchctl bootout "$domain/$label"
  fi

  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_xml</string>
    <string>$root_xml/bin/$job.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$root_xml</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$path_xml</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$log_xml/$job.log</string>
  <key>StandardErrorPath</key>
  <string>$log_xml/$job-error.log</string>
  $schedule
</dict>
</plist>
PLIST

  plutil -lint "$plist"
  launchctl bootstrap "$domain" "$plist"
}

install_agent server '<key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>'
install_agent scan '<key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>2</integer>
    <key>Minute</key><integer>0</integer>
  </dict>'

echo "Đã cài ATC Iso. Mở http://127.0.0.1:4317 để sử dụng."

# Tường lửa macOS: cho phép máy cùng wifi vào web
fw=/usr/libexec/ApplicationFirewall/socketfilterfw
if [[ -x "$fw" ]]; then
  node_real="$("$node_path" -e 'console.log(require("fs").realpathSync(process.execPath))')"
  echo "Tường lửa: $("$fw" --getglobalstate)"
  if "$fw" --getglobalstate | grep -qi enabled; then
    if "$fw" --listapps 2>/dev/null | grep -qF "$node_real" && ! "$fw" --getappblocked "$node_real" 2>/dev/null | grep -qi "blocked" ; then
      echo "Node đã được phép nhận kết nối."
    else
      echo "Cần mật khẩu máy Mac để cho máy cùng wifi vào web ATC Iso:"
      sudo "$fw" --add "$node_real" && sudo "$fw" --unblockapp "$node_real" || echo "Chưa mở được tường lửa." >&2
    fi
  fi
fi

# Kiểm tra máy chủ đã chạy chưa
sleep 4
for job in server scan; do
  echo "== com.atciso.$job"
  launchctl print "$domain/com.atciso.$job" 2>&1 | grep -E "state =|last exit code|pid =" | head -5 || true
done
if command -v curl >/dev/null && curl -s -m 3 -o /dev/null http://127.0.0.1:4317/api/profiles; then
  echo "Máy chủ web: đang chạy."
else
  echo "Máy chủ web: CHƯA chạy." >&2
  echo "== thử chạy trực tiếp 5 giây" >&2
  ( cd "$root" && "$node_path" bin/server.js > /tmp/atciso-try.log 2>&1 & p=$!; sleep 5; kill $p 2>/dev/null; tail -5 /tmp/atciso-try.log ) || true
  echo "== nhật ký nền:" >&2; tail -n 8 "$log_dir/server-error.log" 2>/dev/null >&2 || true
fi
