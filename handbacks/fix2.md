# Bàn giao fix2

1. Tải ảnh và `content.js` kiểm tra 429, chuyển hướng tới trang chặn và nội dung HTML. Lỗi chặn đi tới bộ điều phối và kết thúc lượt. Tệp `src/browser.js`, `src/atc.js`, `src/scanner.js`.
2. Quét giữ khoá độc quyền `flock` trên `data/.scan.lock` qua `/usr/bin/perl`. Khoá được nhả khi tiến trình giữ khoá kết thúc, tệp khoá được giữ tại chỗ. PID còn sống trong khoá định dạng cũ vẫn được tôn trọng, kể cả sau ba giờ. Tệp `src/lock.js`.
3. Đồng bộ chỉ chạy khi `config.json` ở gốc có `{"sync": true}`. Mỗi lệnh Git tắt nhắc tương tác và có hạn 60 giây. Push được thử cả khi dữ liệu không đổi, để đẩy được commit còn tồn. Kết quả ghi vào trường `sync` của mục nhật ký quét. Tệp `src/sync.js`, `bin/scan.js`.
4. Trang đầu phát hiện thử thách CAPTCHA qua DOM và điều hướng `/sorry` trên host ATC. RPC xét status và kiểu nội dung trước khi đọc body, có hạn 30 giây. Tệp `src/browser.js`, `src/atc.js`.
5. Chụp ảnh khi nội dung chữ hiện ra hoặc video có khung hình, giới hạn chờ 10 giây. Lỗi dựng ảnh hiện trong log tiến trình. Mỗi lượt thử lại tối đa 20 mẫu cũ thiếu ảnh có URL xem trước. Tệp `src/browser.js`, `src/scanner.js`.
6. Trình cài kiểm tra cặp Node/npm cùng thư mục tại `~/.homebrew/bin`, `/opt/homebrew/bin` và các đường dẫn tuyệt đối. Plist dùng đường dẫn tuyệt đối và hỗ trợ thư mục có dấu cách. Tệp `ops/install-macos.sh`.
7. API dùng khoá chung để báo lượt quét theo lịch. Yêu cầu quét tay chỉ nhận `202` sau xác nhận lấy khoá và nhận `409` khi lượt khác giành khoá trước. Tệp `bin/server.js`, `src/server.js`, `bin/scan.js`.
8. Lỗi khởi tạo Chrome được ghi vào nhật ký quét sau khi lấy khoá, với chi tiết kỹ thuật ở log tiến trình. API trạng thái đọc mục mới nhất theo thứ tự ghi của kho. Tệp `bin/scan.js`, `src/server.js`.

## Kiểm thử

- `npm test` đạt toàn bộ.
- `tests/browser.test.js` dùng Chrome giả để thử chặn ở trang đầu, RPC, ảnh và `content.js`, cùng callback mẫu chữ và video.
- `tests/scanner.test.js` thử dừng khi tải ảnh bị chặn, giới hạn 20 lần thử lại, khoá PID sống lâu và tranh khoá giữa hai tiến trình.
- `tests/sync.test.js` dùng hàm Git giả để kiểm tra cấu hình, thời hạn, chế độ không tương tác và thử lại push.
- `tests/install-macos.test.js` dùng thư mục có dấu cách và bộ công cụ giả. `bash -n ops/install-macos.sh` đạt.
- `tests/server.test.js` thử trạng thái khoá và tình huống lượt theo lịch lấy khoá sát lúc bấm quét.
- `tests/scan-entry.test.js` thử lỗi mở Chrome và trường `sync` trong nhật ký.

## Giới hạn xác minh

- Chrome, phản hồi `content.js` thật của Google và launchd trên Mac mini chưa được chạy trong môi trường này. Không chạy Git.
- Bản ghi của lượt hiện tại được ghi sau khi có kết quả push. Bản đó có ngay ở máy quét và được đưa lên cùng lần đồng bộ sau.
- Mẫu hình cũ đã lưu trước bản sửa và thiếu cả ảnh lẫn URL cần xuất hiện lại trong kết quả ATC để lấy URL và thử lại. Mẫu hình thu thập từ bản sửa lưu URL để có thể thử lại ở lượt sau.
