# Bàn giao UI7

- `web/index.html`, `web/style.css` và `web/app.js` triển khai tổng quan theo Hôm nay, 7 ngày và 30 ngày. Sáu thẻ lọc bảng, mỗi mục có biểu đồ nhỏ 30 ngày và có thể mở năm nhóm đầu rồi xem thêm. Nhóm hiển thị trạng thái, thay đổi, mẫu mới, quốc gia và nút Theo dõi khi phù hợp.
- Trang từng mục có danh sách nhóm sắp xếp được, lưới mẫu kiểu ATC và biểu đồ 90 ngày cho cả mục lẫn nhóm. Giao diện giữ màu trạng thái hiện có. Các nút quét dùng chung trạng thái và hỗ trợ quét tất cả hoặc quét riêng từng mục. Giờ quét lại hiển thị theo giờ Việt Nam.
- Ô tìm chờ 250 ms rồi lấy gợi ý, dùng loại Đối thủ hoặc Dự án đang chọn khi thêm. Có thể gửi trực tiếp tên miền, tên nhà quảng cáo hoặc đường dẫn.
- `tests/ui7.test.js` dùng DOM mô phỏng và dữ liệu giả theo hợp đồng mới. Bảy bài đạt, gồm lọc và mở nhóm, biểu đồ, lưới và chi tiết, gợi ý, theo dõi nhóm, quét, lỗi 409 và phản hồi đến sau khi đóng nhóm.
- `npm test` đạt 10/11 tệp. `tests/web.test.js` nằm ngoài phạm vi sửa và mô phỏng API cùng cấu trúc giao diện cũ, gồm đường dẫn tổng quan không có tham số và năm thẻ. Tệp này cần được cập nhật theo hợp đồng mới để cả bộ đạt.
- Kiểm tra giao diện bằng API giả. Máy chủ trên nhánh này vẫn trả cấu trúc tổng quan cũ và chưa phục vụ `/series` hay `/suggest`, nên chưa xác minh được luồng tích hợp thực tế.
