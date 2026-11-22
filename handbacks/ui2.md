# Bàn giao ui2

- `web/index.html` và `web/style.css` dựng giao diện tiếng Việt cho ATC Iso với thanh thêm đối thủ, chọn hồ sơ, trạng thái quét và bố cục ba cột từ 1280 px. Màn hình hẹp cuộn ngang.
- `web/app.js` giữ các API hiện có, lọc đối thủ ngay trên trình duyệt theo `watchId` và `watchIds`, dùng danh sách chưa lọc để đếm mẫu và mẫu mới. Thẻ ưu tiên ảnh lưu trong máy rồi dùng URL ảnh khi thiếu ảnh lưu. Khung chi tiết có nút mở ATC và sao chép link.
- `tests/web.test.js` kiểm tra nguồn ảnh, nội dung thẻ, mẫu dùng chung giữa các đối thủ, bảng chi tiết và thao tác sao chép link qua bộ nhớ tạm giả lập.

`npm test` đạt 9/9 tệp kiểm thử. Chưa xác minh hiển thị và bộ nhớ tạm trên trình duyệt thật vì môi trường chặn Chrome khởi động tại lệnh `setsockopt`.
