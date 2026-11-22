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

## Web (cổng 4317, mở cho máy cùng wifi — anh Dai 22/11)
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

## Bổ sung 22/11 (anh Dai, 16:33)
- **Hai loại theo dõi:** "Đối thủ" và "Dự án" (`watch.kind = "competitor" | "project"`, mặc định competitor cho dữ liệu cũ). Cách quét giống nhau (tên miền hoặc mã nhà QC); khác nhau ở mục đích người dùng và chỗ hiển thị.
- **Chỉ quảng cáo Google Tìm kiếm:** mọi yêu cầu SearchCreatives thêm `"3":{"14":[3]}` (đã đo trên ATC ngày 22/11: bộ lọc nền tảng "Google Tìm kiếm" = 14:[3]).
  Mẫu được thấy trong kết quả đã lọc thì gắn `platform:"search"`; giao diện chỉ hiện mẫu có `platform:"search"`. Phân trang tiếp tục khi trang còn mẫu mới HOẶC mẫu chưa gắn `platform:"search"`.
- **Trang chủ:** tổng kết thay đổi của lượt quét gần nhất so với lượt trước: số mẫu mới, số mẫu vừa dừng (đang chạy ở lượt trước, nay đã dừng), số đang chạy; bảng theo từng đối thủ/dự án; lưới mẫu mới và mẫu vừa dừng.
- **Cột trái:** Trang chủ · mục Đối thủ · mục Dự án. Chọn mục nào hiện mục đó.

## Bổ sung 22/11 (anh Dai, 17:20) — tổng quan theo dự án, quốc gia, SQL, ổ rời
- **Hệ thống chạy từ ổ rời:** thư mục gốc `/Volumes/MEMORY BACKUP/ATC ISO` (anh đã chuyển). Mọi đường dẫn tương đối theo thư mục gốc; LaunchAgents cài lại từ đó. Ổ rút ra thì app tạm dừng — chấp nhận.
- **Lưu trữ SQL:** SQLite một tệp `data/atc.db` qua `node:sqlite` (có sẵn từ Node 22.13, không cần cài thêm). Lần chạy đầu tự chuyển dữ liệu JSON cũ vào DB (giữ JSON cũ làm bản sao lưu, không xoá).
  Bảng (liên kết nhiều chiều): profiles · watches(kind) · advertisers · domains · creatives(advertiser_id, domain, format, first_shown, last_shown, preview_url, image_url, image, platform, first_seen_by_us) · watch_creatives(watch_id, creative_id) · creative_regions(creative_id, region_id, last_shown, first_shown) · scans(at, status, error, sync) · group_snapshots(scan_id, watch_id, group_key, running, total).
- **Quốc gia:** `LookupService/GetCreativeById` body `{"1":"AR…","2":"CR…","5":{"1":1,"2":28,"3":2704}}` → `"17": [{"1": mã vùng, "4": yyyymmdd đầu (có thể thiếu), "5": yyyymmdd gần nhất}]`. Mã vùng = 2000 + mã số ISO 3166 (2840 Mỹ, 2704 Việt Nam, 2392 Nhật, 2276 Đức). Gọi cho mẫu mới và mẫu đang chạy chưa có quốc gia, tối đa 60 lượt/lượt quét, cùng nhịp ≥ 8 s, cùng cầu dao chặn.
- **"Dự án" trong tổng quan** = tên miền đích của quảng cáo. Với mục theo dõi loại Đối thủ: nhóm mẫu theo tên miền (đối thủ đang chạy dự án nào). Với mục loại Dự án: nhóm theo nhà quảng cáo (ai đang chạy dự án này).
  Trạng thái mỗi nhóm so với lượt quét trước: `new` (chưa từng thấy nhóm này ở mục này) · `increase` (số mẫu đang chạy tăng) · `decrease` (giảm, vẫn > 0) · `stopped` (trước > 0, nay 0) · `steady`. "Đang chạy" = lastShown ≥ lúc quét − 2 ngày.
- **Tổng quan trọng tâm:** đối thủ chạy dự án gì mới; dự án đó mới hay chạy thêm ads; dự án nào dừng/giảm; tăng/giảm bao nhiêu mẫu; quốc gia đang chạy. Màu nhận diện rõ cho từng trạng thái và từng đối thủ.

