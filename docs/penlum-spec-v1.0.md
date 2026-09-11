# Penlum — Kế hoạch triển khai và Technical Spec

Phiên bản yêu cầu: V1.0 · Cập nhật thương hiệu: 11/09/2026.
Phiên bản mã nguồn hiện tại: 0.1.0. Trạng thái nghiệm thu nằm trong `implementation-status.md`.

## Quyết định thương hiệu đã chốt

- Tên sản phẩm và thương hiệu nền tảng: **Penlum**, cách đọc gợi ý **pen-lum**.
- Định danh kỹ thuật mới dùng `penlum`.
- Tên miền được chọn: **penlum.com**. Chưa mua, chưa xác nhận sở hữu, chưa cấu hình DNS/SSL.
- Ghi nhận lịch sử Porkbun lúc 11:26 ngày 11/09/2026 (Việt Nam): có thể thêm vào giỏ; giá 11,08 USD/năm và gia hạn 11,08 USD/năm. Không coi là giá/availability hiện tại.
- Penlum là nền tảng. Mỗi tenant có tên thương hiệu và domain riêng.
- Chưa chốt logo, màu sắc, slogan và cách chia subdomain. Dấu “p” và màu admin trong source chỉ là giao diện khởi đầu, không phải nhận diện thương hiệu đã được phê duyệt.
- “Đưa nội dung ra ánh sáng”, diễn giải “pen” / “lum” chỉ là đề xuất.
- Quyết định tên do chủ dự án xác nhận ngày 11/09/2026. Nguồn: cuộc trò chuyện “Tóm tắt cấu trúc website”, ID `6aa37a79-24f8-83ec-a26c-e837a13c52d4`.
- Cập nhật thương hiệu không thay đổi kiến trúc, chức năng, nghiệm thu hoặc lộ trình V1.0. Không phải lệnh mua domain hay triển khai hạ tầng.

## Spec V1.0 gốc được cung cấp cùng yêu cầu triển khai

Nội dung bên dưới giữ nguyên yêu cầu, không dùng trạng thái mã nguồn hiện tại để giảm phạm vi spec.

SPEC TRIỂN KHAI — SEO-FIRST MULTI-TENANT CMS TRÊN CLOUDFLARE

Phiên bản V1.0 — 2026-09-11 Quy mô: 500–1.000 website, khoảng 20–25
bài/site.

1. Mục tiêu

Xây CMS multi-tenant cực nhẹ theo tư duy WordPress Multisite nhưng không
dùng WordPress. Một codebase, một admin trung tâm, nhiều website độc
lập. Ưu tiên SEO, tốc độ, trải nghiệm đọc, quản trị hàng loạt, analytics
và API/MCP. Không tự động liên kết chéo giữa các tenant. V1 không có
page builder, plugin ecosystem, ecommerce hoặc chức năng thừa.

2. Kiến trúc Cloudflare

Internet -> Cloudflare DNS -> Worker -> Tenant Resolver -> Public
Renderer/Admin API -> storage.

Stack: Cloudflare Workers + TypeScript; D1 cho
content/config/auth/SEO/analytics aggregate; R2 cho media/export; KV tùy
chọn cho hostname/config lookup; Queues cho purge/import/audit jobs;
Cron cho analytics sync và housekeeping. Public dùng SSR HTML, JS tối
thiểu. Admin là app riêng. Một lần deploy cập nhật toàn hệ thống; thêm
site không cần deploy.

Phải có Data Access/Repository Layer để business logic không hard-code
vào một D1. V1 shared schema; có đường nâng cấp shard theo nhóm site nếu
write/analytics tăng.

3. Tenant và domain

Mỗi site có site_id, primary_domain, aliases, locale, timezone, theme,
status. Request: normalize Host -> resolve site_id ->
authorization/state -> route -> content/config -> SSR -> edge cache.
Cache key tối thiểu hostname + pathname. Unknown hostname không fallback
tenant khác. Alias 301 về primary khi cấu hình. HTTP->HTTPS; www/non-www
có canonical policy duy nhất.

4. Data model

Mọi bảng tenant-scoped có site_id + index.

