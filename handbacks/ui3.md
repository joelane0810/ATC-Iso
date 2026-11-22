# Bàn giao UI3

- Trang chủ mở mặc định và dùng dữ liệu tổng quan của hồ sơ. Giao diện có thời điểm lượt quét trước theo giờ Việt Nam, ba thẻ số, bảng mở từng mục theo dõi và hai lưới mẫu dùng chung thẻ và khung chi tiết.
- Cột trái có hai nhóm thu gọn Đối thủ và Dự án, kèm số mẫu và số mẫu mới từ tổng quan. Mục cũ thiếu loại được xếp vào Đối thủ.
- Nút + Thêm chọn loại tương ứng và đưa con trỏ vào ô nhập. Biểu mẫu gửi `input`, `region: null` và `kind`. Các lưới chỉ hiển thị mẫu có `platform: "search"`.
- Tệp sửa gồm `web/index.html`, `web/app.js`, `web/style.css` và `tests/web.test.js`.
- `npm test` đạt 9/9 tệp kiểm thử. Kiểm thử giao diện mô phỏng DOM và kiểm tra dữ liệu tổng quan, điều hướng, loại theo dõi gửi đi, lọc nền tảng và mở chi tiết.
- Nhánh máy chủ cung cấp `/summary` còn cần được ghép để kiểm tra tích hợp với dữ liệu thật.
