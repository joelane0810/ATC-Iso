#!/bin/bash
cd "$(dirname "$0")"
NODE_BIN="$(/bin/zsh -lic 'command -v node' 2>/dev/null | tail -n 1)"
[[ -x "$NODE_BIN" ]] || NODE_BIN="$HOME/.local/bin/node"
"$NODE_BIN" bin/scan.js 2>&1 | tee logs/quet-ngay.txt
echo "Nhấn Enter để đóng."; read
