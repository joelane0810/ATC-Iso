# Bàn giao img2

- `src/browser.js` tải trực tiếp qua `context.request` khi có `imageUrl`, áp dụng cho mẫu chữ, hình và video. Đuôi tệp ảnh lấy theo `Content-Type`. Với `content.js`, trình quét bổ sung `htmlParentId` và `responseCallback` khi thiếu, dựng trên trang trắng, chờ tối đa 8 giây và chụp khi nội dung đủ điều kiện hiển thị. Tín hiệu chặn vẫn ném `BlockedError`.
- `src/scanner.js` giới hạn 40 lần thử lưu ảnh mỗi lượt, tính chung tải trực tiếp và chụp xem trước. Lần tiếp theo bắt đầu ít nhất 1,5 giây sau khi lần trước kết thúc. Lượt vẫn thử lại tối đa 20 mẫu cũ thiếu ảnh trong giới hạn chung, kể cả mẫu còn lưu URL `archive/simgad` trong `previewUrl`.
- `tests/browser.test.js` dùng Chrome giả để kiểm tra tải ảnh trực tiếp theo kiểu nội dung, bổ sung tham số xem trước, chờ iframe có kích thước, và các tín hiệu chặn.
- `tests/scanner.test.js` dùng client giả để kiểm tra giới hạn chung qua nhiều đối thủ, yêu cầu chờ giữa các ảnh, thử lại URL ảnh đã lưu và dừng khi bị chặn.

`npm test` đạt cả 9 tệp kiểm thử trên Node 22. Chưa chạy lượt quét thật với Chrome và Google.