## Bổ sung 22/11 (anh Dai, 20:18) — so theo THỜI GIAN, gọn, quét từng mục, biểu đồ
- **So theo ngày, không theo lượt quét.** Mọi "mới/tăng/giảm/dừng" tính từ ngày chạy ATC báo (firstShown/lastShown), không phụ thuộc đã quét mấy lần.
  - Ngày tham chiếu (theo giờ Việt Nam): từ 20:00 trở đi = hôm nay; trước 20:00 = hôm qua (ATC chỉ cập nhật quảng cáo hôm nay vào buổi tối).
  - Khoảng so: Hôm nay (so với ngày trước đó) · 7 ngày · 30 ngày (so với cùng mốc trước đó).
  - Đang chạy ngày D = mẫu có firstShown ≤ cuối ngày D và lastShown ≥ đầu ngày D.
  - Mẫu mới = firstShown trong khoảng. Nhóm mới (dự án mới của đối thủ / nhà QC mới vào dự án) = firstShown sớm nhất của nhóm trong khoảng.
  - Trạng thái nhóm: new · stopped (trước >0, nay 0) · increase · decrease · steady.
- **Tách 3 loại "mới":** Dự án mới (đối thủ chạy tên miền mới) · Nhà QC mới (người mới vào dự án theo dõi) · Ads mới.
- **Quét:** nút "Quét tất cả" + nút quét riêng từng mục. Một lúc chỉ một lượt.
- **Tổng quan gọn:** bảng tóm tắt mỗi mục một dòng (có biểu đồ nhỏ 30 ngày); bấm mới xổ danh sách nhóm (5 dòng đầu, "xem thêm").
- **Trang mục theo dõi:** thêm chế độ "Theo nhà quảng cáo/dự án" bên cạnh lưới kiểu ATC; bấm nhóm xem mẫu; biểu đồ số mẫu đang chạy + mẫu mới theo ngày (90 ngày) cho mục và cho từng nhóm.
- **Thêm theo dõi tiện hơn:** ô tìm gợi ý từ nhà QC/tên miền đã thấy trong dữ liệu; nút "Theo dõi" ngay trên mỗi nhà QC/dự án trong danh sách; nhận mọi dạng link ATC.

## Bổ sung 22/11 (anh Dai, 21:36) — nhóm, thùng rác, xác nhận xoá
- Xoá mục theo dõi phải xác nhận; có chế độ chọn nhiều để xoá; xoá = vào THÙNG RÁC (khôi phục được), tự xoá hẳn sau 60 ngày. Biểu tượng thùng rác ở góc dưới cột trái.
- NHÓM: trong Đối thủ và trong Dự án đều tạo được nhóm để gom mục liên quan; mỗi mục thuộc tối đa một nhóm.
- Khung "Chi tiết quảng cáo" (đổi tên từ "Chi tiết mẫu") có nút thêm dự án (tên miền của quảng cáo) / thêm đối thủ (nhà QC); có nhóm thì chọn nhóm.
- Biểu đồ vẽ theo đúng điểm ảnh của khung (chữ cố định 12px), không phóng theo bề ngang.

## Bổ sung 22/11 22:49 — Giới hạn tab ATC
- Cả máy tối đa 2 tab ATC cùng lúc (mở nhiều tab là nguyên nhân lớn bị Google khoá).
- Trước mỗi lượt quét: đếm tab ATC đang mở ở Chrome/Brave/Edge/Arc của người dùng (macOS). Còn 2 chỗ → quét dùng 2 tab; còn 1 → dùng 1 tab (tra quốc gia trên chính tab chính); hết chỗ → chờ tối đa 10 phút (kiểm lại mỗi 30 giây), quá thì hoãn lượt, ghi lý do.
- Trình duyệt quét tự đóng tab cũ được khôi phục và mọi tab bật ra ngoài ý muốn. Không đóng tab ở trình duyệt riêng của người dùng.

## Bổ sung 22/11 23:11 — Tên miền cho mẫu chữ/video
- Mẫu chữ/video không có ảnh: tải tệp xem trước của Google (content.js) và đọc tên miền hiển thị (visible_url → destination_url → máy chủ được liên kết nhiều nhất, ≥2 lần, bỏ máy chủ hạ tầng/Google). Nguồn ghi 'preview'.
- Đọc bù chạy lúc bật máy chủ, sau mỗi lượt quét, và mỗi 30 phút; tối đa 2000 ảnh + 1000 bản xem trước mỗi lượt, thử lại sau 7 ngày nếu chưa ra.
- Còn sót: mẫu Google đã gỡ ảnh/bản xem trước (trả lỗi 404/500) — không còn dữ liệu để đọc.
