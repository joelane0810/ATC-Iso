# Bàn giao fix5

## Thay đổi

- `package.json`, `ops/install-macos.sh` yêu cầu Node từ 22.13 và thử nạp `node:sqlite` bằng đúng chương trình Node trước khi cài.
- `src/db.js`, `src/server.js`, `src/web-store.js` mở cơ sở dữ liệu đã đúng phiên bản mà không lấy khóa ghi. Yêu cầu GET đọc qua kết nối chỉ đọc trong luồng riêng. Web chờ khóa SQLite tối đa 250 ms mỗi lần và trả 503 tiếng Việt khi bận. Các giao dịch ghi của tiến trình quét thử tối đa ba lần khi gặp `SQLITE_BUSY`. Khi khởi tạo hoặc nâng cấp, SQLite được kiểm tra lại sau khi đặt WAL và ghi nhật ký nếu phải chuyển sang DELETE.
- `src/db.js`, `src/store.js`, `src/groups.js`, `src/scanner.js` gắn từng mục đã quét với `scan_id` và lưu dữ liệu cùng ảnh chụp số liệu trong một giao dịch. Tổng quan dùng hai mốc thật gần nhất của từng mục. Mục bị bỏ qua giữ số liệu gần nhất với mức thay đổi bằng 0 trong lượt hiện tại. Nhóm biến mất được tính là đã dừng nếu trước đó có mẫu đang chạy.
- `src/db.js`, `src/store.js` chuyển JSON theo định danh gồm loại, giá trị và vùng, tách mã trùng và dùng thông tin mục trong tệp quảng cáo để gán dữ liệu. Bản JSON gốc được giữ lại. Kiểm và ghi `user_version` trong cùng giao dịch ghi. Dữ liệu nhập có ảnh chụp số liệu gốc. Khi nâng cấp từ SQLite phiên bản 1, lịch sử chỉ dùng các ảnh chụp có nhật ký xác nhận mục đã quét.
- `src/scanner.js`, `src/store.js`, `src/atc.js` giữ ngày xuất hiện gần nhất lớn nhất và đọc thêm tối đa ba trang sau trang toàn mẫu cũ, trong giới hạn mười trang cho lượt quét lại. Phản hồi quốc gia thiếu trường được lên lịch thử lại, kể cả với mẫu mới đã ngừng chạy. Danh sách rỗng hợp lệ được lưu là đã kiểm tra. Mẫu đang chạy được làm mới sau bảy ngày. Hạn mức 60 được chia theo số mục, phần dư luân phiên theo ngày. Ngày quốc gia được tính đến cuối ngày UTC.
- `src/db.js`, `src/store.js` tái sử dụng câu lệnh SQLite đã chuẩn bị, thêm cột ngày có chỉ mục và lấy quốc gia bằng JOIN theo lô. Giữ hợp đồng summary và ads. Không sửa `web/`.

## Kiểm chứng

- `npm test` đạt cả 9 tệp kiểm thử trên Node 22.23.5. Các tệp bổ sung hoặc cập nhật gồm `tests/install-macos.test.js`, `tests/atc.test.js`, `tests/scanner.test.js`, `tests/server.test.js` và `tests/store.test.js`.
- `bash -n ops/install-macos.sh` đạt.
- `tests/store.test.js` chạy riêng đạt 17 bài. Tổng quan 5.000 mẫu có dữ liệu quốc gia mất 36,4 ms trên cơ sở dữ liệu tạm, dưới ngưỡng kiểm thử 1.500 ms.
- Kiểm thử tranh khóa dùng SQLite thật. Môi trường giới hạn socket nên bài kiểm thử HTTP gọi cùng bộ xử lý yêu cầu trong bộ nhớ. Kiểm thử cài đặt dùng chương trình giả lập macOS. Chưa kiểm chứng trên Mac mini hoặc ổ rời thực tế.
