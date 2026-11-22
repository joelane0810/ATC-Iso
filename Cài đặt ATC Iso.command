#!/bin/bash
cd "$(dirname "$0")"
echo "Đang cài ATC Iso..."
bash ops/install-macos.sh && echo "Xong. Mở http://127.0.0.1:4317" && open "http://127.0.0.1:4317"
echo "Nhấn Enter để đóng."; read
