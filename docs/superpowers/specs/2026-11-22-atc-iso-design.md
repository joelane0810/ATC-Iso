# ATC Iso — thiết kế (22/11/2026)

## Mục đích
App theo dõi quảng cáo của đối thủ trên Google Ads Transparency Center (ATC) cho anh Dai và nhóm.
Mỗi ngày tự quét danh sách đối thủ, lưu mẫu quảng cáo mới: ảnh, tên website, link, ngày bắt đầu chạy,
ngày chạy gần nhất ("ngày kết thúc"). Giao diện màn hình ngang.

## Quyết định của anh Dai
- Hồ sơ người dùng: chọn theo tên, không mật khẩu (phương án A).
- Quét bằng Chrome thật của anh nhưng **hồ sơ Chrome riêng** (không đụng hồ sơ đang dùng).
- **Toàn bộ hệ thống chạy local trên Mac mini** (`/Users/daituong/ATC ISO`). Dữ liệu đồng bộ lên GitHub `joelane0810/ATC-Iso`.

## Ràng buộc đã đo
- Gọi ATC từ máy ảo đám mây bị Google chặn (trang captcha) sau ~3 lượt. Không lách captcha, không giả trình duyệt.
- Từ Chrome thật của anh: gọi API nội bộ ATC ngay trong trang adstransparency.google.com (cùng nguồn, cookie thật),
  tốc độ người thật (≥8 s/lượt, có dao động), **gặp captcha/302 về google.com/sorry là dừng cả lượt quét** (cầu dao),
  ghi trạng thái "bị chặn", lần sau mới chạy lại. Không bao giờ giải captcha.
- Máy anh phải bật; app chạy nền bằng launchd.

## Phương án đã xét
1. Dịch vụ dữ liệu trả phí (SerpApi/DataForSEO) chạy trên máy ảo — anh không chọn (tốn tiền).
2. Tiện ích Chrome + GitHub Pages — bỏ khi anh chuyển sang chạy local (cần khoá GitHub trong tiện ích, phức tạp hơn).
3. **Chọn:** ứng dụng Node chạy trên Mac: Playwright điều khiển Chrome cài sẵn (`channel: "chrome"`) với thư mục hồ sơ riêng
   `ATC ISO/chrome-profile`, máy chủ web local phục vụ giao diện, git đẩy dữ liệu lên GitHub sau mỗi lượt quét.

## API ATC (đã đo 22/11)
POST `https://adstransparency.google.com/anji/_/rpc/<Service>/<Method>?authuser=` , body `f.req=<json>` (form-urlencoded).
- `SearchService/SearchSuggestions` `{"1":"<chữ>","2":10,"3":10}` → `{"1":[{"1":{"1":tên,"2":"AR…","3":nước}} | {"2":{"1":"domain"}}]}`
- `SearchService/SearchCreatives`
  - theo tên miền: `{"2":40,"3":{"12":{"1":"<domain>","2":true}},"7":{"1":1,"2":30,"3":2840}}`
  - theo nhà quảng cáo: `{"2":40,"3":{"13":{"1":["AR…"]}},"7":{"1":1,"2":30,"3":2840}}`
  - trang sau: thêm `"4":"<token>"` lấy từ `"2"` của phản hồi trước.
  - vùng: thêm `"3":{"8":[<mã vùng>]}` (2840 = Mỹ); mặc định "mọi nơi" (không gửi).
  - mỗi mẫu: `"1"` mã nhà QC, `"2"` mã mẫu CR…, `"3"` xem trước (`{"1":{"4":url content.js}}` hoặc `{"3":{"2":"<img src=…>"}}`),
    `"4"` định dạng (1 chữ, 2 hình, 3 video), `"6":{"1":giây}` ngày đầu, `"7":{"1":giây}` ngày cuối, `"12"` tên nhà QC, `"14"` tên miền.
- Link chi tiết: `https://adstransparency.google.com/advertiser/<AR>/creative/<CR>`.

## Dữ liệu (thư mục `data/`, đẩy lên GitHub)
- `data/profiles.json` — `[{ "id":"dai","name":"Dai","createdAt":ISO }]`
- `data/profiles/<id>/watchlist.json` — `[{ "id":slug,"type":"domain"|"advertiser","value":"x.com"|"AR…","label":str,"region":null|2840,"addedAt":ISO }]`
- `data/ads/<watchId>.json` — `{ "watch":{…}, "lastScanAt":ISO, "ads":{ "<CR>":Ad } }`
  - `Ad = { creativeId, advertiserId, advertiserName, domain, format:"text"|"image"|"video", previewUrl, image:"images/<CR>.png"|null,
    firstShown:ISO, lastShown:ISO, firstSeenByUs:ISO, detailsUrl }`
- `data/images/<CR>.(png|jpg)` — hình: tải thẳng ảnh; chữ/video: dựng content.js trong trang trắng của chính Chrome đó rồi chụp phần tử.
- `data/scan-log.json` — 30 lượt gần nhất: thời điểm, số đối thủ quét, số mẫu mới, trạng thái `ok|blocked|error`.
- "Đang chạy" = lastShown trong 2 ngày gần nhất so với lượt quét; còn lại "đã dừng". "Mới" = firstSeenByUs trong 24 giờ.

## Quét
- Gộp watchlist của mọi hồ sơ, bỏ trùng theo (type,value,region).
- Lần đầu: tối đa 5 trang (200 mẫu)/đối thủ. Các lần sau: dừng phân trang khi một trang không có mẫu mới nào.
- Lịch: 02:00 hằng ngày (launchd) + nút "Quét ngay" trên web. Một lúc chỉ một lượt (khoá tệp).

## Web (localhost:4317)
- Bố cục ngang 3 cột: trái = hồ sơ + danh sách đối thủ (thêm/xoá, số mẫu mới); giữa = lưới mẫu (lọc: Mới hôm nay / Đang chạy / Đã dừng / Tất cả, tìm theo chữ, định dạng);
  phải = chi tiết mẫu (ảnh lớn, website, link ATC, ngày đầu, ngày cuối, số ngày chạy). Thanh trên: trạng thái lượt quét gần nhất, nút Quét ngay.
- Thêm đối thủ: dán tên miền hoặc link ATC `…/advertiser/AR…`.
- Tiếng Việt, không chữ kỹ thuật.

## Không làm
- Không lách captcha, không xoay IP, không giả trình duyệt.
- Không đăng nhập Google trong hồ sơ quét.
- Không công khai web ra internet (chạy local; dữ liệu vẫn có trên GitHub).

## Để bên xây tự quyết
Thư viện cụ thể, cấu trúc mã, kiểu dáng giao diện (theo bố cục trên).
