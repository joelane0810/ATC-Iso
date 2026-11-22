# Bàn giao be8

- `src/time-report.js` tính tổng quan theo khoảng ngày Việt Nam và so với khoảng trước liền kề cùng độ dài. Trả ngày bắt đầu, ngày kết thúc, hai mốc kỳ trước, ngày dữ liệu sớm nhất và ngày tham chiếu. Giữ mốc 20:00 và giới hạn theo dữ liệu lần quét.
- `src/time-report.js` trả chuỗi từ ngày sớm nhất tới ngày tham chiếu theo mặc định. Các khoảng dài hơn 120 ngày dùng nhóm 7 ngày tính từ ngày bắt đầu khoảng chọn. Mỗi quảng cáo được đếm tối đa một lần trong mỗi nhóm. Nếu biểu đồ nhỏ có hơn 120 nhóm tuần, biểu đồ giữ 120 nhóm gần nhất. Số liệu tổng quan và chuỗi chi tiết vẫn tính trên toàn khoảng.
- `src/server.js` chuyển các tham số ngày vào báo cáo và danh sách quảng cáo. `src/store.js` lọc theo giao khoảng trước khi gộp các bản ghi trùng mẫu. Ngày sai và khoảng đảo ngược trả lỗi 400 tiếng Việt. Ngày hợp lệ vượt mốc tham chiếu được kẹp về mốc đó.
- `tests/server.test.js` và `tests/store.test.js` kiểm tra khoảng một ngày tương đương `window=day`, khoảng 7 ngày, kỳ trước liền kề, mốc ngày Việt Nam, gộp tuần, lọc quảng cáo và lỗi ngày.

`npm test` đạt cả 11 tệp kiểm thử. Tổng quan và chuỗi theo tuần cho 5.000 mẫu mất 113,7 ms trong lần chạy riêng bộ kiểm thử kho dữ liệu, dưới ngưỡng 1.500 ms.
