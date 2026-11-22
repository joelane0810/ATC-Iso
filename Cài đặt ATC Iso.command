#!/bin/bash
cd "$(dirname "$0")"
echo "Đang cài ATC Iso..."
NODE_BIN="$(/bin/zsh -lic 'command -v node' 2>/dev/null | tail -n 1)"
if [[ -z "$NODE_BIN" ]]; then
  for b in "$HOME/.homebrew/bin/brew" /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [[ -x "$b" ]]; then echo "Chưa có Node.js — đang cài qua Homebrew..."; "$b" install node; NODE_BIN="$(dirname "$b")/node"; break; fi
  done
fi
if [[ -n "$NODE_BIN" && -x "$NODE_BIN" ]]; then export PATH="$(dirname "$NODE_BIN"):$PATH"; fi
{ echo "node: $NODE_BIN"; "$NODE_BIN" -v; } > logs-cai-dat.txt 2>&1
bash ops/install-macos.sh 2>&1 | tee -a logs-cai-dat.txt
if [[ ${PIPESTATUS[0]} -eq 0 ]]; then echo "Xong."; open "http://127.0.0.1:4317"; fi
echo "Nhấn Enter để đóng."; read
