# Bàn giao ui4

- `web/index.html` và `web/app.js` hiển thị Tổng quan theo từng mục theo dõi. Đối thủ có hàng theo tên miền, Dự án có hàng theo nhà quảng cáo. Năm thẻ số lọc các hàng. Thẻ Mẫu đang chạy hiển thị các hàng còn ít nhất một mẫu chạy. Bấm lại thẻ để bỏ lọc.
- Hàng hiển thị số mẫu trước và nay, chênh lệch, mẫu mới, tối đa sáu cờ kèm số mẫu và tối đa bốn ảnh thu nhỏ. Bấm hàng để tải mẫu ngay bên dưới bằng `watchId` và `group`. Lượt quét đầu vẫn hiển thị các hàng và trạng thái.
- `web/style.css` dùng chung năm cặp màu trạng thái. Chấm màu băm từ mã mục theo dõi dùng chung ở Tổng quan và cột trái. Thẻ mẫu hiển thị cờ, khung chi tiết hiển thị tên quốc gia và ngày chạy gần nhất.
- `tests/web.test.js` dùng DOM và API giả theo hợp đồng. Kiểm thử cả năm bộ lọc, mở nhóm, phản hồi đến sau khi đóng nhóm, màu nhận diện, ảnh, quốc gia, ngày chạy và các thao tác có sẵn. `npm test` đạt cả 9 tệp kiểm thử trên Node 22.23.5.
- Tích hợp thực tế cần backend của nhánh kia. Backend hiện tại vẫn trả cấu trúc Tổng quan cũ và chưa áp dụng tham số lọc nhóm.
