# Bàn giao reg6

- `src/browser.js` mở trang chi tiết trong một tab riêng tái sử dụng của hồ sơ Chrome đang quét. Tab đọc phản hồi chi tiết do trang tải và dùng `parseCreativeRegions`. Hết 15 giây chờ phản hồi thì trả `null`. Lượt mở trang và RPC dùng chung hàng đợi cùng khoảng nghỉ tối thiểu và độ dao động. Chuyển tới `/sorry`, mã 429 hoặc CAPTCHA làm dừng lượt quét qua `BlockedError`.
- `src/scanner.js` lấy vùng qua `lookupRegions` với mặc định tối đa 30 mẫu mỗi lượt. Client thiếu phương thức này bỏ qua bước lấy vùng. Kết quả `null` được ghi để thử lại ở lượt sau.
- `tests/browser.test.js` và `tests/scanner.test.js` kiểm tra đường dẫn, đọc phản hồi, dùng lại tab, nhịp nghỉ chung, hết giờ, chặn, hạn mức và thử lại với client giả.
- `npm test` đạt cả 9 tệp kiểm thử trên Node 22.23.5. Chưa chạy với Chrome thật trên máy quét.
