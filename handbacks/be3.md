# Bàn giao be3

- `src/atc.js` gửi bộ lọc Google Tìm kiếm `14: [3]` trong mọi yêu cầu SearchCreatives.
- `src/store.js` mặc định danh sách cũ thành `competitor`, cập nhật loại khi thêm trùng và gắn `platform: "search"` cho mẫu được quét. Danh sách quảng cáo chỉ hiển thị mẫu Tìm kiếm và trả `watchKind` theo hồ sơ.
- `src/scanner.js` tiếp tục phân trang khi gặp mẫu mới hoặc chưa xác nhận là Tìm kiếm. Nhật ký ghi `changes` theo mục theo dõi. Mẫu cũ được xác nhận là Tìm kiếm giữ ngày phát hiện ban đầu. Việc xác định mẫu vừa dừng dùng mốc quét trước đã lưu của từng mục theo dõi.
- `src/server.js` nhận `kind` khi thêm mục theo dõi và phục vụ `GET /api/profiles/:pid/summary`. Tổng kết dùng hai nhật ký gần nhất có trạng thái `ok` hoặc `blocked`. Danh sách mẫu mới sắp theo ngày phát hiện, danh sách mẫu vừa dừng sắp theo ngày chạy cuối. Mỗi danh sách tối đa 24 mẫu.
- Đã cập nhật `tests/atc.test.js`, `tests/store.test.js`, `tests/scanner.test.js` và `tests/server.test.js` để kiểm tra bộ lọc, tương thích dữ liệu cũ, phân trang, ranh giới hai ngày, phạm vi hồ sơ và giới hạn danh sách tổng kết.

`npm test` đạt cả 9 tệp kiểm thử trên Node 22.23.5.