sites: id, name, primary_domain, status, locale, timezone, theme_id,
site_title, description, logo/favicon/default_og, robots_mode,
timestamps. site_domains: id, site_id, hostname UNIQUE, type
primary|alias, redirect_to_primary, verified_at, status. users: id,
email, display_name, auth reference, status, last_login.
site_memberships: site_id, user_id, role. Roles: super_admin,
site_admin, editor, author, analyst/viewer. posts: id, site_id, type
post|page, status draft|scheduled|published|archived, title, slug,
excerpt, markdown_content, rendered_html optional, author,
featured_media, published/scheduled/timestamps, deleted_at. categories +
post_categories: tenant-scoped taxonomy. media: id, site_id, r2_key,
filename, MIME, width/height/bytes, alt/title/caption/checksum.
seo_meta: site_id, entity_type/id, seo_title, description,
canonical_override, index/follow, OG fields, schema_type,
schema_overrides_json. redirects: site_id, source_path UNIQUE per site,
target, 301|302, enabled. code_snippets: global|site scope, placement,
slot, targeting JSON, priority, enabled, content, audit fields.
theme_settings; navigation_menus; navigation_items. api_credentials:
hash only, type system|site|service, site scope optional, scopes,
expiry/status/last_used. audit_logs: site optional, actor
user|api|mcp|system, action, resource, before/after, timestamp.
analytics_daily_site: date/site, clicks, impressions, CTR, avg_position,
optional pageviews/sessions. analytics_daily_page: date/site/path + same
metrics. analytics_daily_query: optional V1.1 if volume large.
seo_audit_results: site/entity/path, rule, severity, status, details,
detected/resolved.

5. Content/editor

Public V1: homepage, page, category archive, post, 404. Author archive
optional/off by default. Editor: title, slug, Markdown, preview,
category, featured image, status/schedule, autosave. SEO drawer: SEO
title, meta description, canonical, index/follow, OG, schema, SERP
preview. Helpers: heading outline, broken links, orphan status,
internal-link suggestions trong cùng tenant, missing alt. Pipeline:
Markdown -> parser -> HTML AST -> sanitize -> heading IDs -> link/media
processing -> HTML. Raw HTML chỉ role tin cậy.

6. SEO Engine

SEO là core module. Bắt buộc: canonical đúng; draft/private không index;
404 thật; 301/302 thật; không soft-404; title/meta/OG fallback; sitemap
và robots riêng từng hostname; sitemap chỉ
published+indexable+canonical; lastmod đúng; invalidate khi content đổi.
Structured data: WebSite, WebPage, BreadcrumbList, Article/BlogPosting
khi phù hợp, Organization/Person chỉ khi có dữ liệu thật. Không tạo
rating/review/credentials giả. Internal links: graph theo tenant, orphan
pages, broken links, inbound/outbound counts, suggestions chỉ cùng site
mặc định. Redirect manager: đổi slug tạo/đề xuất 301; phát hiện
chain/loop. SEO audit: missing/duplicate title, canonical anomaly,
noindex trong sitemap, broken link, orphan page, H1 anomaly, missing alt
warning, oversized image, internal 404, redirect chain/loop, invalid
structured data, duplicate path.

7. Performance/UX

SSR + edge cache; public JS gần 0; không hydrate toàn trang; CSS nhỏ;
responsive images; width/height bắt buộc; lazy load dưới fold; LCP image
xử lý riêng; fingerprint assets; cache dài cho immutable assets. Purge
chính xác theo site/path khi content/menu/theme/SEO/code thay đổi. Site
#7 thay đổi không được phá cache 999 site khác. Article UX: semantic
HTML, typography đọc dài tốt, heading hierarchy, container hợp lý,
responsive table/image/code, banner không gây CLS, accessibility.

8. Theme

Không drag-drop builder. Contract: base, header, footer, homepage, post,
page, category, 404, placement slots. Site admin chỉ chỉnh whitelist:
logo/favicon, typography/spacing/container preset, navigation, layout
variant, banner slots. Bắt đầu 3–5 theme nhẹ; không sửa source template
từ admin V1.

9. Code & Placement Manager

Scope global hoặc site. Placement: head, body_start, body_end,
header_banner, before_content, after_content, sidebar optional,
footer_banner. Target: all/home/posts/pages/categories/include-exclude
path. Có enable, priority, preview target, audit, cache invalidation,
revision/rollback cho global. Executable global code chỉ super_admin; có
CSP strategy.

10. Auth/API key

