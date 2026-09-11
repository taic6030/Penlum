import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { passwordHash } from '../packages/auth/src/index';
import { sqlValue } from '../packages/domain/src/restore';
import { id, now } from '../packages/shared/src/index';
await mkdir('.wrangler', { recursive: true });
const credentialPath = resolve('.wrangler/local-admin.txt');
try {
  await access(credentialPath);
  console.log(`Local seed already initialized. Credentials: ${credentialPath}`);
  process.exit(0);
} catch {}
const password = process.env.PENLUM_ADMIN_PASSWORD || id() + id().slice(0, 8);
if (password.length < 12) throw new Error('PENLUM_ADMIN_PASSWORD must be at least 12 characters');
const userId = id(),
  siteId = id(),
  time = now(),
  domainId = id(),
  menuId = id();
const values = (v: unknown[]) => v.map(sqlValue).join(',');
const statements = [
  `INSERT INTO users(id,email,display_name,password_hash,role,created_at) VALUES (${values([userId, 'admin@penlum.local', 'Quản trị viên', await passwordHash(password), 'super_admin', time])});`,
  `INSERT INTO sites(id,name,primary_domain,status,theme_id,site_title,description,robots_mode,created_at,updated_at) VALUES (${values([siteId, 'Góc Viết · Demo', 'journal.localhost', 'active', 'journal', 'Những câu chuyện đáng đọc', 'Website mẫu local để thử quy trình biên tập của Penlum.', 'noindex', time, time])});`,
  `INSERT INTO site_domains(id,site_id,hostname,type,verification_token,verified_at,status) VALUES (${values([domainId, siteId, 'journal.localhost', 'primary', id(), time, 'verified'])});`,
  `INSERT INTO theme_settings VALUES (${values([siteId, '{}'])});`,
  `INSERT INTO navigation_menus VALUES (${values([menuId, siteId, 'main'])});`,
  `INSERT INTO navigation_items VALUES (${values([id(), siteId, menuId, 'Trang chủ', '/', 0])});`,
  `INSERT INTO posts(id,site_id,title,slug,excerpt,markdown_content,author_id,status,published_at,created_at,updated_at) VALUES (${values([id(), siteId, 'Bắt đầu một không gian viết', 'bat-dau-mot-khong-gian-viet', 'Một bài mẫu để bạn thử biên tập, cấu hình SEO và xuất bản.', '## Viết điều có ích\n\nĐây là nội dung mẫu của môi trường local. Bạn có thể sửa tiêu đề, nội dung và đường dẫn của bài viết trong Penlum.\n\n## Quy trình xuất bản\n\n1. Tạo bản nháp bằng Markdown.\n2. Kiểm tra tiêu đề, mô tả và ảnh.\n3. Xem trước rồi xuất bản.\n\n> Nội dung thuộc từng website. Không có liên kết chéo tự động giữa các tenant.', userId, 'published', time, time, time])});`,
  `INSERT INTO audit_logs(id,site_id,actor_type,actor_id,action,resource,request_id,created_at) VALUES (${values([id(), siteId, 'system', 'seed-cli', 'local.seed', siteId, id(), time])});`,
];
const sqlPath = resolve('.wrangler/seed.sql');
await writeFile(sqlPath, statements.join('\n'), { mode: 0o600 });
execFileSync(
  process.execPath,
  [
    'node_modules/wrangler/bin/wrangler.js',
    'd1',
    'execute',
    'penlum-local',
    '--local',
    '--env=',
    '--file',
    sqlPath,
  ],
  { stdio: 'inherit' },
);
await writeFile(
  credentialPath,
  `Local development only\nURL: http://localhost:8787/admin/\nEmail: admin@penlum.local\nPassword: ${password}\nTenant: http://journal.localhost:8787/\n`,
  { mode: 0o600 },
);
console.log(`Local demo initialized. Login details saved to ${credentialPath}`);
