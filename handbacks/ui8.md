# Bàn giao ui8

- `web/index.html` và `web/style.css` thêm bộ chọn thời gian chạy dùng chung cho lưới mẫu và danh sách nhóm, đồng thời làm nổi bật nút Tổng quan bằng biểu tượng và màu theo trạng thái chọn.
- `web/app.js` lọc mẫu theo phần giao của các ngày chạy và khoảng đã chọn, tính cả hai đầu theo giờ Việt Nam. Nhóm hiển thị khi có ít nhất một mẫu khớp và danh sách mẫu khi mở nhóm dùng cùng khoảng lọc. Lựa chọn và ngày tuỳ chọn được lưu trong localStorage có xử lý lỗi. Bộ lọc “Hôm nay” dùng ngày lịch Việt Nam, còn so sánh trên Tổng quan dùng ngày tham chiếu của API.
- Thẻ “Ads đang chạy” dùng số liệu tổng hợp và có chú thích “Số mẫu quảng cáo có hiển thị trong ngày dữ liệu mới nhất”. Các nhãn liên quan dùng “Ads đang chạy” và “Ads mới”.
- `tests/web.test.js` cập nhật dữ liệu giả lập theo hợp đồng summary, series, suggest và quét theo watchId. Giữ các ca ảnh local → remote → ô trống, thẻ mẫu, chi tiết, nhóm đúng mục, phản hồi đến muộn và chip loại theo dõi.
- `tests/ui7.test.js` cập nhật kỳ vọng nhãn, kiểm tra lọc lưới và nhóm tại ranh giới ngày Việt Nam và kiểm tra lưu khoảng tuỳ chọn sau khi tải lại.

`npm test` đạt 11/11 tệp kiểm thử. Chạy riêng hai tệp giao diện đạt 15/15 ca. Kiểm tra bổ sung trên Chrome headless bị chặn lúc khởi động do giới hạn socket của môi trường. Phạm vi thay đổi gồm `web/`, hai tệp kiểm thử giao diện và bản bàn giao.
