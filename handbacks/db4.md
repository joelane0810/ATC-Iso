# Bàn giao db4

- `src/db.js` mở `data/atc.db` với WAL và khóa ngoại. Dữ liệu hồ sơ, mục theo dõi, quảng cáo và nhật ký được chuyển trong một giao dịch, đánh dấu bằng `user_version`. Các tệp JSON cũ được giữ làm bản sao lưu.
- `src/store.js` lưu dữ liệu trên SQLite, giữ các hàm cũ và bổ sung quốc gia, số liệu từng nhóm ở mỗi lượt quét và tổng quan. Các lượt nhập từ nhật ký cũ có trạng thái và ngày giờ. Số mẫu đang chạy để so sánh đến từ các bản chụp được ghi sau khi chuyển sang SQLite.
- `src/atc.js` dựng yêu cầu xem chi tiết, đọc ngày quốc gia theo UTC và ánh xạ 249 mã ISO 3166-1. `src/scanner.js` ưu tiên mẫu mới trong từng mục theo dõi, giới hạn 60 yêu cầu chi tiết cho cả lượt và dừng khi bị Google chặn.
- `src/server.js` trả tổng quan theo hợp đồng và hỗ trợ lọc quảng cáo theo `watchId` và `group`. `bin/scan.js` ghi nhật ký và bản chụp trước khi đồng bộ, checkpoint SQLite và loại các tệp WAL/SHM khỏi phạm vi đồng bộ. Kết quả đồng bộ được lưu tại máy sau khi thao tác đồng bộ kết thúc.
- `tests/atc.test.js`, `tests/store.test.js`, `tests/scanner.test.js`, `tests/server.test.js` kiểm tra mẫu phản hồi thực tế, số dòng khi chuyển JSON, đủ năm trạng thái và hai loại nhóm, lọc API, giới hạn 60 và dừng khi bị chặn ở yêu cầu chi tiết.

`npm test` đạt trên Node 22.23.5. HTTP được kiểm tra qua bộ xử lý trong bộ nhớ vì môi trường chặn mở cổng. Lượt quét dùng phản hồi giả lập. SQLite yêu cầu Node 22.13 trở lên theo spec.