Hai tầng: (A) system credential cho MCP/AI/trusted backend; (B)
site/service credential chỉ khi cần tích hợp riêng. Không tạo 1.000 key
từ đầu. Scopes: sites:read/write, content:read/write/publish,
media:write, seo:read/write, analytics:read, users:read/write,
code:write, system:admin. Request flow: authenticate -> scope -> tenant
authorization -> operation -> audit -> rate limit. System secret không
nhúng browser.

11. REST API V1

Base /api/v1. Sites: GET/POST /sites; GET/PATCH /sites/{id};
activate/archive. Domains: list/add/delete theo site. Posts:
list/create/get/update/delete/publish/unpublish.
Categories/Media/Redirects/Members: CRUD tenant-scoped. SEO: site SEO,
post SEO, audit get/run. Code: CRUD site snippets và system snippets.
Analytics: /analytics/sites, /winners, /losers; site
analytics/pages/queries. Ops: cache purge, site health, system health.
Conventions: cursor pagination, filter/sort, request_id, structured
errors, idempotency cho mutation quan trọng, optimistic concurrency.

12. MCP/AI

MCP dùng cùng service layer/API, không tạo business logic riêng. Tools:
list/get/create/update site; list/get/create/update/publish post; upload
media; get/update SEO; run audit; get site/page performance;
winners/losers; create redirect; purge cache. Mutation AI phải audit
actor/site/resource/before-after. Delete site, global code, bulk publish
cần guard/confirmation policy.

13. Analytics Center

Mục tiêu: nhìn 1.000 site vẫn biết ngay site/page nào tăng hoặc giảm.
Nguồn SEO chính: Google Search Console (clicks, impressions, CTR,
average position theo date/page/query). Có thể bổ sung Cloudflare Web
Analytics/first-party analytics cho pageviews/visits. Daily ingestion:
scheduled job -> fetch -> normalize domain/path -> map site_id -> upsert
daily aggregates -> compute deltas/anomalies -> save sync state.

Global dashboard: yesterday/7d/28d/custom + compare previous period;
tổng clicks/impressions; top rising/falling sites; anomalies; sync
failures. Sites table: Site | Clicks | Δ | Impressions | Δ | CTR |
Position | Δ Position | Last Sync; filter/sort/search. Site detail:
daily trend, top/rising/falling pages, queries, compare periods. Page
detail: daily metrics, top queries, publish/update date, SEO audit,
internal-link counts. Winner/loser phải dùng absolute delta +
percentage + minimum-volume threshold để tránh nhiễu dữ liệu nhỏ.
Anomaly examples: clicks/impressions giảm mạnh, position giảm, URL mất
traffic, site mất data, page tăng đột biến. D1 ưu tiên aggregate theo
ngày; raw/export lớn lưu R2 nếu cần.

14. Admin UX

Một admin domain. Navigation: Dashboard, Sites, Content Search, SEO,
Analytics, Media, Users, Code Manager, API/MCP, System/Jobs/Audit. Site
switcher luôn sẵn; chọn site sẽ scope UI. Global Sites table: domain,
status, posts, last publish, traffic trend, SEO issues, last sync. Bulk
actions: activate/archive, apply theme/config, SEO audit, cache purge,
code targeting, export. Saved views: sites giảm >30%, sites có nhiều SEO
errors, sites lâu chưa publish, pages mất >N clicks.

15. Provisioning

Create Site wizard: create record -> attach/verify domain -> theme ->
entity/site settings -> default homepage/menu -> staging/noindex ->
sitemap -> health/SEO preflight -> activate -> purge/warm key routes.
Không deploy code. Archive: ngừng publish theo policy nhưng bảo toàn dữ
liệu; không hard-delete ngay.

16. Security

Tenant isolation là yêu cầu số 1. Không tin site_id từ client nếu chưa
authorize. Sanitize content. Secure session/cookies; CSRF theo auth
model; rate limit; API key hash; audit mutation; privileged global code;
upload MIME/size validation; secrets trong Cloudflare secret storage;
không expose D1/R2 trực tiếp. Backup/restore phải test.

17. Observability

Theo dõi Worker 5xx/latency, cache hit ratio, D1 errors/latency, Queue
retry/failure, analytics sync, sitemap, tenant resolution, publish
failures. Request/job có ID; log site_id nhưng không log secrets. System
Health hiển thị runtime, DB, R2, queues, cron last run, failed jobs,
analytics freshness.

18. Backup/export

