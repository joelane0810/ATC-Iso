# Bàn giao be9

- `src/scanner.js` điền tên miền của mục theo dõi khi ATC thiếu trường 14. Mục nhà quảng cáo giữ tên miền trống nếu ATC thiếu trường này. Bộ quét chỉ tải ảnh trực tiếp, tối đa 40 lần thử mỗi lượt, và vẫn dùng được đường dẫn ảnh lưu cũ trên `tpc.googlesyndication.com`.
- `src/db.js` nâng DB lên phiên bản 3 trong một giao dịch khi mở để ghi. Bước nâng cấp điền tên miền còn trống trong `creatives` và dữ liệu của từng mục tên miền trong `watch_creatives.observation`. Nếu một mẫu có nhiều mục tên miền, bản ghi chung dùng tên miền của mục có mã đứng đầu theo thứ tự sắp xếp. Dữ liệu của từng mục dùng tên miền của chính mục đó.
- `src/browser.js` bỏ bước mở trang, dựng `content.js` và chụp ảnh xem trước. Tải ảnh trực tiếp vẫn dừng lượt quét khi gặp tín hiệu chặn.
- `tests/scanner.test.js`, `tests/store.test.js` và `tests/browser.test.js` kiểm tra tên miền thiếu, nâng cấp đúng một lần, dữ liệu mục nhà quảng cáo, việc bỏ dựng ảnh xem trước, tải trực tiếp và giới hạn 40 lần thử.

`npm test` trên Node v22.23.5 đạt 11/11 tệp kiểm thử.
