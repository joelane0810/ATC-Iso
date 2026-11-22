# Bàn giao UI9

- Bộ chọn **Phạm vi ngày** dùng chung cho Tổng quan, mục theo dõi, biểu đồ nhóm và lưới mẫu. Lịch cuộn theo tháng, nhận ngày gõ tay, giới hạn theo dữ liệu và lưu lựa chọn qua tải lại trang. Trước lần chọn đầu tiên, Tổng quan dùng ngày tham chiếu và mục theo dõi dùng Mọi lúc.
- Tổng quan hiển thị khoảng liền trước và dùng `spark` của khoảng đã chọn. Danh sách nhóm lấy số liệu từ `summary`, lưới mẫu gửi khoảng đến `ads`. Giao diện dùng giá trị mặc định của API để lấy các mốc ngày ban đầu.
- Biểu đồ mục theo dõi và nhóm có đường Ads đang chạy, cột Ads mới, nhãn theo tuần khi gộp, một hộp thông tin dùng chung, kéo chọn khoảng, đặt lại và chuyển sang bảng số liệu.
- Tệp triển khai gồm `web/index.html`, `web/app.js`, `web/style.css`. Kiểm thử giao diện nằm trong `tests/web.test.js`.

## Kiểm tra

- `node tests/web.test.js` đạt 10/10 với DOM mô phỏng và phản hồi API theo hợp đồng mới. Phạm vi kiểm tra gồm ngày không hợp lệ, giới hạn lịch, khoảng dùng chung qua các trang, lưu lựa chọn, kéo trên biểu đồ, chuyển sang bảng và đặt lại.
- Playwright thử cả Chrome lẫn Chromium Headless. Môi trường từ chối thao tác socket lúc tiến trình trình duyệt khởi động, nên chưa xác minh bố cục trên trình duyệt thật.
- `npm test` đạt 10/11 tệp kiểm thử. Ba ca trong `tests/ui7.test.js` vẫn kiểm tra bộ chọn `window`, biểu đồ 90 ngày cũ và bộ lọc `ad-period`. Tệp này nằm ngoài phạm vi được sửa.
- Kiểm tra tích hợp với máy chủ cần bản triển khai API khoảng ngày. Máy chủ hiện tại vẫn dùng hợp đồng cũ.