Export riêng tenant thành metadata + Markdown + SEO + redirects +
config + media manifest. Có restore test. Media có lifecycle/backup
policy. Thiết kế tránh lock-in vào renderer để có thể di chuyển tenant.

19. Repository

Monorepo đề xuất: /apps/public-worker /apps/admin /apps/mcp /packages/db
/packages/domain /packages/auth /packages/content /packages/seo
/packages/analytics /packages/renderer /packages/themes
/packages/api-contracts /packages/shared /migrations /tests /docs
Business rules nằm service/domain packages; Worker/Admin/MCP là
adapters.

20. Testing/acceptance

Unit: tenant resolver, router, permissions, sanitizer, canonical,
sitemap, redirect, analytics delta. Integration: D1 repositories,
publish, cache invalidation, API scopes, media. E2E: create site ->
domain -> content -> publish -> public URL -> sitemap; đổi slug -> 301;
cross-tenant denial; global code targeting; analytics filters; MCP
draft/publish. SEO regression: status
codes/canonical/robots/sitemap/schema/routes. Performance regression:
HTML/JS budget, render latency, cache behavior.

Acceptance V1: tạo site không deploy; public SSR crawlable; tenant
isolation test pass; post CRUD/publish; sitemap/robots/canonical/schema;
media R2; roles; Code Manager; system+optional site API credentials; MCP
core tools; daily analytics + winners/losers; audit logs; targeted cache
purge; backup/export procedure.

21. Lộ trình triển khai

Phase 0 — Foundation: repo, CI/CD, environments, migrations, Worker
skeleton, logging, secrets. Phase 1 — Multi-tenant core: sites/domains,
resolver, routing, isolation tests. Phase 2 — CMS:
posts/pages/categories/media, Markdown renderer, admin CRUD, roles.
Phase 3 — SEO: metadata, canonical, robots, sitemap, schema, redirects,
audits. Phase 4 — Performance/themes: cache/invalidation, image
strategy, theme contract, CWV budgets. Phase 5 — Code Manager:
global/site snippets, targeting, CSP, audit/rollback. Phase 6 — API/MCP:
scopes, system credential, site credential option, MCP tools, rate
limits. Phase 7 — Analytics: GSC integration, daily aggregates, compare,
winners/losers, anomalies. Phase 8 — Hardening: load/security/tenant
tests, backup/restore, observability, pilot 10–20 sites. Phase 9 — Scale
rollout: 100 -> 500 -> 1.000 sites; đo D1/Worker/cache/analytics và
shard chỉ khi metrics chứng minh cần.

22. Quyết định kiến trúc cần giữ

1)  Một application, không 1.000 deployments.
2)  Tenant resolution bằng hostname.
3)  site_id bắt buộc trong data access.
4)  Markdown là content source chính.
5)  SSR HTML + edge cache.
6)  SEO là core.
7)  Không cross-link tự động giữa tenant.
8)  System API key cho AI là mặc định; site key là optional capability.
9)  Analytics aggregate theo ngày và drill-down site/page.
10) UI tối giản; bulk/automation ở global admin.
11) Data layer có khả năng shard về sau.
12) Mọi mutation từ UI/API/MCP dùng cùng service layer và audit được.

23. Definition of Done cho bản đầu tiên

Bản đầu được coi là usable khi super admin có thể tạo một site mới, nối
domain, chọn theme, tạo user, viết Markdown, upload ảnh, cấu hình SEO,
publish; website public trả HTML nhanh và đúng
canonical/schema/sitemap/robots; đổi slug có redirect; admin xem được dữ
liệu hiệu quả theo ngày; có thể tìm winners/losers giữa nhiều site;
global code có thể bật cho toàn hệ thống; AI/MCP có thể tạo/sửa/publish
content bằng credential có scope; và mọi hành động quan trọng có audit
log.

24. Những thứ cố ý KHÔNG làm ở V1

Page builder, plugin marketplace, comments, ecommerce, complex workflow,
per-site deployment, arbitrary PHP/server code, theme source editor,
social network features, SEO score gamification, tự động cross-link giữa
các website, hoặc lưu raw analytics vô hạn trong transactional DB.

---

Kết luận: đây là một “content operating system” multi-tenant chạy edge,
không phải bản clone WordPress. Thiết kế phải giữ lõi nhỏ, public cực
nhẹ và đưa độ phức tạp cần thiết vào control plane: tenant management,
SEO, analytics, permissions, automation và AI/MCP.
