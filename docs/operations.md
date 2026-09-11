# Vận hành và triển khai

## Local

Chạy các lệnh trong README. Khi môi trường sandbox không cho ghi cấu hình Wrangler bên ngoài dự án, có thể dùng các biến riêng cho tiến trình:

```sh
export XDG_CONFIG_HOME=/tmp/penlum-config
export WRANGLER_LOG_PATH=.wrangler/logs
export WRANGLER_SEND_METRICS=false
```

Không dùng biến trên để đổi thư mục home của hệ thống. Runtime local cần mở loopback; không cần tài khoản Cloudflare. Có thể chạy `wrangler dev --test-scheduled` để gọi cron local; các queued job được Wrangler local xử lý khi consumer đang chạy.

## Production: chưa được triển khai

`wrangler.jsonc` top-level chỉ dành cho development. `env.production` cố ý chưa có resource bindings/host thực. Cấu hình production là bước riêng sau khi chủ dự án có domain và tài khoản Cloudflare:

1. Tạo D1, R2, jobs queue và dead-letter queue trong tài khoản được chỉ định.
2. Thêm **bindings riêng** vào `env.production`: `DB`, `MEDIA`, `JOBS`, consumer queue; D1 `migrations_dir: migrations`. Wrangler không kế thừa các binding này giữa environments.
3. Chọn admin domain, đặt `ADMIN_HOST` đúng hostname, `ENVIRONMENT=production`. Không dùng `localhost` hoặc placeholder. Chọn Worker routes/custom hostnames cho các tenant. Verification TXT không tự tạo DNS, TLS hoặc Worker route.
4. Apply migration vào D1 production qua `wrangler d1 migrations apply <name> --remote --env production`. Sao lưu trước các migration thay đổi schema.
5. Bootstrap người dùng super admin bằng hash PBKDF2 qua công cụ nội bộ; không chạy seed demo vào production. Triển khai MFA/Cloudflare Access ở admin perimeter trước pilot có dữ liệu quan trọng.
6. Đặt GSC secrets nếu cần. Build, test; `wrangler deploy --dry-run --env production`; chỉ deploy thật sau khi chủ dự án yêu cầu.
7. Pilot 10–20 site, kiểm thử DNS/SSL, publish/redirect/sitemap, D1/R2 restore và GSC end-to-end. Đo quota/latency trước tăng 100 → 500 → 1.000.

Không có workflow tự động deploy hoặc mua domain. CI chỉ kiểm tra. Cấu hình Worker: [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/), [Queues configuration](https://developers.cloudflare.com/queues/configuration/configure-queues/).

## Google Search Console

Tạo OAuth client có Search Console readonly permission; tài khoản OAuth phải được quyền đọc từng property. Lấy refresh token từ quy trình OAuth do chủ tài khoản kiểm soát. Cấu hình:

- `GSC_CLIENT_ID` trong vars.
- `GSC_CLIENT_SECRET`, `GSC_REFRESH_TOKEN` trong `wrangler secret put ... --env production`.
- Mỗi site chọn `sc-domain:<primary_domain>` hoặc `https://<primary_domain>/` trong admin Analytics.

Cron 06:15 UTC (13:15 Việt Nam) queue lại 3 ngày gần nhất đã đủ độ trễ (D−3, D−4, D−5). API gọi `searchAnalytics.query`, phân trang 25.000 rows; normalize URL/path, chỉ page thuộc primary domain. Tối đa 2.000 distinct pages/site mỗi lần sync ở V1; vượt giới hạn job báo lỗi trước khi ghi thay dữ liệu. Site total do GSC trả có thể khác tổng page vì giới hạn và tổng hợp của Google.

Ngày analytics theo múi giờ PT của Search Console (không chuyển theo timezone tenant). Ngày không có rows được ghi zero metrics; API errors giữ dữ liệu cũ và lưu sync error. CTR = clicks/impressions; vị trí tổng hợp có trọng số impressions. Compare = kỳ liền trước có cùng số ngày. Winners/losers dùng absolute delta, percentage (null nếu kỳ trước bằng 0) và min volume mặc định 10 clicks.

Chưa có dữ liệu Google thật trong repo; local hiển thị empty state. OAuth callback/admin OAuth wizard và query storage là phần mở rộng. Nguồn API: [Search Analytics query](https://developers.google.com/webmaster-tools/v1/searchanalytics/query).

## Backup / restore

1. GET `/sites/:id/export` tải JSON metadata + Markdown + SEO + redirects + theme/menu + media manifest. POST cùng route tạo export job lưu private R2 key `<site_id>/exports/<job_id>.json`.
2. Sao chép R2 bytes theo `media[].r2_key` ra kho backup độc lập; kiểm tra SHA-256 `checksum`. JSON manifest **không chứa bytes ảnh**.
3. Chạy `pnpm backup:restore <export.json>` để tạo `.wrangler/restore.sql` phục vụ review. Mặc định không apply.
4. Trên D1 local đã migrate, có thể dùng `pnpm backup:restore <export.json> --apply-local`. Không REPLACE dữ liệu. Nếu site ID/domain đã tồn tại, restore thất bại; dùng DB sạch và không tự xóa site hiện hữu.
5. Khôi phục bytes ảnh vào đúng R2 key, đối chiếu checksum. Kiểm tra draft/published, category references, SEO và media.
6. Restore tạo site `staging/noindex`, domain primary `pending`, snippets tắt. Xác minh DNS, preview/audit trước activate. Alias không được khôi phục tự động để tránh giành hostname.
7. Kiểm thử tự động hiện bao gồm round-trip export → D1 sạch, giữ số bài, staging/noindex, pending domain và từ chối overwrite. Chưa chứng minh disaster recovery với dữ liệu production hoặc bản sao R2 ngoài tài khoản.

Retention đề xuất cần chủ dự án chọn: D1 point-in-time recovery theo plan; export hằng ngày giữ 30 ngày; R2 version/copy backup độc lập; bytes mồ côi giữ ít nhất 30 ngày. Chưa bật lifecycle tự xóa media: tránh mất nội dung khi chưa có backup thực đã thử.

## Observability

HTTP log chỉ chứa request ID, method, status, duration; không log request body/cookie/bearer. Audit lưu actor/site/before-after cho mutation. System health kiểm tra D1/R2, hiển thị jobs failures, cron last run và analytics sync. Queue binding tồn tại không đồng nghĩa delivery khỏe: xem job state/DLQ.

Rate-limit counters dùng D1; Cron xóa window cũ, sessions hết hạn và idempotency entries. Chưa có hệ thống cảnh báo gửi ra ngoài, retention auto-prune audit/jobs hay load benchmark 1.000 sites. Các bước này phải hoàn tất trong hardening/pilot.
