# Bàn giao fix1

- `src/store.js` gộp mẫu theo mã, giữ bản có ngày thấy sớm nhất và lưu danh sách mã, nhãn của tất cả đối thủ khớp. Bộ lọc và nhãn trạng thái dùng cùng quy tắc 24 giờ và 2 ngày tính theo mốc trong spec.
- `src/store.js` lưu `imageUrl` và cập nhật nhãn đối thủ AR từ tên nhà quảng cáo của mẫu đầu tiên trên các hồ sơ có cùng đối thủ và vùng. Giá trị AR được giữ nguyên.
- `web/app.js` ưu tiên ảnh cục bộ rồi đến ảnh từ xa. Thẻ hiện website hoặc tên nhà quảng cáo, định dạng, hai ngày theo giờ Việt Nam và nhãn trạng thái tương ứng. Khi bấm thẻ, khung bên phải cập nhật ảnh lớn, website, nhà quảng cáo, ngày bắt đầu, ngày gần nhất, số ngày chạy và liên kết ATC mở trong tab mới. Trang cuộn vừa đủ để đưa khung vào tầm nhìn.
- `tests/store.test.js` kiểm tra gộp mẫu, lưu ảnh từ xa và đổi nhãn AR. `tests/web.test.js` kiểm tra thứ tự chọn ảnh, nội dung thẻ và thao tác bấm để đổi mẫu trong khung chi tiết bằng DOM mô phỏng.

`npm test` đạt cả 6 tệp trên Node v22.23.5. Môi trường chặn mở cổng cục bộ và khởi chạy Chrome, nên lượt kiểm tra API dùng bộ xử lý HTTP trong bộ nhớ và lượt kiểm tra giao diện dùng DOM mô phỏng.
