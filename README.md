# Penlum

CMS multi-tenant, SEO-first trên Cloudflare Workers. Một Worker phục vụ nhiều website theo hostname; admin trung tâm là app riêng được build thành static assets. Markdown là nguồn nội dung, public SSR không tải JavaScript ứng dụng.

Mã nguồn **0.1.0** hiện chạy được local. Spec yêu cầu là **V1.0**; đây chưa phải chứng nhận sẵn sàng chạy 1.000 website production. Xem [trạng thái triển khai](docs/implementation-status.md).

## Chạy local

Yêu cầu Node.js 24 và pnpm 11.19.0.

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm seed
pnpm dev
```

- Admin: [localhost:8787/admin/](http://localhost:8787/admin/).
- Website mẫu: [journal.localhost:8787](http://journal.localhost:8787/).
- Thông tin đăng nhập được tạo ngẫu nhiên và lưu tại `.wrangler/local-admin.txt` (bị gitignore, quyền 0600). Email local: `admin@penlum.local`.
- Dữ liệu mẫu chỉ chứa một website và bài viết minh họa, **không tạo dữ liệu analytics giả**.
- `pnpm seed` chỉ chạy local, không kết nối Cloudflare production. Có thể cung cấp `PENLUM_ADMIN_PASSWORD` trước lần seed đầu; tối thiểu 12 ký tự.
- Dữ liệu D1/R2 local lưu ở `.wrangler/state`. Không xóa thư mục này nếu cần giữ dữ liệu.

Tạo site mới bằng domain `example.localhost` → kiểm tra domain → kích hoạt → chọn robots index nếu muốn → tạo bài → publish. Domain `.localhost` được xác minh tự động **chỉ ở development**. Canonical luôn dùng HTTPS và primary domain theo spec, kể cả preview local HTTP.

## Viết và quản lý nội dung

Chọn website → **Bài viết** hoặc **Trang** → **Viết bài mới**. Editor có chế độ trực quan/Markdown, thanh định dạng, ảnh, danh mục, SEO và mục lục. Dùng **Xem trước** để kiểm tra trên theme website ở khung máy tính/điện thoại.

Bản nháp được tự lưu sau khi ngừng gõ khoảng 1,6 giây. Với bài đã xuất bản hoặc lên lịch, các chỉnh sửa được giữ trên máy; bấm **Cập nhật** để áp dụng. **⌘/Ctrl+S** lưu thủ công, **⌘/Ctrl+K** tìm nhanh màn hình/website ngoài editor. Xem [UX review và giới hạn](docs/ux-review.md).

## Lệnh kiểm tra

```sh
pnpm typecheck
pnpm test
pnpm build
# Hoặc cả ba:
pnpm check
```

`build` chỉ bundle Worker bằng `wrangler deploy --dry-run`; **không deploy**. Kiểm thử tích hợp chạy Miniflare thật cho D1 và R2, cần quyền mở cổng loopback. CI chạy typecheck, tests, build.

## Các phần đã có

- Tenant resolver hostname; unknown/pending/archive trả 404; alias 301; xác minh TXT DNS.
- Site/domain, Markdown posts/pages, category, ảnh R2, lịch xuất bản, soft delete và đổi slug tạo redirect.
- Admin tiếng Việt: site switcher, editor autosave/preview, SEO, media, users/members, code manager, API credentials, analytics, jobs và audit.
- Session HttpOnly + SameSite + Origin check; PBKDF2; API token chỉ lưu SHA-256; scopes, membership và quyền author trên chính bài của mình.
- Canonical/meta/OG/schema, robots, sitemap; 3 theme; menu và theme whitelist; code targeting và CSP script hashes.
- REST `/api/v1` và MCP `/mcp` cùng `Service`; audit mutation; idempotency cho REST khi gửi header; version check.
- GSC OAuth adapter, queue/cron ingestion, daily site/page aggregates, so sánh kỳ trước, winners/losers với minimum volume.
- Export tenant và CLI tạo SQL restore; restore sang D1 sạch được kiểm thử, mặc định staging/noindex và tắt snippets.

## Cấu trúc

```text
apps/public-worker  HTTP, REST, scheduler và queue adapters
apps/admin          Admin app TypeScript + CSS, static build riêng
apps/mcp            MCP Streamable HTTP adapter, protocol 2025-11-25
packages/db         D1 database / tenant repository, models
packages/domain     Services, media, jobs, export/restore
packages/auth       Session, scopes, membership, password/token hashes
packages/content    Markdown parsing, sanitize, heading IDs, link extraction
packages/seo        Metadata, schema, sitemap, audit
packages/analytics  GSC ingestion, weighted aggregates, period comparison
packages/renderer   Public SSR, semantic HTML và CSP
packages/themes     Theme presets và placement targeting
packages/api-contracts  Zod schemas
migrations          Shared-schema D1 migration
scripts             Build, local seed và restore
```

## Tài liệu

- [Spec V1.0 + quyết định Penlum](docs/penlum-spec-v1.0.md)
- [Kiến trúc, bảo mật và cache](docs/architecture.md)
- [REST / MCP](docs/api.md)
- [Cloudflare, GSC, backup/restore](docs/operations.md)
- [Trạng thái nghiệm thu và phần còn lại](docs/implementation-status.md)

Tên miền `penlum.com` chỉ là lựa chọn thương hiệu, chưa đăng ký hoặc cấu hình trong source này. `ADMIN_HOST` cần do chủ dự án lựa chọn khi cấu hình production; không tự chốt subdomain.
