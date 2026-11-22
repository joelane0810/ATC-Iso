#!/bin/bash
cd "$(dirname "$0")"
PATH="$HOME/.homebrew/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" node bin/scan.js
echo "Nhấn Enter để đóng."; read
