# Trạng thái triển khai — 11/09/2026

**Penlum source 0.1.0, triển khai luồng lõi của spec V1.0.** Spec V1.0 vẫn là mục tiêu đầy đủ. Không đánh dấu hoàn tất hardening/pilot/rollout và không coi build local là production acceptance.

## Có mã nguồn và đã chạy kiểm thử local

| Hạng mục     | Đã có                                                                                                                                                                                                                     | Giới hạn hiện tại                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Foundation   | Monorepo, TypeScript, lockfile, CI, migration, Worker build                                                                                                                                                               | CI chưa chạy trên GitHub vì chưa có remote repository                                                                        |
| Multi-tenant | Host resolver, verified domain, unknown 404, alias policy, staging/archive, composite keys                                                                                                                                | Chưa nối DNS/SSL/Cloudflare custom hostnames thật                                                                            |
| CMS          | Sites, domains, posts/pages, categories, Markdown, schedule, media R2                                                                                                                                                     | Upload PNG/JPEG/GIF; không có image transform pipeline                                                                       |
| Admin        | Site switcher, editor trực quan/Markdown, Font Awesome, autosave nháp và local recovery, preview chưa lưu, search toàn hệ thống, site CRUD, bulk audit/purge/export/status, media, users/members, code, credentials, jobs | Chưa có saved views bền vững, đầy đủ bulk config, user reset-password/MFA, theme preview gallery                             |
| SEO          | Canonical, robots, sitemap, meta/OG/schema, redirects, sanitizer, heading IDs, tenant-only links                                                                                                                          | Audit hiện là subset quan trọng, chưa có crawler kiểm tra toàn bộ external links và đầy đủ từng rule của spec                |
| Themes/cache | 3 theme, menu, typography/container presets, site generation cache, global generation code                                                                                                                                | Invalidate theo site; chưa physical purge từng URL, srcset/AVIF/WebP hoặc CWV lab suite                                      |
| Auth         | PBKDF2, HttpOnly sessions, CSRF Origin, hashed API keys, scopes, roles, author ownership, rate limit                                                                                                                      | Chưa MFA/SSO, password reset flow hoặc session management UI                                                                 |
| Code Manager | Site/global slots, targeting, enabled/priority, executable super-admin, CSP hashes, revisions/rollback API                                                                                                                | Chưa revision/rollback UI; CSP chặn external scripts và outbound connections                                                 |
| REST/MCP     | Shared service, audit, version checks, idempotency REST, 19 MCP tools                                                                                                                                                     | Cursor chỉ trên sites/posts/global content; một số API adapters vẫn chứa D1 write batches; chưa OpenAPI generated/client SDK |
| Analytics    | GSC adapter có test fixture, queue/cron, site/page aggregates, dates/compare, winners/losers                                                                                                                              | Chưa chạy OAuth/GSC tài khoản thật; query store V1.1; page daily drill-down/saved anomaly views chưa đủ                      |
| Ops/backup   | Queue outbox, retries, health, audit, tenant JSON export, SQL restore, clean-D1 round-trip test                                                                                                                           | R2 backup bytes và lifecycle còn thủ công; chưa production recovery drill hoặc alerts                                        |
| Scale        | Index tenant, shared-schema data repository                                                                                                                                                                               | Chưa load-test 100/500/1.000 sites; chưa có shard router triển khai                                                          |

## Kiểm tra kỹ thuật

- **35/35 tests đã qua** (8 core + 4 editor utilities + 23 integration); typecheck riêng Worker và browser admin đã qua.
- Vitest gồm pure domain và integration dùng D1/R2 thật trong Miniflare, không mock SQL repository.
- Các luồng được kiểm tra: create/publish/SSR/sitemap, noindex/canonical override, đổi slug/301, stale write rollback, tenant denial, API scopes, author role, media isolation, global targeting/audit, CSRF, idempotency, MCP mutation, weighted analytics, GSC fixture ingestion, scheduled publishing, backup restore.
- Dry-run Worker bundle thành công; không phát hành Cloudflare.
- HTTP smoke test trên Wrangler local: admin HTML/JS/CSS, login, site listing và tenant SSR. Bài seed SSR khoảng 5 KB, không tải JavaScript ứng dụng.
- Đã kiểm tra trực tiếp trên browser các luồng viết, autosave/tải lại, SEO, danh mục, preview, xuất bản/cập nhật và local recovery ở desktop/mobile. Chi tiết trong [UX review](ux-review.md). Chưa có browser E2E tự động và chưa audit accessibility đầy đủ.

## Điều kiện còn lại trước khi gọi là hoàn tất V1.0

1. Hoàn thiện phần UI/API còn thiếu ở bảng trên, đặc biệt saved views, table metrics/sorts/cursors, page detail analytics, SEO audit coverage và image strategy.
2. Tiếp tục tách prepared-write commands khỏi service/API vào repository để sẵn sàng routing D1 theo nhóm site.
3. Cấu hình Cloudflare resource IDs, admin domain, DNS routes/TLS và GSC secrets khi có quyền quản lý. Kiểm chứng integrations thật.
4. Thực hiện browser E2E, accessibility, security review, load/CWV budgets, backup media round-trip, alerting và pilot 10–20 sites.
5. Chỉ tăng quy mô sau khi có metrics cho D1 writes, cache hit ratio, queue retries và GSC quotas.

Source hiện tại có thể dùng để chạy thử và tiếp tục phát triển. Không thay đổi tên miền, không mua `penlum.com`, không tạo tài nguyên hoặc deploy production trong phiên này.
