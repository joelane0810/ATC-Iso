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
for dir in "$HOME/.homebrew/bin" /opt/homebrew/bin ${path_dirs[@]+"${path_dirs[@]}"} /usr/local/bin /usr/bin; do
  if [[ "$dir" = /* && -x "$dir/node" && -x "$dir/npm" ]] &&
     "$dir/node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
    node_path="$dir/node"
    npm_path="$dir/npm"
    export PATH="$dir:$PATH"
    break
  fi
done
if [[ -z "$node_path" ]]; then
  echo "Cần cài Node.js từ phiên bản 20 trở lên, kèm npm." >&2
  exit 1
fi

if [[ ! -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
  echo "Cần cài Google Chrome vào thư mục Ứng dụng." >&2
  exit 1
fi

cd "$root"
"$npm_path" ci

agent_dir="$HOME/Library/LaunchAgents"
domain="gui/$(id -u)"
mkdir -p "$agent_dir" "$root/logs"

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
  <string>$root_xml/logs/$job.log</string>
  <key>StandardErrorPath</key>
  <string>$root_xml/logs/$job-error.log</string>
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
