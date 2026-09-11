# REST và MCP

Base: `https://<ADMIN_HOST>/api/v1`. Bearer token hoặc session cookie. JSON response `{data, request_id}`; lỗi `{error:{code,message,details?},request_id}`. List sites/posts/content hỗ trợ `limit` (1–100), `cursor`, `next_cursor`. Posts hỗ trợ `q` và `status`; các list nhỏ khác hiện giới hạn 100, chưa có cursor đầy đủ. Optimistic concurrency dùng `version` trong PATCH post/site, PUT snippet.

`GET /auth/me` bổ sung `display_name`, `email`, `memberships:[{site_id,role,scopes}]` của người đang đăng nhập để admin hiển thị đúng quyền.

`POST /sites/:site/preview` nhận `{post_id?:string, post:{title,slug,type?,markdown_content?,excerpt?,featured_media?,category_ids?}, seo?:{...}}`. Trả HTML `no-store/noindex` chưa lưu; kiểm tra tenant và author ownership nếu có `post_id`. Không cập nhật bài, SEO hoặc cache generation.

## Endpoints

| Nhóm        | Routes chính                                                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth        | POST `/auth/login`, `/auth/logout`; GET `/auth/me`                                                                                                                                                      |
| Sites       | GET/POST `/sites`; GET/PATCH `/sites/:site`; POST `activate`, `archive`; POST `/sites/bulk`                                                                                                             |
| Domains     | GET/POST `/sites/:site/domains`; POST `/:domain/verify`; DELETE `/:domain`                                                                                                                              |
| Content     | GET `/content?q=` tìm kiếm toàn bộ site được authorize                                                                                                                                                  |
| Posts       | GET/POST `/sites/:site/posts`; GET/PATCH/DELETE `/:post`; POST `/:post/publish`, `/:post/unpublish`; GET `/:post/preview`, `/:post/helpers`                                                             |
| Categories  | GET/POST `/sites/:site/categories`; PUT/DELETE `/:item`                                                                                                                                                 |
| Media       | GET/POST `/sites/:site/media`; PATCH/DELETE `/:item`; GET `/:item/file` (authenticated)                                                                                                                 |
| SEO         | GET/PUT `/sites/:site/seo/:entity`; entity = site ID hoặc post ID                                                                                                                                       |
| Redirects   | GET/POST `/sites/:site/redirects`; PUT/DELETE `/:item`                                                                                                                                                  |
| Audit       | POST `/sites/:site/audit`; GET `/sites/:site/seo_audit_results`                                                                                                                                         |
| Theme/menu  | PUT `/sites/:site/theme`, `/sites/:site/navigation`; GET `theme_settings`, `navigation_menus`, `navigation_items`                                                                                       |
| Code        | GET `/sites/:site/code_snippets`; POST `/sites/:site/snippets`; PUT `/:item`; GET/POST `/system/snippets`; PUT `/:item`; GET `/:item/revisions`; POST `/:item/rollback`                                 |
| Users       | GET/POST `/users`; GET/POST `/sites/:site/members`; DELETE `/sites/:site/members/:user`                                                                                                                 |
| Credentials | GET/POST `/credentials`; DELETE `/:item` để revoke                                                                                                                                                      |
| Analytics   | GET `/analytics/sites`, `/analytics/winners`, `/analytics/losers`; GET `/sites/:site/analytics/sites`, `/pages`, `/daily`, `/queries`; PUT `/sites/:site/analytics`; POST `/sites/:site/analytics/sync` |
| Ops         | POST `/sites/:site/purge`, `/export`; GET `/sites/:site/export`, `/health`; GET `/system/health`, `/system/jobs`, `/system/audit`; POST `/system/jobs/:item/retry`                                      |

`/queries` hiện trả `available:false`, đúng optional V1.1. `/daily` hiện site aggregates; page comparison trả qua `/pages`.

Publish body `{ "version": 2 }`; schedule body `{ "version": 2, "scheduled_at": "2026-10-01T08:00:00.000Z" }`. Không set published status bằng PATCH. Delete post là soft-delete, author không xóa bài đã publish. Site delete không expose; archive giữ dữ liệu.

```sh
curl "https://<ADMIN_HOST>/api/v1/sites/<SITE_ID>/posts" \
  -H "Authorization: Bearer $PENLUM_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: unique-request-id' \
  --data '{"title":"Một bài viết","slug":"mot-bai-viet","markdown_content":"## Đề mục\n\nNội dung."}'
```

Ảnh: multipart `file`, `alt`. API chỉ lưu metadata sau khi put R2 thành công; nếu transaction D1 lỗi sẽ xóa R2 object vừa tạo. Xóa metadata media giữ R2 bytes để retention/backup; từ chối xóa featured media đang được dùng.

Bulk body `{site_ids:[...],action:"audit|purge|export|activate|archive|theme",theme_id?:...}`. Tối đa 100 sites; super admin; mỗi site một transaction và kết quả thành công/lỗi riêng. Không có bulk publish.

## MCP

Endpoint `/mcp`, Streamable HTTP trả JSON, protocol ổn định `2025-11-25`, stateless session. POST JSON-RPC `initialize`, `ping`, `tools/list`, `tools/call`; notification initialized trả 202. GET trả 405 (không có server-initiated SSE). Bearer bắt buộc, không dùng session browser. Origin nếu có phải khớp endpoint.

Tools: list/get/create/update site; list/get/create/update/publish post; upload_media; get/update_seo; run_audit; get_site_performance/get_page_performance; winners/losers; create_redirect; purge_cache. Upload MCP base64 giới hạn 2 MB. Global code, delete site và bulk publish không expose cho MCP.

MCP mutation đi qua `Service`, actor ghi `mcp`. Scope và tenant từ credential được kiểm tra như REST. Không có system secret được bundle vào admin.

Nguồn giao thức: [MCP 2025-11-25 Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
