# ATC Iso

ATC Iso theo dõi mẫu quảng cáo của đối thủ trên Google Ads Transparency Center. Mở ứng dụng tại <http://127.0.0.1:4317> để chọn hồ sơ, thêm tên miền hoặc liên kết nhà quảng cáo và xem mẫu đã lưu.

## Cài trên macOS

1. Cài Node.js từ phiên bản 20 trở lên kèm npm và đặt Google Chrome trong thư mục Ứng dụng.
2. Chuẩn bị bản sao kho `joelane0810/ATC-Iso` trên Mac mini, chẳng hạn tại `/Users/daituong/ATC ISO`. Tài khoản macOS đang dùng cần có danh tính Git, quyền đẩy lên kho và thông tin xác thực hoạt động khi chạy nền.
3. Mở Terminal trong thư mục dự án từ phiên đăng nhập macOS của bạn và chạy:

   ```bash
   bash ops/install-macos.sh
   ```

Máy chủ tự khởi động khi đăng nhập. Lịch quét tự động là 02:00 theo giờ trên máy Mac. Giữ máy bật và tài khoản macOS đăng nhập để chạy theo lịch. Chrome dùng hồ sơ riêng trong `chrome-profile/`. Nếu Google chặn, lượt quét dừng và trạng thái hiển thị trên ứng dụng.

## Quét và xem nhật ký

Bấm **Quét ngay** trên ứng dụng hoặc chạy `npm run scan` trong thư mục dự án. Sau lượt quét, dữ liệu thay đổi trong `data/` được đồng bộ lên GitHub. Các nhật ký máy chủ và lượt quét nằm trong `logs/`.

## Gỡ trên macOS

```bash
bash ops/uninstall-macos.sh
```

Lệnh này dừng máy chủ và gỡ lịch quét. Dữ liệu, hồ sơ Chrome và nhật ký vẫn nằm trong thư mục dự án.
