# Bàn giao BE7

- Tổng quan lấy ngày chạy ATC theo giờ Việt Nam. Ngày tham chiếu đổi lúc 20:00. Khoảng tính mẫu mới gồm ngày tham chiếu và các ngày liền trước, bắt đầu sau ngày so sánh. Báo cáo dùng SQL để gộp theo mục, nhóm và quốc gia, đồng thời trả chuỗi 30 ngày và tối đa 4 mẫu mỗi nhóm. Các bảng snapshot vẫn được lưu.
- API chuỗi ngày mặc định trả 90 điểm, kể cả ngày trống. Khi một mẫu khớp nhiều mục trong chuỗi của hồ sơ, mỗi ngày chỉ đếm mẫu đó một lần.
- API gợi ý dùng dữ liệu đã có. Thêm theo dõi nhận tên miền, mã nhà quảng cáo, liên kết ATC và tên nhà quảng cáo khớp chính xác khi bỏ qua hoa thường.
- API và dòng lệnh hỗ trợ quét riêng một mục. Trong thời gian nghỉ, lượt quét riêng tối đa hai trang, bỏ qua trang chi tiết và ảnh xem trước, lưu `light` và công bố `resumeAt`. Quét tất cả giữ quy tắc nghỉ hiện hành.

## Tệp

- `src/time-report.js`, `src/store.js`, `src/db.js`, `src/groups.js` và `src/atc.js` xử lý báo cáo, gợi ý và đầu vào.
- `src/server.js` và `src/web-store.js` nối hợp đồng HTTP với kho dữ liệu.
- `bin/scan.js`, `bin/server.js`, `src/scanner.js` và `src/scan-rest.js` xử lý quét riêng và thời gian nghỉ.
- `tests/store.test.js`, `tests/server.test.js` và `tests/scan-entry.test.js` kiểm tra hợp đồng mới.

## Kiểm thử

- `npm test` đạt.
- Kiểm thử tập trung đạt 24 bài. Bao gồm mốc 19:59 và 20:00, các khoảng ngày, quét lặp, chuỗi 90 ngày, gợi ý, đầu vào, lọc mẫu, quét riêng và thời gian nghỉ.
- Tổng quan 5.000 mẫu có dữ liệu quốc gia đo được 89 ms trên môi trường kiểm thử. Ngưỡng kiểm thử là 1.500 ms.
- Luồng quét được kiểm thử với máy khách mô phỏng.
